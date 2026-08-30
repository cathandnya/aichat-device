package jp.local.aichat.device

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.SoundPool
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.app.Activity
import java.util.Calendar

/**
 * 据え置きの画面。**顔と声だけ。**
 *
 * 判断はすべて Mac のサーバーが持つ（ウェイクワードの判定・音声認識・
 * AI・読み上げ）。ここは「マイクを送る・音を鳴らす・顔を出す」だけで、
 * **状態機械を持たない**。届いた状態をそのまま映す。
 *
 * ブラウザ版（device/web）を実機に載せる案もあったが、
 * - `getUserMedia` に secure context（HTTPS）が要る
 * - キオスク化（全画面・自動起動・スリープ抑止）に別のアプリが要る
 * - エコーキャンセルをこちらから明示できない
 * の3つが消えるので、ネイティブにした。ブラウザ版は手元で内容を読む画面として残る。
 */
class MainActivity : Activity() {

    private lateinit var view: FaceView
    private lateinit var player: AudioPlayer
    private var socket: DeviceSocket? = null
    private var mic: MicStream? = null

    /**
     * 鳴らした音の控え。**再生側が積み、マイク側が引く。**
     *
     * 両方が同じ 1 つを見る必要があるのでここに置く。
     */
    private val echo = EchoReference()
    private var face: Face? = null

    private val ui = Handler(Looper.getMainLooper())
    private var sounds: SoundPool? = null
    private var wakeSound = 0
    private var mouthStep = 0

    /** 登場の位置と速度。バネで動かす。0=画面の外、1=定位置。 */
    private var appear = 0f
    private var appearVelocity = 0f

    /** まばたき。次に閉じる時刻と、閉じ終わる時刻（`uptimeMillis`）。 */
    private var blinkAt = 0L
    private var blinkUntil = 0L

    /** `--es mock` で差し込んだ状態。**入っている間はサーバーに従わない。** */
    private var mockState: State? = null
    private var mockSpeaking = false
    /** 直前も鳴っていたか。鳴り終わりの瞬間を捉えるのに使う。 */
    private var wasSpeaking = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // **画面を消さない。** 据え置きの機械が寝ると、話しかけても何も起きない。
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setShowWhenLocked(true)

        view = FaceView(this)
        view.setOnClickListener { onTouch() }
        setContentView(view)
        hideSystemBars()

        face = Face(this)
        view.face = face
        if (face?.usable != true) {
            Log.w(TAG, "立ち絵がありません。顔は出ませんが声は動きます。")
        }

