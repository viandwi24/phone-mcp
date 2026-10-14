package com.phonemcp.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Point
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import android.view.WindowManager
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * The persistent core. Holds the WebSocket to the broker, owns the
 * MediaProjection, and dispatches incoming commands to the capturer / the
 * accessibility service.
 */
class RemoteForegroundService : Service(), WsClient.Listener {

    private var wsClient: WsClient? = null
    private var projection: MediaProjection? = null
    private var capturer: ScreenCapturer? = null
    private val exec = Executors.newSingleThreadExecutor()
    @Volatile private var connected = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopEverything()
                return START_NOT_STICKY
            }
            else -> start(intent)
        }
        return START_STICKY
    }

    private fun start(intent: Intent?) {
        startForegroundNotification(getString(R.string.notification_disconnected))

        // Optional MediaProjection consent result passed from SetupActivity.
        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, Int.MIN_VALUE) ?: Int.MIN_VALUE
        val data = if (Build.VERSION.SDK_INT >= 33) {
            intent?.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent?.getParcelableExtra(EXTRA_RESULT_DATA)
        }
        if (resultCode != Int.MIN_VALUE && data != null) {
            setupProjection(resultCode, data)
        }

        val serverUrl = Prefs.serverUrl(this)
        val token = Prefs.token(this)
        if (serverUrl.isEmpty() || token.isEmpty()) {
            Log.w(TAG, "no server/token configured; idling")
            StatusBus.setState(StatusBus.State.IDLE, "no server/token configured")
            return
        }
        if (wsClient == null) {
            StatusBus.log("starting (projection=${projection != null}, a11y=${RemoteAccessibilityService.instance != null})")
            wsClient = WsClient(serverUrl, token, this).also { it.start() }
        }
    }

    private fun setupProjection(resultCode: Int, data: Intent) {
        try {
            val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val proj = mgr.getMediaProjection(resultCode, data)
            proj.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    Log.i(TAG, "projection stopped by system (per-session consent ended)")
                    capturer?.release()
                    capturer = null
                    projection = null
                }
            }, null)
            projection = proj

            val (w, h, dpi) = screenSize()
            capturer = ScreenCapturer(proj, w, h, dpi)
            Log.i(TAG, "projection ready: ${w}x$h @${dpi}dpi")
        } catch (e: Throwable) {
            Log.e(TAG, "projection setup failed: ${e.message}")
        }
    }

    private fun screenSize(): Triple<Int, Int, Int> {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val dpi = resources.displayMetrics.densityDpi
        return if (Build.VERSION.SDK_INT >= 30) {
            val b = wm.maximumWindowMetrics.bounds
            Triple(b.width(), b.height(), dpi)
        } else {
            @Suppress("DEPRECATION")
            val p = Point().also { wm.defaultDisplay.getRealSize(it) }
            Triple(p.x, p.y, dpi)
        }
    }

    // ── WsClient.Listener ───────────────────────────────────────────────────────

    override fun onOpen() {
        connected = true
        StatusBus.log("→ sending register (${Prefs.deviceId(this)})")
        sendRegister()
        updateNotification(getString(R.string.notification_connected))
    }

    override fun onClosed() {
        connected = false
        updateNotification(getString(R.string.notification_disconnected))
    }

    override fun onMessage(text: String) {
        exec.execute { handleMessage(text) }
    }

    private fun sendRegister() {
        val (w, h, _) = screenSize()
        val msg = JSONObject()
            .put("type", "register")
            .put("deviceId", Prefs.deviceId(this))
            .put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
            .put("androidVersion", Build.VERSION.SDK_INT)
            .put("screen", JSONObject().put("w", w).put("h", h))
            .put(
                "caps",
                JSONObject()
                    .put("projection", projection != null)
                    .put("accessibility", RemoteAccessibilityService.instance != null),
            )
        wsClient?.send(msg.toString())
    }

    // ── Command dispatch ──────────────────────────────────────────────────────────

    private fun handleMessage(text: String) {
        val msg = try {
            JSONObject(text)
        } catch (_: Throwable) {
            return
        }
        when (msg.optString("type")) {
            "ping" -> wsClient?.send(JSONObject().put("type", "pong").put("ts", System.currentTimeMillis()).toString())
            "registered" -> {
                Log.i(TAG, "registered with server")
                StatusBus.setState(StatusBus.State.CONNECTED, "registered as ${Prefs.deviceId(this)}")
            }
            "command" -> dispatch(msg)
        }
    }

    private fun dispatch(msg: JSONObject) {
        val reqId = msg.optString("reqId")
        val cmd = msg.optString("cmd")
        val args = msg.optJSONObject("args") ?: JSONObject()
        try {
            val data = runCommand(cmd, args)
            StatusBus.log("✓ $cmd")
            sendResult(reqId, true, data, null)
        } catch (e: Throwable) {
            Log.w(TAG, "command '$cmd' failed: ${e.message}")
            StatusBus.log("✗ $cmd — ${e.message}")
            sendResult(reqId, false, null, e.message ?: "command failed")
        }
    }

    private fun runCommand(cmd: String, args: JSONObject): JSONObject {
        val a11y = { RemoteAccessibilityService.instance ?: error("accessibility service not enabled") }
        return when (cmd) {
            "device_info" -> {
                val (w, h, _) = screenSize()
                JSONObject()
                    .put("deviceId", Prefs.deviceId(this))
                    .put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
                    .put("androidVersion", Build.VERSION.SDK_INT)
                    .put("screen", JSONObject().put("w", w).put("h", h))
                    .put(
                        "caps",
                        JSONObject()
                            .put("projection", projection != null)
                            .put("accessibility", RemoteAccessibilityService.instance != null),
                    )
            }

            "screenshot" -> {
                val cap = capturer ?: error("screen capture not granted (open the app and grant it)")
                val maxWidth = args.optInt("maxWidth", 720)
                val quality = args.optInt("quality", 80)
                val png = args.optString("format", "jpeg") == "png"
                val r = cap.capture(maxWidth, quality, png)
                JSONObject().put("image", r.base64).put("mime", r.mime).put("w", r.w).put("h", r.h)
            }

            "ui_tree" -> {
                val maxDepth = args.optInt("maxDepth", 40)
                val visibleOnly = args.optBoolean("visibleOnly", true)
                JSONObject().put("tree", a11y().dumpTree(maxDepth, visibleOnly))
            }

            "tap" -> {
                val ok = a11y().tap(args.getDouble("x").toFloat(), args.getDouble("y").toFloat())
                JSONObject().put("dispatched", ok)
            }

            "swipe" -> {
                val ok = a11y().swipe(
                    args.getDouble("x1").toFloat(), args.getDouble("y1").toFloat(),
                    args.getDouble("x2").toFloat(), args.getDouble("y2").toFloat(),
                    args.optLong("durationMs", 300),
                )
                JSONObject().put("dispatched", ok)
            }

            "long_press" -> {
                val ok = a11y().longPress(
                    args.getDouble("x").toFloat(), args.getDouble("y").toFloat(),
                    args.optLong("durationMs", 600),
                )
                JSONObject().put("dispatched", ok)
            }

            "scroll" -> {
                val (w, h, _) = screenSize()
                val cx = w / 2f
                val cy = h / 2f
                val dist = h * 0.35f
                val amount = args.optInt("amount", 1).coerceAtLeast(1)
                var ok = true
                repeat(amount) {
                    val (x1, y1, x2, y2) = when (args.optString("direction", "down")) {
                        "up" -> listOf(cx, cy - dist, cx, cy + dist)
                        "down" -> listOf(cx, cy + dist, cx, cy - dist)
                        "left" -> listOf(cx - dist, cy, cx + dist, cy)
                        "right" -> listOf(cx + dist, cy, cx - dist, cy)
                        else -> listOf(cx, cy + dist, cx, cy - dist)
                    }
                    ok = a11y().swipe(x1, y1, x2, y2, 300) && ok
                }
                JSONObject().put("dispatched", ok)
            }

            "type_text" -> JSONObject().put("ok", a11y().typeText(args.getString("text")))

            "click_node" -> {
                val ok = a11y().clickNode(
                    args.optStringOrNull("viewId"),
                    args.optStringOrNull("text"),
                    args.optInt("index", 0),
                )
                JSONObject().put("clicked", ok)
            }

            "open_url" -> {
                LaunchBridgeActivity.start(this, args.getString("url"), args.optStringOrNull("package"))
                JSONObject().put("launched", true)
            }

            "global_action" -> JSONObject().put("ok", a11y().globalAction(args.getString("action")))

            else -> error("unknown command: $cmd")
        }
    }

    private fun sendResult(reqId: String, ok: Boolean, data: JSONObject?, error: String?) {
        val msg = JSONObject().put("type", "result").put("reqId", reqId).put("ok", ok)
        if (data != null) msg.put("data", data)
        if (error != null) msg.put("error", error)
        wsClient?.send(msg.toString())
    }

    // ── Notification ──────────────────────────────────────────────────────────────

    private fun startForegroundNotification(text: String) {
        val channelId = ensureChannel()
        val tap = PendingIntent.getActivity(
            this, 0, Intent(this, SetupActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n: Notification = Notification.Builder(this, channelId)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .setContentIntent(tap)
            .build()

        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIF_ID, n)
        }
    }

    private fun updateNotification(text: String) {
        val channelId = ensureChannel()
        val n = Notification.Builder(this, channelId)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .build()
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIF_ID, n)
    }

    private fun ensureChannel(): String {
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
            mgr.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.notification_channel_name),
                    NotificationManager.IMPORTANCE_LOW,
                ),
            )
        }
        return CHANNEL_ID
    }

    private fun stopEverything() {
        wsClient?.stop()
        wsClient = null
        capturer?.release()
        capturer = null
        try {
            projection?.stop()
        } catch (_: Throwable) {
        }
        projection = null
        StatusBus.setState(StatusBus.State.IDLE, "stopped")
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        exec.shutdownNow()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "FgService"
        private const val CHANNEL_ID = "phone_mcp_remote"
        private const val NOTIF_ID = 1001
        const val ACTION_START = "com.phonemcp.agent.START"
        const val ACTION_STOP = "com.phonemcp.agent.STOP"
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_RESULT_DATA = "result_data"
    }
}

private fun JSONObject.optStringOrNull(key: String): String? =
    if (has(key) && !isNull(key)) optString(key) else null
