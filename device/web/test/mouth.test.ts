/**
 * 口パクのコマ送りの検証。
 *
 *     node --test test/*.test.ts
 *
 * ここが狂うと、口が開けっぱなしになったり閉じっぱなしになったりする。
 * `Mouth` は DOM を触るのでテストしない。**判断は `mouthFrame` に
 * 寄せてあり、残るのは属性の書き換えだけ。**
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MOUTH_CLOSED, MOUTH_PATTERN, mouthFrame } from "../src/character/mouth.ts";

test("並びのとおりに返る", () => {
  for (const [tick, frame] of MOUTH_PATTERN.entries()) {
    assert.equal(mouthFrame(tick), frame);
  }
});

test("末尾まで行くと先頭へ戻る", () => {
  const length = MOUTH_PATTERN.length;
  assert.equal(mouthFrame(length), mouthFrame(0));
  assert.equal(mouthFrame(length * 7 + 2), mouthFrame(2));
});

test("負の tick でも落ちない", () => {
  // setInterval の回数を数えるだけなので通常は起きないが、
  // ここで落ちると口が固まったままになる。
  assert.equal(mouthFrame(-1), MOUTH_PATTERN[MOUTH_PATTERN.length - 1]);
  assert.equal(mouthFrame(-MOUTH_PATTERN.length), mouthFrame(0));
});

test("閉じた口が並びに入っている", () => {
  // 開きっぱなしで往復させると、口が震えているだけに見えて
  // 喋っているように見えない。閉じを挟むのが肝心。
  assert.ok(MOUTH_PATTERN.includes(MOUTH_CLOSED));
});

test("どのコマも用意した絵の範囲に収まる", () => {
  // 0/1/2 以外を返すと、CSS にその行が無いので**口がどれも出ず、
  // 土台に口が描かれていないので口無しになる。**
  for (let tick = 0; tick < 20; tick += 1) {
    assert.ok([0, 1, 2].includes(mouthFrame(tick)), `tick=${tick}`);
  }
});
