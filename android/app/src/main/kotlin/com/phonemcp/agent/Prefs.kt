package com.phonemcp.agent

import android.content.Context
import android.provider.Settings
import java.util.UUID

/** Persistent app settings: server URL, token, and a stable device id. */
object Prefs {
    private const val FILE = "phone_mcp_prefs"
    private const val KEY_SERVER = "server_url"
    private const val KEY_TOKEN = "token"
    private const val KEY_DEVICE_ID = "device_id"

    fun serverUrl(ctx: Context): String =
        prefs(ctx).getString(KEY_SERVER, "") ?: ""

    fun token(ctx: Context): String =
        prefs(ctx).getString(KEY_TOKEN, "") ?: ""

    fun save(ctx: Context, serverUrl: String, token: String) {
        prefs(ctx).edit()
            .putString(KEY_SERVER, serverUrl.trim().trimEnd('/'))
            .putString(KEY_TOKEN, token.trim())
            .apply()
    }

    /** Stable per-install id; prefixed with a short slice of ANDROID_ID for readability. */
    fun deviceId(ctx: Context): String {
        val existing = prefs(ctx).getString(KEY_DEVICE_ID, null)
        if (existing != null) return existing
        val androidId = try {
            Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID) ?: ""
        } catch (_: Throwable) {
            ""
        }
        val suffix = UUID.randomUUID().toString().substring(0, 6)
        val prefix = if (androidId.length >= 4) androidId.substring(0, 4) else "dev"
        val id = "$prefix-$suffix"
        prefs(ctx).edit().putString(KEY_DEVICE_ID, id).apply()
        return id
    }

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE)
}
