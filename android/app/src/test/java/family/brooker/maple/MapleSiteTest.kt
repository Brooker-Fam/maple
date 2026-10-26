package family.brooker.maple

import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MapleSiteTest {
    private val site = MapleSite("https://maple.brooker.family/")

    @Test
    fun treatsOnlyTheBaseOriginAsTheApp() {
        assertTrue(site.isApp("https://maple.brooker.family/maple"))
        assertTrue(site.isApp("https://MAPLE.brooker.family:443/api/maple/export"))
        assertFalse(site.isApp("http://maple.brooker.family/maple"))
        assertFalse(site.isApp("https://maple.brooker.family.evil.example/maple"))
        assertFalse(site.isApp("https://evil.example/https://maple.brooker.family"))
        assertFalse(site.isApp("https://maple.brooker.family:8443/maple"))
        assertFalse(site.isApp(null as String?))
    }

    @Test
    fun aDevServerBaseKeepsItsSchemeAndPort() {
        val local = MapleSite("http://10.0.2.2:3000")
        assertTrue(local.isApp("http://10.0.2.2:3000/maple"))
        assertFalse(local.isApp("https://10.0.2.2:3000/maple"))
        assertFalse(local.isApp("http://10.0.2.2/maple"))
    }

    @Test
    fun buildsTheAppUrlsFromTheBase() {
        assertEquals("https://maple.brooker.family/maple", site.home)
        assertEquals(
            "https://maple.brooker.family/api/maple/auth/start?native=android&challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            site.googleSignIn("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"),
        )
    }

    @Test
    fun spotsTheWebGoogleSignInButNotTheNativeOne() {
        assertTrue(site.isWebGoogleSignIn(Uri.parse("https://maple.brooker.family/api/maple/auth/start?return=/maple")))
        assertFalse(site.isWebGoogleSignIn(Uri.parse(site.googleSignIn("x"))))
        assertFalse(site.isWebGoogleSignIn(Uri.parse("https://evil.example/api/maple/auth/start")))
    }

    private fun returnUrl(link: String) = site.signInReturn(Uri.parse(link), "the-verifier")?.url

    @Test
    fun turnsATicketIntoTheNativeSignInUrlUnchangedWithTheVerifier() {
        val page = site.signInReturn(Uri.parse("maple://auth?ticket=eyJtIjoxfQ.c2ln-_%2B"), "the-verifier")
        assertEquals("https://maple.brooker.family/api/maple/auth/native?ticket=eyJtIjoxfQ.c2ln-_%2B", page?.url)
        assertEquals(mapOf("X-Maple-Verifier" to "the-verifier"), page?.headers)
    }

    @Test
    fun cannotSmuggleExtraParametersThroughTheTicket() {
        assertEquals(
            "https://maple.brooker.family/api/maple/auth/native?ticket=abc",
            returnUrl("maple://auth?ticket=abc&return=https://evil.example"),
        )
        assertEquals(
            "https://maple.brooker.family/maple?auth=failed",
            returnUrl("maple://auth?ticket=a%20b<c>"),
        )
    }

    @Test
    fun sendsAnErrorBackToTheSignInScreen() {
        assertEquals("https://maple.brooker.family/maple?auth=not_invited", returnUrl("maple://auth?error=not_invited"))
        assertEquals("https://maple.brooker.family/maple?auth=failed", returnUrl("maple://auth?error=%3Cscript%3E"))
        assertEquals("https://maple.brooker.family/maple?auth=failed", returnUrl("maple://auth"))
        assertEquals(emptyMap<String, String>(), site.signInReturn(Uri.parse("maple://auth?error=denied"), "v")?.headers)
    }

    @Test
    fun ignoresLinksThatAreNotTheSignInReturn() {
        assertNull(returnUrl("maple://other?ticket=abc"))
        assertNull(returnUrl("https://maple.brooker.family/maple?ticket=abc"))
    }
}
