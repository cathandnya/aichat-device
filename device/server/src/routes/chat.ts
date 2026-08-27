/**
 * POST /api/chat — 回答を作って SSE で返す。
 *
 * もとは Cloudflare Worker への中継だった。Worker をやめて AI を直接
 * 呼ぶようにしたので、ここは「本文を受けて `ai/chat.ts` に渡し、
 * 返ってきたストリームを画面へ流す」だけになった。
 *
 * **`c.req.raw.signal` を通すのが肝心。** 通し忘れると、画面で「やめる」を
 * 押しても生成が続き、誰も見ない回答に課金され続ける。
 */

import type { Context } from "hono";
import { stream } from "hono/streaming";

import { handleChat as generate } from "../ai/chat.ts";
import type { Runtime } from "../ai/types.ts";
import { SSE_HEADERS, sseMessage } from "../sse.ts";

export async function handleChat(c: Context, runtime: Runtime): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorStream(c, "送信内容を読み取れませんでした。");
  }

  let result: Response;
  try {
    result = await generate(body, c.req.raw.signal, runtime);
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

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
    } catch (error) {
      if (isAbort(error)) return;
      console.error("[chat] stream broke", label(error));
      await writer.write(sseMessage("error", { message: "通信が途切れました。" }));
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

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function label(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
}
