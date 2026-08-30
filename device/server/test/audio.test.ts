/**
 * 音声の扱いの検証。デバイスもマイクも要らない。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Endpointer, NoiseFloor } from "../src/audio/endpoint.ts";
import { FRAME_MS, SAMPLE_RATE, encodeWav, rms, wavDurationMs,
  splitWav,
} from "../src/audio/format.ts";
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

test("何ミリ秒鳴るか読める", () => {
  // 追い質問の窓をいつ開くかの根拠。読み違えると窓が短くなる。
  assert.equal(wavDurationMs(encodeWav(new Int16Array(SAMPLE_RATE))), 1000);
  assert.equal(wavDurationMs(encodeWav(new Int16Array(SAMPLE_RATE / 2))), 500);

  // VOICEVOX は 24kHz で返す。取り違えると 1.5 倍ずれる。
  assert.equal(wavDurationMs(encodeWav(new Int16Array(24_000), 24_000)), 1000);
});

test("fmt と data の間に別のチャンクが挟まっても読める", () => {
  const wav = encodeWav(new Int16Array(SAMPLE_RATE));
  const list = Buffer.alloc(12);
  list.write("LIST", 0);
  list.writeUInt32LE(4, 4);
  const spliced = Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)]);
  spliced.writeUInt32LE(spliced.length - 8, 4);

  assert.equal(wavDurationMs(spliced), 1000);
});

test("WAV でなければ待たない", () => {
  // 読めないものを待つと、窓が開かないまま固まる。
  assert.equal(wavDurationMs(Buffer.alloc(0)), 0);
  assert.equal(wavDurationMs(Buffer.from("これは音声ではない")), 0);
  assert.equal(wavDurationMs(encodeWav(new Int16Array(SAMPLE_RATE)).subarray(0, 30)), 0);
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

  // **無音 1 秒で確定する。** 80ms 刻みなので 12 フレーム（960ms）では
  // まだ足りず、13 フレーム目（1040ms）で返る。**長さそのものを確かめる**
  // ように書いてある。ここを縮めると言い切る前に切られ、伸ばすと
  // 返事が遅くなる、という体感に直結する値。
  for (let i = 0; i < 12; i += 1) assert.equal(ep.push(quiet()), null);
  assert.equal(ep.push(quiet())?.reason, "speech");
});

test("一度も声がしなければ 1 秒で諦める", () => {
  // 諦めた先は「はい？」と返して 8 秒の窓を開く経路。長さを変えると
  // 「呼んだのに何も返ってこない時間」がそのまま変わる。
  const ep = new Endpointer(0.001);

  let frames = 0;
  let result = null;
  while (frames < 60 && !result) {
    result = ep.push(quiet());
    frames += 1;
  }

  assert.equal(result?.reason, "silence");
  assert.equal(frames, Math.ceil(1_000 / FRAME_MS), "諦めるまでの長さが変わっている");
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

test("長い WAV は刻んで送る", () => {
  // 3 秒ぶん。500ms 刻みなので 6 つになる。
  const pcm = new Int16Array(SAMPLE_RATE * 3);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = (i % 1000) - 500;
  const parts = splitWav(encodeWav(pcm));

  assert.equal(parts.length, 6);
  // **繋ぐと元に戻る。** 切り口で音が飛ばないことの確認。
  const back: number[] = [];
  for (const part of parts) {
    const d = part.subarray(44);
    for (let i = 0; i + 1 < d.length; i += 2) back.push(d.readInt16LE(i));
  }
  assert.equal(back.length, pcm.length);
  assert.deepEqual(back.slice(0, 100), Array.from(pcm.slice(0, 100)));
  // 継ぎ目も合っているか（1つ目の終わりと2つ目の頭）。
  const seam = SAMPLE_RATE / 2;
  assert.equal(back[seam - 1], pcm[seam - 1]);
  assert.equal(back[seam], pcm[seam]);
});

test("短い WAV は刻まない", () => {
  // 1 かたまりに収まるなら、そのまま 1 つで返す。
  const pcm = new Int16Array(SAMPLE_RATE / 4); // 250ms
  const wav = encodeWav(pcm);
  assert.deepEqual(splitWav(wav), [wav]);
});

test("**壊れた WAV はそのまま返す**", () => {
  // 呼ぶ側に分岐を持たせない。読めなければ触らない。
  const junk = Buffer.from("これは WAV ではない");
  assert.deepEqual(splitWav(junk), [junk]);
});

test("刻んだそれぞれが単体で鳴らせる", () => {
  // デバイスの Wav.decode はヘッダを見るので、
  // **かたまりごとにヘッダが要る**。長さも読めること。
  const pcm = new Int16Array(SAMPLE_RATE * 2);
  const parts = splitWav(encodeWav(pcm));
  for (const part of parts) {
    assert.equal(part.toString("ascii", 0, 4), "RIFF");
    assert.ok(wavDurationMs(part) > 0);
  }
  const total = parts.reduce((sum, p) => sum + wavDurationMs(p), 0);
  assert.ok(Math.abs(total - 2000) < 1, `合計 ${total}ms`);
});
