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
    /** 読み上げの音声（WAV）。 */
    data class Audio(val wav: ByteArray) : Event
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
