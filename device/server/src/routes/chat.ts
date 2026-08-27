/**
 * POST /api/chat — 回答を作って SSE で返す。
 *
 * **受けるのは `{ chatId, content }`。** 会話の履歴はサーバーが持つので、
 * 呼ぶ側が `messages` を組み立てる必要がない。以前は画面側にも同じ
 * 「直近N往復・TTL」のロジックがあり、サーバーと二重になっていた。
 *
 * `chatId` が無ければ新しいチャットを作る。応答ヘッダ
 * `X-AIChatDevice-Chat-Id` で、どのチャットに入ったかを返す。
 *
 * **`c.req.raw.signal` を通すのが肝心。** 通し忘れると、画面で「やめる」を
 * 押しても生成が続き、誰も見ない回答に課金され続ける。
 */

import type { Context } from "hono";
import { stream } from "hono/streaming";

import { handleChat as generate } from "../ai/chat.ts";
import type { Runtime } from "../ai/types.ts";
import {
  appendTurn,
  createChat,
  endChat,
  messagesOf,
  reachedLimit,
  readChat,
} from "../chats/store.ts";
import { UNKNOWN_DEVICE_ID } from "../chats/types.ts";
import { readConfig } from "../store.ts";
import type { Source } from "../ws/protocol.ts";
import { SSELineParser, SSE_HEADERS, sseMessage } from "../sse.ts";

export async function handleChat(c: Context, runtime: Runtime): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorStream(c, "送信内容を読み取れませんでした。");
  }

  const { chatId, content } = (body ?? {}) as {
    chatId?: unknown;
    content?: unknown;
  };
  if (typeof content !== "string" || !content.trim()) {
    return errorStream(c, "送信内容が空です。");
  }

  // 続きなら読む。無ければ作る。
  let chat = typeof chatId === "string" ? readChat(chatId) : null;
  if (!chat) chat = createChat("web", UNKNOWN_DEVICE_ID);

  // 暴走よけ。文脈の長さは messagesOf が絞るので、ここに来るのは
  // 会話が異常に長く続いた場合だけ。
  if (reachedLimit(chat)) {
    endChat(chat.id, "limit");
    chat = createChat("web", UNKNOWN_DEVICE_ID);
  }

  const asked = appendTurn(chat.id, {
    role: "user",
    content: content.trim(),
    at: new Date().toISOString(),
  });
  const chatIdForTurn = chat.id;

  c.header("X-AIChatDevice-Chat-Id", chatIdForTurn);

  let result: Response;
  try {
    result = await generate(
      // **AI に送るのは直近の往復だけ。** 保存は全部のまま。
      { messages: messagesOf(asked ?? chat, readConfig().contextTurns) },
      c.req.raw.signal,
      runtime,
    );
  } catch (error) {
    if (isAbort(error)) return new Response(null, { status: 499 });
    console.error("[chat] failed", label(error));
    return errorStream(c, "AI の呼び出しに失敗しました。");
  }

  // ai/chat.ts は検証エラーや上流エラーを JSON で返す。
  // 画面側を「fetch できたら SSE を読む」の1経路に保ちたいので、
  // ここで SSE に直す。元の状態コードは X-Upstream-Status に残す。
  if (!result.ok || !result.body) {
    const message = await errorMessage(result);
    return errorStream(c, message, result.status);
  }

  for (const [key, value] of Object.entries(SSE_HEADERS)) c.header(key, value);
  passThrough(c, result, "X-AIChatDevice-Provider");
  passThrough(c, result, "X-AIChatDevice-Model");

  const body$ = result.body;

  return stream(c, async (writer) => {
    const reader = body$.getReader();
    writer.onAbort(() => void reader.cancel().catch(() => {}));

    // 流しながら控えておき、終わったら保存する。
    // 途中で切れた分も残す（そこまでは有効な回答なので）。
    const collector = new AnswerCollector();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        collector.push(value);
        await writer.write(value);
      }
    } catch (error) {
      if (isAbort(error)) return;
      console.error("[chat] stream broke", label(error));
      await writer.write(sseMessage("error", { message: "通信が途切れました。" }));
    } finally {
      collector.save(chatIdForTurn);
    }
  });
}

/**
 * エラーも **HTTP 200 + SSE** で返す。
 *
 * 状態コードで分岐させると、`response.ok` の判定と SSE の `error` の
 * 両方で同じ文言を出す羽目になり、片方だけ直す事故が起きる。
 */
function errorStream(c: Context, message: string, upstreamStatus?: number): Response {
  for (const [key, value] of Object.entries(SSE_HEADERS)) c.header(key, value);
  if (upstreamStatus) c.header("X-Upstream-Status", String(upstreamStatus));

  return stream(c, async (writer) => {
    await writer.write(sseMessage("error", { message }));
  });
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch {
    // JSON でなければ下の既定文言。
  }
  return "AI の呼び出しに失敗しました。";
}

function passThrough(c: Context, from: Response, name: string): void {
  const value = from.headers.get(name);
  if (value) c.header(name, value);
}

/**
 * 流れていく SSE から、保存する分を拾う。
 *
 * 画面へ流すのと同じバイト列を横目で読むだけなので、
 * 中継そのものは遅くならない。
 */
class AnswerCollector {
  private readonly parser = new SSELineParser();
  private text = "";
  private sources: Source[] = [];

  push(chunk: Uint8Array): void {
    for (const payload of this.parser.push(chunk)) {
      let event: { text?: string; sources?: Source[] };
      try {
        event = JSON.parse(payload) as never;
      } catch {
        continue; // 知らない形は読み飛ばす
      }
      if (typeof event.text === "string") this.text += event.text;
      if (Array.isArray(event.sources)) this.sources.push(...event.sources);
    }
  }

  save(chatId: string): void {
    if (!this.text) return; // 何も返らなかったときは残さない
    appendTurn(chatId, {
      role: "assistant",
      content: this.text,
      at: new Date().toISOString(),
      ...(this.sources.length ? { sources: this.sources } : {}),
    });
  }
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function label(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
}
