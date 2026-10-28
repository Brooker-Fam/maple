import WebKit
import XCTest
@testable import Maple

@MainActor
final class UserAgentTests: XCTestCase {
    func testUserAgentKeepsWebKitsAndEndsWithTheNativeToken() async throws {
        let browser = MapleBrowser()
        let userAgent = try await browser.webView.evaluateJavaScript("navigator.userAgent") as? String

        XCTAssertTrue(userAgent?.hasPrefix("Mozilla/5.0 (iPhone") == true, userAgent ?? "nil")
        XCTAssertTrue(userAgent?.contains(" Mobile/") == true, userAgent ?? "nil")
        XCTAssertTrue(userAgent?.hasSuffix(" Maple-Native-App/1.1 (ios)") == true, userAgent ?? "nil")
    }
}
