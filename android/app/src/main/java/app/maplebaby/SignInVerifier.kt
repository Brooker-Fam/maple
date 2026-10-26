package app.maplebaby

import android.content.SharedPreferences
import android.util.Base64
import androidx.core.content.edit
import java.security.MessageDigest
import java.security.SecureRandom

object SignInVerifier {
    const val HEADER = "X-Maple-Verifier"

    fun make(): String = base64Url(ByteArray(32).also(SecureRandom()::nextBytes))

    fun challenge(verifier: String): String =
        base64Url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

    private fun base64Url(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
}

// Kept on disk because Android may kill the app while the Custom Tab is open.
class PendingSignIn(
    private val prefs: SharedPreferences,
    private val now: () -> Long = System::currentTimeMillis,
) {
    fun begin(): String {
        val verifier = SignInVerifier.make()
        prefs.edit {
            putString(VERIFIER, verifier)
            putLong(STARTED, now())
        }
        return verifier
    }

    fun take(): String? {
        val verifier = prefs.getString(VERIFIER, null)
        val started = prefs.getLong(STARTED, 0)
        prefs.edit {
            remove(VERIFIER)
            remove(STARTED)
        }
        val age = now() - started
        return verifier?.takeIf { age in 0..MAX_AGE_MS }
    }

    companion object {
        const val PREFS = "sign-in"
        private const val VERIFIER = "verifier"
        private const val STARTED = "started"
        // The server's state cookie lasts 10 minutes, so no sign-in started earlier can still finish.
        private const val MAX_AGE_MS = 10 * 60_000L
    }
}
