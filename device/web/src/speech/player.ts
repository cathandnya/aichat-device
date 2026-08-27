/**
 * サーバーから届いた読み上げ音声を、届いた順に鳴らす。
 *
 * WebSocket 経路（マイクを開いているとき）で使う。
 *
 * **先読みの仕掛けは要らない。** サーバー側の `speech/queue.ts` が
 * 「合成は並列・送出は直列」を済ませており、届く順＝読み上げる順が
 * 保証されている。こちらは受け取って復号して順に鳴らすだけ。
 * （`speaker.ts` の `RemoteSpeaker` は自分で /api/tts を叩く経路のもの）
 */

export class AudioPlayer {
  private context: AudioContext | null = null;
  private playing: AudioBufferSourceNode | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** 「やめる」のたびに増やす。古い世代の音は鳴らさない。 */
  private generation = 0;
  /** 復号済みの効果音。鳴らすたびに取りに行かない。 */
  private readonly chimes: Record<string, Promise<AudioBuffer>> = {};

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
    this.queue = this.queue
      .then(() => this.playOne(wav, generation))
      .catch((error: unknown) => {
        // 黙って捨てない。握り潰すと「音が出ない」原因を追えなくなる。
        console.error("読み上げに失敗しました:", error);
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

    this.chimes[url] ??= fetch(url)
      .then((response) => response.arrayBuffer())
      .then((bytes) => context.decodeAudioData(bytes));

    const buffer = await this.chimes[url];
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
  }

  /** すべてやめる。 */
  cancel(): void {
    this.generation += 1;
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
      source.onended = () => {
        this.playing = null;
        resolve();
      };
      this.playing = source;
      source.start();
    });
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
