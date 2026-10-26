# Maple for iPhone

A small SwiftUI app that shows Maple's Log (`{BASE}/maple`) full screen in a `WKWebView`. Bundle id `family.brooker.maple`, display name "Maple", iOS 17+. No third-party packages.

## What the app adds to the web app

- **Edge to edge.** The page draws under the status bar and home indicator and keeps its controls clear with `env(safe-area-inset-*)` (the web layout uses `viewport-fit=cover`).
- **User agent.** WebKit's own user agent with ` Maple-Native-App/1.0 (ios)` appended, so the web app can tell it is in the app.
- **Google sign-in.** Google blocks sign-in inside embedded web views, so the app does it in the system sign-in sheet:
  1. The page posts `{type: "google-sign-in"}` to `window.webkit.messageHandlers.nativeApp` (an object or a JSON string both work). A tap on a plain link to `/api/maple/auth/start` does the same.
  2. The app makes a random verifier and opens `ASWebAuthenticationSession` at `{BASE}/api/maple/auth/start?native=ios&challenge=<SHA-256 of the verifier>`, then waits for a `maple://` callback.
  3. `maple://auth?ticket=<t>` loads `{BASE}/api/maple/auth/native?ticket=<t>` in the web view with the verifier in an `X-Maple-Verifier` header, and the server sets the session cookie there. The verifier lives only in memory for that one sign-in.
  4. `maple://auth?error=<reason>` loads `{BASE}/maple?auth=<reason>`, so the sign-in screen shows its usual message. A cancelled sheet does nothing.
  
  Only the app's own origin (same scheme, host and port), in the main frame, can start sign-in. The admin password works inside the web view as it does on the web. Invite links don't reach the app yet: they open in Safari and sign in there (universal links are Phase 4).
- **Links.** `tel:`, `sms:`, `mailto:` and links to anything but `BASE`'s scheme, host and port open in the system (Phone, Messages, Mail, Safari). `target="_blank"` links to Maple's own origin stay in the app.
- **Photos.** `<input type="file">` offers the photo library and the camera. The usage strings are in `Maple/Info.plist`.
- **Downloads.** The CSV export, and any other download, goes to the share sheet (Save to Files, AirDrop and so on). The temporary copy is deleted when the sheet closes, and any leftovers are deleted on the next launch.
- **Offline.** If the page cannot load, a calm screen in Maple's colours says so and has a Try again button. It also retries by itself when the connection comes back or the app returns to the foreground.
- **Sign-in persists.** Cookies live in the default `WKWebsiteDataStore`. These cookies are separate from Safari's, so each person signs in once in the app.
- **Colours.** Overscroll shows the page's own background (WebKit's default), so the night look never shows a cream band. The launch screen and the moment before the first paint use Maple's day or dark colour, following the phone's appearance.
- Pull-to-refresh is off. The page reloads itself if WebKit's content process dies.

Not in this version: push notifications, Live Activity, Siri / App Intents (see `docs/mobile.md`).

## Build and run

You need Xcode 26 or later. There is nothing to install.

```bash
# Simulator build (no signing)
xcodebuild -project ios/Maple.xcodeproj -scheme Maple -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build

# Unit tests (link routing, sign-in callback parsing, bridge parsing, user agent)
xcodebuild -project ios/Maple.xcodeproj -scheme Maple \
  -destination 'platform=iOS Simulator,name=<a simulator you have>' CODE_SIGNING_ALLOWED=NO test
```

To run it in a fresh simulator from the command line:

```bash
xcrun simctl create "Maple Test" com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-26-4
xcrun simctl boot "Maple Test"
xcodebuild -project ios/Maple.xcodeproj -scheme Maple -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/maple-ios CODE_SIGNING_ALLOWED=NO build
xcrun simctl install "Maple Test" /tmp/maple-ios/Build/Products/Debug-iphonesimulator/Maple.app
xcrun simctl launch "Maple Test" family.brooker.maple
```

Or open `ios/Maple.xcodeproj` in Xcode and press Run.

To run on a phone, pick a team under Signing & Capabilities. `DEVELOPMENT_TEAM` is left empty and signing is automatic. Debug builds can be inspected from Safari's Develop menu.

## Pointing at another server

The server comes from the `MAPLE_BASE_URL` build setting, default `https://maplebaby.app`. The build writes it into Info.plist as `MapleBaseURL`, and the app loads `{MAPLE_BASE_URL}/maple`. Override it on the command line:

```bash
# The old copy at brooker.family/maple (Google sign-in there predates the native flow)
xcodebuild ... MAPLE_BASE_URL=https://brooker.family build

# A local dev server reached by IP address (use the Mac's LAN IP on a real phone)
xcodebuild ... MAPLE_BASE_URL=http://127.0.0.1:3000 build
```

In Xcode, change it under Build Settings → User-Defined → `MAPLE_BASE_URL`. If the value is empty or malformed, the app falls back to the default. Only pages on that origin (scheme, host and port) stay inside the app; everything else opens in Safari.

## Project layout

- `Maple.xcodeproj`: written by hand. It uses Xcode 16+ synchronized folders, so any file added under `Maple/` or `MapleTests/` is picked up without editing the project.
- `Maple/MapleBrowser*.swift`: the web view, navigation policy, sign-in session and downloads.
- `Maple/MapleRoutes.swift`: URL building and link routing (unit tested).
- `Maple/OfflineView.swift`: the error screen.
- `Maple/Assets.xcassets`: the app icon, Maple's colours (day and dark) and the leaf mark.
- `scripts/render-icon.sh`: re-renders the 1024 px icon from `public/maple-icon.svg` with Quick Look and ImageMagick.
