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
import { stubChatResponse } from "../stub/chat.ts";
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
} from "../audio/format.ts";
import { RingBuffer } from "../audio/ring.ts";
import { runtimeFrom, type Config } from "../config.ts";
import {
  EmotionTagStripper,
  guessEmotion,
  type Emotion,
} from "../speech/emotion.ts";
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

/**
 * 端末の合図を待つ余裕。
 *
 * 計算値ちょうどで開くと、端末の再生がわずかに遅れているだけで
 * 保険が先に鳴ってしまう。**合図を待つ側に倒す。**
 */
const SPOKEN_GRACE_MS = 1_500;

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

  /**
   * エコー消去の効きを測るためだけの覗き見。`AICHAT_AEC_PROBE=1`。
   *
   * **読み上げ中に自分の声が文字になるか**を見る。数値（ERLE）が
   * 出ていても書き起こしが通るなら意味がないので、こちらが本当の
   * 合格条件になる。起動はしないので、本番の挙動は変わらない。
   */
  private readonly probe = process.env.AICHAT_AEC_PROBE === "1";
  private sinceProbeMs = 0;
  private probing = false;

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
   * 次に送る音声に載せる表情。
   *
   * **鳴り始めを知っているのは端末だけ。** サーバーの `wavDurationMs` は
   * 計算値で実際の再生とずれるので、時計合わせでは追いつかない。
   * 音と同じ予告に入れて渡し、切り替えは端末に任せる。
   */
  private nextEmotion: Emotion | null = null;
  /**
   * 端末が鳴らし終えたと言ってきたか。
   *
   * **計算値より端末の言い分を優先する。** 立てるのは `onSpoken`、
   * 倒すのは次の読み上げを始めるとき。
   */
  private spoken = false;
  /**
   * 鳴り終わった時刻。**追い質問で遡りすぎないための境。**
   *
   * ここより前には自分の読み上げが入っている。
   */
  private spokenAt = 0;
  /**
   * 起こした直後か。
   *
   * `startChat` はウェイクワードを含む手前まで遡るので、**呼びかけ
   * そのものをもう一度聞き取る**。それで仕切り直すと輪になる。
   */
  private justWoke = false;
  /**
   * このチャットで「呼ばれただけ」の返事を済ませたか。
   *
   * 一度返事をしたあとも silence のたびに返すと、物音で
   * 「はい？」を繰り返す機械になる。1回だけにする。
   */
  private acknowledged = false;

  private readonly config: Config;
  private readonly io: SessionIO;
  /**
   * この接続の端末。**会話を継ぐ相手を決める鍵。**
   *
   * 接続ごとの値なので `Config`（プロセス全体の設定）には入れない。
   * 検証は `ws/index.ts` で済ませてあり、ここに来るのは安全な値だけ。
   */
  private readonly deviceId: string;

  constructor(config: Config, io: SessionIO, deviceId: string) {
    this.config = config;
    this.io = io;
    this.deviceId = deviceId;
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
        // **窓が開いている間は無条件で聞き取りに入る。**
        //
        // 以前は音量で門番をしていたが、この端末は入力が小さく、
        // 暗騒音の推定が下限に張り付く。閾値が固定の 0.015 になり、
        // **わずかな物音（実測 0.019）でも起動した**。
        //
        // 呼ばれたあとは聞く体勢なのだから、迷う必要がない。声が
        // 無ければ下流の `Endpointer` が `silence` で戻すので、門番を
        // 二重に置く意味も無い。読み上げ中のマイクは端末が止めている。
        this.continueListening();
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
        //
        // ただし `AICHAT_AEC_PROBE=1` のときだけ、**判定はせずに
        // 書き起こしだけ**する。エコー消去が効いているかは
        // 「読み上げ中に自分の声が文字になるか」でしか分からないので、
        // その計器。**起動はしない**ので本番の挙動は変わらない。
        //
        // **輪には入れない。** 入口（`onFrame` の頭）で既に押している。
        // ここで二重に押すと、読み上げ中の自分の声が輪に厚く残り、
        // 直後の追い質問が 0.4 秒遡ってそれを拾う（実機で
        // 「はい、何のようなのだ。」を質問として answer し、
        // **勝手に喋り続けた**）。測るのは判定だけでよい。
        if (this.probe) this.tickProbe();
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
      .then(({ fired, heard }) => {
        // **外れたぶんも出す。** 反応が悪いときに要るのは
        // 「何と聞こえて外したか」のほう——実際、遠くから呼ぶと
        // 「ずんだもん」が「17」に化けていた。無音は出さない。
        if (heard) console.log(`[wake] ${fired ? "★" : "  "} 「${heard}」`);
        // 判定の間に状態が変わっていることがある。
        if (fired && (this.state === "idle" || this.state === "error")) {
          this.startChat();
        }
      })
      // **握り潰さない。** ここが無いと `startChat` の例外が
      // どこにも出ないまま消える（実機の切り分けで実際に詰まった）。
      .catch((e) => {
        console.error("[wake] 判定のあとで落ちました:", e);
      })
      .finally(() => {
        this.checking = false;
      });
  }

  /**
   * 読み上げ中の書き起こし。**測るだけで、何もしない。**
   *
   * 出る文字がそのままエコー消去の成績になる。
   *
   *   何も出ない        理想。声として成立していない
   *   「んー」など      良い。消え残りはあるが言葉になっていない
   *   「ずんだもんなのだ」最悪。ゲートを開けたら自己起動する
   */
  private tickProbe(): void {
    this.sinceProbeMs += FRAME_MS;
    if (this.probing || this.sinceProbeMs < WAKE_HOP_SEC * 1000) return;
    if (this.ring.length < WAKE_WINDOW_SEC * SAMPLE_RATE * 0.5) return;

    this.sinceProbeMs = 0;
    this.probing = true;

    const window = this.ring.last(WAKE_WINDOW_SEC);
    const saved = readConfig();

    void detectWake(
      window,
      saved.wakeWords,
      saved.sttModel,
      runtimeFrom(this.config),
      transcribe,
    )
      .then(({ fired, heard }) => {
        if (heard) {
          console.log(`[probe] 読み上げ中に聞こえた: ${fired ? "★起動語" : "     "} 「${heard}」`);
        }
      })
      .catch((e) => {
        console.error("[probe] 落ちました:", e);
      })
      .finally(() => {
        this.probing = false;
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
      findResumable(this.deviceId, saved.conversationGapMin * 60_000) ??
      createChat("device", this.deviceId);

    this.chatId = chat.id;
    // **呼ばれるたびに必ず戻す。会話ごとではない。**
    // これは「物音で起きるたびに『はい？』と言い続けない」ための札で、
    // 一度呼ばれた中で二度目の無言だったときにだけ効く。
    // 継いだ会話だからと立てたままにすると、呼んで黙っていた人に
    // 返事もせず窓も開かないまま待機に戻ってしまう。
    this.acknowledged = false;
    // 起こした直後の 1 回は、同じ発話を聞き直すことになる。
    this.justWoke = true;
    // **気づいたことを先に返す。** 聞き取りが始まるまで無反応だと、
    // 呼んだ人はもう一度呼んでしまう。
    this.io.send({ type: "wake" });
    this.io.send({ type: "chat", chatId: chat.id, title: chat.title });

    this.beginListening();
  }

  /** 追い質問。同じチャットのまま聞き取りに入る。 */
  private continueListening(): void {
    this.clearFollowTimer();
    // **窓のぶんだけ待つ。**
    //
    // 音量の門番をやめて即ここへ来るようにしたので、`Endpointer` の
    // 既定（1 秒）で諦めると**窓が実質 1 秒になる**。呼ばれてから
    // 考えている人を、話し始める前に切ってしまった。
    //
    // 遡る量は短いまま。ウェイクワードを含める必要がなく、長く遡ると
    // 前の発話の尻尾まで拾う（実際に「の天気は駅までの行き方は」と
    // いう質問文になった）。
    //
    // ★ **鳴り終わりより前へは遡らない。**
    //
    // 端末は鳴り終わってから 350ms（`TAIL_MS`）マイクを伏せるが、
    // 0.4 秒遡るとその**手前まで届いてしまう**。そこには自分の読み上げの
    // 尻尾が入っており、それを質問として聞き取って答え、その答えの尻尾を
    // また拾う——という輪になる（実機で「うん。」を質問として answer し、
    // **勝手に喋り続けた**）。
    const sinceSpoken = (Date.now() - this.spokenAt) / 1000;
    const preroll = Math.max(0, Math.min(FOLLOW_UP_PREROLL_SEC, sinceSpoken));

    const seconds = readConfig().followUpSec;
    this.beginListening(preroll, Math.max(seconds, 1) * 1000);
  }

  /**
   * 聞き取りに入る。`prerollSec` は輪から遡る長さ。
   *
   * **語頭は輪から遡って取る。**デバイスは何も覚えていない。
   * ウェイクワードで始めるときは、その発話ごと拾って書き起こしてから
   * 文字で落とす（切り出しの位置に頼るより確実）。
   */
  private beginListening(prerollSec = WAKE_WINDOW_SEC, noSpeechMs?: number): void {
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.clearFollowTimer();
    this.abort = new AbortController();
    this.endpointer = new Endpointer(this.noise.current, noSpeechMs);

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
    //
    // **終わりの合図は端末が出す**（`spoken`）。WAV の長さから計算すると
    // 実際の再生とずれる。ここでの待ちは、その合図が来なかったときの
    // 保険（切断・取りこぼし）でしかない。
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

  /**
   * この文の感情を決める。**タグがあればそれ、無ければ辞書。**
   *
   * 1 文ごとに出しておく。**タグが付いたのか辞書に落ちたのかを
   * 区別できないと、プロンプトが効いているか測れない**（docs/08）。
   */
  private pickEmotion(tagged: Emotion | null, sentence: string): Emotion {
    const emotion = tagged ?? guessEmotion(sentence);
    const from = tagged ? "タグ" : "辞書";
    console.log(`[emotion] ${emotion}（${from}） ${sentence.slice(0, 24)}`);
    return emotion;
  }

  /**
   * 端末が鳴らし終えた。**追い質問の窓はここから数え始める。**
   *
   * 読み上げ中でなければ捨てる（前の会話の取りこぼしが後から届いても、
   * いまの状態を壊さない）。
   */
  onSpoken(): void {
    // **読み上げ中でなければ捨てる。** 前の回の取りこぼしが遅れて届く
    // ことがあり、いまの状態を壊してはいけない。
    if (this.state !== "speaking") return;
    this.spoken = true;
    this.spokenAt = Date.now();
    this.clearFollowTimer();
    this.openFollowUp();
  }

  /**
   * 端末の「鳴り終わり」が来なかったときの保険。
   *
   * 計算した鳴り終わりに余裕を足した時刻で、こちらから窓を開ける。
   * **合図が来ればそちらが先に開く**ので、ここは通らないのが正常。
   */
  private armSpokenFallback(): void {
    const wait = Math.min(
      Math.max(this.speakingUntil - Date.now(), 0) + SPOKEN_GRACE_MS,
      MAX_SPEAKING_WAIT_MS,
    );
    this.clearFollowTimer();
    this.followTimer = setTimeout(() => {
      this.followTimer = null;
      if (this.state !== "speaking") return;
      console.log("[speech] 端末からの鳴り終わりが来ないので、計算値で開きます");
      this.spoken = true;
      this.spokenAt = Date.now();
      this.openFollowUp();
    }, wait);
  }

  /** 次の音声に載せる表情を取り出す。**1 回だけ返る。** */
  takeEmotion(): Emotion | null {
    const value = this.nextEmotion;
    this.nextEmotion = null;
    return value;
  }

  /** 音声を送り、鳴り終わる時刻を進める。読み上げは必ずここを通す。 */
  private async sendAudio(audio: Buffer): Promise<void> {
    const now = Date.now();
    this.speakingUntil =
      Math.max(now, this.speakingUntil) + wavDurationMs(audio);
    // 新しい音を送ったので、前の「鳴り終わった」は無効。
    this.spoken = false;
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

    // **何と聞こえたかを必ず残す。**
    //
    // ウェイクワードを落とす前の `raw` を出す。落とした後だけ見ても
    // 「呼びかけが認識されたのか、何も聞こえなかったのか」が分からない。
    // **AEC の評価もここを見る**（読み上げ中に自分の声が文字になったら、
    // それがそのまま出る）。
    console.log(`[speech] 聞き取り: 「${raw}」`);

    const saved = readConfig();

    // **終了語。**AI を呼ばずにここで終える。
    if (question && matchesWake(question, saved.endPhrases)) {
      this.closeChat("phrase");
      this.setState("idle", "話しかけてください");
      return;
    }

    // **窓の中でウェイクワードを言われたら仕切り直す。**
    // ここで拾わないと「ずんだもん」だけが質問として送られて空になる。
    //
    // **ただし、いま起こしたばかりの発話では仕切り直さない。**
    // `startChat` はウェイクワードを含む手前まで遡って聞き直すので、
    // 呼びかけそのものがここへ来る。素通しにすると
    // 起動 → 聞き直し → また起動 の輪になり、**効果音が 3 回鳴った**。
    if (raw && matchesWake(raw, saved.wakeWords) && !question) {
      if (this.justWoke) {
        this.justWoke = false;
        void this.acknowledge();
        return;
      }
      this.startChat();
      return;
    }
    this.justWoke = false;

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
      const fresh = createChat("device", this.deviceId);
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
      (emotion) => {
        this.nextEmotion = emotion;
      },
    );

    const splitter = new SentenceSplitter();
    const stripper = new EmotionTagStripper();
    /**
     * 直前に採れたタグ。
     *
     * **バッファが空のときに来たタグはいまの文に、そうでなければ次の文に
     * 効かせる**（docs/08）。`SentenceSplitter` が短い断片を次とまとめる
     * ので、「はい。[happy] やったのだ！」が 1 文になり、タグが文の途中に
     * 来ることがあるため。
     */
    let tagged: Emotion | null = null;
    const collectedSources: Source[] = [];
    let answer = "";
    let failed = false;

    let response: Response;
    try {
      // **`stub` をここでも見る。**
      //
      // `stub` の分岐は HTTP のルーティング（app.ts）にしかなく、
      // WebSocket 経路はそこを通らない。**「stub のつもりで課金されて
      // いた」**ことに実機で気づいた。デバイスからの会話はすべてこの
      // 経路なので、いちばん課金が乗るところが素通りしていた。
      response =
        this.config.mode === "stub"
          ? stubChatResponse()
          : await handleChat({ messages }, controller.signal, runtimeFrom(this.config));
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
            // **タグを先に剥がす。** ここを通さないと画面にも読み上げにも
            // `[happy]` が出る。
            //
            // **順序どおりに処理する。** 1 つの delta に複数のタグが入る
            // ことがあり（Gemini は改行込みでまとめて送ってくる）、
            // 最後のタグだけを見ると **1 文目に最後の感情が付く**。
            for (const part of stripper.pushParts(event.text)) {
              if (typeof part !== "string") {
                tagged = part.emotion;
                continue;
              }
              if (!answer) this.setState("speaking", "回答中");
              answer += part;
              this.io.send({ type: "answer", text: answer });
              for (const sentence of splitter.push(part)) {
                this.speech?.enqueue(sentence, this.pickEmotion(tagged, sentence));
                tagged = null;
              }
            }
            for (const word of stripper.takeUnknown()) {
              // 表に足す材料になる。捨てたことは黙らない。
              console.log(`[emotion] 知らない語を捨てました: ${word}`);
            }
          }
          if (event.sources?.length) {
            // **検索が走ったかは、これでしか分からない。** 端末は音声だけで
            // 引用元を出さないので、ログに残さないと確かめようがない。
            for (const source of event.sources) {
              console.log(`[search] ${source.title ?? source.uri}`);
            }
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

    // **保留分を取りこぼさない。** 途中で打ち切られた（truncated）ときは
    // 閉じないタグが残るので、本文として流す。
    const rest = stripper.flush();
    if (rest) {
      answer += rest;
      this.io.send({ type: "answer", text: answer });
      for (const sentence of splitter.push(rest)) {
        this.speech?.enqueue(sentence, this.pickEmotion(tagged, sentence));
        tagged = null;
      }
    }
    for (const sentence of splitter.flush()) {
      this.speech?.enqueue(sentence, this.pickEmotion(tagged, sentence));
      tagged = null;
    }

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

    // **これで最後だと伝える。** 端末はこれを見てから鳴り終わりを返す。
    this.io.send({ type: "speech-end" });

    this.speech = null;
    this.abort = null;

    // **ここでは窓を開けない。** 開けてしまうと状態が `speaking` から
    // 外れ、そのあとに届く端末の「鳴り終わり」が弾かれる（実際そうなって
    // いて、毎回この下の保険が動いていた）。
    //
    // 窓は `onSpoken` が開く。**送出が終わった時刻と、スピーカーから
    // 音が消える時刻は違う**（送出は socket に渡した時点で返る）。
    // 待つのはそのぶん。合図が来なければ保険が開ける。
    this.armSpokenFallback();
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
    // **ここも「これで最後」を伝える。** SpeechQueue を通らない経路なので、
    // 言い忘れると端末が鳴り終わりを返さない。
    this.io.send({ type: "speech-end" });
    // 窓は端末の合図で開く（`onSpoken`）。ここでは保険だけ張る。
    this.armSpokenFallback();
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
