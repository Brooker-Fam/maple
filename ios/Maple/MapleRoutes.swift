import Foundation

enum LinkRoute: Equatable {
    case stay
    case system
    case googleSignIn
}

enum SignInOutcome: Equatable {
    case ticket(String)
    case failure(reason: String)
}

struct MapleRoutes {
    let base: URL

    var app: URL { base.appending(path: "maple") }

    func googleSignInStart(challenge: String) -> URL {
        var components = URLComponents(url: base.appending(path: "api/maple/auth/start"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "native", value: "ios"), URLQueryItem(name: "challenge", value: challenge)]
        return components.url!
    }

    func nativeSignIn(ticket: String, verifier: String) -> URLRequest {
        var components = URLComponents(url: base.appending(path: "api/maple/auth/native"), resolvingAgainstBaseURL: false)!
        components.percentEncodedQuery = "ticket=" + Self.strictlyEncoded(ticket)
        var request = URLRequest(url: components.url!)
        request.setValue(verifier, forHTTPHeaderField: SignInVerifier.header)
        return request
    }

    func signInFailed(reason: String) -> URL {
        var components = URLComponents(url: app, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "auth", value: Self.sanitizedReason(reason))]
        return components.url!
    }

    func route(for url: URL) -> LinkRoute {
        switch url.scheme?.lowercased() {
        case "http", "https":
            guard isOwnHost(url) else { return .system }
            return url.path == "/api/maple/auth/start" ? .googleSignIn : .stay
        case nil, "about", "blob", "data":
            return .stay
        default:
            return .system
        }
    }

    func isOwnHost(_ url: URL) -> Bool {
        isOwnOrigin(scheme: url.scheme, host: url.host, port: url.port)
    }

    // WKSecurityOrigin reports a default port as 0.
    func isOwnOrigin(scheme: String?, host: String?, port: Int?) -> Bool {
        guard let scheme = scheme?.lowercased(), scheme == base.scheme?.lowercased(),
              let host = host?.lowercased(), host == base.host?.lowercased() else { return false }
        return Self.effectivePort(port, scheme: scheme) == Self.effectivePort(base.port, scheme: scheme)
    }

    private static func effectivePort(_ port: Int?, scheme: String) -> Int? {
        if let port, port != 0 { return port }
        switch scheme {
        case "https": return 443
        case "http": return 80
        default: return nil
        }
    }

    static func outcome(of callback: URL) -> SignInOutcome {
        guard callback.scheme?.lowercased() == Config.callbackScheme,
              callback.host?.lowercased() == "auth",
              let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems else {
            return .failure(reason: "failed")
        }
        if let ticket = items.first(where: { $0.name == "ticket" })?.value, !ticket.isEmpty {
            return .ticket(ticket)
        }
        return .failure(reason: items.first(where: { $0.name == "error" })?.value ?? "failed")
    }

    // A ticket may be standard base64, and a raw "+" in a query string reads back as a space.
    private static func strictlyEncoded(_ value: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }

    private static func sanitizedReason(_ reason: String) -> String {
        let plain = reason.count <= 40 && reason != "ok" && !reason.isEmpty
            && reason.allSatisfy { ("a"..."z").contains($0) || $0 == "_" }
        return plain ? reason : "failed"
    }
}
