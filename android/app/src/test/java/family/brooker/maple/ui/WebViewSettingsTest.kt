package family.brooker.maple.ui

import android.webkit.WebView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WebViewSettingsTest {
    @Test
    fun marksTheUserAgentAsTheNativeApp() {
        val webView = WebView(RuntimeEnvironment.getApplication())
        webView.settings.userAgentString = "Mozilla/5.0 (Linux; Android 15) Chrome/140.0"

        webView.configure()

        assertEquals("Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Maple-Native-App/1.0 (android)", webView.settings.userAgentString)
        assertTrue(webView.settings.javaScriptEnabled)
        assertTrue(webView.settings.domStorageEnabled)
    }
}
