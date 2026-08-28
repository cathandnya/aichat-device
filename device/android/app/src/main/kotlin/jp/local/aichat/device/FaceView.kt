package jp.local.aichat.device

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.view.View
import kotlin.math.cos
import kotlin.math.sin

/**
 * 画面そのもの。**顔・縁の光・声の大きさ・時計だけ。**
 *
 * 文字（質問と回答）は出さない。2.5インチの丸に出しても離れたら読めない。
 * 内容は声で聞く。
 *
 * 1枚の View に全部描くのは、丸い画面で**四隅を使えない**ため。
 * 部品を並べるより、中心からの距離で置くほうが素直になる。
 */
class FaceView(context: Context) : View(context) {

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val src = Rect()
    private val dst = Rect()

    var face: Face? = null
    var state: State = State.IDLE
    var mouth: Int = Face.CLOSED
    /** 時計の針の位置。**分・秒は連続値**なので、針が滑らかに進む。 */
    var hour: Float = 0f
    var minute: Float = 0f
    var second: Float = 0f
    /** 0〜1 の実効音量。**輪の太さに出る。** */
    var level: Float = 0f

    /**
     * キャラクターの登場ぐあい。0=画面の外、1=定位置。
     *
     * **1 を超える**ことがある（バネで行き過ぎて戻る）。描画側は
     * それを前提にする。
     */
    var appear: Float = 0f
    /** まばたき。 */
    var eyeClosed: Boolean = false
    /** いまの表情。サーバーからタグで届く想定（docs/08）。 */
    var emotion: Emotion = Emotion.NEUTRAL

    /** 時計の濃さ。`appear` と入れ替わりで薄くなる。 */
    private var clockAlpha: Int = 255

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()

        // 夜のテーブルに置くものなので、常に暗い。
        // **真っ黒にする。** 丸い画面なので、縁のベゼルと地続きに見える。
        canvas.drawColor(Color.BLACK)

