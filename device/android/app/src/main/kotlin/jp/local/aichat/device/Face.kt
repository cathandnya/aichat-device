package jp.local.aichat.device

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory

/**
 * 顔。**土台に目と口を重ねる。**
 *
 * 土台には目も口も描かれていない。3 枚とも同じ 480x480 の座標系で
 * 位置が合わせてあるので、そのまま重ねればよい。
 *
 *     normal.png            土台（目も口も無い）
 *     normal_eye.png        開いた目
 *     normal_eye_close.png  閉じた目
 *     mouse_0.png           閉じた口（既定）
 *     mouse_1.png           半開き
 *     mouse_2.png           大きく開く
 *
 * 表情ごとに `happy.png` / `happy_eye.png` … と同じ 3 枚組が並ぶ。
 *
 * **口は表情で変わらないので共通の 1 組。** 土台と目だけ差し替える。
 *
 * ### 差し替えの単位は「表情」ではなく slug ★
 *
 * 引くのは [Emotion] ではなく**ファイル名の頭（slug）**にしてある。
 * 顔を決めるものが 2 系統あるため。
 *
 *     docs/08 の 5 表情   normal / happy / sad / angry / surprised
 *     考え中              thinking
 *
 * `thinking` は**感情ではなく状態**（返事を待っている間）なので、
 * [Emotion] に足すと AI に `[thinking]` を吐かせる話になってしまう。
 * どちらを出すかは [FaceView] が決め、ここは名前で引くだけにする。
 *
 * ### なぜ `assets` で、`drawable` ではないか ★
 *
 * **素材は git に入れない**（配布元の規約を確かめていない。
 * `.gitignore` と web/public/character/README.md）。
 *
 * `drawable` に置くと `R.drawable.happy` がコンパイル時に解決されるので、
 * **画像が無いとビルドが通らない**。clone しただけの人が build できなく
 * なってしまう。`assets` なら名前で引くだけなので、無ければ実行時に
 * `null` が返って顔が出ないだけで済む。
 *
 * ### 読み込みは遅らせる
 *
 * 6 顔 × 3 枚を起動時に全部展開すると、480x480 の PNG が 18 枚ぶん
 * メモリに乗る。**使われた顔だけ**読んで覚える。
 *
 * **画像が無くても壊れない。** 顔が出ないだけで、声はそのまま動く。
 */
class Face(context: Context) {

    private val assets = context.assets
    private val cache = HashMap<String, Bitmap?>()

    /** 土台。顔ごと。絵が無ければ `normal` に落ちる。 */
    fun base(slug: String): Bitmap? =
        load("$slug.png") ?: load("normal.png")

    /** 目。閉じ絵が無ければ開いたまま（まばたきしないだけで壊れない）。 */
    fun eye(slug: String, closed: Boolean): Bitmap? {
        val suffix = if (closed) "_eye_close" else "_eye"
        return load("$slug$suffix.png")
            ?: load("${slug}_eye.png")
            ?: load("normal$suffix.png")
            ?: load("normal_eye.png")
    }

    fun mouth(index: Int): Bitmap? =
        load("mouse_${index.coerceIn(0, 2)}.png") ?: load("mouse_0.png")

    /** 顔を出せるか。土台が読めれば描ける。 */
    val usable: Boolean get() = load("normal.png") != null

    private fun load(name: String): Bitmap? = cache.getOrPut(name) {
        try {
            assets.open("character/$name").use { BitmapFactory.decodeStream(it) }
        } catch (_: Exception) {
            null
        }
    }

    companion object {
        /**
         * パラパラの並び。0=閉じ 1=半開き 2=大きく開く。
         *
         * **`0` を混ぜているのが肝心。** 開きっぱなしで往復させると口が
         * 震えているだけに見える。閉じを挟むと音節の切れ目に見える。
         */
        val PATTERN = intArrayOf(1, 2, 1, 0)

        /**
         * 1コマの長さ（ミリ秒）。
         *
         * 日本語は 1 モーラ 100〜120ms 程度で、読み上げは速めてある。
         * 速すぎると震えて見え、遅すぎると口が置いていかれる。
         */
        const val INTERVAL_MS = 120L

        /** 黙っているときの口。 */
        const val CLOSED = 0

        /** まばたきで目を閉じている長さ。**短くないと眠そうに見える。** */
        const val BLINK_MS = 140L

        /** まばたきの間隔。この幅でばらつかせる。規則的だと機械に見える。 */
        const val BLINK_MIN_MS = 2_000L
        const val BLINK_MAX_MS = 6_000L
    }
}
