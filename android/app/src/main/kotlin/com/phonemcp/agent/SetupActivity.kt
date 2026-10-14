package com.phonemcp.agent

import android.Manifest
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.TextUtils
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.phonemcp.agent.databinding.ActivitySetupBinding

class SetupActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySetupBinding

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
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
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
        requestProjection()
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
            append("Accessibility: ").append(if (a11y) "enabled ✓" else "DISABLED ✗")
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
