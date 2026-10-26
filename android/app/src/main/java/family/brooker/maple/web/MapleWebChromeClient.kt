package family.brooker.maple.web

import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView

class MapleWebChromeClient(
    private val onFileChooser: (ValueCallback<Array<Uri>>, FileChooserParams) -> Unit,
) : WebChromeClient() {

    override fun onShowFileChooser(
        webView: WebView,
        filePathCallback: ValueCallback<Array<Uri>>,
        fileChooserParams: FileChooserParams,
    ): Boolean {
        onFileChooser(filePathCallback, fileChooserParams)
        return true
    }
}
