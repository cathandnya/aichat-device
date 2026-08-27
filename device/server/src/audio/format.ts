/**
 * 音声の形式。デバイスとサーバーの取り決め。
 *
 * デバイスは 16kHz mono 16bit のリトルエンディアンを 80ms（1280 サンプル）
 * ずつ送ってくる。80ms にしているのは、将来ウェイクワードを専用モデルに
 * 切り替えたときのフレーム長に合わせるため。
 */

export const SAMPLE_RATE = 16_000;
export const FRAME_SAMPLES = 1280;
export const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000; // 80

/** 音声認識に投げられる最大の長さ。長すぎる録音を打ち切る根拠。 */
export const MAX_UTTERANCE_SEC = 20;

/**
 * 16bit PCM を WAV にする。
 *
 * ブラウザ版（web/src/audio/wav.ts）と同じ形。あちらは Float32 から
 * 変換していたが、こちらは既に 16bit で届くのでヘッダを付けるだけ。
 */
export function encodeWav(pcm: Int16Array, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  const dataBytes = pcm.length * 2;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);

  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt チャンクの長さ
  header.writeUInt16LE(1, 20); // 1 = リニア PCM
  header.writeUInt16LE(1, 22); // モノラル
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // バイト毎秒
  header.writeUInt16LE(2, 32); // ブロックの大きさ
  header.writeUInt16LE(16, 34); // 量子化ビット数

  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);

  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, dataBytes)]);
}

/**
 * WAV が何ミリ秒鳴るか。
 *
 * **追い質問の窓をいつ開くか**の根拠。送り終わった時点から数えると、
 * 鳴っている時間ぶん窓が短くなる（8秒のはずが実測で6秒台）。
 * デバイスからの「鳴り終わった」を待つ手もあるが、取り決めを増やさずに
 * 済むほうを採る。読み上げの速さは VOICEVOX 側で掛かるので、
 * ここで測る長さがそのまま実際に鳴る長さになる。
 *
 * ヘッダを走査するのは、`fmt ` と `data` の間に別のチャンクが
 * 挟まっても壊れないようにするため。読めなければ 0（待たない）。
 */
export function wavDurationMs(wav: Buffer): number {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") return 0;

  let bytesPerSecond = 0;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt " && size >= 16) bytesPerSecond = wav.readUInt32LE(body + 8);
    if (id === "data") {
      if (!bytesPerSecond) return 0;
      const bytes = Math.min(size, wav.length - body);
      return (bytes / bytesPerSecond) * 1000;
    }
    offset = body + size + (size % 2); // チャンクは偶数境界に揃う
  }
  return 0;
}

/** 実効音量（0〜1）。無音判定に使う。 */
export function rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;

  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const value = (pcm[i] as number) / 0x8000;
    sum += value * value;
  }
  return Math.sqrt(sum / pcm.length);
}
