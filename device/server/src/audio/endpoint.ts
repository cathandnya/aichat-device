/**
 * 発話の終わりの検出。
 *
 * ブラウザ版（web/src/audio/endpoint.ts）から移したが、**プリロールは無い**。
 * こちらは RingBuffer が手前を持っているので、語頭を溜め直す必要がない。
 * 残ったのは「いつ話し終わったか」の判定だけ。
 */

import { FRAME_MS, MAX_UTTERANCE_SEC, rms } from "./format.ts";

/**
 * 話し終わったとみなすまでの無音の長さ。
 *
 * **言い淀みより速さを取る。** 以前は 700ms で切り、足りないぶんを
 * 「言い切りの形か」の判定（`ai/complete.ts`）で補って最大 3 秒待って
 * いた。が、この機械は一問一答が主で会話を続けない。**待たされる不利の
 * ほうが大きい**ので判定ごと外し、その代わりここを 1 秒に伸ばした。
 *
 * 副作用として「冷蔵庫に卵と…」で 1 秒黙ると、そのまま送られる。
 * 承知のうえ。
 */
const HANGOVER_MS = 1_000;

/**
 * 一度も声がしないまま諦めるまでの長さ。
 *
 * **短くてよい。諦めた先は失敗ではない。**呼ばれただけだと分かったら
 * 「はい？」と返して追い質問の窓（8秒）を開く。黙ったまま待たせるより、
 * 早く返事をしてから待つほうが話しかけやすい。
 *
 * ウェイクワードは 1 秒ごとに判定しているので、呼び終わってから
 * ここに入るまでに既に間がある。3 秒にしていたときは、呼んで考えて
 * いる人に何の反応も返さない時間が長かった。
 */
const NO_SPEECH_MS = 1_000;

/** 部屋の暗騒音に対して何倍を「声」とみなすか。 */
const NOISE_FACTOR = 3;

/** どんなに静かでも、これより下は声とみなさない。 */
const FLOOR = 0.01;

export type EndpointResult =
  | { reason: "speech" }
  | { reason: "silence" }
  | { reason: "tooLong" };

/**
 * 80ms の塊を流し込むと、話し終わりで結果を返す。
 *
 * しきい値は**呼び出し側が渡す**。ウェイクワードを待っている間に
 * ずっと暗騒音を測れるので、こちらで測り直す必要がない。
 */
export class Endpointer {
  private readonly threshold: number;
  /**
   * 一度も声がしないまま諦めるまでの長さ。
   *
   * **追い質問の窓はここを伸ばして作る。** 呼ばれてから考えている人を
   * 話し始める前に切らないよう、`session.ts` が設定の秒数を渡す。
   */
  private readonly noSpeechMs: number;
  private elapsedMs = 0;
  private silenceMs = 0;
  private speaking = false;

  constructor(noiseFloor: number, noSpeechMs = NO_SPEECH_MS) {
    this.threshold = Math.max(noiseFloor * NOISE_FACTOR, FLOOR);
    this.noSpeechMs = noSpeechMs;
  }

  push(frame: Int16Array): EndpointResult | null {
    this.elapsedMs += FRAME_MS;
    const level = rms(frame);

    if (!this.speaking) {
      if (level > this.threshold) {
        this.speaking = true;
        this.silenceMs = 0;
      } else if (this.elapsedMs >= this.noSpeechMs) {
        return { reason: "silence" };
      }
      return null;
    }

    if (level > this.threshold) {
      this.silenceMs = 0;
    } else {
      this.silenceMs += FRAME_MS;
      if (this.silenceMs >= HANGOVER_MS) return { reason: "speech" };
    }

    if (this.elapsedMs >= MAX_UTTERANCE_SEC * 1000) {
      return { reason: "tooLong" };
    }
    return null;
  }
}

/**
 * 暗騒音の推定。
 *
 * ウェイクワードを待っている間、ずっと更新し続ける。
 * 固定のしきい値は部屋によって必ず外れるので、実測から決める。
 * 静かなときの値に引っ張られるよう、下がるときは速く、上がるときは遅くする。
 */
export class NoiseFloor {
  private value = FLOOR;

  update(frame: Int16Array): void {
    const level = rms(frame);
    const rate = level < this.value ? 0.1 : 0.01;
    this.value += (level - this.value) * rate;
  }

  get current(): number {
    return Math.max(this.value, FLOOR / 2);
  }
}
