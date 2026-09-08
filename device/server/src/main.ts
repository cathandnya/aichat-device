/**
 * ローカルサーバーの起動。
 *
 *     node src/main.ts
 *
 * Node 22 は .ts をそのまま実行できる（型ストリッピング）ので、
 * ここにビルド手順を置いていない。別の機械に移すときも
 * `device/` を丸ごとコピーして `npm ci` だけで動く。
 */

import dns from "node:dns";

import { serve } from "@hono/node-server";

import { createApp } from "./app.ts";
import { attachWebSocket } from "./ws/index.ts";
import { bindWarning, loadDotEnv, readConfig, startupNotes } from "./config.ts";

/**
 * **`.local` の相手は IPv4 で引く。**
 *
 * 家の機械（電力計・水位・PC）は mDNS の名前で書いてある。この家では
 * `.local` を既定のまま引くと、**AAAA（IPv6）の問い合わせで詰まる**。
 * 水位センサーは IPv4 しか持たないのに 5 秒待っても繋がらず、
 * `house/*.ts` の上限は 3 秒なので**必ず「繋がりません」になる**
 * （実際に起きた。`curl -4` なら 0.04 秒で返る）。
 *
 * **`dns.setDefaultResultOrder("ipv4first")` では直らない。** あれは
 * 返ってきた結果を並べ替えるだけで、AAAA の問い合わせ自体は行うため、
 * 詰まる場所が変わらない。**`family: 4` を渡して A だけを引く**必要がある。
 *
 * `fetch`（undici）も内部でこの `dns.lookup` を使うので、ここで包めば
 * 家の機械への呼び出しすべてに効く。名前のまま書けるので、`.env` を
 * IP 直書きにせずに済む（DHCP で IP が変わっても追随する。実際に
 * 水位センサーは .43 から .60 に変わっていた）。
 */
const lookup = dns.lookup;
dns.lookup = ((
  hostname: string,
  options: unknown,
  callback: (...args: unknown[]) => void,
) => {
  if (typeof options === "function") {
    callback = options as (...args: unknown[]) => void;
    options = {};
  }
  const opts = typeof options === "number" ? { family: options } : { ...(options as object) };
  // 呼ぶ側が family を指定していれば尊重する。
  if (!("family" in opts) || !opts.family) (opts as { family?: number }).family = 4;
  return (lookup as (...args: unknown[]) => unknown)(hostname, opts, callback);
}) as unknown as typeof dns.lookup;

loadDotEnv();

let config;
try {
  config = readConfig();
} catch (error) {
  console.error(`設定が不正です: ${(error as Error).message}`);
  process.exit(1);
}

const warning = bindWarning(config.host, config.port);
if (warning) console.warn(`⚠ ${warning}`);
for (const note of startupNotes(config)) console.warn(`⚠ ${note}`);

const app = createApp(config);

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
  console.log(`aichat-device-server  http://${config.host}:${config.port}`);
  console.log(`  モード: ${config.mode}${config.mode === "live" ? "（AI の課金が発生します）" : "（課金なし）"}`);
  console.log(`  読み上げ: ${config.voicevoxUrl || "未設定"}`);
  console.log(`  管理UI: http://${config.host}:${config.port}/admin`);
  console.log("  画面の開発は device/web で `npm run dev`（http://127.0.0.1:9800）");
  console.log(`  デバイスの接続先: ws://${config.host}:${config.port}/ws`);
});

// デバイス（マイクと画面）はここに繋ぐ。
attachWebSocket(server as unknown as import("node:http").Server, config);
