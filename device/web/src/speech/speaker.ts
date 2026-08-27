/**
 * 読み上げ。
 *
 * 実装を2つ持ち、差し替えられるようにしてある。
 *
 * - `RemoteSpeaker`  /api/tts（VOICEVOX）で作った音をブラウザ内で鳴らす。**本命**
 * - `WebSpeechSpeaker`  ブラウザの speechSynthesis。Mac での手軽な確認用
 *
 * **なぜ speechSynthesis を本命にしないか。**
 *
 * 1. Pi の Chromium には日本語の音声が入っていない。Chromium は自前の
 *    音声を持たず speech-dispatcher 経由で OS の TTS を呼ぶが、
 *    既定の espeak-ng は漢字を読めない。**Mac には Kyoko が入っている
 *    ので、Mac だけで確かめると気づけない。**
 * 2. エコーキャンセルの参照信号に入らない。ブラウザの AEC は「自分が
 *    鳴らした音」を参照にするので、別プロセスが出した音は対象外。
 *    読み上げ中の自分の声をマイクが拾ってループする。
 *    ここで取った WAV を WebAudio で鳴らせば確実に参照に入る。
 */

/**
 * 読み上げる準備ができた1文。
 *
 * 中身は実装ごとに違う（VOICEVOX なら復号済みの波形、
 * ブラウザの読み上げなら文字列のまま）ので、外からは触らない。
 */
export type Prepared = unknown;

export interface Speaker {
  /**
   * 合成だけ行う。**再生はしない。**
   *
   * 再生と分けているのは、**再生中に次の文を合成しておく**ため。
   * 「合成 → 再生 → 合成 → 再生」と直列にすると、文が変わるたびに
   * 合成の待ち時間ぶん黙る（実測で 1 文あたり約 1 秒。音声 9.2 秒に対して
   * 無音が 3.0 秒入っていた）。
   */
  prepare(text: string): Promise<Prepared>;
  /** 合成済みのものを鳴らす。鳴り終わるまで待つ。 */
  play(prepared: Prepared): Promise<void>;
  /** 読み上げ中のものも、待っているものもやめる。 */
  cancel(): void;
  /**
   * 音を出せる状態にしておく。**画面を触った瞬間に呼ぶこと。**
   *
   * ブラウザは、利用者が触る前に音を鳴らすことを許さない。
   * `AudioContext` は作られた時点では止まっていて、
   * 動かすには利用者の操作の流れの中で `resume()` する必要がある。
   *
   * 読み上げが始まるのは、聞き取り（0.3秒）と回答の生成（1秒）が
   * 終わったあと。そこまで来ると最初の操作から離れすぎていて、
   * ブラウザによっては `resume()` が拒否される。
   * だから「話す」を押した瞬間に済ませておく。
   */
  prime?(): Promise<void>;
}

/**
 * VOICEVOX で読み上げる。
 *
 * 録音用とは別の AudioContext を使う。VOICEVOX の出力は 24kHz で、
 * 録音用は 16kHz。1つの AudioContext は1つのレートしか持てない。
 */
export class RemoteSpeaker implements Speaker {
  private context: AudioContext | null = null;
  private playing: AudioBufferSourceNode | null = null;
  /** 走っている合成。先読みするので同時に複数ありうる。 */
  private readonly inFlight = new Set<AbortController>();
  /**
   * 「やめる」を押すたびに増やす。
   *
   * 単なる真偽値にすると、一度やめたあと戻す場所が無く、
   * **以降ずっと鳴らなくなる**。合成した時点の値を持ち回し、
   * 再生時に食い違っていたら捨てる。
   */
  private generation = 0;

  /** 画面を触った流れの中で呼ぶ。ここで音を出せる状態にしておく。 */
  async prime(): Promise<void> {
    const context = this.ensureContext();
    if (context.state === "suspended") {
      await context.resume().catch(() => {
        // ここで拒否されても speak() 側でもう一度試す。
      });
    }
  }

