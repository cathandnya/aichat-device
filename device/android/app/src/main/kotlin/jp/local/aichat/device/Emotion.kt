package jp.local.aichat.device

/**
 * 表情。**docs/08 の 5 種類に合わせる。**
 *
 * サーバーが `[happy]` のようなタグで送ってくる想定（まだ配管は無い）。
 * 語は列挙して固定する。自由に作らせると絵の無い名前が来る。
 *
 * **知らない語は `NEUTRAL` に倒す。** 感情は「付いていたら使う」上乗せで、
 * 無くても会話は成り立つ（docs/08 の方針）。
 */
enum class Emotion(
    /** 画像のファイル名の頭。`normal.png` / `happy_eye.png` のように使う。 */
    val slug: String,
) {
    NEUTRAL("normal"),
    HAPPY("happy"),
    SAD("sad"),
    ANGRY("angry"),
    SURPRISED("surprised");

    companion object {
        fun of(name: String?): Emotion = when (name?.trim()?.lowercase()) {
            "happy" -> HAPPY
            "sad" -> SAD
            "angry" -> ANGRY
            // 素材のファイル名が `suprised` と綴られていた名残。
            // タグ側で揺れても拾えるようにしておく。
            "surprised", "suprised" -> SURPRISED
            else -> NEUTRAL
        }
    }
}
