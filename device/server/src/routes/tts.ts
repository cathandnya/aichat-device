/**
 * POST /api/tts — 読み上げ音声を作る。VOICEVOX Engine を呼ぶ。
 *
 * **なぜブラウザの speechSynthesis を使わないか。** 理由が3つある。
 *
 * 1. **Pi で日本語が出ない。** Linux の Chromium は自前の音声を持たず
 *    speech-dispatcher 経由で OS の TTS を呼ぶ。既定の espeak-ng は
 *    漢字を読めない。Mac には Kyoko が入っているので Mac だけで
 *    確かめると気づけない。**だから Mac の段階から VOICEVOX を使う。**
 * 2. **エコーキャンセルの参照に入らない。** ブラウザの AEC は「自分が
 *    鳴らした音」を参照信号にする。speech-dispatcher は別プロセスで
 *    音を出すのでその参照に入らず、読み上げ中の自分の声をマイクが
 *    拾ってループする。ここで作った WAV をブラウザ内の WebAudio で
 *    鳴らせば、確実に参照に入る。
 * 3. **置き場所の自由。** VOICEVOX が Mac のローカルか Pi か LAN の
 *    別マシンかは変わりうる。ブラウザから直接叩くと、変わるたびに
 *    フロントを書き換えることになる。
 *
 * VOICEVOX の `audio_query` → `synthesis` の2段はここで隠す。
 * ブラウザからは1回の呼び出しに見える。
 */

import type { Context } from "hono";

import type { Config } from "../config.ts";
import { readConfig } from "../store.ts";

/** 読み上げ1文ぶんの上限。文単位で投げる前提。 */
const MAX_TEXT_LENGTH = 500;

const TIMEOUT_MS = 20_000;

export async function handleTts(c: Context, config: Config): Promise<Response> {
  if (!config.voicevoxUrl) {
    return c.json(
      { error: { message: "読み上げの接続先が設定されていません。" } },
      503,
    );
  }

  let body: { text?: unknown; speaker?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: { message: "送信内容を読み取れませんでした。" } }, 400);
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return c.json({ error: { message: "読み上げる文がありません。" } }, 400);
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return c.json({ error: { message: "読み上げる文が長すぎます。" } }, 413);
  }

  const speaker =
    typeof body.speaker === "number" && Number.isInteger(body.speaker)
      ? body.speaker
      : config.voicevoxSpeaker;

  const signal = AbortSignal.any([
    c.req.raw.signal,
    AbortSignal.timeout(TIMEOUT_MS),
  ]);

  try {
    // 1段目: 読み・アクセント・長さを決める。
    const query = await fetch(
      `${config.voicevoxUrl}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`,
      { method: "POST", signal },
    );
    if (!query.ok) throw new Error(`audio_query ${query.status}`);

    // 速さは 1段目の結果に上書きして渡す。
    //
    // ブラウザ側で再生速度を上げる（`playbackRate`）方法もあるが、
    // そちらは声の高さまで上がって不自然になる。`speedScale` なら
    // 高さを保ったまま速く話す。
    const params = (await query.json()) as Record<string, unknown>;
    params.speedScale = readConfig().speechSpeed;

    // 2段目: 波形にする。
    const synthesis = await fetch(
      `${config.voicevoxUrl}/synthesis?speaker=${speaker}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal,
      },
    );
    if (!synthesis.ok) throw new Error(`synthesis ${synthesis.status}`);

    return new Response(await synthesis.arrayBuffer(), {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    console.error("[tts] voicevox failed", label(error));
    return c.json({ error: { message: "読み上げの音声を作れませんでした。" } }, 502);
  }
}

function label(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
}
