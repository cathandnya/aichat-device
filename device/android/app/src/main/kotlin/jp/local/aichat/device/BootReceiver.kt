package jp.local.aichat.device

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 電源が入ったら勝手に立ち上がる。
 *
 * **キオスク運用の要**。家族が起動の操作を覚える必要が無いようにする
 * （[01-requirements] の「電源を入れれば勝手に起動する」）。
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        context.startActivity(
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}