  /** 合成して復号するところまで。再生はしない。 */
  async prepare(text: string): Promise<Prepared> {
    const generation = this.generation;
    const controller = new AbortController();
    this.inFlight.add(controller);

    let wav: ArrayBuffer;
    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`tts ${response.status}`);
      wav = await response.arrayBuffer();
    } finally {
      this.inFlight.delete(controller);
    }

    // 復号にも時間がかかるので、ここまでを再生の前に済ませておく。
    const buffer = await this.ensureContext().decodeAudioData(wav);
    return { generation, buffer };
  }

  /** 合成済みの波形を鳴らす。**呼び出し側が順番を守ること。** */
  async play(prepared: Prepared): Promise<void> {
    const item = prepared as { generation: number; buffer: AudioBuffer };
    // 「やめる」を挟んで作られたものは鳴らさない。
    if (item.generation !== this.generation) return;

    const context = this.ensureContext();
    // 止まっていたら動かす。**ただし失敗しても先へ進む。**
    if (context.state === "suspended") {
      await context.resume().catch(() => {});
    }

    await new Promise<void>((resolve) => {
      const source = context.createBufferSource();
      source.buffer = item.buffer;
      source.connect(context.destination);
      source.onended = () => {
        this.playing = null;
        resolve();
      };
      this.playing = source;
      source.start();
    });
  }

  cancel(): void {
    this.generation += 1;
    // 先読みしている分もすべて止める。残すと、やめたあとに
    // 使われない音声を作り続けることになる。
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();

    if (this.playing) {
      this.playing.onended = null;
      try {
        this.playing.stop();
      } catch {
        // すでに終わっていることがある。
      }
      this.playing = null;
    }
  }

  private ensureContext(): AudioContext {
    // レートを指定しない。VOICEVOX が返す WAV のレートに
    // decodeAudioData が合わせてくれる。
    this.context ??= new AudioContext();
    return this.context;
  }
}

/**
 * ブラウザの読み上げ。Mac での確認用。
 *
 * Pi では日本語の音声が無く、`getVoices()` が空になる。
 * `isUsable()` で使えるかどうかを確かめてから使う。
 */
export class WebSpeechSpeaker implements Speaker {
  private voice: SpeechSynthesisVoice | null = null;

  /** 日本語の音声があるか。無ければこの実装は使えない。 */
  static isUsable(): boolean {
    if (!("speechSynthesis" in globalThis)) return false;
    return speechSynthesis.getVoices().some((v) => v.lang.startsWith("ja"));
  }

  /**
   * ブラウザの読み上げは合成と再生を分けられない。
   * 文字列をそのまま持ち回して、`play` で読み上げる。
   */
  async prepare(text: string): Promise<Prepared> {
    return text;
  }

  play(prepared: Prepared): Promise<void> {
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(prepared as string);
      utterance.lang = "ja-JP";

      this.voice ??=
        speechSynthesis.getVoices().find((v) => v.lang.startsWith("ja")) ?? null;
      if (this.voice) utterance.voice = this.voice;

      // 読み上げに失敗しても画面は先に進める。声が出ないより
      // 固まるほうが困る。
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();

      speechSynthesis.speak(utterance);
    });
  }

  cancel(): void {
    speechSynthesis.cancel();
  }
}

/**
 * 読み上げを順番に流す。
 *
 * 文ができた端から `enqueue` する。前の文を読み終わってから次を読むので、
 * 重なって聞こえることはない。
 */
/**
 * 読み上げを順番に流す。
 *
 * **文が届いた時点で合成を始め、再生は順番に行う。**
 * こうすると、いま鳴っている文の裏で次の文が用意されるので、
 * 文と文の間が空かない。
 *
 * 直列（合成 → 再生 → 合成 → 再生）にしていたときは、
 * 1 文あたり約 1 秒の無音が入っていた（音声 9.2 秒に対して無音 3.0 秒）。
 */
export class SpeechQueue {
  /** 合成中または合成済みのもの。順番はここで保つ。 */
  private queue: Promise<Prepared | null>[] = [];
  private running = false;
  private readonly speaker: Speaker;

  /** 読み上げに失敗したときの通知先。画面に出すために使う。 */
  onError?: (error: unknown) => void;

  constructor(speaker: Speaker) {
    this.speaker = speaker;
  }

  /** 画面を触った瞬間に呼ぶ。自動再生の制限を外しておくため。 */
  async prime(): Promise<void> {
    await this.speaker.prime?.();
  }

  /**
   * 1文を積む。**この時点で合成が始まる。**
   *
   * 失敗しても例外にせず null にする。そうしないと、まだ再生の順番が
   * 来ていない Promise が拒否された時点で「拾われなかった拒否」になる。
   */
  enqueue(text: string): void {
    this.queue.push(
      this.speaker.prepare(text).catch((error: unknown) => {
        // 黙って捨てない。握り潰していたせいで原因を追えなかったことがある。
        console.error("読み上げの合成に失敗しました:", error);
        this.onError?.(error);
        return null;
      }),
    );
    if (!this.running) void this.run();
  }

  /** すべてやめる。「やめて」を押したとき。 */
  cancel(): void {
    this.queue = [];
    this.speaker.cancel();
  }

  /** 読み終わるまで待つ。 */
  async drain(): Promise<void> {
    while (this.running || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      for (;;) {
        const next = this.queue.shift();
        if (next === undefined) break;

        const prepared = await next;
        if (prepared === null) continue; // 合成に失敗した文は飛ばす

        try {
          await this.speaker.play(prepared);
        } catch (error) {
          console.error("読み上げに失敗しました:", error);
          this.onError?.(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
