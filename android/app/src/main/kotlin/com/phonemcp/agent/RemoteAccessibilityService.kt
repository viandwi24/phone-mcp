package com.phonemcp.agent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.annotation.RequiresApi
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The AccessibilityService: reads the UI tree and performs gestures / node
 * actions. Its lifecycle is owned by the OS (user enables it in Settings), so
 * it publishes a static [instance] the foreground service calls into.
 */
class RemoteAccessibilityService : AccessibilityService() {

    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(TAG, "accessibility connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) { /* not needed */ }

    override fun onInterrupt() {}

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        if (instance === this) instance = null
        return super.onUnbind(intent)
    }

    // ── UI tree ───────────────────────────────────────────────────────────────

    fun dumpTree(maxDepth: Int, visibleOnly: Boolean): JSONObject {
        val root = rootInActiveWindow
            ?: return JSONObject().put("class", "null").put("note", "no active window")
        return try {
            serialize(root, 0, maxDepth, visibleOnly)
        } finally {
            @Suppress("DEPRECATION")
            root.recycle()
        }
    }

    private fun serialize(node: AccessibilityNodeInfo, depth: Int, maxDepth: Int, visibleOnly: Boolean): JSONObject {
        val o = JSONObject()
        node.className?.let { o.put("class", it.toString()) }
        node.text?.let { if (it.isNotEmpty()) o.put("text", it.toString()) }
        node.contentDescription?.let { if (it.isNotEmpty()) o.put("desc", it.toString()) }
        node.viewIdResourceName?.let { o.put("viewId", it) }
        node.packageName?.let { o.put("pkg", it.toString()) }

        val r = Rect()
        node.getBoundsInScreen(r)
        o.put("bounds", JSONObject().put("l", r.left).put("t", r.top).put("r", r.right).put("b", r.bottom))
        if (node.isClickable) o.put("clickable", true)
        if (node.isScrollable) o.put("scrollable", true)
        if (node.isEditable) o.put("editable", true)
        if (node.isCheckable) o.put("checkable", true)
        if (node.isChecked) o.put("checked", true)
        if (node.isFocused) o.put("focused", true)
        if (node.isSelected) o.put("selected", true)

        if (depth < maxDepth && node.childCount > 0) {
            val children = JSONArray()
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                try {
                    if (visibleOnly && !child.isVisibleToUser) continue
                    children.put(serialize(child, depth + 1, maxDepth, visibleOnly))
                } finally {
                    @Suppress("DEPRECATION")
                    child.recycle()
                }
            }
            if (children.length() > 0) o.put("children", children)
        }
        return o
    }

    // ── Screenshot (no MediaProjection popup; needs Android 11+ / API 30) ───────

    /**
     * Capture the whole screen via AccessibilityService.takeScreenshot — no
     * user consent popup, survives app switches. FLAG_SECURE windows come back
     * black. Blocks the caller until the async callback returns.
     */
    @RequiresApi(Build.VERSION_CODES.R)
    fun takeShot(maxWidth: Int, quality: Int, png: Boolean): ScreenCapturer.Result {
        val latch = CountDownLatch(1)
        var result: ScreenCapturer.Result? = null
        var failure: String? = null
        val executor = Executors.newSingleThreadExecutor()
        try {
            takeScreenshot(
                Display.DEFAULT_DISPLAY,
                executor,
                object : TakeScreenshotCallback {
                    override fun onSuccess(screenshot: ScreenshotResult) {
                        try {
                            val buffer = screenshot.hardwareBuffer
                            val hw = Bitmap.wrapHardwareBuffer(buffer, screenshot.colorSpace)
                            if (hw == null) {
                                failure = "wrapHardwareBuffer returned null"
                            } else {
                                // Copy into a software bitmap so we can scale/compress it.
                                val software = hw.copy(Bitmap.Config.ARGB_8888, false)
                                hw.recycle()
                                result = encode(software, maxWidth, quality, png)
                            }
                            buffer.close()
                        } catch (e: Throwable) {
                            failure = e.message ?: "screenshot conversion failed"
                        } finally {
                            latch.countDown()
                        }
                    }

                    override fun onFailure(errorCode: Int) {
                        failure = "takeScreenshot failed (code $errorCode)"
                        latch.countDown()
                    }
                },
            )
        } catch (e: Throwable) {
            executor.shutdown()
            error(e.message ?: "takeScreenshot threw")
        }
        latch.await(8, TimeUnit.SECONDS)
        executor.shutdown()
        return result ?: error(failure ?: "screenshot timed out")
    }

    private fun encode(src: Bitmap, maxWidth: Int, quality: Int, png: Boolean): ScreenCapturer.Result {
        val scaled = if (maxWidth in 1 until src.width) {
            val ratio = maxWidth.toFloat() / src.width
            val h = (src.height * ratio).toInt().coerceAtLeast(1)
            Bitmap.createScaledBitmap(src, maxWidth, h, true).also { if (it != src) src.recycle() }
        } else {
            src
        }
        val out = ByteArrayOutputStream()
        val fmt = if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG
        scaled.compress(fmt, quality.coerceIn(1, 100), out)
        val w = scaled.width
        val h = scaled.height
        scaled.recycle()
        val b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        return ScreenCapturer.Result(b64, if (png) "image/png" else "image/jpeg", w, h)
    }

    // ── Gestures ──────────────────────────────────────────────────────────────

    fun tap(x: Float, y: Float): Boolean {
        val path = Path().apply { moveTo(x, y) }
        return dispatch(path, 0, 50)
    }

    fun longPress(x: Float, y: Float, durationMs: Long): Boolean {
        val path = Path().apply { moveTo(x, y) }
        return dispatch(path, 0, durationMs)
    }

    fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long): Boolean {
        val path = Path().apply {
            moveTo(x1, y1)
            lineTo(x2, y2)
        }
        return dispatch(path, 0, durationMs)
    }

    private fun dispatch(path: Path, startTime: Long, durationMs: Long): Boolean {
        val stroke = GestureDescription.StrokeDescription(path, startTime, durationMs.coerceAtLeast(1))
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        val latch = CountDownLatch(1)
        var ok = false
        val posted = dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(d: GestureDescription?) {
                ok = true
                latch.countDown()
            }

            override fun onCancelled(d: GestureDescription?) {
                ok = false
                latch.countDown()
            }
        }, mainHandler)
        if (!posted) return false
        latch.await(durationMs + 3_000, TimeUnit.MILLISECONDS)
        return ok
    }

    // ── Node actions ────────────────────────────────────────────────────────────

    fun clickNode(viewId: String?, text: String?, index: Int): Boolean {
        val root = rootInActiveWindow ?: return false
        try {
            val matches = ArrayList<AccessibilityNodeInfo>()
            if (!viewId.isNullOrEmpty()) {
                matches.addAll(root.findAccessibilityNodeInfosByViewId(viewId))
            }
            if (matches.isEmpty() && !text.isNullOrEmpty()) {
                matches.addAll(root.findAccessibilityNodeInfosByText(text))
            }
            // When both are given, keep only nodes that also match text.
            val filtered = if (!viewId.isNullOrEmpty() && !text.isNullOrEmpty()) {
                matches.filter {
                    it.text?.toString()?.contains(text, true) == true ||
                        it.contentDescription?.toString()?.contains(text, true) == true
                }
            } else {
                matches
            }
            val target = filtered.getOrNull(index) ?: return false
            // Walk up to the nearest clickable ancestor if the match itself isn't clickable.
            var n: AccessibilityNodeInfo? = target
            while (n != null && !n.isClickable) n = n.parent
            return (n ?: target).performAction(AccessibilityNodeInfo.ACTION_CLICK)
        } finally {
            @Suppress("DEPRECATION")
            root.recycle()
        }
    }

    fun typeText(text: String): Boolean {
        val root = rootInActiveWindow ?: return false
        try {
            val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }
            return focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        } finally {
            @Suppress("DEPRECATION")
            root.recycle()
        }
    }

    fun globalAction(action: String): Boolean {
        val id = when (action) {
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
            else -> return false
        }
        return performGlobalAction(id)
    }

    /** Turn the screen off / show the lock screen (Android 9+). */
    @RequiresApi(Build.VERSION_CODES.P)
    fun lockScreen(): Boolean = performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)

    companion object {
        private const val TAG = "A11yService"

        @Volatile
        var instance: RemoteAccessibilityService? = null
            private set
    }
}
