package com.phonemcp.agent

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log

/**
 * A transparent, no-UI activity whose only job is to call startActivity for a
 * URL/deep link. Launching from an Activity avoids the background-activity-start
 * restrictions that bite a Service on Android 10+.
 */
class LaunchBridgeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra(EXTRA_URL)
        val pkg = intent.getStringExtra(EXTRA_PACKAGE)
        if (!url.isNullOrEmpty()) {
            try {
                val view = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    if (!pkg.isNullOrEmpty()) setPackage(pkg)
                }
                startActivity(view)
            } catch (e: Throwable) {
                Log.w(TAG, "launch failed, retrying without package: ${e.message}")
                try {
                    startActivity(
                        Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                } catch (e2: Throwable) {
                    Log.e(TAG, "launch failed: ${e2.message}")
                }
            }
        }
        finish()
    }

    companion object {
        private const val TAG = "LaunchBridge"
        const val EXTRA_URL = "url"
        const val EXTRA_PACKAGE = "package"

        fun start(ctx: android.content.Context, url: String, pkg: String?) {
            val i = Intent(ctx, LaunchBridgeActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                putExtra(EXTRA_URL, url)
                if (!pkg.isNullOrEmpty()) putExtra(EXTRA_PACKAGE, pkg)
            }
            ctx.startActivity(i)
        }
    }
}
