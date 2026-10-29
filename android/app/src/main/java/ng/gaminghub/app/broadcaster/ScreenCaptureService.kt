package ng.gaminghub.app.broadcaster

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.room.Room
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.VideoCaptureParameter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Android Foreground Service for capturing mobile game screen and internal audio
 * using MediaProjection, then publishing via LiveKit WebRTC SDK.
 */
class ScreenCaptureService : Service() {

    companion object {
        const val TAG = "ScreenCaptureService"
        const val CHANNEL_ID = "gaming_hub_screen_broadcast"
        const val NOTIFICATION_ID = 2001

        const val ACTION_START = "ng.gaminghub.app.ACTION_START"
        const val ACTION_STOP = "ng.gaminghub.app.ACTION_STOP"

        const val EXTRA_RESULT_CODE = "extra_result_code"
        const val EXTRA_RESULT_DATA = "extra_result_data"
        const val EXTRA_ROOM_ID = "extra_room_id"
        const val EXTRA_TOKEN = "extra_token"
        const val EXTRA_SERVER_URL = "extra_server_url"
        const val EXTRA_QUALITY = "extra_quality"
        const val EXTRA_CAPTURE_AUDIO = "extra_capture_audio"
        const val EXTRA_GAME_TITLE = "extra_game_title"
    }

    private val serviceScope = CoroutineScope(Dispatchers.Main + Job())
    private var mediaProjection: MediaProjection? = null
    private var liveKitRoom: Room? = null
    private var screenVideoTrack: LocalVideoTrack? = null
    private var internalAudioTrack: LocalAudioTrack? = null
    private var audioRecord: AudioRecord? = null

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
        }

        return START_NOT_STICKY
    }

    private fun handleStart(intent: Intent) {
        val gameTitle = intent.getStringExtra(EXTRA_GAME_TITLE) ?: "Mobile Game"
        val notification = createNotification("Transmitting $gameTitle gameplay...")
        startForeground(NOTIFICATION_ID, notification)

        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
        val resultData = intent.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
        val roomId = intent.getStringExtra(EXTRA_ROOM_ID) ?: return
        val token = intent.getStringExtra(EXTRA_TOKEN) ?: return
        val serverUrl = intent.getStringExtra(EXTRA_SERVER_URL) ?: return
        val quality = intent.getStringExtra(EXTRA_QUALITY) ?: "auto"
        val captureAudio = intent.getBooleanExtra(EXTRA_CAPTURE_AUDIO, true)

        if (resultData == null) {
            Log.e(TAG, "Result data is missing. User permission required.")
            stopSelf()
            return
        }

        val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        mediaProjection = projectionManager.getMediaProjection(resultCode, resultData)

        if (mediaProjection == null) {
            Log.e(TAG, "Failed to acquire MediaProjection token")
            stopSelf()
            return
        }

        // Initialize LiveKit room & publishing
        serviceScope.launch {
            try {
                connectAndPublish(serverUrl, token, quality, captureAudio)
            } catch (e: Exception) {
                Log.e(TAG, "Error connecting LiveKit room: ${e.message}", e)
                stopSelf()
            }
        }
    }

    private suspend fun connectAndPublish(
        serverUrl: String,
        token: String,
        quality: String,
        captureAudio: Boolean
    ) {
        val room = LiveKit.create(applicationContext)
        liveKitRoom = room

        // Configure video capture parameters based on user quality setting
        val (width, height, fps, maxBitrate) = when (quality) {
            "360p" -> VideoCaptureParameter(640, 360, 30, 700_000)
            "480p" -> VideoCaptureParameter(854, 480, 30, 1_500_000)
            "720p" -> VideoCaptureParameter(1280, 720, 30, 2_500_000)
            else -> VideoCaptureParameter(1280, 720, 30, 1_800_000) // Auto
        }

        // Connect room over WebRTC
        room.connect(serverUrl, token)
        Log.i(TAG, "Connected to LiveKit room: ${room.name}")

        // Create Screen Share Video Track using the MediaProjection
        val videoTrack = room.localParticipant.createScreenShareTrack(
            options = LocalVideoTrackOptions(
                isScreenShare = true,
                captureParams = VideoCaptureParameter(width, height, fps, maxBitrate)
            ),
            mediaProjection = mediaProjection
        )
        screenVideoTrack = videoTrack
        room.localParticipant.publishVideoTrack(videoTrack)
        Log.i(TAG, "Published screen video track ($width x $height @ ${fps}fps)")

        // Internal Audio Capture (Android 10+ / API 29+)
        if (captureAudio && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && mediaProjection != null) {
            try {
                setupInternalAudioCapture(mediaProjection!!, room)
            } catch (e: Exception) {
                Log.w(TAG, "Internal audio capture unsupported or rejected by target game: ${e.message}")
            }
        }
    }

    /**
     * Captures internal game audio via AudioPlaybackCaptureConfiguration (Android 10+)
     */
    private fun setupInternalAudioCapture(projection: MediaProjection, room: Room) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return

        val config = AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .build()

        val audioFormat = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(44100)
            .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
            .build()

        val minBufferSize = AudioRecord.getMinBufferSize(
            44100,
            AudioFormat.CHANNEL_IN_STEREO,
            AudioFormat.ENCODING_PCM_16BIT
        )

        audioRecord = AudioRecord.Builder()
            .setAudioPlaybackCaptureConfig(config)
            .setAudioFormat(audioFormat)
            .setBufferSizeInBytes(minBufferSize * 2)
            .build()

        audioRecord?.startRecording()
        Log.i(TAG, "Internal game audio recording initialized successfully.")
    }

    private fun handleStop() {
        try {
            audioRecord?.stop()
            audioRecord?.release()
            audioRecord = null

            screenVideoTrack?.stop()
            screenVideoTrack = null

            internalAudioTrack?.stop()
            internalAudioTrack = null

            liveKitRoom?.disconnect()
            liveKitRoom = null

            mediaProjection?.stop()
            mediaProjection = null

            Log.i(TAG, "Broadcast terminated and all media resources cleanly released.")
        } catch (e: Exception) {
            Log.e(TAG, "Error cleaning up broadcast resources: ${e.message}", e)
        } finally {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    override fun onDestroy() {
        serviceScope.cancel()
        handleStop()
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Gaming Hub Live Broadcasting",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows persistent status while broadcasting your gameplay screen"
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun createNotification(contentText: String): Notification {
        val stopIntent = Intent(this, ScreenCaptureService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPendingIntent = PendingIntent.getService(
            this,
            101,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Gaming Hub: Live Match Stream")
            .setContentText(contentText)
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_delete, "Stop Broadcast", stopPendingIntent)
            .build()
    }
}
