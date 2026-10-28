import { clearAnalyticsContext, parseAnalyticsContext, readAnalyticsContext, ensureAnalyticsContext } from "@/lib/analytics/context";
import { captureSignupStartedSoon } from "@/lib/analytics/server";
import { signupFailed } from "./family/signup";
import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { encryptSecret, getAppBaseUrl, openSecret } from "@/lib/secret-box";
import { captureServerException } from "@/lib/posthog-server";
import { APPLE_CALLBACK_PATH, appleAuthorizeUrl, appleIdentityFromCode, isAppleConfigured, type AppleIdentity } from "./apple";
import { setSessionCookies } from "./auth";
import { grantMetricsAccess } from "./admin/auth";
import { mintNativeTicket, nativeFromState, nativeReturnUrl, nativeState } from "./native-auth";
import { completeSignIn, signInErrorCode, type SignInContext } from "./signin-flow";

export const APPLE_STATE_COOKIE = "maple_apple_state";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function appleFailure(ctx: SignInContext | null, code: string): NextResponse {
  if (ctx?.signup?.kind === "create") signupFailed(parseAnalyticsContext(ctx.analytics), "apple", code);
  if (ctx?.native) return NextResponse.redirect(nativeReturnUrl({ error: code }), 303);
  const site = ctx?.site ?? getAppBaseUrl();
  const url = new URL(ctx?.mode === "signup" ? "/signup" : "/maple", site);
  if (ctx?.mode === "link" && !code.startsWith("link_")) code = "link_failed";
  url.searchParams.set(ctx?.mode === "signup" ? "error" : "auth", code);
  if (ctx?.signup?.kind === "join") url.searchParams.set("join", "1");
  return NextResponse.redirect(url.toString(), 303);
}

export async function beginApple(req: NextRequest, ctx: SignInContext): Promise<NextResponse> {
  ctx = { ...ctx, analytics: parseAnalyticsContext(ctx.analytics) ?? readAnalyticsContext(req) };
  if (!isAppleConfigured()) return appleFailure(ctx, "not_configured");
  try {
    const random = randomBytes(32).toString("base64url");
    const state = ctx.native ? nativeState(ctx.native, random) : `maple.apple.${random}`;
    const browser = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const authorize = appleAuthorizeUrl(state, nonce, ctx.site);
    const res = NextResponse.redirect(authorize, 303);
    ctx.analytics ??= ensureAnalyticsContext(req, res);
    if (ctx.signup) ctx.signup = { ...ctx.signup, analytics: ctx.analytics };
    const rows = await query(
      `WITH expired AS (DELETE FROM maple_oauth_attempts WHERE expires_at <= NOW())
       INSERT INTO maple_oauth_attempts (state_hash, browser_hash, sealed_payload, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes') RETURNING state_hash`,
      [hash(state), hash(browser), encryptSecret(JSON.stringify({ ctx, nonce }))]
    );
    if (!rows?.length) return appleFailure(ctx, "unavailable");
    // Apple's callback is a cross-site POST. Secure + None lets only this
    // narrow, random browser proof accompany it; the session stays SameSite=Lax.
    res.cookies.set(APPLE_STATE_COOKIE, browser, { httpOnly: true, secure: true, sameSite: "none", path: APPLE_CALLBACK_PATH, maxAge: 600 });
    if (ctx.signup?.kind === "create") captureSignupStartedSoon(ctx.analytics, { provider: "apple" });
    return res;
  } catch (error) {
    await captureServerException(error, { route: "apple start" });
    return appleFailure(ctx, "unavailable");
  }
}

export async function finishApple(req: NextRequest, identify: (code: string, nonce: string, site: string) => Promise<AppleIdentity | null> = appleIdentityFromCode): Promise<NextResponse> {
  let ctx: SignInContext | null = null;
  const clear = (res: NextResponse) => {
    res.cookies.set(APPLE_STATE_COOKIE, "", { path: APPLE_CALLBACK_PATH, maxAge: 0, httpOnly: true, secure: true, sameSite: "none" });
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
  try {
    if (!req.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return clear(appleFailure(null, "bad_state"));
    const text = await req.text();
    if (text.length > 24_000) return clear(appleFailure(null, "bad_state"));
    const form = new URLSearchParams(text);
    const state = form.get("state") ?? "";
    const native = nativeFromState(state);
    if (native) ctx = { mode: "signin", native, site: getAppBaseUrl(), back: "/maple" };
    const browser = req.cookies.get(APPLE_STATE_COOKIE)?.value ?? "";
    if (!/^[A-Za-z0-9._-]{20,150}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(browser)) return clear(appleFailure(ctx, "bad_state"));
    const rows = await query(
      `DELETE FROM maple_oauth_attempts WHERE state_hash = $1 AND browser_hash = $2 AND expires_at > NOW() RETURNING sealed_payload`,
      [hash(state), hash(browser)]
    );
    if (!rows?.length) return clear(appleFailure(ctx, "bad_state"));
    const opened = openSecret(String(rows[0].sealed_payload));
    if (opened.prev) return clear(appleFailure(ctx, "bad_state"));
    const saved = JSON.parse(opened.text) as { ctx: SignInContext; nonce: string };
    ctx = saved.ctx;
    if (form.get("error")) return clear(appleFailure(ctx, "denied"));
    const code = form.get("code");
    if (!code || code.length > 4096) return clear(appleFailure(ctx, "bad_state"));
    const identity = await identify(code, saved.nonce, ctx.site);
    if (!identity) return clear(appleFailure(ctx, "no_email"));
    const completed = await completeSignIn(req, ctx, { provider: "apple", ...identity });
    if (ctx.native) {
      if (!ctx.challenge) return clear(appleFailure(ctx, "bad_state"));
      const res = clear(NextResponse.redirect(nativeReturnUrl({ ticket: mintNativeTicket(completed.id, completed.familyId, ctx.back, ctx.challenge, Date.now(), parseAnalyticsContext(ctx.analytics)) }), 303));
      clearAnalyticsContext(res);
      return res;
    }
    const res = clear(NextResponse.redirect(completed.redirect, 303));
    grantMetricsAccess(res, identity.email ?? "", completed.id);
    setSessionCookies(res, completed.id, completed.familyId);
    clearAnalyticsContext(res);
    return res;
  } catch (error) {
    await captureServerException(error, { route: "apple callback" });
    return clear(appleFailure(ctx, signInErrorCode(error)));
  }
}
