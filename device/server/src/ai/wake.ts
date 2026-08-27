/**
 * ウェイクワードの判定。
 *
 * 専用モデルを学習させず、**音声認識を短い窓で回し続けて
 * 書き起こしに語が出たら起動する**。音声がサーバーに来ている構成だから
 * できること。
 *
 * ### なぜこれで足りるか（実測・docs/06）
 *
 * 「ずんだもん」で **検出 10/10・誤起動 0/15**。1窓あたり 0.14〜0.15 秒で、
 * 毎秒投げても CPU 1コアの 12〜15%。**学習が要らない**のが最大の利点で、
 * 語を変えたくなっても設定を書き換えるだけで済む。
 *
 * ### ウェイクワードは「綴り」ではなく「認識器が出す文字列」で決める
 *
 * 当初の候補「ねえアイチャット」は、話者や速度を変えても一貫して
 * **「恋愛チャット」**と書き起こされた。辞書に無い並びを実在語に
 * 寄せてしまうため。「ねえ」で始まる語は軒並みだめだった
 * （ねえアシスタント → ネイ／レイ／名）。
 *
 * なので **判定語は複数持てる**ようにしてある。濁点が落ちた
 * 「すんだもん」のような認識器の癖を、あとから足せる形にしておく。
 */

import { encodeWav } from "../audio/format.ts";
import { SttError } from "./stt.ts";
import type { Runtime, SttModel } from "./types.ts";

/** 判定に使う窓の長さ（秒）。短い語なら 2 秒で足りる。 */
export const WAKE_WINDOW_SEC = 2.0;

/** 窓をずらす幅（秒）。短いほど反応が速く、CPU を食う。 */
export const WAKE_HOP_SEC = 1.0;

/**
 * 比べる前に整える。
 *
 * SpeechAnalyzer は**語の区切りに空白を入れ、長音を落とす**
 * （「ずんだもん」→「ず んだも ん」、「ハローアイチャット」→「ハロアイチャット」）。
 * 記号・全半角の揺れも含めて落としてから比べる。
 */
export function normalizeHeard(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\s、。！？!?・ー]/g, "");
}

/** 書き起こしに判定語が含まれるか。 */
export function matchesWake(heard: string, patterns: readonly string[]): boolean {
  const normalized = normalizeHeard(heard);
  if (!normalized) return false;

  return patterns.some((pattern) => {
    const p = normalizeHeard(pattern);
    return p.length > 0 && normalized.includes(p);
  });
}

/**
 * 窓を1つ判定する。
 *
 * 書き起こしに失敗しても throw しない。ウェイクワードの待ち受けは
 * 延々と回るので、一時的な失敗で止めたくない。
 */
export async function detectWake(
  pcm: Int16Array,
  patterns: readonly string[],
  model: SttModel,
  runtime: Runtime,
  transcribe: (
    audio: ArrayBuffer,
    model: SttModel,
    runtime: Runtime,
    signal: AbortSignal,
  ) => Promise<string>,
): Promise<{ fired: boolean; heard: string }> {
  const wav = encodeWav(pcm);
  const buffer = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);

  let heard = "";
  try {
    heard = await transcribe(
      buffer as ArrayBuffer,
      model,
      runtime,
      AbortSignal.timeout(5_000),
    );
  } catch (error) {
    // 接続できない・鍵が無いといった設定の誤りは伝える価値がある。
    // それ以外（一時的な失敗）は黙って次の窓へ。
    if (error instanceof SttError) {
      console.error("[wake]", error.message);
    }
    return { fired: false, heard: "" };
  }

  return { fired: matchesWake(heard, patterns), heard };
}
