/**
 * 発話の始まりと終わりの判定。
 *
 * 実装は音量（RMS）だけを見る素朴なもの。静かな部屋では十分だが、
 * テレビやエアコンの音があると外れる。差し替えられるよう、
 * 入り口は「80ms の塊を流し込む」形にしてある。
 * （次に入れるなら Silero VAD の onnxruntime-web 版）
 */

import { rms } from "./wav.ts";

/** 80ms（16kHz で 1280 サンプル）ごとに判定する。 */
const FRAME_MS = 80;

/** 話し終わったとみなすまでの無音の長さ。 */
const HANGOVER_MS = 700;

/** 一度も声がしないまま諦めるまでの長さ。 */
const NO_SPEECH_MS = 3_000;

/** 録音を打ち切る長さ。サーバーの上限（約31秒）に余裕を持たせた値。 */
const MAX_MS = 20_000;

/**
 * 声だと判断する前の音を、どれだけ遡って残すか。
 *
 * **これが無いと語頭が切れる。** 「あした」の「あ」で音量が上がった
 * ことに気づく頃には、その「あ」は過ぎている。常にこの長さぶんを
 * 溜めておき、録音の先頭に足す。
 */
const PREROLL_MS = 300;

/** 話し終わりの判定後も少し残す。子音の切れを防ぐ。 */
const TAIL_MS = 200;

/** 部屋の暗騒音を測る時間。しきい値をここから決める。 */
const CALIBRATE_MS = 300;

/** 暗騒音に対して何倍を「声」とみなすか。 */
const NOISE_FACTOR = 3;

/** どんなに静かな部屋でも、これより下は声とみなさない。 */
const FLOOR = 0.01;

export type EndpointResult =
  | { reason: "speech"; samples: Float32Array[] }
  | { reason: "silence" }
  | { reason: "tooLong"; samples: Float32Array[] };

export interface EndpointEvents {
  /** 声を検出した。画面を「聞き取り中」にする。 */
  onSpeechStart?: () => void;
  /** 音量（0〜1）。波形の表示に使う。 */
  onLevel?: (level: number) => void;
}

/**
 * 80ms の塊を順に流し込むと、話し終わりで結果を返す。
 *
 * 状態は3つ。
 *   calibrating — 暗騒音を測っている
 *   waiting     — 声を待っている（プリロールを回している）
 *   speaking    — 録音中
 */
export class Endpointer {
  private state: "calibrating" | "waiting" | "speaking" = "calibrating";
  private elapsedMs = 0;
  private silenceMs = 0;
  private speechMs = 0;

  private noiseSum = 0;
  private noiseCount = 0;
  private threshold = FLOOR;

  /** 声を検出する前の音。常に一定の長さだけ持ち回す。 */
  private preroll: Float32Array[] = [];
  private recorded: Float32Array[] = [];

  // パラメータプロパティ（constructor(private x)）は使わない。
  // Node の型ストリッピングは値を伴う構文を扱えないため。
  private readonly events: EndpointEvents;

  constructor(events: EndpointEvents = {}) {
    this.events = events;
  }

  /** 塊を1つ流し込む。話が終わっていれば結果を返す。 */
  push(frame: Float32Array): EndpointResult | null {
    this.elapsedMs += FRAME_MS;

    const level = rms(frame);
    this.events.onLevel?.(level);

    if (this.state === "calibrating") {
      this.noiseSum += level;
      this.noiseCount += 1;

      if (this.elapsedMs >= CALIBRATE_MS) {
        const noise = this.noiseSum / Math.max(1, this.noiseCount);
        // 固定のしきい値は部屋によって必ず外れる。実測から決める。
        this.threshold = Math.max(noise * NOISE_FACTOR, FLOOR);
        this.state = "waiting";
      }
      this.remember(frame);
      return null;
    }

    if (this.state === "waiting") {
      this.remember(frame);

      if (level > this.threshold) {
        this.state = "speaking";
        this.speechMs = 0;
        this.silenceMs = 0;
        // 溜めておいた分を録音の先頭にする。ここが語頭。
        this.recorded = [...this.preroll];
        this.events.onSpeechStart?.();
        return null;
      }

      if (this.elapsedMs >= NO_SPEECH_MS) return { reason: "silence" };
      return null;
    }

    // speaking
    this.recorded.push(frame);
    this.speechMs += FRAME_MS;

    if (level > this.threshold) {
      this.silenceMs = 0;
    } else {
      this.silenceMs += FRAME_MS;
      if (this.silenceMs >= HANGOVER_MS) {
        return { reason: "speech", samples: this.trimTail() };
      }
    }

    if (this.speechMs >= MAX_MS) {
      return { reason: "tooLong", samples: this.recorded };
    }
    return null;
  }

  /** 溜めておく音を一定の長さに保つ。 */
  private remember(frame: Float32Array): void {
    this.preroll.push(frame);
    while (this.preroll.length * FRAME_MS > PREROLL_MS) this.preroll.shift();
  }

  /**
   * 末尾の無音を落とす。ただし少しは残す。
   *
   * 全部落とすと語尾の子音が切れて「〜です」が「〜で」に聞こえる。
   */
  private trimTail(): Float32Array[] {
    const keep = Math.ceil(TAIL_MS / FRAME_MS);
    const drop = Math.floor(HANGOVER_MS / FRAME_MS) - keep;
    return drop > 0 ? this.recorded.slice(0, -drop) : this.recorded;
  }
}
