/**
 * 直近の音声を保持する輪。
 *
 * **これがあるおかげでプリロールの問題が消える。**
 * ブラウザ版では「声を検出したと気づいた頃には語頭が過ぎている」ため、
 * デバイス側で 300ms のリングバッファを回していた。
 * こちらは常時流れてくる音を溜めているので、ウェイクワードを検出した
 * あとで手前を遡って取ればよい。デバイスは何も覚えなくてよい。
 */

import { SAMPLE_RATE } from "./format.ts";

export class RingBuffer {
  private readonly buffer: Int16Array;
  /** 次に書く位置。 */
  private cursor = 0;
  /** 一周したか。まだなら cursor までが有効。 */
  private wrapped = false;

  constructor(seconds: number, sampleRate = SAMPLE_RATE) {
    this.buffer = new Int16Array(Math.ceil(seconds * sampleRate));
  }

  push(pcm: Int16Array): void {
    for (let i = 0; i < pcm.length; i += 1) {
      this.buffer[this.cursor] = pcm[i] as number;
      this.cursor += 1;
      if (this.cursor >= this.buffer.length) {
        this.cursor = 0;
        this.wrapped = true;
      }
    }
  }

  /** 溜まっている長さ（サンプル数）。 */
  get length(): number {
    return this.wrapped ? this.buffer.length : this.cursor;
  }

  /**
   * 直近 `seconds` 秒を、古い順に並べて返す。
   * 溜まっている分が足りなければ、あるだけ返す。
   */
  last(seconds: number, sampleRate = SAMPLE_RATE): Int16Array {
    const want = Math.min(Math.ceil(seconds * sampleRate), this.length);
    const out = new Int16Array(want);

    // cursor は「次に書く位置」なので、その手前が最新。
    let read = this.cursor - want;
    if (read < 0) read += this.buffer.length;

    for (let i = 0; i < want; i += 1) {
      out[i] = this.buffer[read] as number;
      read += 1;
      if (read >= this.buffer.length) read = 0;
    }
    return out;
  }

  clear(): void {
    this.cursor = 0;
    this.wrapped = false;
  }
}
