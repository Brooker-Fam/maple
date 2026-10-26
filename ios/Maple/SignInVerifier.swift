import CryptoKit
import Foundation
import Security

struct SignInVerifier: Equatable {
    static let header = "X-Maple-Verifier"

    let value: String

    var challenge: String {
        Self.base64URL(Data(SHA256.hash(data: Data(value.utf8))))
    }

    static func make() -> SignInVerifier? {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
        return SignInVerifier(value: base64URL(Data(bytes)))
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
