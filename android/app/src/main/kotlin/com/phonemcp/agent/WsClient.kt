package com.phonemcp.agent

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Single persistent WebSocket to the broker with exponential-backoff reconnect.
 * Translates an http(s) base URL into ws(s)://<host>/device?token=…
 */
class WsClient(
    private val serverUrl: String,
    private val token: String,
    private val listener: Listener,
) {
    interface Listener {
        fun onOpen()
        fun onMessage(text: String)
        fun onClosed()
    }

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .build()

    @Volatile private var ws: WebSocket? = null
    private val running = AtomicBoolean(false)
    private var attempt = 0

    fun start() {
        if (running.getAndSet(true)) return
        connect()
    }

    fun stop() {
        running.set(false)
        try {
            ws?.close(1000, "client stopping")
        } catch (_: Throwable) {
        }
        ws = null
    }

    fun send(text: String): Boolean = ws?.send(text) ?: false

    private fun wsUrl(): String {
        val base = serverUrl.trim().trimEnd('/')
        val wsBase = when {
            base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
            base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
            base.startsWith("wss://") || base.startsWith("ws://") -> base
            else -> "wss://$base"
        }
        return "$wsBase/device?token=${token.trim()}"
    }

    private fun connect() {
        if (!running.get()) return
        val url = wsUrl()
        // Never log the token — show the host/path only.
        val safeUrl = url.substringBefore("?token=")
        Log.i(TAG, "connecting to $url")
        StatusBus.setState(StatusBus.State.CONNECTING, safeUrl)
        val req = Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer ${token.trim()}")
            .build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                attempt = 0
                StatusBus.log("WebSocket open (HTTP ${response.code})")
                listener.onOpen()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                listener.onMessage(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "closed: $code $reason")
                StatusBus.setState(StatusBus.State.DISCONNECTED, "closed $code${if (reason.isNotEmpty()) " $reason" else ""}")
                listener.onClosed()
                scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val code = response?.code
                val reason = when {
                    code == 401 || code == 403 -> "HTTP $code unauthorized — check the token matches the server"
                    code != null -> "HTTP $code ${response.message}"
                    else -> t.message ?: "network error (check URL / internet)"
                }
                Log.w(TAG, "failure: $reason")
                StatusBus.setState(StatusBus.State.DISCONNECTED, reason)
                listener.onClosed()
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        if (!running.get()) return
        ws = null
        val delayMs = minOf(30_000L, 1_000L * (1L shl minOf(attempt, 5)))
        attempt++
        Log.i(TAG, "reconnect in ${delayMs}ms (attempt $attempt)")
        reconnectThread(delayMs)
    }

    private fun reconnectThread(delayMs: Long) {
        Thread {
            try {
                Thread.sleep(delayMs)
            } catch (_: InterruptedException) {
            }
            connect()
        }.apply { isDaemon = true }.start()
    }

    companion object {
        private const val TAG = "WsClient"
    }
}
