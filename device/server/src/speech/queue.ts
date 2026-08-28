/**
 * 読み上げを順番に流す。**合成と送出を分ける。**
 *
 * 文が届いた時点で合成を始め、送出だけを順番に行う。こうすると
 * いま鳴っている文の裏で次の文が用意されるので、文と文の間が空かない。
 *
 * 直列（合成 → 送出 → 合成 → 送出）にしていたときは、文が変わるたびに
 * 合成の待ち時間ぶん黙っていた。実測で 3 文の回答（音声 9.2 秒）に対して
 * **無音が 3.4 秒**入り、「たまに途切れる」と受け取られた。
 */

import type { Emotion } from "./emotion.ts";

export class SpeechQueue {
  /** 合成中または合成済みのもの。順番はここで保つ。 */
  private queue: Promise<{ audio: Buffer; emotion?: Emotion } | null>[] = [];
  private running = false;
  private generation = 0;

  // パラメータプロパティ（constructor(private x)）は使わない。
  // Node の型ストリッピングは値を伴う構文を扱えないため。
  private readonly synthesize: (text: string) => Promise<Buffer>;
  private readonly send: (audio: Buffer) => Promise<void>;
  private readonly onEmotion: ((emotion: Emotion) => void) | undefined;

  constructor(
    synthesize: (text: string) => Promise<Buffer>,
    send: (audio: Buffer) => Promise<void>,
    onEmotion?: (emotion: Emotion) => void,
  ) {
    this.synthesize = synthesize;
    this.send = send;
    this.onEmotion = onEmotion;
  }

  /**
   * 1文を積む。**この時点で合成が始まる。**
   *
   * 感情は音声と一緒に運ぶ。**先に全部送ると顔だけ先走る**（合成は
   * 並行に走るので、積んだ順と鳴る順は同じでも、積んだ時刻とは違う）。
   */
  enqueue(text: string, emotion?: Emotion): void {
    const generation = this.generation;
    this.queue.push(
      this.synthesize(text)
        .then((audio) => (generation === this.generation ? { audio, emotion } : null))
        .catch((error: unknown) => {
          // 黙って捨てない。握り潰すと「音が出ない」原因を追えなくなる。
          console.error("[tts] 合成に失敗しました:", error);
          return null;
        }),
    );
    if (!this.running) void this.run();
  }

  /**
   * すべてやめる。
   *
   * 世代を進めることで、走っている合成の結果も捨てる。
   * 真偽値にすると戻す場所が無く、一度やめたあと二度と鳴らなくなる。
   */
  cancel(): void {
    this.generation += 1;
    this.queue = [];
  }

  /** 送り終わるまで待つ。 */
  async drain(): Promise<void> {
    while (this.running || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      for (;;) {
        const next = this.queue.shift();
        if (next === undefined) break;

        const item = await next;
        if (item === null) continue; // 合成に失敗した文は飛ばす

        try {
          // **音より先に顔を変える。** 声が出るときには表情が揃っている。
          if (item.emotion) this.onEmotion?.(item.emotion);
          await this.send(item.audio);
        } catch (error) {
          console.error("[tts] 送出に失敗しました:", error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
