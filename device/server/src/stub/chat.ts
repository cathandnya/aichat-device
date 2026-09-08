/**
 * stub モードの /api/chat。上流を呼ばずに固定の応答を SSE で流す。
 *
 * 目的は**課金せずに UI を一周させる**こと
 * （「UI の確認 → 固定の文字列を流し込む」）。
 *
 * シナリオを分けているのは、**エラー側の画面は本番では再現しにくい**ため。
 * 混雑・途中で切れる・空の応答は、狙って起こせるのはここだけ。
 *
 *     POST /api/chat?scenario=long
 */

import type { Context } from "hono";
import { stream } from "hono/streaming";

import { SSE_HEADERS, sseMessage } from "../sse.ts";

export const SCENARIOS = [
  "normal",
  "long",
  "slow",
  "error",
  "empty",
  "truncated",
  "emotion",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

const NORMAL =
  "明日の東京は晴れ時々くもりの見込みです。最高気温は二十四度、" +
  "最低気温は十六度で、日中は少し汗ばむくらいの陽気になりそうです。" +
  "夕方から雲が増えますが、雨の心配はいりません。";

const LONG =
  NORMAL +
  "\n\n" +
  "洗濯物は問題なく外に干せます。ただし午後は南寄りの風がやや強く吹くので、" +
  "軽いものは飛ばされないように留めておくと安心です。" +
  "\n\n" +
  "朝晩はまだ冷えます。出かけるときは羽織るものを一枚持っていくとちょうどいいでしょう。";

/**
 * 5 種類のタグを全部含む応答。**目で見て耳で聞いて確かめる**ためのもの
 * （docs/08「表情と声色の切り替わり」は課金ゼロで確かめられる）。
 *
 * `[1]` を混ぜてあるのは、**本文の角括弧が消えないこと**を同時に見るため。
 */
const EMOTION =
  "[neutral] 今日の予定を確認するのだ。" +
  "[happy] 全部かたづいたのだ！" +
  "[surprised] えっ、もうこんな時間なのだ。" +
  "[sad] ひとつだけ間に合わなかったのだ。" +
  "[angry] 次はぜったい忘れないのだ。" +
  "参考は [1] の資料なのだ。";

const SOURCES = [
  { uri: "https://vertexaisearch.example/redirect/abc", title: "tenki.jp" },
  { uri: "https://vertexaisearch.example/redirect/def", title: "weathernews.jp" },
];

/**
 * Hono を通らない経路（WebSocket）用。**同じ固定応答を素の Response で返す。**
 *
 * `stub` の分岐は HTTP のルーティングにしかなく、デバイスからの会話は
 * すべて WebSocket なので**素通りして課金されていた**。
 */
export function stubChatResponse(scenario: Scenario = "normal"): Response {
  const text =
    scenario === "long" ? LONG : scenario === "emotion" ? EMOTION : NORMAL;

  // `sseMessage` は Uint8Array を返すので、そのまま流す。
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks(text)) {
        controller.enqueue(sseMessage("delta", { text: chunk }));
        await sleep(40);
      }
      controller.enqueue(sseMessage("done", { stopReason: "end_turn" }));
      controller.close();
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}

export function handleStubChat(c: Context): Response {
  const scenario = pickScenario(c.req.query("scenario"));

  for (const [key, value] of Object.entries(SSE_HEADERS)) c.header(key, value);
  c.header("X-AIChatDevice-Provider", "claude");
  c.header("X-AIChatDevice-Model", "claude-haiku-4-5");
  c.header("X-AIChat-Stub-Scenario", scenario);

  return stream(c, async (writer) => {
    let cancelled = false;
    writer.onAbort(() => {
      cancelled = true;
    });

    if (scenario === "empty") {
      // 上流が何も返さずに終わった場合。画面が無言で固まらないこと。
      await writer.write(sseMessage("done", { stopReason: "empty" }));
      return;
    }

    // 「考え中」の見た目を確かめるための待ち。本物の Claude でも
    // 最初のトークンまでは1秒前後かかる。
    await sleep(scenario === "slow" ? 5_000 : 400);
    if (cancelled) return;

    const text =
      scenario === "long" ? LONG : scenario === "emotion" ? EMOTION : NORMAL;

    for (const chunk of chunks(text)) {
      if (cancelled) return;
      await writer.write(sseMessage("delta", { text: chunk }));
      await sleep(40);

      // 半分ほど流したところで切る。読み上げの途中でエラーに
      // なったときの見え方を確かめる。
      if (scenario === "error" && chunk.includes("十六度")) {
        await writer.write(
          sseMessage("error", { message: "混み合っています。しばらく待ってからお試しください。" }),
        );
        return;
      }
    }

    if (cancelled) return;
    await writer.write(sseMessage("sources", { sources: SOURCES }));
    await writer.write(
      sseMessage("done", {
        stopReason: scenario === "truncated" ? "max_tokens" : "end_turn",
      }),
    );
  });
}

/**
 * 数文字ずつに割る。
 *
 * 本物の上流も文字単位ではなくまとまりで届くので、それらしく揺らす。
 * 1文字ずつ流すと、文の区切りの検出（sentences.ts）が現実より
 * 甘い条件で通ってしまう。
 */
function* chunks(text: string): Generator<string> {
  let i = 0;
  let size = 3;
  while (i < text.length) {
    yield text.slice(i, i + size);
    i += size;
    size = (size % 5) + 2; // 2〜6 文字を巡回させる
  }
}

function pickScenario(value: string | undefined): Scenario {
  return isScenario(value) ? value : "normal";
}

function isScenario(value: unknown): value is Scenario {
  return (
    typeof value === "string" && (SCENARIOS as readonly string[]).includes(value)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
