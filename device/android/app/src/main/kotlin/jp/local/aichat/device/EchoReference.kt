package jp.local.aichat.device

/**
 * 自分が鳴らした音を、マイク側から引ける形で覚えておく輪。
 *
 * エコー消去には「いまマイクに入っている音の、元になった再生音」が要る。
 * **端末しかこれを正確に持てない。** サーバーは何をいつ渡したかは知って
 * いるが、実際にスピーカーが鳴った時刻は知らない。
 *
 * ### 何を入れるか
 *
 * `AudioTrack.write()` に渡すのと同じ PCM を、**16kHz mono に直して**
 * 入れる。VOICEVOX は 24kHz で返すので落とす必要がある。
 *
 * **出力 HAL は 48kHz ステレオだが、そちらは追わない。** OS が上げ直した
 * 後の音は取れないし、取る必要もない。リサンプルは線形時不変なので、
 * その差はフィルタが部屋の伝達関数の一部として吸収する。
 *
 * ### 位置の数え方
 *
 * 文ごとに `AudioTrack` を作り直すが、**位置は通しで数える**。
 * track を跨いでも連続した時間軸になるので、マイク側は
 * 「いまの再生位置 − 遅延」で引ける。
 */
class EchoReference {

    /** 16kHz mono の輪。8 秒ぶん持つ（`RingBuffer` と同じ長さ）。 */
    private val ring = ShortArray(Format.SAMPLE_RATE * SECONDS)

    /** これまでに積んだ通算サンプル数。**巻き戻らない。** */
    @Volatile private var written = 0L

    /** いま鳴っている track の、輪の中での開始位置。 */
    @Volatile private var trackStart = 0L

    /** 鳴っているか。false の間は参照を返さない。 */
    @Volatile var active = false
        private set

    /** 新しい文を鳴らし始める。**係数は消さない**（部屋は変わらない）。 */
    @Synchronized fun beginTrack() {
        trackStart = written
        active = true
    }

    /**
     * 鳴らし終わった／やめた。
     *
     * `playedFrames` は実際に鳴った長さ（`playbackHeadPosition`）。
     * **途中で止めたぶんは捨てる。** 残すと、鳴っていない音を
     * 「鳴った」ことにして引いてしまい、フィルタが壊れる。
     */
    @Synchronized fun endTrack(playedFrames: Int) {
        val played = trackStart + playedFrames
        if (played < written) written = played
        active = false
    }

    /**
     * 鳴らす PCM を積む。**`write()` を呼ぶ前に呼ぶこと。**
     *
     * `AudioTrack.write()` はバッファが空くまでブロックする（数百 ms
     * あり得る）。後に積むと、その間マイク側が参照を引けず空を読む。
     */
    @Synchronized fun push(pcm: Pcm) {
        val step = pcm.sampleRate.toDouble() / Format.SAMPLE_RATE
        val channels = maxOf(1, pcm.channels)
        val bytesPerFrame = 2 * channels
        val frames = pcm.samples.size / bytesPerFrame

        // 16kHz に落としながら積む。**線形補間はしない。**
        // 折り返しはフィルタが吸うので、最近傍で足りる（凝らない）。
        var at = 0.0
        while (at < frames) {
            val frame = at.toInt()
            // ステレオなら左だけ見る。参照は mono でよい。
            val index = frame * bytesPerFrame
            val sample = ((pcm.samples[index + 1].toInt() shl 8) or
                (pcm.samples[index].toInt() and 0xff)).toShort()

            ring[(written % ring.size).toInt()] = sample
            written += 1
            at += step
        }
    }

    /**
     * `count` サンプルぶんの参照を取り出す。
     *
     * `delaySamples` は「スピーカーから出てマイクに戻るまで」の遅れ。
     * いま鳴っている位置からそのぶん遡って読む。
     *
     * 鳴っていない、または遡り先が輪から溢れているときは null。
     * **null は「消すものが無い」の意味**で、呼ぶ側は素通しする。
     */
    @Synchronized fun read(count: Int, delaySamples: Int, into: ShortArray): Boolean {
        if (!active) return false

        val from = written - delaySamples - count
        if (from < 0) return false
        // 輪から溢れて上書きされていたら諦める。
        if (written - from > ring.size) return false

        for (i in 0 until count) {
            into[i] = ring[((from + i) % ring.size).toInt()]
        }
        return true
    }

    private companion object {
        /** `RingBuffer` と揃えて 8 秒。遅延が大きくても引けるように。 */
        const val SECONDS = 8
    }
}
