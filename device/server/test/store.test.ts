/**
 * 設定の保存の検証。
 *
 * KV からローカルのファイルに移した部分。ここが壊れると
 * デバイスが黙るので、読み書きと壊れたときの振る舞いを確かめる。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const DATA_DIR = mkdtempSync(join(tmpdir(), "aichat-store-"));
process.env.AICHAT_DATA_DIR = DATA_DIR;

const { readConfig, writeConfig, validatePatch } = await import("../src/store.ts");
const { DEFAULT_CONFIG } = await import("../src/ai/types.ts");

const CONFIG_PATH = join(DATA_DIR, "config.json");
const ALLOWED = ["gemini-3.7-flash", "gemini-3.6-flash"];

test("一度も保存していなければ既定値を返す", () => {
  // 初回はファイルが無い。異常ではないので既定値で動き始める。
  assert.deepEqual(readConfig(), DEFAULT_CONFIG);
});

test("書いたものが読める", () => {
  const config = { ...DEFAULT_CONFIG, version: 3, claudeModel: "claude-opus-5" as const };
  writeConfig(config);

  assert.deepEqual(readConfig(), config);
});

test("壊れたファイルでも既定値で動き続ける", () => {
  // 設定が読めないだけでチャット全体が止まるのは避けたい。
  writeFileSync(CONFIG_PATH, "{ これは JSON ではない");

  assert.deepEqual(readConfig(), DEFAULT_CONFIG);
});

test("1つのフィールドが壊れても他は保たれる", () => {
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ ...DEFAULT_CONFIG, version: 9, provider: "存在しない" }),
  );

  const config = readConfig();
  assert.equal(config.version, 9, "無事なフィールドまで捨てている");
  assert.equal(config.provider, DEFAULT_CONFIG.provider, "壊れた分は既定値に戻す");
});

test("保存したファイルは本人しか読めない", () => {
  // システムプロンプトが入るので、同じ機械の他のユーザーには見せない。
  writeConfig({ ...DEFAULT_CONFIG, systemPrompt: "家族向けの指示" });

  assert.equal(statSync(CONFIG_PATH).mode & 0o077, 0);
});

test("一時ファイルが残らない", () => {
  writeConfig({ ...DEFAULT_CONFIG, version: 5 });

  // rename で置き換えるので .tmp は残らない。
  assert.throws(() => readFileSync(`${CONFIG_PATH}.tmp`, "utf8"));
});

// --- 読み上げの速さ ---

test("許可された速さは通る", () => {
  const result = validatePatch(DEFAULT_CONFIG, { speechSpeed: 1.5 }, ALLOWED);

  assert.equal(result.ok, true);
  assert.equal(result.config?.speechSpeed, 1.5);
});

test("フォームからの文字列も受ける", () => {
  // 管理UI は form-data なので値は文字列で来る。
  const result = validatePatch(DEFAULT_CONFIG, { speechSpeed: "1.2" }, ALLOWED);

  assert.equal(result.ok, true);
  assert.equal(result.config?.speechSpeed, 1.2);
});

test("読み上げが壊れる値は拒否する", () => {
  // 自由入力にすると 0 や 100 を保存できてしまう。
  for (const bad of [0, -1, 100, 3, "はやく", null, NaN]) {
    const result = validatePatch(DEFAULT_CONFIG, { speechSpeed: bad }, ALLOWED);
    assert.equal(result.ok, false, String(bad));
  }
});

test("壊れた値が保存されていても既定値に戻す", () => {
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ ...DEFAULT_CONFIG, speechSpeed: 99 }),
  );

  assert.equal(readConfig().speechSpeed, DEFAULT_CONFIG.speechSpeed);
});

// --- 検証（KV の頃から変わらない部分） ---

test("端末内モデルは選べない", () => {
  // 据え置きデバイス専用なので provider は claude / gemini の二択。
  for (const value of ["automatic", "onDevice"]) {
    assert.equal(validatePatch(DEFAULT_CONFIG, { provider: value }, ALLOWED).ok, false, value);
  }
});

test("許可リストに無い音声認識モデルは拒否される", () => {
  // Workers AI をやめたので、以前の ID はもう通ってはいけない。
  const result = validatePatch(
    DEFAULT_CONFIG,
    { sttModel: "@cf/openai/whisper-large-v3-turbo" },
    ALLOWED,
  );

  assert.equal(result.ok, false);
  assert.match(String(result.errors?.[0]), /音声認識/);
});

test("触っていない項目はそのまま引き継がれる", () => {
  const current = { ...DEFAULT_CONFIG, systemPrompt: "元の指示", answerLength: "long" as const };
  const result = validatePatch(current, { provider: "gemini" }, ALLOWED);

  assert.equal(result.ok, true);
  assert.equal(result.config?.systemPrompt, "元の指示");
  assert.equal(result.config?.answerLength, "long");
  assert.equal(result.config?.version, current.version + 1, "版が上がっていない");
});
