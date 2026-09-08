/**
 * GET /api/config — いまの設定を画面に配る。
 *
 * 画面下の「いま Haiku 4.5」という表示のためだけに使う。
 * 同じプロセスのファイルを読むだけなのでキャッシュは持たない。
 */

import type { Context } from "hono";

import { readConfig } from "../store.ts";

export function handleConfig(c: Context): Response {
  const { systemPrompt: _hidden, ...rest } = readConfig();

  // systemPrompt は落とす。秘密ではないが、家族が読むための情報ではない。
  // 管理者は /admin で見られる。
  return c.json(rest, 200, { "Cache-Control": "no-store" });
}
