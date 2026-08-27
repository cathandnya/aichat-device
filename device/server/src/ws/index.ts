/**
 * デバイスとの WebSocket。
 *
 * `/ws` で待ち受け、デバイス1台につき `Session` を1つ持つ。
 *
 * 音声はバイナリのフレーム（16kHz mono 16bit LE）で届く。
 * こちらからは JSON（状態・文字）とバイナリ（鳴らす WAV）を返す。
 * バイナリを送る前に `{type:"audio"}` を送って予告するので、
 * デバイス側は「次のバイナリは音声」と分かる。
 */

import type { Server } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import type { Config } from "../config.ts";
import type { DeviceMessage, ServerMessage } from "./protocol.ts";
import { Session } from "./session.ts";

/** 1フレームのバイト数（80ms × 16kHz × 16bit）。 */
const FRAME_BYTES = 1280 * 2;

/**
 * 一度に受け取るバイナリの上限。
 *
 * まとめて送られても構わないが、際限なく受けると
 * 壊れた相手に付き合ってメモリを食う。
 */
const MAX_CHUNK_BYTES = FRAME_BYTES * 64; // 約 5 秒

export function attachWebSocket(server: Server, config: Config): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket, request) => {
    const from = request.socket.remoteAddress ?? "?";
    console.log(`[ws] つながりました: ${from}`);

    const session = new Session(config, {
      send: (message: ServerMessage) => sendJson(socket, message),
      sendAudio: async (audio: Buffer) => {
        sendJson(socket, { type: "audio", bytes: audio.byteLength });
        await sendBinary(socket, audio);
      },
    });

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        onAudio(session, data);
        return;
      }
      onControl(session, data.toString("utf8"));
    });

    socket.on("close", () => {
      console.log(`[ws] 切れました: ${from}`);
      session.dispose();
    });

    socket.on("error", (error) => {
      console.error("[ws] エラー:", error.message);
      session.dispose();
    });
  });

  return wss;
}

function onAudio(session: Session, data: Buffer): void {
  if (data.byteLength === 0 || data.byteLength > MAX_CHUNK_BYTES) return;
  // 端数のバイトは捨てる（16bit の途中で切れている分）。
  const usable = data.byteLength - (data.byteLength % 2);

  // まとめて届いてもフレームに割り直す。デバイスの送り方に依存しない。
  for (let offset = 0; offset < usable; offset += FRAME_BYTES) {
    const end = Math.min(offset + FRAME_BYTES, usable);
    const slice = data.subarray(offset, end);
    // Buffer は共有メモリなので、コピーしてから Int16 として見る。
    const copy = Buffer.from(slice);
    session.onFrame(
      new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2),
    );
  }
}

function onControl(session: Session, raw: string): void {
  let message: DeviceMessage;
  try {
    message = JSON.parse(raw) as DeviceMessage;
  } catch {
    return; // 知らない形は読み飛ばす
  }

  if (message.type === "wake") session.onWakeRequest();
  if (message.type === "cancel") session.onCancel();
}

function sendJson(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function sendBinary(socket: WebSocket, data: Buffer): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState !== socket.OPEN) {
      resolve();
      return;
    }
    // 送り切るまで待つ。待たずに次を積むと、
    // 遅い回線で読み上げが前後する。
    socket.send(data, { binary: true }, () => resolve());
  });
}
