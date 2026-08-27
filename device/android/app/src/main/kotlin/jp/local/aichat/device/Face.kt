package jp.local.aichat.device

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.File

/**
 * 顔。**土台に口を1枚重ねる。**
 *
 * 土台には口が描かれていない。黙っているときは 0（閉じ）を重ねる——
 * 「重ねていない」わけではない。ブラウザ版（web/src/character/mouth.ts）と
 * 同じ作り。
 *
 * ### 画像はアプリに焼き込まない
 *
 * `getExternalFilesDir("character")` から読む。**入れ替えるのにビルドが
 * 要らない**のと、素材を git に入れない方針（web/public/character/README.md）に
 * 揃えるため。
 *
 *     adb push normal.png /sdcard/Android/data/jp.local.aichat.device/files/character/
 *
 * **画像が無くても壊れない。** 顔が出ないだけで、声はそのまま動く。
 */
class Face(context: Context) {

    private val dir = File(context.getExternalFilesDir(null), "character")

    val base: Bitmap? = load("normal.png")
    private val mouths: List<Bitmap?> = listOf(
        load("mouse.0.png"),
        load("mouse.1.png"),
        load("mouse.2.png"),
    )

    val usable: Boolean get() = base != null

    fun mouth(index: Int): Bitmap? = mouths.getOrNull(index) ?: mouths.firstOrNull()

    private fun load(name: String): Bitmap? = try {
        val file = File(dir, name)
        if (file.isFile) BitmapFactory.decodeFile(file.path) else null
    } catch (_: Exception) {
        null
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
    }
}
