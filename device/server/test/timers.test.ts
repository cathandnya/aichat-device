/**
 * タイマー。**1台1本という約束が守られるか**を主に見る。
 *
 * **実時間を待たない。** 鳴らすのは `fire()` で起こす。
 *
 * 時計を待つと遅いうえ、`setTimer` が `unref` しているので
 * **他に生きたハンドルが無いとランナーが先に終わる**（テストが
 * cancelled になる）。時計そのものは `remainingSec` の計算で
 * `now` を渡して確かめられるので、待つ必要がない。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cancelTimer,
  fire,
  getTimer,
  onRing,
  resetAll,
  setTimer,
  type Timer,
} from "../src/timers.ts";

/** 鳴ったものを受け取る箱。 */
function catcher(deviceId: string): { got: Timer[] } {
  const got: Timer[] = [];
  onRing(deviceId, (t) => got.push(t));
  return { got };
}

test("時間が来たら鳴る", () => {
  resetAll();
  const box = catcher("dev-1");
  setTimer("dev-1", 60);
  assert.equal(fire("dev-1"), true);
  assert.equal(box.got.length, 1);
  assert.equal(box.got[0]?.deviceId, "dev-1");
});

test("**動いている間は新しくかけない**", () => {
  resetAll();
  const first = setTimer("dev-2", 60);
  assert.equal(first.ok, true);

  // ここが仕様の肝。上書きも追加もせず、動いているものを返す。
  const second = setTimer("dev-2", 120);
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.running.durationSec, 60);
    assert.ok(second.running.remainingSec > 0);
  }
  // 1本目は生きたまま。
  assert.equal(getTimer("dev-2")?.durationSec, 60);
});

test("端末ごとに別々に持てる", () => {
  resetAll();
  assert.equal(setTimer("dev-a", 60).ok, true);
  // 別の端末なら「動いている」に当たらない。
  assert.equal(setTimer("dev-b", 60).ok, true);
});

test("やめれば鳴らない", () => {
  resetAll();
  const box = catcher("dev-3");
  setTimer("dev-3", 60);
  assert.ok(cancelTimer("dev-3"));
  assert.equal(getTimer("dev-3"), null);
  // やめたあとは起こすものが無い。
  assert.equal(fire("dev-3"), false);
  assert.equal(box.got.length, 0);
});

test("動いていなければやめられない", () => {
  resetAll();
  assert.equal(cancelTimer("dev-4"), null);
});

test("やめたあとはまたかけられる", () => {
  resetAll();
  setTimer("dev-5", 60);
  cancelTimer("dev-5");
  assert.equal(setTimer("dev-5", 30).ok, true);
});

test("鳴ったあとはまたかけられる", () => {
  resetAll();
  catcher("dev-6");
  setTimer("dev-6", 60);
  fire("dev-6");
  // 鳴り終わったら手放している。
  assert.equal(getTimer("dev-6"), null);
  assert.equal(setTimer("dev-6", 60).ok, true);
});

test("残り時間が減る", async () => {
  resetAll();
  const at = Date.now();
  setTimer("dev-7", 10, null, at);
  assert.equal(getTimer("dev-7", at)?.remainingSec, 10);
  assert.equal(getTimer("dev-7", at + 4000)?.remainingSec, 6);
  // 過ぎていても負にはしない。
  assert.equal(getTimer("dev-7", at + 99_000)?.remainingSec, 0);
});

test("ラベルを覚える", () => {
  resetAll();
  const r = setTimer("dev-8", 60, "パスタ");
  assert.equal(r.ok && r.timer.label, "パスタ");
  // 空白だけはラベル無し扱い。
  resetAll();
  const blank = setTimer("dev-8", 60, "   ");
  assert.equal(blank.ok && blank.timer.label, null);
});

test("**壊れた長さでも落ちない**", () => {
  // AI が渡してくる値なので、何が来てもおかしくない。
  resetAll();
  const nan = setTimer("dev-9", Number.NaN);
  assert.equal(nan.ok && nan.timer.durationSec, 1);

  resetAll();
  const minus = setTimer("dev-9", -5);
  assert.equal(minus.ok && minus.timer.durationSec, 1);

  resetAll();
  const huge = setTimer("dev-9", 999_999_999);
  assert.equal(huge.ok && huge.timer.durationSec, 24 * 60 * 60);

  resetAll();
  const fraction = setTimer("dev-9", 90.6);
  assert.equal(fraction.ok && fraction.timer.durationSec, 91);
});

test("**切断中に鳴っても捨てない**", () => {
  // 受け口が居ないまま時間が来ることがある（端末の再起動、WiFi の瞬断）。
  // 捨てると「かけたのに何も言われない」になる。
  resetAll();
  setTimer("dev-10", 60);
  fire("dev-10"); // 受け口が無いまま鳴った

  // 繋ぎ直して初めて受け口が付く。溜まっていたぶんがここで流れる。
  const box = catcher("dev-10");
  assert.equal(box.got.length, 1);
  assert.equal(box.got[0]?.deviceId, "dev-10");
});

test("受け口は付け替えられる", () => {
  resetAll();
  let old = false;
  onRing("dev-11", () => {
    old = true;
  });
  // 繋ぎ直すと新しい Session が登録し直す。古いほうには行かない。
  const box = catcher("dev-11");
  setTimer("dev-11", 60);
  fire("dev-11");
  assert.equal(old, false);
  assert.equal(box.got.length, 1);
});
