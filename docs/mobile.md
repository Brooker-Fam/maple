# Maple on iPhone and Android (`ios/`, `android/`)

Two small native apps that wrap the web app: SwiftUI with a `WKWebView` on iOS, Kotlin with Compose and a `WebView` on Android. They load `https://maplebaby.app/maple`, so every screen, rule and fix still lives in `src/` and ships with a normal deploy. Neither folder is deployed: `.vercelignore` leaves out `ios/` and `android/`.

## Phase 1: the shell apps

What the apps do now:

- **Load Maple full screen**, edge to edge, with a reload when the web view's process dies and a plain offline screen. There is no pull to refresh.
- **Hand off what a web view can't do itself:** `tel:` (911, 988 and the help lines), `sms:`, `mailto:` and other sites open in the system; `target="_blank"` links to Maple's own host stay in the app, and to other hosts open outside; the CSV export downloads; photo pickers and the camera work for Moments.
- **Google and Apple sign-in through the system sign-in sheet** (Google refuses sign-in inside an embedded web view). See [Sign-in](#sign-in) below. Email codes and the admin username and password work inside the app’s web view.
- **Identify themselves** with a user-agent suffix, ` Maple-Native-App/1.1 (ios)` or ` Maple-Native-App/1.1 (android)`, and listen on a bridge named `nativeApp`.
- **Match the page's colour on Android:** the system-bar strips and their icons follow the page's `theme-color` (cream, forest, or near-black for the night look), sent over the bridge. On iOS the status bar already follows the page, and overscroll shows the page's own background.

What they don't do yet:

- **Notifications.** Web Push doesn't exist in `WKWebView` or Android's `WebView`. Inside the app the Notifications sheet says "Notifications come to the app in a later update" and the row reads "Not in the app yet"; the sheet never shows the Home Screen steps there, and Family → On this phone drops the "Add to Home Screen" hint. A phone that has notifications on in the Home Screen web app (iPhone) or Chrome (Android) keeps getting them there, so existing medicine reminders stay on the web app until Phase 2.
- **Invite links.** An invite opens in Safari or Chrome and signs in the browser, not the app, until universal links and app links exist (Phase 4). Members can sign in to the app with Google, Apple (bridge 1.1), or an email code once those providers are configured. Invite-link guests still enter through the browser. In the app, the sign-in screen says so instead of "just open it on this phone".
- **"Logged" on the same phone.** The app's web view keeps its own storage, so it has a different `X-Maple-Device` id from the Home Screen web app on the same phone. A dose logged in the app therefore isn't recognised as "this phone" by that phone's web-app subscription: the "Logged" notice (and any "logged elsewhere" notice) still arrives there. Nothing can share the id: neither app can read the other's storage. Phase 2's native subscription fixes it, because then the app's own id is the one that gets notices.
- **Back on Android** walks the web view's history and then leaves the app. Maple only replaces history (it never pushes), so in practice Back leaves the app even with a sheet open, as in the Home Screen web app. Closing the top sheet with Back needs a page hook (say `window.mapleBack()`), later.
- Lock-screen nursing timer, Siri without a Shortcut, keep-awake for the Lantern and haptics: Phases 2 and 3.

Each app keeps its own cookies, apart from Safari's and Chrome's, so each person signs in once in the app. The session lasts 180 days, like the web's.

### The web app's side

- `src/lib/maple/native.ts`: `isNativeApp()` (the user agent contains `Maple-Native-App/`), `nativePlatform()` (`"ios"`, `"android"` or null), `supportsNativeAppleSignIn()` (web or bridge 1.1 onward), and `postToNative(message)`. It posts to exactly one target, `window.webkit.messageHandlers.nativeApp` or else `window.nativeApp` (Android also installs a `webkit.messageHandlers` shim that forwards to `window.nativeApp`, so posting to both would deliver twice there). The body is always a JSON **string**, because Android's `JavascriptInterface` only takes strings. It returns false outside the apps.
- Messages so far: `{"type":"google-sign-in"}`, `{"type":"apple-sign-in"}` (bridge 1.1 onward), and `{"type":"theme","color":"#RRGGBB"}` whenever the page's `theme-color` changes (`MapleApp`'s theme effect; only Android uses it). Both apps ignore types they don't know. The page therefore checks `supportsNativeAppleSignIn()` before offering Apple in a native app; old 1.0 builds continue to offer Google and email. Posting `apple-sign-in` to an old shell returns false instead of claiming success.
- Only the main frame on Maple's own origin (scheme, host and port) can post. iOS checks the message's frame and security origin; Android uses `WebViewCompat.addWebMessageListener` limited to that origin and acts only on `isMainFrame`, so `window.nativeApp` doesn't exist in other sites' frames.
- `src/components/maple/SignIn.tsx`: in the app, Google and Apple buttons post `google-sign-in` or `apple-sign-in` instead of following their links. Both apps also catch navigation to `/api/maple/auth/start` or `/api/maple/auth/apple/start`, so a plain link still opens the system sheet. Apple account linking is done from Family in a browser: the system browser and web view do not share the existing account’s session cookie. Email linking stays inside the app.
- `src/components/maple/notify/`: status `app` (`NotificationsProvider` sets it whenever `isNativeApp()`; `turnOn()` only opens the sheet), the sheet's in-app card, and no "Remind me" chip in a dose toast.

