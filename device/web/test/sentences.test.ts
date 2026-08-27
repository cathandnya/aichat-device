/**
 * 文の切り出しの検証。
 *
 * 読み上げを先読みするための仕掛けなので、切れなさすぎると
 * 「話しかけてから声が返るまでが遅い」に直結する。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { SentenceSplitter } from "../src/speech/sentences.ts";

/** 本物の SSE のように、数文字ずつ流し込む。 */
function feed(splitter: SentenceSplitter, text: string, size = 3): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(...splitter.push(text.slice(i, i + size)));
  }
  return out;
}

test("句点で切れる", () => {
  const splitter = new SentenceSplitter();
  const done = feed(splitter, "明日は晴れる見込みです。洗濯物も干せます。");

  assert.deepEqual(done, ["明日は晴れる見込みです。", "洗濯物も干せます。"]);
  assert.deepEqual(splitter.flush(), []);
});

test("チャンクの切れ目が文の途中に来ても壊れない", () => {
  // 本物の delta は文字数がそろわない。1文字ずつでも同じ結果になること。
  const a = feed(new SentenceSplitter(), "明日は晴れる見込みです。洗濯物も干せます。", 1);
  const b = feed(new SentenceSplitter(), "明日は晴れる見込みです。洗濯物も干せます。", 7);

  assert.deepEqual(a, b);
});

test("感嘆符・疑問符・改行でも切れる", () => {
  const splitter = new SentenceSplitter();

  assert.deepEqual(feed(splitter, "それは大変でしたね！"), ["それは大変でしたね！"]);
  assert.deepEqual(feed(splitter, "どちらにしますか？"), ["どちらにしますか？"]);
  assert.deepEqual(feed(splitter, "ひとつめの項目\n"), ["ひとつめの項目"]);
});

test("同じ delta に来た連続する区切りは1文にまとめる", () => {
  // 「！」と「？」が一度に届いたときは、間で切らない。
  const splitter = new SentenceSplitter();

  assert.deepEqual(splitter.push("それは本当ですか！？すぐに調べてみますね。"), [
    "それは本当ですか！？",
    "すぐに調べてみますね。",
  ]);
});

test("区切りが delta をまたいでも、次の文が記号で始まらない", () => {
  // 「！」と「？」の間で delta が切れると、次の文が「？…」で
  // 始まってしまう。読み上げに意味の無い記号なので落とす。
  const splitter = new SentenceSplitter();
  const done = [
    ...splitter.push("それは本当ですか！"),
    ...splitter.push("？すぐに調べてみますね。"),
  ];

  for (const sentence of done) {
    assert.ok(!"！？!?。".includes(sentence[0] as string), sentence);
  }
});

test("短すぎる断片は次とまとめる", () => {
  // 「はい。」だけを VOICEVOX に投げると細切れで間延びする。
  const splitter = new SentenceSplitter();
  const done = feed(splitter, "はい。承知しました、すぐにお調べします。");

  assert.equal(done.length, 1);
  assert.ok((done[0] as string).startsWith("はい。"));
});

test("長い文でも途中で切らない", () => {
  // 60字で切っていたときは「〜丼ものにするか、」のように読点で切れ、
  // 読み上げが文の途中で途切れて不自然だった。
  const splitter = new SentenceSplitter();
  const answer =
    "冷蔵庫に卵と玉ねぎ、それに豚肉があるなら、親子丼のような丼ものにするか、" +
    "あるいは野菜と一緒に炒めて生姜焼き風にするのが手早くて美味しいと思いますよ。";

  const done = feed(splitter, answer);

  assert.equal(done.length, 1, "文の途中で切れている");
  for (const sentence of done) {
    assert.match(sentence, /[。！？!?]$/, `文末で終わっていない: ${sentence}`);
  }
});

test("読点では切らない", () => {
  const splitter = new SentenceSplitter();
  const done = feed(splitter, "あ".repeat(80) + "、" + "い".repeat(80) + "。");

  assert.equal(done.length, 1);
  assert.ok((done[0] as string).endsWith("。"));
});

test("区切りが来なくても長くなれば切る", () => {
  // 句点を打たない回答や箇条書きでも読み上げが始まること。
  const splitter = new SentenceSplitter();
  // 句点を打たない回答が来ても、いつかは読み上げが始まること。
  // ただし非常口なので、通常の長さでは働かない。
  const done = feed(splitter, "あ".repeat(600));

  assert.ok(done.length > 0, "一度も切れていない");
  for (const sentence of done) {
    assert.ok(sentence.length <= 200, `長すぎる: ${sentence.length}`);
  }
});

test("非常口で切るときは読点を選ぶ", () => {
  // 句点がまったく無いまま伸び切った場合の話。
  // 語の途中でぶつ切りにするよりは読点のほうがまし。
  const splitter = new SentenceSplitter();
  const text = "あ".repeat(150) + "、" + "い".repeat(150);
  const done = feed(splitter, text);

  assert.ok((done[0] as string).endsWith("、"), done[0]);
});

test("flush で残りが出る", () => {
  const splitter = new SentenceSplitter();

  assert.deepEqual(feed(splitter, "句点で終わらない回答"), []);
  assert.deepEqual(splitter.flush(), ["句点で終わらない回答"]);
  assert.deepEqual(splitter.flush(), [], "2回目は空");
});

test("reset で持ち越さない", () => {
  const splitter = new SentenceSplitter();
  feed(splitter, "途中まで書いた");
  splitter.reset();

  assert.deepEqual(splitter.flush(), []);
});

test("空白だけの断片は出さない", () => {
  const splitter = new SentenceSplitter();

  assert.deepEqual(feed(splitter, "\n\n\n"), []);
  assert.deepEqual(splitter.flush(), []);
});
