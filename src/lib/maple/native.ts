/**
 * The web app's side of the iOS and Android apps (ios/, android/): both wrap
 * this site in a web view whose user agent ends in
 * " Maple-Native-App/<version> (ios)" or "(android)", and listen on a bridge
 * named `nativeApp` (the iOS script message handler; Android's
 * JavascriptInterface, which also installs a webkit.messageHandlers shim).
 * Both apps ignore types they don't handle, so a new type is safe to send
 * before every installed build understands it. Contract: docs/mobile.md.
 */

export const NATIVE_UA_TOKEN = "Maple-Native-App/";

export type NativePlatform = "ios" | "android";

/** "theme": the page's theme-color, so Android's system bars match the night look. */
export type NativeMessage = { type: "google-sign-in" } | { type: "theme"; color: string };

interface NativeMessageTarget {
  postMessage: (message: unknown) => void;
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: { nativeApp?: NativeMessageTarget } };
    nativeApp?: NativeMessageTarget;
  }
}

export function isNativeApp(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes(NATIVE_UA_TOKEN);
}

export function nativePlatform(): NativePlatform | null {
  if (!isNativeApp()) return null;
  const rest = navigator.userAgent.slice(navigator.userAgent.indexOf(NATIVE_UA_TOKEN));
  if (/\(ios\)/i.test(rest)) return "ios";
  if (/\(android\)/i.test(rest)) return "android";
  return null;
}

/** True when the app took the message (false outside the apps, or with no bridge). */
export function postToNative(message: NativeMessage): boolean {
  if (!isNativeApp()) return false;
  // Exactly one target: Android's webkit shim forwards to window.nativeApp, so posting to both would deliver twice there.
  const target = window.webkit?.messageHandlers?.nativeApp ?? window.nativeApp;
  if (!target) return false;
  try {
    target.postMessage(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}
