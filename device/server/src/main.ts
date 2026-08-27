/**
 * ローカルサーバーの起動。
 *
 *     node src/main.ts
 *
 * Node 22 は .ts をそのまま実行できる（型ストリッピング）ので、
 * ここにビルド手順を置いていない。Pi へ持っていくときも
 * `device/` を丸ごとコピーして `npm ci` だけで動く。
 */

import { serve } from "@hono/node-server";

import { createApp } from "./app.ts";
import { bindWarning, loadDotEnv, readConfig, startupNotes } from "./config.ts";

loadDotEnv();

let config;
try {
  config = readConfig();
} catch (error) {
  console.error(`設定が不正です: ${(error as Error).message}`);
  process.exit(1);
}

const warning = bindWarning(config.host);
if (warning) console.warn(`⚠ ${warning}`);
for (const note of startupNotes(config)) console.warn(`⚠ ${note}`);

const app = createApp(config);

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
  console.log(`aichat-device-server  http://${config.host}:${config.port}`);
  console.log(`  モード: ${config.mode}${config.mode === "live" ? "（AI の課金が発生します）" : "（課金なし）"}`);
  console.log(`  読み上げ: ${config.voicevoxUrl || "未設定"}`);
  console.log(`  管理UI: http://${config.host}:${config.port}/admin`);
  console.log("  画面の開発は device/web で `npm run dev`（http://127.0.0.1:5173）");
});
