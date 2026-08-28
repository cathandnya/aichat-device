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
   */
  push(delta: string): string {
    let out = "";

    for (const ch of delta) {
      if (this.held) {
        this.held += ch;

        if (ch === "]") {
          const word = this.held.slice(1, -1);
          if (isEmotion(word)) {
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
    return out;
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
