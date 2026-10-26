package app.maplebaby.web

import android.net.Uri
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import app.maplebaby.MapleSite
import org.json.JSONException
import org.json.JSONObject

class NativeBridge(
    private val site: MapleSite,
    private val onGoogleSignIn: () -> Unit,
    private val onTheme: (argb: Int) -> Unit,
) : WebViewCompat.WebMessageListener {

    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        receive(message.data, sourceOrigin, isMainFrame)
    }

    fun receive(message: String?, sourceOrigin: Uri, isMainFrame: Boolean) {
        if (!isMainFrame || !site.isApp(sourceOrigin) || message == null) return
        val body = try {
            JSONObject(message)
        } catch (_: JSONException) {
            return
        }
        when (body.optString("type")) {
            "google-sign-in" -> onGoogleSignIn()
            "theme" -> themeColor(body.optString("color"))?.let(onTheme)
        }
    }

    companion object {
        const val NAME = "nativeApp"

        private val HEX = Regex("^#[0-9A-Fa-f]{6}$")

        fun themeColor(raw: String): Int? =
            if (HEX.matches(raw)) (0xFF000000L or raw.substring(1).toLong(16)).toInt() else null

        val WEBKIT_SHIM_JS = """
            (function() {
                if (window.webkit && window.webkit.messageHandlers) return;
                window.webkit = { messageHandlers: { nativeApp: { postMessage: function(msg) {
                    window.nativeApp.postMessage(typeof msg === 'string' ? msg : JSON.stringify(msg));
                } } } };
            })();
        """.trimIndent()
    }
}
