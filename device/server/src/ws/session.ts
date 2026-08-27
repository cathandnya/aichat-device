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
 *   following 追い質問の窓。ウェイクワード無しで続けられる
 *   error     失敗。数秒で idle に戻る
 *
 * ### チャットの終わり方
 *
 * **ウェイクワード＝新しいチャット、それ以外は続き。**利用者から見て
 * 規則が1つで済むよう、「受付の終了」と「文脈の終了」を一致させている。
 *
 *   ウェイクワード       → いまのチャットを閉じ、新規に始める
 *   読み上げが終わる     → 追い質問の窓を開く（既定 8 秒）
 *   窓の間に話しかける   → 同じチャットの続き。窓を開き直す
 *   窓が無言で閉じる     → チャット終了
 *   終了語／上限／エラー → チャット終了
 */

import { handleChat } from "../ai/chat.ts";
import { transcribe } from "../ai/stt.ts";
import {
  WAKE_HOP_SEC,
  WAKE_WINDOW_SEC,
  detectWake,
  matchesWake,
} from "../ai/wake.ts";
import {
  appendTurn,
  createChat,
  deleteChat,
  endChat,
  findResumable,
  messagesOf,
  reachedLimit,
  readChat,
} from "../chats/store.ts";
import { Endpointer, NoiseFloor } from "../audio/endpoint.ts";
import {
  FRAME_MS,
  MAX_UTTERANCE_SEC,
  wavDurationMs,
  SAMPLE_RATE,
  encodeWav,
  rms,
} from "../audio/format.ts";
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

/**
 * 追い質問のときに遡る長さ。
 *
 * ウェイクワードを含める必要がないので短くてよい。語頭が切れない
 * ぎりぎりを狙う。長くすると前の発話の尻尾まで質問に混ざる。
 */
const FOLLOW_UP_PREROLL_SEC = 0.4;

/** エラー表示から待機に戻るまで。 */
const ERROR_RESET_MS = 6_000;

/**
 * 鳴り終わりを待つ上限。
 *
 * 長さの読み違いで永遠に待つことがないようにする。20秒（`MAX_UTTERANCE_SEC`）
 * 話しても回答の読み上げがこれを超えることはまずない。
 */
