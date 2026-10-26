# Maple for Android

A Kotlin + Jetpack Compose shell around Maple's web app: one full-screen WebView on `{BASE}/maple`. Package `family.brooker.maple`, minSdk 26, target and compile SDK 36. Gradle setup comes from `~/dev/gt-android`, with Firebase, analytics and signing removed.

## Build

Needs JDK 17 and the Android SDK.

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_HOME=~/Library/Android/sdk
./gradlew assembleDebug lint test
./gradlew assembleDebug -PmapleBaseUrl=https://brooker.family   # point at another origin
./gradlew assembleDebug -PmapleBaseUrl=http://10.0.2.2:3000     # pnpm dev on this Mac, from the emulator
```

`BASE` is `BuildConfig.MAPLE_BASE_URL`. It defaults to `https://maplebaby.app`, and `-PmapleBaseUrl` overrides it. The build accepts an `https://` origin, or plain http to `10.0.2.2`, `localhost` or `127.0.0.1` for a dev server. Only debug builds allow that cleartext (`src/debug/res/xml/network_security_config.xml`); a release build pointed at it can't load. Google sign-in only works against the production base, whose redirect URI Google knows.

The debug APK is `app/build/outputs/apk/debug/app-debug.apk`. There is no release signing yet. Before the first sideload or Play upload, create a Maple upload keystore and back it up, because losing it blocks every later update. Keep it, and any `keystore.properties`, out of git; `.gitignore` already covers both.

## What the shell does

- **Pages.** Only `BASE` stays in the app (same scheme, host and port). Links to other sites open in the browser. `tel:` opens the dialer, `sms:` and `mailto:` open the messaging and mail apps, and other schemes (`maple:` included) are dropped. Back goes through the WebView's history, then leaves the app. Maple only replaces history, never pushes it, so in practice Back leaves the app even with a sheet open, as the Home Screen web app does.
- **User agent.** The suffix ` Maple-Native-App/1.0 (android)` lets the web app's `isNativeApp()` spot the app.
- **Bridge.** `window.nativeApp.postMessage(json)` comes from `WebViewCompat.addWebMessageListener`, limited to `BASE`'s origin, so other sites' frames never get it. The app also injects `window.webkit.messageHandlers.nativeApp.postMessage(obj)`, so the web code can make the same call on iOS and Android. Only messages from the main frame on `BASE` count. On a WebView too old for the listener there is no bridge, and the sign-in link's navigation is caught instead. The app handles two messages:
  - `{"type":"google-sign-in"}` starts Google sign-in (below).
  - `{"type":"theme","color":"#RRGGBB"}` paints the system-bar strips that colour and picks light or dark bar icons from it, so the night look gets near-black bars on a phone in light mode. Without one (or on the offline screen) the bars follow the phone's dark mode, and follow it again when it changes with the app open.
- **Google sign-in.** Google blocks sign-in inside a WebView, so sign-in runs in a Custom Tab. The app makes a random verifier, keeps it with the time in private `SharedPreferences` (Android may kill the app while the Custom Tab is open), and opens `{BASE}/api/maple/auth/start?native=android&challenge=<SHA-256 of the verifier>`. The server ends the flow at `maple://auth?ticket=<t>` or `maple://auth?error=<reason>`. The app takes that link only if it started a sign-in in the last 10 minutes (once, then forgets it), and loads one of these in the WebView:
  - `{BASE}/api/maple/auth/native?ticket=<t>`, passing the ticket on byte for byte with the verifier in an `X-Maple-Verifier` header. The server sets the session cookie there.
  - `{BASE}/maple?auth=<reason>` on an error.
  A `maple://auth` link it didn't ask for, from another app or a web page, is ignored.
  If the page navigates straight to `/api/maple/auth/start` without `native`, the app sends it to the Custom Tab too. The admin username and password sign-in works inside the WebView as before.
- **Uploads.** `<input type=file>` opens the system picker and follows the input's `accept` list. An input with `capture` and an image type opens the camera (FileProvider, `cache/camera/`). This needs no CAMERA permission.
- **Downloads** (the CSV export) go through `DownloadManager`, which sends the WebView's cookie for that URL. On Android 10 and later the file goes to Downloads. Before Android 10 it goes to the app's own Downloads folder, because public Downloads would need the storage permission there.
- **Cookies.** Cookies and third-party cookies are on, and they are flushed to disk when the app goes to the background. App backup is off, so the 180-day session cookie never reaches a cloud backup.
- **Edge to edge.** The app draws behind the system bars. The WebView is padded by the system bars, the display cutout and the keyboard (`WindowInsets.safeDrawing`) on Maple's page color. The WebView gets no insets of its own, so `env(safe-area-inset-*)` is 0 and the page is never padded twice.
- **Offline.** If the main page fails to load, the app shows a "Can't reach Maple" screen with a Try again button, in Maple's day or dark colors.
- **Crashes.** If the WebView's renderer dies, the app rebuilds the WebView on the last page instead of crashing.
- **Icon.** The adaptive launcher icon is built from `public/maple-icon-512.png`: the leaf in the safe zone on cream (`#FDF8F0`), plus a monochrome layer for themed icons.

## Not in this phase

- **No notifications in the app.** Web Push does not work in Android WebView. Until native push (FCM) ships, medicine reminders still need the browser or Home Screen web app.
- **No App Links.** Any installed app can register `maple://`. A hijacked return would get only a ticket it can't trade without the verifier. Verified App Links (`assetlinks.json` on `BASE`) would stop the catch too, and would let invite links open in the app (until then they open in Chrome).
- Ongoing nursing timer notification, keep-awake and haptics bridge messages.

## Tests

`./gradlew test` runs Robolectric tests for:
- the origin and sign-in-return rules (`MapleSite`)
- the verifier and the pending sign-in (`PendingSignIn`)
- the bridge (origin, main frame, theme colours)
- link routing
- the file picker's type rules
- the user agent

## Emulator

```bash
~/Library/Android/sdk/emulator/emulator -avd <avd> -no-window -no-audio &
adb wait-for-device
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n family.brooker.maple/.MainActivity
adb exec-out screencap -p > shot.png
```

If the emulator has no internet, use the proxy described in gt-android's `CLAUDE.md`. Never type real family credentials into an emulator you'll screenshot.
