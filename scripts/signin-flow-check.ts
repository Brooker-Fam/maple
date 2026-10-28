/** Full auth flows with PGlite, fake mail and fake provider identities; no external requests. */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { done, freshDb, seedFamilies, sql, test } from "./tenancy/harness";
import * as auth from "../src/lib/maple/auth";
import { startEmail, finishEmail, EMAIL_STATE_COOKIE } from "../src/lib/maple/email-flow";
import { startEmailChallenge } from "../src/lib/maple/email-auth";
import { beginApple, finishApple, APPLE_STATE_COOKIE } from "../src/lib/maple/apple-flow";
import { APPLE_CALLBACK_PATH, type AppleIdentity } from "../src/lib/maple/apple";
import { signInContext, type SignInContext } from "../src/lib/maple/signin-flow";
import { identityMember } from "../src/lib/maple/auth-identities";
import { handleMapleGoogleCallback } from "../src/lib/maple/google-callback";
import { createSignupCode } from "../src/lib/maple/family/codes";
import { setLaterRunner } from "../src/lib/maple/push-hooks";
import { nativeChallengeFor, openNativeTicket } from "../src/lib/maple/native-auth";
import { GET as redeemNative } from "../src/app/api/maple/auth/native/route";

const BASE = "https://maple.example.com";
process.env.NEXT_PUBLIC_BASE_URL = BASE;
process.env.MCP_SECRET = "signin-check-mcp-secret";
process.env.MAPLE_SESSION_SECRET = "signin-check-session-secret";
process.env.GOOGLE_CLIENT_ID = "signin-check.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "signin-check-google-secret";
process.env.RESEND_API_KEY = "re_check_not_a_key";
process.env.RESEND_EMAIL_DOMAIN = "example.com";
process.env.APPLE_CLIENT_ID = "app.example.maple";
process.env.APPLE_TEAM_ID = "TESTTEAM01";
process.env.APPLE_KEY_ID = "TESTKEY001";
process.env.APPLE_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
process.env.MAPLE_SIGNUP_DAILY_MAX = "50";
delete process.env.MAPLE_ALLOWED_EMAILS;
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.MAPLE_EMAIL_AUTH_DAILY_MAX;
delete process.env.VERCEL_ENV;
delete process.env.VERCEL_URL;

let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("External requests are forbidden in auth checks"); };
setLaterRunner(() => {}); // Welcome/analytics jobs are covered by their own tests.
let ipSeq = 0;
let lastCode = "";

