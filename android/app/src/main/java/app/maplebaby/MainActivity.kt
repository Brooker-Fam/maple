package app.maplebaby

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.webkit.CookieManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.net.toUri
import app.maplebaby.ui.MapleScreen

class MainActivity : ComponentActivity() {
    private val site = MapleSite.current
    private val signIn by lazy { PendingSignIn(getSharedPreferences(PendingSignIn.PREFS, MODE_PRIVATE)) }
    private var pendingLoad by mutableStateOf<PageLoad?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) pendingLoad = signInReturn(intent)
        setContent {
            MapleScreen(
                site = site,
                pendingLoad = pendingLoad,
                onPendingLoadConsumed = { pendingLoad = null },
                onGoogleSignIn = ::openGoogleSignIn,
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        signInReturn(intent)?.let { pendingLoad = it }
    }

    override fun onStop() {
        super.onStop()
        CookieManager.getInstance().flush()
    }

    // A maple://auth link the app didn't ask for (another app's, or a web page's) is ignored.
    private fun signInReturn(intent: Intent?): PageLoad? {
        val url = intent?.data?.takeIf(site::isSignInReturn) ?: return null
        val verifier = signIn.take() ?: return null
        return site.signInReturn(url, verifier)
    }

    private fun openGoogleSignIn() {
        try {
            CustomTabsIntent.Builder()
                .setShowTitle(true)
                .build()
                .launchUrl(this, site.googleSignIn(SignInVerifier.challenge(signIn.begin())).toUri())
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show()
        }
    }
}
