package family.brooker.maple

import android.net.Uri
import androidx.core.net.toUri

data class PageLoad(val url: String, val headers: Map<String, String> = emptyMap())

class MapleSite(baseUrl: String) {
    val origin: String = baseUrl.trimEnd('/')
    private val base: Uri = origin.toUri()

    val home: String = "$origin/maple"

    fun googleSignIn(challenge: String): String = "$origin/api/maple/auth/start?native=android&challenge=$challenge"

    fun isApp(url: String?): Boolean = url != null && isApp(url.toUri())

    fun isApp(url: Uri): Boolean =
        url.scheme == base.scheme &&
            url.host.equals(base.host, ignoreCase = true) &&
            url.effectivePort() == base.effectivePort()

    fun isWebGoogleSignIn(url: Uri): Boolean =
        isApp(url) && url.path == "/api/maple/auth/start" && url.getQueryParameter("native") == null

    fun isSignInReturn(url: Uri): Boolean = url.scheme == "maple" && url.host == "auth"

    fun signInReturn(url: Uri, verifier: String): PageLoad? {
        if (!isSignInReturn(url)) return null
        val ticket = rawQueryValue(url, "ticket")
        if (ticket != null && TICKET.matches(ticket)) {
            return PageLoad("$origin/api/maple/auth/native?ticket=$ticket", mapOf(SignInVerifier.HEADER to verifier))
        }
        val reason = url.getQueryParameter("error")?.takeIf { REASON.matches(it) } ?: "failed"
        return PageLoad("$home?auth=$reason")
    }

    private fun rawQueryValue(url: Uri, key: String): String? =
        url.encodedQuery
            ?.split('&')
            ?.firstOrNull { it.startsWith("$key=") }
            ?.substringAfter('=')

    private fun Uri.effectivePort(): Int = if (port != -1) port else if (scheme == "https") 443 else 80

    companion object {
        val current = MapleSite(BuildConfig.MAPLE_BASE_URL)

        private val TICKET = Regex("^[A-Za-z0-9._~%+/=:-]{1,4096}$")
        private val REASON = Regex("^[a-z0-9_]{1,40}$")
    }
}
