package ng.gaminghub.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import ng.gaminghub.app.broadcaster.GamingHubBridge
import ng.gaminghub.app.broadcaster.ScreenCaptureService

/**
 * MainActivity: Android container activity hosting the Gaming Hub web app in a hardened WebView.
 * Handles MediaProjection system permission results and initiates the ScreenCaptureService.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            webViewClient = WebViewClient()
        }
        setContentView(webView)

        // Inject Native Bridges into WebView JavaScript context
        webView.addJavascriptInterface(AndroidBridge(this), "AndroidBridge")
        webView.addJavascriptInterface(GamingHubBridge(this), "GamingHubAndroidBridge")

        // Load the Gaming Hub web app
        webView.loadUrl("https://ais-dev-r3pz3vsqrgvcuj3brgk6ae-193674771200.europe-west2.run.app")
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == GamingHubBridge.REQUEST_MEDIA_PROJECTION) {
            if (resultCode == Activity.RESULT_OK && data != null) {
                val options = GamingHubBridge.pendingBroadcastOptions
                val serviceIntent = Intent(this, ScreenCaptureService::class.java).apply {
                    action = ScreenCaptureService.ACTION_START
                    putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, resultCode)
                    putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, data)
                    putExtra(ScreenCaptureService.EXTRA_ROOM_ID, options?.optString("roomId"))
                    putExtra(ScreenCaptureService.EXTRA_TOKEN, options?.optString("token"))
                    putExtra(ScreenCaptureService.EXTRA_SERVER_URL, options?.optString("serverUrl"))
                    putExtra(ScreenCaptureService.EXTRA_QUALITY, options?.optString("quality", "auto"))
                    putExtra(ScreenCaptureService.EXTRA_CAPTURE_AUDIO, options?.optBoolean("captureInternalAudio", true) ?: true)
                    putExtra(ScreenCaptureService.EXTRA_GAME_TITLE, options?.optString("gameTitle", "Mobile Game"))
                }
                ContextCompat.startForegroundService(this, serviceIntent)

                // Dispatch confirmation into WebView that native capture service has started
                webView.post {
                    webView.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('gaminghub:native_broadcast_started', { detail: { active: true } }));",
                        null
                    )
                }
            } else {
                GamingHubBridge.pendingBroadcastOptions = null
                webView.post {
                    webView.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('gaminghub:native_broadcast_denied', { detail: { error: 'MediaProjection permission was denied by user' } }));",
                        null
                    )
                }
            }
        }
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
