import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getAppBaseUrl } from "@/lib/google";
import {
  authorizeUrl,
  isGoogleConfigured,
  MAPLE_STATE_PREFIX,
  safeReturnPath,
  STATE_COOKIE,
  STATE_COOKIE_PATH,
} from "@/lib/maple/auth";

export const dynamic = "force-dynamic";

/**
 * Begin Google sign-in. `?return=` (our own path only: /maple… or the MCP
 * consent page) rides along in the state cookie so the callback can send
 * people back where they were.
 */
export async function GET(request: NextRequest) {
  const base = getAppBaseUrl();
  if (!isGoogleConfigured()) {
    return NextResponse.redirect(`${base}/maple?auth=not_configured`);
  }
  const back = safeReturnPath(new URL(request.url).searchParams.get("return"));
  const state = `${MAPLE_STATE_PREFIX}${randomUUID()}`;
  const res = NextResponse.redirect(authorizeUrl(state));
  res.cookies.set(STATE_COOKIE, JSON.stringify({ state, back }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: STATE_COOKIE_PATH,
  });
  return res;
}
