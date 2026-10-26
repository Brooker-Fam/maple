package app.maplebaby.web

import android.app.DownloadManager
import android.content.Context
import android.os.Build
import android.os.Environment
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.widget.Toast
import androidx.core.net.toUri
import app.maplebaby.R

object Downloads {
    fun start(context: Context, url: String, userAgent: String, contentDisposition: String?, mimeType: String?) {
        val uri = url.toUri()
        if (uri.scheme != "https") {
            Toast.makeText(context, R.string.download_failed, Toast.LENGTH_SHORT).show()
            return
        }
        val fileName = URLUtil.guessFileName(url, contentDisposition, mimeType)
        val request = DownloadManager.Request(uri)
            .setMimeType(mimeType)
            .addRequestHeader("User-Agent", userAgent)
            .setTitle(fileName)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        CookieManager.getInstance().getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
        } else {
            // Public Downloads needs WRITE_EXTERNAL_STORAGE before Android 10; the app's own folder doesn't.
            request.setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, fileName)
        }
        try {
            context.getSystemService(DownloadManager::class.java).enqueue(request)
            Toast.makeText(context, context.getString(R.string.download_started, fileName), Toast.LENGTH_SHORT).show()
        } catch (_: RuntimeException) {
            Toast.makeText(context, R.string.download_failed, Toast.LENGTH_SHORT).show()
        }
    }
}
