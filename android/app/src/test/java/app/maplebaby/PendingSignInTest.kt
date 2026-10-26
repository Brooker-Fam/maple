package app.maplebaby

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PendingSignInTest {
    private val prefs = RuntimeEnvironment.getApplication().getSharedPreferences("sign-in-test", Context.MODE_PRIVATE)
    private var clock = 1_000_000L
    private val pending = PendingSignIn(prefs) { clock }

    @Test
    fun theChallengeIsTheRfc7636Hash() {
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", SignInVerifier.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
        val made = SignInVerifier.make()
        assertTrue(Regex("^[A-Za-z0-9_-]{43}$").matches(made))
        assertNotEquals(made, SignInVerifier.make())
    }

    @Test
    fun aReturnWithNoSignInStartedIsIgnored() {
        assertNull(pending.take())
    }

    @Test
    fun aSignInIsTakenOnce() {
        val verifier = pending.begin()
        clock += 60_000
        assertEquals(verifier, pending.take())
        assertNull(pending.take())
    }

    @Test
    fun aStaleSignInIsIgnoredAndCleared() {
        pending.begin()
        clock += 10 * 60_000 + 1
        assertNull(pending.take())
        clock -= 10 * 60_000
        assertNull(pending.take())
    }

    @Test
    fun aNewSignInReplacesTheOldOne() {
        val first = pending.begin()
        val second = pending.begin()
        assertNotEquals(first, second)
        assertEquals(second, pending.take())
    }
}
