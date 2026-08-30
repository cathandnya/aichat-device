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
 * ### 位置の数え方 ★
 *
 * **「積んだ位置」と「鳴った位置」を分ける。** ここを混ぜると全部ずれる。
 *
 * `AudioTrack.write()` には文をまるごと渡すので、**積んだ位置は一瞬で
 * 文の終わりまで飛ぶ**。3 秒の文なら、鳴り始めた直後にはもう 3 秒ぶんが
 * 積まれている。積んだ位置を基準に引くと、まだ鳴っていない先の音を
 * 「いま鳴っている音」として消そうとすることになる。
 *
 * だから引くときは**再生位置**（`playbackHeadPosition`）を基準にする。
 * これは実際にデバイスへ渡った量なので、時間軸として信用できる。
 * track を跨いでも連続するよう、開始位置を足して通しで数える。
 */
class EchoReference {

    /** 16kHz mono の輪。8 秒ぶん持つ（`RingBuffer` と同じ長さ）。 */
    private val ring = ShortArray(Format.SAMPLE_RATE * SECONDS)

    /** これまでに**積んだ**通算サンプル数。**巻き戻らない。** */
    @Volatile private var written = 0L

    /** いま鳴っている track が、輪のどこから始まるか。 */
    @Volatile private var trackStart = 0L

    /**
     * いま**鳴った**ところ（通し）。`playbackHeadPosition` から作る。
     *
     * これが引くときの基準。積んだ位置ではない。
     */
    @Volatile private var played = 0L

    /** 鳴っているか。false の間は参照を返さない。 */
    @Volatile var active = false
        private set

    /** 新しい文を鳴らし始める。**係数は消さない**（部屋は変わらない）。 */
    @Synchronized fun beginTrack() {
        trackStart = written
        played = written
        active = true
    }

    /**
     * どこまで鳴ったかを知らせる。**再生側が繰り返し呼ぶ。**
     *
     * `frames` は `AudioTrack.playbackHeadPosition`（その track の中での
     * 位置）。track を跨いで連続するよう開始位置を足す。
     */
    @Synchronized fun progress(frames: Int) {
        played = trackStart + frames
    }

    /**
     * 鳴らし終わった／やめた。
     *
     * `playedFrames` は実際に鳴った長さ。**途中で止めたぶんは捨てる。**
     * 残すと、鳴っていない音を「鳴った」ことにして次の文が引いてしまう。
     * **止める操作は実装済みなので必ず起きる。**
     */
    @Synchronized fun endTrack(playedFrames: Int) {
        played = trackStart + playedFrames
        // 鳴らなかったぶんは無かったことにする。
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

        // ★ **基準は「鳴った位置」。** 積んだ位置（`written`）ではない。
        // `write()` は文をまるごと渡すので、積んだ位置は鳴り始めた直後に
        // もう文末まで飛んでいる。そちらを使うと未来の音を消そうとする。
        val from = played - delaySamples - count
        if (from < 0) {
            note("from<0 played=$played written=$written")
            return false
        }
        // まだ積んでいない先は読めない。
        if (from + count > written) {
            note("未来 from=$from played=$played written=$written")
            return false
        }
        // 輪から溢れて上書きされていたら諦める。
        if (written - from > ring.size) {
            note("溢れ from=$from written=$written")
            return false
        }

        for (i in 0 until count) {
            into[i] = ring[((from + i) % ring.size).toInt()]
        }
        return true
    }

    /** 引けなかった理由を、1 秒に 1 回だけ出す。**毎フレーム出すと流れる。** */
    private var lastNote = 0L
    private var notes = 0
    private fun note(reason: String) {
        notes += 1
        val now = android.os.SystemClock.uptimeMillis()
        if (now - lastNote < 1000) return
        lastNote = now
        android.util.Log.i("aichat-aec", "参照が引けない(${notes}回): $reason")
        notes = 0
    }

    private companion object {
        /** `RingBuffer` と揃えて 8 秒。遅延が大きくても引けるように。 */
        const val SECONDS = 8
    }
}
