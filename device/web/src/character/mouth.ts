/**
 * 口パク。**喋っている間だけ、口の絵をパラパラ切り替える。**
 *
 * 土台（`normal.png`）には口が描かれていないので、**口は常に1枚重なっている。**
 * 黙っているときは 0（閉じ）で、これも「重ねていない」わけではない。
 *
 * ### いつ動かすか
 *
 * **`AudioPlayer` が実際に鳴らしている間だけ**（`main.ts` で繋いである）。
 *
 * 最初はサーバーの状態が `speaking` の間としていたが、**両側にずれた**。
 * あちらは最初の delta で立つので合成の待ち（1 秒以上）ぶん早く動き出し、
 * 「WAV を送り終えた」で降りるのでブラウザがまだ鳴らしている途中で止まる。
 *
 * ### 音量には連動していない
 *
 * 鳴っている間は決まった並びでパラパラ切り替えるだけで、声の大小は見ていない。
 * 気になったら `AudioPlayer` に AnalyserNode を挟んで開き具合を決める形にする。
 * **そのとき変わるのはここを呼ぶ側だけ**で、画像も CSS もそのまま使える。
 */

/**
 * パラパラの並び。0=閉じ 1=半開き 2=大きく開く。
 *
 * **`0` を混ぜているのが肝心。** 開きっぱなしで往復させると、
 * 口が震えているだけに見えて喋っているように見えない。
 * 閉じを挟むと音節の切れ目に見える。
 */
export const MOUTH_PATTERN = [1, 2, 1, 0];

/**
 * 1コマの長さ（ミリ秒）。
 *
 * 日本語は 1 モーラ 100〜120ms 程度で、読み上げは 150% に速めてある。
 * 速すぎると震えて見え、遅すぎると口が置いていかれる。
 */
export const MOUTH_INTERVAL_MS = 120;

/** 黙っているときの口。 */
export const MOUTH_CLOSED = 0;

/**
 * `tick` 番目のコマ。**DOM に触らないのでテストできる。**
 *
 * 負の値でも落ちないようにしてある（`setInterval` の呼び出し回数を
 * 数えるだけなので通常は起きないが、ここで落ちると口が固まる）。
 */
export function mouthFrame(tick: number): number {
  const length = MOUTH_PATTERN.length;
  const index = ((tick % length) + length) % length;
  return MOUTH_PATTERN[index] ?? MOUTH_CLOSED;
}

/**
 * 口を動かす。書き換えるのは `data-mouth` 属性1つだけ。
 *
 * 見せ分けは CSS が持っている（`styles.css` の `.character[data-mouth=...]`）。
 * こちらで要素を作り直すことはしない。
 */
export class Mouth {
  private readonly root: HTMLElement;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    this.set(MOUTH_CLOSED);
  }

  /** 喋り始め。**二重に呼んでも重ならない。** */
  start(): void {
    if (this.timer !== null) return;

    this.tick = 0;
    this.set(mouthFrame(this.tick));
    this.timer = setInterval(() => {
      this.tick += 1;
      this.set(mouthFrame(this.tick));
    }, MOUTH_INTERVAL_MS);
  }

  /**
   * 喋り終わり。**必ず閉じた口に戻す。**
   *
   * 止めた場所のコマのままにすると、口を開けたまま固まる。
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.set(MOUTH_CLOSED);
  }

  private set(frame: number): void {
    this.root.dataset.mouth = String(frame);
  }
}
