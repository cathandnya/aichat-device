package jp.local.aichat.device

/**
 * サーバーとの取り決め。**ブラウザ版（device/web/src/api/device.ts）と同じもの。**
 *
 * 判断はすべてサーバーが持つ。ここに来るのは「こう表示しろ」という結果だけで、
 * このファイルに条件分岐を増やし始めたら設計を間違えている。
 */

/** 画面の状態。サーバーの `DeviceState` と同じ並び。 */
enum class State {
    IDLE,
    LISTENING,
    THINKING,
    SPEAKING,
    /** 追い質問の窓。ウェイクワード無しで続けられる。 */
    FOLLOWING,
    ERROR;

    /** **声を受け付けている状態。** ここだけ見た目を大きく変える。 */
    val hearing: Boolean
        get() = this == LISTENING || this == FOLLOWING

    companion object {
        fun of(raw: String): State = when (raw) {
            "listening" -> LISTENING
            "thinking" -> THINKING
            "speaking" -> SPEAKING
            "following" -> FOLLOWING
            "error" -> ERROR
            else -> IDLE
        }
    }
}

/** サーバーから届くもの。 */
sealed interface Event {
    data class StateChanged(val state: State, val status: String) : Event
    /** 表情。**読み上げの直前に届く**ので、声より先に顔が変わる。 */
    data class EmotionChanged(val emotion: Emotion) : Event
    /** ウェイクワードで起こされた。効果音を鳴らす合図。 */
    data object Wake : Event
    /**
     * 鳴らす音声。**表情も一緒に来る。**
     *
     * 別々に受け取ると、鳴らす順と顔を変える順が合わない
     * （サーバーは端末の再生の進みを知らない）。
     */
    data class Audio(val wav: ByteArray, val emotion: Emotion?) : Event
    /** 読み上げはこれで終わり。**次の音は来ない。** */
    data object SpeechEnd : Event
    /** 音量を変える。**0〜1 の割合**で届く。段数に直すのは端末の仕事。 */
    data class VolumeChanged(val level: Float) : Event
    /** 繋がった。**いまの音量を知らせる合図。** */
    data object Opened : Event
    data class Failed(val message: String) : Event
    data object Closed : Event
}

/** 音声の形式。デバイスとサーバーの取り決め。 */
object Format {
    const val SAMPLE_RATE = 16_000
    /** 1フレームのサンプル数。80ms ぶん。 */
    const val FRAME_SAMPLES = 1_280
    const val FRAME_BYTES = FRAME_SAMPLES * 2
}
