import { parseAnalyticsContext, clearAnalyticsContext, type AnalyticsContext } from "@/lib/analytics/context";
import { identifyAnalyticsSoon } from "@/lib/analytics/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveEmailIdentity } from "./auth-identities";
import { getAppBaseUrl } from "@/lib/secret-box";
import {
  identityFromCode,
  joinWithGoogle,
  safeReturnPath,
  setSessionCookies,
  signInSite,
  STATE_COOKIE,
  STATE_COOKIE_PATH,
} from "@/lib/maple/auth";
import { captureServerException } from "@/lib/posthog-server";
import { handleSignupCallback, isSignupCallback, type SignupCallbackDeps } from "./family/signup";
import { mintNativeTicket, nativeFromState, nativeReturnUrl, parseNativeChallenge, parseNativeFlag } from "./native-auth";
import type { NativePlatform } from "./native";
import { grantMetricsAccess } from "./admin/auth";

function withAuthParam(base: string, path: string, value: string): string {
  const url = new URL(path, base);
  // The MCP consent page reads its own params; only tag app URLs.
  if (url.pathname.startsWith("/maple")) url.searchParams.set("auth", value);
  return url.toString();
}

/** `deps` stands in for Google in the checks; the route passes none. */
export async function handleMapleGoogleCallback(request: NextRequest, deps: SignupCallbackDeps = { identify: identityFromCode }): Promise<NextResponse> {
  // /signup's sign-ins come back to this one registered callback; only its handler may make or join a family.
  if (isSignupCallback(request)) return handleSignupCallback(request, deps);
  let base = getAppBaseUrl();
  const { searchParams } = new URL(request.url);

  let back = "/maple";
  let expected: string | null = null;
  let native: NativePlatform | null = null;
  let challenge: string | null = null;
  let analytics: AnalyticsContext | undefined;
  try {
    const raw = request.cookies.get(STATE_COOKIE)?.value;
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: string; back?: string; native?: string; challenge?: string; site?: string; analytics?: unknown };
      analytics = parseAnalyticsContext(parsed.analytics);
      expected = parsed.state ?? null;
      back = safeReturnPath(parsed.back);
      native = parseNativeFlag(parsed.native);
      challenge = parseNativeChallenge(parsed.challenge);
      if (!native) base = signInSite(parsed.site);
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

    const who = await deps.identify(code, base);
    if (!who) return fail("no_email");

    const verifiedEmail = who.email;
    who.email = await resolveEmailIdentity(who.email);

    // Resolve membership before minting a session, so an uninvited account
    // never holds a cookie for a log it can't reach.
    const joined = await joinWithGoogle(who);
    if (!joined.member) return fail(joined.reason);
    const { member, familyId } = joined;

    if (native) {
      if (!challenge) return fail("bad_state");
      const res = NextResponse.redirect(nativeReturnUrl({ ticket: mintNativeTicket(member.email, familyId, back, challenge, Date.now(), analytics) }));
      res.cookies.set(STATE_COOKIE, "", { path: STATE_COOKIE_PATH, maxAge: 0 });
      clearAnalyticsContext(res);
      return res;
    }

    const res = NextResponse.redirect(withAuthParam(base, back, "ok"));
    // res.cookies.* rewrites every Set-Cookie header, so it must run before
    // setSessionCookies appends the session's raw headers.
    res.cookies.set(STATE_COOKIE, "", { path: STATE_COOKIE_PATH, maxAge: 0 });
    identifyAnalyticsSoon({ familyId, member: member.email, role: member.role }, analytics);
    grantMetricsAccess(res, verifiedEmail, member.email);
    setSessionCookies(res, member.email, familyId);
    clearAnalyticsContext(res);
    return res;
  } catch (error) {
    await captureServerException(error, { route: "GET /api/maple/auth/callback" });
    return fail("failed");
  }
}
