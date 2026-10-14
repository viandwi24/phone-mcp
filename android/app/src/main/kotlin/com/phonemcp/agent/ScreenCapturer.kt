package com.phonemcp.agent

import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import android.util.Log
import java.io.ByteArrayOutputStream

/**
 * Captures single frames from a MediaProjection via an ImageReader-backed
 * VirtualDisplay. Screenshot-on-demand (no continuous stream) to stay cheap.
 */
class ScreenCapturer(
    private val projection: MediaProjection,
    private val widthPx: Int,
    private val heightPx: Int,
    private val densityDpi: Int,
) {
    data class Result(val base64: String, val mime: String, val w: Int, val h: Int)

    private val thread = HandlerThread("screen-capture").apply { start() }
    private val handler = Handler(thread.looper)
    private var imageReader: ImageReader? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var started = false

    @Synchronized
    private fun ensureStarted() {
        if (started) return
        val reader = ImageReader.newInstance(widthPx, heightPx, PixelFormat.RGBA_8888, 2)
        imageReader = reader
        virtualDisplay = projection.createVirtualDisplay(
            "phone-mcp-capture",
            widthPx,
            heightPx,
            densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface,
            null,
            handler,
        )
        started = true
    }

    /** Capture one frame, downscaled to [maxWidth], encoded as JPEG (or PNG). */
    @Synchronized
    fun capture(maxWidth: Int, quality: Int, png: Boolean): Result {
        ensureStarted()
        val reader = imageReader ?: error("capture not started")

        var bitmap: Bitmap? = null
        // The first frame can take a moment to render; retry briefly.
        var tries = 0
        while (bitmap == null && tries < 40) {
            val image = reader.acquireLatestImage()
            if (image == null) {
                Thread.sleep(50)
                tries++
                continue
            }
            try {
                val plane = image.planes[0]
                val buffer = plane.buffer
                val pixelStride = plane.pixelStride
                val rowStride = plane.rowStride
                val rowPadding = rowStride - pixelStride * widthPx
                val bmp = Bitmap.createBitmap(
                    widthPx + rowPadding / pixelStride,
                    heightPx,
                    Bitmap.Config.ARGB_8888,
                )
                bmp.copyPixelsFromBuffer(buffer)
                // Crop off the row padding on the right edge.
                bitmap = Bitmap.createBitmap(bmp, 0, 0, widthPx, heightPx)
                if (bmp != bitmap) bmp.recycle()
            } finally {
                image.close()
            }
        }

        val src = bitmap ?: error("no frame available (screen may be off or FLAG_SECURE)")

        val scaled = if (maxWidth in 1 until src.width) {
            val ratio = maxWidth.toFloat() / src.width
            val h = (src.height * ratio).toInt().coerceAtLeast(1)
            Bitmap.createScaledBitmap(src, maxWidth, h, true).also {
                if (it != src) src.recycle()
            }
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
        return Result(b64, if (png) "image/png" else "image/jpeg", w, h)
    }

    @Synchronized
    fun release() {
        try {
            virtualDisplay?.release()
        } catch (e: Throwable) {
            Log.w(TAG, "release vd: ${e.message}")
        }
        try {
            imageReader?.close()
        } catch (_: Throwable) {
        }
        virtualDisplay = null
        imageReader = null
        started = false
        thread.quitSafely()
    }

    companion object {
        private const val TAG = "ScreenCapturer"
    }
}
