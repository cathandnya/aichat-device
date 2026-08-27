/**
 * ウェイクワードの試験（`?mode=wake`）。
 *
 * **判定だけを行い、チャットを作らず AI を呼ばない。**
 *
 * 誤起動を何時間も測るのが目的なので、当たるたびに課金されては使えない。
 * 音声認識は手元（ohr / whisper）なので、この経路の費用はゼロ。
 *
 * 判定そのものは本番と同じ `ai/wake.ts` を通す。別物を書くと
 * 「試験では通ったのに本番で外れる」が起きる。
 *
 * 合成音声で測った成績（検出 10/10・誤起動 0/15）は楽観的な下限で、
 * 実際の発話・生活音の中では悪くなるはず。それを実マイクで測るための道具。
 */

import { transcribe } from "../ai/stt.ts";
import {
  WAKE_HOP_SEC,
  WAKE_WINDOW_SEC,
  detectWake,
} from "../ai/wake.ts";
import { isWakeWords } from "../ai/types.ts";
import { NoiseFloor } from "../audio/endpoint.ts";
import { FRAME_MS, SAMPLE_RATE } from "../audio/format.ts";
import { RingBuffer } from "../audio/ring.ts";
import { runtimeFrom, type Config } from "../config.ts";
import { readConfig } from "../store.ts";
import type { ServerMessage } from "./protocol.ts";

/** 輪に溜めておく長さ。判定の窓より長ければよい。 */
const RING_SEC = 4;

export interface ProbeIO {
  send(message: ServerMessage): void;
}

export class WakeProbe {
  private readonly ring = new RingBuffer(RING_SEC);
  private readonly noise = new NoiseFloor();
  private sinceCheckMs = 0;
  private checking = false;
  private disposed = false;

  /** この接続だけで使う判定語。空なら設定の語を使う。 */
  private words: string[] | null = null;

  private readonly config: Config;
  private readonly io: ProbeIO;

  constructor(config: Config, io: ProbeIO) {
    this.config = config;
    this.io = io;

    const saved = readConfig();
    this.io.send({
      type: "config",
      provider: saved.provider,
      model: saved.provider === "gemini" ? saved.geminiModel : saved.claudeModel,
      wakeWords: [...saved.wakeWords],
    });
    this.io.send({ type: "state", state: "idle", status: "待ち受け中" });
  }

  /**
   * 判定語を差し替える。**設定は書き換えない。**
   *
   * 壊れた値（空・長すぎ・多すぎ）は無視して設定に戻す。
   * 試験の道具とはいえ、黙って何にでも反応する状態は作らない。
   */
  setWords(words: unknown): void {
    this.words = isWakeWords(words) ? words.map((w) => w.trim()) : null;
  }

  onFrame(frame: Int16Array): void {
    if (this.disposed) return;

    this.ring.push(frame);
    this.noise.update(frame);

    this.sinceCheckMs += FRAME_MS;
    if (this.checking || this.sinceCheckMs < WAKE_HOP_SEC * 1000) return;
    // 溜まっていないうちに判定しても意味が無い。
    if (this.ring.length < WAKE_WINDOW_SEC * SAMPLE_RATE * 0.5) return;

    this.sinceCheckMs = 0;
    this.checking = true;

    const saved = readConfig();
    const patterns = this.words ?? saved.wakeWords;
    const startedAt = Date.now();

    void detectWake(
      this.ring.last(WAKE_WINDOW_SEC),
      patterns,
      saved.sttModel,
      runtimeFrom(this.config),
      transcribe,
    )
      .then(({ fired, heard }) => {
        if (this.disposed) return;
        this.io.send({
          type: "heard",
          text: heard,
          fired,
          at: new Date().toISOString(),
          ms: Date.now() - startedAt,
        });
      })
      .finally(() => {
        this.checking = false;
      });
  }

  dispose(): void {
    this.disposed = true;
  }
}
