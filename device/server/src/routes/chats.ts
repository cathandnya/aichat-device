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

export function handleListChats(c: Context): Response {
  return c.json({ chats: listChats() }, 200, { "Cache-Control": "no-store" });
}

export function handleGetChat(c: Context): Response {
  const chat = readChat(c.req.param("id") ?? "");
  if (!chat) {
    return c.json({ error: { message: "そのチャットはありません。" } }, 404);
  }
  return c.json(chat, 200, { "Cache-Control": "no-store" });
}

export function handleCreateChat(c: Context): Response {
  // Web UI の「新しいチャット」から呼ばれる。
  return c.json(createChat("web"), 201, { "Cache-Control": "no-store" });
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
