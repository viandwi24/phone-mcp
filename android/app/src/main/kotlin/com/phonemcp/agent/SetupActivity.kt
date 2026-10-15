package com.phonemcp.agent

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.TextUtils
import android.text.method.ScrollingMovementMethod
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.phonemcp.agent.databinding.ActivitySetupBinding

class SetupActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySetupBinding
    private val busListener = Runnable { renderBus() }

    private val projectionLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val data = result.data
            if (result.resultCode == RESULT_OK && data != null) {
                launchService(result.resultCode, data)
                toast("Screen capture granted — service starting")
            } else {
                // Start anyway without projection (gestures/ui_tree still work).
                launchService(null, null)
                toast("Started without screen capture")
            }
            refreshStatus()
        }

    private val notifLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* ignored */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySetupBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.serverUrlInput.setText(Prefs.serverUrl(this))
        binding.tokenInput.setText(Prefs.token(this))

        binding.connectButton.setOnClickListener { onConnect() }
        binding.stopButton.setOnClickListener { onStopClicked() }
        binding.accessibilityButton.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        binding.screenButton.setOnClickListener { requestProjection() }
        binding.batteryButton.setOnClickListener { openBatterySettings() }

        binding.logText.movementMethod = ScrollingMovementMethod()
        binding.copyLogButton.setOnClickListener {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("phone-mcp log", StatusBus.snapshot().joinToString("\n")))
            toast("Log copied")
        }
        binding.clearLogButton.setOnClickListener { StatusBus.clear() }
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
        StatusBus.addListener(busListener)
        renderBus()
    }

    override fun onPause() {
        super.onPause()
        StatusBus.removeListener(busListener)
    }

    private fun renderBus() {
        val detail = StatusBus.detail
        binding.connStatusText.text = "● ${StatusBus.state}" + if (detail.isNotEmpty()) " — $detail" else ""
        val lines = StatusBus.snapshot()
        binding.logText.text = if (lines.isEmpty()) "(no activity yet)" else lines.joinToString("\n")
        // Auto-scroll to the newest line.
        binding.logText.post {
            val layout = binding.logText.layout ?: return@post
            val bottom = layout.getLineBottom(binding.logText.lineCount - 1)
            val scrollY = bottom - binding.logText.height
            if (scrollY > 0) binding.logText.scrollTo(0, scrollY) else binding.logText.scrollTo(0, 0)
        }
    }

    private fun onConnect() {
        val url = binding.serverUrlInput.text.toString().trim()
        val token = binding.tokenInput.text.toString().trim()
        if (url.isEmpty() || token.isEmpty()) {
            toast("Enter server URL and token")
            return
        }
        Prefs.save(this, url, token)
        if (Build.VERSION.SDK_INT >= 33) {
            notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        // Start WITHOUT the MediaProjection popup — screenshots go through the
        // Accessibility service now. Screen capture is opt-in via its own button
        // (fallback for Android ≤10 or FLAG_SECURE-free mirroring).
        launchService(null, null)
        toast("Starting — connecting to server")
        refreshStatus()
    }

    private fun requestProjection() {
        val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projectionLauncher.launch(mgr.createScreenCaptureIntent())
    }

    private fun launchService(resultCode: Int?, data: Intent?) {
        val i = Intent(this, RemoteForegroundService::class.java).apply {
            action = RemoteForegroundService.ACTION_START
            if (resultCode != null && data != null) {
                putExtra(RemoteForegroundService.EXTRA_RESULT_CODE, resultCode)
                putExtra(RemoteForegroundService.EXTRA_RESULT_DATA, data)
            }
        }
        launchService(i)
    }

    private fun onStopClicked() {
        launchService(
            Intent(this, RemoteForegroundService::class.java).apply {
                action = RemoteForegroundService.ACTION_STOP
            },
        )
        toast("Stopping")
        refreshStatus()
    }

    private fun launchService(i: Intent) {
        // Calls the framework Context.startService / startForegroundService.
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i) else startService(i)
    }

    private fun openBatterySettings() {
        try {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")),
            )
        } catch (_: Throwable) {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    private fun refreshStatus() {
        val a11y = isAccessibilityEnabled()
        val url = Prefs.serverUrl(this)
        binding.statusText.text = buildString {
            append("Device id: ").append(Prefs.deviceId(this@SetupActivity)).append('\n')
            append("Server: ").append(if (url.isEmpty()) "(not set)" else url).append('\n')
            append("Accessibility: ").append(if (a11y) "enabled ✓" else "DISABLED ✗").append('\n')
            val km = getSystemService(Context.KEYGUARD_SERVICE) as android.app.KeyguardManager
            append("Screen lock: ").append(
                if (km.isDeviceSecure) "PIN/pattern ✗ (agent can't wake & unlock remotely)"
                else "none/swipe ✓ (agent wakes the screen only while working)",
            )
        }
    }

    private fun isAccessibilityEnabled(): Boolean {
        val expected = "$packageName/$packageName.RemoteAccessibilityService"
        val enabled = try {
            Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: ""
        } catch (_: Throwable) {
            ""
        }
        val splitter = TextUtils.SimpleStringSplitter(':')
        splitter.setString(enabled)
        for (component in splitter) {
            if (component.equals(expected, ignoreCase = true)) return true
        }
        return false
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
}