        // 表情の切り替えは**鳴らし始める端末側**で行う（AudioPlayer 参照）。
        player = AudioPlayer(
            reference = echo,
            onStart = { emotion ->
                ui.post {
                    if (mockState == null) {
                        view.emotion = emotion
                        view.invalidate()
                    }
                }
            },
            // **鳴り終わりは端末が知っている。** サーバーの計算値ではずれる。
            onDrained = { ui.post { socket?.spoken() } },
        ).also { it.start() }
        prepareSounds()

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MIC)
        } else {
            start()
        }

        applyMock(intent?.getStringExtra("mock"), intent?.getStringExtra("emotion"))
        tick()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        if (requestCode == REQUEST_MIC &&
            grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        ) {
            start()
        }
    }

    /** 繋いで、マイクを開く。**開いている間ずっと流し続ける。** */
    private fun start() {
        val url = "${serverUrl()}?device=${DeviceId.of(this)}"
        Log.i(TAG, "繋ぎます: $url")

        val device = DeviceSocket(url) { event -> ui.post { onEvent(event) } }
        socket = device
        device.connect()

        try {
            mic = MicStream(
                onFrame = { frame, length ->
                    // ★ **ここが「エコー消去を信用するか」の唯一のスイッチ。**
                    //
                    // 元は `if (!player.playing)` だけだった。この端末は
                    // ハードのエコー消去を持たない（`aecEnabled` は false、
                    // `0 Effect Chains`）ので、鳴らしている間に送ると
                    // スピーカーの音がそのまま戻り、**自分の声で自分が起動する**。
                    //
                    // ソフトで消せているときだけ、鳴っている間も送る。
                    // `Aec.ready` は収束前と効きが落ちたときに自分で false に
                    // 戻るので、**駄目なら放っておいても元の挙動に戻る**。
                    if (!player.playing || (aecAllowed && mic?.aec?.ready == true)) {
                        device.sendFrame(frame, length)
                    } else if (aecProbe) {
                        // **測るためだけに送る。**
                        //
                        // 消去が効いているかは「読み上げ中に自分の声が
                        // 文字になるか」でしか分からない。サーバー側は
                        // `AICHAT_AEC_PROBE=1` のとき、読み上げ中の音を
                        // **書き起こすだけで起動はしない**ので、ここで
                        // 送っても本番の挙動は変わらない。
                        device.sendFrame(frame, length)
                    }
                },
                reference = echo,
            ).also { it.open() }
            Log.i(TAG, "エコーキャンセル: ハード=${mic?.aecEnabled} ソフト=${Aec.ENABLED}")
        } catch (e: Exception) {
            Log.e(TAG, "マイクを開けませんでした", e)
        }
    }

    /**
     * 繋ぎ先。既定は `DEFAULT_SERVER`。
     *
     * 焼き込まずに置いておくのは、家のサーバーが引っ越しても
     * ビルドし直さずに済むようにするため。
     *
     *     adb shell am force-stop jp.local.aichat.device
     *     adb shell am start -n jp.local.aichat.device/.MainActivity \
     *       --es server "ws://192.168.1.10:9801/ws"
     */
    private fun serverUrl(): String {
        val prefs = getSharedPreferences("aichat-device", Context.MODE_PRIVATE)
        intent?.getStringExtra("server")?.let {
            prefs.edit().putString("server", it).apply()
        }
        return prefs.getString("server", DEFAULT_SERVER) ?: DEFAULT_SERVER
    }

    /**
     * エコー消去を信用してよいか。**実行時の退路。**
     *
     * 効かないときに再ビルドせず実機で切り分けられるようにしてある。
     * `serverUrl()` と同じで、一度渡せば覚える。
     *
     *     adb shell am force-stop jp.local.aichat.device
     *     adb shell am start -n jp.local.aichat.device/.MainActivity \
     *       --es aec off
     *
     * `off` 以外（`on` など）を渡せば戻る。
     */
    /**
     * 測定のためだけに、読み上げ中も送るか。**既定は false。**
     *
     *     adb shell am start -n jp.local.aichat.device/.MainActivity \
     *       --es aecprobe on
     *
     * 起動するかどうかはサーバー側が決める（`AICHAT_AEC_PROBE=1` でも
     * 書き起こすだけ）。**段階 4 の判定に使い、済んだら off に戻す。**
     */
    private val aecProbe: Boolean by lazy {
        val prefs = getSharedPreferences("aichat-device", Context.MODE_PRIVATE)
        intent?.getStringExtra("aecprobe")?.let {
            prefs.edit().putBoolean("aecprobe", it != "off").apply()
        }
        prefs.getBoolean("aecprobe", false)
    }

    private val aecAllowed: Boolean by lazy {
        val prefs = getSharedPreferences("aichat-device", Context.MODE_PRIVATE)
        intent?.getStringExtra("aec")?.let {
            prefs.edit().putBoolean("aec", it != "off").apply()
        }
        prefs.getBoolean("aec", true)
    }

    /**
     * 見た目だけを試すための口。**サーバーを介さず状態を差し込む。**
     *
     *     adb shell am start -n jp.local.aichat.device/.MainActivity \
     *       --es mock speaking --es emotion happy
     *
     * 登場やまばたきを見るのに、いちいち話しかけて音声認識を通すのは
     * 手間がかかる（実際に「ずんだもん」が「値段もん」と聞こえて
     * 発火しないこともある）。`--es mock` で直に切り替えられるようにする。
     *
     * **`speaking` を渡すと口も動く。** 音は鳴らないが、パラパラの
     * 見え方はこれで確かめられる。`--es emotion` は表情。
     */
    private fun applyMock(name: String?, emotion: String?) {
        mockState = name?.let { State.of(it) }
        mockSpeaking = name == "speaking"
        emotion?.let {
            view.emotion = Emotion.of(it)
            Log.i(TAG, "mock emotion: ${view.emotion}")
        }
        mockState?.let {
            view.state = it
            Log.i(TAG, "mock: $it")
        }
        view.invalidate()
    }

    private fun onEvent(event: Event) {
        // mock 中はサーバーの状態・表情で上書きしない。
        if (mockState != null && (event is Event.StateChanged || event is Event.EmotionChanged)) {
            return
        }
        when (event) {
            is Event.StateChanged -> {
                view.state = event.state
                view.invalidate()
            }
            // **気づいたことをすぐ返す。** 聞き取りが始まるまで無反応だと、
            // 呼んだ人はもう一度呼んでしまう。
            // 音が無ければ鳴らさない（読み込みに失敗すると 0 が返る）。
            Event.Wake -> if (wakeSound != 0) sounds?.play(wakeSound, 1f, 1f, 1, 0, 1f)
            is Event.EmotionChanged -> {
                view.emotion = event.emotion
                view.invalidate()
            }
            is Event.Audio -> player.enqueue(event.wav, event.emotion)
            Event.SpeechEnd -> player.end()
            is Event.Failed -> Log.w(TAG, "サーバー: ${event.message}")
            Event.Closed -> {
                view.state = State.IDLE
                view.invalidate()
            }
        }
    }

    /**
     * 画面を触った。**話している最中に「やめる」だけ。**
     *
     * 待受中に触っても起こさない。丸い 2.5 インチだと、上から下への
     * スワイプ（通知を出す動き）が View の click として拾われ、
     * **喋っていないのに起動していた**。指を少し動かしても、
     * タッチスロープの内側なら click になる。
     *
     * 起こすのはウェイクワードに任せる。止めるほうは、長い読み上げを
     * 黙らせる手段が他に無いので残す。
     */
    private fun onTouch() {
        val busy = view.state != State.IDLE && view.state != State.ERROR
        if (busy) {
            player.cancel()
            socket?.cancel()
        }
    }

    /**
     * 画面の更新。**口パクに合わせて 120ms ごと**に回す。
     *
     * 口を動かすのは**実際に音が鳴っている間だけ**。サーバーの `speaking` では
     * 両側にずれる（合成の待ちぶん早く立ち、送り終えた時点で降りる）。
     */
    private fun tick() {
        val speaking = player.playing || mockSpeaking
        mouthStep = if (speaking) (mouthStep + 1) % Face.PATTERN.size else 0
        view.mouth = if (speaking) Face.PATTERN[mouthStep] else Face.CLOSED

        // **鳴り終わったら素の顔に戻す。** 最後の文の表情のまま固まると、
        // 怒った顔や悲しい顔で待ち続けることになる。
        // mock 中は差し込んだ表情を見たいので戻さない。
        if (wasSpeaking && !speaking && mockState == null) {
            view.emotion = Emotion.NEUTRAL
        }
        wasSpeaking = speaking
        view.level = mic?.level ?: 0f
        val now = Calendar.getInstance()
        // **秒針は 1 秒ごとに刻む。** ミリ秒を混ぜると滑って動くが、
        // 時計としては 1 目盛りずつ跳ぶほうが読みやすい。
        val second = now.get(Calendar.SECOND).toFloat()
        view.hour = now.get(Calendar.HOUR).toFloat()
        view.minute = now.get(Calendar.MINUTE) + second / 60f
        view.second = second

        stepAppear()
        stepBlink()
        view.invalidate()

        ui.postDelayed({ tick() }, Face.INTERVAL_MS)
    }

    /**
     * 登場をバネで動かす。
     *
     * **行き過ぎて戻る**ので、`appear` は 1 を超えることがある。
     * 単なる補間だとぬるっと出るだけで、呼びかけに応えて跳ね起きる
     * 感じにならない。
     *
     * 待受に戻るときはバネを使わず、まっすぐ引っ込める。跳ねながら
     * 消えると未練がましく見える。
     */
    private fun stepAppear() {
        val target = if (view.state == State.IDLE) 0f else 1f
        val dt = Face.INTERVAL_MS / 1000f

        if (target == 1f) {
            // ばね（減衰つき）。
            //
            // **硬さは刻みの粗さに縛られる。** 120ms ごとの計算なので、
            // stiffness * dt^2 が 1 を超えると積分が発散する。実際に
            // 170 で試したら appear が 1 フレームごとに桁を増やし、
            // 4 億まで飛んで顔が画面の外へ消えた。
            val stiffness = 40f
            val damping = 9f
            val accel = (target - appear) * stiffness - appearVelocity * damping
            appearVelocity += accel * dt
            appear += appearVelocity * dt
            // 念のため。ここが壊れると顔ごと消えて原因が分かりにくい。
            appear = appear.coerceIn(0f, 1.5f)
        } else {
            // 引っ込むときは素直に。跳ねながら消えると未練がましい。
            appearVelocity = 0f
            appear += (target - appear) * 0.35f
        }

        if (target == 0f && appear < 0.001f) {
            appear = 0f
            appearVelocity = 0f
        }
        view.appear = appear
    }

    /**
     * まばたき。**間隔をばらつかせる。**
     *
     * 等間隔だと機械が点滅しているように見える。閉じている時間は
     * 短く保つ（長いと眠そうになる）。
     */
    private fun stepBlink() {
        val now = android.os.SystemClock.uptimeMillis()
        if (blinkAt == 0L) blinkAt = now + nextBlinkDelay()

        if (now >= blinkAt) {
            blinkUntil = now + Face.BLINK_MS
            blinkAt = now + nextBlinkDelay()
        }
        view.eyeClosed = now < blinkUntil
    }

    private fun nextBlinkDelay(): Long =
        Face.BLINK_MIN_MS + (Math.random() * (Face.BLINK_MAX_MS - Face.BLINK_MIN_MS)).toLong()

    private fun prepareSounds() {
        sounds = SoundPool.Builder()
            .setMaxStreams(2)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            .build()
        // **assets から読む。** `R.raw.*` はコンパイル時に解決されるので、
        // 音を git に置かない方針だと**ビルドごと通らなくなる**
        // （立ち絵と同じ理由。device/android/README.md）。
        // 無ければ鳴らないだけで、会話はそのまま動く。
        wakeSound = try {
            assets.openFd("wake.mp3").use { sounds?.load(it, 1) ?: 0 }
        } catch (_: Exception) {
            Log.w(TAG, "起動音がありません。鳴りませんが会話は動きます。")
            0
        }

        // **音量ボタンを読み上げに向ける。**
        // これが無いと、鳴っていないストリームの音量が動くだけで
        // 「音量が変えられない」になる。
        volumeControlStream = AudioManager.STREAM_MUSIC

        (getSystemService(Context.AUDIO_SERVICE) as? AudioManager)?.mode =
            AudioManager.MODE_NORMAL
    }

    private fun hideSystemBars() {
        @Suppress("DEPRECATION")
        view.systemUiVisibility =
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    override fun onDestroy() {
        super.onDestroy()
        ui.removeCallbacksAndMessages(null)
        mic?.close()
        socket?.close()
        player.close()
        sounds?.release()
    }

    private companion object {
        const val TAG = "aichat"
        const val REQUEST_MIC = 1
        /**
         * **IP で書く。`.local` は使えない。**
         *
         * Android は mDNS をアプリの層（`NsdManager`）にしか持たないので、
         * `InetAddress` 経由で引く OkHttp からは `pino.local` が解決できない
         * （API 30 の実機で確認）。名前で書いておくと、アプリのデータを
         * 消したときに既定へ戻って**繋がらない機械**になる。
         *
         * 引っ越したら `--es server` で上書きする（SharedPreferences に残る）。
         */
        const val DEFAULT_SERVER = "ws://192.168.1.2:9801/ws"
    }
}
