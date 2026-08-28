/**
 * 感情タグの剥がし器と辞書の検証。
 *
 * **タグを読み上げる事故**と**本文を壊す事故**の両方を防ぐのが目的。
 * docs/08 の「何を課金ゼロで確かめられるか」に挙がっている範囲を
 * ここで固める。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EmotionTagStripper,
  guessEmotion,
} from "../src/speech/emotion.ts";

/** 本物の SSE のように、少しずつ流し込む。 */
function feed(stripper: EmotionTagStripper, text: string, size: number): string {
  let out = "";
  for (let i = 0; i < text.length; i += size) {
    out += stripper.push(text.slice(i, i + size));
  }
  return out + stripper.flush();
}

test("文頭のタグを剥がして感情を採る", () => {
  const s = new EmotionTagStripper();
  const text = feed(s, "[happy] やったのだ！", 100);
  assert.equal(text, " やったのだ！");
  assert.equal(s.take(), "happy");
});

test("**1文字ずつ**流してもタグが漏れない", () => {
  const s = new EmotionTagStripper();
  const text = feed(s, "[sad] ごめんなのだ。", 1);
  assert.equal(text, " ごめんなのだ。");
  assert.equal(s.take(), "sad");
});

test("タグの真ん中で delta が割れても漏れない", () => {
  // `[hap` / `py] ...` に割れる。ここが最悪の事故（タグを読み上げる）。
  const s = new EmotionTagStripper();
  let out = s.push("[hap");
  assert.equal(out, "", "途中では何も出さない");
  out += s.push("py] そうなのだ");
  assert.equal(out, " そうなのだ");
  assert.equal(s.take(), "happy");
});

test("`[1]` のような本文は消さない", () => {
  const s = new EmotionTagStripper();
  const text = feed(s, "[1] のように書くのだ", 3);
  assert.equal(text, "[1] のように書くのだ");
  assert.equal(s.take(), null);
});

test("知らない語は本文に流し、捨てた語を覚えておく", () => {
  const s = new EmotionTagStripper();
  const text = feed(s, "[excited] やったのだ", 4);
  assert.equal(text, "[excited] やったのだ");
  assert.equal(s.take(), null);
  assert.deepEqual(s.takeUnknown(), ["excited"]);
});

test("閉じないタグで永久に黙らない", () => {
  const s = new EmotionTagStripper();
  const text = feed(s, "[happyそうなのだ、とても長い文章が続くのだ", 5);
  assert.ok(text.startsWith("[happy"), `本文に流れる: ${text}`);
  assert.ok(text.includes("そうなのだ"), "続きも流れる");
});

test("終端で保留分を取りこぼさない", () => {
  const s = new EmotionTagStripper();
  const out = s.push("こんにちは[ha");
  assert.equal(out, "こんにちは");
  // 途中で切られた（truncated）ときも、保留を本文に返す。
  assert.equal(s.flush(), "[ha");
});

test("採った感情は1回だけ返る", () => {
  const s = new EmotionTagStripper();
  s.push("[angry] むむ");
  assert.equal(s.take(), "angry");
  assert.equal(s.take(), null, "2回目は消えている");
});

test("タグが無ければ本文はそのまま", () => {
  const s = new EmotionTagStripper();
  const text = feed(s, "ふつうの文なのだ。", 2);
  assert.equal(text, "ふつうの文なのだ。");
  assert.equal(s.take(), null);
});

test("辞書で推定する", () => {
  assert.equal(guessEmotion("やったのだ！"), "happy");
  assert.equal(guessEmotion("ごめんなさい"), "sad");
  assert.equal(guessEmotion("それは駄目なのだ"), "angry");
  assert.equal(guessEmotion("えっ、本当に？"), "surprised");
  assert.equal(guessEmotion("明日は晴れです"), "neutral");
});

test("辞書は先に出た語を採る", () => {
  // 「ごめん」が先にあるので sad。
  assert.equal(guessEmotion("ごめん、でもうれしい"), "sad");
});
