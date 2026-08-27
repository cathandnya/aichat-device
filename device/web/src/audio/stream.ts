/**
 * マイクの音を 80ms ごとにサーバーへ流す。
 *
 * ウェイクワードを効かせるには、音が常時サーバーに届いている必要がある。
 * **サーバーの時計はフレームの到着そのもの**なので、無音でも送り続ける。
 *
 * 1発話ぶんを録って WAV にする経路（`capture.ts` の `captureUtterance`）とは別物。
 * あちらはマイクを閉じているときの「押して話す」で使う。
 */

import { openMicrophone } from "./capture.ts";
import { SAMPLE_RATE } from "./wav.ts";

/** 80ms。サーバーの取り決め（1280 サンプル）と同じ。 */
const FRAME_SAMPLES = 1280;

export class SampleRateError extends Error {}

export class MicStream {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;

  /**
   * マイクを開いて流し始める。
   *
   * `onFrame` には 16bit PCM のバイト列（2560 バイト）が渡る。
   */
  async open(onFrame: (pcm: ArrayBuffer) => void): Promise<void> {
    this.stream = await openMicrophone();

    // サーバーは 16kHz 固定なので、グラフごとそのレートで回す。
    this.context = new AudioContext({ sampleRate: SAMPLE_RATE });

    // **Firefox はこの指定を無視する。** 1発話ぶんを WAV にする経路では
    // ヘッダに実測値を書いて逃げていたが、こちらは生の PCM を流すので
    // 誤魔化せない。黙って精度が壊れるより、開かないほうがよい。
    if (this.context.sampleRate !== SAMPLE_RATE) {
      const actual = this.context.sampleRate;
      await this.close();
      throw new SampleRateError(
        `このブラウザは ${actual}Hz で動いており、${SAMPLE_RATE}Hz に固定できません。` +
          "Chrome か Safari で開いてください。",
      );
    }

    await this.context.audioWorklet.addModule("./recorder-worklet.js");

    const source = this.context.createMediaStreamSource(this.stream);
    const recorder = new AudioWorkletNode(this.context, "recorder");
    source.connect(recorder);
    // 出力には繋がない。繋ぐと自分の声がスピーカーから出る。

    recorder.port.onmessage = (event: MessageEvent<Float32Array>) => {
      onFrame(toPcm(event.data));
    };
  }

  async close(): Promise<void> {
    // マイクを掴んだままにしない。録音中の表示が出っぱなしだと不安になる。
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;

    await this.context?.close().catch(() => {});
    this.context = null;
  }
}

/**
 * Float32（-1〜1）を 16bit PCM にする。
 *
 * **クリップしてから整数にする。** 省くと大きな音で値が回り込み、
 * 正の音が負になって認識が壊れる（`wav.ts` と同じ扱い）。
 */
function toPcm(samples: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(FRAME_SAMPLES);
  const n = Math.min(samples.length, FRAME_SAMPLES);

  for (let i = 0; i < n; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] as number));
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return pcm.buffer;
}
