package com.phonemcp.agent

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager

/**
 * Invisible activity that turns the screen on above the lock screen and asks
 * the system to dismiss a swipe/none keyguard, then finishes so whatever app
 * was in front comes back. A secure (PIN/pattern/biometric) keyguard stays up.
 */
class WakeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }

        val km = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        if (km.isKeyguardLocked && !km.isKeyguardSecure) {
            km.requestDismissKeyguard(
                this,
                object : KeyguardManager.KeyguardDismissCallback() {
                    override fun onDismissSucceeded() = finish()
                    override fun onDismissCancelled() = finish()
                    override fun onDismissError() = finish()
                },
            )
            // Safety net in case no callback ever arrives.
            window.decorView.postDelayed({ if (!isFinishing) finish() }, 3_000)
        } else {
            finish()
        }
    }

    companion object {
        fun start(ctx: Context) {
            ctx.startActivity(
                Intent(ctx, WakeActivity::class.java).addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION,
                ),
            )
        }
    }
}
