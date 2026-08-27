/**
 * デバイス1台ぶんの会話。
 *
 * ブラウザ版では `web/src/main.ts` が持っていた状態機械を、
 * そのままサーバーへ移したもの。**デバイスは判断をしない。**
 *
 *   idle      待機。ウェイクワードを待ちながら暗騒音を測る
 *   listening 聞き取り中
 *   thinking  考え中（音声認識 → 最初の delta まで）
 *   speaking  回答中。文ができた端から読み上げを送る
 *   error     失敗。数秒で idle に戻る
 */

import { handleChat } from "../ai/chat.ts";
import { transcribe } from "../ai/stt.ts";
import { WAKE_HOP_SEC, WAKE_WINDOW_SEC, detectWake } from "../ai/wake.ts";
import { Endpointer, NoiseFloor } from "../audio/endpoint.ts";
import { FRAME_MS, MAX_UTTERANCE_SEC, SAMPLE_RATE, encodeWav } from "../audio/format.ts";
import { RingBuffer } from "../audio/ring.ts";
import { runtimeFrom, type Config } from "../config.ts";
import { SentenceSplitter } from "../speech/sentences.ts";
import { SpeechQueue } from "../speech/queue.ts";
import { synthesize } from "../speech/tts.ts";
import { SSELineParser } from "../sse.ts";
import { readConfig } from "../store.ts";
import type { DeviceState, ServerMessage, Source } from "./protocol.ts";

/** 輪に溜めておく長さ。判定の窓より長ければよい。 */
const RING_SEC = 8;

/** 会話の持ち越し。家族共用なので短く。 */
const HISTORY_TURNS = 6;
const HISTORY_TTL_MS = 5 * 60_000;

/** エラー表示から待機に戻るまで。 */
const ERROR_RESET_MS = 6_000;

export interface SessionIO {
  send(message: ServerMessage): void;
  sendAudio(audio: Buffer): Promise<void>;
}

export class Session {
  private state: DeviceState = "idle";
  private readonly ring = new RingBuffer(RING_SEC);
  private readonly noise = new NoiseFloor();

  /** ウェイクワードの判定を最後に走らせてからの経過。 */
  private sinceWakeCheckMs = 0;
  /** 判定が走っている間は重ねて走らせない。 */
  private checking = false;

  /** 聞き取り中に溜める塊。 */
  private utterance: Int16Array[] = [];
  private endpointer: Endpointer | null = null;

  private speech: SpeechQueue | null = null;
  private abort: AbortController | null = null;
  private errorTimer: NodeJS.Timeout | null = null;

  private history: { role: string; content: string }[] = [];
  private historyAt = 0;

  private readonly config: Config;
  private readonly io: SessionIO;

  constructor(config: Config, io: SessionIO) {
    this.config = config;
    this.io = io;
    this.setState("idle", "話しかけてください");
    this.sendConfig();
  }

  /** デバイスから 80ms の塊が届くたびに呼ぶ。 */
  onFrame(frame: Int16Array): void {
    this.ring.push(frame);

    switch (this.state) {
      case "idle":
      case "error":
        // 待っている間ずっと暗騒音を測る。聞き取りに入ってから
        // 測り直す必要がなくなる。
        this.noise.update(frame);
        this.tickWake();
        break;

      case "listening":
        this.utterance.push(frame);
        this.onListening(frame);
        break;

      case "thinking":
      case "speaking":
        // **読み上げ中はウェイクワードを判定しない。**
        // 常時マイクが開いているので、判定を続けると自分の声で
        // 起動し続ける（エコーキャンセルを持たないため）。
        break;
    }
  }

  /** 画面を触った / 物理ボタン。ウェイクワード無しで起こす。 */
  onWakeRequest(): void {
    if (this.state === "idle" || this.state === "error") this.beginListening();
  }

  /** やめる。 */
  onCancel(): void {
    this.abort?.abort();
    this.abort = null;
    this.speech?.cancel();
    this.speech = null;
    this.utterance = [];
    this.endpointer = null;
    this.setState("idle", "話しかけてください");
  }

  dispose(): void {
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.onCancel();
  }

  // --- 待機中 ---

  private tickWake(): void {
    this.sinceWakeCheckMs += FRAME_MS;
    if (this.checking || this.sinceWakeCheckMs < WAKE_HOP_SEC * 1000) return;
    if (this.ring.length < WAKE_WINDOW_SEC * SAMPLE_RATE * 0.5) return;

    this.sinceWakeCheckMs = 0;
    this.checking = true;

    const window = this.ring.last(WAKE_WINDOW_SEC);
    const saved = readConfig();

    void detectWake(
      window,
      saved.wakeWords,
      saved.sttModel,
      runtimeFrom(this.config),
      transcribe,
    )
      .then(({ fired }) => {
        // 判定の間に状態が変わっていることがある。
        if (fired && (this.state === "idle" || this.state === "error")) {
          this.beginListening();
        }
      })
      .finally(() => {
        this.checking = false;
      });
  }

  // --- 聞き取り中 ---

  private beginListening(): void {
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.abort = new AbortController();
    this.endpointer = new Endpointer(this.noise.current);

    // **語頭は輪から遡って取る。**デバイスは何も覚えていない。
    // ウェイクワードの発話そのものも含まれるが、書き起こしてから
    // 落とすほうが、切り出しの精度に頼るより確実。
    this.utterance = [this.ring.last(WAKE_WINDOW_SEC)];

    this.setState("listening", "聞いています");
  }

  private onListening(frame: Int16Array): void {
    const result = this.endpointer?.push(frame);
    if (!result) return;

    this.endpointer = null;

    if (result.reason === "silence") {
      this.fail("聞き取れませんでした。もう一度どうぞ。");
      return;
    }
    void this.answer();
  }

