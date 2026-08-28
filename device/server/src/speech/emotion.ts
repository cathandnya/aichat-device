/**
 * 感情。**`[happy]` のようなタグを剥がし、無ければ辞書で推定する。**
 *
 * docs/08 の設計。**タグの有無に本文が依存しない**のが原則で、
 * タグが1つも付かなくても回答は完全に成立する。感情は
 * 「付いていたら使う」上乗せ。
 *
 *     タグが付いている  →  そのタグを使う
 *     タグが無い        →  辞書で推定する
 *     どちらも当たらない →  neutral
 *
 * 辞書だけでも配管（表情・声色）は通るので、**タグの付きが悪くても
 * 投資は無駄にならない**。
 */

/**
 * タグを付けさせる指示。**サーバーが必ず足す。**
 *
 * `/admin` の `systemPrompt`（利用者が書き換える）とは分ける。
 * **書き換えでタグの指示が消えると、原因の分からない不調になる**
 * （docs/08「プロンプトの書き方」）。
 *
 * 効くと分かっている書き方に揃えてある。
 * - 語を**そのまま 5 つ列挙する**（「感情を書け」にしない。自由に作る）
 * - 「各文の**先頭**に必ず 1 つ」「タグ以外の説明をしない」
 * - **例を 2 つ**入れる
 * - 「迷ったら `[neutral]`」— 逃げ道を与えると変な語を作りにくい
 */
export const EMOTION_PROMPT = `各文の先頭に、その文の感情を示すタグを必ず1つ付けてください。
使えるタグは次の5つだけです。ほかの語を作らないでください。

[neutral] [happy] [sad] [angry] [surprised]

- タグは文の先頭にだけ置き、文の途中には入れないでください
- タグについての説明や言い訳は書かないでください
- 迷ったら [neutral] を使ってください

例:
[happy] できたのだ！ [neutral] 次は何をするのだ。
[sad] 見つからなかったのだ。 [neutral] 別の方法を試すのだ。`;

/** 表に無い語は捨てる。デバイス側（Emotion.kt）と揃える。 */
export const EMOTIONS = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "surprised",
] as const;

export type Emotion = (typeof EMOTIONS)[number];

const KNOWN = new Set<string>(EMOTIONS);

export function isEmotion(value: unknown): value is Emotion {
  return typeof value === "string" && KNOWN.has(value);
}

/**
 * 保留の上限。
 *
 * **閉じないタグで永久に黙るのを防ぐ。** 既知の語で一番長いのは
 * `surprised`（9）なので、`[` と少しの余裕を見てこの長さ。
 */
const HOLD_LIMIT = 12;

/**
 * 辞書で推定する。
 *
 * **課金ゼロ・遅延ゼロで確実に動く**のが取り柄。タグはこれを上書きする。
 *
 * 語の重なり（「ごめん、うれしい」）では**先に出たほう**を採る。
 * 精度を上げようとすると際限が無いので、単純な規則で止めておく。
 */
export function guessEmotion(text: string): Emotion {
  let best: { at: number; emotion: Emotion } | null = null;

  for (const [emotion, words] of Object.entries(DICTIONARY)) {
    for (const word of words) {
      const at = text.indexOf(word);
      if (at < 0) continue;
      if (!best || at < best.at) best = { at, emotion: emotion as Emotion };
    }
  }
  return best?.emotion ?? "neutral";
}

/**
 * 推定の手がかり。**短い語は誤爆する**ので、多少長めに取る。
 *
 * ここは実際の会話を見ながら育てるもので、完璧を狙わない。
 * 外れても neutral に落ちるだけで、本文は無傷。
 */
const DICTIONARY: Record<Exclude<Emotion, "neutral">, string[]> = {
  happy: ["！", "!", "よかった", "うれしい", "嬉しい", "おめでとう", "できた", "成功"],
  sad: ["ごめん", "すみません", "残念", "悲しい", "かなしい", "できません", "わかりません"],
  angry: ["だめ", "駄目", "いけません", "許せ", "怒"],
  surprised: ["えっ", "まさか", "びっくり", "驚", "本当に？", "ほんとに？"],
};

