import { createHash, timingSafeEqual } from "node:crypto";
import { decryptSecret, encryptSecret } from "@/lib/secret-box";
import { MAPLE_STATE_PREFIX, safeReturnPath } from "./auth";
import type { NativePlatform } from "./native";

/**
 * Google sign-in for the iOS and Android apps. Google refuses sign-in inside
 * an embedded web view, so the app opens the system auth session at
 * /api/maple/auth/start?native=ios|android; the callback then hands the app a
 * ticket on maple://auth instead of a cookie (the system browser's cookies
 * never reach the app's web view), and the app's web view trades it at
 * /api/maple/auth/native for the usual session cookies.
 *
 * The ticket is stateless: sealed with the session key (AES-256-GCM, so it
 * can't be read or altered), and good for two minutes. It is also bound to
 * the app that asked for it, PKCE style: the app sends `challenge`
 * (base64url SHA-256 of a random verifier only it holds) to start, the
 * ticket carries it, and the trade needs the verifier in the
 * X-Maple-Verifier header. A page on another site can't add that header to a
 * navigation, so a ticket can't be planted in someone else's browser or app.
 */

export const NATIVE_TICKET_PREFIX = "mnt1";
export const NATIVE_TICKET_TTL_MS = 2 * 60_000;
export const NATIVE_RETURN_URL = "maple://auth";
export const NATIVE_VERIFIER_HEADER = "x-maple-verifier";
const KIND = "maple-native-ticket";
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export function parseNativeFlag(raw: string | null | undefined): NativePlatform | null {
  return raw === "ios" || raw === "android" ? raw : null;
}

/** OAuth state for an app's sign-in: it names the app too, so a callback that lost its state cookie can still send its error back to the app. */
export function nativeState(native: NativePlatform, nonce: string): string {
  return `${MAPLE_STATE_PREFIX}native-${native}.${nonce}`;
}

export function nativeFromState(state: string | null | undefined): NativePlatform | null {
  const m = /^maple\.native-(ios|android)\./.exec(state ?? "");
  return m ? parseNativeFlag(m[1]) : null;
}

export function parseNativeChallenge(raw: string | null | undefined): string | null {
  return raw && CHALLENGE.test(raw) ? raw : null;
}

export function nativeChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function nativeVerifierMatches(verifier: string | null | undefined, challenge: string): boolean {
  if (!verifier || !VERIFIER.test(verifier)) return false;
  const got = Buffer.from(nativeChallengeFor(verifier));
  const want = Buffer.from(challenge);
  return got.length === want.length && timingSafeEqual(got, want);
}

export type NativeTicket = { id: string; back: string; challenge: string };

export function mintNativeTicket(id: string, back: string, challenge: string, now = Date.now()): string {
  const sealed = encryptSecret(JSON.stringify({ k: KIND, id, back, c: challenge, exp: now + NATIVE_TICKET_TTL_MS }));
  const parts = sealed.split(":").map((p) => Buffer.from(p, "base64").toString("base64url"));
  return [NATIVE_TICKET_PREFIX, ...parts].join(".");
}

export function openNativeTicket(raw: string | null | undefined, now = Date.now()): NativeTicket | null {
  if (!raw || raw.length > 2048) return null;
  const [prefix, ...parts] = raw.split(".");
  if (prefix !== NATIVE_TICKET_PREFIX || parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  try {
    const sealed = parts.map((p) => Buffer.from(p, "base64url").toString("base64")).join(":");
    const { k, id, back, c, exp } = JSON.parse(decryptSecret(sealed));
    if (k !== KIND || typeof id !== "string" || !id || typeof exp !== "number" || now > exp) return null;
    const challenge = parseNativeChallenge(typeof c === "string" ? c : null);
    if (!challenge) return null;
    return { id, back: safeReturnPath(typeof back === "string" ? back : null), challenge };
  } catch {
    return null;
  }
}

export function nativeReturnUrl(result: { ticket: string } | { error: string }): string {
  const url = new URL(NATIVE_RETURN_URL);
  if ("ticket" in result) url.searchParams.set("ticket", result.ticket);
  else url.searchParams.set("error", result.error);
  return url.toString();
}
