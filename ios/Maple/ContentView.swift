import SwiftUI
import WebKit

struct ContentView: View {
    @StateObject private var browser = MapleBrowser()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Color.mapleBackground.ignoresSafeArea()
            WebViewContainer(webView: browser.webView)
                .ignoresSafeArea()
            if let failure = browser.failure {
                OfflineView(failure: failure, onRetry: browser.retry)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: browser.failure)
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { browser.retryIfFailed() }
        }
    }
}

private struct WebViewContainer: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }

    func updateUIView(_ webView: WKWebView, context: Context) {}
}
