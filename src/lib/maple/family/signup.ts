import { randomUUID } from "crypto";
import { resolveEmailIdentity } from "../auth-identities";
import { sameOriginRequest } from "../auth-request";
import { NextResponse, type NextRequest } from "next/server";
import { captureAppEvent, captureSignupCompleted, captureSignupStartedSoon } from "@/lib/analytics/server";
import { LEGAL_VERSION } from "@/components/site/legal";
import { emailWelcome } from "@/lib/email/notices";
import { captureServerException } from "@/lib/posthog-server";
import { encryptSecret, getAppBaseUrl, openSecret } from "@/lib/secret-box";
import {
  authorizeUrl,
  identityFromCode,
  isGoogleConfigured,
  joinWithGoogle,
  MAPLE_STATE_PREFIX,
  setSessionCookies,
  signInSite,
  STATE_COOKIE,
  STATE_COOKIE_PATH,
  type GoogleIdentity,
} from "../auth";
import { effectiveSignupMode } from "../family";
import { later } from "../push-hooks";
import { DEFAULT_TZ } from "../time";
import { normalizeCode, codeUsable } from "./codes";
import { createFamily, homeFamily, joinByInvite } from "./create";
import { allowAttempt } from "./limits";

/**
 * /signup's Google sign-in. POST /api/maple/signup/start takes the form
 * (invite code, timezone, terms, or an invite link's token), checks it, and
 * sends the browser to Google with the usual state cookie plus a sealed
 * `signup` intent. Google returns to the one registered callback,
 * /api/maple/auth/callback, which hands a state carrying that intent to
 * handleSignupCallback. Only then is a family made (or joined), so nobody
 * holds a session for a family they don't belong to.
 */

export const SIGNUP_STATE_PREFIX = `${MAPLE_STATE_PREFIX}signup.`;
const INTENT_KIND = "maple-signup";
const INTENT_TTL_MS = 10 * 60_000;

export type SignupIntent = { kind: "create"; code: string | null; tz: string; terms: string } | { kind: "join"; invite: string };

export function sealIntent(intent: SignupIntent, now = Date.now()): string {
  return encryptSecret(JSON.stringify({ k: INTENT_KIND, exp: now + INTENT_TTL_MS, ...intent }));
}

export function openIntent(raw: unknown, now = Date.now()): SignupIntent | null {
  if (typeof raw !== "string" || !raw || raw.length > 2048) return null;
  try {
    const opened = openSecret(raw);
    if (opened.prev) return null;
    const v = JSON.parse(opened.text);
    if (v?.k !== INTENT_KIND || typeof v.exp !== "number" || now > v.exp) return null;
    if (v.kind === "join") return typeof v.invite === "string" && v.invite ? { kind: "join", invite: v.invite } : null;
    if (v.kind !== "create" || typeof v.terms !== "string") return null;
    const tz = validTimeZone(v.tz);
    if (!tz) return null;
    return { kind: "create", code: v.code == null ? null : normalizeCode(v.code), tz, terms: v.terms };
  } catch {
    return null;
  }
}

