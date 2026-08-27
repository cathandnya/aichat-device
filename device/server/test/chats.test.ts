/**
 * チャット履歴の保存の検証。
 *
 * データベースを使わずファイルにした判断（docs/07・計画）を、
 * 実際の振る舞いで裏づける。壊れた1件で全部を失わないことが肝。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const DATA_DIR = mkdtempSync(join(tmpdir(), "aichat-chats-"));
process.env.AICHAT_DATA_DIR = DATA_DIR;

// env を立ててから src を読み込む（保存先はモジュール読み込み時に確定する）。
const store = await import("../src/chats/store.ts");
const { titleFrom } = await import("../src/chats/types.ts");

const CHATS = join(DATA_DIR, "chats");
const at = () => new Date().toISOString();

/** 連番の id を確実に分けるため、時刻をずらして作る。 */
function makeChat(i: number) {
  return store.createChat("device", new Date(2026, 0, 1, 0, 0, i));
}

// --- 基本 ---

test("作って追記して読み直せる", () => {
  const chat = store.createChat("device");

  store.appendTurn(chat.id, { role: "user", content: "明日の天気は", at: at() });
  store.appendTurn(chat.id, { role: "assistant", content: "晴れです", at: at() });

  const read = store.readChat(chat.id);
  assert.equal(read?.turns.length, 2);
  assert.equal(read?.turns[0]?.content, "明日の天気は");
  assert.equal(read?.origin, "device");
});

test("題名は最初の質問から決まる", () => {
  // AI に付けさせると呼び出しが1回増えて遅くなるので、冒頭を切り出す。
  const chat = store.createChat("web");
  assert.equal(chat.title, "（無題）");

  store.appendTurn(chat.id, { role: "user", content: "晩ごはん何にしよう", at: at() });
  assert.equal(store.readChat(chat.id)?.title, "晩ごはん何にしよう");

  // 2つめの質問では変わらない。
  store.appendTurn(chat.id, { role: "user", content: "他には", at: at() });
  assert.equal(store.readChat(chat.id)?.title, "晩ごはん何にしよう");
});

test("長い質問の題名は切り詰める", () => {
  const long = "あ".repeat(100);
  assert.ok(titleFrom(long).length < 30);
  assert.ok(titleFrom(long).endsWith("…"));
  assert.equal(titleFrom("   "), "（無題）");
});

test("id は時系列に並ぶ", () => {
  // 一覧の並べ替えをファイル名だけで済ませるための前提。
  const a = store.newChatId(new Date(2026, 0, 1, 10, 0, 0));
  const b = store.newChatId(new Date(2026, 0, 1, 10, 0, 1));
  assert.ok(a < b, `${a} < ${b} でない`);
});

// --- 一覧 ---

test("一覧は新しい順", () => {
  const first = makeChat(10);
  const second = makeChat(11);
  store.appendTurn(first.id, { role: "user", content: "ひとつめ", at: at() });
  store.appendTurn(second.id, { role: "user", content: "ふたつめ", at: at() });

  const list = store.listChats();
  const ids = list.map((c) => c.id);
  assert.ok(ids.indexOf(second.id) < ids.indexOf(first.id), "新しい順になっていない");
});

test("一覧には題名と件数だけで、本文は含まない", () => {
  // 一覧を出すのに全文を運ばない。題名は最初の質問から作るので、
  // それ以降の発言が混ざっていないことで確かめる。
  const chat = makeChat(20);
  store.appendTurn(chat.id, { role: "user", content: "はじめの質問", at: at() });
  store.appendTurn(chat.id, { role: "assistant", content: "秘密の回答", at: at() });

  const summary = store.listChats().find((c) => c.id === chat.id);
  assert.equal(summary?.turns, 2);
  assert.equal(summary?.title, "はじめの質問");
  assert.equal(JSON.stringify(summary).includes("秘密の回答"), false, "本文が漏れている");
});

test("壊れた1件があっても一覧は返る", () => {
  // 1つの破損で会話全体を失わない（設定の readConfig と同じ方針）。
  const chat = makeChat(30);
  store.appendTurn(chat.id, { role: "user", content: "無事な方", at: at() });
  writeFileSync(join(CHATS, "20260101-000031-bad.json"), "{ これは JSON ではない");

  const list = store.listChats();
  assert.ok(list.some((c) => c.id === chat.id), "無事な方まで消えている");
});

