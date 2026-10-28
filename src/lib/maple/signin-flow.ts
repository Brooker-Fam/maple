import type { NextRequest } from "next/server";
import { LEGAL_VERSION } from "@/components/site/legal";
import { normalizeEmail } from "@/lib/waitlist";
import { sessionContext, signedInAs, joinWithGoogle, safeReturnPath, signInSite } from "./auth";
import { bindIdentity, bindAppleIdentity, resolveAppleIdentity, resolveEmailIdentity } from "./auth-identities";
import { IdentityConflict } from "./auth-identities";
import { effectiveSignupMode } from "./family";
import { codeUsable, normalizeCode } from "./family/codes";
import { completeSignup, validTimeZone, type SignupIntent } from "./family/signup";
import { DEFAULT_TZ } from "./time";
import type { NativePlatform } from "./native";
import { sameOriginRequest } from "./auth-request";
export { sameOriginRequest } from "./auth-request";

export type SignInContext = {
  mode: "signin" | "signup" | "link";
  site: string;
  back: string;
  signup?: SignupIntent;
  link?: { id: string; fam: number };
  native?: NativePlatform;
  challenge?: string;
};

export class SignInError extends Error {
  constructor(public code: string) { super(code); }
}

export async function signInContext(req: NextRequest, data: Record<string, unknown>): Promise<SignInContext> {
  if (!sameOriginRequest(req)) throw new SignInError("cross");
  const mode = data.mode ?? "signin";
  if (mode !== "signin" && mode !== "signup" && mode !== "link") throw new SignInError("failed");
  const ctx: SignInContext = { mode, site: signInSite(typeof data.site === "string" ? data.site : null), back: safeReturnPath(typeof data.return === "string" ? data.return : null) };
  if (mode === "link") {
    const current = await sessionContext(req);
    if (!current || !normalizeEmail(current.member.email)) throw new SignInError("link_expired");
    ctx.link = { id: current.member.email, fam: current.ctx.familyId };
    ctx.back = "/maple";
  }
  if (mode === "signup") {
    const signupMode = await effectiveSignupMode();
    if (signupMode === "off") throw new SignInError("off");
    if (typeof data.invite === "string" && data.invite) {
      if (!/^[A-Za-z0-9_-]{20,64}$/.test(data.invite)) throw new SignInError("invite");
      ctx.signup = { kind: "join", invite: data.invite };
    } else {
      if (data.terms !== "yes") throw new SignInError("terms");
      const code = signupMode === "invite" ? normalizeCode(data.code) : null;
      if (signupMode === "invite") {
        if (!code) throw new SignInError("code");
        const usable = await codeUsable(code);
        if (!usable) throw new SignInError(usable === null ? "unavailable" : "code");
      }
      ctx.signup = { kind: "create", code, tz: validTimeZone(data.tz) ?? DEFAULT_TZ, terms: LEGAL_VERSION };
    }
  }
  return ctx;
}

export type VerifiedIdentity = { provider: "email"; email: string } | { provider: "apple"; subject: string; email: string | null };

export async function completeSignIn(req: NextRequest, ctx: SignInContext, who: VerifiedIdentity): Promise<{ id: string; familyId: number; redirect: string }> {
  if (ctx.mode === "link") {
    // Apple form_post cannot carry the Lax session cookie; its single-use browser
    // proof binds the session captured at start. Re-read current membership here.
    const current = ctx.link && await signedInAs(ctx.link);
    if (!current || !normalizeEmail(current.member.email)) throw new SignInError("link_expired");
    if (who.provider === "email") {
      const session = await sessionContext(req);
      if (session?.member.email !== ctx.link!.id || session.ctx.familyId !== ctx.link!.fam) throw new SignInError("link_expired");
      await bindIdentity("email", who.email, current.member.email, who.email);
    } else {
      await bindAppleIdentity(who.subject, who.email, current.member.email);
    }
    return { id: current.member.email, familyId: current.ctx.familyId, redirect: new URL("/maple?auth=linked", ctx.site).toString() };
  }
  const id = who.provider === "email" ? await resolveEmailIdentity(who.email) : await resolveAppleIdentity(who.subject, who.email);
  const identity = { email: id, name: null };
  let familyId: number;
  if (ctx.mode === "signup" && ctx.signup) {
    const result = await completeSignup(req, identity, ctx.signup, who.email ?? id);
    if ("error" in result) throw new SignInError(result.error);
    familyId = result.familyId;
  } else {
    // Email/Apple never claim the legacy family's very first owner. Existing
    // membership or an explicit allowlist/invite remains required.
    const { homeFamilyOf } = await import("./family");
    const home = await homeFamilyOf(id);
    if (home === null) throw new SignInError("unavailable");
    if (home === undefined) throw new SignInError("not_invited");
    const joined = await joinWithGoogle(identity);
    if (!joined.member) throw new SignInError(joined.reason);
    familyId = joined.familyId;
  }
  if (who.provider === "apple") await bindAppleIdentity(who.subject, who.email, id);
  const to = new URL(safeReturnPath(ctx.back), ctx.site);
  if (to.pathname.startsWith("/maple")) to.searchParams.set("auth", "ok");
  return { id, familyId, redirect: to.toString() };
}

export function signInErrorCode(error: unknown): string {
  if (error instanceof IdentityConflict) return "link_conflict";
  return error instanceof SignInError ? error.code : "unavailable";
}

export const SIGNIN_ERRORS: Record<string, string> = {
  cross: "Start from Maple’s own sign-in page.",
  failed: "That sign-in didn’t work. Please try again.",
  unavailable: "Sign-in is unavailable for a moment. Please try again shortly.",
  not_invited: "This account isn’t in a family’s log yet. Open your family’s invite link, or get started from Maple’s sign-up page.",
  off: "Sign-up isn’t open yet.",
  terms: "Please agree to the terms before starting your family’s log.",
  code: "That invite code doesn’t work. Check it or ask for a new one.",
  invite: "That invite link has expired, was used, or was sent to another address. Ask for a new one.",
  link_expired: "Sign in to your existing account again, then connect this sign-in method from Family.",
  link_conflict: "That sign-in method already belongs to a different account. Sign in with that account to use its log.",
  full: "Maple has taken all the new families it can for today. Try again tomorrow.",
  ip_limit: "Several families were started from this connection today. Try again tomorrow.",
  account_limit: "This account already started a family today. Sign in to it instead.",
};
