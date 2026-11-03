package ng.gaminghub.app.broadcaster

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.webkit.JavascriptInterface
import ng.gaminghub.app.observer.AIMatchObserverService
import org.json.JSONObject

/**
 * JavaScript Interface injected into the Android WebView as window.GamingHubAndroidBridge.
 * Allows the React frontend to:
 * 1. Control the LiveKit screen broadcaster (ScreenCaptureService)
 * 2. Control the local on-device AI Match Observer (AIMatchObserverService)
 * 
 * Enforces Android 14+ token isolation and prevents concurrent MediaProjection session conflicts.
 */
class GamingHubBridge(private val activity: Activity) {

    companion object {
        const val REQUEST_MEDIA_PROJECTION = 1001
        const val REQUEST_MEDIA_OBSERVER = 1002

        var pendingBroadcastOptions: JSONObject? = null
        var pendingObserverOptions: JSONObject? = null
    }

    @JavascriptInterface
    fun isSupported(): Boolean {
        return true
    }

    // =========================================================================
    // LIVE BROADCASTER CONTROLS (LiveKit WebRTC Stream)
    // =========================================================================

    @JavascriptInterface
    fun startBroadcast(optionsJson: String): String {
        val result = JSONObject()
        try {
            // Android 14 token conflict protection: if observer is active, stop it before broadcasting
            if (AIMatchObserverService.isObserving) {
                stopObservation()
            }

            val options = JSONObject(optionsJson)
            pendingBroadcastOptions = options

            val projectionManager = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val captureIntent = projectionManager.createScreenCaptureIntent()

            // Launches Android system permission dialog ("Gaming Hub will start capturing everything...")
            activity.startActivityForResult(captureIntent, REQUEST_MEDIA_PROJECTION)

            result.put("success", true)
            result.put("message", "Requested system screen broadcast consent dialog")
        } catch (e: Exception) {
            result.put("success", false)
            result.put("error", e.message ?: "Failed to initiate screen broadcast")
        }
        return result.toString()
    }

    @JavascriptInterface
    fun stopBroadcast(): String {
        val result = JSONObject()
        try {
            val stopIntent = Intent(activity, ScreenCaptureService::class.java).apply {
                action = ScreenCaptureService.ACTION_STOP
            }
            activity.startService(stopIntent)
            pendingBroadcastOptions = null
            result.put("success", true)
            result.put("message", "Broadcast stopped")
        } catch (e: Exception) {
            result.put("success", false)
            result.put("error", e.message ?: "Failed to stop broadcast")
        }
        return result.toString()
    }

    @JavascriptInterface
    fun getBroadcastStatus(): String {
        val status = JSONObject()
        status.put("isBroadcasting", pendingBroadcastOptions != null)
        status.put("quality", pendingBroadcastOptions?.optString("quality", "auto") ?: "auto")
        return status.toString()
    }

    // =========================================================================
    // AI MATCH OBSERVER CONTROLS (Local On-Device Screen Analysis ~1 FPS)
    // =========================================================================

    @JavascriptInterface
    fun startObservation(optionsJson: String): String {
        val result = JSONObject()
        try {
            // Prevent duplicate starts
            if (AIMatchObserverService.isObserving) {
                result.put("success", true)
                result.put("alreadyObserving", true)
                result.put("message", "Observation already active")
                result.put("status", AIMatchObserverService.getDiagnostics())
                return result.toString()
            }

            // Android 14 token conflict protection: if broadcast is active, stop it before observing
            if (pendingBroadcastOptions != null) {
                stopBroadcast()
            }

            val options = JSONObject(optionsJson)
            pendingObserverOptions = options

            val projectionManager = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val captureIntent = projectionManager.createScreenCaptureIntent()

            // Launches Android system permission dialog for dedicated observer session
            activity.startActivityForResult(captureIntent, REQUEST_MEDIA_OBSERVER)

            result.put("success", true)
            result.put("message", "Requested system screen observation consent dialog")
        } catch (e: Exception) {
            result.put("success", false)
            result.put("error", e.message ?: "Failed to initiate screen observation")
        }
        return result.toString()
    }

    @JavascriptInterface
    fun stopObservation(): String {
        val result = JSONObject()
        try {
            val stopIntent = Intent(activity, AIMatchObserverService::class.java).apply {
                action = AIMatchObserverService.ACTION_STOP
            }
            activity.startService(stopIntent)
            pendingObserverOptions = null
            result.put("success", true)
            result.put("message", "Observation stopped")
        } catch (e: Exception) {
            result.put("success", false)
            result.put("error", e.message ?: "Failed to stop observation")
        }
        return result.toString()
    }

    @JavascriptInterface
    fun getObservationStatus(): String {
        return try {
            val status = AIMatchObserverService.getDiagnostics()
            val result = JSONObject()
            result.put("success", true)
            result.put("status", status)
            result.toString()
        } catch (e: Exception) {
            val err = JSONObject()
            err.put("success", false)
            err.put("error", e.message ?: "Failed to read observation status")
            err.toString()
        }
    }
}