/** An IANA zone this runtime knows, or null. */
export function validTimeZone(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(raw)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export const SIGNUP_ERRORS = {
  off: "Sign-up isn’t open yet. Join the waitlist to hear when it is.",
  code: "That invite code doesn’t work. Check it, or ask whoever sent it for a new one.",
  terms: "Tick the box to say you’re 18 or older and agree to the terms.",
  busy: "Too many tries from this connection. Try again in an hour.",
  full: "Maple has taken all the new families it can for today. Try again tomorrow.",
  ip_limit: "Several families were started from this connection today. Try again tomorrow.",
  account_limit: "That account started a family in the last day. Sign in to it instead.",
  invite: "That invite link has been used or has expired. Ask the family for a new one.",
  elsewhere: "That account is already in another family’s log, and can join a second one later. Use the invite link without Google for now.",
  cross: "Start from Maple’s own sign-up page.",
  not_configured: "That sign-in method isn’t set up here yet.",
  denied: "Sign-in was cancelled. Try again whenever you’re ready.",
  bad_state: "That sign-in took a wrong turn (it may have sat open too long). Please try once more.",
  no_email: "Your sign-in provider didn’t share a verified email for that account. Try a different account.",
  unavailable: "Maple is offline for a moment. Please try again shortly.",
  failed: "Something went wrong. Please try again.",
} as const;

export type SignupError = keyof typeof SIGNUP_ERRORS;

export function isSignupError(raw: unknown): raw is SignupError {
  return typeof raw === "string" && Object.hasOwn(SIGNUP_ERRORS, raw);
}

function toSignup(base: string, error: SignupError, join?: boolean): NextResponse {
  const url = new URL("/signup", base);
  url.searchParams.set("error", error);
  if (join) url.searchParams.set("join", "1");
  return NextResponse.redirect(url.toString(), 303);
}

async function readForm(req: Request): Promise<URLSearchParams | null> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("application/x-www-form-urlencoded")) return null;
  const text = await req.text().catch(() => null);
  return text != null && text.length <= 4000 ? new URLSearchParams(text) : null;
}

/** POST /api/maple/signup/start: a plain form post, so it works before the page's script loads. */
export async function startSignup(req: NextRequest): Promise<NextResponse> {
  const base = getAppBaseUrl();
  if (!sameOriginRequest(req)) return toSignup(base, "cross");
  const form = await readForm(req);
  const site = signInSite(form?.get("site"));
  const invite = form?.get("invite")?.trim() || null;
  const fail = (error: SignupError) => toSignup(site, error, !!invite);
  if (!form) return fail("failed");
  const mode = await effectiveSignupMode();
  if (mode === "off") return fail("off");
  const provider = form.get("provider") ?? "google";
  if (provider !== "google" && provider !== "apple") return fail("not_configured");
  if (provider === "google" && !isGoogleConfigured()) return fail("not_configured");
  if (!(await allowAttempt(req))) return fail("busy");

  let intent: SignupIntent;
  if (invite) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(invite)) return fail("invite");
    intent = { kind: "join", invite };
  } else {
    if (form.get("terms") !== "yes") return fail("terms");
    let code: string | null = null;
    if (mode === "invite") {
      code = normalizeCode(form.get("code"));
      if (!code) return fail("code");
      const usable = await codeUsable(code);
      if (usable === null) return fail("unavailable");
      if (!usable) return fail("code");
    }
    intent = { kind: "create", code, tz: validTimeZone(form.get("tz")) ?? DEFAULT_TZ, terms: LEGAL_VERSION };
  }

  if (provider === "apple") {
    const { beginApple } = await import("../apple-flow");
    const response = await beginApple(req, { mode: "signup", signup: intent, site, back: "/maple" });
    if (intent.kind === "create" && response.headers.get("location")?.startsWith("https://appleid.apple.com/")) captureSignupStartedSoon();
    return response;
  }

  const state = `${SIGNUP_STATE_PREFIX}${randomUUID()}`;
  const res = NextResponse.redirect(authorizeUrl(state, site), 303);
  res.cookies.set(STATE_COOKIE, JSON.stringify({ state, back: "/maple", site, signup: sealIntent(intent) }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: STATE_COOKIE_PATH,
  });
  if (intent.kind === "create") captureSignupStartedSoon();
  return res;
}

type CallbackState = { state: string; site: string; signup: unknown };

function readState(req: NextRequest): CallbackState | null {
  try {
    const raw = req.cookies.get(STATE_COOKIE)?.value;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: unknown; site?: unknown; signup?: unknown };
    if (typeof parsed.state !== "string" || parsed.signup === undefined) return null;
    return { state: parsed.state, site: signInSite(typeof parsed.site === "string" ? parsed.site : null), signup: parsed.signup };
  } catch {
    return null;
  }
}

