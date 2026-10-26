package family.brooker.maple.web

import android.net.Uri
import family.brooker.maple.MapleSite
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NativeBridgeTest {
    private var signIns = 0
    private val themes = mutableListOf<Int>()
    private val bridge = NativeBridge(MapleSite("https://maplebaby.app"), { signIns++ }, { themes += it })
    private val maple = Uri.parse("https://maplebaby.app")

    @Test
    fun startsGoogleSignInFromTheAppsMainFrame() {
        bridge.receive("""{"type":"google-sign-in"}""", maple, isMainFrame = true)
        assertEquals(1, signIns)
    }

    @Test
    fun ignoresSubframesEvenOnTheAppsOrigin() {
        bridge.receive("""{"type":"google-sign-in"}""", maple, isMainFrame = false)
        bridge.receive("""{"type":"theme","color":"#0B0F0A"}""", maple, isMainFrame = false)
        assertEquals(0, signIns)
        assertEquals(emptyList<Int>(), themes)
    }

    @Test
    fun ignoresOtherOrigins() {
        for (origin in listOf("https://maplebaby.app.evil.example", "http://maplebaby.app", "https://maplebaby.app:8443", "null")) {
            bridge.receive("""{"type":"google-sign-in"}""", Uri.parse(origin), isMainFrame = true)
        }
        assertEquals(0, signIns)
    }

    @Test
    fun passesOnThePagesThemeColor() {
        bridge.receive("""{"type":"theme","color":"#0B0F0A"}""", maple, isMainFrame = true)
        bridge.receive("""{"type":"theme","color":"#f6f3ec"}""", maple, isMainFrame = true)
        assertEquals(listOf(0xFF0B0F0A.toInt(), 0xFFF6F3EC.toInt()), themes)
    }

    @Test
    fun ignoresMalformedAndUnknownMessages() {
        for (message in listOf("not json", """{"type":"something-else"}""", """["google-sign-in"]""", null)) {
            bridge.receive(message, maple, isMainFrame = true)
        }
        for (color in listOf("red", "#FFF", "#0B0F0A80", "", "javascript:x")) {
            bridge.receive("""{"type":"theme","color":"$color"}""", maple, isMainFrame = true)
        }
        assertEquals(0, signIns)
        assertEquals(emptyList<Int>(), themes)
    }
}
