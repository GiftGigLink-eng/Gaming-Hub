package ng.gaminghub.app.broadcaster

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * JavaScript Interface injected into the Android WebView as window.GamingHubAndroidBridge.
 * Allows the React frontend to initiate MediaProjection screen capture consent and control
 * the ScreenCaptureService.
 */
class GamingHubBridge(private val activity: Activity) {

    companion object {
        const val REQUEST_MEDIA_PROJECTION = 1001
        var pendingBroadcastOptions: JSONObject? = null
    }

    @JavascriptInterface
    fun isSupported(): Boolean {
        return true
    }

    @JavascriptInterface
    fun startBroadcast(optionsJson: String): String {
        val result = JSONObject()
        try {
            val options = JSONObject(optionsJson)
            pendingBroadcastOptions = options

            val projectionManager = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val captureIntent = projectionManager.createScreenCaptureIntent()

            // Launches Android system permission dialog ("Gaming Hub will start capturing everything...")
            activity.startActivityForResult(captureIntent, REQUEST_MEDIA_PROJECTION)

            result.put("success", true)
            result.put("message", "Requested system screen capture consent dialog")
        } catch (e: Exception) {
            result.put("success", false)
            result.put("error", e.message ?: "Failed to initiate screen capture")
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
}