        drawFace(canvas)
        drawClock(canvas, w, h)
        drawLamp(canvas, w, h)
    }

    /**
     * 顔。**画面いっぱいに、土台・目・口の順で重ねる。**
     *
     * 絵は 480x480 の画面に合わせて描かれているので、拡大縮小せず
     * そのまま貼る。3 枚とも同じ座標系なので、位置合わせは要らない。
     *
     * `appear` が 1 未満のときは下から出てくる途中。**下へずらして描く**。
     */
    private fun drawFace(canvas: Canvas) {
        if (appear <= 0f) return
        val current = face ?: return
        val base = current.base(emotion) ?: return

        src.set(0, 0, base.width, base.height)
        dst.set(0, 0, width, height)

        val saved = canvas.save()
        // 画面の高さぶん下から上がってくる。
        canvas.translate(0f, height * (1f - appear))
        // 出かかりは薄く。**下端で唐突に現れるのを防ぐ。**
        paint.alpha = (255 * appear.coerceIn(0f, 1f)).toInt()

        canvas.drawBitmap(base, src, dst, paint)
        current.eye(emotion, eyeClosed)?.let { canvas.drawBitmap(it, src, dst, paint) }
        current.mouth(mouth)?.let { canvas.drawBitmap(it, src, dst, paint) }

        paint.alpha = 255
        canvas.restoreToCount(saved)
    }

    /**
     * 待受中のアナログ時計。**目盛りと針だけ。**
     *
     * 丸い画面なので、文字盤も丸のまま使う。数字は 12・3・6・9 の
     * 4 つだけ置く。全部並べると 2.5 インチでは潰れるうえ、
     * **顔と重なって読めなくなる**。
     *
     * 針は中心から外へ引く。顔の上に乗るので、色は控えめにして
     * 立ち絵を殺さないようにする。
     */
    private fun drawClock(canvas: Canvas, w: Float, h: Float) {
        // **キャラクターと入れ替わりで消える。** 状態で切ると、
        // 顔が出てくる途中に時計が瞬間で消えて雑に見える。
        val fade = (1f - appear).coerceIn(0f, 1f)
        if (fade <= 0.01f) return
        clockAlpha = (255 * fade).toInt()

        val cx = w / 2f
        val cy = h / 2f
        val radius = minOf(w, h) / 2f

        drawTicks(canvas, cx, cy, radius, w)
        drawNumerals(canvas, cx, cy, radius, w)

        // 短針。**分ぶんだけ進める。** 3時ちょうどと3時59分で同じ位置に
        // 見えると、時計として読めない。
        drawHand(
            canvas, cx, cy,
            angle = (hour % 12f) / 12f * 360f + minute / 60f * 30f,
            length = radius * 0.48f,
            width = w * 0.030f,
            color = Color.parseColor("#c3cad8"),
        )
        // 長針。**目盛りの少し内側まで伸ばす。**
        drawHand(
            canvas, cx, cy,
            angle = minute / 60f * 360f,
            length = radius * 0.70f,
            width = w * 0.020f,
            color = Color.parseColor("#c3cad8"),
        )
        // 秒針。**細く、色を変える。** 同じ色だと、離れて見たときに
        // どれが分針か分からなくなる。
        drawHand(
            canvas, cx, cy,
            angle = second / 60f * 360f,
            length = radius * 0.78f,
            width = w * 0.009f,
            color = SECOND_HAND,
        )

        // 中心の軸。針の付け根を隠す。
        // 秒針の色を内側に重ねて、秒針が軸から生えて見えるようにする。
        paint.style = Paint.Style.FILL
        paint.color = Color.parseColor("#c3cad8")
        paint.alpha = clockAlpha
        canvas.drawCircle(cx, cy, w * 0.018f, paint)
        paint.color = SECOND_HAND
        paint.alpha = clockAlpha
        canvas.drawCircle(cx, cy, w * 0.008f, paint)
        paint.alpha = 255
    }

    /**
     * 5 分ごとの目盛り。**分目盛りは打たない。**
     *
     * 2.5 インチに 60 本並べると、離れて見たとき粒がにじんで
     * 輪郭がぼやける。時刻を読むのに要るのは 5 分の刻みだけ。
     */
    private fun drawTicks(canvas: Canvas, cx: Float, cy: Float, radius: Float, w: Float) {
        paint.style = Paint.Style.STROKE
        paint.strokeCap = Paint.Cap.ROUND
        paint.strokeWidth = w * 0.014f
        paint.color = TICK_MAJOR
        paint.alpha = clockAlpha

        for (i in 0 until 12) {
            // 12・3・6・9 は数字を置くので、目盛りは打たない。
            if (i % 3 == 0) continue

            val radian = Math.toRadians((i * 30f - 90f).toDouble())
            val cos = cos(radian).toFloat()
            val sin = sin(radian).toFloat()

            val outer = radius - w * 0.045f
            val inner = outer - w * 0.055f

            canvas.drawLine(
                cx + cos * inner, cy + sin * inner,
                cx + cos * outer, cy + sin * outer,
                paint,
            )
        }
        paint.alpha = 255
        paint.style = Paint.Style.FILL
    }

    /** 12・3・6・9 だけ。**縁に寄せて顔を避ける。** */
    private fun drawNumerals(canvas: Canvas, cx: Float, cy: Float, radius: Float, w: Float) {
        paint.color = TICK_MAJOR
        paint.alpha = clockAlpha
        paint.textSize = w * 0.126f
        paint.textAlign = Paint.Align.CENTER
        paint.isFakeBoldText = true

        val at = radius - w * 0.095f
        for ((index, label) in NUMERALS) {
            val radian = Math.toRadians((index * 30f - 90f).toDouble())
            val x = cx + cos(radian).toFloat() * at
            val y = cy + sin(radian).toFloat() * at
            // drawText の y は baseline なので、字の高さの半分だけ下げて
            // 中心に載せる。
            canvas.drawText(label, x, y - (paint.ascent() + paint.descent()) / 2f, paint)
        }
        paint.isFakeBoldText = false
        paint.alpha = 255
    }

    private fun drawHand(
        canvas: Canvas,
        cx: Float,
        cy: Float,
        angle: Float,
        length: Float,
        width: Float,
        color: Int,
    ) {
        val radian = Math.toRadians((angle - 90f).toDouble())
        val cos = cos(radian).toFloat()
        val sin = sin(radian).toFloat()

        paint.style = Paint.Style.STROKE
        paint.strokeCap = Paint.Cap.ROUND
        paint.strokeWidth = width
        paint.color = color
        paint.alpha = clockAlpha
        // 少しだけ後ろへ伸ばすと、軸に刺さって見える。
        canvas.drawLine(
            cx - cos * length * 0.12f, cy - sin * length * 0.12f,
            cx + cos * length, cy + sin * length,
            paint,
        )
        paint.alpha = 255
        paint.style = Paint.Style.FILL
    }

    /**
     * 画面の縁の光。**色は状態、太さは声の大きさ。**
     *
     * 据え置きの機械は離れた場所から見るので、文字の色が変わるだけでは
     * 気づけない。丸い画面なので、そのまま輪にする。
     *
     * **声の大きさもここで出す。** 「届いていることの証」——状態の色だけ
     * だと、本当に音が届いているのか、黙って固まったのかが分からない。
     * ここが動けば届いている。
     */
    private fun drawLamp(canvas: Canvas, w: Float, h: Float) {
        val color = lampColor() ?: return

        // **色は状態のもの。声の大きさは太さだけで出す。**
        //
        // 色にも混ぜると、状態の見分け（青＝聞いている／緑＝続けてどうぞ）が
        // 音量で濁る。色は状態、太さは音量、と役割を分ける。
        //
        // 以前は画面の下に棒を引いていたが、**丸い画面では下に寄せるほど
        // 幅が取れず**、離れて見ると動いているのが分からなかった。
        // 縁は一番長く取れる場所。
        val loud = if (state.hearing) (level / LEVEL_FULL).coerceIn(0f, 1f) else 0f
        val stroke = w * (0.03f + 0.045f * loud)

        paint.style = Paint.Style.STROKE
        paint.strokeWidth = stroke
        paint.color = color
        canvas.drawCircle(w / 2f, h / 2f, minOf(w, h) / 2f - stroke / 2f, paint)
        paint.style = Paint.Style.FILL
    }

    private companion object {
        /**
         * 輪が振り切る音量。
         *
         * **実測から決めた。** 端末側で 4 倍に持ち上げたあとの値で、
         * 普通の話し声が rms 0.03 ほど、暗騒音が 0.004 ほど。
         * 以前は 0.3 にしていたので、話しても 1 割しか動かなかった。
         */
        const val LEVEL_FULL = 0.06f


        val TICK_MAJOR: Int = Color.parseColor("#8a91a0")
        val SECOND_HAND: Int = Color.parseColor("#c96a5a")

        /** 置くのは 12・3・6・9 だけ。添字は 12 分割の位置。 */
        val NUMERALS = listOf(0 to "12", 3 to "3", 6 to "6", 9 to "9")
    }

    private fun lampColor(): Int? = when (state) {
        State.IDLE -> null
        State.LISTENING -> Color.parseColor("#5aa9ff")
        State.FOLLOWING -> Color.parseColor("#6ee7a8")
        State.THINKING -> Color.parseColor("#3a4152")
        State.SPEAKING -> Color.parseColor("#2b4f7a")
        State.ERROR -> Color.parseColor("#ff6b6b")
    }
}
