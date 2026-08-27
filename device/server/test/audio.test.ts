/**
 * 音声の扱いの検証。デバイスもマイクも要らない。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Endpointer, NoiseFloor } from "../src/audio/endpoint.ts";
import { SAMPLE_RATE, encodeWav, rms } from "../src/audio/format.ts";
import { RingBuffer } from "../src/audio/ring.ts";

const FRAME = 1280; // 80ms
const quiet = (): Int16Array => new Int16Array(FRAME);
const loud = (): Int16Array => new Int16Array(FRAME).fill(0x4000);

// --- WAV ---

test("16kHz mono 16bit として書かれる", () => {
  const wav = encodeWav(new Int16Array(100));

  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1, "リニア PCM");
  assert.equal(wav.readUInt16LE(22), 1, "モノラル");
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt32LE(28), 32_000, "バイト毎秒");
  assert.equal(wav.readUInt16LE(34), 16, "量子化ビット数");
});

test("長さの欄が実際のバイト数と合う", () => {
  const wav = encodeWav(new Int16Array(1234));

  assert.equal(wav.byteLength, 44 + 1234 * 2);
  assert.equal(wav.readUInt32LE(4), wav.byteLength - 8);
  assert.equal(wav.readUInt32LE(40), 1234 * 2);
});

test("波形がそのまま入る", () => {
  const wav = encodeWav(new Int16Array([0, 32767, -32768, 1234]));

  assert.equal(wav.readInt16LE(44), 0);
  assert.equal(wav.readInt16LE(46), 32767);
  assert.equal(wav.readInt16LE(48), -32768);
  assert.equal(wav.readInt16LE(50), 1234);
});

test("音量は無音で 0、振り切りで 1", () => {
  assert.equal(rms(new Int16Array(0)), 0);
  assert.equal(rms(new Int16Array([0, 0])), 0);
  assert.ok(Math.abs(rms(new Int16Array([32767, -32768])) - 1) < 0.01);
});

// --- 輪バッファ（プリロールの代わり） ---

test("溜めた分だけ遡れる", () => {
  const ring = new RingBuffer(1); // 1秒 = 16000 サンプル

  ring.push(new Int16Array([1, 2, 3, 4, 5]));
  assert.deepEqual(Array.from(ring.last(1)), [1, 2, 3, 4, 5]);
});

test("一周しても最新が正しい順で取れる", () => {
  // ここが狂うと、語頭を遡ったときに音が入れ替わる。
  const ring = new RingBuffer(4 / SAMPLE_RATE); // 4 サンプルだけ持つ

  ring.push(new Int16Array([1, 2, 3, 4, 5, 6]));

  assert.equal(ring.length, 4);
  assert.deepEqual(Array.from(ring.last(1)), [3, 4, 5, 6]);
});

test("要求より溜まっていなければ、あるだけ返す", () => {
  const ring = new RingBuffer(1);
  ring.push(new Int16Array([1, 2, 3]));

  assert.deepEqual(Array.from(ring.last(1)), [1, 2, 3]);
});

test("何度も書き込んでも壊れない", () => {
  const ring = new RingBuffer(0.5);
  for (let i = 0; i < 50; i += 1) ring.push(loud());

  const last = ring.last(0.5);
  assert.equal(last.length, Math.ceil(0.5 * SAMPLE_RATE));
  assert.ok(last.every((v) => v === 0x4000));
});

// --- 発話の終わり ---

test("無音が続けば話し終わりとみなす", () => {
  const ep = new Endpointer(0.001);

  for (let i = 0; i < 5; i += 1) assert.equal(ep.push(loud()), null);

  let result = null;
  for (let i = 0; i < 12 && !result; i += 1) result = ep.push(quiet());
  assert.equal(result?.reason, "speech");
});

test("一度も声がしなければ諦める", () => {
  const ep = new Endpointer(0.001);

  let result = null;
  for (let i = 0; i < 60 && !result; i += 1) result = ep.push(quiet());
  assert.equal(result?.reason, "silence");
});

test("話し続けても 20 秒で打ち切る", () => {
  const ep = new Endpointer(0.001);

  let result = null;
  for (let i = 0; i < 400 && !result; i += 1) result = ep.push(loud());
  assert.equal(result?.reason, "tooLong");
});

test("うるさい部屋ではしきい値が上がる", () => {
  // 固定のしきい値だと、暗騒音のある部屋で話していないのに反応する。
  const noisy = (): Int16Array => new Int16Array(FRAME).fill(0x0a00);

  const quietRoom = new Endpointer(0.001);
  let fired = null;
  for (let i = 0; i < 20 && !fired; i += 1) fired = quietRoom.push(noisy());
  // 静かな部屋ならこの音量は「声」なので、無音待ちに入らない
  assert.equal(fired, null);

  const noisyRoom = new Endpointer(rms(noisy()));
  let result = null;
  for (let i = 0; i < 60 && !result; i += 1) result = noisyRoom.push(noisy());
  assert.equal(result?.reason, "silence", "暗騒音を声とみなしてしまっている");
});

test("暗騒音の推定は実測に寄っていく", () => {
  const floor = new NoiseFloor();
  const before = floor.current;

  const hum = new Int16Array(FRAME).fill(0x0800);
  for (let i = 0; i < 200; i += 1) floor.update(hum);

  assert.ok(floor.current > before, "上がっていない");
  assert.ok(floor.current <= rms(hum), "実際の音量を超えている");
});
