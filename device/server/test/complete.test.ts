/**
 * 話し終わりの判定。
 *
 * **外れ方の向きが大事。** 完了を見落としても少し待つだけだが、
 * 継続を見落とすと話を切ってしまう。迷ったら待つ側に倒れることを
 * ここで確かめる。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { looksComplete } from "../src/ai/complete.ts";

test("感嘆符・疑問符で終わっていれば送る", () => {
  assert.equal(looksComplete("これは何ですか？"), true);
  assert.equal(looksComplete("やった！"), true);
});

test("**句点は根拠にしない**", () => {
  // `ohr` は途中で切れた音声にも句点を付ける。実測で「えっと。」が
  // 返り、言い淀みが完了と判定された。句点を落としてから語尾を見る。
  assert.equal(looksComplete("えっと。"), false);
  assert.equal(looksComplete("冷蔵庫に卵と。"), false);
  // 語尾が言い切りなら、句点があってもなくても完了。
  assert.equal(looksComplete("そうなのだ。"), true);
  assert.equal(looksComplete("そうなのだ"), true);
});

test("依頼の言い切りは「て」でも完了", () => {
  assert.equal(looksComplete("明日の天気を教えて。"), true);
  assert.equal(looksComplete("それはやめて"), true);
  // ただし普通の連用中止は待つ。
  assert.equal(looksComplete("買い物に行って"), false);
});

test("丁寧体・終止形で終わっていれば送る", () => {
  assert.equal(looksComplete("明日は晴れです"), true);
  assert.equal(looksComplete("洗濯物を干します"), true);
  assert.equal(looksComplete("もう終わった"), true);
  assert.equal(looksComplete("それはできない"), true);
});

test("終助詞で終わっていれば送る", () => {
  // 話し言葉はここで終わることが多い。
  assert.equal(looksComplete("これでいいかな"), true);
  assert.equal(looksComplete("そうだよね"), true);
  // 「の」は待つ側に倒した（下のテスト参照）。
});

test("**接続助詞で終わっていたら待つ**", () => {
  // ここが本題。考えながら話すと、この形で間が空く。
  assert.equal(looksComplete("冷蔵庫に卵があるんだけれど"), false);
  assert.equal(looksComplete("明日は雨なので"), false);
  assert.equal(looksComplete("駅まで行きたいから"), false);
});

test("格助詞で終わっていたら待つ", () => {
  assert.equal(looksComplete("東京の天気を"), false);
  assert.equal(looksComplete("スーパーに"), false);
  assert.equal(looksComplete("卵と"), false);
});

test("連用中止（〜して、）で終わっていたら待つ", () => {
  assert.equal(looksComplete("買い物に行って"), false);
  assert.equal(looksComplete("それで、"), false);
});

test("言いよどみで終わっていたら待つ", () => {
  assert.equal(looksComplete("えーっと"), false);
  assert.equal(looksComplete("明日の予定はなんか"), false);
});

test("**「の」は待つ**", () => {
  // 「どうするの」（終助詞）と「今日の夕飯の」（連体修飾）が同じ形。
  // 実測で後者が完了と判定されて切られたので、待つ側に倒した。
  assert.equal(looksComplete("今日の夕飯の。"), false);
  assert.equal(looksComplete("どうするの"), false);
});

test("名詞で終わっていたら待つ", () => {
  // 「明日の天気」で切れているのか「明日の天気を教えて」の途中なのか
  // 分からない。**待つ側に倒す。**
  assert.equal(looksComplete("明日の天気"), false);
  assert.equal(looksComplete("東京タワー"), false);
});

test("空なら待たない", () => {
  // 何も聞き取れていないときに待ち続けても意味がない。
  assert.equal(looksComplete(""), true);
  assert.equal(looksComplete("   "), true);
});

test("未完了が優先される", () => {
  // 「して」は COMPLETE にもあるが、読点が付いていれば続く。
  assert.equal(looksComplete("電気を消して、"), false);
});