test("壊れた発言だけを捨てて、残りは読める", () => {
  const chat = makeChat(40);
  const path = join(CHATS, `${chat.id}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      ...chat,
      turns: [
        { role: "user", content: "よい発言", at: at() },
        { role: "宇宙人", content: "壊れている", at: at() },
        { role: "assistant", content: "よい返事", at: at() },
      ],
    }),
  );

  const read = store.readChat(chat.id);
  assert.equal(read?.turns.length, 2, "壊れた1件で会話全体を失っている");
});

// --- 上限 ---

test("上限を超えると古いものから消える", () => {
  const limit = 5;
  for (let i = 0; i < 12; i += 1) {
    store.createChat("device", new Date(2026, 1, 1, 0, 0, i));
    store.prune(limit);
  }
  assert.equal(store.listChats(100).length <= limit, true);
});

test("暴走した会話だけ打ち切る", () => {
  // 文脈の長さは messagesOf が絞るので、ここは一覧が遅くならないための
  // 安全弁でしかない。**時間では打ち切らない**（間があいたかどうかは
  // findResumable が見る）。以前は「5分で打ち切り」だったため、
  // 話している最中に会話が別のチャットに切り替わっていた。
  const chat = store.createChat("device", new Date(2026, 2, 1, 0, 0, 0));
  assert.equal(store.reachedLimit(chat), false);

  const turn = { role: "user" as const, content: "x", at: at() };
  const fill = (n: number) => ({ ...chat, turns: Array.from({ length: n }, () => turn) });

  assert.equal(store.reachedLimit(fill(store.MAX_TURNS * 2)), true, "暴走よけが効いていない");
  assert.equal(
    store.reachedLimit(fill(store.MAX_TURNS * 2 - 1)),
    false,
    "上限の手前で打ち切っている",
  );
});

// --- 削除・終了 ---

test("消せる", () => {
  const chat = makeChat(50);
  assert.equal(store.deleteChat(chat.id), true);
  assert.equal(store.readChat(chat.id), null);
  assert.equal(store.deleteChat(chat.id), false, "二度目は false");
});

test("終わった理由を残す", () => {
  // 「窓が短すぎないか」「終了語が誤爆していないか」を後から見返す材料。
  const chat = makeChat(60);
  store.endChat(chat.id, "phrase");
  assert.equal(store.readChat(chat.id)?.endedBy, "phrase");
});

// --- 呼ばれただけのチャット ---

test("一度も話していないチャットは消せる", () => {
  // 呼びかけただけ・物音で起きただけのものが履歴に「（無題）」として
  // 並ぶと、読み返すときに邪魔になる。
  const empty = makeChat(90);
  assert.equal(store.readChat(empty.id)?.turns.length, 0);
  assert.equal(store.deleteChat(empty.id), true);
  assert.equal(store.listChats().some((c) => c.id === empty.id), false);
});

// --- 安全 ---

test("id にパスを紛れ込ませても data の外を触らない", () => {
  // id は URL のパスから来る。
  for (const bad of ["../config", "a/b", "..", "a b", ""]) {
    assert.equal(store.readChat(bad), null, bad);
    assert.equal(store.deleteChat(bad), false, bad);
  }
});

test("保存したファイルは本人しか読めない", () => {
  // 会話の中身が入る。同じ機械の他の利用者には見せない。
  const chat = makeChat(70);
  assert.equal(statSync(join(CHATS, `${chat.id}.json`)).mode & 0o077, 0);
});

test("一時ファイルが残らない", () => {
  const chat = makeChat(80);
  assert.throws(() => readFileSync(join(CHATS, `${chat.id}.json.tmp`), "utf8"));
});

test("AI に渡す形にできる", () => {
  const chat = store.createChat("web");
  store.appendTurn(chat.id, { role: "user", content: "こんにちは", at: at() });
  store.appendTurn(chat.id, { role: "assistant", content: "はい", at: at() });

  const messages = store.messagesOf(store.readChat(chat.id)!);
  assert.deepEqual(messages, [
    { role: "user", content: "こんにちは" },
    { role: "assistant", content: "はい" },
  ]);
});

test("AI に渡すのは直近の往復だけ", () => {
  // 保存は全部のまま、送る分だけを絞る。会話がいくら続いても送る量が
  // 一定になるので、課金が会話の長さで膨らまない。
  const chat = store.createChat("web", new Date(2026, 10, 1, 0, 0, 0));
  for (let i = 1; i <= 6; i += 1) {
    store.appendTurn(chat.id, { role: "user", content: `質問${i}`, at: at() });
    store.appendTurn(chat.id, { role: "assistant", content: `回答${i}`, at: at() });
  }

  assert.deepEqual(store.messagesOf(store.readChat(chat.id)!, 2), [
    { role: "user", content: "質問5" },
    { role: "assistant", content: "回答5" },
    { role: "user", content: "質問6" },
    { role: "assistant", content: "回答6" },
  ]);
});

test("切り詰めても必ず user から始まる", () => {
  // ai/chat.ts の parseBody は先頭が user でないと 400 で弾く。
  // 回答が空だった往復があると発言数の偶奇がずれ、単純に後ろから
  // N 件取ると assistant から始まってしまう。
  const chat = store.createChat("web", new Date(2026, 10, 1, 0, 0, 1));
  const roles = ["user", "assistant", "user", "user", "assistant"] as const;
  roles.forEach((role, i) => {
    store.appendTurn(chat.id, { role, content: `発言${i + 1}`, at: at() });
  });

  assert.deepEqual(
    store.messagesOf(store.readChat(chat.id)!, 2),
    [
      { role: "user", content: "発言3" },
      { role: "user", content: "発言4" },
      { role: "assistant", content: "発言5" },
    ],
    "assistant から始まると 400 になる",
  );
});

test("上限より短い会話はそのまま全部渡す", () => {
  const chat = store.createChat("web", new Date(2026, 10, 1, 0, 0, 2));
  store.appendTurn(chat.id, { role: "user", content: "こんにちは", at: at() });
  store.appendTurn(chat.id, { role: "assistant", content: "はい", at: at() });

  assert.equal(store.messagesOf(store.readChat(chat.id)!, 5).length, 2);
});

// --- 会話の続き ---
//
// ウェイクワードで文脈を捨てていた頃、実際の記録では「今日これから雨降る」の
// 2.7 分後の「東京なんだけど」が別チャットになり、AI に文脈が渡っていなかった。
// ここはその回帰を防ぐ。
//
// 日付を1日ずつずらすのは、保存先を共有する他のテストと干渉させないため。

const GAP = 10 * 60_000;

/** 1日1件、話したチャットを作る。 */
function talked(day: number, origin: "device" | "web") {
  const when = new Date(2026, 11, day, 12, 0, 0);
  const chat = store.createChat(origin, when);
  store.appendTurn(chat.id, {
    role: "user",
    content: "今日これから雨降る",
    at: when.toISOString(),
  });
  return { id: chat.id, spokeAt: when.getTime() };
}

test("少し間があいたくらいなら直前の会話を継ぐ", () => {
  const { id, spokeAt } = talked(1, "device");

  const found = store.findResumable("device", GAP, spokeAt + 3 * 60_000);
  assert.equal(found?.id, id, "3分後なのに別の会話にされている");
  assert.equal(found?.turns.length, 1, "継ぐなら中身も要る");
});

test("間があきすぎたら継がない", () => {
  const { spokeAt } = talked(2, "device");
  assert.equal(store.findResumable("device", GAP, spokeAt + 11 * 60_000), null);
});

test("画面が違えば継がない", () => {
  // ブラウザで話していた会話をデバイスが引き取るのは驚きが大きい。
  const { spokeAt } = talked(3, "web");
  assert.equal(store.findResumable("device", GAP, spokeAt + 60_000), null);
});

test("暴走上限に達した会話は継がない", () => {
  const when = new Date(2026, 11, 4, 12, 0, 0);
  const chat = store.createChat("device", when);
  for (let i = 0; i < store.MAX_TURNS * 2; i += 1) {
    store.appendTurn(chat.id, {
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x",
      at: when.toISOString(),
    });
  }

  assert.equal(store.findResumable("device", GAP, when.getTime() + 60_000), null);
});

test("0 分にすれば毎回新しい会話になる", () => {
  const { spokeAt } = talked(5, "device");
  assert.equal(store.findResumable("device", 0, spokeAt), null);
});
