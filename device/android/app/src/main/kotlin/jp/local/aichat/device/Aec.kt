package jp.local.aichat.device

import android.util.Log
import kotlin.math.log10
import kotlin.math.sqrt

/**
 * 音響エコー消去。**speexdsp を呼ぶ口。**
 *
 * この端末はハードのエコー消去を持たない（実測で `aecEnabled=false`、
 * `dumpsys` の `0 Effect Chains`）。そのため今までは「読み上げ中は
 * マイクを送らない」で自己起動を避けていた（`MainActivity`）。
 * **それだと読み上げ中に話しかけられない。**
 *
 * ### 効いているかの判定
 *
 * ERLE（消えた量）を測るが、**合格条件は数値ではない**。本当の条件は
 * 「読み上げ中に自分の声が文字にならないこと」で、それはサーバーの
 * `[speech] 聞き取り` と `[wake]` のログで見る。ERLE は外れたときに
 * 原因を切り分けるための計器。
 *
 * ### 退路
 *
 * 効かなかったときに**放っておいても元に戻る**ようにしてある。
 * `ready` が false になれば、呼ぶ側の条件は元の「再生中は送らない」と
 * 同じ意味になる。
 */
class Aec {

    private var handle: Long = 0L

    /** 消した結果を入れる先。**毎フレーム確保しない。** */
    private val out = ShortArray(FRAME)
    private val mic = ShortArray(FRAME)
    private val ref = ShortArray(FRAME)

    /**
     * 信用してよいか。**呼ぶ側はこれだけを見る。**
     *
     * 収束前と、効きが落ちたときに false になる。
     */
    @Volatile var ready: Boolean = false
        private set

    /** 直近の ERLE（dB）。ログと判定に使う。 */
    @Volatile var erle: Float = 0f
        private set

    /** 収束したとみなすまでに通したフレーム数。 */
    private var processed = 0

    private var micEnergy = 0.0
    private var outEnergy = 0.0
    private var measured = 0

    fun open() {
        if (handle != 0L) return
        handle = nativeInit(FRAME, FILTER, Format.SAMPLE_RATE)
        if (handle == 0L) {
            Log.w(TAG, "speexdsp を初期化できませんでした。エコー消去は使いません。")
            return
        }
        processed = 0
        Log.i(TAG, "開きました frame=$FRAME filter=$FILTER rate=${Format.SAMPLE_RATE}")
    }

    /**
     * 80ms の塊から自分の声を消す。
     *
     * **speexdsp は 20ms 単位**なので 4 つに割って順に渡す。まとめて
     * 渡すと収束しない。
     *
     * `micFrame` は書き換える（消した結果で上書きする）。`reference`
     * は同じ長さの参照信号で、null なら**何もしない**（鳴っていない）。
     */
    fun process(micFrame: ByteArray, length: Int, reference: ShortArray?) {
        if (handle == 0L || reference == null) return

        val frames = length / 2 / FRAME
        for (n in 0 until frames) {
            val base = n * FRAME

            for (i in 0 until FRAME) {
                val at = (base + i) * 2
                mic[i] = ((micFrame[at + 1].toInt() shl 8) or
                    (micFrame[at].toInt() and 0xff)).toShort()
                ref[i] = reference[base + i]
            }

            nativeProcess(handle, mic, ref, out)

            for (i in 0 until FRAME) {
                val at = (base + i) * 2
                micFrame[at] = (out[i].toInt() and 0xff).toByte()
                micFrame[at + 1] = ((out[i].toInt() shr 8) and 0xff).toByte()
            }

            accumulate()
            processed += 1
        }
    }

