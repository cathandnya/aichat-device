/**
 * 発話の始まりと終わりの判定の検証。
 *
 * 実機のマイクは要らない。80ms の塊を手で流し込めば動く。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Endpointer } from "../src/audio/endpoint.ts";
import { MAX_AUDIO_BYTES, concat, encodeWav } from "../src/audio/wav.ts";

const FRAME = 1280; // 16kHz で 80ms

const quiet = (): Float32Array => new Float32Array(FRAME);
const loud = (): Float32Array => new Float32Array(FRAME).fill(0.5);

/** 結果が出るまで流し込む。出なければ null。 */
function feed(
  endpointer: Endpointer,
  make: () => Float32Array,
  frames: number,
): ReturnType<Endpointer["push"]> {
  for (let i = 0; i < frames; i += 1) {
    const result = endpointer.push(make());
    if (result) return result;
  }
  return null;
}

test("プリロールがあるので語頭が切れない", () => {
  // 「あした」の「あ」で音量が上がったと気づく頃には、その「あ」は
  // 過ぎている。手前を溜めておかないと語頭が落ちる。
  const endpointer = new Endpointer();

  feed(endpointer, quiet, 10); // 暗騒音の測定と待機
  feed(endpointer, loud, 10); // 発話

  const result = feed(endpointer, quiet, 12); // 黙る（700ms で確定）

  assert.equal(result?.reason, "speech");
  const samples = (result as { samples: Float32Array[] }).samples;
  assert.ok(samples.length > 10, `${samples.length} フレームしか無い（手前が残っていない）`);
});

test("声を検出したら知らせる", () => {
  let started = 0;
  const endpointer = new Endpointer({ onSpeechStart: () => (started += 1) });

  feed(endpointer, quiet, 10);
  assert.equal(started, 0, "無音で始まってしまった");

  feed(endpointer, loud, 3);
  assert.equal(started, 1);
});

test("一度も声がしなければ silence で終わる", () => {
  const result = feed(new Endpointer(), quiet, 60);

  assert.equal(result?.reason, "silence");
});

test("話し続けても 20 秒で打ち切る", () => {
  const endpointer = new Endpointer();
  feed(endpointer, quiet, 10);

  const result = feed(endpointer, loud, 400);

  assert.equal(result?.reason, "tooLong");

  // 打ち切った分が Worker の上限に収まること。
  const samples = (result as { samples: Float32Array[] }).samples;
  assert.ok(encodeWav(concat(samples)).byteLength < MAX_AUDIO_BYTES);
});

test("うるさい部屋ではしきい値が上がる", () => {
  // しきい値を固定値にすると、暗騒音のある部屋では
  // 話していないのに「話し始めた」と判断してしまう。
  const noise = (): Float32Array => new Float32Array(FRAME).fill(0.08);

  const endpointer = new Endpointer();
  feed(endpointer, noise, 10); // この音量を暗騒音として学習する

  let started = false;
  const quietRoom = new Endpointer({ onSpeechStart: () => (started = true) });
  feed(quietRoom, quiet, 10);
  feed(quietRoom, noise, 3);
  assert.equal(started, true, "静かな部屋ではこの音量は声とみなす");

  // 同じ音量でも、暗騒音として学習済みなら声とみなさない。
  let startedNoisy = false;
  const noisyRoom = new Endpointer({ onSpeechStart: () => (startedNoisy = true) });
  feed(noisyRoom, noise, 10);
  feed(noisyRoom, noise, 3);
  assert.equal(startedNoisy, false, "暗騒音を声とみなしてしまっている");
});
