/**
 * POST /api/stt — 音声を文字にする。
 *
 * 本文は WAV のバイト列そのまま。multipart にしないのは、画面側の
 * 実装が単純になり、こちらもそのまま上流へ渡せるため。
 *
 * どのモデルを使うかは画面から受け取らない。保存された設定だけが効く。
 */

import type { Context } from "hono";

import { SttError, transcribe } from "../ai/stt.ts";
import { MAX_AUDIO_BYTES, type Runtime } from "../ai/types.ts";
import { readConfig } from "../store.ts";

export async function handleStt(c: Context, runtime: Runtime): Promise<Response> {
  // Content-Length が無い（チャンク送信）場合もあるので、
  // ここでの拒否は早期打ち切りに留め、読み取り後にも確かめる。
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_AUDIO_BYTES) {
    return c.json({ error: { message: "音声が長すぎます。" } }, 413);
  }

  const audio = await c.req.arrayBuffer();
  if (audio.byteLength === 0) {
    return c.json({ error: { message: "音声が空です。" } }, 400);
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    return c.json({ error: { message: "音声が長すぎます。" } }, 413);
  }

  const config = readConfig();

  try {
    const text = await transcribe(audio, config.sttModel, runtime, c.req.raw.signal);

    // 無音のときは空文字が返る。エラーにはせず、画面が
    // 「聞き取れませんでした」を出して待機に戻る。
    return c.json({ text }, 200, {
      "Cache-Control": "no-store",
      "X-AIChatDevice-STT-Model": config.sttModel,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    if (error instanceof SttError) {
      return c.json({ error: { message: error.message } }, 502);
    }
    console.error("[stt] failed", label(error));
    return c.json({ error: { message: "音声の認識に失敗しました。" } }, 502);
  }
}

function label(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
}
