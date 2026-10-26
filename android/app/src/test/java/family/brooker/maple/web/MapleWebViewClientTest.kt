package family.brooker.maple.web

import android.content.Intent
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebView
import family.brooker.maple.MapleSite
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MapleWebViewClientTest {
    private val app = RuntimeEnvironment.getApplication()
    private val webView = WebView(app)
    private var signIns = 0
    private val client = MapleWebViewClient(
        site = MapleSite("https://maplebaby.app"),
        onDocumentStarted = {},
        onDocumentFinished = {},
        onUrlChanged = {},
        onMainFrameError = {},
        onGoogleSignIn = { signIns++ },
        onRendererGone = {},
    )

    private fun request(url: String, mainFrame: Boolean = true) = object : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse(url)
        override fun isForMainFrame() = mainFrame
        override fun isRedirect() = false
        override fun hasGesture() = true
        override fun getMethod() = "GET"
        override fun getRequestHeaders() = emptyMap<String, String>()
    }

    private fun nextStarted(): Intent? = shadowOf(app).nextStartedActivity

    @Test
    fun keepsTheAppInTheWebView() {
        assertFalse(client.shouldOverrideUrlLoading(webView, request("https://maplebaby.app/maple/connect")))
        assertNull(nextStarted())
    }

    @Test
    fun sendsOtherSitesAndPhoneNumbersToThePhone() {
        assertTrue(client.shouldOverrideUrlLoading(webView, request("https://www.cdc.gov/")))
        assertEquals(Intent.ACTION_VIEW, nextStarted()?.action)
        assertTrue(client.shouldOverrideUrlLoading(webView, request("tel:911")))
        assertEquals(Intent.ACTION_DIAL, nextStarted()?.action)
    }

    @Test
    fun routesGoogleSignInThroughTheSystemBrowser() {
        assertTrue(client.shouldOverrideUrlLoading(webView, request("https://maplebaby.app/api/maple/auth/start?return=/maple")))
        assertEquals(1, signIns)
        assertNull(nextStarted())
    }

    @Test
    fun dropsASignInReturnFromInsideAPage() {
        for (mainFrame in listOf(true, false)) {
            assertTrue(client.shouldOverrideUrlLoading(webView, request("maple://auth?ticket=abc", mainFrame)))
        }
        assertNull(shadowOf(webView).lastLoadedUrl)
        assertNull(nextStarted())
    }
}