const MAX_SPEAKING_WAIT_MS = 60_000;

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

  /** いま開いているチャット。無ければ待機中。 */
  private chatId: string | null = null;
  /** 追い質問の窓を閉じるための時計。鳴り終わりを待つのにも使う。 */
  private followTimer: NodeJS.Timeout | null = null;
  /**
   * 送った音声が鳴り終わる時刻。
   *
   * `sendAudio` は**socket に渡し終わった**時点で返るので、これを
   * 数えていないと窓が鳴っている間に開いてしまう。デバイスは届いた順に
   * 隙間なく鳴らすので、長さを足していけば終わりが分かる。
   */
  private speakingUntil = 0;
  /**
   * このチャットで「呼ばれただけ」の返事を済ませたか。
   *
   * 一度返事をしたあとも silence のたびに返すと、物音で
   * 「はい？」を繰り返す機械になる。1回だけにする。
   */
  private acknowledged = false;

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

      case "following":
        // 窓が開いている間は**ウェイクワードを判定しない。**
        // 代わりに声がしたかだけを見て、したら同じチャットの続きに入る。
        // ここでウェイクワードも回すと、判定が二重になって遅くなる。
        if (rms(frame) > this.noise.current * 3) this.continueListening();
        else this.noise.update(frame);
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
    if (this.state === "thinking" || this.state === "speaking") return;
    this.startChat();
  }

  /** やめる。開いているチャットも閉じる。 */
  onCancel(): void {
    this.closeChat("manual");
    this.setState("idle", "話しかけてください");
  }

  dispose(): void {
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.closeChat("manual");
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
          this.startChat();
        }
      })
      .finally(() => {
        this.checking = false;
      });
  }

  // --- 聞き取り中 ---

  /**
   * ウェイクワード／ボタン。
   *
   * **文脈は捨てない。** 直前の会話が規定時間内なら、その続きとして扱う。
   * 呼ばれるたびに新しいチャットを作っていた頃は、少し考えて言い直すだけで
   * 前の話が飛んでいた（実際の記録でも、2.7 分後の「東京なんだけど」が
   * 別チャットになって文脈を失っていた）。
   *
   * 規定時間を過ぎていたら新しい会話として始める。
   */
  private startChat(): void {
    this.closeChat("timeout");

    const saved = readConfig();
    const chat =
      findResumable("device", saved.conversationGapMin * 60_000) ??
      createChat("device");

    this.chatId = chat.id;
    // **呼ばれるたびに必ず戻す。会話ごとではない。**
    // これは「物音で起きるたびに『はい？』と言い続けない」ための札で、
    // 一度呼ばれた中で二度目の無言だったときにだけ効く。
    // 継いだ会話だからと立てたままにすると、呼んで黙っていた人に
    // 返事もせず窓も開かないまま待機に戻ってしまう。
    this.acknowledged = false;
    this.io.send({ type: "chat", chatId: chat.id, title: chat.title });

    this.beginListening();
  }

  /** 追い質問。同じチャットのまま聞き取りに入る。 */
  private continueListening(): void {
    this.clearFollowTimer();
    // **遡る量を短くする。** ウェイクワードを含める必要がなく、
    // 長く遡ると前の発話の尻尾まで拾ってしまう
    // （実際に「の天気は駅までの行き方は」という質問文になった）。
    this.beginListening(FOLLOW_UP_PREROLL_SEC);
  }

  /**
   * 聞き取りに入る。`prerollSec` は輪から遡る長さ。
   *
   * **語頭は輪から遡って取る。**デバイスは何も覚えていない。
   * ウェイクワードで始めるときは、その発話ごと拾って書き起こしてから
   * 文字で落とす（切り出しの位置に頼るより確実）。
   */
  private beginListening(prerollSec = WAKE_WINDOW_SEC): void {
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.clearFollowTimer();
    this.abort = new AbortController();
    this.endpointer = new Endpointer(this.noise.current);

    this.utterance = [this.ring.last(prerollSec)];

    this.setState("listening", "聞いています");
  }

  /**
   * 追い質問の窓を開く。無言で閉じたらチャットも終わる。
   *
   * 設定が 0 なら開かない（毎回ウェイクワードが要る）。
   * 窓の間は部屋の話し声を拾って AI に投げてしまうので、
   * 誤爆が気になる家庭が止められるようにしてある。
   */
  private openFollowUp(): void {
    // **鳴り終わってから数え始める。** 送出は socket に渡した時点で
    // 返るので、ここで待たないと読み上げの長さぶん窓が短くなる。
    // 鳴っている間に窓を開いても、自分の声を拾うだけで意味がない。
    const remaining = Math.min(this.speakingUntil - Date.now(), MAX_SPEAKING_WAIT_MS);
    if (remaining > 0) {
      this.clearFollowTimer();
      this.followTimer = setTimeout(() => {
        this.followTimer = null;
        if (this.state !== "speaking") return;
        this.openFollowUp();
      }, remaining);
      return;
    }

    const seconds = readConfig().followUpSec;
    if (seconds <= 0 || !this.chatId) {
      this.closeChat("timeout");
      this.setState("idle", "話しかけてください");
      return;
    }

    this.setState("following", "続けてどうぞ");
    this.clearFollowTimer();
    this.followTimer = setTimeout(() => {
      this.followTimer = null;
      if (this.state !== "following") return;
      this.closeChat("timeout");
      this.setState("idle", "話しかけてください");
    }, seconds * 1000);
  }

  /** 音声を送り、鳴り終わる時刻を進める。読み上げは必ずここを通す。 */
  private async sendAudio(audio: Buffer): Promise<void> {
    const now = Date.now();
    this.speakingUntil =
      Math.max(now, this.speakingUntil) + wavDurationMs(audio);
    await this.io.sendAudio(audio);
  }

  private clearFollowTimer(): void {
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followTimer = null;
  }

  /** 開いているチャットを閉じる。開いていなければ何もしない。 */
  private closeChat(reason: import("../chats/types.ts").ChatEndReason): void {
    this.abort?.abort();
    this.abort = null;
    this.speech?.cancel();
    this.speech = null;
    // やめたぶんは鳴らないので、待つ理由も無くなる。
    this.speakingUntil = 0;
    this.utterance = [];
    this.endpointer = null;
    this.clearFollowTimer();

    if (this.chatId) {
      // **一度も話さずに終わったチャットは残さない。**
      // 呼びかけただけ・物音で起きただけのものが履歴に
      // 「（無題）」として並ぶと、読み返すときに邪魔になる。
      const chat = readChat(this.chatId);
      if (chat && chat.turns.length === 0) deleteChat(this.chatId);
      else endChat(this.chatId, reason);

      this.chatId = null;
    }
  }

  private onListening(frame: Int16Array): void {
    const result = this.endpointer?.push(frame);
    if (!result) return;

    this.endpointer = null;

    if (result.reason === "silence") {
      // 呼ばれただけで質問が続かなかった。**失敗ではない。**
      void this.acknowledge();
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
    let raw = "";
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
      raw = question;
      question = stripWake(question, saved.wakeWords);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "音声を認識できませんでした。");
      return;
    }

    if (controller.signal.aborted) return;

    const saved = readConfig();

    // **終了語。**AI を呼ばずにここで終える。
    if (question && matchesWake(question, saved.endPhrases)) {
      this.closeChat("phrase");
      this.setState("idle", "話しかけてください");
      return;
    }

    // **窓の中でウェイクワードを言われたら仕切り直す。**
    // ここで拾わないと「ずんだもん」だけが質問として送られて空になる。
    if (raw && matchesWake(raw, saved.wakeWords) && !question) {
      this.startChat();
      return;
    }

    if (!question) {
      // ウェイクワードだけが聞こえて、質問が無かった場合もここに来る。
      void this.acknowledge();
      return;
    }

    this.io.send({ type: "question", text: question });
    this.setState("thinking", "考えています");

    await this.generate(question, controller);
  }

  private async generate(question: string, controller: AbortController): Promise<void> {
    if (!this.chatId) return;

    // 暴走よけ。文脈の長さは messagesOf が絞るので、ここに来るのは
    // 会話が異常に長く続いた場合だけ。
    const current = readChat(this.chatId);
    if (current && reachedLimit(current)) {
      endChat(this.chatId, "limit");
      const fresh = createChat("device");
      this.chatId = fresh.id;
      this.io.send({ type: "chat", chatId: fresh.id, title: fresh.title });
    }

    const chatId = this.chatId;
    const asked = appendTurn(chatId, {
      role: "user",
      content: question,
      at: new Date().toISOString(),
    });
    if (asked) {
      this.io.send({ type: "chat", chatId, title: asked.title });
    }
    // **AI に送るのは直近の往復だけ。** 保存は全部のまま。
    const messages = messagesOf(
      asked ?? ({ turns: [] } as never),
      readConfig().contextTurns,
    );

    this.speech = new SpeechQueue(
      (text) => synthesize(text, this.config, controller.signal),
      (audio) => this.sendAudio(audio),
    );

    const splitter = new SentenceSplitter();
    const collectedSources: Source[] = [];
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
            collectedSources.push(...event.sources);
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
      appendTurn(chatId, {
        role: "assistant",
        content: answer,
        at: new Date().toISOString(),
        ...(collectedSources.length ? { sources: collectedSources } : {}),
      });
    }

    await this.speech?.drain();
    if (controller.signal.aborted) return;

    this.speech = null;
    this.abort = null;

    // **読み上げが終わってから窓を開く。**鳴っている間に開くと
    // 自分の声を拾う（エコーキャンセルを持たないため）。
    this.openFollowUp();
  }

  /**
   * 名前を呼ばれただけのときの返事。
   *
   * **AI は呼ばない。**読み上げるだけなので費用はかからない。
   * 返事のあとは追い質問の窓を開けて待つので、続けて質問できる。
   *
   * 2回目以降は黙って閉じる。物音で silence を繰り返すたびに
   * 「はい？」と言い続ける機械になってしまうため。
   */
  private async acknowledge(): Promise<void> {
    const controller = this.abort;

    if (this.acknowledged || !this.chatId) {
      this.closeChat("timeout");
      this.setState("idle", "話しかけてください");
      return;
    }
    this.acknowledged = true;

    const reply = readConfig().wakeReply.trim();
    if (reply) {
      this.setState("speaking", "はい");
      try {
        const wav = await synthesize(
          reply,
          this.config,
          controller?.signal ?? AbortSignal.timeout(20_000),
        );
        if (controller?.signal.aborted) return;
        await this.sendAudio(wav);
      } catch (error) {
        // 鳴らなくても待つ側に進む。返事が出ないだけで
        // 会話ができなくなるほうが困る。
        console.error("[ack] 返事を鳴らせませんでした:", error);
      }
    }

    if (controller?.signal.aborted) return;
    this.openFollowUp();
  }

  // --- 補助 ---

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
    // 失敗したまま続きを聞かれても噛み合わないので、チャットも閉じる。
    this.closeChat("error");

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
