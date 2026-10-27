import type { NextRequest } from "next/server";
import { LEGAL_VERSION } from "../../src/components/site/legal";
import { done, eq, freshDb, ok, quietly, seedFamilies, sha256, sql, test } from "./harness";

/**
 * Sign-up (MAPLE_SIGNUP): /signup's Google sign-in creates a family and its
 * owner, or joins a family by its invite link, behind the per-connection,
 * per-account, per-day and per-code limits, and the switcher shows only for
 * someone in two or more families. Off (the default, and on production's
 * schema whatever the switch says) nothing new happens. Made-up people only;
 * Google is a stand-in that names a made-up address.
 */

delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.MAPLE_ALLOWED_EMAILS;
delete process.env.MAPLE_ADMIN_FAMILY_ID;
delete process.env.NEXT_PUBLIC_BASE_URL;
delete process.env.VERCEL_ENV;
delete process.env.VERCEL_URL;
process.env.MCP_SECRET = "signup-check-maple-mcp-secret";
process.env.MAPLE_SESSION_SECRET = "signup-check-maple-session-secret";
process.env.GOOGLE_CLIENT_ID = "made-up-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "signup-check-secret-not-real";
process.env.ADMIN_USER = "made-up-admin";
process.env.ADMIN_PASS = "made-up-admin-pass";
process.env.MAPLE_SIGNUP_DAILY_MAX = "50";

const BASE = "http://localhost:3000";

