package jp.local.aichat.device

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import kotlin.math.sqrt

/**
 * マイクを開いて 80ms ずつ流す。
 *
 * **16kHz mono 16bit をそのまま録る。** ブラウザ版は `AudioContext` に
 * 変換させていたが、こちらは最初から要る形で録れる。
 *
 * ### エコーキャンセル ★
 *
 * `VOICE_COMMUNICATION` で開き、`AcousticEchoCanceler` を明示的に付ける。
 * 常時マイクが開いている機械なので、**これが無いと自分の読み上げで
 * 起動し続ける**（いまはサーバーが読み上げ中の判定を止めて避けている）。
 *
 * ここが効けば、読み上げ中も判定を続けられて**声で割り込める**ようになる。
 * 効くかどうかは端末次第なので、`aecEnabled` を見て実機で確かめること。
 */
class MicStream(private val onFrame: (ByteArray, Int) -> Unit) {

    private var record: AudioRecord? = null
    private var thread: Thread? = null
    @Volatile private var running = false

    /** 直近のフレームの実効音量（0〜1）。画面の「届いている証」に使う。 */
    @Volatile var level: Float = 0f
        private set

    /** エコーキャンセルが実際に有効になったか。**実機で確かめる値。** */
    @Volatile var aecEnabled: Boolean = false
        private set

    var noiseSuppressorEnabled: Boolean = false
        private set

    fun open() {
        if (running) return

        val minimum = AudioRecord.getMinBufferSize(
            Format.SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        // 最小の倍を持つ。ぎりぎりだと取りこぼす。
        val bufferBytes = maxOf(minimum, Format.FRAME_BYTES * 8) * 2

        val audio = AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            Format.SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferBytes,
        )
        if (audio.state != AudioRecord.STATE_INITIALIZED) {
            audio.release()
            throw IllegalStateException("マイクを開けませんでした。")
        }

        attachEffects(audio.audioSessionId)

        record = audio
        running = true
        audio.startRecording()

        thread = Thread({ pump(audio) }, "mic").also { it.start() }
    }

    private fun attachEffects(sessionId: Int) {
        if (AcousticEchoCanceler.isAvailable()) {
            AcousticEchoCanceler.create(sessionId)?.let {
                it.enabled = true
                aecEnabled = it.enabled
            }
        }
        if (NoiseSuppressor.isAvailable()) {
            NoiseSuppressor.create(sessionId)?.let {
                it.enabled = true
                noiseSuppressorEnabled = it.enabled
            }
        }
        // **AGC は付けない。** 無音の底上げでウェイクワードの誤検出が増えるほうが困る。
        AutomaticGainControl.isAvailable()
    }

    private fun pump(audio: AudioRecord) {
        val frame = ByteArray(Format.FRAME_BYTES)
        while (running) {
            var filled = 0
            // **80ms ちょうどで送る。** 半端な長さで送ると、サーバー側の
            // フレーム数え（暗騒音・窓の長さ）がずれる。
            while (filled < frame.size && running) {
                val read = audio.read(frame, filled, frame.size - filled)
                if (read <= 0) break
                filled += read
            }
            if (filled < frame.size) continue

            level = rms(frame)
            onFrame(frame, filled)
        }
    }

    private fun rms(frame: ByteArray): Float {
        var sum = 0.0
        var i = 0
        while (i + 1 < frame.size) {
            val sample = (frame[i].toInt() and 0xff) or (frame[i + 1].toInt() shl 8)
            val value = sample.toShort().toDouble()
            sum += value * value
            i += 2
        }
        return (sqrt(sum / (frame.size / 2)) / 32768.0).toFloat()
    }

    fun close() {
        running = false
        thread?.join(500)
        thread = null
        record?.let {
            try {
                it.stop()
            } catch (_: Exception) {
                // すでに止まっていることがある。
            }
            it.release()
        }
        record = null
        level = 0f
    }
}
