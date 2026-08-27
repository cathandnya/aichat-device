/**
 * 読み上げ音声を作る。
 *
 * `routes/tts.ts` から切り出したもの。ブラウザから叩かれる経路と、
 * WebSocket の会話から呼ぶ経路の両方が要るため。
 *
 * VOICEVOX の `audio_query` → `synthesis` の2段はここで隠す。
 */

import type { Config } from "../config.ts";
import { readConfig } from "../store.ts";

/** 読み上げ1文ぶんの上限。文単位で投げる前提。 */
export const MAX_TEXT_LENGTH = 500;

const TIMEOUT_MS = 20_000;

export class TtsError extends Error {}

export async function synthesize(
  text: string,
  config: Config,
  signal: AbortSignal,
): Promise<Buffer> {
  if (!config.voicevoxUrl) {
    throw new TtsError("読み上げの接続先が設定されていません。");
  }

  const saved = readConfig();
  const speaker = config.voicevoxSpeaker;
  const merged = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);

  // 1段目: 読み・アクセント・長さを決める。
  const query = await fetch(
    `${config.voicevoxUrl}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`,
    { method: "POST", signal: merged },
  );
  if (!query.ok) throw new TtsError(`audio_query ${query.status}`);

  // 速さは 1段目の結果に上書きする。ブラウザ側で再生速度を上げる方法も
  // あるが、そちらは声の高さまで上がって不自然になる。
  const params = (await query.json()) as Record<string, unknown>;
  params.speedScale = saved.speechSpeed;

  // 2段目: 波形にする。
  const synthesis = await fetch(`${config.voicevoxUrl}/synthesis?speaker=${speaker}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: merged,
  });
  if (!synthesis.ok) throw new TtsError(`synthesis ${synthesis.status}`);

  return Buffer.from(await synthesis.arrayBuffer());
}
