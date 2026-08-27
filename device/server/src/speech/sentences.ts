/**
 * 流れてくる本文を文に切る。DOM に触らないのでテストできる。
 *
 * 回答を全部待ってから読み上げると、話しかけてから声が返るまで
 * 何秒も空く。1文できた時点で読み上げに回すために、
 * SSE の delta を貯めながら「切れたところ」を教える役をする。
 */

/** 文の終わりとみなす文字。 */
const TERMINATORS = new Set(["。", "！", "？", "!", "?", "\n"]);

/**
 * 読み上げに回す最小の長さ。
 *
 * 「はい。」のような短い断片を単独で投げると、VOICEVOX の呼び出しが
 * 細切れになり、間延びして聞こえる。次の文とまとめる。
 */
const MIN_LENGTH = 8;

/**
 * 区切りが来ないまま伸び続けたときに、諦めて切る長さ。
 *
 * **これは非常口であって、通常の分割手段ではない。**
 * 以前は 60 字にしていたが、日本語の 60 字はごく普通の長さで、
 * 「冷蔵庫に卵と玉ねぎ、それに豚肉があるなら、親子丼のような丼ものにするか、」
 * のように**文の途中で切れて不自然に聞こえた**。
 *
 * 文末（。！？改行）でだけ切るのが原則。ここに当たるのは、句点を
 * 打たない回答が来たときだけにする。
 */
const FORCE_LENGTH = 200;

export class SentenceSplitter {
  private buffer = "";

  /**
   * 本文の差分を足し、確定した文を返す。
   *
   * 差分（delta）を受ける前提。正規化した SSE は累積ではなく差分を流す
   * （src/sse.ts）ので、そのまま渡してよい。
   */
  push(delta: string): string[] {
    this.buffer += delta;

    const done: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut === null) break;

      const sentence = clean(this.buffer.slice(0, cut));
      this.buffer = this.buffer.slice(cut);
      if (sentence) done.push(sentence);
    }
    return done;
  }

  /** 残りを吐き出す。生成が終わったときに呼ぶ。 */
  flush(): string[] {
    const rest = clean(this.buffer);
    this.buffer = "";
    return rest ? [rest] : [];
  }

  reset(): void {
    this.buffer = "";
  }

  /** 切る位置（その手前までが1文）。まだ切れないなら null。 */
  private findCut(): number | null {
    for (let i = 0; i < this.buffer.length; i += 1) {
      if (!TERMINATORS.has(this.buffer[i] as string)) continue;

      // 「……」や「!?」のように区切りが続くときは最後まで含める。
      let end = i + 1;
      while (end < this.buffer.length && TERMINATORS.has(this.buffer[end] as string)) {
        end += 1;
      }

      // 短い断片はここでは切らず、次の文とまとめる。
      if (end < MIN_LENGTH) continue;

      return end;
    }

    // 区切りが無いまま伸びすぎたら、読みやすいところで切る。
    if (this.buffer.length >= FORCE_LENGTH) {
      const at = this.buffer.lastIndexOf("、", FORCE_LENGTH);
      return at > MIN_LENGTH ? at + 1 : FORCE_LENGTH;
    }
    return null;
  }
}

/**
 * 読み上げに回す形に整える。
 *
 * 先頭の区切り文字を落とすのは、delta の切れ目が「！」と「？」の間に
 * 来たときに、次の文が「？なるほど……」で始まってしまうため。
 * 読み上げに意味を持たない記号なので落とす。
 */
function clean(text: string): string {
  let start = 0;
  while (start < text.length && TERMINATORS.has(text[start] as string)) start += 1;
  return text.slice(start).trim();
}
