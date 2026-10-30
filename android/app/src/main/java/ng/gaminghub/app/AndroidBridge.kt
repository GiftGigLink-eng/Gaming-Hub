package ng.gaminghub.app

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.webkit.JavascriptInterface

/**
 * AndroidBridge: Native Android JavascriptInterface
 *
 * Bridges the Gaming Hub React web app with native Android capabilities:
 * - Package Manager queries and app launch
 * - Native Google Sign-In trigger via Jetpack Credential Manager
 */
class AndroidBridge(private val context: Context) {

    /**
     * Triggers native Google Sign-In using Android Credential Manager.
     * Called from Web frontend when running inside the Android container.
     */
    @JavascriptInterface
    fun triggerGoogleSignIn(requestId: String) {
        if (context is MainActivity) {
            context.runOnUiThread {
                context.startNativeGoogleSignIn(requestId)
            }
        }
    }

    /**
     * Checks if a specific package ID is installed on this Android device.
     * Complies with Android 11+ package visibility through <queries> in AndroidManifest.xml.
     */
    @JavascriptInterface
    fun isPackageInstalled(packageId: String): Boolean {
        return try {
            context.packageManager.getPackageInfo(packageId, 0)
            true
        } catch (e: PackageManager.NameNotFoundException) {
            false
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Launches the game package using the default launch Intent.
     * Returns true if the launch intent was successfully dispatched.
     */
    @JavascriptInterface
    fun launchPackage(packageId: String): Boolean {
        return try {
            val launchIntent = context.packageManager.getLaunchIntentForPackage(packageId)
            if (launchIntent != null) {
                launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(launchIntent)
                true
            } else {
                // Fallback to Google Play Store if not installed or unlaunchable
                val playStoreIntent = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$packageId"))
                playStoreIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(playStoreIntent)
                false
            }
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Returns device manufacturer and model for esports latency profiling.
     */
    @JavascriptInterface
    fun getDeviceModel(): String {
        return "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}"
    }

    /**
     * Returns Android OS API level (e.g. 34 for Android 14).
     */
    @JavascriptInterface
    fun getAndroidVersion(): Int {
        return android.os.Build.VERSION.SDK_INT
    }
}
