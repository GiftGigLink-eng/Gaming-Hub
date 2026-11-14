package ng.gaminghub.app

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.webkit.JavascriptInterface
import java.nio.ByteBuffer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

import android.security.keystore.KeyInfo
import javax.crypto.SecretKeyFactory

/**
 * AndroidKeystoreVault
 *
 * Provides secure storage using the Android KeyStore provider.
 * Uses AES-256 in Galois/Counter Mode (GCM) with NoPadding.
 *
 * Explicit Security Level Verification:
 * Inspects KeyInfo.isInsideSecureHardware() via SecretKeyFactory to determine
 * whether the generated key is backed by dedicated secure hardware (TEE / StrongBox)
 * or operating via a software-backed keystore fallback.
 *
 * Encrypted payload format:
 * [1 byte: IV length (12)] + [12 bytes: IV] + [N bytes: ciphertext with 128-bit GCM tag]
 * Stored in private SharedPreferences as Base64.
 *
 * Zero token logging: Never logs keys, ciphertexts, or decrypted values.
 */
class AndroidKeystoreVault(private val context: Context) {

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "GamingHubKeystoreVaultMasterKey"
        private const val CIPHER_TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_IV_LENGTH = 12
        private const val GCM_TAG_LENGTH_BITS = 128
        private const val PREFS_NAME = "gaming_hub_keystore_vault"
    }

    private val prefs by lazy {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    fun isAvailable(): Boolean {
        return try {
            getOrCreateSecretKey() != null
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Checks if the KeyStore key is backed by dedicated secure hardware (TEE / StrongBox).
     * Returns true if verified inside hardware, false if software-backed, null if key unavailable.
     */
    fun isHardwareBacked(): Boolean {
        return try {
            val secretKey = getOrCreateSecretKey() ?: return false
            val factory = SecretKeyFactory.getInstance(secretKey.algorithm, ANDROID_KEYSTORE)
            val keyInfo = factory.getKeySpec(secretKey, KeyInfo::class.java) as? KeyInfo
            keyInfo?.isInsideSecureHardware ?: false
        } catch (e: Exception) {
            // Emulators, rooted systems, or software KeyStore fallbacks throw or fail gracefully
            false
        }
    }

    /**
     * Accurately reports storage security classification:
     * - "hardware_keystore": KeyStore active AND verified inside secure hardware (TEE / StrongBox)
     * - "software_keystore": KeyStore active and functional, but operating without hardware backing
     * - "unavailable": KeyStore is not functional or cannot generate/retrieve keys
     */
    fun getSecurityLevel(): String {
        if (!isAvailable()) {
            return "unavailable"
        }
        return if (isHardwareBacked()) {
            "hardware_keystore"
        } else {
            "software_keystore"
        }
    }

    private fun getOrCreateSecretKey(): SecretKey? {
        return try {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            if (keyStore.containsAlias(KEY_ALIAS)) {
                val entry = keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
                return entry?.secretKey
            }

            val keyGenerator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES,
                ANDROID_KEYSTORE
            )
            val keyGenSpec = KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()

            keyGenerator.init(keyGenSpec)
            keyGenerator.generateKey()
        } catch (e: Exception) {
            null
        }
    }

    fun setItem(key: String, value: String): Boolean {
        if (key.isBlank()) return false
        return try {
            val secretKey = getOrCreateSecretKey() ?: return false
            val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, secretKey)

            val iv = cipher.iv ?: return false
            val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))

            val buffer = ByteBuffer.allocate(1 + iv.size + ciphertext.size)
            buffer.put(iv.size.toByte())
            buffer.put(iv)
            buffer.put(ciphertext)

            val encoded = Base64.encodeToString(buffer.array(), Base64.NO_WRAP)
            prefs.edit().putString(key, encoded).commit()
        } catch (e: Exception) {
            false
        }
    }

    fun getItem(key: String): String? {
        if (key.isBlank()) return null
        return try {
            val encoded = prefs.getString(key, null) ?: return null
            val raw = Base64.decode(encoded, Base64.NO_WRAP)
            if (raw.size <= 1 + GCM_IV_LENGTH) return null

            val buffer = ByteBuffer.wrap(raw)
            val ivLength = buffer.get().toInt()
            if (ivLength != GCM_IV_LENGTH || buffer.remaining() <= ivLength) return null

            val iv = ByteArray(ivLength)
            buffer.get(iv)

            val ciphertext = ByteArray(buffer.remaining())
            buffer.get(ciphertext)

            val secretKey = getOrCreateSecretKey() ?: return null
            val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
            val spec = GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv)
            cipher.init(Cipher.DECRYPT_MODE, secretKey, spec)

            val decrypted = cipher.doFinal(ciphertext)
            String(decrypted, Charsets.UTF_8)
        } catch (e: Exception) {
            try {
                prefs.edit().remove(key).apply()
            } catch (_: Exception) {}
            null
        }
    }

    fun removeItem(key: String): Boolean {
        if (key.isBlank()) return false
        return try {
            prefs.edit().remove(key).commit()
        } catch (e: Exception) {
            false
        }
    }
}

/**
 * AndroidBridge: Native Android JavascriptInterface
 *
 * Bridges the Gaming Hub React web app with native Android capabilities:
 * - Package Manager queries and app launch
 * - Native Google Sign-In trigger via Jetpack Credential Manager
 * - Native Android Keystore hardware-backed secure storage for refresh tokens
 */
class AndroidBridge(private val context: Context) {

    private val secureVault = AndroidKeystoreVault(context)

    // =========================================================================
    // NATIVE ANDROID KEYSTORE SECURE STORAGE (Stage 3.2 Hardening & Verification)
    // =========================================================================

    /**
     * Confirms whether Android Keystore secure storage is active and operational.
     */
    @JavascriptInterface
    fun isSecureStorageAvailable(): Boolean {
        return secureVault.isAvailable()
    }

    /**
     * Explicitly checks whether the active KeyStore key is backed by secure hardware (TEE / StrongBox).
     * Never claims hardware backing when unverified or running on software fallbacks.
     */
    @JavascriptInterface
    fun isHardwareBacked(): Boolean {
        return secureVault.isHardwareBacked()
    }

    /**
     * Returns the verified storage security classification:
     * "hardware_keystore", "software_keystore", or "unavailable"
     */
    @JavascriptInterface
    fun getStorageSecurityLevel(): String {
        return secureVault.getSecurityLevel()
    }

    /**
     * Securely retrieves a decrypted string from Android Keystore storage.
     * Returns null if key does not exist or decryption fails.
     */
    @JavascriptInterface
    fun getSecureItem(key: String): String? {
        return secureVault.getItem(key)
    }

    /**
     * Encrypts and securely persists a string using Android Keystore AES-256-GCM.
     * Preserves encrypted storage functionality whether backed by hardware or software KeyStore.
     * Returns true on success, false on any crypto or IO failure.
     */
    @JavascriptInterface
    fun setSecureItem(key: String, value: String): Boolean {
        return secureVault.setItem(key, value)
    }

    /**
     * Removes an item from secure storage.
     */
    @JavascriptInterface
    fun removeSecureItem(key: String): Boolean {
        return secureVault.removeItem(key)
    }

    // =========================================================================
    // NATIVE GOOGLE SIGN-IN & APP LIFECYCLE
    // =========================================================================

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
