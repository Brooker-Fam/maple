import { NextRequest, NextResponse } from "next/server";
import { getAppBaseUrl } from "@/lib/google";
import {
  identityFromCode,
  joinWithGoogle,
  safeReturnPath,
  setSessionCookies,
  STATE_COOKIE,
} from "@/lib/maple/auth";
import { captureServerException } from "@/lib/posthog-server";

export const dynamic = "force-dynamic";

function withAuthParam(base: string, path: string, value: string): string {
  const url = new URL(path, base);
  // The MCP consent page reads its own params; only tag app URLs.
  if (url.pathname.startsWith("/maple")) url.searchParams.set("auth", value);
  return url.toString();
}

export async function GET(request: NextRequest) {
  const base = getAppBaseUrl();
  const { searchParams } = new URL(request.url);

  let back = "/maple";
  let expected: string | null = null;
  try {
    const raw = request.cookies.get(STATE_COOKIE)?.value;
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: string; back?: string };
      expected = parsed.state ?? null;
      back = safeReturnPath(parsed.back);
    }
  } catch {
    // fall through to bad_state
  }

  const fail = (why: string) => {
    const res = NextResponse.redirect(withAuthParam(base, back.startsWith("/maple") ? back : "/maple", why));
    res.cookies.set(STATE_COOKIE, "", { path: "/api/maple/auth", maxAge: 0 });
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

    const res = NextResponse.redirect(withAuthParam(base, back, "ok"));
    // res.cookies.* rewrites every Set-Cookie header, so it must run before
    // setSessionCookies appends the session's raw headers.
    res.cookies.set(STATE_COOKIE, "", { path: "/api/maple/auth", maxAge: 0 });
    setSessionCookies(res, member.email);
    return res;
  } catch (error) {
    console.error("Maple auth callback error:", error);
    await captureServerException(error, { route: "GET /api/maple/auth/callback" });
    return fail("failed");
  }
}
