package app.maplebaby.ui

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.net.Uri
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient.FileChooserParams
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.maplebaby.BuildConfig
import app.maplebaby.MapleSite
import app.maplebaby.PageLoad
import app.maplebaby.web.Downloads
import app.maplebaby.web.FilePicker
import app.maplebaby.web.MapleWebChromeClient
import app.maplebaby.web.MapleWebViewClient
import app.maplebaby.web.NativeBridge

private class LoadState {
    var lastUrl: String? = null
    var failed = false
    var clearHistoryAfterSignIn = false
}

@Composable
fun MapleScreen(
    site: MapleSite,
    pendingLoad: PageLoad?,
    onPendingLoadConsumed: () -> Unit,
    onGoogleSignIn: () -> Unit,
    onAppleSignIn: () -> Unit,
) {
    val context = LocalContext.current
    val colors = mapleColors()
    val load = remember { LoadState() }
    var generation by remember { mutableIntStateOf(0) }
    var webView by remember { mutableStateOf<WebView?>(null) }
    var canGoBack by remember { mutableStateOf(false) }
    var failedUrl by remember { mutableStateOf<String?>(null) }
    var retrying by remember { mutableStateOf(false) }
    var pageColor by remember { mutableStateOf<Color?>(null) }
    val barColor = pageColor?.takeIf { failedUrl == null } ?: colors.bg
    val darkBars = barColor.luminance() < 0.5f
    val activity = LocalActivity.current as? ComponentActivity
    LaunchedEffect(activity, darkBars) {
        val style = if (darkBars) {
            SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
        } else {
            SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT)
        }
        activity?.enableEdgeToEdge(style, style)
    }

    var fileCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    var photoUri by remember { mutableStateOf<Uri?>(null) }
    fun deliverFiles(uris: Array<Uri>?) {
        fileCallback?.onReceiveValue(uris)
        fileCallback = null
    }
    val pickFiles = rememberLauncherForActivityResult(FilePicker.PickFiles()) { uris ->
        deliverFiles(uris.toTypedArray())
    }
    val takePhoto = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        val uri = photoUri
        photoUri = null
        deliverFiles(if (saved && uri != null) arrayOf(uri) else null)
    }
    fun chooseFiles(callback: ValueCallback<Array<Uri>>, params: FileChooserParams) {
        fileCallback?.onReceiveValue(null)
        fileCallback = callback
        if (FilePicker.wantsCamera(params.isCaptureEnabled, params.acceptTypes)) {
            try {
                val uri = FilePicker.newPhotoUri(context)
                photoUri = uri
                takePhoto.launch(uri)
                return
            } catch (_: ActivityNotFoundException) {
                photoUri = null
            }
        }
        try {
            pickFiles.launch(
                FilePicker.Request(
                    mimeTypes = FilePicker.mimeTypes(params.acceptTypes),
                    allowMultiple = params.mode == FileChooserParams.MODE_OPEN_MULTIPLE,
                ),
            )
        } catch (_: ActivityNotFoundException) {
            deliverFiles(null)
        }
    }

    BackHandler(enabled = canGoBack) {
        webView?.goBack()
    }

    LaunchedEffect(pendingLoad, webView) {
        val wv = webView ?: return@LaunchedEffect
        val page = pendingLoad ?: return@LaunchedEffect
        load.clearHistoryAfterSignIn = true
        wv.loadUrl(page.url, page.headers)
        onPendingLoadConsumed()
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(barColor)
            .windowInsetsPadding(WindowInsets.safeDrawing),
    ) {
        key(generation) {
            AndroidView(
                factory = { viewContext ->
                    WebView(viewContext).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT,
                        )
                        setBackgroundColor(colors.bg.toArgb())
                        // Compose pads by the bars and keyboard; insets reaching the page as env(safe-area-inset-*) would pad it twice.
                        ViewCompat.setOnApplyWindowInsetsListener(this) { _, _ -> WindowInsetsCompat.CONSUMED }
                        configure()

                        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                            val bridge = NativeBridge(site, onGoogleSignIn, onAppleSignIn) { argb -> pageColor = Color(argb) }
                            WebViewCompat.addWebMessageListener(this, NativeBridge.NAME, setOf(site.origin), bridge)
                        }
                        var shimAtDocumentStart = false
                        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                            WebViewCompat.addDocumentStartJavaScript(this, NativeBridge.WEBKIT_SHIM_JS, setOf(site.origin))
                            shimAtDocumentStart = true
                        }

                        webViewClient = MapleWebViewClient(
                            site = site,
                            onDocumentStarted = { load.failed = false },
                            onDocumentFinished = { url ->
                                if (!shimAtDocumentStart && site.isApp(url)) {
                                    evaluateJavascript(NativeBridge.WEBKIT_SHIM_JS, null)
                                }
                                if (!load.failed) {
                                    failedUrl = null
                                    retrying = false
                                    load.lastUrl = url
                                    if (load.clearHistoryAfterSignIn && site.isApp(url) && !url.orEmpty().contains("/api/maple/auth/")) {
                                        load.clearHistoryAfterSignIn = false
                                        clearHistory()
                                    }
                                }
                                canGoBack = canGoBack()
                            },
                            onUrlChanged = { url ->
                                if (!load.failed) load.lastUrl = url
                                canGoBack = canGoBack()
                            },
                            onMainFrameError = { url ->
                                load.failed = true
                                failedUrl = url
                                retrying = false
                            },
                            onGoogleSignIn = onGoogleSignIn,
                            onAppleSignIn = onAppleSignIn,
                            onRendererGone = { generation++ },
                        )
                        webChromeClient = MapleWebChromeClient(::chooseFiles)
                        setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
                            Downloads.start(context, url, userAgent, contentDisposition, mimeType)
                        }

                        webView = this
                        loadUrl(load.lastUrl?.takeIf(site::isApp) ?: site.home)
                    }
                },
                onRelease = { released ->
                    if (webView === released) webView = null
                    released.destroy()
                },
                modifier = Modifier.fillMaxSize(),
            )
        }

        failedUrl?.let { url ->
            OfflineScreen(
                retrying = retrying,
                onRetry = {
                    retrying = true
                    webView?.loadUrl(url)
                },
            )
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
internal fun WebView.configure() {
    if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    settings.userAgentString = "${settings.userAgentString} $USER_AGENT_SUFFIX"
    CookieManager.getInstance().apply {
        setAcceptCookie(true)
        setAcceptThirdPartyCookies(this@configure, true)
    }
}

// Bridge 1.1 adds Apple sign-in; web pages gate its button for older shells.
internal const val USER_AGENT_SUFFIX = "Maple-Native-App/1.1 (android)"
