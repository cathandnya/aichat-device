/**
 * ウェイクワードの判定の検証。
 *
 * 音声認識は呼ばない。**書き起こしを受け取ってからの扱い**だけを見る。
 * 認識そのものの成績は docs/06 に実測を載せてある（検出 10/10・誤起動 0/15）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { matchesWake, normalizeHeard } from "../src/ai/wake.ts";
import { stripWake } from "../src/ws/session.ts";

const WAKE = ["ずんだもん", "すんだもん"];

// --- 正規化 ---

test("語の区切りに入る空白を落とす", () => {
  // SpeechAnalyzer は「ず んだも ん」のように空白を入れてくる。
  assert.equal(normalizeHeard("ず んだも ん。"), "ずんだもん");
});

test("長音を落とす", () => {
  // 「ハローアイチャット」→「ハロアイチャット」と聞こえる。
  assert.equal(normalizeHeard("ハローアイチャット"), normalizeHeard("ハロアイチャット"));
});

test("全角と半角を揃える", () => {
  assert.equal(normalizeHeard("ＡＩチャット"), normalizeHeard("AIチャット"));
});

// --- 一致 ---

test("聞こえ方が揺れても拾う", () => {
  for (const heard of ["ず んだも ん。", "ずんだもん", "す んだも ん。", "ずんだ も ん"]) {
    assert.equal(matchesWake(heard, WAKE), true, heard);
  }
});

test("文の途中にあっても拾う", () => {
  assert.equal(matchesWake("あ、ずんだもん、明日の天気は", WAKE), true);
});

test("日常の語尾では起動しない", () => {
  // 「〜んだもん」は普通の言い回し。ここが誤起動の最大の危険。
  for (const heard of [
    "だって疲れてるんだもん。",
    "行きたくないんだもん。",
    "もう全部済んだもん。",
    "前はそこに住んだもんね。",
    "ずっと待ってるんだもん。",
    "ずんずん進んでいく。",
  ]) {
    assert.equal(matchesWake(heard, WAKE), false, heard);
  }
});

test("空の書き起こしでは起動しない", () => {
  assert.equal(matchesWake("", WAKE), false);
  assert.equal(matchesWake("   ", WAKE), false);
});

test("空のパターンで全部拾ってしまわない", () => {
  // 設定を消したときに、あらゆる音で起動するのは事故。
  assert.equal(matchesWake("こんにちは", [""]), false);
  assert.equal(matchesWake("こんにちは", []), false);
});

// --- ウェイクワードを質問から落とす ---

test("先頭のウェイクワードを落とす", () => {
  // 語頭を輪から遡って取るので、発話そのものが混ざる。
  assert.equal(stripWake("ずんだもん、明日の天気は", WAKE), "明日の天気は");
  assert.equal(stripWake("すんだもん 今何時", WAKE), "今何時");
});

test("ウェイクワードだけなら空になる", () => {
  assert.equal(stripWake("ずんだもん。", WAKE), "");
});

test("文の後ろにある同じ語は落とさない", () => {
  // 「〜が好きなんだ、ずんだもん」のような場合まで削ると本文が消える。
  const text = "きのう食べたのはずんだもん";
  assert.equal(stripWake(text, WAKE), text);
});

test("ウェイクワードが無ければそのまま", () => {
  assert.equal(stripWake("明日の天気は", WAKE), "明日の天気は");
});
