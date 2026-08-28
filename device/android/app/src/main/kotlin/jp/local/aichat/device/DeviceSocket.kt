package jp.local.aichat.device

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * サーバーとの1本の線。
 *
 * **判断はしない。** 音を流し、届いたものをそのまま上へ渡すだけ。
 * 状態機械はサーバーにある（device/server/src/ws/session.ts）。
 *
 * 切れたら黙って繋ぎ直す。**据え置きの機械は誰も面倒を見ない**ので、
 * WiFi が一瞬切れただけで沈黙する機械にはできない。
 */
class DeviceSocket(
    private val url: String,
    private val onEvent: (Event) -> Unit,
) {
    private val client = OkHttpClient.Builder()
        // 読み上げの WAV は数百 KB 来ることがある。短い読み取り上限だと切られる。
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var socket: WebSocket? = null
    private var closing = false
    /** 直前に「次はバイナリ」と予告があったか。 */
    private var expectAudio = false
    private var retryMs = 1_000L

    fun connect() {
        closing = false
        open()
    }

    private fun open() {
        val request = Request.Builder().url(url).build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i("aichat", "繋がりました")
                retryMs = 1_000L
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleText(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                // 予告のあとに届いたバイナリだけを音声として扱う。
                if (expectAudio) {
                    expectAudio = false
                    onEvent(Event.Audio(bytes.toByteArray()))
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                onEvent(Event.Closed)
                retry()
            }

            // **黙って落ちると切り分けができない。** 証明書・平文の禁止・
            // 名前解決の失敗はどれもここに来るが、画面には何も出ない。
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w("aichat", "繋がりません: ${t.javaClass.simpleName}: ${t.message}")
                onEvent(Event.Closed)
                retry()
            }
        })
    }

    /**
     * 繋ぎ直す。**間隔を伸ばしていく**（最大 30 秒）。
     * サーバーが落ちている間に毎秒叩き続けても意味がない。
     */
    private fun retry() {
        if (closing) return
        val wait = retryMs
        retryMs = (retryMs * 2).coerceAtMost(30_000L)
        Thread {
            Thread.sleep(wait)
            if (!closing) open()
        }.start()
    }

    private fun handleText(text: String) {
        val json = try {
            JSONObject(text)
        } catch (_: Exception) {
            return // 知らない形は読み飛ばす
        }

        when (json.optString("type")) {
            "state" -> onEvent(
                Event.StateChanged(
                    State.of(json.optString("state")),
                    json.optString("status"),
                ),
            )
            // 次に届くバイナリが読み上げの音声であることの予告。
            "audio" -> expectAudio = true
            "wake" -> onEvent(Event.Wake)
            "error" -> onEvent(Event.Failed(json.optString("message")))
            // question / answer / sources / chat / config は文字なので使わない。
            // **取り決めは変えない。** ブラウザの画面が使い続けている。
        }
    }

    /** 80ms ぶんの音。**判断せずそのまま流す。** */
    fun sendFrame(pcm: ByteArray, length: Int) {
        socket?.send(pcm.toByteString(0, length))
    }

    /**
     * ウェイクワード無しで起こす。
     *
     * **この端末からは呼んでいない。** 丸い画面でスワイプが click として
     * 拾われ、誤って起動していたため（`MainActivity.onTouch`）。
     * サーバーと `device/web` は今も受け付けるので、口は残す。
     */
    fun wake() {
        socket?.send("""{"type":"wake"}""")
    }

    /** やめる。 */
    fun cancel() {
        socket?.send("""{"type":"cancel"}""")
    }

    fun close() {
        closing = true
        socket?.close(1000, null)
        socket = null
    }
}
