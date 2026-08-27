/**
 * デバイスとの WebSocket。
 *
 * `/ws` で待ち受け、デバイス1台につき `Session` を1つ持つ。
 *
 * `?mode=wake` で繋ぐと、**判定だけを行う試験用の経路**（`WakeProbe`）になる。
 * チャットを作らず AI を呼ばないので、誤起動を何時間測っても費用はゼロ。
 *
 * 音声はバイナリのフレーム（16kHz mono 16bit LE）で届く。
 * こちらからは JSON（状態・文字）とバイナリ（鳴らす WAV）を返す。
 * バイナリを送る前に `{type:"audio"}` を送って予告するので、
 * デバイス側は「次のバイナリは音声」と分かる。
 */

import type { Server } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import {
  UNKNOWN_DEVICE_ID,
  normalizeDeviceId,
} from "../chats/types.ts";
import type { Config } from "../config.ts";
import type { DeviceMessage, ServerMessage } from "./protocol.ts";
import { Session } from "./session.ts";
import { WakeProbe } from "./wake-probe.ts";

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
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.searchParams.get("mode") === "wake") {
      console.log(`[ws] ウェイクワードの試験: ${from}`);
      attachProbe(socket, config);
      return;
    }

    // **端末 id はここでだけ確かめる。** 通った値は「保存してよい・画面に
    // 出してよい・ファイル名に入れてよい」と保証されたものとして下流へ渡す。
    // 名乗らない端末は1つにまとめる（古いクライアントや素の接続）。
    const deviceId =
      normalizeDeviceId(url.searchParams.get("device")) || UNKNOWN_DEVICE_ID;

    console.log(`[ws] つながりました: ${from} (${deviceId})`);

    const session = new Session(config, {
      send: (message: ServerMessage) => sendJson(socket, message),
      sendAudio: async (audio: Buffer) => {
        sendJson(socket, { type: "audio", bytes: audio.byteLength });
        await sendBinary(socket, audio);
      },
    }, deviceId);

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

/** 判定だけの接続。チャットも AI も動かない。 */
function attachProbe(socket: WebSocket, config: Config): void {
  const probe = new WakeProbe(config, {
    send: (message) => sendJson(socket, message),
  });

  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      forEachFrame(data, (frame) => probe.onFrame(frame));
      return;
    }
    try {
      const message = JSON.parse(data.toString("utf8")) as DeviceMessage;
      if (message.type === "wake-words") probe.setWords(message.words);
    } catch {
      // 知らない形は読み飛ばす
    }
  });

  socket.on("close", () => {
    console.log("[ws] 試験を終えました");
    probe.dispose();
  });
  socket.on("error", () => probe.dispose());
}

function onAudio(session: Session, data: Buffer): void {
  forEachFrame(data, (frame) => session.onFrame(frame));
}

/**
 * 受け取ったバイナリをフレームに割り直す。
 *
 * まとめて届いても構わないようにしてある（デバイスの送り方に依存しない）。
 */
function forEachFrame(data: Buffer, onFrame: (frame: Int16Array) => void): void {
  if (data.byteLength === 0 || data.byteLength > MAX_CHUNK_BYTES) return;
  // 端数のバイトは捨てる（16bit の途中で切れている分）。
  const usable = data.byteLength - (data.byteLength % 2);

  for (let offset = 0; offset < usable; offset += FRAME_BYTES) {
    const end = Math.min(offset + FRAME_BYTES, usable);
    // Buffer は共有メモリなので、コピーしてから Int16 として見る。
    const copy = Buffer.from(data.subarray(offset, end));
    onFrame(new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2));
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
