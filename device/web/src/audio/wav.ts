/**
 * 録音した波形を WAV にする。DOM に触らないのでテストできる。
 *
 * サーバーの /api/stt は 16kHz mono 16bit の WAV を想定している
 * （device/server/src/ai/stt.ts）。ここで作る形が合っていないと、
 * 認識精度だけが静かに落ちて原因が分かりにくい。
 */

export const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const HEADER_BYTES = 44;

/**
 * 受け付ける音声の上限。サーバーの MAX_AUDIO_BYTES と同じ値。
 *
 * ブラウザとサーバーで別の npm プロジェクトなので写している。
 * **device/server/src/ai/types.ts を変えたらここも直す。**
 */
export const MAX_AUDIO_BYTES = 1_000_000;

/** 上限に収まる録音の長さ（秒）。約 31 秒。 */
export const MAX_SECONDS = (MAX_AUDIO_BYTES - HEADER_BYTES) / (SAMPLE_RATE * BYTES_PER_SAMPLE);

/**
 * Float32 の並びを 16bit PCM の WAV にする。
 *
 * `sampleRate` を引数で受けるのは、AudioContext が指定どおりの
 * レートで動いていない場合にその値を正直に書き込むため。
 * 16000 と偽って書くと、上流には「速回しの音」に聞こえる。
 */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number = SAMPLE_RATE,
): ArrayBuffer {
  const buffer = new ArrayBuffer(HEADER_BYTES + samples.length * BYTES_PER_SAMPLE);
  const view = new DataView(buffer);

  const byteRate = sampleRate * BYTES_PER_SAMPLE;
  const dataBytes = samples.length * BYTES_PER_SAMPLE;

  ascii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // これ以降のバイト数
  ascii(view, 8, "WAVE");

  ascii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt チャンクの長さ
  view.setUint16(20, 1, true); // 1 = リニア PCM
  view.setUint16(22, 1, true); // モノラル
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true); // ブロックの大きさ
  view.setUint16(34, 16, true); // 量子化ビット数

  ascii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i += 1) {
    // クリップしてから整数にする。これを省くと、大きな声のときに
    // 値が回り込んで耳障りなノイズになり、認識も落ちる。
    const clamped = Math.max(-1, Math.min(1, samples[i] as number));
    view.setInt16(
      HEADER_BYTES + i * BYTES_PER_SAMPLE,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
  }

  return buffer;
}

/** いくつもの塊を1本に繋ぐ。 */
export function concat(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;

  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/** 塊の実効音量。無音判定に使う。 */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;

  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] as number;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

function ascii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