const cookieValue = (res: Response, name: string): string | null => {
  const line = res.headers.getSetCookie().find((value) => value.startsWith(`${name}=`) && !value.startsWith(`${name}=;`));
  return line ? /^[^=]+=([^;]*)/.exec(line)![1] : null;
};
const sessionCookie = (id: string, familyId: number) => `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.sealSession(id, familyId))}`;
const sessionOf = (res: Response) => {
  const value = cookieValue(res, auth.SESSION_COOKIE);
  return value ? auth.openSession(decodeURIComponent(value)) : null;
};
const jsonReq = (path: string, body: unknown, cookie = "", headers: Record<string, string> = {}) => new NextRequest(new URL(path, BASE), {
  method: "POST", headers: { "content-type": "application/json", origin: BASE, "sec-fetch-site": "same-origin", "x-real-ip": `198.51.100.${++ipSeq}`, cookie, ...headers }, body: JSON.stringify(body),
});
const beginEmail = (fields: Record<string, unknown>, cookie = "", headers: Record<string, string> = {}) => startEmail(
  jsonReq("/api/maple/auth/email/start", { site: BASE, ...fields }, cookie, headers),
  (req, email, context) => startEmailChallenge(req, email, context, { send: async (message) => {
    lastCode = message.text.match(/\b\d{6}\b/)?.[0] ?? "";
    assert.match(lastCode, /^\d{6}$/);
    return { sent: true, id: "fake-signin-message" };
  } })
);
async function emailFlow(fields: Record<string, unknown>, cookie = "") {
  const start = await beginEmail(fields, cookie);
  assert.equal(start.status, 200, JSON.stringify(await start.clone().json()));
  const token = cookieValue(start, EMAIL_STATE_COOKIE);
  assert.ok(token);
  return finishEmail(jsonReq("/api/maple/auth/email/verify", { code: lastCode }, `${EMAIL_STATE_COOKIE}=${token}; ${cookie}`));
}
async function signedIn(res: Response, id: string, familyId: number) {
  const session = sessionOf(res);
  assert.deepEqual(session, { id, fam: familyId });
  const current = await auth.signedInAs(session);
  assert.equal(current?.member.email, id);
  assert.equal(current?.ctx.familyId, familyId);
  return current;
}
const signin: SignInContext = { mode: "signin", site: BASE, back: "/maple" };
async function appleStart(ctx = signin) {
  const res = await beginApple(new NextRequest(`${BASE}/api/maple/auth/apple/start`), ctx);
  const url = new URL(res.headers.get("location") ?? BASE);
  assert.equal(url.origin, "https://appleid.apple.com", res.headers.get("location") ?? "missing redirect");
  const cookie = cookieValue(res, APPLE_STATE_COOKIE);
  assert.ok(cookie);
  return { res, cookie, state: url.searchParams.get("state")!, nonce: url.searchParams.get("nonce")! };
}
type AppleStart = Awaited<ReturnType<typeof appleStart>>;
function appleRequest(start: AppleStart, overrides: { cookie?: string; state?: string; error?: string } = {}) {
  return new NextRequest(`${BASE}${APPLE_CALLBACK_PATH}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://appleid.apple.com", cookie: `${APPLE_STATE_COOKIE}=${overrides.cookie ?? start.cookie}` },
    body: new URLSearchParams({ state: overrides.state ?? start.state, code: "fake-apple-code", ...(overrides.error ? { error: overrides.error } : {}) }).toString(),
  });
}
async function appleBack(start: AppleStart, identity: AppleIdentity) {
  return finishApple(appleRequest(start), async (code, nonce, site) => {
    assert.equal(code, "fake-apple-code"); assert.equal(nonce, start.nonce); assert.equal(site, BASE);
    return identity;
  });
}
const authReason = (res: Response) => new URL(res.headers.get("location") ?? BASE).searchParams.get("auth");

async function main() {
  await freshDb({ shape: "final" });
  process.env.MAPLE_SIGNUP = "off";
  const check = (name: string, run: () => Promise<void>) => test(name, async () => {
    await sql("TRUNCATE maple_auth_challenges, maple_oauth_attempts, upload_rate_limit");
    await run();
  });

  await check("email cannot bootstrap a stranger as the legacy family's first owner", async () => {
    const res = await emailFlow({ email: "stranger@example.com" });
    assert.equal(res.status, 400);
    assert.equal(sessionOf(res), null);
    assert.equal((await sql("SELECT * FROM maple_members")).length, 0);
  });

  const { alpha, beta } = await seedFamilies();
  process.env.MAPLE_SIGNUP = "open";

  await check("email sign-in opens the existing Google member and original history", async () => {
    const before = await sql("SELECT id FROM maple_entries WHERE family_id = $1 ORDER BY id", [alpha.familyId]);
    const res = await emailFlow({ email: alpha.owner });
    assert.equal(res.status, 200);
    await signedIn(res, alpha.owner, alpha.familyId);
    assert.deepEqual(await sql("SELECT id FROM maple_entries WHERE family_id = $1 ORDER BY id", [alpha.familyId]), before);
    assert.equal((await sql("SELECT * FROM maple_families")).length, 2);
  });

  await check("email codes cannot be completed from a different browser or cross-origin page", async () => {
    const start = await beginEmail({ email: alpha.owner });
    const code = lastCode;
    const token = cookieValue(start, EMAIL_STATE_COOKIE)!;
    const noCookie = await finishEmail(jsonReq("/api/maple/auth/email/verify", { code }));
    assert.equal(noCookie.status, 400);
    const cross = await finishEmail(jsonReq("/api/maple/auth/email/verify", { code }, `${EMAIL_STATE_COOKIE}=${token}`, { origin: "https://untrusted.example.com", "sec-fetch-site": "same-site" }));
    assert.equal(cross.status, 400);
    const valid = await finishEmail(jsonReq("/api/maple/auth/email/verify", { code }, `${EMAIL_STATE_COOKIE}=${token}`));
    await signedIn(valid, alpha.owner, alpha.familyId);
  });

  await check("signup requires terms and honors closed and invite-only modes before sending", async () => {
    let res = await beginEmail({ mode: "signup", email: "newparent@example.com" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /terms/);
    process.env.MAPLE_SIGNUP = "off";
    res = await beginEmail({ mode: "signup", email: "newparent@example.com", terms: "yes" });
    assert.equal(res.status, 400);
    process.env.MAPLE_SIGNUP = "invite";
    res = await beginEmail({ mode: "signup", email: "newparent@example.com", terms: "yes", code: "wrong" });
    assert.equal(res.status, 400);
    assert.equal((await sql("SELECT * FROM maple_auth_challenges")).length, 0);
    process.env.MAPLE_SIGNUP = "open";
  });

  await check("email signup creates one family and repeated signup returns the same membership", async () => {
    const res = await emailFlow({ mode: "signup", email: "newparent@example.com", terms: "yes", tz: "America/Denver" });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const session = sessionOf(res)!;
    assert.equal(session.id, "newparent@example.com");
    assert.ok(Number(session.fam) > 2);
    assert.equal((await sql("SELECT status FROM maple_families WHERE id = $1", [session.fam]))[0].status, "onboarding");
    await sql("TRUNCATE maple_auth_challenges, upload_rate_limit");
    const again = await emailFlow({ mode: "signup", email: "newparent@example.com", terms: "yes" });
    assert.deepEqual(sessionOf(again), session);
    assert.equal((await sql("SELECT * FROM maple_members WHERE email = 'newparent@example.com'")).length, 1);
  });

  await check("invite signup spends the invitation only after email is verified", async () => {
    process.env.MAPLE_SIGNUP = "invite";
    const code = await createSignupCode();
    const start = await beginEmail({ mode: "signup", email: "invitedparent@example.com", terms: "yes", code });
    assert.equal(start.status, 200);
    assert.equal((await sql("SELECT uses FROM maple_signup_codes ORDER BY created_at DESC LIMIT 1"))[0].uses, 0);
    const res = await finishEmail(jsonReq("/api/maple/auth/email/verify", { code: lastCode }, `${EMAIL_STATE_COOKIE}=${cookieValue(start, EMAIL_STATE_COOKIE)}`));
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.equal((await sql("SELECT uses FROM maple_signup_codes ORDER BY created_at DESC LIMIT 1"))[0].uses, 1);
    const next = await beginEmail({ mode: "signup", email: "anotherparent@example.com", terms: "yes", code });
    assert.equal(next.status, 400);
    process.env.MAPLE_SIGNUP = "open";
  });

  await check("addressed family invites require the verified recipient and preserve their role", async () => {
    const invite = await auth.createInvite({ familyId: beta.familyId }, { role: "viewer", displayName: "Invited Test", emoji: null, createdBy: beta.owner, email: "guest@example.com" });
    const wrong = await emailFlow({ mode: "signup", email: "wrongguest@example.com", invite: invite.token });
    assert.equal(wrong.status, 400);
    assert.equal((await sql("SELECT used_at FROM maple_invites WHERE id = $1", [invite.invite.id]))[0].used_at, null);
    const right = await emailFlow({ mode: "signup", email: "guest@example.com", invite: invite.token });
    const current = await signedIn(right, "guest@example.com", beta.familyId);
    assert.equal(current?.member.role, "viewer");
  });

  await check("pending membership cannot sign in or be stolen through email linking", async () => {
    await sql("INSERT INTO maple_members (family_id, email, role, added_by) VALUES ($1, 'pending@example.com', 'member', $2)", [beta.familyId, beta.owner]);
    const plain = await emailFlow({ email: "pending@example.com" });
    assert.equal(plain.status, 400);
    await sql("TRUNCATE maple_auth_challenges, upload_rate_limit");
    const link = await emailFlow({ mode: "link", email: "pending@example.com" }, sessionCookie(alpha.owner, alpha.familyId));
    assert.equal(link.status, 400);
    assert.match((await link.json()).error, /different account/);
  });

  await check("email linking needs the same valid signed-in member at start and completion", async () => {
    const anonymous = await beginEmail({ mode: "link", email: "alternate@example.com" });
    assert.equal(anonymous.status, 400);
    const start = await beginEmail({ mode: "link", email: "alternate@example.com" }, sessionCookie(alpha.owner, alpha.familyId));
    assert.equal(start.status, 200);
    const finish = await finishEmail(jsonReq("/api/maple/auth/email/verify", { code: lastCode }, `${EMAIL_STATE_COOKIE}=${cookieValue(start, EMAIL_STATE_COOKIE)}`));
    assert.equal(finish.status, 400);
    assert.equal(await identityMember("email", "alternate@example.com"), null);
  });

  await check("linked email and its Google login both return the original member", async () => {
    const linked = await emailFlow({ mode: "link", email: "alternate@example.com" }, sessionCookie(alpha.owner, alpha.familyId));
    await signedIn(linked, alpha.owner, alpha.familyId);
    assert.equal(await identityMember("email", "alternate@example.com"), alpha.owner);
    await sql("TRUNCATE maple_auth_challenges, upload_rate_limit");
    await signedIn(await emailFlow({ email: "alternate@example.com" }), alpha.owner, alpha.familyId);
    const state = "maple.fake-google-alias-state";
    const response = await handleMapleGoogleCallback(new NextRequest(`${BASE}/api/maple/auth/callback?state=${state}&code=fake`, {
      headers: { cookie: `${auth.STATE_COOKIE}=${encodeURIComponent(JSON.stringify({ state, back: "/maple", site: BASE }))}` },
    }), { identify: async () => ({ email: "alternate@example.com", name: null }) });
    await signedIn(response, alpha.owner, alpha.familyId);
    assert.equal((await sql("SELECT * FROM maple_members WHERE email = 'alternate@example.com'")).length, 0);
  });

  await check("an addressed invite to a linked email adds the canonical member only", async () => {
    const invite = await auth.createInvite({ familyId: beta.familyId }, { role: "viewer", displayName: null, emoji: null, createdBy: beta.owner, email: "alternate@example.com" });
    const wrong = await emailFlow({ mode: "signup", email: alpha.member, invite: invite.token });
    assert.equal(wrong.status, 400);
    assert.equal((await sql("SELECT used_at FROM maple_invites WHERE id = $1", [invite.invite.id]))[0].used_at, null);
    const right = await emailFlow({ mode: "signup", email: "alternate@example.com", invite: invite.token });
    const current = await signedIn(right, alpha.owner, beta.familyId);
    assert.equal(current?.member.role, "viewer");
    assert.equal((await sql("SELECT * FROM maple_members WHERE email = 'alternate@example.com'")).length, 0);
    assert.equal((await sql("SELECT used_by FROM maple_invites WHERE id = $1", [invite.invite.id]))[0].used_by, alpha.owner);
  });

  await check("failed email signin and signup do not reserve an address or prevent later linking", async () => {
    const email = "unregistered-link@example.com";
    assert.equal((await emailFlow({ email })).status, 400);
    assert.equal(await identityMember("email", email), null);
    await sql("TRUNCATE maple_auth_challenges, upload_rate_limit");
    assert.equal((await emailFlow({ mode: "signup", email, invite: "missing_invitation_token_12345" })).status, 400);
    assert.equal(await identityMember("email", email), null);
    await sql("TRUNCATE maple_auth_challenges, upload_rate_limit");
    await signedIn(await emailFlow({ mode: "link", email }, sessionCookie(alpha.member, alpha.familyId)), alpha.member, alpha.familyId);
    assert.equal(await identityMember("email", email), alpha.member);
  });

  await check("invalid signup code guesses are limited before any email is sent", async () => {
    process.env.MAPLE_SIGNUP = "invite";
    try {
      for (let i = 0; i < 20; i++) {
        const res = await beginEmail({ mode: "signup", email: "guessing@example.com", terms: "yes", code: "wrong" }, "", { "x-real-ip": "203.0.113.88" });
        assert.equal(res.status, 400);
      }
      const res = await beginEmail({ mode: "signup", email: "guessing@example.com", terms: "yes", code: "wrong" }, "", { "x-real-ip": "203.0.113.88" });
      assert.equal(res.status, 429);
      assert.equal((await sql("SELECT * FROM maple_auth_challenges")).length, 0);
    } finally { process.env.MAPLE_SIGNUP = "open"; }
  });

  await check("same-site sibling origins cannot start or link sign-in methods", async () => {
    const sibling = { origin: "https://sibling.example.com", "sec-fetch-site": "same-site" };
    const res = await beginEmail({ mode: "link", email: "sibling-link@example.com" }, sessionCookie(alpha.member, alpha.familyId), sibling);
    assert.equal(res.status, 400);
    assert.equal((await sql("SELECT * FROM maple_auth_challenges")).length, 0);
    await assert.rejects(() => signInContext(jsonReq("/api/maple/auth/apple/start", {}, sessionCookie(alpha.member, alpha.familyId), sibling), { mode: "link", site: BASE }), /cross/);
  });

  await check("legacy addMember resolves linked addresses without creating shadow members", async () => {
    const email = "legacy-member-alias@example.com";
    await signedIn(await emailFlow({ mode: "link", email }, sessionCookie(beta.member, beta.familyId)), beta.member, beta.familyId);
    await auth.addMember({ familyId: alpha.familyId }, email, alpha.owner, null, "viewer");
    assert.equal((await sql("SELECT * FROM maple_members WHERE email = $1", [email])).length, 0);
    const member = await auth.memberFor({ familyId: alpha.familyId }, beta.member);
    assert.equal(member?.email, beta.member);
    assert.equal(member?.role, "viewer");
  });

  await check("another family's account cannot be linked or merged", async () => {
    const res = await emailFlow({ mode: "link", email: beta.owner }, sessionCookie(alpha.owner, alpha.familyId));
    assert.equal(res.status, 400);
    assert.equal(sessionOf(res), null);
    assert.match((await res.json()).error, /different account/);
    assert.equal((await sql("SELECT family_id FROM maple_members WHERE email = $1", [beta.owner]))[0].family_id, String(beta.familyId));
  });

  await check("Apple callback binds state to the browser, forwards nonce and cannot replay", async () => {
    const start = await appleStart();
    let calls = 0;
    const identity = { subject: "apple-owner-alpha", email: alpha.owner, name: null } as const;
    const refused = await finishApple(appleRequest(start, { cookie: "a".repeat(43) }), async () => { calls++; return identity; });
    assert.equal(authReason(refused), "bad_state"); assert.equal(calls, 0);
    const res = await appleBack(start, identity);
    await signedIn(res, alpha.owner, alpha.familyId);
    const replay = await finishApple(appleRequest(start), async () => { calls++; return identity; });
    assert.equal(authReason(replay), "bad_state"); assert.equal(calls, 0);
    assert.ok(start.res.headers.getSetCookie().some((line) => line.includes("HttpOnly") && line.includes("Secure") && /SameSite=none/i.test(line)));
  });

  await check("Apple expired state and cancelled consent mint no sessions", async () => {
    const expired = await appleStart();
    await sql("UPDATE maple_oauth_attempts SET expires_at = NOW() - INTERVAL '1 second'");
    let calls = 0;
    const identify = async () => { calls++; return { subject: "apple-owner-alpha", email: alpha.owner, name: null }; };
    assert.equal(authReason(await finishApple(appleRequest(expired), identify)), "bad_state");
    const cancelled = await appleStart();
    assert.equal(authReason(await finishApple(appleRequest(cancelled, { error: "access_denied" }), identify)), "denied");
    assert.equal(calls, 0);
  });

  await check("failed Apple signin and signup leave no relay reservation and can later link", async () => {
    const identity = { subject: "apple-failed-then-linked", email: "failed-link@privaterelay.appleid.com", name: null } as const;
    const failed = await appleBack(await appleStart(), identity);
    assert.equal(authReason(failed), "not_invited");
    assert.equal(await identityMember("apple", identity.subject), null);
    assert.equal(await identityMember("email", identity.email), null);
    const signup = await signInContext(jsonReq("/api/maple/auth/apple/start", {}), { mode: "signup", site: BASE, invite: "missing_invitation_token_12345" });
    const failedSignup = await appleBack(await appleStart(signup), identity);
    assert.equal(new URL(failedSignup.headers.get("location")!).searchParams.get("error"), "invite");
    assert.equal(await identityMember("apple", identity.subject), null);
    assert.equal(await identityMember("email", identity.email), null);
    const link = await signInContext(jsonReq("/api/maple/auth/apple/start", {}, sessionCookie(alpha.member, alpha.familyId)), { mode: "link", site: BASE });
    await signedIn(await appleBack(await appleStart(link), identity), alpha.member, alpha.familyId);
    assert.equal(await identityMember("apple", identity.subject), alpha.member);
  });

  await check("Apple native sign-in issues a ticket bound to the requesting app verifier", async () => {
    const verifier = "v".repeat(43);
    const challenge = nativeChallengeFor(verifier);
    const start = await appleStart({ ...signin, native: "ios", challenge, back: "/maple?tab=history" });
    const res = await appleBack(start, { subject: "apple-native-alpha", email: alpha.member, name: null });
    const redirect = new URL(res.headers.get("location")!);
    assert.equal(redirect.protocol, "maple:"); assert.equal(redirect.hostname, "auth");
    const ticket = redirect.searchParams.get("ticket")!;
    assert.deepEqual(openNativeTicket(ticket), { id: alpha.member, fam: alpha.familyId, back: "/maple?tab=history", challenge });
    const endpoint = `${BASE}/api/maple/auth/native?ticket=${encodeURIComponent(ticket)}`;
    const wrong = await redeemNative(new NextRequest(endpoint, { headers: { "x-maple-verifier": "w".repeat(43) } }));
    assert.equal(authReason(wrong), "failed"); assert.equal(sessionOf(wrong), null);
    const right = await redeemNative(new NextRequest(endpoint, { headers: { "x-maple-verifier": verifier } }));
    await signedIn(right, alpha.member, alpha.familyId);
    assert.equal(new URL(right.headers.get("location")!).searchParams.get("tab"), "history");
  });

  await check("session changes and signout invalidate pending Apple browser proof", async () => {
    for (const mutate of [(res: NextResponse) => auth.setSessionCookies(res, alpha.owner, alpha.familyId), auth.clearSessionCookies]) {
      const res = NextResponse.json({ ok: true });
      mutate(res);
      const cookies = res.headers.getSetCookie();
      assert.ok(cookies.some((line) => line.startsWith(`${APPLE_STATE_COOKIE}=;`) && line.includes(`Path=${APPLE_CALLBACK_PATH}`) && line.includes("Max-Age=0") && line.includes("HttpOnly") && line.includes("Secure")));
      for (const path of auth.SESSION_PATHS) assert.ok(cookies.some((line) => line.startsWith(`${auth.SESSION_COOKIE}=`) && line.includes(`Path=${path};`)));
    }
  });

  await check("Apple linking preserves an existing member when Hide My Email is used", async () => {
    const req = jsonReq("/api/maple/auth/apple/start", {}, sessionCookie(alpha.member, alpha.familyId));
    const ctx = await signInContext(req, { mode: "link", site: BASE });
    const start = await appleStart(ctx);
    const res = await appleBack(start, { subject: "apple-hidden-alpha", email: "hidden@privaterelay.appleid.com", name: null });
    await signedIn(res, alpha.member, alpha.familyId);
    assert.equal(authReason(res), "linked");
    assert.equal(await identityMember("apple", "apple-hidden-alpha"), alpha.member);
    assert.equal(await identityMember("email", "hidden@privaterelay.appleid.com"), alpha.member);
    const later = await appleBack(await appleStart(), { subject: "apple-hidden-alpha", email: null, name: null });
    await signedIn(later, alpha.member, alpha.familyId);
    await signedIn(await emailFlow({ email: "hidden@privaterelay.appleid.com" }), alpha.member, alpha.familyId);
    assert.equal((await sql("SELECT * FROM maple_members WHERE email = 'hidden@privaterelay.appleid.com'")).length, 0);
  });

  await check("Apple linking cannot attach another family's account", async () => {
    const req = jsonReq("/api/maple/auth/apple/start", {}, sessionCookie(alpha.owner, alpha.familyId));
    const start = await appleStart(await signInContext(req, { mode: "link", site: BASE }));
    const res = await appleBack(start, { subject: "apple-owner-beta", email: beta.owner, name: null });
    assert.equal(authReason(res), "link_conflict");
    assert.equal(sessionOf(res), null);
    assert.equal(await identityMember("apple", "apple-owner-beta"), null);
  });

  await check("removing a member during Apple linking invalidates the captured session", async () => {
    const req = jsonReq("/api/maple/auth/apple/start", {}, sessionCookie(alpha.viewer, alpha.familyId));
    const start = await appleStart(await signInContext(req, { mode: "link", site: BASE }));
    await sql("DELETE FROM maple_members WHERE family_id = $1 AND email = $2", [alpha.familyId, alpha.viewer]);
    const res = await appleBack(start, { subject: "apple-removed", email: "removed@privaterelay.appleid.com", name: null });
    assert.equal(authReason(res), "link_expired");
    assert.equal(await identityMember("apple", "apple-removed"), null);
  });

  await test("sign-in integration uses no external requests", () => assert.equal(networkCalls, 0));
  done("signin-flow-check.ts");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Sign-in integration failed");
  process.exitCode = 1;
});
