import { NextRequest, NextResponse } from "next/server";
import { normalizeEmail } from "@/lib/waitlist";
import { captureSignupStartedSoon } from "@/lib/analytics/server";
import { captureServerException } from "@/lib/posthog-server";
import { setSessionCookies } from "./auth";
import { grantMetricsAccess } from "./admin/auth";
import { startEmailChallenge, verifyEmailChallenge } from "./email-auth";
import { allowAttempt } from "./family/limits";
import { completeSignIn, sameOriginRequest, signInContext, signInErrorCode, SIGNIN_ERRORS, type SignInContext } from "./signin-flow";

export const EMAIL_STATE_COOKIE = "maple_email_challenge";
const PATH = "/api/maple/auth/email";
const headers = { "Cache-Control": "no-store" };
const fail = (error: string, status = 400) => NextResponse.json({ error: SIGNIN_ERRORS[error] ?? error }, { status, headers });

async function bodyOf(req: NextRequest): Promise<Record<string, unknown> | null> {
  if (!sameOriginRequest(req) || !req.headers.get("content-type")?.startsWith("application/json")) return null;
  const text = await req.text();
  if (text.length > 5000) return null;
  try { const body = JSON.parse(text); return body && typeof body === "object" && !Array.isArray(body) ? body : null; } catch { return null; }
}

export async function startEmail(req: NextRequest, start = startEmailChallenge): Promise<NextResponse> {
  try {
    const body = await bodyOf(req);
    if (!body) return fail("cross");
    const email = normalizeEmail(body.email);
    if (!email) return fail("Enter a valid email address.");
    if (body.mode === "signup" && !(await allowAttempt(req))) return fail("Too many tries. Please try again later.", 429);
    const ctx = await signInContext(req, body);
    const result = await start(req, email, ctx);
    if (!result.ok) return fail(result.error, result.status);
    const res = NextResponse.json({ ok: true }, { headers });
    res.cookies.set(EMAIL_STATE_COOKIE, result.token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", maxAge: 600, path: PATH });
    if (ctx.signup?.kind === "create") captureSignupStartedSoon();
    return res;
  } catch (error) {
    await captureServerException(error, { route: "email start" });
    return fail(signInErrorCode(error));
  }
}

export async function finishEmail(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await bodyOf(req);
    if (!body) return fail("cross");
    const token = req.cookies.get(EMAIL_STATE_COOKIE)?.value ?? "";
    const result = await verifyEmailChallenge(token, typeof body.code === "string" ? body.code : "");
    if (!result.ok) return fail(result.error, result.status);
    const ctx = result.context as SignInContext;
    const completed = await completeSignIn(req, ctx, { provider: "email", email: result.email });
    const res = NextResponse.json({ ok: true, redirect: completed.redirect }, { headers });
    res.cookies.set(EMAIL_STATE_COOKIE, "", { path: PATH, maxAge: 0 });
    grantMetricsAccess(res, result.email, completed.id);
    setSessionCookies(res, completed.id, completed.familyId);
    return res;
  } catch (error) {
    await captureServerException(error, { route: "email verify" });
    const res = fail(signInErrorCode(error));
    res.cookies.set(EMAIL_STATE_COOKIE, "", { path: PATH, maxAge: 0 });
    return res;
  }
}
