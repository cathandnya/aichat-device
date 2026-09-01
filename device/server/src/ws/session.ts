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

import { handleChat, type ServerTools } from "../ai/chat.ts";
import { stubChatResponse } from "../stub/chat.ts";
import {
  cancelTimer,
  getTimer,
  onRing,
  setTimer,
  type Timer,
  type TimerView,
} from "../timers.ts";
import { transcribe } from "../ai/stt.ts";
import { readPower } from "../house/power.ts";
import { readWater } from "../house/water.ts";
import { pressPcPower, readPcPower } from "../house/pc.ts";
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

/**
 * 端末が WAV の長さの何倍かけて鳴らすか。**保険の見積りだけに使う。**
 *
 * 鳴らす仕組みそのものは端末側で継ぎ目なく直したが、合成の速度や
 * 機種で多少はずれる。**見積りが足りないと保険が先に切れて、
 * 端末の合図が捨てられる**（実測でそうなっていた）ので、少し多めに
 * 見ておく。合図が来ればそちらが先に開くので、多い側の害は無い。
 */
const PLAYBACK_SLACK = 1.1;

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
   * 鳴らせないまま待っているタイマー。
   *
   * 会話の最中に時間が来たときに入る。**割り込まずに待つ**——読み上げに
   * 重ねると両方聞き取れない。待機に戻った時点で鳴らす（`setState`）。
   */
  private pendingRing: Timer | null = null;
  /**
   * いまの音量（0〜1）。**端末が教えてくれた値。**
   *
   * サーバーは段数を知らないので割合で持つ。端末のボタンでも変えられる
   * ので、**真実は端末側**。こちらは「もう少し大きく」に答えるための控え。
   * 届く前は分からないので null。
   */
  private volume: number | null = null;
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
    // **タイマーの受け口を持つ。** 繋ぎ直すたびに新しい Session が
    // 登録し直す（`onRing` は 1 台に 1 つで、付け替えられる）。
    // 切断中に鳴ったぶんは、ここで登録した瞬間に流れてくる。
    onRing(this.deviceId, (timer) => void this.ringTimer(timer));
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
        // ★ **読み上げ中でもウェイクワードを判定する＝声で割り込める。**
        //
        // 以前は判定を止めていた。この端末はハードのエコー消去を持たず、
        // 自分の読み上げがそのままマイクに戻って**自分の声で起動し続けた**
        // ため。いまは端末側で帯域ごとに抑えている（`cpp/aec_jni.c`）ので、
        // 自分のウェイクワードを鳴らしても起動しない（実測 3 試行 0 回）。
        //
        // **端末が送ってこない間はここに何も来ない。** 端末は消去が効いて
        // いるとき（`Aec.ready`）だけ読み上げ中も送る。効きが落ちれば
        // 送るのをやめるので、**駄目になれば自動的に元の挙動に戻る**。
        //
        // **輪には入れない。** 入口（`onFrame` の頭）で既に押している。
        // ここで二重に押すと、読み上げ中の自分の声が輪に厚く残り、
        // 直後の追い質問が 0.4 秒遡ってそれを拾う（実機で
        // 「はい、何のようなのだ。」を質問として answer し、
        // **勝手に喋り続けた**）。
        this.tickWake();
        if (this.probe) this.tickProbe();
        break;
    }
  }

  /** 画面を触った / 物理ボタン。ウェイクワード無しで起こす。 */
  onWakeRequest(): void {
    if (this.state === "thinking" || this.state === "speaking") return;
    this.startChat();
  }

  /** 端末が音量を教えてきた。**繋いだ直後と、変えたあとに届く。** */
  onVolume(level: number): void {
    if (!Number.isFinite(level)) return;
    this.volume = Math.min(Math.max(level, 0), 1);
    console.log(`[volume] 端末はいま ${Math.round(this.volume * 100)}%`);
  }

  /** 試験用。**道具を通さずに音量だけ動かす。** */
  setVolumeForTest(level: number): void {
    const safe = Math.min(Math.max(level, 0), 1);
    this.volume = safe;
    this.io.send({ type: "volume", level: safe });
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
        if (!fired) return;
        if (this.state === "idle" || this.state === "error") {
          this.startChat();
          return;
        }
        // ★ **読み上げ中に呼ばれたら、止めて聞き直す。**
        //
        // `startChat` は頭で `closeChat` を呼び、そこで `speech.cancel()`
        // が走るので読み上げは止まる。端末側も `cancel` を受けて鳴って
        // いるぶんを捨てる。
        if (this.state === "speaking") {
          console.log("[wake] 読み上げ中に呼ばれたので止めます");
          // `startChat` が `closeChat` → `speech.cancel()` で合成を止め、
          // 端末は `wake` を受けて鳴っているぶんを捨てて効果音を鳴らす。
          //
          // **遡らない。** 輪には止めたばかりの読み上げと呼びかけが
          // 入っているので、遡ると**それが質問になる**。呼ばれたら
          // 最初からやり直す、が割り込みの意味。
          this.startChat(true);
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
  /**
   * 会話を始める。`fresh` なら**輪から遡らない**。
   *
   * 割り込み（読み上げ中に呼ばれた）で使う。輪には自分の読み上げの尻尾と
   * 呼びかけそのものが入っているので、遡ると**それが質問になる**
   * （実機で、割り込んだ直後に同じ答えを繰り返した）。
   */
  private startChat(fresh = false): void {
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
    // （`fresh`＝割り込みのときは遡らないので聞き直さないが、
    //   立てておいても害はない。次の発話で必ず倒れる）
    this.justWoke = true;
    // **気づいたことを先に返す。** 聞き取りが始まるまで無反応だと、
    // 呼んだ人はもう一度呼んでしまう。
    this.io.send({ type: "wake" });
    this.io.send({ type: "chat", chatId: chat.id, title: chat.title });

    // 割り込みのときは遡らない。**呼びかけの続きだけを聞く。**
    this.beginListening(fresh ? 0 : WAKE_WINDOW_SEC);
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
  /**
   * 試験用に、任意の音声を鳴らす。**AI もチャットも通さない。**
   *
   * 読み上げ中に自分のウェイクワードを鳴らして誤爆するかを試す口。
   * `speaking` にしてから鳴らすので、probe の判定もそのまま働く。
   */
  async speakForTest(wav: Buffer): Promise<void> {
    this.setState("speaking", "試験中");
    this.spoken = false;
    await this.sendAudio(wav);
    this.io.send({ type: "speech-end" });
    // 鳴り終わったら待機に戻す。端末の合図（onSpoken）で戻る。
    this.armSpokenFallback();
  }

  private async sendAudio(audio: Buffer): Promise<void> {
    const now = Date.now();
    this.speakingUntil =
      Math.max(now, this.speakingUntil) + wavDurationMs(audio) * PLAYBACK_SLACK;
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
          : await handleChat(
              { messages },
              controller.signal,
              runtimeFrom(this.config),
              this.tools(),
            );
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
  /**
   * AI に持たせる道具。
   *
   * 端末の会話からしか呼べない（`/api/chat` には渡していない）。
   * 誰が呼んだか分からない HTTP からタイマーを掛けさせない。
   *
   * 家の情報（いまは消費電力）は**設定されているときだけ**渡す。
   * URL が空のまま宣言すると、AI が呼んでは失敗する道具が増え、
   * 「調べます」と言ってから黙る挙動になる。
   */
  private tools(): ServerTools {
    return {
      declarations: [
        {
          name: "set_timer",
          description:
            "タイマーをかける。すでに動いているときはかけずに、動いているタイマーを返す。",
          parameters: {
            type: "object",
            properties: {
              seconds: { type: "number", description: "何秒後に鳴らすか" },
              label: { type: "string", description: "「パスタ」などの名前。無くてよい" },
            },
            required: ["seconds"],
          },
        },
        {
          name: "get_timer",
          description: "いま動いているタイマーの残り時間を調べる。",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "cancel_timer",
          description: "動いているタイマーをやめる。",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "set_volume",
          description:
            "音量を変える。「大きく」「小さく」なら change に増減を、" +
            "「半分に」「最大に」なら level に 0〜1 を渡す。どちらか一方だけ。",
          parameters: {
            type: "object",
            properties: {
              change: {
                type: "number",
                description:
                  "いまからの増減。少し大きくは 0.15、大きくは 0.3、少し小さくは -0.15",
              },
              level: {
                type: "number",
                description: "0〜1 で直接指定。最大は 1、半分は 0.5",
              },
            },
          },
        },
        {
          name: "get_volume",
          description: "いまの音量を調べる。",
          parameters: { type: "object", properties: {} },
        },
        ...(this.config.housePowerUrl
          ? [
              {
                name: "get_house_power",
                description:
                  "この家がいま使っている電気の量（消費電力）をワットで調べる。" +
                  "スマートメーターの実測値。",
                parameters: { type: "object", properties: {} },
              },
            ]
          : []),
        ...(this.config.waterLevelUrl
          ? [
              {
                name: "get_ice_maker_water",
                description:
                  "冷蔵庫の製氷機のタンクに水が入っているかを調べる。" +
                  "有無だけが分かり、残りの量は分からない。",
                parameters: { type: "object", properties: {} },
              },
            ]
          : []),
        ...(this.config.pcPowerUrl
          ? [
              {
                name: "get_pc_power",
                description: "PC の電源が入っているかを調べる。",
                parameters: { type: "object", properties: {} },
              },
              {
                name: "set_pc_power",
                description:
                  "PC の電源を入れる、または切る。" +
                  "切るときは電源ボタンを短く押すだけなので、OS が通常どおり終了する。" +
                  "強制的に電源を落とすことはできない。" +
                  "すでに頼まれた状態なら何もしない。",
                parameters: {
                  type: "object",
                  properties: {
                    want: {
                      type: "string",
                      enum: ["on", "off"],
                      description: "入れるなら on、切るなら off",
                    },
                  },
                  required: ["want"],
                },
              },
            ]
          : []),
      ],
      execute: async (name: string, args: Record<string, unknown>) => {
        switch (name) {
          case "set_timer": {
            const result = setTimer(
              this.deviceId,
              Number(args.seconds),
              typeof args.label === "string" ? args.label : null,
            );
            return result.ok
              ? { ok: true, ...describe(result.timer) }
              : { ok: false, reason: "すでに動いています", ...describe(result.running) };
          }
          case "get_timer": {
            const timer = getTimer(this.deviceId);
            return timer ? { running: true, ...describe(timer) } : { running: false };
          }
          case "cancel_timer": {
            const timer = cancelTimer(this.deviceId);
            return timer ? { cancelled: true, ...describe(timer) } : { cancelled: false };
          }
          case "set_volume": {
            // **端末がまだ教えてくれていないうちは、増減を扱えない。**
            // 基準が無いので「もう少し大きく」が計算できない。
            if (typeof args.change === "number" && this.volume === null) {
              return { ok: false, reason: "いまの音量が分かりません" };
            }
            const next =
              typeof args.level === "number"
                ? args.level
                : (this.volume ?? 0) + Number(args.change ?? 0);
            if (!Number.isFinite(next)) return { ok: false, reason: "値が読めません" };

            const level = Math.min(Math.max(next, 0), 1);
            this.volume = level;
            this.io.send({ type: "volume", level });
            console.log(`[volume] ${Math.round(level * 100)}% にします`);
            return { ok: true, percent: Math.round(level * 100) };
          }
          case "get_volume": {
            return this.volume === null
              ? { known: false }
              : { known: true, percent: Math.round(this.volume * 100) };
          }
          case "get_house_power": {
            const watt = await readPower(this.config.housePowerUrl);
            // **繋がらないことは隠さない。** 古い値を言うより「分かりません」。
            return watt === null
              ? { ok: false, reason: "電力計に繋がりません" }
              : { ok: true, watt };
          }
          case "get_ice_maker_water": {
            const water = await readWater(this.config.waterLevelUrl);
            return water === null
              ? { ok: false, reason: "水位センサーに繋がりません" }
              : { ok: true, water };
          }
          case "get_pc_power": {
            const on = await readPcPower(this.config.pcPowerUrl);
            return on === null
              ? { ok: false, reason: "電源の装置に繋がりません" }
              : { ok: true, on };
          }
          case "set_pc_power": {
            // **知らない値では押さない。** 向きが分からないまま押すと、
            // 点けるつもりで消すことになる。
            if (args.want !== "on" && args.want !== "off") {
              return { ok: false, reason: "入れるのか切るのか分かりません" };
            }
            return await pressPcPower(this.config.pcPowerUrl, args.want);
          }
          default:
            return { error: `知らない道具です: ${name}` };
        }
      },
    };
  }

  /**
   * タイマーが鳴った。**AI は呼ばない。**文はこちらで組み立てる。
   *
   * 鳴らし方は `acknowledge()` と同じ（合成 → 送る → speech-end → 保険）。
   */
  private async ringTimer(timer: Timer): Promise<void> {
    // **会話の最中なら待つ。** 読み上げに割り込むと両方聞き取れない。
    if (this.state !== "idle" && this.state !== "error") {
      this.pendingRing = timer;
      return;
    }
    this.pendingRing = null;

    const what = timer.label ? `${timer.label}の` : "";
    const text = `${what}${spellDuration(timer.durationSec)}が経ったのだ！`;
    console.log(`[timer] 鳴らします: 「${text}」`);

    this.setState("speaking", "タイマー");
    try {
      const wav = await synthesize(text, this.config, AbortSignal.timeout(20_000));
      await this.sendAudio(wav);
    } catch (error) {
      console.error("[timer] 鳴らせませんでした:", error);
    }
    this.io.send({ type: "speech-end" });
    // 鳴り終わったら窓が開く。**そのまま「あと5分」と足せる。**
    this.armSpokenFallback();
  }

  private async acknowledge(): Promise<void> {
    const controller = this.abort;

    if (this.acknowledged || !this.chatId) {
      this.closeChat("timeout");
      this.setState("idle", "話しかけてください");
      return;
    }
    this.acknowledged = true;

    const reply = readConfig().wakeReply.trim();

    // ★ **返事をしないときは、その場で窓を開ける。**
    //
    // 既定は空（効果音だけ。アレクサに合わせた）。このとき `speaking` に
    // 入らないので、`onSpoken` も `armSpokenFallback` も**素通りする**
    // （どちらも `state === "speaking"` を条件にしている）。
    // 素直に書くと**窓が永遠に開かず、音が鳴ったあと何も聞かない**
    // 機械になる。
    if (!reply) {
      if (controller?.signal.aborted) return;
      this.spoken = true;
      this.spokenAt = Date.now();
      this.openFollowUp();
      return;
    }

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

    if (controller?.signal.aborted) return;
    // **ここも「これで最後」を伝える。** SpeechQueue を通らない経路なので、
    // 言い忘れると端末が鳴り終わりを返さない。
    this.io.send({ type: "speech-end" });
    // 窓は端末の合図で開く（`onSpoken`）。ここでは保険だけ張る。
    this.armSpokenFallback();
  }

  // --- 補助 ---

  private setState(state: DeviceState, status: string): void {
    // **待機に戻った瞬間に、待たせていたタイマーを鳴らす。**
    // 会話の最中に時間が来たぶんがここで出る。
    if ((state === "idle" || state === "error") && this.pendingRing) {
      const timer = this.pendingRing;
      this.pendingRing = null;
      // いまの遷移を終わらせてから鳴らす（状態が二重に動かないように）。
      setTimeout(() => void this.ringTimer(timer), 0);
    }
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

  // ★ **続けて呼ばれたぶんは全部落とす。**
  //
  // 元は 1 個だけ落としていた。読み上げ中に割り込むときは強めに
  // 「ずんだもんずんだもん」と重ねて呼ぶので、**残った方が質問として
  // AI に渡っていた**（実機で、割り込んだあと同じ答えを繰り返した）。
  //
  // 落とすのは頭に続く範囲だけ。文の後ろに出てくる同じ語（「それって
  // ずんだもんの話？」）は残す。
  for (let round = 0; round < patterns.length + 4; round += 1) {
    let hit = false;
    for (const pattern of patterns) {
      const at = result.indexOf(pattern);
      if (at >= 0 && at < 8) {
        result = result.slice(at + pattern.length);
        result = result.replace(/^[\s、。！？!?・]+/, "");
        hit = true;
        break;
      }
    }
    if (!hit) break;
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

/** 道具の返り値に入れる形。**AI が言葉にしやすいように秒と分の両方を渡す。** */
function describe(timer: TimerView): Record<string, unknown> {
  return {
    label: timer.label,
    durationSec: timer.durationSec,
    remainingSec: timer.remainingSec,
    remaining: spellDuration(timer.remainingSec),
  };
}

/**
 * 秒を「3分」「1分30秒」の形にする。
 *
 * **読み上げる文に使う。** 「180秒が経ったのだ」では通じない。
 */
function spellDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`;
  const min = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (min >= 60) {
    const hour = Math.floor(min / 60);
    const restMin = min % 60;
    return restMin ? `${hour}時間${restMin}分` : `${hour}時間`;
  }
  return rest ? `${min}分${rest}秒` : `${min}分`;
}