/**
 * タグの剥がし器。
 *
 * **`[` を見たらそこから先を保留し、本文に流さない。** これで
 * 「タグを読み上げる」事故が原理的に起きなくなる。保留による遅れは
 * 文頭の十数文字ぶんだけ。
 *
 * 1. 保留中に `]` が来た → 中身が**既知の語に完全一致**すれば感情として
 *    採って捨てる。一致しなければ**保留分をそのまま本文に流す**
 * 2. 保留が {@link HOLD_LIMIT} を超えた → 諦めて本文に流す
 * 3. 終端（{@link flush}）では保留分を必ず流す
 *
 * **`[1]` や `[注]` が消えないのは 1 の「完全一致」による。**
 * 「`[` で始まったら剥がす」にすると本文を壊す。
 */
export class EmotionTagStripper {
  /** `[` のあとに溜めている文字。`[` を含む。 */
  private held = "";

  /**
   * 直近で採れた感情。**読み出すと消える**。
   *
   * 消さないと、1つのタグが後続の文すべてに効いてしまう。
   */
  private pending: Emotion | null = null;

  /** 表に無い語。**捨てた語は呼び出し側でログに出す**（表に足す材料）。 */
  private unknown: string[] = [];

  /**
   * delta を流し込む。**本文だけが返る。**
   *
   * **1 つの delta に複数のタグが入ることがある。** Gemini は改行込みで
   * まとめて送ってくることがあり、`[happy] …\n[sad] …\n[angry] …` が
   * 1 回で届く。採った端から {@link take} で読まないと**最後のタグだけが
   * 残り、それが 1 文目に付く**（実際にそうなった）。
   *
   * 順序を保つため、タグの手前までの本文を {@link pushParts} で
   * 区切って返す。`push` はその本文をつないだだけのもの。
   */
  push(delta: string): string {
    return this.pushParts(delta)
      .map((part) => (typeof part === "string" ? part : ""))
      .join("");
  }

  /**
   * delta を「本文の断片」と「タグ」の並びに分けて返す。**順序を保つ。**
   *
   * 文字列はそのまま本文、`{ emotion }` はそこにタグがあった印。
   * 呼び出し側はこれを順に処理すれば、タグが本文のどこに挟まっていたかを
   * 取り違えない。
   */
  pushParts(delta: string): Array<string | { emotion: Emotion }> {
    const parts: Array<string | { emotion: Emotion }> = [];
    let out = "";

    const flushText = () => {
      if (out) {
        parts.push(out);
        out = "";
      }
    };

    for (const ch of delta) {
      if (this.held) {
        this.held += ch;

        if (ch === "]") {
          const word = this.held.slice(1, -1);
          if (isEmotion(word)) {
            // **ここまでの本文を先に閉じる。** そうしないと後ろの本文と
            // 混ざって、タグがどの文に掛かるか分からなくなる。
            flushText();
            parts.push({ emotion: word });
            this.pending = word;
          } else {
            // 既知の語でないなら本文。`[1]` はここで助かる。
            out += this.held;
            if (word) this.unknown.push(word);
          }
          this.held = "";
          continue;
        }

        // 閉じないまま伸びたら諦める。
        if (this.held.length > HOLD_LIMIT) {
          out += this.held;
          this.held = "";
        }
        continue;
      }

      if (ch === "[") {
        this.held = ch;
        continue;
      }
      out += ch;
    }
    flushText();
    return parts;
  }

  /** 終端。**保留分を取りこぼさない。** */
  flush(): string {
    const rest = this.held;
    this.held = "";
    return rest;
  }

  /** 採れた感情を1回だけ返す。無ければ `null`。 */
  take(): Emotion | null {
    const value = this.pending;
    this.pending = null;
    return value;
  }

  /** 捨てた語。表に足す材料にする。 */
  takeUnknown(): string[] {
    const words = this.unknown;
    this.unknown = [];
    return words;
  }
}
