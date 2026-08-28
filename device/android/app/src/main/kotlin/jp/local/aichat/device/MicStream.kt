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
/**
 * 送る前に掛ける倍率。
 *
 * **4 倍では足りなかった。** 普通の距離から話すと、そのあとでも
 * 実測で peak 800（16bit の上限 32768 に対して 2.5%）ほどにしかならず、
 * **音声認識が言葉として拾えない**（「ずんだもん」が「17」になった）。
 * 音量の閾値ではなく認識精度の問題なので、素材そのものを大きくする。
 *
 * 12 倍でも peak 2400 前後で、割れるにはまだ遠い。
 */
private const val GAIN = 12f

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

            amplify(frame, filled)
            level = rms(frame)
            onFrame(frame, filled)
        }
    }

    /**
     * 送る前に一律で持ち上げる。
     *
     * **Echo Spot は入力が小さい。** 実測で、普通の話し声が rms 0.008 ほど
     * にしかならず、サーバーの「続けてどうぞ」の音量判定（暗騒音の 3 倍、
     * 下限 0.015）を超えられなかった。ウェイクワードは書き起こしで判定
     * するので通り、音量で判定する追い質問だけが落ちる、という形で出る。
     *
     * **AGC ではなく一律の倍率**にしてある。AGC は無音を底上げしてしまい、
     * ウェイクワードの誤検出が増える（`attachEffects` の判断）。一律なら
     * 暗騒音と声の比が変わらないので、その心配が無い。
     * そもそもこの端末は効果チェーンを持たないので AGC は使えない。
     */
    private fun amplify(frame: ByteArray, length: Int) {
        if (GAIN == 1f) return
        var i = 0
        while (i + 1 < length) {
            val sample = ((frame[i + 1].toInt() shl 8) or (frame[i].toInt() and 0xff)).toShort()
            val scaled = (sample * GAIN).toInt().coerceIn(-32768, 32767)
            frame[i] = (scaled and 0xff).toByte()
            frame[i + 1] = ((scaled shr 8) and 0xff).toByte()
            i += 2
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
