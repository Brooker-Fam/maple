/**
 * Assertions for the apps' Google sign-in (src/lib/maple/native-auth.ts and
 * the start, callback and native routes): the ?native= flag, the maple://auth
 * answers, the two-minute ticket (expiry, tampering, wrong prefix, other
 * sealed values passed off as one) and its binding to the app's verifier. The
 * web flow's state cookie must stay exactly what it was.
 *
 *   npx tsx scripts/maple-native-check.ts      (or pnpm check:maple-native)
 *
 * No database, no network: secrets and people are made up here, nothing
 * reaches Google (only the redirect URL is read), and the one member lookup
 * is answered by a fetch stand-in on a .invalid host. One PASS/FAIL line per
 * case, exit 1 on any failure.
 */
import type { NextRequest } from "next/server";

delete process.env.DATABASE_URL;
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.NEXT_PUBLIC_BASE_URL;
delete process.env.VERCEL_ENV;
delete process.env.VERCEL_URL;
const FAKE_CLIENT_ID = "check-client.apps.example.com";
const FAKE_SECRET = "check-secret-not-real-0123456789";
process.env.GOOGLE_CLIENT_ID = FAKE_CLIENT_ID;
process.env.GOOGLE_CLIENT_SECRET = FAKE_SECRET;

// ── harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function eq(actual: unknown, expected: unknown, what = "value") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}
function ok(cond: unknown, what: string) {
  if (!cond) throw new Error(what);
}

const JO = "jo@example.com";
const MIN = 60_000;
// RFC 7636's own example pair (appendix B), so the hash is checked against a published value.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const OTHER_VERIFIER = "another-made-up-verifier-0123456789abcdefghij";

