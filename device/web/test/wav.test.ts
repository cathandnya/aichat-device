/**
 * WAV の組み立てと音量計算の検証。
 *
 *     node --test test/*.test.ts
 *
 * ここが狂うと、上流には「速回しの音」や「割れた音」が届き、
 * 認識精度だけが静かに落ちて原因を追いにくい。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_AUDIO_BYTES,
  MAX_SECONDS,
  SAMPLE_RATE,
  concat,
  encodeWav,
  rms,
} from "../src/audio/wav.ts";

function header(buffer: ArrayBuffer): DataView {
  return new DataView(buffer);
}

function ascii(view: DataView, offset: number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(view.getUint8(offset + i));
  return text;
}

test("RIFF/WAVE のヘッダが正しい", () => {
  const view = header(encodeWav(new Float32Array(100)));

  assert.equal(ascii(view, 0, 4), "RIFF");
  assert.equal(ascii(view, 8, 4), "WAVE");
  assert.equal(ascii(view, 12, 4), "fmt ");
  assert.equal(ascii(view, 36, 4), "data");
});

test("16kHz mono 16bit として書かれる", () => {
  const view = header(encodeWav(new Float32Array(100)));

  assert.equal(view.getUint16(20, true), 1, "リニア PCM");
  assert.equal(view.getUint16(22, true), 1, "モノラル");
  assert.equal(view.getUint32(24, true), 16_000, "サンプリング周波数");
  assert.equal(view.getUint32(28, true), 32_000, "バイト毎秒");
  assert.equal(view.getUint16(32, true), 2, "ブロックの大きさ");
  assert.equal(view.getUint16(34, true), 16, "量子化ビット数");
});

test("長さの欄が実際のバイト数と合う", () => {
  const samples = new Float32Array(1_234);
  const buffer = encodeWav(samples);
  const view = header(buffer);

  assert.equal(buffer.byteLength, 44 + 1_234 * 2);
  assert.equal(view.getUint32(4, true), buffer.byteLength - 8);
  assert.equal(view.getUint32(40, true), 1_234 * 2);
});

test("実際のサンプリング周波数を正直に書く", () => {
  // AudioContext が 16000 を無視した場合（Firefox など）に
  // 16000 と偽って書くと、上流には速回しの音に聞こえる。
  const view = header(encodeWav(new Float32Array(10), 48_000));

  assert.equal(view.getUint32(24, true), 48_000);
  assert.equal(view.getUint32(28, true), 96_000);
});

test("振幅が 16bit の範囲に収まる", () => {
  const samples = new Float32Array([0, 1, -1, 0.5, -0.5]);
  const view = header(encodeWav(samples));

  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 32_767);
  assert.equal(view.getInt16(48, true), -32_768);
  assert.equal(view.getInt16(50, true), 16_383);
  assert.equal(view.getInt16(52, true), -16_384);
});

test("範囲外の値は丸められ、回り込まない", () => {
  // クリップを省くと、大きな声のときに値が回り込んで
  // 正の音が負になる（耳障りなノイズになり認識も落ちる）。
  const view = header(encodeWav(new Float32Array([3.5, -3.5])));

  assert.equal(view.getInt16(44, true), 32_767);
  assert.equal(view.getInt16(46, true), -32_768);
});

test("上限は 30 秒前後", () => {
  // 録音の打ち切り時間（20 秒）を決める根拠。
  assert.ok(MAX_SECONDS > 25, `${MAX_SECONDS}`);
  assert.ok(MAX_SECONDS < 35, `${MAX_SECONDS}`);

  // 20 秒ぶんは確実に上限に収まること。
  assert.ok(encodeWav(new Float32Array(SAMPLE_RATE * 20)).byteLength < MAX_AUDIO_BYTES);
});

test("塊を順番どおりに繋ぐ", () => {
  const merged = concat([
    new Float32Array([1, 2]),
    new Float32Array([]),
    new Float32Array([3, 4, 5]),
  ]);

  assert.deepEqual(Array.from(merged), [1, 2, 3, 4, 5]);
});

test("音量は無音で 0、振り切りで 1", () => {
  assert.equal(rms(new Float32Array(0)), 0);
  assert.equal(rms(new Float32Array([0, 0, 0])), 0);
  assert.equal(rms(new Float32Array([1, -1, 1, -1])), 1);
  assert.ok(Math.abs(rms(new Float32Array([0.5, -0.5])) - 0.5) < 1e-6);
});