## Sign-in

Both OAuth providers use the same verifier-bound `maple://auth` ticket and `/api/maple/auth/native` redemption. Apple starts at `/api/maple/auth/apple/start?native=ios|android&challenge=<c>` and returns by POST to `/api/maple/auth/apple/callback`; its server state must survive Apple’s cross-site form POST. The shell never receives provider tokens. New native builds advertise bridge **1.1**; deploying the web changes alone cannot add Apple support to already-installed 1.0 binaries.

```
App                           Maple server                                 Google
 │ makes a random verifier; challenge = base64url(SHA-256(verifier))
 │ system sheet (ASWebAuthenticationSession / Custom Tab)
 ├──────────▶ GET /api/maple/auth/start?native=ios|android&challenge=<c>[&return=/maple…]
 │            state cookie {state, back, native, challenge}, state = maple.native-<platform>.<uuid>
 │                                                     ──────────────────────▶ consent
 │            GET /api/maple/auth/callback?code&state ◀──────────────────────
 │            member checked (joinWithGoogle), no cookie set
 │ ◀────────── 307 maple://auth?ticket=<t>   (or maple://auth?error=<reason>)
 │ app's own web view
 ├──────────▶ GET /api/maple/auth/native?ticket=<t>   X-Maple-Verifier: <verifier>
 │ ◀────────── 307 /maple with Set-Cookie maple_session (Path=/api/maple and /oauth/authorize)
 │             or 307 /maple?auth=failed
```

