import { NextRequest, NextResponse } from "next/server";
import { getAppBaseUrl } from "@/lib/secret-box";
import {
  identityFromCode,
  joinWithGoogle,
  safeReturnPath,
  setSessionCookies,
  STATE_COOKIE,
  STATE_COOKIE_PATH,
} from "@/lib/maple/auth";
import { captureServerException } from "@/lib/posthog-server";
import { mintNativeTicket, nativeFromState, nativeReturnUrl, parseNativeChallenge, parseNativeFlag } from "./native-auth";
import type { NativePlatform } from "./native";

function withAuthParam(base: string, path: string, value: string): string {
  const url = new URL(path, base);
  // The MCP consent page reads its own params; only tag app URLs.
  if (url.pathname.startsWith("/maple")) url.searchParams.set("auth", value);
  return url.toString();
}

export async function handleMapleGoogleCallback(request: NextRequest): Promise<NextResponse> {
  const base = getAppBaseUrl();
  const { searchParams } = new URL(request.url);

  let back = "/maple";
  let expected: string | null = null;
  let native: NativePlatform | null = null;
  let challenge: string | null = null;
  try {
    const raw = request.cookies.get(STATE_COOKIE)?.value;
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: string; back?: string; native?: string; challenge?: string };
      expected = parsed.state ?? null;
      back = safeReturnPath(parsed.back);
      native = parseNativeFlag(parsed.native);
      challenge = parseNativeChallenge(parsed.challenge);
    }
  } catch {
    // fall through to bad_state
  }
  // Picks only where an error goes, so a lost cookie still lands back in the app rather than on a web page inside its sign-in sheet.
  const failToApp = native ?? (expected ? null : nativeFromState(searchParams.get("state")));

  const fail = (why: string) => {
    const res = NextResponse.redirect(
      failToApp ? nativeReturnUrl({ error: why }) : withAuthParam(base, back.startsWith("/maple") ? back : "/maple", why)
    );
    res.cookies.set(STATE_COOKIE, "", { path: STATE_COOKIE_PATH, maxAge: 0 });
    return res;
  };

  try {
    if (searchParams.get("error")) return fail("denied");
    const state = searchParams.get("state");
    if (!state || !expected || state !== expected) return fail("bad_state");
    const code = searchParams.get("code");
    if (!code) return fail("no_code");

    const who = await identityFromCode(code);
    if (!who) return fail("no_email");

    // Resolve membership before minting a session, so an uninvited account
    // never holds a cookie for a log it can't reach.
    const { member, reason } = await joinWithGoogle(who);
    if (!member) return fail(reason ?? "not_invited");

    if (native) {
      if (!challenge) return fail("bad_state");
      const res = NextResponse.redirect(nativeReturnUrl({ ticket: mintNativeTicket(member.email, back, challenge) }));
      res.cookies.set(STATE_COOKIE, "", { path: STATE_COOKIE_PATH, maxAge: 0 });
      return res;
    }

    const res = NextResponse.redirect(withAuthParam(base, back, "ok"));
    // res.cookies.* rewrites every Set-Cookie header, so it must run before
    // setSessionCookies appends the session's raw headers.
    res.cookies.set(STATE_COOKIE, "", { path: STATE_COOKIE_PATH, maxAge: 0 });
    setSessionCookies(res, member.email);
    return res;
  } catch (error) {
    console.error("Maple auth callback error:", error);
    await captureServerException(error, { route: "GET /api/maple/auth/callback" });
    return fail("failed");
  }
}
