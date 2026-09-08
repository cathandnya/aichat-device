/**
 * サーバーから届いた読み上げ音声を、届いた順に鳴らす。
 *
 * WebSocket 経路（マイクを開いているとき）で使う。
 *
 * **先読みの仕掛けは要らない。** サーバー側の `speech/queue.ts` が
 * 「合成は並列・送出は直列」を済ませており、届く順＝読み上げる順が
 * 保証されている。こちらは受け取って復号して順に鳴らすだけ。
 */

export class AudioPlayer {
  private context: AudioContext | null = null;
  private playing: AudioBufferSourceNode | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** 「やめる」のたびに増やす。古い世代の音は鳴らさない。 */
  private generation = 0;
  /** 復号済みの効果音。鳴らすたびに取りに行かない。 */
  private readonly chimes: Record<string, Promise<AudioBuffer | null>> = {};

  /**
   * 鳴らしている最中かどうかが変わったときに呼ぶ。
   *
   * **口パクの拠り所。** サーバーの `speaking` では代わりにならない。
   * あちらは「最初の delta が届いた」で立ち、「WAV を送り終えた」で降りるので、
   * **合成の待ち時間ぶん早く始まり、鳴り終わる前に終わる。**
   */
  private readonly onSpeaking: (speaking: boolean) => void;

  /** 積んであって、まだ鳴らし終えていないものの数。0 になったら喋り終わり。 */
  private pending = 0;
  private speaking = false;

  /**
   * いま鳴っている音を、外から止められるようにしておく。
   *
   * `cancel()` で `stop()` を呼んでも `onended` を潰してしまうと
   * `playOne` の待ちがほどけず、**列が二度と動かなくなる**。
   */
  private finish: (() => void) | null = null;

  constructor(onSpeaking: (speaking: boolean) => void = () => {}) {
    this.onSpeaking = onSpeaking;
  }

  /**
   * 音を出せる状態にしておく。**画面を触った瞬間に呼ぶこと。**
   *
   * ブラウザは利用者が触る前に音を鳴らさない。ウェイクワードで
   * 始まる経路では、鳴るのが最初の操作から遠く離れるので、
   * マイクを開くボタンを押した流れの中で済ませておく必要がある。
   */
  async prime(): Promise<void> {
    const context = this.ensureContext();
    if (context.state === "suspended") {
      await context.resume().catch(() => {});
    }
  }

  /** 届いた WAV を積む。前のものが鳴り終わってから鳴る。 */
  enqueue(wav: ArrayBuffer): void {
    const generation = this.generation;
    this.pending += 1;
    this.queue = this.queue
      .then(() => this.playOne(wav, generation))
      .catch((error: unknown) => {
        // 黙って捨てない。握り潰すと「音が出ない」原因を追えなくなる。
        console.error("読み上げに失敗しました:", error);
      })
      .finally(() => {
        this.pending -= 1;
        // **文と文の合間では下ろさない。** 次が積まれている間は
        // 鳴っていなくても喋っている扱いにする（口が一瞬閉じるのを避ける）。
        if (this.pending <= 0) this.setSpeaking(false);
      });
  }

  /**
   * 短い効果音を鳴らす。**読み上げの列には積まない。**
   *
   * ウェイクワードに気づいたことをすぐ返すためのものなので、
   * 前の読み上げが終わるのを待っていては意味がない。
   * 復号したものは取っておく（2回目からは待たずに鳴る）。
   */
  async chime(url: string): Promise<void> {
    const context = this.ensureContext();
    if (context.state === "suspended") await context.resume().catch(() => {});

    // **音が無くても壊れない。** 素材は git に入れていないので、
    // clone しただけの状態では鳴らせない（device/README.md）。
    //
    // **404 とは限らない。** Vite は開発時に SPA のフォールバックで
    // `index.html` を返すので、`response.ok` は true になり
    // `decodeAudioData` のほうが失敗する。どちらの転び方も同じ
    // `catch` で拾って、鳴らさずに進む。
    //
    // 失敗も含めてキャッシュするのが肝心。**失敗した Promise を残すと、
    // 呼ばれるたびに同じ例外を投げ続ける。**
    this.chimes[url] ??= fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`${url} が見つかりません`);
        return response.arrayBuffer();
      })
      .then((bytes) => context.decodeAudioData(bytes))
      .catch(() => null);

    const buffer = await this.chimes[url];
    if (!buffer) return;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
  }

  /** すべてやめる。 */
  cancel(): void {
    this.generation += 1;
    if (this.playing) {
      try {
        this.playing.stop();
      } catch {
        // すでに終わっていることがある。
      }
      this.playing = null;
    }
    // **待ちを自分でほどく。** `onended` を潰して止めると `playOne` の
    // Promise が永久に解決せず、以降 enqueue しても何も鳴らなくなる。
    this.finish?.();
    this.setSpeaking(false);
  }

  async close(): Promise<void> {
    this.cancel();
    await this.context?.close().catch(() => {});
    this.context = null;
  }

  private async playOne(wav: ArrayBuffer, generation: number): Promise<void> {
    if (generation !== this.generation) return;

    const context = this.ensureContext();
    if (context.state === "suspended") {
      // 止まっていても先へ進む。ここで諦めると無音になるだけで
      // 原因が分からない。
      await context.resume().catch(() => {});
    }

    const buffer = await context.decodeAudioData(wav);
    if (generation !== this.generation) return;

    await new Promise<void>((resolve) => {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);

      // 二度呼ばれても構わない（resolve は一度しか効かない）。
      const done = (): void => {
        this.playing = null;
        this.finish = null;
        resolve();
      };
      source.onended = done;
      this.finish = done;

      this.playing = source;
      source.start();
      // **ここが本当の「喋り始め」。** 合成の待ちも送出の遅れも済んでいる。
      this.setSpeaking(true);
    });
  }

  private setSpeaking(next: boolean): void {
    if (this.speaking === next) return;
    this.speaking = next;
    this.onSpeaking(next);
  }

  /**
   * 再生用の AudioContext。**録音用とは別にする。**
   * VOICEVOX の出力は 24kHz、録音は 16kHz で、1つの AudioContext は
   * 1つのレートしか持てない。レートを指定しないので decodeAudioData が吸収する。
   */
  private ensureContext(): AudioContext {
    this.context ??= new AudioContext();
    return this.context;
  }
}
