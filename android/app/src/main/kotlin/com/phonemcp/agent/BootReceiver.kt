package com.phonemcp.agent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Best-effort restart of the service after reboot so the WebSocket + gesture
 * capabilities come back without opening the app. Screen capture still needs a
 * fresh per-session consent (MediaProjection cannot be restored silently), so
 * screenshots stay unavailable until the user re-grants from the app.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (Prefs.serverUrl(context).isEmpty() || Prefs.token(context).isEmpty()) return
        try {
            val i = Intent(context, RemoteForegroundService::class.java).apply {
                action = RemoteForegroundService.ACTION_START
            }
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i) else context.startService(i)
        } catch (e: Throwable) {
            // Some OEMs / Android 14+ background-start rules may block this; it's best effort.
            Log.w("BootReceiver", "auto-start blocked: ${e.message}")
        }
    }
}