/** True when the callback is finishing a /signup sign-in (its state cookie carries an intent). */
export function isSignupCallback(req: NextRequest): boolean {
  return readState(req) !== null || (new URL(req.url).searchParams.get("state") ?? "").startsWith(SIGNUP_STATE_PREFIX);
}

// An address on MAPLE_ALLOWED_EMAILS that comes in by /signup joins family 1, as a plain sign-in would, instead of making a family.
function onFamilyOneAllowlist(email: string): boolean {
  return (process.env.MAPLE_ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .includes(email);
}

export type SignupCallbackDeps = { identify: (code: string, site: string) => Promise<GoogleIdentity | null> };

/** The sign-up half of GET /api/maple/auth/callback. */
export async function handleSignupCallback(req: NextRequest, deps: SignupCallbackDeps = { identify: identityFromCode }): Promise<NextResponse> {
  const params = new URL(req.url).searchParams;
  const saved = readState(req);
  const site = saved?.site ?? getAppBaseUrl();
  const intent = openIntent(saved?.signup);
  const join = intent?.kind === "join";
  const finish = (res: NextResponse) => {
    res.cookies.set(STATE_COOKIE, "", { path: STATE_COOKIE_PATH, maxAge: 0 });
    return res;
  };
  const fail = (error: SignupError) => finish(toSignup(site, error, join));

  try {
    if (params.get("error")) return fail("denied");
    const state = params.get("state");
    if (!saved || !state || state !== saved.state || !intent) return fail("bad_state");
    const code = params.get("code");
    if (!code) return fail("bad_state");
    const mode = await effectiveSignupMode();
    if (mode === "off") return fail("off");

    const who = await deps.identify(code, site);
    if (!who) return fail("no_email");

    const verifiedEmail = who.email;
    who.email = await resolveEmailIdentity(who.email);
    const completed = await completeSignup(req, who, intent, verifiedEmail);
    if ("error" in completed) return fail(completed.error);
    const { familyId } = completed;

    const url = new URL("/maple", site);
    url.searchParams.set("auth", "ok");
    const res = finish(NextResponse.redirect(url.toString()));
    // After every res.cookies call: setSessionCookies appends raw Set-Cookie headers that a later one would drop.
    setSessionCookies(res, who.email, familyId);
    return res;
  } catch (error) {
    await captureServerException(error, { route: "GET /api/maple/auth/callback (signup)" });
    return fail("failed");
  }
}

/** The same family admission rules for each verified sign-in provider. */
export async function completeSignup(req: NextRequest, who: GoogleIdentity, intent: SignupIntent, verifiedEmail = who.email): Promise<{ familyId: number } | { error: SignupError }> {
  const mode = await effectiveSignupMode();
  if (mode === "off") return { error: "off" };
  if (intent.kind === "join") {
    const joined = await joinByInvite(who, intent.invite, verifiedEmail);
    return joined.reason ? { error: joined.reason } : { familyId: joined.familyId };
  }
  if (onFamilyOneAllowlist(who.email)) {
    const joined = await joinWithGoogle(who);
    return joined.member ? { familyId: joined.familyId } : { error: joined.reason === "unavailable" ? "unavailable" : "failed" };
  }
  const created = await createFamily(who, { code: intent.code, tz: intent.tz, via: mode, terms: intent.terms }, req);
  if (created.reason === "exists") {
    const familyId = await homeFamily(who.email);
    return familyId === null ? { error: "unavailable" } : { familyId };
  }
  if (created.reason) return { error: created.reason };
  const familyId = created.familyId;
  const made = { familyId, to: who.email, name: who.name, origin: getAppBaseUrl() };
  later(async () => {
    await Promise.all([emailWelcome(made), captureAppEvent(familyId, "signed_up"), captureSignupCompleted(familyId)]);
  }, "maple signup notices");
  return { familyId };
}
