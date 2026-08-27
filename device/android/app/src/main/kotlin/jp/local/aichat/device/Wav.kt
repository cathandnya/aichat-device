package jp.local.aichat.device

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * 届いた WAV を鳴らせる形にする。
 *
 * VOICEVOX は 24kHz で返してくるので、**レートはヘッダから読む**。
 * 決め打ちにすると 1.5 倍速で鳴る。
 *
 * `fmt ` と `data` の間に別のチャンクが挟まっても壊れないように走査する
 * （サーバー側の `audio/format.ts` の `wavDurationMs` と同じ考え方）。
 */
data class Pcm(val samples: ByteArray, val sampleRate: Int, val channels: Int) {
    override fun equals(other: Any?): Boolean =
        other is Pcm && samples.contentEquals(other.samples) &&
            sampleRate == other.sampleRate && channels == other.channels

    override fun hashCode(): Int =
        samples.contentHashCode() * 31 * 31 + sampleRate * 31 + channels
}

object Wav {
    /** 読めなければ null。**鳴らないだけで落ちないこと。** */
    fun decode(wav: ByteArray): Pcm? {
        if (wav.size < 44) return null
        val buffer = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN)
        if (String(wav, 0, 4, Charsets.US_ASCII) != "RIFF") return null

        var rate = 0
        var channels = 1
        var offset = 12
        while (offset + 8 <= wav.size) {
            val id = String(wav, offset, 4, Charsets.US_ASCII)
            val size = buffer.getInt(offset + 4)
            val body = offset + 8
            if (size < 0) return null

            if (id == "fmt " && size >= 16) {
                channels = buffer.getShort(body + 2).toInt()
                rate = buffer.getInt(body + 4)
            }
            if (id == "data") {
                if (rate == 0) return null
                val length = minOf(size, wav.size - body)
                return Pcm(wav.copyOfRange(body, body + length), rate, channels)
            }
            offset = body + size + (size % 2) // チャンクは偶数境界に揃う
        }
        return null
    }
}
