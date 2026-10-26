package family.brooker.maple.web

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import family.brooker.maple.R

object ExternalLinks {
    fun intentFor(url: Uri): Intent? = when (url.scheme?.lowercase()) {
        "http", "https" -> Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE)
        "tel" -> Intent(Intent.ACTION_DIAL, url)
        "sms", "smsto", "mailto" -> Intent(Intent.ACTION_SENDTO, url)
        "geo" -> Intent(Intent.ACTION_VIEW, url)
        else -> null
    }

    fun open(context: Context, url: Uri) {
        val intent = intentFor(url) ?: return
        if (!context.isInActivity()) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(context, R.string.no_app_for_link, Toast.LENGTH_SHORT).show()
        }
    }

    private fun Context.isInActivity(): Boolean {
        var current: Context? = this
        while (current is ContextWrapper) {
            if (current is Activity) return true
            current = current.baseContext
        }
        return false
    }
}
