/**
 * マイクの取り込み。
 *
 * `getUserMedia` は secure context でしか動かない。HTTP で secure context
 * 扱いになるのは localhost / 127.0.0.1 だけなので、LAN の IP で開くと
 * ここが必ず失敗する。開発サーバーも 127.0.0.1 で開くこと。
 */

import { Endpointer, type EndpointEvents } from "./endpoint.ts";
import { SAMPLE_RATE, concat, encodeWav } from "./wav.ts";

export type CaptureResult =
  | { ok: true; wav: ArrayBuffer; seconds: number }
  | { ok: false; reason: "silence" };

export class MicrophoneError extends Error {}

/**
 * 1回ぶんの発話を録る。
 *
 * 話し終わり（無音 700ms）で自動的に止まる。`signal` でも止められる。
 */
export async function captureUtterance(
  events: EndpointEvents & { signal?: AbortSignal } = {},
): Promise<CaptureResult> {
  const stream = await openMicrophone();

  // レートを指定してグラフごと 16kHz で回す。自前のリサンプラは要らない。
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });

  try {
    // Firefox は sampleRate の指定を無視する。黙って進むと
    // 「なぜか認識精度が壊滅する」原因不明の不具合になるので、
    // ここで気づけるようにしておく。
    if (context.sampleRate !== SAMPLE_RATE) {
      console.warn(
        `AudioContext が ${context.sampleRate}Hz で動いています` +
          `（${SAMPLE_RATE}Hz を要求）。WAV にはこの値を書き込みます。`,
      );
    }

    await context.audioWorklet.addModule("./recorder-worklet.js");

    const source = context.createMediaStreamSource(stream);
    const recorder = new AudioWorkletNode(context, "recorder");
    source.connect(recorder);
    // 出力には繋がない。繋ぐと自分の声がスピーカーから出る。

    const endpointer = new Endpointer(events);

    const frames = await new Promise<Float32Array[] | null>((resolve) => {
      const stop = (value: Float32Array[] | null) => {
        recorder.port.onmessage = null;
        events.signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => stop(null);

      events.signal?.addEventListener("abort", onAbort, { once: true });

      recorder.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const result = endpointer.push(event.data);
        if (!result) return;
        stop(result.reason === "silence" ? null : result.samples);
      };
    });

    if (!frames) return { ok: false, reason: "silence" };

    const samples = concat(frames);
    return {
      ok: true,
      wav: encodeWav(samples, context.sampleRate),
      seconds: samples.length / context.sampleRate,
    };
  } finally {
    // マイクを掴んだままにしない。ブラウザの録音中の表示が
    // 出っぱなしになると、家族に不安を与える。
    for (const track of stream.getTracks()) track.stop();
    await context.close().catch(() => {});
  }
}

async function openMicrophone(): Promise<MediaStream> {
  if (!globalThis.isSecureContext) {
    throw new MicrophoneError(
      "この URL ではマイクを使えません。127.0.0.1 で開いてください。",
    );
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // 読み上げ中の自分の声を拾わないために要る。
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new MicrophoneError(
      name === "NotAllowedError"
        ? "マイクの使用が許可されていません。ブラウザの設定を確認してください。"
        : "マイクを使えませんでした。接続を確認してください。",
    );
  }
}
