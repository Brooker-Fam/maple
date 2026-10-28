import { deepStrictEqual as eq } from "node:assert";
import { NextRequest, NextResponse } from "next/server";
import { GET } from "../../src/app/api/maple/admin/metrics/route";
import { clearMetricsAccess, grantMetricsAccess, isMetricsAdmin, isMetricsAdminSession, METRICS_ACCESS_COOKIE, METRICS_ACCESS_TTL_MS } from "../../src/lib/maple/admin/auth";
import { readAdminMetrics } from "../../src/lib/maple/admin/metrics";
import { SESSION_COOKIE, sealSession } from "../../src/lib/maple/auth";
import { StoreUnavailable } from "../../src/lib/maple/store";
import { encryptSecret, openSecret } from "../../src/lib/secret-box";
import { done, freshDb, ok, seedFamilies, sql, test, type Shape } from "./harness";

process.env.MAPLE_SESSION_SECRET = "synthetic-admin-metrics-session-secret";
process.env.MCP_SECRET = "synthetic-admin-metrics-mcp-secret";
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;

const NOW = new Date("2026-10-28T12:00:00.000Z");
const URL = "http://localhost:3000/api/maple/admin/metrics";

function request(member?: string, familyId = 1, extraHeaders: Record<string, string> = {}, proofCookie?: string) {
  return new NextRequest(URL, {
    headers: {
      ...(member ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealSession(member, familyId))}${proofCookie ? `; ${proofCookie}` : ""}` } : {}),
      ...extraHeaders,
    },
  });
}

async function aggregates(shape: Shape) {
  await freshDb({ shape });
  await test(`${shape}: no external families produces zero totals and a complete zero-filled UTC chart`, async () => {
    const result = await readAdminMetrics(NOW);
    eq(result.families, { total: 0, signedUp7d: 0, signedUp30d: 0, onboarding: 0, setupComplete: 0, deleting: 0 });
    eq(result.people, { total: 0 });
    eq(result.activity, { families7d: 0, families30d: 0, entries30d: 0 });
    eq(result.waitlist, { total: 0 });
    eq(result.generatedAt, NOW.toISOString());
    eq(result.dailySignups.length, 30);
    eq(result.dailySignups[0], { date: "2026-09-29", count: 0 });
    eq(result.dailySignups[29], { date: "2026-10-28", count: 0 });
    eq(result.dailySignups.reduce((sum, day) => sum + day.count, 0), 0);
  });

  const { alpha, beta } = await seedFamilies();
  await sql(`UPDATE maple_families SET created_at = '2026-10-28T06:30:00Z' WHERE id = 2`);
  await sql(`INSERT INTO maple_families (id, timezone, status, created_at) VALUES
    (3, 'America/New_York', 'onboarding', '2026-10-19T12:00:00Z'),
    (4, 'UTC', 'deleting', '2026-09-20T12:00:00Z'),
    (5, 'UTC', 'active', '2026-10-21T12:00:00Z')`);
  await sql(`UPDATE maple_members SET last_seen_at = '2026-10-27T12:00:00Z' WHERE family_id = 1`);
  await sql(`UPDATE maple_members SET last_seen_at = '2026-10-20T12:00:00Z' WHERE email = $1`, [beta.owner]);
  await sql(`UPDATE maple_members SET accepted_at = NULL, last_seen_at = '2026-10-28T11:00:00Z' WHERE email = $1`, [beta.viewer]);
  await sql(`INSERT INTO maple_members (family_id, email, role, accepted_at, last_seen_at) VALUES
    (3, 'invite:100', 'viewer', '2026-10-19T12:00:00Z', '2026-10-27T12:00:00Z'),
    (3, 'pending@example.test', 'member', NULL, '2026-10-28T11:00:00Z'),
    (4, 'old@example.test', 'owner', '2026-09-20T12:00:00Z', '2026-09-21T12:00:00Z'),
    (5, 'admin', 'owner', '2026-10-21T12:00:00Z', '2026-10-28T11:00:00Z')`);
  await sql(`UPDATE maple_entries SET created_at = '2026-10-27T12:00:00Z'`);
  await sql(`UPDATE maple_entries SET deleted_at = '2026-10-28T11:00:00Z' WHERE id = $1`, [beta.entries.diaper]);
  await sql(`UPDATE maple_entries SET created_at = '2026-09-28T12:00:00Z' WHERE id = $1`, [beta.entries.feed]);
  await sql(`INSERT INTO maple_waitlist (email) VALUES ('waiting-one@example.test'), ('waiting-two@example.test')`);

  await test(`${shape}: signup, accepted people and recent activity have separate definitions`, async () => {
    const result = await readAdminMetrics(NOW);
    eq(result.families, { total: 4, signedUp7d: 1, signedUp30d: 3, onboarding: 1, setupComplete: 2, deleting: 1 });
    eq(result.people, { total: 3 });
    eq(result.activity, { families7d: 1, families30d: 2, entries30d: 1 });
    eq(result.waitlist, { total: 2 });
    eq(result.dailySignups.filter((day) => day.count), [
      { date: "2026-10-19", count: 1 },
      { date: "2026-10-21", count: 1 },
      { date: "2026-10-28", count: 1 },
    ]);
    const body = JSON.stringify(result);
    for (const privateValue of [alpha.owner, beta.owner, "waiting-one@example.test", "Juniper", "Rowan", "diaper", "Ibuprofen"]) {
      ok(!body.includes(privateValue), "aggregate result contains no identity or log details");
    }
  });

  if (shape === "final") {
    await test("final: one accepted account in two families is one person", async () => {
      await sql(`INSERT INTO maple_members (family_id, email, role, accepted_at) VALUES (3, $1, 'member', '2026-10-27T12:00:00Z')`, [beta.owner]);
      eq((await readAdminMetrics(NOW)).people, { total: 3 });
    });
  }

  await test(`${shape}: removal of a family removes it from current-record totals`, async () => {
    await sql(`DELETE FROM maple_members WHERE family_id = 4`);
    await sql(`DELETE FROM maple_families WHERE id = 4`);
    const result = await readAdminMetrics(NOW);
    eq(result.families.total, 3);
    eq(result.families.deleting, 0);
    eq(result.people.total, 2);
  });
}

async function authorization(shape: Shape) {
  await freshDb({ shape });
  const { alpha, beta } = await seedFamilies();
  await sql(`INSERT INTO maple_members (family_id, email, role, accepted_at) VALUES (1, 'admin', 'owner', NOW())`);
  // If an unauthorized request reaches the aggregate read it would now fail.
  await sql(`DROP TABLE maple_waitlist`);
  await test(`${shape}: no session, a tampered cookie and a foreign family do not authorize`, async () => {
    eq((await GET(request())).status, 401);
    eq((await GET(request(undefined, 1, { cookie: `${SESSION_COOKIE}=tampered` }))).status, 401);
    eq((await GET(request(alpha.owner, 2))).status, 401);
  });
  await test(`${shape}: owner, member, viewer and shared admin have no metrics access`, async () => {
    for (const [member, family] of [[alpha.owner, 1], [beta.owner, 2], [beta.member, 2], [beta.viewer, 2], ["admin", 1]] as const) {
      const response = await GET(request(member, family, { "x-admin-email": "operator@example.test" }));
      eq(response.status, 403);
      eq(response.headers.get("cache-control"), "no-store");
      eq(await response.json(), { error: "Not allowed" });
    }
  });
  await test(`${shape}: pending and removed memberships cannot use a previously signed cookie`, async () => {
    await sql(`UPDATE maple_members SET accepted_at = NULL WHERE email = $1`, [beta.viewer]);
    eq((await GET(request(beta.viewer, 2))).status, 401);
    await sql(`DELETE FROM maple_members WHERE email = $1`, [beta.owner]);
    eq((await GET(request(beta.owner, 2))).status, 401);
  });
}

async function operatorIntegration() {
  // An operator can supply the actual account only in their local process,
  // keeping personal addresses out of the public test fixtures. This does not
  // override production authorization: it must match the fixed allowlist.
  const operator = process.env.MAPLE_METRICS_TEST_ACCOUNT;
  if (!operator) return;
  await freshDb({ shape: "final" });
  const { beta } = await seedFamilies();
  let proofCookie = "";
  let proofBody: Record<string, unknown> = {};
  await test("configured operator: normalized identity is permitted and an authenticated request returns only aggregates", async () => {
    ok(isMetricsAdmin(operator), "provided local operator matches fixed allowlist");
    ok(isMetricsAdmin(` ${operator.toUpperCase()} `), "email normalization");
    await sql(`INSERT INTO maple_members (family_id, email, role, accepted_at) VALUES (1, $1, 'owner', NOW())`, [operator]);
    const withoutProof = await GET(request(operator));
    eq(withoutProof.status, 403);
    eq((await withoutProof.json()).code, "metrics_reauth");
    const signIn = NextResponse.json({ ok: true });
    grantMetricsAccess(signIn, operator, operator);
    const header = signIn.headers.get("set-cookie")!;
    ok(header.includes("Path=/api/maple") && header.includes("HttpOnly") && header.includes("SameSite=Strict") && header.includes("Max-Age=43200"), "proof cookie has restricted attributes");
    proofCookie = header.split(";")[0];
    proofBody = JSON.parse(openSecret(decodeURIComponent(proofCookie.slice(proofCookie.indexOf("=") + 1))).text);
    const response = await GET(request(operator, 1, {}, proofCookie));
    eq(response.status, 200);
    eq(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    eq(Object.keys(body).sort(), ["activity", "dailySignups", "families", "generatedAt", "people", "waitlist"]);
    ok(!JSON.stringify(body).includes(operator), "operator identity is not returned");
  });
  await test("configured operator: expired, future, wrong-purpose, tampered and previous-key proofs are refused", async () => {
    const now = Date.now();
    const seal = (body: Record<string, unknown>) => `${METRICS_ACCESS_COOKIE}=${encodeURIComponent(encryptSecret(JSON.stringify(body)))}`;
    const invalid = [
      `${METRICS_ACCESS_COOKIE}=tampered`,
      seal({ ...proofBody, issuedAt: now - METRICS_ACCESS_TTL_MS - 1, expiresAt: now - 1 }),
      seal({ ...proofBody, issuedAt: now + 60_000, expiresAt: now + 60_000 + METRICS_ACCESS_TTL_MS }),
      seal({ ...proofBody, expiresAt: now + METRICS_ACCESS_TTL_MS * 2 }),
      seal({ ...proofBody, kind: "maple-session" }),
      seal({ ...proofBody, member: "other-account" }),
    ];
    const current = process.env.MAPLE_SESSION_SECRET!;
    const previous = "synthetic-old-shared-session-secret";
    try {
      process.env.MAPLE_SESSION_SECRET = previous;
      invalid.push(seal(proofBody));
    } finally {
      process.env.MAPLE_SESSION_SECRET = current;
    }
    process.env.MAPLE_SESSION_SECRET_PREV = previous;
    try {
      for (const cookie of invalid) {
        const req = request(operator, 1, {}, cookie);
        eq(isMetricsAdminSession(req, operator), false);
        eq((await GET(req)).status, 403);
      }
    } finally {
      delete process.env.MAPLE_SESSION_SECRET_PREV;
    }
  });
  await test("configured operator: linked aliases cannot mint a proof and another account cannot use it", async () => {
    for (const [verified, canonical] of [["alias@example.test", operator], [operator, "alias@example.test"]]) {
      const response = NextResponse.json({ ok: true });
      grantMetricsAccess(response, verified, canonical);
      ok(response.headers.get("set-cookie")?.includes("Max-Age=0"), "alias mismatch clears proof");
    }
    eq((await GET(request(beta.owner, 2, {}, proofCookie))).status, 403);
    // Re-sealing a primary session (a family switch or ticket exchange) still
    // cannot confer metrics access without a fresh provider-verified proof.
    eq((await GET(request(operator))).status, 403);
    const signedOut = NextResponse.json({ ok: true });
    clearMetricsAccess(signedOut);
    ok(signedOut.headers.get("set-cookie")?.includes("Max-Age=0"), "signout expires proof");
  });
  await test("configured operator: metrics require a Maple-only session key", async () => {
    const current = process.env.MAPLE_SESSION_SECRET!;
    const requestWithCurrentKey = request(operator, 1, {}, proofCookie);
    try {
      delete process.env.MAPLE_SESSION_SECRET;
      eq(isMetricsAdminSession(requestWithCurrentKey, operator), false);
      process.env.MAPLE_SESSION_SECRET = current;
      process.env.GOOGLE_CLIENT_SECRET = current;
      eq(isMetricsAdminSession(requestWithCurrentKey, operator), false);
    } finally {
      process.env.MAPLE_SESSION_SECRET = current;
      delete process.env.GOOGLE_CLIENT_SECRET;
    }
  });
  await test("configured operator: stale family header and removed membership are refused", async () => {
    eq((await GET(request(operator, 1, { "x-maple-family": "2" }, proofCookie))).status, 409);
    await sql(`DELETE FROM maple_members WHERE email = $1`, [operator]);
    eq((await GET(request(operator, 1, {}, proofCookie))).status, 401);
  });
}

async function main() {
  await test("ordinary identities and the shared admin pseudo-account are not operators", () => {
    for (const id of ["", "admin", "invite:1", "owner@example.test", "operator@example.test"]) eq(isMetricsAdmin(id), false);
  });
  for (const shape of ["production", "final"] as const) {
    await aggregates(shape);
    await authorization(shape);
  }
  await operatorIntegration();
  await test("an unavailable database is an error rather than a zero-signup report", async () => {
    process.env.DATABASE_URL = "";
    let unavailable = false;
    try {
      await readAdminMetrics(NOW);
    } catch (error) {
      unavailable = error instanceof StoreUnavailable;
    }
    ok(unavailable, "read failed closed");
  });
  done("admin.check.ts");
}

void main().catch((error) => { console.error(error); process.exit(1); });
