package jp.local.aichat.device

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.view.View

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
    var clock: String = ""
    /** 0〜1。声を受け付けている間だけ描く。 */
    var level: Float = 0f

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()

        // 夜のテーブルに置くものなので、常に暗い。
        canvas.drawColor(Color.parseColor("#0d0f14"))

        drawFace(canvas)
        drawClock(canvas, w)
        drawLevel(canvas, w, h)
        drawLamp(canvas, w, h)
    }

    /** 顔は中央に、画面の高さいっぱいに。 */
    private fun drawFace(canvas: Canvas) {
        val current = face ?: return
        val base = current.base ?: return

        val scale = (height * 0.72f) / base.height
        val drawW = (base.width * scale).toInt()
        val drawH = (base.height * scale).toInt()
        val left = (width - drawW) / 2
        val top = (height - drawH) / 2

        src.set(0, 0, base.width, base.height)
        dst.set(left, top, left + drawW, top + drawH)

        canvas.drawBitmap(base, src, dst, paint)
        current.mouth(mouth)?.let { canvas.drawBitmap(it, src, dst, paint) }
    }

    private fun drawClock(canvas: Canvas, w: Float) {
        if (state != State.IDLE || clock.isEmpty()) return
        paint.color = Color.parseColor("#8a91a0")
        paint.textSize = w * 0.13f
        paint.textAlign = Paint.Align.CENTER
        canvas.drawText(clock, w / 2f, w * 0.22f, paint)
    }

    /**
     * 声の大きさ。**届いていることの証。**
     *
     * 状態の文字だけだと、本当に音が届いているのか、黙って固まったのかが
     * 分からない。ここが動けば届いている。
     */
    private fun drawLevel(canvas: Canvas, w: Float, h: Float) {
        if (!state.hearing) return

        val full = w * 0.5f
        val length = full * level.coerceIn(0f, 0.3f) / 0.3f
        val y = h * 0.86f
        paint.style = Paint.Style.STROKE
        paint.strokeCap = Paint.Cap.ROUND
        paint.strokeWidth = w * 0.02f

        paint.color = Color.parseColor("#232733")
        canvas.drawLine(w / 2 - full / 2, y, w / 2 + full / 2, y, paint)

        if (length > 0f) {
            paint.color = lampColor() ?: HEARING_FALLBACK
            canvas.drawLine(w / 2 - full / 2, y, w / 2 - full / 2 + length, y, paint)
        }
        paint.style = Paint.Style.FILL
    }

    /**
     * 画面の縁の光。**声を受け付けている間だけ強く光る。**
     *
     * 据え置きの機械は離れた場所から見るので、文字の色が変わるだけでは
     * 気づけない。丸い画面なので、そのまま輪にする。
     */
    private fun drawLamp(canvas: Canvas, w: Float, h: Float) {
        val color = lampColor() ?: return
        val stroke = w * 0.03f
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = stroke
        paint.color = color
        canvas.drawCircle(w / 2f, h / 2f, minOf(w, h) / 2f - stroke / 2f, paint)
        paint.style = Paint.Style.FILL
    }

    private companion object {
        /** `hearing` のときは必ず色が付くが、型の上では分からないので置く。 */
        val HEARING_FALLBACK: Int = Color.parseColor("#5aa9ff")
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