async function main() {
  const { NextRequest } = await import("next/server");
  const auth = await import("../../src/lib/maple/auth");
  const family = await import("../../src/lib/maple/family");
  const signup = await import("../../src/lib/maple/family/signup");
  const { handleMapleGoogleCallback } = await import("../../src/lib/maple/google-callback");
  const codes = await import("../../src/lib/maple/family/codes");
  const { migrateSignup } = await import("../../src/lib/maple/family/schema");
  const start = await import("../../src/app/api/maple/signup/start/route");
  const families = await import("../../src/app/api/maple/signup/families/route");

  let ipSeq = 0;
  const freshIp = () => `198.51.100.${++ipSeq}`;

  const form = (fields: Record<string, string>, ip: string, headers: Record<string, string> = {}): NextRequest =>
    new NextRequest(new URL("/api/maple/signup/start", BASE), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-real-ip": ip, ...headers },
      body: new URLSearchParams(fields).toString(),
    });

  const setCookie = (res: Response, name: string) => {
    const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`));
    return raw ? /^[^=]+=([^;]*)/.exec(raw)![1] : null;
  };
  const errorOf = (res: Response) => new URL(res.headers.get("location") ?? "", BASE).searchParams.get("error");

  /** POST /api/maple/signup/start; on the way to Google, the state cookie it set. */
  const begin = async (fields: Record<string, string>, ip = freshIp()) => {
    const res = await start.POST(form({ site: BASE, tz: "America/Denver", ...fields }, ip));
    const cookie = setCookie(res, auth.STATE_COOKIE);
    const state = cookie ? (JSON.parse(decodeURIComponent(cookie)) as { state: string; signup?: string }) : null;
    return { res, cookie, state, error: errorOf(res), ip };
  };

  /** Google's return to /api/maple/auth/callback (its whole handler) for a sign-in begun above, as `email`. */
  const back = async (began: { cookie: string | null; state: { state: string } | null; ip: string }, email: string, name = "Made-Up Person") => {
    const url = new URL("/api/maple/auth/callback", BASE);
    url.searchParams.set("state", began.state?.state ?? "missing");
    url.searchParams.set("code", "made-up-google-code");
    const req = new NextRequest(url, { headers: { cookie: began.cookie ? `${auth.STATE_COOKIE}=${began.cookie}` : "", "x-real-ip": began.ip } });
    const res = await handleMapleGoogleCallback(req, { identify: async () => ({ email, name }) });
    const sealed = setCookie(res, auth.SESSION_COOKIE);
    const session = sealed ? auth.openSession(decodeURIComponent(sealed)) : null;
    const signedIn = session ? await auth.signedInAs(session) : null;
    return { res, error: errorOf(res), location: res.headers.get("location") ?? "", familyId: signedIn?.ctx.familyId ?? null, role: signedIn?.member.role ?? null };
  };

  const signUp = async (email: string, fields: Record<string, string> = {}, ip?: string) => back(await begin({ terms: "yes", ...fields }, ip), email);
  const membership = async (email: string) => (await sql(`SELECT family_id, role FROM maple_members WHERE email = $1 ORDER BY family_id`, [email])).map((r) => `${r.family_id}:${r.role}`);
  const familyCount = async () => Number((await sql(`SELECT count(*)::int AS n FROM maple_families`))[0].n);

  const cookieFor = (id: string, fam: number) => ({ cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.sealSession(id, fam))}` });
  const callFamilies = async (method: "GET" | "POST", as: { id: string; fam: number }, body?: unknown) => {
    const req = new NextRequest(new URL("/api/maple/signup/families", BASE), {
      method,
      headers: { ...cookieFor(as.id, as.fam), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const res = await (method === "GET" ? families.GET(req) : families.POST(req));
    const sealed = setCookie(res, auth.SESSION_COOKIE);
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, session: sealed ? auth.openSession(decodeURIComponent(sealed)) : null };
  };

  // ── production's schema: the switch can't turn sign-up on ──────────

  await freshDb({ shape: "production" });
  await quietly(migrateSignup);
  await seedFamilies();
  process.env.MAPLE_SIGNUP = "open";

  await test("production schema: MAPLE_SIGNUP=open stays off while family_id has a default", async () => {
    eq(family.signupMode(), "open", "the switch");
    eq(await family.effectiveSignupMode(), "off", "in force");
  });

  await test("production schema: /signup's start refuses, sets no state, and its callback makes no family", async () => {
    const before = await familyCount();
    const began = await begin({ terms: "yes" });
    eq([began.res.status, began.error, began.cookie], [303, "off", null], "start");
    const forged = { state: `${signup.SIGNUP_STATE_PREFIX}made-up`, signup: signup.sealIntent({ kind: "create", code: null, tz: "UTC", terms: "1.2" }) };
    const cb = await back({ cookie: encodeURIComponent(JSON.stringify(forged)), state: forged, ip: freshIp() }, "stranger.prod@example.com");
    eq([cb.error, cb.familyId], ["off", null], "callback");
    eq(await familyCount(), before, "families");
    eq(await membership("stranger.prod@example.com"), [], "membership");
  });

  await test("a family-1 sign-in's state never reaches the sign-up handler", async () => {
    const plain = JSON.stringify({ state: `${auth.MAPLE_STATE_PREFIX}made-up`, back: "/maple", site: BASE });
    const req = (cookie: string, state: string) =>
      new NextRequest(new URL(`/api/maple/auth/callback?state=${encodeURIComponent(state)}&code=x`, BASE), { headers: { cookie: `${auth.STATE_COOKIE}=${encodeURIComponent(cookie)}` } });
    eq(signup.isSignupCallback(req(plain, `${auth.MAPLE_STATE_PREFIX}made-up`)), false, "a /maple sign-in");
    const withIntent = JSON.stringify({ state: `${signup.SIGNUP_STATE_PREFIX}x`, back: "/maple", site: BASE, signup: "sealed" });
    eq(signup.isSignupCallback(req(withIntent, `${signup.SIGNUP_STATE_PREFIX}x`)), true, "a /signup sign-in");
  });

  delete process.env.MAPLE_SIGNUP;

  /** A plain /maple Google sign-in through the same callback, as `email`. */
  const plainSignIn = async (email: string) => {
    const state = `${auth.MAPLE_STATE_PREFIX}made-up-${++ipSeq}`;
    const cookie = encodeURIComponent(JSON.stringify({ state, back: "/maple", site: BASE }));
    const url = new URL(`/api/maple/auth/callback?state=${encodeURIComponent(state)}&code=made-up`, BASE);
    const res = await handleMapleGoogleCallback(new NextRequest(url, { headers: { cookie: `${auth.STATE_COOKIE}=${cookie}` } }), { identify: async () => ({ email, name: "Made-Up Person" }) });
    const sealed = setCookie(res, auth.SESSION_COOKIE);
    const session = sealed ? auth.openSession(decodeURIComponent(sealed)) : null;
    const signedIn = session ? await auth.signedInAs(session) : null;
    return { familyId: signedIn?.ctx.familyId ?? null, auth: new URL(res.headers.get("location") ?? "", BASE).searchParams.get("auth") };
  };
  /** The owner's family has finished onboarding (a family still setting up can't add anyone). */
  const addByEmail = async (owner: string, fam: number, email: string) => {
    await sql(`UPDATE maple_families SET status = 'active' WHERE id = $1`, [fam]);
    const members = await import("../../src/app/api/maple/members/route");
    const req = new NextRequest(new URL("/api/maple/members", BASE), {
      method: "POST",
      headers: { ...cookieFor(owner, fam), "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    return (await members.POST(req)).status;
  };

  await finalShape({ begin, back, signUp, membership, familyCount, callFamilies, freshIp, signup, codes, migrateSignup, plainSignIn, addByEmail });
  done("signup.check.ts");
}

type Kit = {
  begin: (fields: Record<string, string>, ip?: string) => Promise<{ res: Response; cookie: string | null; state: { state: string; signup?: string } | null; error: string | null; ip: string }>;
  back: (began: { cookie: string | null; state: { state: string } | null; ip: string }, email: string, name?: string) => Promise<{ res: Response; error: string | null; location: string; familyId: number | null; role: string | null }>;
  signUp: (email: string, fields?: Record<string, string>, ip?: string) => Promise<{ res: Response; error: string | null; location: string; familyId: number | null; role: string | null }>;
  membership: (email: string) => Promise<string[]>;
  familyCount: () => Promise<number>;
  callFamilies: (method: "GET" | "POST", as: { id: string; fam: number }, body?: unknown) => Promise<{ status: number; body: Record<string, unknown>; session: { id: string; fam?: unknown } | null }>;
  freshIp: () => string;
  signup: typeof import("../../src/lib/maple/family/signup");
  codes: typeof import("../../src/lib/maple/family/codes");
  migrateSignup: () => Promise<void>;
  plainSignIn: (email: string) => Promise<{ familyId: number | null; auth: string | null }>;
  addByEmail: (owner: string, fam: number, email: string) => Promise<number>;
};

async function finalShape(k: Kit) {
  const { begin, back, signUp, membership, familyCount, signup } = k;
  const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];
  const familyOne = () => sql(`SELECT email, role, display_name FROM maple_members WHERE family_id = 1 ORDER BY email`);

  await freshDb({ shape: "final" });
  await quietly(k.migrateSignup);
  const s = await seedFamilies();

  await test("final schema: with MAPLE_SIGNUP unset, sign-up is off", async () => {
    delete process.env.MAPLE_SIGNUP;
    const began = await begin({ terms: "yes" });
    eq([began.error, began.cookie], ["off", null]);
  });

  process.env.MAPLE_SIGNUP = "open";

  await test("open: the start needs the terms box and a same-site post", async () => {
    eq((await begin({})).error, "terms", "no terms");
    const cross = await (await import("../../src/app/api/maple/signup/start/route")).POST(
      new (await import("next/server")).NextRequest(new URL("/api/maple/signup/start", BASE), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site", "x-real-ip": k.freshIp() },
        body: "terms=yes",
      })
    );
    eq(new URL(cross.headers.get("location") ?? "", BASE).searchParams.get("error"), "cross", "cross-site");
  });

  await test("open: the start goes to Google with a sign-up state and a sealed intent", async () => {
    const began = await begin({ terms: "yes" });
    const to = new URL(began.res.headers.get("location") ?? "");
    eq([began.res.status, to.hostname, to.searchParams.get("redirect_uri")], [303, "accounts.google.com", `${BASE}/api/maple/auth/callback`]);
    ok(began.state?.state.startsWith(signup.SIGNUP_STATE_PREFIX), "state prefix");
    eq(signup.openIntent(began.state?.signup), { kind: "create", code: null, tz: "America/Denver", terms: LEGAL_VERSION }, "intent");
  });

  let firstFamily = 0;
  await test("open: a new Google account gets a new family in onboarding, as its owner, and family 1 is untouched", async () => {
    const before = await familyOne();
    const cb = await signUp("new.owner@example.com");
    ok(cb.familyId !== null && cb.familyId > s.beta.familyId, `new family id ${cb.familyId}`);
    firstFamily = cb.familyId!;
    eq([cb.role, new URL(cb.location).pathname, new URL(cb.location).searchParams.get("auth")], ["owner", "/maple", "ok"], "signed in");
    eq(await membership("new.owner@example.com"), [`${firstFamily}:owner`], "membership");
    const f = await one(`SELECT status, timezone, created_by, settings->'signup'->>'via' AS via FROM maple_families WHERE id = $1`, [firstFamily]);
    eq([f.status, f.timezone, f.created_by, f.via], ["onboarding", "America/Denver", "new.owner@example.com", "open"], "family row");
    eq(await familyOne(), before, "family 1's members");
    ok(cb.res.headers.getSetCookie().some((c) => c.startsWith(`maple_oauth_state=;`)), "state cookie cleared");
  });

  await test("open: someone already in a family signs in to it instead of making another", async () => {
    const n = await familyCount();
    const cb = await signUp("new.owner@example.com");
    eq([cb.familyId, await familyCount()], [firstFamily, n], "its owner");
    const member = await signUp(s.beta.member);
    eq([member.familyId, member.role, await familyCount(), await membership(s.beta.member)], [2, "member", n, ["2:member"]], "a member of another family");
  });

  await test("open: one family per Google account a day, even after leaving it", async () => {
    await sql(`DELETE FROM maple_members WHERE email = 'new.owner@example.com'`);
    const n = await familyCount();
    eq([(await signUp("new.owner@example.com")).error, await familyCount()], ["account_limit", n]);
  });

  await test("open: three families a day from one connection, then the fourth is refused", async () => {
    const ip = k.freshIp();
    for (const who of ["ip.one", "ip.two", "ip.three"]) ok((await signUp(`${who}@example.com`, {}, ip)).familyId !== null, `${who} made a family`);
    const n = await familyCount();
    eq([(await signUp("ip.four@example.com", {}, ip)).error, await familyCount()], ["ip_limit", n], "fourth");
    ok((await signUp("ip.four@example.com")).familyId !== null, "from another connection");
  });

  await test("open: the day's cap on new families (MAPLE_SIGNUP_DAILY_MAX) holds", async () => {
    const today = Number((await one(`SELECT count(*)::int AS n FROM maple_families WHERE id <> 1 AND created_at > NOW() - INTERVAL '1 day'`)).n);
    process.env.MAPLE_SIGNUP_DAILY_MAX = String(today);
    try {
      eq([(await signUp("over.cap@example.com")).error, await membership("over.cap@example.com")], ["full", []]);
    } finally {
      process.env.MAPLE_SIGNUP_DAILY_MAX = "50";
    }
  });

  await test("open: a forged, expired or mismatched sign-up state makes nothing", async () => {
    const n = await familyCount();
    const began = await begin({ terms: "yes" });
    const swap = (signupValue: unknown) => encodeURIComponent(JSON.stringify({ ...began.state, signup: signupValue }));
    eq((await back({ ...began, cookie: swap("not-sealed") }, "forged@example.com")).error, "bad_state", "forged");
    const stale = signup.sealIntent({ kind: "create", code: null, tz: "UTC", terms: "1.2" }, Date.now() - 11 * 60_000);
    eq((await back({ ...began, cookie: swap(stale) }, "forged@example.com")).error, "bad_state", "expired");
    eq((await back({ ...began, state: { state: `${signup.SIGNUP_STATE_PREFIX}other` } }, "forged@example.com")).error, "bad_state", "state mismatch");
    eq(await familyCount(), n);
  });

  await test("open: an address on MAPLE_ALLOWED_EMAILS joins family 1 as before; any other gets its own family", async () => {
    process.env.MAPLE_ALLOWED_EMAILS = "allowed.one@example.com";
    try {
      eq((await signUp("allowed.one@example.com")).familyId, 1, "allowlisted");
      eq(await membership("allowed.one@example.com"), ["1:member"]);
      const other = await signUp("not.allowed@example.com");
      ok(other.familyId !== null && other.familyId !== 1, "not allowlisted");
    } finally {
      delete process.env.MAPLE_ALLOWED_EMAILS;
    }
  });

  // ── invite codes ─────────────────────────────────────────────────

  process.env.MAPLE_SIGNUP = "invite";

  await test("invite: no code, a malformed one or an unknown one never reaches Google", async () => {
    for (const code of ["", "hello", `MAPLE-${"2".repeat(15)}`]) eq((await begin({ terms: "yes", code })).error, "code", `code "${code}"`);
  });

  await test("invite: a code makes one family, is spent by it, and isn't in the state cookie", async () => {
    const code = await k.codes.createSignupCode({ label: "made-up beta family" });
    const began = await begin({ terms: "yes", code: code.toLowerCase() });
    ok(began.cookie && !decodeURIComponent(began.cookie).includes(code.slice(6, 11)), "code sealed");
    const cb = await back(began, "coded.one@example.com");
    ok(cb.familyId !== null, "family made");
    const row = await one(`SELECT uses, families FROM maple_signup_codes WHERE code_hash = $1`, [k.codes.codeHash(k.codes.normalizeCode(code)!)]);
    eq([row.uses, row.families], [1, [String(cb.familyId)]], "spent");
    eq((await begin({ terms: "yes", code })).error, "code", "a second start");
  });

  // Logic only: PGlite runs one transaction at a time, so this passes without SIGNUP_LOCK too. The lock itself
  // needs a real Postgres (a schema-only Neon branch) to prove.
  await test("invite: two sign-ups on one code make one family (the code's use count, not its lock)", async () => {
    const code = await k.codes.createSignupCode();
    const [a, b] = [await begin({ terms: "yes", code }), await begin({ terms: "yes", code })];
    const results = await Promise.all([back(a, "race.a@example.com"), back(b, "race.b@example.com")]);
    eq(results.map((r) => (r.familyId === null ? r.error : "made")).sort(), ["code", "made"]);
  });

  await test("invite: a revoked or expired code is refused", async () => {
    const revoked = await k.codes.createSignupCode();
    await sql(`UPDATE maple_signup_codes SET revoked_at = NOW() WHERE code_hash = $1`, [k.codes.codeHash(k.codes.normalizeCode(revoked)!)]);
    eq((await begin({ terms: "yes", code: revoked })).error, "code", "revoked");
    const expired = await k.codes.createSignupCode();
    await sql(`UPDATE maple_signup_codes SET expires_at = NOW() - INTERVAL '1 minute' WHERE code_hash = $1`, [k.codes.codeHash(k.codes.normalizeCode(expired)!)]);
    eq((await begin({ terms: "yes", code: expired })).error, "code", "expired");
  });

  // ── joining by invite link, and the switcher ─────────────────────

  await test("join: an invite link adds this Google account to the link's family only, even in invite mode with no code", async () => {
    const cb = await back(await begin({ invite: s.beta.inviteToken }), "joiner@example.com", "Made-Up Joiner");
    eq([cb.familyId, cb.role], [s.beta.familyId, "member"], "signed in to Beta");
    eq(await membership("joiner@example.com"), [`${s.beta.familyId}:member`], "membership");
    const inv = await one(`SELECT used_by FROM maple_invites WHERE id = $1`, [s.beta.inviteId]);
    eq([inv.used_by, (await one(`SELECT display_name FROM maple_members WHERE email = 'joiner@example.com'`)).display_name], ["joiner@example.com", "Grandparent"]);
    eq((await back(await begin({ invite: s.beta.inviteToken }), "second.joiner@example.com")).error, "invite", "a used link");
  });

  const invite = async (fam: number, token: string, extra = "") => {
    await sql(
      `INSERT INTO maple_invites (family_id, token_hash, role, display_name, created_by, expires_at${extra ? ", email" : ""})
       VALUES ($1, $2, 'viewer', 'Made-Up Helper', 'made-up', NOW() + INTERVAL '7 days'${extra ? ", $3" : ""})`,
      extra ? [fam, sha256(token), extra] : [fam, sha256(token)]
    );
  };

  await test("join: someone already in the family signs in to it and the link stays unused", async () => {
    await invite(2, "betaSecondInviteMadeUp0123456789");
    eq((await back(await begin({ invite: "betaSecondInviteMadeUp0123456789" }), s.beta.member)).familyId, 2);
    eq((await one(`SELECT used_at FROM maple_invites WHERE token_hash = $1`, [sha256("betaSecondInviteMadeUp0123456789")])).used_at, null);
  });

  await test("join: a link made for one address, or from a family being deleted, opens for nobody else", async () => {
    await invite(2, "betaEmailInviteMadeUp01234567890", "meant.for@example.com");
    eq((await back(await begin({ invite: "betaEmailInviteMadeUp01234567890" }), "someone.else@example.com")).error, "invite", "another address");
    eq(await membership("someone.else@example.com"), []);
    eq((await back(await begin({ invite: "betaEmailInviteMadeUp01234567890" }), "meant.for@example.com")).familyId, 2, "its address");
    await invite(2, "betaDeletingInviteMadeUp01234567");
    await sql(`UPDATE maple_families SET status = 'deleting' WHERE id = 2`);
    try {
      eq((await back(await begin({ invite: "betaDeletingInviteMadeUp01234567" }), "late.joiner@example.com")).error, "invite", "deleting");
    } finally {
      await sql(`UPDATE maple_families SET status = 'active' WHERE id = 2`);
    }
  });

  await test("join: a link made for no one in particular never lets in an address the family removed; one made for that address does", async () => {
    const removed = "removed.beta@example.com";
    const tombstones = async () => Number((await one(`SELECT COUNT(*)::int AS n FROM maple_removed WHERE family_id = 2 AND email = $1`, [removed])).n);
    await invite(2, "betaOpenInviteForRemoved01234567");
    eq((await back(await begin({ invite: "betaOpenInviteForRemoved01234567" }), removed)).error, "invite", "an open link");
    eq([await membership(removed), await tombstones()], [[], 1], "still out");
    eq((await one(`SELECT used_at FROM maple_invites WHERE token_hash = $1`, [sha256("betaOpenInviteForRemoved01234567")])).used_at, null, "the link stays unused");
    await invite(2, "betaNamedInviteForRemoved0123456", removed);
    eq((await back(await begin({ invite: "betaNamedInviteForRemoved0123456" }), removed)).familyId, 2, "a link made for it");
    eq(await tombstones(), 0, "lifted");
  });

  await test("switcher: shows only for someone in two families, and switches only to theirs", async () => {
    eq((await k.callFamilies("GET", { id: s.beta.owner, fam: 2 })).body, { switcher: false, families: [] }, "one family");
    eq((await back(await begin({ invite: s.alpha.inviteToken }), s.beta.owner)).familyId, 1, "Beta's owner joins Alpha by its link");
    const listed = await k.callFamilies("GET", { id: s.beta.owner, fam: 2 });
    eq(
      (listed.body.families as { familyId: number; label: string; role: string; current: boolean }[]).map((f) => [f.familyId, f.label, f.role, f.current]),
      [
        [1, "Family Alpha", "member", false],
        [2, "Family Beta", "owner", true],
      ]
    );
    const moved = await k.callFamilies("POST", { id: s.beta.owner, fam: 2 }, { familyId: 1 });
    eq([moved.status, moved.session?.fam], [200, 1], "switch to Alpha");
    const notTheirs = await k.callFamilies("POST", { id: s.beta.owner, fam: 2 }, { familyId: firstFamily });
    eq([notTheirs.status, notTheirs.session], [404, null], "a family they're not in");
    await sql(`INSERT INTO maple_members (family_id, email, role) VALUES ($1, $2, 'member')`, [firstFamily, s.beta.owner]);
    eq((await k.callFamilies("GET", { id: s.beta.owner, fam: 2 })).body.families, listed.body.families, "a membership they never took up isn't listed");
    const unaccepted = await k.callFamilies("POST", { id: s.beta.owner, fam: 2 }, { familyId: firstFamily });
    eq([unaccepted.status, unaccepted.session], [404, null], "nor switched to");
    await sql(`DELETE FROM maple_members WHERE family_id = $1 AND email = $2`, [firstFamily, s.beta.owner]);
    await sql(`INSERT INTO maple_members (family_id, email, role, display_name, accepted_at) VALUES (1, 'admin', 'owner', 'Admin', NOW()), (2, 'admin', 'owner', 'Admin', NOW())`);
    try {
      eq((await k.callFamilies("GET", { id: "admin", fam: 1 })).body, { switcher: false, families: [] }, "the admin login's list");
      const admin = await k.callFamilies("POST", { id: "admin", fam: 1 }, { familyId: 2 });
      eq([admin.status, admin.session], [404, null], "the admin login, even with a row planted in family 2");
    } finally {
      await sql(`DELETE FROM maple_members WHERE email = 'admin'`);
    }
  });

  // ── a stranger's family can't take anyone in ─────────────────────

  process.env.MAPLE_SIGNUP = "open";

  await test("squat (a): an address another family's owner added still gets its own family when it signs up", async () => {
    const attacker = await signUp("squat.attacker@example.com");
    ok(attacker.familyId !== null, "the attacker's family");
    eq(await k.addByEmail("squat.attacker@example.com", attacker.familyId!, "victim.new@example.com"), 201, "the add answers with a pending invite");
    eq(await membership("victim.new@example.com"), [], "no membership from the add");
    const victim = await signUp("victim.new@example.com");
    ok(victim.familyId !== null && victim.familyId !== attacker.familyId, `the victim's own family, not ${attacker.familyId}`);
    eq([victim.role, await membership("victim.new@example.com")], ["owner", [`${victim.familyId}:owner`]]);
  });

  await test("squat (b): an owner added by a family with a lower id still signs in to their own", async () => {
    const attacker = await signUp("squat.early@example.com");
    const victim = await signUp("victim.two@example.com");
    ok(attacker.familyId! < victim.familyId!, "the attacker's family is older");
    eq(await k.addByEmail("squat.early@example.com", attacker.familyId!, "victim.two@example.com"), 201);
    eq((await k.plainSignIn("victim.two@example.com")).familyId, victim.familyId, "a plain Google sign-in");
    eq((await signUp("victim.two@example.com")).familyId, victim.familyId, "a second /signup");
    eq((await k.callFamilies("GET", { id: "victim.two@example.com", fam: victim.familyId! })).body, { switcher: false, families: [] }, "nothing in the switcher");
  });

  await test("squat (c): an allowlisted address the attacker added first still joins family 1", async () => {
    process.env.MAPLE_ALLOWED_EMAILS = "allowed.later@example.com";
    try {
      const attacker = await signUp("squat.third@example.com");
      eq(await k.addByEmail("squat.third@example.com", attacker.familyId!, "allowed.later@example.com"), 201);
      eq((await k.plainSignIn("allowed.later@example.com")).familyId, 1);
      eq(await membership("allowed.later@example.com"), ["1:member"]);
    } finally {
      delete process.env.MAPLE_ALLOWED_EMAILS;
    }
  });

  await test("squat: a family still setting up can't invite anyone", async () => {
    const owner = await signUp("still.onboarding@example.com");
    const members = await import("../../src/app/api/maple/members/route");
    const res = await members.POST(
      new (await import("next/server")).NextRequest(new URL("/api/maple/members", BASE), {
        method: "POST",
        headers: {
          cookie: `${(await import("../../src/lib/maple/auth")).SESSION_COOKIE}=${encodeURIComponent((await import("../../src/lib/maple/auth")).sealSession("still.onboarding@example.com", owner.familyId!))}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "someone.new@example.com" }),
      })
    );
    eq(res.status, 403);
  });

  await test("squat: the pending invite's own link, signed in as that address, is the way in", async () => {
    const attacker = await signUp("inviting.owner@example.com");
    await sql(`UPDATE maple_families SET status = 'active' WHERE id = $1`, [attacker.familyId]);
    const members = await import("../../src/app/api/maple/members/route");
    const res = await members.POST(
      new (await import("next/server")).NextRequest(new URL("/api/maple/members", BASE), {
        method: "POST",
        headers: { cookie: `${(await import("../../src/lib/maple/auth")).SESSION_COOKIE}=${encodeURIComponent((await import("../../src/lib/maple/auth")).sealSession("inviting.owner@example.com", attacker.familyId!))}`, "content-type": "application/json" },
        body: JSON.stringify({ email: "invited.friend@example.com" }),
      })
    );
    const token = String(((await res.json()) as { url: string }).url).split("#join=")[1];
    eq((await back(await begin({ invite: token }), "someone.else.again@example.com")).error, "invite", "another address");
    const joined = await back(await begin({ invite: token }), "invited.friend@example.com");
    eq([joined.familyId, joined.role], [attacker.familyId, "member"], "its own address, by Google");
  });

  delete process.env.MAPLE_SIGNUP;

  // ── an empty family 1: the old first-sign-in claim stays closed ─────

  await freshDb({ shape: "final" });
  await quietly(k.migrateSignup);
  process.env.MAPLE_SIGNUP = "open";

  await test("open, on a database with nobody in family 1: a sign-up makes family 2 and never claims family 1", async () => {
    const cb = await signUp("first.stranger@example.com");
    eq([cb.familyId, cb.role], [2, "owner"]);
    eq(await familyOne(), [], "family 1 still empty");
  });

  await test("open, on an empty family 1: a plain Google sign-in can't claim it either", async () => {
    eq(await k.plainSignIn("second.stranger@example.com"), { familyId: null, auth: "not_invited" });
    eq(await familyOne(), [], "family 1 still empty");
  });

  delete process.env.MAPLE_SIGNUP;

  await test("off, on an empty family 1: the first Google sign-in claims it, as it always has", async () => {
    eq((await k.plainSignIn("first.owner@example.com")).familyId, 1);
    eq((await familyOne()).map((r) => [r.email, r.role]), [["first.owner@example.com", "owner"]]);
  });
}


main().catch((error) => {
  console.error(error);
  process.exit(1);
});

