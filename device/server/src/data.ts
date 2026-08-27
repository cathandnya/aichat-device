/**
 * `data/` への読み書き。
 *
 * 設定・モデル一覧・チャット履歴が同じ作法で書かれるようにここへ集めた。
 * 以前は store.ts と ai/gemini-models.ts で同じ処理を書き分けており、
 * **権限の指定が片方だけ抜けていた**（config.json は 0600、
 * gemini-models.json は 0644）。集約でそれも揃う。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 保存先。テストは `AICHAT_DATA_DIR` で逃がす。
 *
 * **モジュールを読み込んだ時点で決まる。** テストでは src を import する前に
 * 環境変数を立てること。
 */
export const DATA_DIR =
  process.env.AICHAT_DATA_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "data");

export function dataPath(...segments: string[]): string {
  return join(DATA_DIR, ...segments);
}

/**
 * JSON を書く。**一時ファイル → rename** で置き換える。
 *
 * rename は同じファイルシステム上では不可分なので、途中で電源が落ちても
 * 「古い内容」か「新しい内容」のどちらかが残り、壊れた JSON にはならない。
 * 設定が壊れるとデバイスが黙るので、ここは丁寧にやる価値がある。
 *
 * 権限を 0600 にするのは、システムプロンプトや会話の中身が入るため。
 * 同じ機械の他の利用者には見せない。
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });

  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temp, path);
}

/**
 * JSON を読む。**throw しない。**
 *
 * 読めないだけでデバイス全体が止まるのは避けたい。呼び出し側が
 * 既定値に倒せるよう null を返す。ファイルが無いのは異常ではないので
 * 黙って null（初回は必ずこれになる）。
 */
export function readJsonSafe(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`読めませんでした: ${path}`, error);
    }
    return null;
  }
}
