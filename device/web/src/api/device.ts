/**
 * デバイスと同じ経路（WebSocket）でサーバーに繋ぐ。
 *
 * マイクを開いているときはこちらを使う。**サーバーが状態機械を持ち**、
 * ウェイクワードの判定・音声認識・AI・読み上げまでを行う。
 * 画面は「送る・受け取って描く・鳴らす」だけになる。
 *
 * マイクを閉じているときの「押して話す」は HTTP の経路（`client.ts`）。
 * あちらは押している間だけマイクを開くので、常時待ち受けにしたくない
 * ときのために残してある。
 */

import type { Source } from "./client.ts";

/** サーバーが持つ状態。画面はこれをそのまま映す。 */
export type DeviceState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "following"
  | "error";

export type DeviceEvent =
  | { type: "state"; state: DeviceState; status: string }
  | { type: "question"; text: string }
  /** **累積全文。** 差分ではないので置き換える。 */
  | { type: "answer"; text: string }
  | { type: "sources"; sources: Source[] }
  | { type: "chat"; chatId: string; title: string }
  /** ウェイクワードで起こされた。効果音を鳴らす合図。 */
  | { type: "wake" }
  | { type: "error"; message: string }
  /** 読み上げの音声（WAV）。 */
  | { type: "audio"; wav: ArrayBuffer }
  | { type: "closed" };

export class DeviceSocket {
  private socket: WebSocket | null = null;
  /** 直前に「次はバイナリ」と予告があったか。 */
  private expectAudio = false;

  connect(onEvent: (event: DeviceEvent) => void): void {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${scheme}//${location.host}/ws`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) {
        // 予告のあとに届いたバイナリだけを音声として扱う。
        if (!this.expectAudio) return;
        this.expectAudio = false;
        onEvent({ type: "audio", wav: event.data });
        return;
      }

      let message: { type: string } & Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data)) as never;
      } catch {
        return; // 知らない形は読み飛ばす
      }

      if (message.type === "audio") {
        this.expectAudio = true;
        return;
      }
      // `config` は画面下のモデル名に使っているが、HTTP 経路でも
      // 取れているのでここでは流さない。
      if (message.type === "config") return;

      onEvent(message as never);
    });

    socket.addEventListener("close", () => onEvent({ type: "closed" }));
    socket.addEventListener("error", () => onEvent({ type: "closed" }));
  }

  /** 音声のフレームを送る。 */
  sendFrame(pcm: ArrayBuffer): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(pcm);
  }

  /** ボタンで起こす（ウェイクワードを言わずに始める）。 */
  wake(): void {
    this.send({ type: "wake" });
  }

  cancel(): void {
    this.send({ type: "cancel" });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  get open(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private send(message: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }
}
