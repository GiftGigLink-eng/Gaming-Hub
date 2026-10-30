package ng.gaminghub.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.lifecycle.lifecycleScope
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.launch
import ng.gaminghub.app.broadcaster.GamingHubBridge
import ng.gaminghub.app.broadcaster.ScreenCaptureService
import org.json.JSONObject
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean

/**
 * MainActivity: Android container activity hosting the Gaming Hub web app in a hardened WebView.
 * Implements native Android Google Sign-In via Jetpack Credential Manager and handles MediaProjection.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "MainActivity"
        // Web OAuth Client ID from Firebase configuration
        const val WEB_CLIENT_ID = "412030257080-rcsplujisfo70vif40gibte227eug7mk.apps.googleusercontent.com"
    }

    private lateinit var webView: WebView
    private val isSignInInProgress = AtomicBoolean(false)

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

    /**
     * Initiates Native Google Sign-In using Android Jetpack Credential Manager.
     * Prevents concurrent duplicate requests and dispatches results securely via JSON.
     */
    fun startNativeGoogleSignIn(requestId: String) {
        if (!isSignInInProgress.compareAndSet(false, true)) {
            Log.w(TAG, "Google sign-in request already in progress. Ignoring duplicate.")
            dispatchAuthEvent("error", requestId, "Google sign-in is already in progress.")
            return
        }

        lifecycleScope.launch {
            try {
                val credentialManager = CredentialManager.create(this@MainActivity)

                // Generate secure random nonce for authentication verification
                val randomBytes = ByteArray(16)
                SecureRandom().nextBytes(randomBytes)
                val nonce = randomBytes.joinToString("") { "%02x".format(it) }

                val googleIdOption = GetGoogleIdOption.Builder()
                    .setFilterByAuthorizedAccounts(false)
                    .setServerClientId(WEB_CLIENT_ID)
                    .setNonce(nonce)
                    .setAutoSelectEnabled(false)
                    .build()

                val request = GetCredentialRequest.Builder()
                    .addCredentialOption(googleIdOption)
                    .build()

                val result = credentialManager.getCredential(
                    context = this@MainActivity,
                    request = request
                )

                val credential = result.credential
                if (credential is CustomCredential &&
                    credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
                ) {
                    val googleIdTokenCredential = GoogleIdTokenCredential.createFrom(credential.data)
                    val idToken = googleIdTokenCredential.idToken

                    if (!idToken.isNullOrBlank()) {
                        // Dispatch token securely to Web layer
                        dispatchAuthSuccess(requestId, idToken)
                    } else {
                        dispatchAuthEvent("error", requestId, "Empty Google ID token received.")
                    }
                } else {
                    dispatchAuthEvent("error", requestId, "Unsupported credential format received from provider.")
                }
            } catch (e: GetCredentialCancellationException) {
                Log.i(TAG, "User cancelled Google Sign-In flow.")
                dispatchAuthEvent("cancelled", requestId, "Sign-in cancelled by player.")
            } catch (e: GetCredentialException) {
                Log.e(TAG, "Credential Manager error during Google Sign-In: ${e.message}", e)
                dispatchAuthEvent("error", requestId, e.message ?: "Authentication failed via Google Play Services.")
            } catch (e: Exception) {
                Log.e(TAG, "Unexpected error during native sign-in: ${e.message}", e)
                dispatchAuthEvent("error", requestId, e.message ?: "An unexpected error occurred during sign-in.")
            } finally {
                isSignInInProgress.set(false)
            }
        }
    }

    /**
     * Dispatches successful ID token to WebView using a safe JSON string payload.
     * Tokens are neither logged nor string-interpolated directly into script bodies.
     */
    private fun dispatchAuthSuccess(requestId: String, idToken: String) {
        val payload = JSONObject().apply {
            put("type", "success")
            put("requestId", requestId)
            put("idToken", idToken)
        }

        webView.post {
            val script = "(function() { window.dispatchEvent(new CustomEvent('gaminghub:native_auth_response', { detail: $payload })); })();"
            webView.evaluateJavascript(script, null)
        }
    }

    /**
     * Dispatches cancellation or error events to WebView using safe JSON serialization.
     */
    private fun dispatchAuthEvent(type: String, requestId: String, message: String) {
        val payload = JSONObject().apply {
            put("type", type)
            put("requestId", requestId)
            put("error", message)
        }

        webView.post {
            val script = "(function() { window.dispatchEvent(new CustomEvent('gaminghub:native_auth_response', { detail: $payload })); })();"
            webView.evaluateJavascript(script, null)
        }
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
