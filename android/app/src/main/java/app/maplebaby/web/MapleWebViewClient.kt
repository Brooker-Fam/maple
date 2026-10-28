package app.maplebaby.web

import android.graphics.Bitmap
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import app.maplebaby.MapleSite

class MapleWebViewClient(
    private val site: MapleSite,
    private val onDocumentStarted: (url: String?) -> Unit,
    private val onDocumentFinished: (url: String?) -> Unit,
    private val onUrlChanged: (url: String?) -> Unit,
    private val onMainFrameError: (url: String) -> Unit,
    private val onGoogleSignIn: () -> Unit,
    private val onAppleSignIn: () -> Unit,
    private val onRendererGone: () -> Unit,
) : WebViewClient() {

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url
        if (site.isWebGoogleSignIn(url)) {
            onGoogleSignIn()
            return true
        }
        if (site.isWebAppleSignIn(url)) {
            onAppleSignIn()
            return true
        }
        if (site.isApp(url)) return false
        val web = url.scheme == "http" || url.scheme == "https"
        if (!request.isForMainFrame && web) return false
        ExternalLinks.open(view.context, url)
        return true
    }

    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        super.onPageStarted(view, url, favicon)
        onDocumentStarted(url)
    }

    override fun onPageFinished(view: WebView, url: String?) {
        super.onPageFinished(view, url)
        onDocumentFinished(url)
    }

    override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
        super.doUpdateVisitedHistory(view, url, isReload)
        onUrlChanged(url)
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        super.onReceivedError(view, request, error)
        if (request.isForMainFrame) onMainFrameError(request.url.toString())
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        onRendererGone()
        return true
    }
}
