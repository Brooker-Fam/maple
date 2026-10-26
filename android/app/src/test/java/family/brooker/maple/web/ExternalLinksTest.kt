package family.brooker.maple.web

import android.content.Intent
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ExternalLinksTest {
    @Test
    fun handsPhoneAndMessageLinksToTheirApps() {
        assertEquals(Intent.ACTION_DIAL, ExternalLinks.intentFor(Uri.parse("tel:911"))?.action)
        assertEquals(Intent.ACTION_SENDTO, ExternalLinks.intentFor(Uri.parse("sms:988"))?.action)
        assertEquals(Intent.ACTION_SENDTO, ExternalLinks.intentFor(Uri.parse("mailto:someone@example.com"))?.action)
    }

    @Test
    fun opensOtherSitesInTheBrowser() {
        val intent = ExternalLinks.intentFor(Uri.parse("https://www.cdc.gov/"))
        assertEquals(Intent.ACTION_VIEW, intent?.action)
        assertTrue(intent!!.hasCategory(Intent.CATEGORY_BROWSABLE))
    }

    @Test
    fun opensNothingForOtherSchemes() {
        assertNull(ExternalLinks.intentFor(Uri.parse("javascript:alert(1)")))
        assertNull(ExternalLinks.intentFor(Uri.parse("intent://scan/#Intent;scheme=zxing;end")))
        assertNull(ExternalLinks.intentFor(Uri.parse("file:///sdcard/secret")))
    }
}
