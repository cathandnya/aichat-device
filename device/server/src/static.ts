/**
 * Web UI の配信。
 *
 * 開発中は Vite の dev サーバーが配るのでここは通らない。
 * 据え置きで動かすときは `npm run build` した `device/web/dist` を
 * このサーバーが配る（プロセスを1つに保つ）。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";

const HERE = dirname(fileURLToPath(import.meta.url));
/** device/server/src → device/web/dist */
const DIST = join(HERE, "..", "..", "web", "dist");

export function mountStatic(app: Hono): boolean {
  if (!existsSync(DIST)) return false;

  // serveStatic の root は「このプロセスの作業ディレクトリからの相対」で
  // 受け取るので、絶対パスから作り直す。
  const root = "../web/dist";

  app.use("/*", serveStatic({ root }));
  // 拡張子の無い URL でも開けるようにする（Vite の dev サーバーにも
  // 同じ対応がある）。**index.html への総取りより先に置く。**
  app.get("/history", serveStatic({ root, path: "history.html" }));
  // 直接 URL を叩かれても画面を出す。
  app.get("*", serveStatic({ root, path: "index.html" }));

  return true;
}
