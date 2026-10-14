package com.phonemcp.agent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
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

    companion object {
        private const val TAG = "A11yService"

        @Volatile
        var instance: RemoteAccessibilityService? = null
            private set
    }
}
