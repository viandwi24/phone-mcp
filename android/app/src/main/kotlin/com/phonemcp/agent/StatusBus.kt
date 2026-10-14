package com.phonemcp.agent

import android.os.Handler
import android.os.Looper
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Process-wide connection state + rolling log, so the UI can show what the
 * background service is actually doing (connecting / connected / why it failed)
 * without needing logcat. Safe to call from any thread; listeners fire on main.
 */
object StatusBus {

    enum class State { IDLE, CONNECTING, CONNECTED, DISCONNECTED }

    @Volatile var state: State = State.IDLE
        private set

    /** Short human detail for the current state, e.g. "401 unauthorized — wrong token?". */
    @Volatile var detail: String = ""
        private set

    private const val MAX_LINES = 200
    private val lines = ArrayDeque<String>()
    private val listeners = CopyOnWriteArraySet<Runnable>()
    private val main = Handler(Looper.getMainLooper())
    private val clock = SimpleDateFormat("HH:mm:ss", Locale.US)

    fun setState(newState: State, detail: String = "") {
        state = newState
        this.detail = detail
        log("● ${newState.name}" + if (detail.isNotEmpty()) " — $detail" else "")
    }

    fun log(message: String) {
        synchronized(lines) {
            lines.addLast("${clock.format(Date())}  $message")
            while (lines.size > MAX_LINES) lines.removeFirst()
        }
        notifyListeners()
    }

    fun snapshot(): List<String> = synchronized(lines) { lines.toList() }

    fun clear() {
        synchronized(lines) { lines.clear() }
        notifyListeners()
    }

    fun addListener(r: Runnable) = listeners.add(r)
    fun removeListener(r: Runnable) = listeners.remove(r)

    private fun notifyListeners() {
        main.post { listeners.forEach { it.run() } }
    }
}
