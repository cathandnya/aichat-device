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
/** 鳴り終わったあと、マイクを伏せておく長さ。 */
private const val TAIL_MS = 350L


class AudioPlayer(
    /**
     * その音を鳴らし始める直前に呼ぶ。**表情の切り替えはここ。**
     *
     * サーバーは端末の再生の進みを知らないので、向こうで時刻を計算しても
     * ずれる（実機で「音と感情がずれる」）。**鳴り始めを正確に知っている
     * のは端末だけ**なので、切り替えはここでやる。
     */
    private val onStart: (Emotion) -> Unit = {},
    /**
     * 積んであったものを鳴らし終えて、次が無くなったときに呼ぶ。
     *
     * **追い質問の窓はこれを合図に開く。** サーバーは WAV の長さから
     * 終わりを計算していたが実際の再生とずれる。早く開くと自分の声を
     * 拾い、遅いと話しかけても反応しない時間ができる。
     */
    private val onDrained: () -> Unit = {},
    /**
     * 鳴らした音を控えておく先。**エコー消去の参照信号になる。**
     *
     * ここに積まないと、マイク側は「自分が何を鳴らしたか」を知れない。
     * 消去を使わないときは null でよい。
     */
    private val reference: EchoReference? = null,
) {

    private data class Item(val wav: ByteArray, val emotion: Emotion?)

    private val queue = LinkedBlockingQueue<Item>()
    private var thread: Thread? = null
    @Volatile private var running = false
    /** 「やめる」のたびに増やす。古い世代の音は鳴らさない。 */
    @Volatile private var generation = 0
    /** サーバーが「これで最後」と言ったか。 */
    @Volatile private var ended = false

    /** 開いている鳴らし口。**形が同じなら使い回す。** */
    private var track: AudioTrack? = null
    private var trackRate = 0
    private var trackChannels = 0
    /** いまの口に書いた合計フレーム数。鳴り終わりの判定に使う。 */
    private var writtenFrames = 0L

    /** いま実際に音が出ているか。**口パクの根拠。** */
    @Volatile var playing: Boolean = false
        private set

    fun start() {
        if (running) return
        running = true
        thread = Thread({ pump() }, "player").also { it.start() }
    }

    fun enqueue(wav: ByteArray, emotion: Emotion? = null) {
        queue.put(Item(wav, emotion))
    }

    /**
     * これ以上の音は来ない、とサーバーが言ってきた。
     *
     * すでに鳴らし終えていれば、その場で報告する（最後の音の到着より
     * この知らせが遅れることがある）。
     */
    fun end() {
        ended = true
        reportIfDrained()
    }

    /**
     * 「これで最後」と言われたぶんを鳴らし終えていれば報告する。
     *
     * **2 か所から呼ぶ。** 最後の音を鳴らし終えたとき（`pump`）と、
     * 鳴らし終えたあとに知らせが届いたとき（`end`）。どちらが先かは
     * 決まっていないので、両方から同じ判定を通す。
     *
     * `synchronized` にしているのは、その 2 つが別のスレッドだから。
     * 以前は片方が `playing` を見ていて、鳴り終わりの余韻（TAIL_MS）と
     * 重なると**どちらも報告しない**ことがあった。
     */
    @Synchronized
    private fun reportIfDrained() {
        if (ended && queue.isEmpty() && !playing) {
            ended = false
            onDrained()
        }
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
        ended = false
        // **口も閉じる。** 開いたままだと、ハードのバッファに残っている
        // ぶんが鳴り続ける（割り込みで止めたのに喋り続ける）。
        // 次に鳴らすときに開き直す。
        //
        // `pump` の側から呼ばれることもあるが、`closeTrack` は null で
        // 何もしないので二重に閉じても安全。
        closeTrack()
    }

    private fun pump() {
        while (running) {
            val item = queue.take()
            val mine = generation
            val pcm = Wav.decode(item.wav) ?: continue
            if (mine != generation) continue
            // **鳴らす直前に顔を変える。** 復号のあと、再生の直前。
            item.emotion?.let { onStart(it) }
            play(pcm, mine)
            // **キューが空なだけでは判断できない。** 文ごとに届くので、
            // 1 文目を鳴らし終えた時点で 2 文目がまだ来ていないことがある。
            // サーバーの「これで最後」と揃ってはじめて鳴り終わり。
            if (mine == generation) reportIfDrained()
        }
    }

    /** 1 フレームのバイト数。16bit なので 2×チャンネル数。 */
    private fun bytesPerFrameOf(pcm: Pcm): Int = 2 * maxOf(1, pcm.channels)

    /**
     * 鳴らす口を用意する。**同じ形なら開いたまま使い回す。**
     *
     * かたまりごとに作り直すと、その立ち上げと後片付けで **1 個につき
     * 55ms の無音**が入る（実測。500ms のかたまりが 555ms かかっていた）。
     * 500ms 刻みで送っているので、それが途切れとして聞こえる。
     *
     * 形（レート・チャンネル数）が変わったときだけ作り直す。VOICEVOX は
     * 常に同じ形で返すので、実際にはほぼ起きない。
     */
    private fun trackFor(pcm: Pcm): AudioTrack? {
        val channelMask =
            if (pcm.channels >= 2) AudioFormat.CHANNEL_OUT_STEREO
            else AudioFormat.CHANNEL_OUT_MONO

        val open = track
        if (open != null && trackRate == pcm.sampleRate && trackChannels == pcm.channels) {
            return open
        }
        closeTrack()

        val minimum = AudioTrack.getMinBufferSize(
            pcm.sampleRate,
            channelMask,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minimum <= 0) return null

        val fresh = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    // **MEDIA にする。**
                    //
                    // 元は VOICE_COMMUNICATION だった。録音側と対にすれば
                    // 端末のエコーキャンセルが参照信号を掴める、という理屈
                    // だったが、**この端末に AEC は無い**（実測で aecEnabled
                    // は false、`0 Effect Chains`）ので、その利点は無い。
                    //
                    // 通話ストリームのままだと**音量ボタンが効かない**。
                    // ボタンは既定でメディア音量を動かすので、別の系統を
                    // 鳴らしていると変えられなかった。
                    .setUsage(AudioAttributes.USAGE_MEDIA)
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
            // **厚めに持つ。** `MODE_STREAM` の `write()` は空きが出るまで
            // 待つ。待つこと自体は正しい（再生の速度に合わせる仕組み）が、
            // 薄いと網の揺れがそのまま途切れになる。
            .setBufferSizeInBytes(maxOf(minimum * 4, pcm.samples.size))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()

        track = fresh
        trackRate = pcm.sampleRate
        trackChannels = pcm.channels
        writtenFrames = 0L
        reference?.attach(fresh, pcm.sampleRate)
        fresh.play()
        return fresh
    }

    /** 開いている口を閉じる。**参照の控えも一緒に片づける。** */
    private fun closeTrack() {
        val open = track ?: return
        val played = try {
            open.playbackHeadPosition
        } catch (_: Exception) {
            0
        }
        reference?.endTrack(played)
        reference?.detach()
        try {
            open.stop()
        } catch (_: Exception) {
            // すでに止まっていることがある。
        }
        try {
            open.release()
        } catch (_: Exception) {
            // すでに解放されていることがある。
        }
        track = null
        writtenFrames = 0L
    }

    private fun play(pcm: Pcm, mine: Int) {
        val open = trackFor(pcm) ?: return

        try {
            playing = true
            // **参照は `write()` より先に積む。**
            //
            // `write()` はバッファが空くまでブロックする（数百 ms あり得る）。
            // 後に積むと、その間マイク側が参照を引けず、消さないまま
            // 素通しになる。**鳴り始めが一番消したい所**なので順序が要る。
            reference?.push(pcm)

            val body = pcm.samples
            var offset = 0
            while (offset < body.size && mine == generation) {
                val wrote = open.write(body, offset, body.size - offset)
                if (wrote <= 0) break
                offset += wrote
            }
            writtenFrames += body.size / bytesPerFrameOf(pcm)

            // **次が控えているなら、鳴り終わりを待たない。**
            //
            // 待つと、そのぶん次のかたまりを書き始めるのが遅れる。
            // 口は開いたままなので、続けて書けば音は繋がる。
            if (!queue.isEmpty()) return

            // **鳴り終わるまで待つ。** 書き終えた時点ではまだ鳴っている。
            // ここで戻ると口パクが先に止まる。
            //
            // `playbackHeadPosition` は track を開いてからの通算なので、
            // 書いた合計（`writtenFrames`）と直に比べられる。
            if (mine == generation) {
                var stalled = 0
                while (mine == generation && open.playbackHeadPosition < writtenFrames) {
                    val before = open.playbackHeadPosition
                    Thread.sleep(20)
                    // 進まなくなったら諦める。**永久に待たない。**
                    if (open.playbackHeadPosition == before) {
                        stalled += 1
                        if (stalled > 25) break
                    } else {
                        stalled = 0
                    }
                    // 待っている間に次が届いたら、そちらを優先する。
                    if (!queue.isEmpty()) return
                }
            }
        } catch (_: Exception) {
            // 鳴らなくても止まらない。次の文へ進む。
        } finally {
            // **本当に鳴り終わったときだけ伏せる。**
            //
            // `playbackHeadPosition` は「デバイスに渡した位置」で、
            // スピーカーから実際に音が出るまでにはハードのバッファぶん
            // 遅れる。ここで即 false にすると、**まだ鳴っている音を
            // マイクが拾い**、追い質問として送られて話が遮られる。
            //
            // エコー消去が効くようになれば要らなくなるが、**効かなかった
            // ときの退路**でもあるので残す。
            if (queue.isEmpty()) {
                try {
                    Thread.sleep(TAIL_MS)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                }
                playing = false
                // **鳴り終わったら閉じる。** 開いたままだと、次の文まで
                // 参照の位置が繋がってしまい、エコー消去の時間合わせが
                // 合わなくなる。
                if (queue.isEmpty()) closeTrack()
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
