import Foundation

enum Config {
    static let fallbackBaseURL = URL(string: "https://maplebaby.app")!

    static let baseURL: URL = baseURL(from: Bundle.main.object(forInfoDictionaryKey: "MapleBaseURL") as? String)

    // Bridge 1.1 adds Apple sign-in; web pages gate its button for older shells.
    static let userAgentToken = "Maple-Native-App/1.1 (ios)"

    static let bridgeName = "nativeApp"

    static let callbackScheme = "maple"

    static func baseURL(from raw: String?) -> URL {
        var text = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              url.host?.isEmpty == false else {
            return fallbackBaseURL
        }
        return url
    }
}
