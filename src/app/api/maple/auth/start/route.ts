import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getAppBaseUrl } from "@/lib/secret-box";
import {
  authorizeUrl,
  isGoogleConfigured,
  MAPLE_STATE_PREFIX,
  safeReturnPath,
  STATE_COOKIE,
  STATE_COOKIE_PATH,
} from "@/lib/maple/auth";
import { nativeReturnUrl, nativeState, parseNativeChallenge, parseNativeFlag } from "@/lib/maple/native-auth";

export const dynamic = "force-dynamic";

/**
 * Begin Google sign-in. `?return=` (our own path only: /maple… or the MCP
 * consent page) rides along in the state cookie so the callback can send
 * people back where they were. `?native=ios|android&challenge=` is the apps'
 * sign-in (src/lib/maple/native-auth.ts): the callback answers on maple://auth.
 */
export async function GET(request: NextRequest) {
  const base = getAppBaseUrl();
  const { searchParams } = new URL(request.url);
  const native = parseNativeFlag(searchParams.get("native"));
  if (!isGoogleConfigured()) {
    return NextResponse.redirect(native ? nativeReturnUrl({ error: "not_configured" }) : `${base}/maple?auth=not_configured`);
  }
  const challenge = parseNativeChallenge(searchParams.get("challenge"));
  if (native && !challenge) return NextResponse.redirect(nativeReturnUrl({ error: "failed" }));
  const back = safeReturnPath(searchParams.get("return"));
  const state = native ? nativeState(native, randomUUID()) : `${MAPLE_STATE_PREFIX}${randomUUID()}`;
  const res = NextResponse.redirect(authorizeUrl(state));
  res.cookies.set(STATE_COOKIE, JSON.stringify(native ? { state, back, native, challenge } : { state, back }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: STATE_COOKIE_PATH,
  });
  return res;
}
