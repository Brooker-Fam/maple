import AuthenticationServices

// Google refuses sign-in inside an embedded web view, so it runs in the system's auth session and
// comes back as maple://auth?ticket=… for the web view to redeem.
extension MapleBrowser: ASWebAuthenticationPresentationContextProviding {
    func startGoogleSignIn() {
        guard signInSession == nil else { return }
        guard let verifier = SignInVerifier.make() else {
            load(routes.signInFailed(reason: "failed"))
            return
        }
        signInVerifier = verifier
        let session = ASWebAuthenticationSession(
            url: routes.googleSignInStart(challenge: verifier.challenge),
            callbackURLScheme: Config.callbackScheme
        ) { [weak self] callbackURL, error in
            Task { @MainActor in
                self?.finishGoogleSignIn(callbackURL: callbackURL, error: error)
            }
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        signInSession = session
        if !session.start() {
            signInSession = nil
            signInVerifier = nil
            load(routes.signInFailed(reason: "failed"))
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        webView.window ?? ASPresentationAnchor()
    }

    private func finishGoogleSignIn(callbackURL: URL?, error: Error?) {
        signInSession = nil
        let verifier = signInVerifier
        signInVerifier = nil
        if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
            return
        }
        guard let callbackURL, error == nil else {
            load(routes.signInFailed(reason: "failed"))
            return
        }
        switch MapleRoutes.outcome(of: callbackURL) {
        case .ticket(let ticket):
            guard let verifier else {
                load(routes.signInFailed(reason: "failed"))
                return
            }
            load(routes.nativeSignIn(ticket: ticket, verifier: verifier.value))
        case .failure(let reason):
            load(routes.signInFailed(reason: reason))
        }
    }
}