- **`/api/maple/auth/start`** takes `native=ios` or `native=android` exactly; any other value (or none) is the web flow, whose state cookie stays byte for byte what it was (`{"state":"maple.<uuid>","back":"…"}`). The apps' flow also needs `challenge` (43 base64url characters); without one it answers `maple://auth?error=failed` and never reaches Google. `return` still goes through `safeReturnPath` (only `/maple…` and the MCP consent page; anything else becomes `/maple`). With Google not set up, the app gets `maple://auth?error=not_configured`.
- **`/api/maple/auth/callback`** with `native` in the state cookie answers on `maple://auth` instead of setting the session: `?ticket=<t>` on success, `?error=<reason>` on failure with the same reasons the web shows on `/maple?auth=` (`denied`, `bad_state`, `no_code`, `no_email`, `not_invited`, `unavailable`, `failed`). If the state cookie was lost on the way (a sheet left open past 10 minutes), a state that names an app still sends `bad_state` back to the app rather than leaving a web page inside its sheet. The redirect URI Google sees is the same one the web uses, so nothing changes in Google Cloud.
- **The ticket** (`src/lib/maple/native-auth.ts`) is stateless: `mnt1.<iv>.<tag>.<ciphertext>`, base64url parts, sealed with AES-256-GCM under the session key (from `GOOGLE_CLIENT_SECRET`, like `maple_session`), so it can't be read or altered. It carries the member id, the return path, the app's challenge and an expiry two minutes after it's made. Other sealed values (a session cookie, for one) don't open as a ticket.
- **`/api/maple/auth/native`** opens the ticket, requires an `X-Maple-Verifier` header whose SHA-256 is the ticket's challenge, checks the member still exists, sets the usual session cookies (`setSessionCookies`) and redirects to the ticket's return path (`/maple` by default, re-checked with `safeReturnPath`). A missing, tampered, expired or wrong-prefix ticket, a missing or wrong verifier, or someone removed in the meantime, lands on `/maple?auth=failed`, where the sign-in screen shows a sign-in failure. The responses are `no-store` with `Referrer-Policy: no-referrer`.
- **On an error** the apps load `/maple?auth=<reason>` in their web view, so the sign-in screen shows the same words as on the web.
- **Why the verifier.** Without it the ticket was a bearer login link: anyone who signed in with `?native=ios` on a computer could copy their own `maple://auth?ticket=` and send `/api/maple/auth/native?ticket=…` to someone else, whose browser (or app) would then be signed in as them (login CSRF), and another app that claimed `maple://` could trade a caught ticket. A page on another site can't add a custom header to a navigation, and a cross-origin fetch with one fails its preflight, so only the app that made the challenge can trade the ticket. Android also ignores any `maple://auth` link when it hasn't started a sign-in in the last 10 minutes (the state cookie's lifetime), keeps that pending sign-in on disk in case Android kills the app behind the Custom Tab, takes it once, and never follows `maple://` from inside a page.
- **Checks:** `pnpm check:maple-native` (`scripts/maple-native-check.ts`) covers the flag, the challenge and verifier (against RFC 7636's own example pair), the cookie shapes, the callback's error answers, the ticket's expiry, tampering, prefix and key, and the native route's success and failure paths, including a good ticket traded with no verifier or the wrong one. It needs no database or network (a fetch stand-in on a `.invalid` host answers the one member lookup).

**Known limits, for a later hardening pass.**

- Any app can register the `maple://` scheme. On Android one that claimed it could catch a ticket, but without the verifier it can't trade it. Returning over a verified HTTPS link (iOS universal link with `ASWebAuthenticationSession`'s HTTPS callback on iOS 17.4+, Android App Links with `assetlinks.json`) would stop the catch too.
- The ticket is stateless, so the app that holds the verifier could trade it more than once within its two minutes. A table of used ticket ids would make it single use.

## Building and running on this Mac

Base URL: iOS reads the `MAPLE_BASE_URL` build setting (into `Info.plist`); Android reads the `mapleBaseUrl` Gradle property (into `BuildConfig.MAPLE_BASE_URL`: an https origin, or `http://10.0.2.2:<port>` for a dev server on this Mac, which only debug builds let through). Both default to `https://maplebaby.app`. Until that domain serves the deployment, point a build at a deployment URL that isn't behind Vercel's login, or at `pnpm dev`. Google sign-in only works against the production base (its redirect URI is registered there); the admin password, downloads, uploads and `tel:` links can be tried against `pnpm dev`.

**iOS** (Xcode 26, Swift packages only; CocoaPods is broken on this Mac):

```bash
cd ios
xcrun simctl create "Maple iPhone" "iPhone 17"          # once; any recent iPhone type works
xcodebuild -project Maple.xcodeproj -scheme Maple -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=Maple iPhone' \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
xcrun simctl boot "Maple iPhone"; open -a Simulator
xcrun simctl install "Maple iPhone" build/Build/Products/Debug-iphonesimulator/Maple.app
xcrun simctl launch "Maple iPhone" app.maplebaby
xcodebuild -project Maple.xcodeproj -scheme Maple -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=Maple iPhone' CODE_SIGNING_ALLOWED=NO test
```

Add `MAPLE_BASE_URL=https://<deployment>` to the `xcodebuild` line to try another server. Running on a real iPhone needs a signing team (see [Accounts](#accounts-and-cost)).

**Android** (JDK 17, the Gradle wrapper in `android/`):

```bash
cd android
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_HOME=~/Library/Android/sdk
./gradlew assembleDebug test lint                       # -PmapleBaseUrl=https://<deployment>, or http://10.0.2.2:3000 for pnpm dev
~/Library/Android/sdk/emulator/emulator -avd Medium_Phone_API_36.0 &
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n app.maplebaby/.MainActivity
```

If the emulator has no internet, send it through a host proxy: `adb shell settings put global http_proxy 10.0.2.2:8888` with a proxy listening on the Mac's port 8888 (and `adb shell settings put global http_proxy :0` to undo it).

**Not yet seen working, so Phase 1 isn't done until these pass** (the sign-in server routes only exist once this is deployed, and Google's redirect URI is tied to the production base):

1. Deploy, then on each platform tap Continue with Google and have a family member sign in with their own account in the system sheet (typed by that person, never by an agent). The app should land on Today. On Android this also proves Chrome follows the server's 307 to `maple://` from inside a Custom Tab.
2. A real CSV export from Family on each platform: the file has its `.csv` name and opens.
3. One Moments photo from the camera and one from the library on each platform.
4. A `tel:911` tap on each brings up the call prompt (cancel it).
5. Android at night with the phone in light mode: the bar strips are near-black with light icons, and switching the phone's dark mode with the app open updates them.

## Later phases

Sizes are relative; each phase ships on its own, in this order.

### Phase 2: native push (medium)

Depends on Phase 1, the Apple team decision (for APNs) and a Firebase project (for FCM).

- **Server.** Generalize `maple_push_subs` rather than building a second system: add `kind` (`web` | `apns` | `fcm`), keep the device token in `endpoint`, let `p256dh` and `auth` be null, and add `la_token` for the Live Activity token, all as additive migrations (brooker-wedding still reads these tables). `deliver()` in `push.ts` dispatches on `kind`; claims, retries, prefs, the per-phone `device_id` skip, health and the 3-hour cutoff stay as they are. APNs 410 / `BadDeviceToken` and FCM `UNREGISTERED` mean "needs resubscribe"; 429 and 5xx retry.
- **APNs.** A token-based `.p8` key from the paid team; env `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8` (secret), `APNS_BUNDLE_ID=app.maplebaby`, `APNS_ENV` (sandbox for development builds, production for TestFlight). An ES256 JWT from `node:crypto` over `node:http2`, no new dependency, cached under an hour. `apns-collapse-id` = the notice's tag (iOS then replaces "OK again" with "Logged" itself), `interruption-level: time-sensitive` for her medicines so they get through Focus.
- **FCM.** A free Firebase project owned by the family's Google account with `app.maplebaby` registered (`google-services.json`), and a service account for FCM HTTP v1 as `FCM_SERVICE_ACCOUNT_JSON`. Send with an access token from `google-auth-library` (already a dependency). High-priority data messages; the app builds the notice, with channels `maple_meds` (high) and `maple_nursing` (low, ongoing) and tag-based replacement. Use a dedicated Firebase project; do not reuse another app's project.
- **Apps.** The permission prompt, then the token goes to the web over the bridge and the web POSTs it to `/api/maple/push` with its cookie and `X-Maple-Device`, the same path a browser subscription takes. Token refreshes re-register the same way. A tapped notice fires the existing `maple-open` window event, which CareNav already routes. Receipts are posted from the app.
- **Web.** The Notifications sheet uses the native path when `isNativeApp()`, and the `app` status gives way to the usual on/off.
- **Dedupe.** A phone with notifications on in both the web app and the native app would get every reminder twice: `deliver()` must skip a web subscription whose `device_id` also has a native one, or the app turns the web one off when it turns on.
- **Checks.** Payload builders and outcome mapping as `tsx` checks with stubbed HTTP; `xcrun simctl push <udid> app.maplebaby payload.apns` for rendering, collapse and taps (no account needed); FCM end to end on the emulator once `google-services.json` exists.

### Phase 3: Live Activity, App Intents, Android's running timer (large)

Depends on Phase 2 for updates from the server.

- **iOS Live Activity** for the nursing timer: a widget extension `app.maplebaby.LiveActivity` with the entry id and a content state (side, side start, feed start, on a break, both sides). It counts by itself with `Text(timerInterval:)`, starts and updates from a `NURSING_TIMER` bridge message, and gets `liveactivity` pushes from `nursingChanged()` (`push-hooks.ts`) on phones with a Live Activity token, instead of nurse notices. Push-to-start (iOS 17.2+) lets a feed started on one phone or by Siri show on the other.
- **iOS App Intents and App Shortcuts** for the `/api/maple/quick` actions (pee, poop, both, nurse left/right, switch, stop, sleep, wake, status, mom status, mom dose). The app makes its own token with `POST /api/maple/tokens` (cookie auth), keeps it in the Keychain, labelled "Maple app (iPhone)" so Family can revoke it; `status` speaks its `speak` text.
- **Android** ongoing notification with a running clock, ported from gt-android's `WorkoutTimerNotifier`, fed by `NURSING_TIMER` and FCM nursing messages.
- **Small bridge messages** alongside: `KEEP_AWAKE` for the Lantern (`isIdleTimerDisabled`, `FLAG_KEEP_SCREEN_ON`) and `HAPTIC` (the Vibration API is silent in both web views).

### Phase 4: distribution (small for the family's own phones, large for public stores)

- **iOS:** archive and upload with fastlane `upload_to_testflight` and a new App Store Connect API key for the chosen team, then internal testers; or an ad hoc build for registered devices.
- **Android:** a new Maple upload keystore (back it up: losing it blocks updates on Play), then sideload, Firebase App Distribution, or Play's internal track.
- **Links:** `apple-app-site-association` and `assetlinks.json` from maplebaby.app, so invite links open in the app and sign-in can return over HTTPS.
- **Not recommended:** public App Store or Play listings. Review needs a demo login into a demo baby, never Maple's real log, which means multi-baby or demo-tenant work.

## Accounts and cost

The family decides; nothing here is set up yet.

| Choice | Cost | What it gives | Catch |
|---|---|---|---|
| **Apple: the maintainer enrolls as an Individual** | $99 a year, recurring | APNs, time-sensitive alerts, Live Activity pushes, TestFlight for up to 100 internal testers (builds expire after 90 days) | Breaks the no-recurring-cost goal; listed under the maintainer's legal name |
| **Apple: an existing authorized team** | $0 | The same capabilities | Needs the account owner's explicit consent; the app and its push key sit in that account; testers become App Store Connect users or registered devices |
| **Apple: free personal team** | $0 | Live Activities that update locally, App Intents (moderate confidence) | No push or time-sensitive alerts; 3 devices; the app must be reinstalled from this Mac every 7 days. A stopgap only |
| **Android: sideload or Firebase App Distribution** | $0 | Everything, FCM included | Updates by reinstalling or through App Distribution |
| **Android: a new personal Play account** | $25 once | The internal testing track at once | Production needs a 12-tester, 14-day closed test |
| **Android: an existing authorized Play account** | $0 | Internal track | Listed under that account's name; its owner must agree |

Recommendation: Android by sideload or Firebase App Distribution. For iOS, weigh first that the Home Screen web app already gets push on iOS 16.4+; the native app adds the Live Activity, reminders that get through Focus, Siri without a Shortcut and no Home Screen step. If those are worth it, the choice is $99 a year or an existing account owner's consent, with the free team as a stopgap.

Before Phase 2, whichever is chosen:

1. Apple: register the App ID `app.maplebaby` with Push Notifications and Time Sensitive, create an APNs `.p8` key and add it to Vercel (team guava-tri, project maple) as the `APNS_*` variables, and create an App Store Connect API key for uploads.
2. Android: a free Firebase project under the family's Google account, `app.maplebaby` registered, `google-services.json` downloaded, and an FCM service-account secret in Vercel.
3. Which phones and OS versions the family uses (push-to-start needs iOS 17.2+).
4. Real-phone checks once built: sign in, the 1-minute test with the phone locked, a nursing Live Activity, a time-sensitive reminder through the Sleep Focus, "Hey Siri, Maple status", and `tel:911` opening the dialer.
