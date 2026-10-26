import Foundation

enum BridgeMessage: Equatable {
    case googleSignIn

    static func parse(_ body: Any) -> BridgeMessage? {
        switch type(of: body) {
        case "google-sign-in": return .googleSignIn
        default: return nil
        }
    }

    private static func type(of body: Any) -> String? {
        if let object = body as? [String: Any] {
            return object["type"] as? String
        }
        guard let text = body as? String,
              let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return object["type"] as? String
    }
}