    /** ERLE を測る。**1 秒ぶん溜めてから出す。**フレームごとだと暴れる。 */
    private fun accumulate() {
        var m = 0.0
        var o = 0.0
        for (i in 0 until FRAME) {
            m += mic[i].toDouble() * mic[i].toDouble()
            o += out[i].toDouble() * out[i].toDouble()
        }
        micEnergy += m
        outEnergy += o
        measured += 1

        if (measured < MEASURE_FRAMES) return

        // 消えた量 = 入ってきた大きさ ÷ 残った大きさ。
        erle = if (outEnergy > 0 && micEnergy > 0) {
            (10.0 * log10(micEnergy / outEnergy)).toFloat()
        } else {
            0f
        }
        // ★ **信用するかどうかは、ここだけで決める。**
        //
        // 測り終えた直後の、いま計った値だけを見る。フレームごとに
        // 判定すると**前の窓の値が残ったまま**次の 1 秒を通してしまい、
        // 消えなくなった瞬間の 1 秒がまるごと素通しになる。
        // 自己起動が起きるのはまさにその 1 秒なので、ここを分けない。
        //
        // 収束前も信用しない。起動直後のフィルタは何も消せていない。
        ready = processed >= WARMUP_FRAMES && erle >= ERLE_FLOOR

        Log.i(
            TAG,
            "erle=%.1fdB mic=%.3f out=%.3f ready=%s".format(
                erle,
                sqrt(micEnergy / (measured * FRAME)) / 32768.0,
                sqrt(outEnergy / (measured * FRAME)) / 32768.0,
                ready,
            ),
        )
        micEnergy = 0.0
        outEnergy = 0.0
        measured = 0
    }

    /**
     * 文を鳴らし終えたときに呼ぶ。**係数は消さない**（部屋は変わらない）。
     *
     * **信用は毎回落とす。** 鳴っていない間はフレームが来ないので、
     * ここで落とさないと最後に測った値が残り続ける。次の文が鳴り始めて
     * から測り直して、また 6dB 出ていれば立つ。
     *
     * 収束の数え（`processed`）は残す。部屋の伝達関数は変わらないので、
     * 2 文目以降は溜めた係数がそのまま効く。
     */
    fun endTrack() {
        ready = false
        micEnergy = 0.0
        outEnergy = 0.0
        measured = 0
    }

    fun close() {
        if (handle == 0L) return
        nativeDestroy(handle)
        handle = 0L
        ready = false
        processed = 0
    }

    companion object {
        private const val TAG = "aichat-aec"

        /**
         * ここを false にすれば**完全に元の挙動**に戻る（ビルド時の退路）。
         *
         * 実行時に切りたいときは `--es aec off`（`MainActivity`）。
         * 再ビルドせずに実機で切り分けられる。
         */
        const val ENABLED = true

        /** speexdsp に渡す 1 回ぶん。**20ms 推奨。** */
        const val FRAME = Format.SAMPLE_RATE / 50

        /**
         * 消したい残響の長さ。
         *
         * 実測（`dumpsys media.audio_flinger`）で、HAL より下だけで
         * 50〜80ms あった（write ave 50.8ms、HAL buffer 16ms、
         * mixer 24ms、pipe 32ms）。これにアプリ側のバッファと空気の
         * ぶんが乗るので、**200ms 取る**。
         */
        const val FILTER = Format.SAMPLE_RATE / 5

        /** これを割ったら信用しない。 */
        const val ERLE_FLOOR = 6f

        /** 収束を待つ長さ。20ms × 50 = 1 秒。 */
        const val WARMUP_FRAMES = 50

        /** ERLE を出す間隔。20ms × 50 = 1 秒。 */
        const val MEASURE_FRAMES = 50

        init {
            System.loadLibrary("aec")
        }

        @JvmStatic external fun nativeInit(
            frameSize: Int,
            filterLength: Int,
            sampleRate: Int,
        ): Long

        @JvmStatic external fun nativeProcess(
            handle: Long,
            mic: ShortArray,
            ref: ShortArray,
            out: ShortArray,
        )

        @JvmStatic external fun nativeDestroy(handle: Long)
    }
}