async function main() {
  const { NextRequest } = await import("next/server");
  const nativeAuth = await import("../src/lib/maple/native-auth");
  const { mintNativeTicket, openNativeTicket, nativeReturnUrl, parseNativeFlag, nativeFromState, NATIVE_TICKET_TTL_MS } = nativeAuth;
  const { nativeChallengeFor, nativeVerifierMatches, parseNativeChallenge } = nativeAuth;
  const { openSession, sealSession, STATE_COOKIE } = await import("../src/lib/maple/auth");
  const { encryptSecret } = await import("../src/lib/secret-box");
  const start = await import("../src/app/api/maple/auth/start/route");
  const nativeRoute = await import("../src/app/api/maple/auth/native/route");
  const { handleMapleGoogleCallback } = await import("../src/lib/maple/google-callback");

  const req = (path: string, cookies: Record<string, string> = {}, headers: Record<string, string> = {}): NextRequest => {
    const r = new NextRequest(new URL(path, "http://localhost:3000"), { headers });
    for (const [k, v] of Object.entries(cookies)) r.cookies.set(k, v);
    return r;
  };
  const location = (res: Response) => res.headers.get("location") ?? "";

  // ── the ?native= flag ──────────────────────────────────────────────────

  await check("parseNativeFlag takes exactly ios and android", () => {
    eq(parseNativeFlag("ios"), "ios");
    eq(parseNativeFlag("android"), "android");
    for (const v of [null, undefined, "", "1", "true", "IOS", "Android", "ios ", " ios", "web", "ios,android"]) eq(parseNativeFlag(v), null, JSON.stringify(v));
  });

  await check("nativeFromState reads only an app's state", () => {
    eq(nativeFromState("maple.native-ios.4d0c6f2e-0000-4000-8000-000000000000"), "ios");
    eq(nativeFromState("maple.native-android.x"), "android");
    for (const v of [null, "", "maple.4d0c6f2e-0000-4000-8000-000000000000", "maple.native-web.x", "x.maple.native-ios.y", "maple.native-ios"]) eq(nativeFromState(v), null, JSON.stringify(v));
  });

  // ── the app's verifier ─────────────────────────────────────────────────

  await check("the challenge is base64url SHA-256 of the verifier", () => {
    eq(nativeChallengeFor(VERIFIER), CHALLENGE);
    eq(parseNativeChallenge(CHALLENGE), CHALLENGE);
    for (const v of [null, undefined, "", CHALLENGE.slice(1), `${CHALLENGE}A`, CHALLENGE.replace("-", "+"), `${CHALLENGE.slice(0, 42)}=`]) eq(parseNativeChallenge(v), null, JSON.stringify(v));
  });

  await check("only the matching verifier passes", () => {
    ok(nativeVerifierMatches(VERIFIER, CHALLENGE), "the right verifier");
    ok(!nativeVerifierMatches(OTHER_VERIFIER, CHALLENGE), "another verifier");
    ok(!nativeVerifierMatches(CHALLENGE, CHALLENGE), "the challenge itself");
    for (const v of [null, undefined, "", "short", "x".repeat(129), `${VERIFIER} `, `${VERIFIER}+`]) ok(!nativeVerifierMatches(v, CHALLENGE), JSON.stringify(v));
  });

  // ── the ticket ─────────────────────────────────────────────────────────

  const now = Date.parse("2026-10-26T14:00:00Z");
  const ticket = mintNativeTicket(JO, "/maple", CHALLENGE, now);
  const opened = { id: JO, back: "/maple", challenge: CHALLENGE };

  await check("a ticket opens to its member, return path and challenge", () => {
    eq(openNativeTicket(ticket, now), opened);
    eq(openNativeTicket(mintNativeTicket(JO, "/maple?care=1", CHALLENGE, now), now), { ...opened, back: "/maple?care=1" });
    ok(/^mnt1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket), `URL-safe shape: ${ticket}`);
    ok(ticket.split(".").slice(1).every((p) => !Buffer.from(p, "base64url").toString("latin1").includes(JO)), "the email isn't readable in the ticket");
    ok(mintNativeTicket(JO, "/maple", CHALLENGE, now) !== ticket, "two tickets for the same sign-in differ");
  });

  await check("a ticket lasts two minutes", () => {
    eq(NATIVE_TICKET_TTL_MS, 2 * MIN);
    eq(openNativeTicket(ticket, now + 2 * MIN), opened, "at exactly two minutes");
    eq(openNativeTicket(ticket, now + 2 * MIN + 1), null, "a millisecond past");
    eq(openNativeTicket(ticket, now + 60 * MIN), null, "an hour later");
  });

  await check("a tampered ticket is refused", () => {
    const parts = ticket.split(".");
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      const flipped = (p[0] === "A" ? "B" : "A") + p.slice(1);
      eq(openNativeTicket([...parts.slice(0, i), flipped, ...parts.slice(i + 1)].join("."), now), null, `part ${i} changed`);
    }
    eq(openNativeTicket(ticket.slice(0, -2), now), null, "cut short");
    eq(openNativeTicket(`${ticket}.extra`, now), null, "a fifth part");
    eq(openNativeTicket(ticket.replace(/\./g, ":"), now), null, "colons");
    eq(openNativeTicket(`${ticket}%3D`, now), null, "stray characters");
  });

  await check("a wrong prefix is refused", () => {
    const rest = ticket.slice(ticket.indexOf("."));
    for (const p of ["mnt0", "mnt2", "MNT1", "mcpcode", "mcpat", ""]) eq(openNativeTicket(`${p}${rest}`, now), null, p || "(none)");
    eq(openNativeTicket(rest.slice(1), now), null, "no prefix at all");
  });

  await check("other sealed values can't pass for a ticket", () => {
    const wrap = (sealed: string) => ["mnt1", ...sealed.split(":").map((p) => Buffer.from(p, "base64").toString("base64url"))].join(".");
    eq(openNativeTicket(wrap(sealSession(JO)), now), null, "a session cookie");
    const k = "maple-native-ticket";
    eq(openNativeTicket(wrap(encryptSecret(JSON.stringify({ id: JO, back: "/maple", c: CHALLENGE, exp: now + MIN }))), now), null, "no kind");
    eq(openNativeTicket(wrap(encryptSecret(JSON.stringify({ k, id: "", back: "/maple", c: CHALLENGE, exp: now + MIN }))), now), null, "no member");
    eq(openNativeTicket(wrap(encryptSecret(JSON.stringify({ k, id: JO, back: "/maple", c: CHALLENGE }))), now), null, "no expiry");
    eq(openNativeTicket(wrap(encryptSecret(JSON.stringify({ k, id: JO, back: "/maple", exp: now + MIN }))), now), null, "no challenge");
    eq(openNativeTicket(wrap(encryptSecret(JSON.stringify({ k, id: JO, back: "/maple", c: "short", exp: now + MIN }))), now), null, "a malformed challenge");
  });

  await check("a ticket sealed with another key is refused", () => {
    process.env.GOOGLE_CLIENT_SECRET = "a-different-made-up-secret";
    try {
      eq(openNativeTicket(ticket, now), null);
    } finally {
      process.env.GOOGLE_CLIENT_SECRET = FAKE_SECRET;
    }
    eq(openNativeTicket(ticket, now), opened, "back on the right key");
  });

  await check("a ticket's return path still follows safeReturnPath", () => {
    for (const bad of ["//evil.example", "https://evil.example/maple", "/maple\\..", "/admin"]) eq(openNativeTicket(mintNativeTicket(JO, bad, CHALLENGE, now), now)?.back, "/maple", bad);
    eq(openNativeTicket(mintNativeTicket(JO, "/oauth/authorize?client_id=x", CHALLENGE, now), now)?.back, "/oauth/authorize?client_id=x");
  });

  await check("garbage is refused without throwing", () => {
    for (const v of [null, undefined, "", ".", "mnt1", "mnt1...", "mnt1.a.b.c", "x".repeat(5000)]) eq(openNativeTicket(v, now), null, String(v).slice(0, 20));
  });

  await check("maple://auth answers", () => {
    eq(nativeReturnUrl({ ticket }), `maple://auth?ticket=${ticket}`);
    eq(nativeReturnUrl({ error: "not_invited" }), "maple://auth?error=not_invited");
  });

  // ── /api/maple/auth/start ──────────────────────────────────────────────

  const startWith = async (qs: string) => {
    const res = await start.GET(req(`/api/maple/auth/start${qs}`));
    const raw = res.cookies.get(STATE_COOKIE)?.value ?? "";
    const google = new URL(location(res));
    return { res, raw, cookie: JSON.parse(raw || "{}") as Record<string, unknown>, google };
  };
  const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

  await check("start without native: the state cookie is exactly { state, back }", async () => {
    for (const qs of ["?return=%2Fmaple%3Fcare%3D1", "?return=%2Fmaple%3Fcare%3D1&native=", "?return=%2Fmaple%3Fcare%3D1&native=desktop", "?return=%2Fmaple%3Fcare%3D1&native=IOS"]) {
      const { raw, cookie, google } = await startWith(qs);
      const state = String(cookie.state);
      ok(new RegExp(`^maple\\.${UUID}$`).test(state), `${qs}: web state ${state}`);
      eq(raw, JSON.stringify({ state, back: "/maple?care=1" }), `${qs}: cookie`);
      eq(google.origin + google.pathname, "https://accounts.google.com/o/oauth2/v2/auth", `${qs}: Google`);
      eq(google.searchParams.get("state"), state, `${qs}: state sent to Google`);
      eq(google.searchParams.get("redirect_uri"), "http://localhost:3000/api/maple/auth/callback", `${qs}: redirect_uri`);
    }
  });

  await check("start with native=ios / android: native and the challenge ride in the cookie", async () => {
    for (const native of ["ios", "android"]) {
      const { res, raw, cookie, google } = await startWith(`?native=${native}&challenge=${CHALLENGE}&return=%2Fmaple`);
      const state = String(cookie.state);
      ok(new RegExp(`^maple\\.native-${native}\\.${UUID}$`).test(state), `${native}: state ${state}`);
      eq(raw, JSON.stringify({ state, back: "/maple", native, challenge: CHALLENGE }), `${native}: cookie`);
      ok(!google.search.includes(CHALLENGE), `${native}: the challenge stays off Google's URL`);
      eq(google.searchParams.get("state"), state, `${native}: state sent to Google`);
      eq(google.searchParams.get("redirect_uri"), "http://localhost:3000/api/maple/auth/callback", `${native}: same redirect_uri as the web`);
      const set = res.headers.get("set-cookie") ?? "";
      ok(/Path=\/api\/maple\/auth\/callback/i.test(set) && /HttpOnly/i.test(set) && /Max-Age=600/i.test(set), `${native}: cookie attributes ${set}`);
    }
  });

  await check("start with native but no usable challenge goes back to the app without reaching Google", async () => {
    for (const qs of ["?native=ios", "?native=android&challenge=", `?native=ios&challenge=${CHALLENGE.slice(1)}`, `?native=ios&challenge=${encodeURIComponent(`${CHALLENGE}=`)}`]) {
      const res = await start.GET(req(`/api/maple/auth/start${qs}`));
      eq(location(res), "maple://auth?error=failed", qs);
      ok(!res.cookies.get(STATE_COOKIE)?.value, `${qs}: no state cookie`);
    }
  });

  await check("start with native: return still follows safeReturnPath", async () => {
    eq((await startWith(`?native=android&challenge=${CHALLENGE}&return=%2F%2Fevil.example`)).cookie.back, "/maple");
    eq((await startWith(`?native=ios&challenge=${CHALLENGE}`)).cookie.back, "/maple");
    eq((await startWith(`?native=ios&challenge=${CHALLENGE}&return=%2Fmaple%2Fconnect`)).cookie.back, "/maple/connect");
  });

  await check("start with Google not set up: the web page, or maple://auth?error=", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      eq(location(await start.GET(req("/api/maple/auth/start?return=%2Fmaple"))), "http://localhost:3000/maple?auth=not_configured");
      eq(location(await start.GET(req("/api/maple/auth/start?native=ios"))), "maple://auth?error=not_configured");
    } finally {
      process.env.GOOGLE_CLIENT_ID = FAKE_CLIENT_ID;
    }
  });

  // ── /api/maple/auth/callback (the paths that never reach Google) ───────

  const callback = (qs: string, cookie?: Record<string, string>) =>
    handleMapleGoogleCallback(req(`/api/maple/auth/callback${qs}`, cookie ? { [STATE_COOKIE]: JSON.stringify(cookie) } : {}));
  const S = "maple.native-ios.4d0c6f2e-0000-4000-8000-000000000000";
  const W = "maple.4d0c6f2e-0000-4000-8000-000000000001";

  await check("callback errors go back to the app on maple://auth", async () => {
    const app = { state: S, back: "/maple", native: "ios" };
    eq(location(await callback(`?error=access_denied&state=${S}`, app)), "maple://auth?error=denied");
    eq(location(await callback(`?state=maple.native-ios.other&code=x`, app)), "maple://auth?error=bad_state");
    eq(location(await callback(`?state=${S}`, app)), "maple://auth?error=no_code");
    const res = await callback(`?error=access_denied&state=${S}`, app);
    ok(/maple_oauth_state=;/.test(res.headers.get("set-cookie") ?? ""), "the state cookie is cleared");
    ok(!/maple_session=[^;]/.test(res.headers.get("set-cookie") ?? ""), "no session");
  });

  await check("callback with the state cookie lost: an app's state still lands in the app", async () => {
    eq(location(await callback("?state=maple.native-android.x&code=y")), "maple://auth?error=bad_state");
    eq(location(await callback("?error=access_denied&state=maple.native-ios.x")), "maple://auth?error=denied");
  });

  await check("callback errors on the web are unchanged", async () => {
    eq(location(await callback(`?error=access_denied&state=${W}`, { state: W, back: "/maple" })), "http://localhost:3000/maple?auth=denied");
    eq(location(await callback(`?state=${W}&code=x`, { state: "maple.other", back: "/maple?care=1" })), "http://localhost:3000/maple?care=1&auth=bad_state");
    eq(location(await callback("?state=maple.abc&code=y")), "http://localhost:3000/maple?auth=bad_state");
    // The web cookie decides, whatever the state param claims.
    eq(location(await callback(`?state=${S}&code=x`, { state: W, back: "/maple" })), "http://localhost:3000/maple?auth=bad_state");
  });

  // ── /api/maple/auth/native ─────────────────────────────────────────────

  const trade = (t: string | null, verifier: string | null = VERIFIER, cookies: Record<string, string> = {}) =>
    nativeRoute.GET(req(`/api/maple/auth/native${t === null ? "" : `?ticket=${encodeURIComponent(t)}`}`, cookies, verifier === null ? {} : { "X-Maple-Verifier": verifier }));
  const sessionSet = (res: Response) => /maple_session=[^;]/.test(res.headers.get("set-cookie") ?? "");

  await check("native: a bad, tampered or expired ticket lands on /maple?auth=failed with no session", async () => {
    const fresh = mintNativeTicket(JO, "/maple", CHALLENGE);
    const parts = fresh.split(".");
    for (const [what, t] of [
      ["missing", null],
      ["empty", ""],
      ["tampered", [...parts.slice(0, 3), (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1)].join(".")],
      ["expired", mintNativeTicket(JO, "/maple", CHALLENGE, Date.now() - 3 * MIN)],
      ["wrong prefix", `mcpcode${fresh.slice(4)}`],
    ] as const) {
      const res = await trade(t);
      eq([res.status, location(res)], [307, "http://localhost:3000/maple?auth=failed"], what);
      ok(!sessionSet(res), `${what}: no session`);
      eq(res.headers.get("cache-control"), "no-store", `${what}: no-store`);
    }
  });

  await check("native: a good ticket with Maple's log unreachable signs no one in", async () => {
    const res = await trade(mintNativeTicket(JO, "/maple", CHALLENGE));
    eq(location(res), "http://localhost:3000/maple?auth=failed");
    ok(!sessionSet(res), "no session");
  });

  // A stand-in for Neon's HTTP endpoint (on .invalid, which never resolves): Jo is the one member.
  const realFetch = globalThis.fetch;
  process.env.DATABASE_URL = "postgresql://check:check@check.invalid/check";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url instanceof Request ? url.url : url);
    if (!/^https:\/\/[a-z.]+\.invalid\/sql$/.test(href)) throw new Error(`unexpected fetch ${href}`);
    const { query, params } = JSON.parse(String(init?.body)) as { query: string; params: unknown[] };
    const member = /FROM maple_members WHERE email = \$1/.test(query) && params[0] === JO;
    const fields = ["email", "role", "display_name", "emoji", "color"].map((name) => ({ name, dataTypeID: 25 }));
    const rows = member ? [[JO, "member", "Jo", null, null]] : [];
    return new Response(JSON.stringify({ command: "SELECT", rowCount: rows.length, rows, fields, rowAsArray: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await check("native: a good ticket sets the usual session cookies and lands on its return path", async () => {
      const res = await trade(mintNativeTicket(JO, "/maple", CHALLENGE));
      eq([res.status, location(res)], [307, "http://localhost:3000/maple"]);
      const set = res.headers.getSetCookie();
      const paths = set.filter((c) => /^maple_session=[^;]/.test(c)).map((c) => /Path=([^;]+)/.exec(c)?.[1]);
      eq(paths, ["/api/maple", "/oauth/authorize"], "session paths");
      const value = decodeURIComponent(/^maple_session=([^;]+)/.exec(set[0])?.[1] ?? "");
      eq(openSession(value), JO, "the session opens to Jo");
      ok(set.some((c) => /^maple_session=;/.test(c) && /Path=\/;/.test(c)), "an old cookie at / is expired");
      eq(location(await trade(mintNativeTicket(JO, "/maple?care=1", CHALLENGE))), "http://localhost:3000/maple?care=1", "return path");
    });

    await check("native: a good ticket without the app's verifier signs no one in (a link from another site)", async () => {
      const t = mintNativeTicket(JO, "/maple", CHALLENGE);
      const victim = { maple_session: sealSession("victim@example.com") };
      for (const [what, verifier] of [
        ["no header", null],
        ["an empty header", ""],
        ["another app's verifier", OTHER_VERIFIER],
        ["the challenge as the verifier", CHALLENGE],
      ] as const) {
        const res = await trade(t, verifier, victim);
        eq(location(res), "http://localhost:3000/maple?auth=failed", what);
        ok(!sessionSet(res), `${what}: no session`);
      }
    });

    await check("native: a ticket for someone no longer a member signs no one in", async () => {
      const res = await trade(mintNativeTicket("gone@example.com", "/maple", CHALLENGE));
      eq(location(res), "http://localhost:3000/maple?auth=failed");
      ok(!sessionSet(res), "no session");
    });
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.DATABASE_URL;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
