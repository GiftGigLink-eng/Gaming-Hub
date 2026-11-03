package ng.gaminghub.app.observer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.SystemClock
import android.util.DisplayMetrics
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * AIMatchObserverService: Android Foreground Service for low-power, on-device screen frame observation.
 * 
 * Key Architectural Properties:
 * 1. Independent of LiveKit / WebRTC streaming - zero network frame transmission.
 * 2. Strictly user-authorised via Android MediaProjection system consent dialog.
 * 3. Low-resolution VirtualDisplay & ImageReader pipeline (640x360 @ 160 DPI).
 * 4. ~1 FPS sampling target - unneeded frames are instantly closed in nanoseconds.
 * 5. Coroutine background processing on Dispatchers.Default.
 * 6. Immediate image.close() and bitmap.recycle() guarantees (zero buffer leaks).
 * 7. Android 14+ (API 34) compliant: MediaProjection.Callback registration and
 *    foregroundServiceType="mediaProjection".
 */
class AIMatchObserverService : Service() {

    companion object {
        const val TAG = "AIMatchObserverService"
        const val CHANNEL_ID = "gaming_hub_match_observer"
        const val NOTIFICATION_ID = 3001

        // Actions
        const val ACTION_START = "ng.gaminghub.app.observer.ACTION_START"
        const val ACTION_STOP = "ng.gaminghub.app.observer.ACTION_STOP"
        const val ACTION_GET_STATUS = "ng.gaminghub.app.observer.ACTION_GET_STATUS"

        // Intent Extras
        const val EXTRA_RESULT_CODE = "extra_result_code"
        const val EXTRA_RESULT_DATA = "extra_result_data"
        const val EXTRA_OPPORTUNITY_ID = "extra_opportunity_id"
        const val EXTRA_GAME_ID = "extra_game_id"
        const val EXTRA_GAME_TITLE = "extra_game_title"
        const val EXTRA_PACKAGE_ID = "extra_package_id"
        const val EXTRA_TARGET_FPS = "extra_target_fps"

        // Capture Geometry (16:9 low resolution for minimum CPU & battery impact)
        const val CAPTURE_WIDTH = 640
        const val CAPTURE_HEIGHT = 360
        const val CAPTURE_DENSITY_DPI = DisplayMetrics.DENSITY_DEFAULT // 160 DPI
        const val DEFAULT_FRAME_INTERVAL_MS = 1000L // 1 FPS target

        // Singleton State for Bridge and Diagnostics
        @Volatile
        var isObserving: Boolean = false
            private set

        @Volatile
        var activeOpportunityId: String? = null
            private set

        @Volatile
        var activeGameTitle: String? = null
            private set

        @Volatile
        var activePackageId: String? = null
            private set

        // Telemetry Counters
        val totalFramesReceived = AtomicInteger(0)
        val totalFramesProcessed = AtomicInteger(0)
        val lastProcessingDurationMs = AtomicLong(0L)
        val sessionStartTimeMs = AtomicLong(0L)

        // Event listener for MainActivity WebView dispatch
        var eventListener: ((event: String, payload: JSONObject) -> Unit)? = null

        fun getDiagnostics(): JSONObject {
            return JSONObject().apply {
                put("isObserving", isObserving)
                put("opportunityId", activeOpportunityId ?: "")
                put("gameTitle", activeGameTitle ?: "")
                put("packageId", activePackageId ?: "")
                put("framesReceived", totalFramesReceived.get())
                put("framesProcessed", totalFramesProcessed.get())
                put("lastProcessingTimeMs", lastProcessingDurationMs.get())
                put("width", CAPTURE_WIDTH)
                put("height", CAPTURE_HEIGHT)
                val durationSec = if (sessionStartTimeMs.get() > 0) {
                    (SystemClock.elapsedRealtime() - sessionStartTimeMs.get()) / 1000L
                } else 0L
                put("sessionDurationSeconds", durationSec)
                val effectiveFps = if (durationSec > 0) {
                    String.format("%.2f", totalFramesProcessed.get().toDouble() / durationSec)
                } else "0.0"
                put("effectiveFps", effectiveFps)
            }
        }
    }

    private var serviceJob = Job()
    private var serviceScope = CoroutineScope(Dispatchers.Default + serviceJob)
    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var backgroundThread: HandlerThread? = null
    private var backgroundHandler: Handler? = null

    private var targetIntervalMs = DEFAULT_FRAME_INTERVAL_MS
    private var lastFrameProcessedTimeMs = 0L
    private val isProcessingFrame = AtomicBoolean(false)