  // --- 聞き取り → 回答 ---

  private async answer(): Promise<void> {
    const controller = this.abort;
    if (!controller) return;

    const pcm = concat(this.utterance);
    this.utterance = [];

    this.setState("thinking", "聞き取っています");

    let question: string;
    try {
      const saved = readConfig();
      const wav = encodeWav(pcm.subarray(0, MAX_UTTERANCE_SEC * SAMPLE_RATE));
      question = (
        await transcribe(
          wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer,
          saved.sttModel,
          runtimeFrom(this.config),
          controller.signal,
        )
      ).trim();
      question = stripWake(question, saved.wakeWords);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "音声を認識できませんでした。");
      return;
    }

    if (controller.signal.aborted) return;
    if (!question) {
      this.fail("聞き取れませんでした。もう一度どうぞ。");
      return;
    }

    this.io.send({ type: "question", text: question });
    this.setState("thinking", "考えています");

    await this.generate(question, controller);
  }

  private async generate(question: string, controller: AbortController): Promise<void> {
    const messages = [...this.validHistory(), { role: "user", content: question }];

    this.speech = new SpeechQueue(
      (text) => synthesize(text, this.config, controller.signal),
      (audio) => this.io.sendAudio(audio),
    );

    const splitter = new SentenceSplitter();
    let answer = "";
    let failed = false;

    let response: Response;
    try {
      response = await handleChat({ messages }, controller.signal, runtimeFrom(this.config));
    } catch (error) {
      if (!controller.signal.aborted) {
        this.fail(error instanceof Error ? error.message : "AI の呼び出しに失敗しました。");
      }
      return;
    }

    if (!response.ok || !response.body) {
      this.fail(await errorMessage(response));
      return;
    }

    const reader = response.body.getReader();
    const parser = new SSELineParser();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (controller.signal.aborted) return;

        for (const payload of parser.push(value)) {
          const event = parse(payload);
          if (!event) continue;

          if (event.message) {
            failed = true;
            this.fail(event.message);
            return;
          }
          if (event.text) {
            if (!answer) this.setState("speaking", "回答中");
            answer += event.text;
            this.io.send({ type: "answer", text: answer });
            for (const sentence of splitter.push(event.text)) {
              this.speech?.enqueue(sentence);
            }
          }
          if (event.sources?.length) {
            this.io.send({ type: "sources", sources: event.sources });
          }
          if (event.stopReason === "empty" && !answer) {
            failed = true;
            this.fail("答えが返りませんでした。もう一度お試しください。");
            return;
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      failed = true;
      this.fail(error instanceof Error ? error.message : "通信が途切れました。");
      return;
    } finally {
      await reader.cancel().catch(() => {});
    }

    if (controller.signal.aborted || failed) return;

    for (const sentence of splitter.flush()) this.speech?.enqueue(sentence);

    if (answer) {
      this.history = [
        ...this.validHistory(),
        { role: "user", content: question },
        { role: "assistant", content: answer },
      ].slice(-HISTORY_TURNS);
      this.historyAt = Date.now();
    }

    await this.speech?.drain();
    if (controller.signal.aborted) return;

    this.speech = null;
    this.abort = null;
    this.setState("idle", "話しかけてください");
  }

  // --- 補助 ---

  /**
   * 持ち越してよい会話だけ返す。
   *
   * 家族で共用するので、前の人の話が次の人に引き継がれないよう
   * 短い時間で捨てる。
   */
  private validHistory(): { role: string; content: string }[] {
    if (Date.now() - this.historyAt > HISTORY_TTL_MS) this.history = [];
    return this.history;
  }

  private setState(state: DeviceState, status: string): void {
    this.state = state;
    this.io.send({ type: "state", state, status });
  }

  private sendConfig(): void {
    const saved = readConfig();
    this.io.send({
      type: "config",
      provider: saved.provider,
      model: saved.provider === "gemini" ? saved.geminiModel : saved.claudeModel,
      wakeWords: [...saved.wakeWords],
    });
  }

  private fail(message: string): void {
    this.speech?.cancel();
    this.speech = null;
    this.abort = null;
    this.utterance = [];
    this.endpointer = null;

    this.setState("error", "うまくいきませんでした");
    this.io.send({ type: "error", message });

    // 放っておいても待機に戻る。家族が「壊れた」と思わないように。
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => {
      if (this.state === "error") this.setState("idle", "話しかけてください");
    }, ERROR_RESET_MS);
  }
}

function concat(chunks: Int16Array[]): Int16Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * 書き起こしの先頭からウェイクワードを落とす。
 *
 * 語頭を輪から遡って取るので、ウェイクワードの発話自体が混ざる。
 * 「ずんだもん、明日の天気は」→「明日の天気は」にする。
 * 切り出しの位置で削るより、文字で削るほうが確実。
 */
export function stripWake(text: string, patterns: readonly string[]): string {
  let result = text.trim();
  for (const pattern of patterns) {
    const at = result.indexOf(pattern);
    if (at >= 0 && at < 8) {
      result = result.slice(at + pattern.length);
      break;
    }
  }
  return result.replace(/^[\s、。！？!?・]+/, "").trim();
}

function parse(payload: string): {
  text?: string;
  sources?: Source[];
  stopReason?: string;
  message?: string;
} | null {
  try {
    return JSON.parse(payload) as never;
  } catch {
    return null; // 知らない形は読み飛ばす
  }
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch {
    // JSON でなければ既定の文言。
  }
  return "AI の呼び出しに失敗しました。";
}
