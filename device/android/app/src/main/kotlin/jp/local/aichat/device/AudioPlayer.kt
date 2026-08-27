package jp.local.aichat.device

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import java.util.concurrent.LinkedBlockingQueue

/**
 * 届いた読み上げを、届いた順に鳴らす。
 *
 * **先読みの仕掛けは要らない。** サーバー側の `speech/queue.ts` が
 * 「合成は並列・送出は直列」を済ませており、届く順＝読み上げる順が
 * 保証されている。ここは受け取って復号して順に鳴らすだけ。
 *
 * `playing` を見ているのは口パク。**状態（speaking）では代わりにならない**
 * ——サーバー側は最初の delta で立ち、WAV を送り終えた時点で降りるので、
 * 実際に鳴っている区間と両側にずれる。
 */
class AudioPlayer {

    private val queue = LinkedBlockingQueue<ByteArray>()
    private var thread: Thread? = null
    @Volatile private var running = false
    /** 「やめる」のたびに増やす。古い世代の音は鳴らさない。 */
    @Volatile private var generation = 0

    /** いま実際に音が出ているか。**口パクの根拠。** */
    @Volatile var playing: Boolean = false
        private set

    fun start() {
        if (running) return
        running = true
        thread = Thread({ pump() }, "player").also { it.start() }
    }

    fun enqueue(wav: ByteArray) {
        queue.put(wav)
    }

    /**
     * すべてやめる。
     *
     * 世代を進めることで、積まれている音も捨てる。真偽値にすると戻す場所が
     * 無く、一度やめたあと二度と鳴らなくなる。
     */
    fun cancel() {
        generation += 1
        queue.clear()
    }

    private fun pump() {
        while (running) {
            val wav = queue.take()
            val mine = generation
            val pcm = Wav.decode(wav) ?: continue
            if (mine != generation) continue
            play(pcm, mine)
        }
    }

    private fun play(pcm: Pcm, mine: Int) {
        val channelMask =
            if (pcm.channels >= 2) AudioFormat.CHANNEL_OUT_STEREO
            else AudioFormat.CHANNEL_OUT_MONO

        val minimum = AudioTrack.getMinBufferSize(
            pcm.sampleRate,
            channelMask,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minimum <= 0) return

        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    // **VOICE_COMMUNICATION にする。** 録音側と対にすることで、
                    // 端末のエコーキャンセルが参照信号を掴める。
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(pcm.sampleRate)
                    .setChannelMask(channelMask)
                    .build(),
            )
            .setBufferSizeInBytes(maxOf(minimum, pcm.samples.size.coerceAtMost(minimum * 4)))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()

        try {
            playing = true
            track.play()
            var offset = 0
            while (offset < pcm.samples.size && mine == generation) {
                val wrote = track.write(pcm.samples, offset, pcm.samples.size - offset)
                if (wrote <= 0) break
                offset += wrote
            }
            // **鳴り終わるまで待つ。** 書き終えた時点ではまだ鳴っている。
            // ここで戻ると口パクが先に止まる。
            if (mine == generation) {
                track.stop()
                while (track.playState == AudioTrack.PLAYSTATE_PLAYING) {
                    Thread.sleep(20)
                }
            }
        } catch (_: Exception) {
            // 鳴らなくても止まらない。次の文へ進む。
        } finally {
            playing = false
            try {
                track.release()
            } catch (_: Exception) {
                // すでに解放されていることがある。
            }
        }
    }

    fun close() {
        running = false
        cancel()
        thread?.interrupt()
        thread = null
    }
}
