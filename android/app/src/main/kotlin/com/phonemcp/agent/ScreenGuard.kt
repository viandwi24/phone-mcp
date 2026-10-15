package com.phonemcp.agent

import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject

/**
 * Keeps the screen on only while the agent is working, so the phone doesn't
 * have to sit with its display lit all day:
 *
 *  - [ensureAwake] (called before every screen command) turns the screen on and
 *    dismisses a swipe/none keyguard. A PIN/pattern/biometric lock cannot be
 *    opened remotely — that is an Android guarantee — so it fails with a clear error.
 *  - A dim wake lock holds the screen while commands keep arriving.
 *  - After [idleLockMs] without commands the screen is locked again, but only if
 *    *we* woke it (never lock a phone someone is actively using).
 */
class ScreenGuard(private val ctx: Context) {

    data class State(val on: Boolean, val locked: Boolean, val secure: Boolean) {
        fun toJson(): JSONObject =
            JSONObject().put("screenOn", on).put("locked", locked).put("secureLock", secure)
    }

    private val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
    private val km = ctx.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
    private val main = Handler(Looper.getMainLooper())

    // SCREEN_DIM + ACQUIRE_CAUSES_WAKEUP are deprecated but remain the only way for a
    // service to light the screen; dim keeps the backlight (and battery drain) low.
    @Suppress("DEPRECATION")
    private val wakeLock: PowerManager.WakeLock = pm.newWakeLock(
        PowerManager.SCREEN_DIM_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
        "phone-mcp:screen",
    ).apply { setReferenceCounted(false) }

    /** Auto-lock delay after the last command; 0 disables auto-lock. */
    @Volatile var idleLockMs: Long = DEFAULT_IDLE_LOCK_MS

    @Volatile private var wokeByUs = false
    private val idleRunnable = Runnable { onIdle() }

    fun state(): State = State(pm.isInteractive, km.isKeyguardLocked, km.isKeyguardSecure)

    /** True when a PIN/pattern/biometric is configured at all (even if currently unlocked). */
    fun deviceSecure(): Boolean = km.isDeviceSecure

    /**
     * Make sure the screen is on and unlocked (swipe/none lock only). Blocks up
     * to ~3 s. Throws when a secure lock is in the way.
     */
    fun ensureAwake(): State {
        val before = state()
        if (before.on && !before.locked) {
            touch()
            return before
        }

        synchronized(this) { wokeByUs = true }
        wakeLock.acquire(holdMs())
        try {
            WakeActivity.start(ctx)
        } catch (e: Throwable) {
            Log.w(TAG, "wake activity failed: ${e.message}")
        }

        val deadline = SystemClock.uptimeMillis() + 3_000
        var s = state()
        while (SystemClock.uptimeMillis() < deadline && !(s.on && (!s.locked || s.secure))) {
            Thread.sleep(100)
            s = state()
        }

        if (s.locked && s.secure) {
            // Nothing more we can do; let the lock screen time out on its own.
            release()
            StatusBus.log("wake: secure lock active — needs manual unlock")
            throw IllegalStateException(SECURE_LOCK_ERROR)
        }
        if (!s.on) {
            release()
            throw IllegalStateException("could not turn the screen on")
        }
        Thread.sleep(SETTLE_MS) // let the unlock animation finish before we look/tap
        StatusBus.log("screen woke for agent")
        touch()
        return s
    }

    /** Extend the wake hold and restart the idle auto-lock timer. */
    @Synchronized
    fun touch() {
        wakeLock.acquire(holdMs()) // non-ref-counted: re-acquire just resets the timeout
        main.removeCallbacks(idleRunnable)
        if (idleLockMs > 0) main.postDelayed(idleRunnable, idleLockMs)
    }

    /** Lock the screen now (explicit `lock` command). */
    @Synchronized
    fun lock(): Boolean {
        main.removeCallbacks(idleRunnable)
        wokeByUs = false
        if (wakeLock.isHeld) wakeLock.release()
        return lockNow()
    }

    /** Drop the wake lock and timers (service stopping). */
    @Synchronized
    fun release() {
        main.removeCallbacks(idleRunnable)
        if (wakeLock.isHeld) wakeLock.release()
    }

    @Synchronized
    private fun onIdle() {
        val lockIt = wokeByUs && pm.isInteractive
        wokeByUs = false
        if (wakeLock.isHeld) wakeLock.release()
        if (lockIt) {
            val ok = lockNow()
            StatusBus.log(
                if (ok) "idle ${idleLockMs / 1000}s → screen locked"
                else "idle → wake released (screen turns off on its normal timeout)",
            )
        }
    }

    private fun lockNow(): Boolean {
        val a11y = RemoteAccessibilityService.instance ?: return false
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) a11y.lockScreen() else false
    }

    private fun holdMs(): Long = (if (idleLockMs > 0) idleLockMs else MAX_HOLD_MS) + 5_000

    companion object {
        private const val TAG = "ScreenGuard"
        const val DEFAULT_IDLE_LOCK_MS = 30_000L
        private const val MAX_HOLD_MS = 10 * 60_000L
        private const val SETTLE_MS = 350L
        const val SECURE_LOCK_ERROR =
            "phone is locked with a PIN/pattern/biometric — unlock it on the device (remote unlock " +
                "isn't possible). For a dedicated automation phone, set Screen lock to None or Swipe."
    }
}
