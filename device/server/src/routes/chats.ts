/**
 * チャット履歴の API。
 *
 * デバイスと Web UI で履歴を共有する。家族用の1台なので分ける意味が薄く、
 * 「さっき何を聞いたか」が見えるのはむしろ望ましい。
 */

import type { Context } from "hono";

import {
  createChat,
  deleteChat,
  endChat,
  listChats,
  readChat,
} from "../chats/store.ts";
import { UNKNOWN_DEVICE_ID, normalizeDeviceId } from "../chats/types.ts";

/**
 * 一覧。`?device=<id>` でその端末のものだけに絞れる。
 *
 * **絞るのは呼ぶ側の判断。** 画面（`/history`）は自分の端末のぶんだけ、
 * 管理画面（`/history?all=1`）は全部を見る。既定は全部で、いままでと変わらない。
 */
export function handleListChats(c: Context): Response {
  const device = normalizeDeviceId(c.req.query("device"));
  const chats = device
    ? listChats().filter((chat) => chat.deviceId === device)
    : listChats();
  return c.json({ chats }, 200, { "Cache-Control": "no-store" });
}

export function handleGetChat(c: Context): Response {
  const chat = readChat(c.req.param("id") ?? "");
  if (!chat) {
    return c.json({ error: { message: "そのチャットはありません。" } }, 404);
  }
  return c.json(chat, 200, { "Cache-Control": "no-store" });
}

export function handleCreateChat(c: Context): Response {
  // HTTP の経路に端末の概念は無い。名乗る手段を足すのは、名乗りたいものが
  // 現れてから（検証の入口を `ws/index.ts` の1つに保ちたい）。
  return c.json(createChat("web", UNKNOWN_DEVICE_ID), 201, {
    "Cache-Control": "no-store",
  });
}

export function handleDeleteChat(c: Context): Response {
  const id = c.req.param("id") ?? "";
  if (!deleteChat(id)) {
    return c.json({ error: { message: "そのチャットはありません。" } }, 404);
  }
  return c.body(null, 204);
}

/** Web UI が仕切り直したときに、開いていたチャットを閉じる。 */
export function handleEndChat(c: Context): Response {
  const id = c.req.param("id") ?? "";
  if (!readChat(id)) {
    return c.json({ error: { message: "そのチャットはありません。" } }, 404);
  }
  endChat(id, "manual");
  return c.body(null, 204);
}
