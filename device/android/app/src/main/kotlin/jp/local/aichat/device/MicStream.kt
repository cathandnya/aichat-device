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
 * **この端末はマイクの入力がとても小さい。** 素のままだと普通の距離の
 * 話し声で peak 200 ほど（16bit の上限 32768 に対して 0.6%）しかなく、
 * **音声認識が言葉として拾えない**（「ずんだもん」が「17」になった）。
 * 音量の閾値ではなく認識の問題なので、素材そのものを大きくする。
 *
 * 実測で決めた値。12 倍で peak 2808・割れ 0、36 倍で peak 15,660・割れ 0。
 * ただし **36 倍は上限まで 2.1 倍しか余裕が無い**。手を叩く程度の突発音で
 * 割れるので、**24 倍に下げる**（発話時 peak 約 10,400、上限の 32%、余裕 3.1 倍）。
 *
 * **AEC にとっても重要。** 下の `amplify()` は `coerceIn` でクリップする。
 * **クリップは非線形歪みなので、線形フィルタでは消せない。** 読み上げ中は
 * 自分の声でマイクが大きく振れるので、割れやすいままだと AEC の前提が崩れる。
 *
 * **AGC ではなく固定倍率**にしてある。AGC は無音を底上げするので、
 * ウェイクワードの誤検出が増える。そもそもこの端末は効果チェーンを
 * 持たない（`0 Effect Chains`）ので AGC も AEC も使えない。
 */
private const val GAIN = 24f

class MicStream(
    private val onFrame: (ByteArray, Int) -> Unit,
    /**
     * 自分が鳴らした音。**エコー消去の参照信号。**
     *
     * null なら消去をしない（元の挙動）。
     */
    private val reference: EchoReference? = null,
) {

    /**
     * エコー消去。**効かなければ自分で降りる**（`Aec.ready`）。
     *
     * `enabled=false` なら作らない＝**消さない**。切り分けのとき、
     * ゲートだけでなく消去そのものを止められるようにしてある。
     */
    var aec: Aec? = if (Aec.ENABLED) Aec() else null
        private set

    /** 消去そのものをやめる。**実行時の切り分け用。** */
    fun disableCancellation() {
        aec?.close()
        aec = null
    }

    /**
     * スピーカーから出てマイクに戻るまでの遅れ（サンプル数）。
     *
     * 実測（`dumpsys media.audio_flinger`）で HAL より下だけで 50〜80ms
     * あった。アプリ側のバッファと空気のぶんが乗るので、**まず 120ms を
     * 置いて始める**。ここがずれていても、フィルタ長 200ms のうちで
     * speexdsp が吸う。
     */
    @Volatile var delaySamples: Int = Format.SAMPLE_RATE * 120 / 1000

    private var record: AudioRecord? = null
    private var thread: Thread? = null
    @Volatile private var running = false

    /** 直近のフレームの実効音量（0〜1）。画面の「届いている証」に使う。 */
    @Volatile var level: Float = 0f
        private set

    /** 直近のフレームで実際に消したか。**ログの切り分け用。** */
    @Volatile var lastCancelled: Boolean = false
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
            // ★ **`MIC`（素の入力）で開く。**
            //
            // 元は `VOICE_COMMUNICATION` だった。端末のエコー消去に
            // 参照を掴ませる狙いだったが、**この端末に効果チェーンは無い**
            // （実測 `0 Effect Chains`）ので、その利点は元々無い。
            //
            // 一方で `VOICE_COMMUNICATION` は、プラットフォーム側が
            // 通話向けの加工（AGC・雑音抑圧・半二重の抑え込み）を
            // 掛けることがある。**加工は非線形なので、線形フィルタでは
            // 消せない。** 自前で消す以上、素のまま受け取るほうがよい。
            MediaRecorder.AudioSource.MIC,
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
        aec?.open()

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
        // 参照を受け取る先。**毎フレーム確保しない。**
        val ref = ShortArray(Format.FRAME_SAMPLES)
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

            // **消してから持ち上げる。順序を入れ替えてはいけない。**
            //
            // `amplify()` は上限で頭打ちにする（クリップ）。クリップは
            // 非線形なので、**線形フィルタでは絶対に消せない**。持ち上げた
            // 後に消そうとすると、割れた成分だけが残る。
            val cancelled = aec?.let { engine ->
                val got = reference?.read(Format.FRAME_SAMPLES, delaySamples, ref) ?: false
                if (got) {
                    engine.process(frame, filled, ref)
                    true
                } else {
                    // **鳴っていないなら信用も落とす。**
                    //
                    // フレームが来なくなるので、ここで落とさないと最後に
                    // 測った値のまま次の文の頭を素通しする。収束したぶん
                    // （係数）は残るので、測り直しはすぐ済む。
                    engine.endTrack()
                    false
                }
            } ?: false

            amplify(frame, filled)
            level = rms(frame)
            onFrame(frame, filled)
            lastCancelled = cancelled
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
        aec?.close()
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
