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
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

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
    private var face: Face? = null

    private val ui = Handler(Looper.getMainLooper())
    private var sounds: SoundPool? = null
    private var wakeSound = 0
    private var mouthStep = 0

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

        player = AudioPlayer().also { it.start() }
        prepareSounds()

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MIC)
        } else {
            start()
        }

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
            mic = MicStream { frame, length -> device.sendFrame(frame, length) }
                .also { it.open() }
            Log.i(TAG, "エコーキャンセル: ${mic?.aecEnabled}")
        } catch (e: Exception) {
            Log.e(TAG, "マイクを開けませんでした", e)
        }
    }

    /**
     * 繋ぎ先。既定は `pino.local`。
     *
     * 焼き込まずに置いておくのは、家のサーバーの名前が変わっても
     * ビルドし直さずに済むようにするため。
     *
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

    private fun onEvent(event: Event) {
        when (event) {
            is Event.StateChanged -> {
                view.state = event.state
                view.invalidate()
            }
            // **気づいたことをすぐ返す。** 聞き取りが始まるまで無反応だと、
            // 呼んだ人はもう一度呼んでしまう。
            Event.Wake -> sounds?.play(wakeSound, 1f, 1f, 1, 0, 1f)
            is Event.Audio -> player.enqueue(event.wav)
            is Event.Failed -> Log.w(TAG, "サーバー: ${event.message}")
            Event.Closed -> {
                view.state = State.IDLE
                view.invalidate()
            }
        }
    }

    /** 画面を触った。話している最中なら「やめる」、そうでなければ起こす。 */
    private fun onTouch() {
        val busy = view.state != State.IDLE && view.state != State.ERROR
        if (busy) {
            player.cancel()
            socket?.cancel()
        } else {
            socket?.wake()
        }
    }

    /**
     * 画面の更新。**口パクに合わせて 120ms ごと**に回す。
     *
     * 口を動かすのは**実際に音が鳴っている間だけ**。サーバーの `speaking` では
     * 両側にずれる（合成の待ちぶん早く立ち、送り終えた時点で降りる）。
     */
    private fun tick() {
        val speaking = player.playing
        mouthStep = if (speaking) (mouthStep + 1) % Face.PATTERN.size else 0
        view.mouth = if (speaking) Face.PATTERN[mouthStep] else Face.CLOSED
        view.level = mic?.level ?: 0f
        view.clock = CLOCK.format(Date())
        view.invalidate()

        ui.postDelayed({ tick() }, Face.INTERVAL_MS)
    }

    private fun prepareSounds() {
        sounds = SoundPool.Builder()
            .setMaxStreams(2)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            .build()
        wakeSound = sounds?.load(this, R.raw.wake, 1) ?: 0

        // 読み上げが聞こえる大きさで出す。
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
        val CLOCK = SimpleDateFormat("HH:mm", Locale.JAPAN)
    }
}
