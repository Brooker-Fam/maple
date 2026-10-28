import AuthenticationServices
import Network
import UIKit
import WebKit

enum LoadFailure: Equatable {
    case offline
    case unreachable
}

@MainActor
final class MapleBrowser: NSObject, ObservableObject {
    @Published private(set) var failure: LoadFailure?

    let routes = MapleRoutes(base: Config.baseURL)
    let webView: WKWebView

    var signInSession: ASWebAuthenticationSession?
    var signInVerifier: SignInVerifier?
    var pendingDownloads: [ObjectIdentifier: URL] = [:]
    private var lastRequestedURL: URL?
    private let pathMonitor = NWPathMonitor()

    private static let offlineCodes: Set<Int> = [
        NSURLErrorNotConnectedToInternet,
        NSURLErrorNetworkConnectionLost,
        NSURLErrorDataNotAllowed,
        NSURLErrorInternationalRoamingOff,
        NSURLErrorCallIsActive,
    ]

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.applicationNameForUserAgent = Self.applicationName(
            appending: Config.userAgentToken,
            to: configuration.applicationNameForUserAgent
        )
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()

        webView.configuration.userContentController.add(self, name: Config.bridgeName)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsLinkPreview = false
        webView.isOpaque = false
        let background = UIColor(resource: .mapleBackground)
        webView.backgroundColor = background
        webView.scrollView.backgroundColor = background
        // The page lays itself out under the bars with env(safe-area-inset-*) (viewport-fit=cover).
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        webView.isInspectable = true
        #endif

        clearDownloads()
        watchConnectivity()
        load(routes.app)
    }

    static func applicationName(appending token: String, to existing: String?) -> String {
        [existing, token].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
    }

    func load(_ url: URL) {
        load(URLRequest(url: url))
    }

    func load(_ request: URLRequest) {
        lastRequestedURL = request.url
        failure = nil
        webView.load(request)
    }

    func retry() {
        load(lastRequestedURL ?? routes.app)
    }

    func retryIfFailed() {
        if failure != nil { retry() }
    }

    func openExternally(_ url: URL) {
        UIApplication.shared.open(url)
    }

    func present(_ controller: UIViewController) {
        guard var top = webView.window?.rootViewController else { return }
        while let next = top.presentedViewController { top = next }
        if let popover = controller.popoverPresentationController {
            popover.sourceView = webView
            popover.sourceRect = CGRect(x: webView.bounds.midX, y: webView.bounds.maxY - 120, width: 1, height: 1)
        }
        top.present(controller, animated: true)
    }

    private func watchConnectivity() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in
                guard let self, self.failure == .offline else { return }
                self.retry()
            }
        }
        pathMonitor.start(queue: .main)
    }

    fileprivate func showFailure(_ error: Error) {
        let nsError = error as NSError
        guard nsError.domain == NSURLErrorDomain, nsError.code != NSURLErrorCancelled else { return }
        if let failed = nsError.userInfo[NSURLErrorFailingURLErrorKey] as? URL, routes.isOwnHost(failed) {
            lastRequestedURL = failed
        }
        failure = Self.offlineCodes.contains(nsError.code) ? .offline : .unreachable
    }

    fileprivate func handle(_ url: URL, route: LinkRoute) {
        switch route {
        case .stay:
            load(url)
        case .system:
            openExternally(url)
        case .googleSignIn:
            startGoogleSignIn()
        case .appleSignIn:
            startAppleSignIn()
        }
    }
}

extension MapleBrowser: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        guard isMainFrame || navigationAction.navigationType == .linkActivated else {
            decisionHandler(.allow)
            return
        }
        let route = routes.route(for: url)
        guard route == .stay else {
            decisionHandler(.cancel)
            handle(url, route: route)
            return
        }
        if navigationAction.targetFrame?.isMainFrame == true, url.scheme?.hasPrefix("http") == true {
            lastRequestedURL = url
        }
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void
    ) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Disposition")?
            .lowercased() ?? ""
        if !navigationResponse.canShowMIMEType || disposition.hasPrefix("attachment") {
            decisionHandler(.download)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showFailure(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView.url == nil {
            retry()
        } else {
            webView.reload()
        }
    }
}

extension MapleBrowser: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            handle(url, route: routes.route(for: url))
        }
        return nil
    }
}

extension MapleBrowser: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame,
              routes.isOwnOrigin(scheme: origin.protocol, host: origin.host, port: origin.port),
              let bridgeMessage = BridgeMessage.parse(message.body) else { return }
        switch bridgeMessage {
        case .googleSignIn:
            startGoogleSignIn()
        case .appleSignIn:
            startAppleSignIn()
        }
    }
}
