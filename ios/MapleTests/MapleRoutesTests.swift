import XCTest
@testable import Maple

final class MapleRoutesTests: XCTestCase {
    private let routes = MapleRoutes(base: URL(string: "https://maple.example.test")!)

    func testPhoneTextAndMailLinksGoToTheSystem() {
        for link in ["tel:911", "tel:988", "sms:988", "mailto:family@example.test"] {
            XCTAssertEqual(routes.route(for: URL(string: link)!), .system, link)
        }
    }

    func testOtherHostsGoToTheSystemAndOwnPagesStay() {
        XCTAssertEqual(routes.route(for: URL(string: "https://claude.ai/settings")!), .system)
        XCTAssertEqual(routes.route(for: URL(string: "https://example.test/maple")!), .system)
        XCTAssertEqual(routes.route(for: URL(string: "https://MAPLE.example.test/maple?tab=log")!), .stay)
        XCTAssertEqual(routes.route(for: URL(string: "https://maple.example.test/api/maple/export")!), .stay)
        XCTAssertEqual(routes.route(for: URL(string: "about:blank")!), .stay)
    }

    func testOnlyTheBaseSchemeAndPortCountAsTheApp() {
        XCTAssertEqual(routes.route(for: URL(string: "https://maple.example.test:443/maple")!), .stay)
        XCTAssertEqual(routes.route(for: URL(string: "http://maple.example.test/maple")!), .system)
        XCTAssertEqual(routes.route(for: URL(string: "https://maple.example.test:8443/maple")!), .system)
        XCTAssertEqual(routes.route(for: URL(string: "https://maple.example.test.evil.test/maple")!), .system)
    }

    func testTheBridgeAcceptsOnlyTheBaseOrigin() {
        XCTAssertTrue(routes.isOwnOrigin(scheme: "https", host: "maple.example.test", port: 0))
        XCTAssertTrue(routes.isOwnOrigin(scheme: "https", host: "MAPLE.example.test", port: 443))
        XCTAssertFalse(routes.isOwnOrigin(scheme: "https", host: "maple.example.test", port: 8443))
        XCTAssertFalse(routes.isOwnOrigin(scheme: "http", host: "maple.example.test", port: 0))
        XCTAssertFalse(routes.isOwnOrigin(scheme: "https", host: "example.test", port: 0))

        let local = MapleRoutes(base: URL(string: "http://127.0.0.1:3000")!)
        XCTAssertTrue(local.isOwnOrigin(scheme: "http", host: "127.0.0.1", port: 3000))
        XCTAssertFalse(local.isOwnOrigin(scheme: "http", host: "127.0.0.1", port: 0))
        XCTAssertEqual(local.route(for: URL(string: "http://127.0.0.1:3000/maple")!), .stay)
        XCTAssertEqual(local.route(for: URL(string: "http://127.0.0.1:4000/maple")!), .system)
    }

    func testTheWebSignInLinkStartsNativeSignIn() {
        let link = URL(string: "https://maple.example.test/api/maple/auth/start?return=%2Fmaple")!
        XCTAssertEqual(routes.route(for: link), .googleSignIn)
    }

    func testSignInStartsWithTheNativeFlagAndChallenge() {
        XCTAssertEqual(
            routes.googleSignInStart(challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM").absoluteString,
            "https://maple.example.test/api/maple/auth/start?native=ios&challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        )
    }

    func testVerifierHashesToItsChallengeAsInRFC7636() {
        XCTAssertEqual(
            SignInVerifier(value: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk").challenge,
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        )
        let made = SignInVerifier.make()
        XCTAssertEqual(made?.value.count, 43)
        XCTAssertNotEqual(made, SignInVerifier.make())
        XCTAssertNil(made?.value.rangeOfCharacter(from: CharacterSet(charactersIn: "+/=")))
    }

    func testTicketCallbackIsRedeemedWithItsPlusSignsIntact() {
        let callback = URL(string: "maple://auth?ticket=ab%2Bc/d%3D")!
        guard case .ticket(let ticket) = MapleRoutes.outcome(of: callback) else {
            return XCTFail("expected a ticket")
        }
        XCTAssertEqual(ticket, "ab+c/d=")
        let request = routes.nativeSignIn(ticket: ticket, verifier: "the-verifier")
        XCTAssertEqual(request.url?.absoluteString, "https://maple.example.test/api/maple/auth/native?ticket=ab%2Bc%2Fd%3D")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Maple-Verifier"), "the-verifier")
    }

    func testErrorCallbackShowsTheWebAppsMessage() {
        XCTAssertEqual(MapleRoutes.outcome(of: URL(string: "maple://auth?error=not_invited")!), .failure(reason: "not_invited"))
        XCTAssertEqual(MapleRoutes.outcome(of: URL(string: "maple://elsewhere?ticket=x")!), .failure(reason: "failed"))
        XCTAssertEqual(routes.signInFailed(reason: "not_invited").absoluteString, "https://maple.example.test/maple?auth=not_invited")
        XCTAssertEqual(routes.signInFailed(reason: "<script>").absoluteString, "https://maple.example.test/maple?auth=failed")
        XCTAssertEqual(routes.signInFailed(reason: "ok").absoluteString, "https://maple.example.test/maple?auth=failed")
    }

    func testBaseURLComesFromTheBuildSettingWithASafeFallback() {
        XCTAssertEqual(Config.baseURL(from: "https://brooker.family/").absoluteString, "https://brooker.family")
        XCTAssertEqual(Config.baseURL(from: "$(MAPLE_BASE_URL)"), Config.fallbackBaseURL)
        XCTAssertEqual(Config.baseURL(from: "ftp://maple.example.test"), Config.fallbackBaseURL)
        XCTAssertEqual(Config.baseURL(from: nil), Config.fallbackBaseURL)
    }

    func testBridgeAcceptsObjectsAndJSONStrings() {
        XCTAssertEqual(BridgeMessage.parse(["type": "google-sign-in"]), .googleSignIn)
        XCTAssertEqual(BridgeMessage.parse(#"{"type":"google-sign-in"}"#), .googleSignIn)
        XCTAssertNil(BridgeMessage.parse(["type": "something-else"]))
        XCTAssertNil(BridgeMessage.parse("not json"))
    }
}