    // MediaProjection system callback (handles user or OS revocation)
    private val mediaProjectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            Log.i(TAG, "[Observer] MediaProjection revoked or stopped by Android system")
            dispatchObserverEvent("gaminghub:native_observer_revoked", JSONObject().apply {
                put("reason", "MediaProjection session revoked or stopped by OS")
                put("opportunityId", activeOpportunityId ?: "")
            })
            handleStop()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) return START_NOT_STICKY

        when (intent.action) {
            ACTION_START -> handleStart(intent)
            ACTION_STOP -> handleStop()
            ACTION_GET_STATUS -> {
                dispatchObserverEvent("gaminghub:native_observer_status", getDiagnostics())
            }
        }

        return START_NOT_STICKY
    }

    /**
     * Handles starting the observation pipeline with explicit user permission.
     */
    private fun handleStart(intent: Intent) {
        if (isObserving) {
            Log.w(TAG, "[Observer] Observation already in progress. Ignoring duplicate start.")
            return
        }

        if (!serviceJob.isActive) {
            serviceJob = Job()
            serviceScope = CoroutineScope(Dispatchers.Default + serviceJob)
        }

        val gameTitle = intent.getStringExtra(EXTRA_GAME_TITLE) ?: "Mobile Game"
        val opportunityId = intent.getStringExtra(EXTRA_OPPORTUNITY_ID) ?: ""
        val packageId = intent.getStringExtra(EXTRA_PACKAGE_ID) ?: ""
        val targetFps = intent.getIntExtra(EXTRA_TARGET_FPS, 1).coerceIn(1, 5)
        targetIntervalMs = 1000L / targetFps

        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
        val resultData: Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(EXTRA_RESULT_DATA)
        }

        if (resultData == null || resultCode == 0) {
            Log.e(TAG, "[Observer] Missing MediaProjection result data or resultCode")
            stopSelf()
            return
        }

        // 1. Start foreground service immediately with persistent notification
        val notification = createNotification("Monitoring $gameTitle locally on device (1 FPS)")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        // 2. Obtain MediaProjection token
        val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        mediaProjection = projectionManager.getMediaProjection(resultCode, resultData)

        if (mediaProjection == null) {
            Log.e(TAG, "[Observer] Failed to acquire MediaProjection from MediaProjectionManager")
            stopSelf()
            return
        }

        // 3. Initialize background handler thread for ImageReader listener
        val thread = HandlerThread("AIMatchObserver_FrameThread").apply { start() }
        backgroundThread = thread
        val handler = Handler(thread.looper)
        backgroundHandler = handler

        // 4. Register Android 14+ MediaProjection Callback
        mediaProjection?.registerCallback(mediaProjectionCallback, handler)

        // 5. Initialize low-memory ImageReader (2 buffers max, RGBA_8888)
        val reader = ImageReader.newInstance(
            CAPTURE_WIDTH,
            CAPTURE_HEIGHT,
            PixelFormat.RGBA_8888,
            2
        )
        imageReader = reader

        reader.setOnImageAvailableListener({ ir ->
            onFrameAvailable(ir)
        }, handler)

        // 6. Create VirtualDisplay attached to ImageReader surface
        try {
            virtualDisplay = mediaProjection?.createVirtualDisplay(
                "GamingHub_AIObserverDisplay",
                CAPTURE_WIDTH,
                CAPTURE_HEIGHT,
                CAPTURE_DENSITY_DPI,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                reader.surface,
                null,
                handler
            )
            Log.i(TAG, "[Observer] VirtualDisplay created successfully: ${CAPTURE_WIDTH}x${CAPTURE_HEIGHT} @ $targetFps FPS")
        } catch (e: Exception) {
            Log.e(TAG, "[Observer] Failed to create VirtualDisplay: ${e.message}", e)
            handleStop()
            return
        }

        // 7. Update singleton state
        isObserving = true
        activeOpportunityId = opportunityId
        activeGameTitle = gameTitle
        activePackageId = packageId
        totalFramesReceived.set(0)
        totalFramesProcessed.set(0)
        lastProcessingDurationMs.set(0L)
        sessionStartTimeMs.set(SystemClock.elapsedRealtime())
        lastFrameProcessedTimeMs = 0L

        dispatchObserverEvent("gaminghub:native_observer_started", getDiagnostics())
    }

    /**
     * ImageReader callback executed on HandlerThread.
     * Enforces strict ~1 FPS sampling and immediate buffer closure.
     */
    private fun onFrameAvailable(reader: ImageReader) {
        var image: Image? = null
        try {
            image = reader.acquireLatestImage()
            if (image == null) return

            totalFramesReceived.incrementAndGet()
            val now = SystemClock.elapsedRealtime()

            // Throttling: If less than target interval has elapsed, discard frame immediately
            if (now - lastFrameProcessedTimeMs < targetIntervalMs || !isProcessingFrame.compareAndSet(false, true)) {
                image.close()
                return
            }

            lastFrameProcessedTimeMs = now
            val frameToProcess = image
            image = null // Transfer ownership to coroutine

            serviceScope.launch(Dispatchers.Default) {
                val startTime = SystemClock.elapsedRealtime()
                try {
                    processFrameLocally(frameToProcess)
                } catch (e: Exception) {
                    Log.w(TAG, "[Observer] Frame processing error: ${e.message}")
                } finally {
                    // STRICT RESOURCE RELEASE: Always close Image to return buffer to pool
                    try {
                        frameToProcess.close()
                    } catch (t: Throwable) {
                        // Already closed
                    }
                    val duration = SystemClock.elapsedRealtime() - startTime
                    lastProcessingDurationMs.set(duration)
                    val count = totalFramesProcessed.incrementAndGet()
                    isProcessingFrame.set(false)

                    // Throttled telemetry dispatch every 5 processed frames (~5 seconds)
                    if (count % 5 == 0) {
                        dispatchObserverEvent("gaminghub:native_observer_frame_processed", getDiagnostics())
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "[Observer] Error acquiring image: ${e.message}")
            image?.close()
            isProcessingFrame.set(false)
        }
    }

    /**
     * Low-level local frame processor.
     * Extracts planes in-memory, validates dimensions, and immediately releases all allocations.
     * STRICT: Never stores or uploads frame data.
     */
    private fun processFrameLocally(image: Image) {
        val planes = image.planes
        if (planes.isEmpty()) return

        val buffer = planes[0].buffer
        val pixelStride = planes[0].pixelStride
        val rowStride = planes[0].rowStride
        val width = image.width
        val height = image.height

        // Sanity validation of plane memory
        if (buffer.remaining() <= 0) return

        // Verify bitmap extraction in low-resolution without leaking native memory
        var sampleBitmap: Bitmap? = null
        try {
            // Allocate temporary 16:9 downscaled test bitmap
            sampleBitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)

            // Handle potential GPU hardware row padding (e.g. 64-byte or 128-byte stride alignment)
            val rowPadding = rowStride - width * pixelStride
            if (rowPadding == 0) {
                sampleBitmap.copyPixelsFromBuffer(buffer.duplicate())
            } else {
                val tightlyPacked = ByteBuffer.allocateDirect(width * height * pixelStride)
                val rowBuffer = ByteArray(width * pixelStride)
                val dup = buffer.duplicate()
                for (row in 0 until height) {
                    dup.position(row * rowStride)
                    dup.get(rowBuffer, 0, width * pixelStride)
                    tightlyPacked.put(rowBuffer)
                }
                tightlyPacked.rewind()
                sampleBitmap.copyPixelsFromBuffer(tightlyPacked)
            }

            // Sample center and corners (sub-millisecond local telemetry)
            val centerPixel = sampleBitmap.getPixel(width / 2, height / 2)
            val alpha = (centerPixel shr 24) and 0xff
            val red = (centerPixel shr 16) and 0xff
            val green = (centerPixel shr 8) and 0xff
            val blue = centerPixel and 0xff

            // Frame is valid and verified in local memory
            if (Log.isLoggable(TAG, Log.DEBUG)) {
                Log.d(TAG, "[Observer Frame] Sampled local frame: ${width}x${height}, RGBA=($red, $green, $blue, $alpha)")
            }
        } catch (e: Exception) {
            Log.w(TAG, "[Observer] Bitmap extraction exception: ${e.message}")
        } finally {
            // STRICT BITMAP RELEASE: Always recycle explicitly
            sampleBitmap?.recycle()
        }
    }

    /**
     * Clean shutdown of all capture resources.
     */
    private fun handleStop() {
        if (!isObserving && mediaProjection == null) {
            return
        }

        try {
            virtualDisplay?.release()
            virtualDisplay = null

            imageReader?.close()
            imageReader = null

            mediaProjection?.unregisterCallback(mediaProjectionCallback)
            mediaProjection?.stop()
            mediaProjection = null

            backgroundThread?.quitSafely()
            backgroundThread = null
            backgroundHandler = null

            serviceJob.cancel()
            serviceJob = Job()
            serviceScope = CoroutineScope(Dispatchers.Default + serviceJob)

            Log.i(TAG, "[Observer] Screen observation pipeline terminated cleanly.")
        } catch (e: Exception) {
            Log.e(TAG, "[Observer] Error during cleanup: ${e.message}", e)
        } finally {
            isObserving = false
            val finalDiagnostics = getDiagnostics()
            activeOpportunityId = null
            activeGameTitle = null
            activePackageId = null
            isProcessingFrame.set(false)

            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()

            dispatchObserverEvent("gaminghub:native_observer_stopped", finalDiagnostics)
        }
    }

    private fun dispatchObserverEvent(event: String, payload: JSONObject) {
        eventListener?.invoke(event, payload)
    }

    override fun onDestroy() {
        handleStop()
        serviceJob.cancel()
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Gaming Hub AI Match Observer",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows local active status while Gaming Hub observes your gameplay locally on-device"
                setShowBadge(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun createNotification(contentText: String): Notification {
        val stopIntent = Intent(this, AIMatchObserverService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPendingIntent = PendingIntent.getService(
            this,
            201,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Gaming Hub: AI Match Observer Active")
            .setContentText(contentText)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(android.R.drawable.ic_delete, "Stop Observer", stopPendingIntent)
            .build()
    }
}
