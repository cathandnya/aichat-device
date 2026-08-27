/**
 * マイクの取り込み。
 *
 * `getUserMedia` は secure context でしか動かない。HTTP で secure context
 * 扱いになるのは localhost / 127.0.0.1 だけなので、LAN の IP で開くと
 * ここが必ず失敗する。開発サーバーも 127.0.0.1 で開くこと。
 */

export class MicrophoneError extends Error {}

export async function openMicrophone(): Promise<MediaStream> {
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
