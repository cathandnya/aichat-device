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
            .setBufferSizeInBytes(maxOf(minimum, pcm.samples.size.coerceAtMost(minimum * 4)))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()

        try {
            playing = true
            // **参照は `write()` より先に積む。**
            //
            // `write()` はバッファが空くまでブロックする（数百 ms あり得る）。
            // 後に積むと、その間マイク側が参照を引けず、消さないまま
            // 素通しになる。**鳴り始めが一番消したい所**なので順序が要る。
            //
            // **積んでから track を渡す。** マイク側は `progress()` ではなく
            // この track から直に再生位置を読む（下記）。
            reference?.beginTrack()
            reference?.push(pcm)
            reference?.attach(track, pcm.sampleRate)
            track.play()
            var offset = 0
            while (offset < pcm.samples.size && mine == generation) {
                val wrote = track.write(pcm.samples, offset, pcm.samples.size - offset)
                if (wrote <= 0) break
                offset += wrote
            }
            // **鳴り終わるまで待つ。** 書き終えた時点ではまだ鳴っている。
            // ここで戻ると口パクが先に止まる。
            //
            // **`stop()` してから `playState` を見てはいけない。** `stop()` の
            // 直後に状態は STOPPED になるので、待ちが素通りして `release()` が
            // 未再生ぶんを捨ててしまう（**読み上げの最後が切れる**）。
            // MODE_STREAM では再生位置が書いた長さに追いつくまで数える。
            if (mine == generation) {
                // **フレーム数で数える。** playbackHeadPosition はサンプル数
                // ではなくフレーム数を返すので、ステレオでは半分になる。
                //
                // **`samples` はバイト列。** 16bit なので 1 サンプル 2 バイト、
                // 1 フレームは 2×チャンネル数バイト。ここを割り忘れると
                // フレーム数が 2 倍過大になり、**再生位置が永遠に届かず**
                // 下の `stalled` 側（約 500ms）で抜けることになる。
                // `TAIL_MS` と合わさって尻切れはしていなかったが、
                // **AEC は再生位置で時間を合わせる**ので、ここが正確でないと
                // 遅延推定が丸ごとずれる。
                val bytesPerFrame = 2 * maxOf(1, pcm.channels)
                val total = pcm.samples.size / bytesPerFrame
                var stalled = 0
                while (mine == generation && track.playbackHeadPosition < total) {
                    val before = track.playbackHeadPosition
                    Thread.sleep(20)
                    // 進まなくなったら諦める。**永久に待たない。**
                    if (track.playbackHeadPosition == before) {
                        stalled += 1
                        if (stalled > 25) break
                    } else {
                        stalled = 0
                    }
                }
                track.stop()
            }
        } catch (_: Exception) {
            // 鳴らなくても止まらない。次の文へ進む。
        } finally {
            // **実際に鳴った長さを控えてから解放する。**
            //
            // `release()` の後では読めない。途中でやめたとき（`cancel`）は
            // 積んだぶんより短くなるので、その差を参照から捨てる必要がある。
            // 捨てないと、鳴っていない音を「鳴った」ことにして引くので
            // フィルタが壊れる。**やめる操作は実装済みなので必ず起きる。**
            val played = try {
                track.playbackHeadPosition
            } catch (_: Exception) {
                0
            }
            reference?.endTrack(played)
            reference?.detach()

            // **鳴り終わってからも少し伏せておく。**
            //
            // `playbackHeadPosition` は「デバイスに渡した位置」で、
            // スピーカーから実際に音が出るまでにはハードのバッファぶん
            // 遅れる。ここで即 false にすると、**まだ鳴っている音を
            // マイクが拾い**、追い質問として送られて話が遮られる。
            //
            // エコー消去が効くようになれば要らなくなるが、**効かなかった
            // ときの退路**でもあるので残す。
            //
            // ★ **次が控えているなら伏せない。** サーバーは 1 文を
            // 500ms ずつに刻んで送るので、かたまりごとに 350ms 待つと
            // **文の途中に沈黙が入る**（3 秒の文で 2 秒ぶん）。
            // 伏せたいのは「本当に鳴り終わったあと」だけ。
            if (queue.isEmpty()) {
                try {
                    Thread.sleep(TAIL_MS)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                }
            }
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
