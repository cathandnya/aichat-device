package jp.local.aichat.device

import android.content.Context
import kotlin.random.Random

/**
 * この端末の id。**会話を継ぐ相手はこれで決まる。**
 *
 * 家に2台置くと、居間の会話を寝室が引き取ってしまう。見分ける鍵が要るが、
 * MAC は TCP では届かず、IP は DHCP で変わる。なので**端末が自分で名乗る**
 * （device/server/src/chats/types.ts の `normalizeDeviceId` と同じ規則）。
 *
 * ブラウザ版は `localStorage` に `browser-xxxx` を作る。こちらは
 * `SharedPreferences` に `android-xxxx` を作る。**別の端末として扱われる**
 * のが正しい（同じ機械でも、ブラウザとアプリは別の流れ）。
 */
object DeviceId {
    private const val PREFS = "aichat-device"
    private const val KEY = "device-id"

    /** サーバー側の規則。ずれてもサーバーが弾いて「名前のない端末」に落ちるだけ。 */
    private val SAFE = Regex("^[A-Za-z0-9][A-Za-z0-9-]{0,31}$")

    fun of(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        val saved = prefs.getString(KEY, null)
        if (saved != null && SAFE.matches(saved)) return saved

        val made = "android-%04x".format(Random.nextInt(0x10000))
        prefs.edit().putString(KEY, made).apply()
        return made
    }
}
