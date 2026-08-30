/**
 * function calling（タイマーの道具）。
 *
 * **本物の AI は呼ばない。** 偽の Gemini を立てて、道具を呼ぶ SSE を
 * 返させ、こちらが正しく実行して返しているかを見る。
 *
 * 見たいのは3つ。
 *   道具を呼ばれたら実行するか
 *   その結果を付けて**もう一度**上流に投げるか
 *   道具を使わない会話が今までどおりか
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.AICHAT_DATA_DIR = mkdtempSync(join(tmpdir(), "aichat-tools-"));

// **provider を gemini にしてから読み込む。** 既定は claude で、
// そのままだと本物の Anthropic SDK を掴んで再試行で止まる（実際に固まった）。
const { writeConfig, readConfig } = await import("../src/store.ts");
writeConfig({ ...readConfig(), provider: "gemini" });

const { handleChat } = await import("../src/ai/chat.ts");
type ServerTools = import("../src/ai/chat.ts").ServerTools;

/** 偽の Gemini。**呼ばれるたびに違う応答を返せる。** */
async function startFakeGemini(
  replies: string[][],
): Promise<{ url: string; bodies: string[]; close(): Promise<void> }> {
  const bodies: string[] = [];
  let call = 0;

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(body);
      const payloads = replies[Math.min(call, replies.length - 1)] ?? [];
      call += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const p of payloads) res.write(`data: ${p}\n\n`);
      res.end();
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function runtimeWith(url: string) {
  return {
    anthropicApiKey: "",
    geminiApiKey: "test",
    openaiApiKey: "",
    whisperUrl: "",
    appleSpeechUrl: "",
    geminiBaseUrl: url,
  };
}

const text = (t: string) =>
  JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] });

const call = (name: string, args: unknown) =>
  JSON.stringify({
    candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }],
  });

async function readText(response: Response): Promise<string> {
  const body = await response.text();
  let out = "";
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const parsed = JSON.parse(line.slice(6)) as { text?: string };
      if (parsed.text) out += parsed.text;
    } catch {
      // event 行などは読み飛ばす
    }
  }
  return out;
}

test("道具を呼ばれたら実行し、結果を付けてもう一度聞く", async () => {
  const fake = await startFakeGemini([
    [call("set_timer", { seconds: 180 })],
    [text("3分のタイマーをかけたのだ！")],
  ]);

  const executed: Array<{ name: string; args: unknown }> = [];
  const tools: ServerTools = {
    declarations: [{ name: "set_timer" }],
    execute: async (name, args) => {
      executed.push({ name, args });
      return { ok: true, remaining: "3分" };
    },
  };

  const response = await handleChat(
    { messages: [{ role: "user", content: "3分のタイマー" }] },
    AbortSignal.timeout(5_000),
    runtimeWith(fake.url),
    tools,
  );

  // 道具が実行された。
  assert.equal(executed.length, 1);
  assert.equal(executed[0]?.name, "set_timer");
  assert.deepEqual(executed[0]?.args, { seconds: 180 });

  // **2 回聞いている。** 1 回目は道具の呼び出し、2 回目が本文。
  assert.equal(fake.bodies.length, 2);

  // 2 回目のリクエストに、道具の結果が載っている。
  const second = JSON.parse(fake.bodies[1] ?? "{}") as {
    contents: Array<{ role: string; parts: unknown[] }>;
  };
  const flat = JSON.stringify(second.contents);
  assert.ok(flat.includes("functionCall"), "model の functionCall が無い");
  assert.ok(flat.includes("functionResponse"), "functionResponse が無い");
  assert.ok(flat.includes("3分"), "道具の返り値が渡っていない");

  // **利用者に届くのは 2 回目の本文だけ。**
  assert.equal(await readText(response), "3分のタイマーをかけたのだ！");

  await fake.close();
});

test("道具を使わない会話は 1 回で終わる", async () => {
  const fake = await startFakeGemini([[text("こんにちはなのだ")]]);
  const tools: ServerTools = {
    declarations: [{ name: "set_timer" }],
    execute: async () => ({ ok: true }),
  };

  const response = await handleChat(
    { messages: [{ role: "user", content: "こんにちは" }] },
    AbortSignal.timeout(5_000),
    runtimeWith(fake.url),
    tools,
  );

  assert.equal(fake.bodies.length, 1);
  assert.equal(await readText(response), "こんにちはなのだ");
  await fake.close();
});

test("**道具が転んでも会話は続く**", async () => {
  // 道具の失敗で黙るより、AI に伝えて言葉にしてもらうほうがよい。
  const fake = await startFakeGemini([
    [call("set_timer", { seconds: 60 })],
    [text("うまくいかなかったのだ")],
  ]);

  const tools: ServerTools = {
    declarations: [{ name: "set_timer" }],
    execute: async () => {
      throw new Error("こわれた");
    },
  };

  const response = await handleChat(
    { messages: [{ role: "user", content: "タイマー" }] },
    AbortSignal.timeout(5_000),
    runtimeWith(fake.url),
    tools,
  );

  assert.equal(fake.bodies.length, 2);
  assert.ok((fake.bodies[1] ?? "").includes("こわれた"), "失敗が伝わっていない");
  assert.equal(await readText(response), "うまくいかなかったのだ");
  await fake.close();
});

test("**道具を呼び続けても打ち切る**", async () => {
  // 呼んでは結果を見てまた呼ぶ、が止まらないと課金が延々と続く。
  const fake = await startFakeGemini([[call("set_timer", { seconds: 1 })]]);
  const tools: ServerTools = {
    declarations: [{ name: "set_timer" }],
    execute: async () => ({ ok: true }),
  };

  const response = await handleChat(
    { messages: [{ role: "user", content: "タイマー" }] },
    AbortSignal.timeout(5_000),
    runtimeWith(fake.url),
    tools,
  );

  assert.equal(response.status, 500);
  // 3 周で止まる。無限に投げ続けない。
  assert.equal(fake.bodies.length, 3);
  await fake.close();
});

test("道具に渡していない経路（画面）は検索つきのまま", async () => {
  const fake = await startFakeGemini([[text("はい")]]);

  await handleChat(
    { messages: [{ role: "user", content: "こんにちは" }] },
    AbortSignal.timeout(5_000),
    runtimeWith(fake.url),
    // tools を渡さない
  );

  const body = JSON.parse(fake.bodies[0] ?? "{}") as { tools: unknown[] };
  assert.ok(
    JSON.stringify(body.tools).includes("googleSearch"),
    "検索が外れている",
  );
  await fake.close();
});
