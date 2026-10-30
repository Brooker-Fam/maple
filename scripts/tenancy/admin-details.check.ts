import { deepStrictEqual as eq } from "node:assert";
import { NextRequest, NextResponse } from "next/server";
import { GET as detailsGet } from "../../src/app/api/maple/admin/details/route";
import { POST as revealPost } from "../../src/app/api/maple/admin/reveal/route";
import { parseAdminDetailsOptions, readAdminDetails, revealAdminEmail } from "../../src/lib/maple/admin/details";
import { grantMetricsAccess } from "../../src/lib/maple/admin/auth";
import { ADMIN_REF_TTL_MS, maskAdminEmail, openAdminRef, sealAdminRef } from "../../src/lib/maple/admin/refs";
import { SESSION_COOKIE, sealSession } from "../../src/lib/maple/auth";
import { BadRequest } from "../../src/lib/maple/api";
import { NotFound, StoreUnavailable } from "../../src/lib/maple/store";
import { encryptSecret } from "../../src/lib/secret-box";
import { done, freshDb, ok, seedFamilies, sql, test, type Shape } from "./harness";

process.env.MAPLE_SESSION_SECRET = "synthetic-admin-details-session-key";
process.env.MCP_SECRET = "synthetic-admin-details-mcp-key";
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
const NOW = new Date("2026-10-28T12:00:00.000Z");
const BASE = "http://localhost:3000/api/maple/admin";

function request(path: string, member?: string, familyId = 1, body?: unknown, proof = "", headers: Record<string, string> = {}) {
  return new NextRequest(`${BASE}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(member ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealSession(member, familyId))}${proof ? `; ${proof}` : ""}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json", origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function references() {
  await test("list masks hide domain, address length and all but one local character", () => {
    eq(maskAdminEmail("Alex.Long@private-company.example"), "a•••@•••");
    eq(maskAdminEmail("invalid"), "•••@•••");
  });
  await test("contact refs are encrypted, purpose-bound, expire and reject previous keys", () => {
    const ref = { kind: "person" as const, email: "alex@example.test" };
    const token = sealAdminRef(ref, 1_000_000);
    ok(!token.includes(ref.email), "ref does not contain raw address");
    eq(openAdminRef(token, 1_000_001), ref);
    eq(openAdminRef(token, 999_999), null);
    eq(openAdminRef(token, 1_000_000 + ADMIN_REF_TTL_MS), null);
    eq(openAdminRef("tampered"), null);
    eq(openAdminRef(encryptSecret(JSON.stringify({ purpose: "other", issuedAt: Date.now(), expiresAt: Date.now() + ADMIN_REF_TTL_MS, ref }))), null);
    const current = process.env.MAPLE_SESSION_SECRET!;
    try {
      process.env.MAPLE_SESSION_SECRET = "synthetic-old-details-key";
      const previous = sealAdminRef(ref);
      process.env.MAPLE_SESSION_SECRET = current;
      process.env.MAPLE_SESSION_SECRET_PREV = "synthetic-old-details-key";
      eq(openAdminRef(previous), null);
    } finally {
      process.env.MAPLE_SESSION_SECRET = current;
      delete process.env.MAPLE_SESSION_SECRET_PREV;
    }
  });
  await test("invalid list filters and unbounded or injected pagination are rejected", () => {
    eq(parseAdminDetailsOptions(new URLSearchParams("view=feedback")), { view: "feedback", filter: "all", page: 1 });
    eq(parseAdminDetailsOptions(new URLSearchParams("filter=chat30d")), { view: "families", filter: "chat30d", page: 1 });
    for (const input of ["view=other", "view=people&filter=7d", "view=feedback&filter=logged7d", "view=waitlist&filter=onboarding", "page=0", "page=-1", "page=1.5", "page=100000000", "filter=all%27%3BDROP"]) {
      let rejected = false;
      try { parseAdminDetailsOptions(new URLSearchParams(input)); } catch (error) { rejected = error instanceof BadRequest; }
      ok(rejected, "invalid options rejected");
    }
  });
}

async function data(shape: Shape) {
  await freshDb({ shape });
  const { alpha, beta } = await seedFamilies();
  await sql(`UPDATE maple_families SET created_at = '2026-10-28T06:00:00Z' WHERE id = 2`);
  await sql(`UPDATE maple_members SET accepted_at = '2026-10-27T12:00:00Z', last_seen_at = '2026-10-28T11:00:00Z' WHERE family_id = 2`);
  await sql(`UPDATE maple_members SET accepted_at = NULL WHERE email = $1`, [beta.viewer]);
  await sql(`INSERT INTO maple_members (family_id, email, role, accepted_at) VALUES (2, 'invite:700', 'viewer', NOW()), (2, 'admin', 'owner', NOW())`);
  const [wait] = await sql(`INSERT INTO maple_waitlist (email, created_at) VALUES ('wait.person@example.test', '2026-10-28T10:00:00Z') RETURNING id`);
  await test(`${shape}: family lists expose metadata and masked creator only`, async () => {
    const list = await readAdminDetails({ view: "families", filter: "all", page: 1 }, NOW);
    eq(list.total, 1);
    const row = list.rows[0];
    ok(row.kind === "family", "family row");
    if (row.kind !== "family") return;
    eq([row.id, row.members, row.status, row.emailMasked], [2, 3, "active", "e•••@•••"]);
    eq(openAdminRef(row.ref), { kind: "family", id: 2 });
    const serialized = JSON.stringify(list);
    for (const privateValue of [alpha.owner, beta.owner, "Rowan", "Family Beta", "Ibuprofen", "first bath"]) ok(!serialized.includes(privateValue), "no private data in list response");
    eq((await readAdminDetails({ view: "families", filter: "7d", page: 1 }, NOW)).total, 1);
    eq((await readAdminDetails({ view: "families", filter: "active7d", page: 1 }, NOW)).total, 1);
    eq((await readAdminDetails({ view: "families", filter: "onboarding", page: 1 }, NOW)).total, 0);
    eq((await readAdminDetails({ view: "families", filter: "setup_complete", page: 1 }, NOW)).total, 1);
  });
  await test(`${shape}: people lists exclude original family, pending invites and pseudo-accounts`, async () => {
    const list = await readAdminDetails({ view: "people", filter: "all", page: 1 }, NOW);
    eq(list.total, 2);
    eq(list.rows.map((row) => row.kind === "person" && [row.emailMasked, row.familyIds, row.joinedAt, row.lastSeenAt]), [
      ["e•••@•••", [2], "2026-10-27T12:00:00.000Z", "2026-10-28T11:00:00.000Z"],
      ["f•••@•••", [2], "2026-10-27T12:00:00.000Z", "2026-10-28T11:00:00.000Z"],
    ]);
    ok(!JSON.stringify(list).includes("example"), "no raw domain or email payload");
  });
  await test(`${shape}: family and people rows say what they used, counted up to the snapshot and never what was logged`, async () => {
    await sql(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, data, note, created_by, source, created_at) VALUES
      (2, $1, 'feed', '2026-10-28T09:00:00Z', '{}', NULL, $2, 'chat', '2026-10-28T11:00:00Z'),
      (2, $1, 'diaper', '2026-10-27T09:00:00Z', '{}', NULL, $3, 'web', '2026-10-27T09:30:00Z'),
      (2, $1, 'diaper', '2026-10-27T08:00:00Z', '{}', NULL, $3, 'web', '2026-10-27T08:30:00Z'),
      (2, $1, 'note', '2026-10-20T09:00:00Z', '{}', 'Made-up private note', $2, 'shortcut', '2026-10-20T09:00:00Z'),
      (2, $1, 'growth', '2026-09-01T09:00:00Z', '{}', NULL, $2, 'epic', '2026-09-01T09:00:00Z'),
      (2, $1, 'sleep', '2026-10-29T09:00:00Z', '{}', NULL, $2, 'web', '2026-10-29T09:00:00Z')`, [beta.babyId, beta.owner, beta.member]);
    await sql(`INSERT INTO maple_chat_daily (family_id, member, day, messages) VALUES (2, $1, '2026-10-26', 5), (2, $2, '2026-09-01', 7)`, [beta.owner, beta.member]);
    const list = await readAdminDetails({ view: "families", filter: "all", page: 1 }, NOW);
    const row = list.rows[0];
    ok(row.kind === "family", "family row");
    if (row.kind !== "family") return;
    // Oct 28 11:00 is period 0, Oct 27 is period 1; Oct 29's entry is after the snapshot and Sept 1's is outside 30 days.
    eq(row.usage, {
      entries7d: 3, entries30d: 4, days7d: 2, lastEntryAt: "2026-10-28T11:00:00.000Z", lastSeenAt: "2026-10-28T11:00:00.000Z",
      chat30d: 8, features: ["feeds", "diapers", "notes", "chat"], sources: ["app", "chat", "siri"],
    });
    ok(!JSON.stringify(list).includes("Made-up private note"), "no entry contents");
    const people = await readAdminDetails({ view: "people", filter: "all", page: 1 }, NOW);
    const usage = Object.fromEntries(people.rows.map((p) => p.kind === "person" ? [p.emailMasked, p.usage] : []));
    eq(usage, { "e•••@•••": { entries30d: 2, chat30d: 8 }, "f•••@•••": { entries30d: 2, chat30d: 0 } });
    eq((await readAdminDetails({ view: "families", filter: "logged7d", page: 1 }, NOW)).total, 1);
    eq((await readAdminDetails({ view: "families", filter: "chat30d", page: 1 }, NOW)).total, 1);
    await sql(`UPDATE maple_entries SET deleted_at = NOW() WHERE family_id = 2`);
    await sql(`DELETE FROM maple_chat_daily WHERE family_id = 2`);
    eq((await readAdminDetails({ view: "families", filter: "logged7d", page: 1 }, NOW)).total, 0, "deleted entries don't count");
    eq((await readAdminDetails({ view: "families", filter: "chat30d", page: 1 }, NOW)).total, 0);
    if (shape === "final") {
      await sql(`INSERT INTO maple_care_people (family_id, member, created_by) VALUES (2, $1, $1)`, [beta.owner]);
      await sql(`INSERT INTO maple_care_entries (family_id, id, person, kind, at, data, created_by, created_at) VALUES (2, 30000001, $1, 'temp', '2026-10-27T10:00:00Z', '{}', $1, '2026-10-27T10:00:00Z')`, [beta.owner]);
      const withPage = (await readAdminDetails({ view: "families", filter: "all", page: 1 }, NOW)).rows[0];
      eq(withPage.kind === "family" && withPage.usage.features, ["recovery"], "her page counts as used, with nothing about it");
      await sql(`DELETE FROM maple_care_entries WHERE family_id = 2`);
      await sql(`DELETE FROM maple_care_people WHERE family_id = 2`);
    }
  });

  await test(`${shape}: feedback lists every family's messages in full, newest first, with the sender masked until revealed`, async () => {
    const [older] = await sql(`INSERT INTO maple_feedback (family_id, member, role, via, topic, message, emailed_at, created_at)
      VALUES (2, $1, 'member', 'app', 'idea', 'Could pumping show a weekly total?', NOW(), '2026-10-20T12:00:00Z') RETURNING id`, [beta.member]);
    const [newer] = await sql(`INSERT INTO maple_feedback (family_id, member, role, via, rating, message, created_at)
      VALUES (2, 'admin', 'owner', 'prompt', 'okay', NULL, '2026-10-27T12:00:00Z') RETURNING id`);
    // The original family's too, unlike every count on the page: it's a message to read, and where the operator tests it.
    const [own] = await sql(`INSERT INTO maple_feedback (family_id, member, role, via, message, created_at)
      VALUES (1, $1, 'owner', 'chat', 'Family 1 feedback', '2026-10-25T12:00:00Z') RETURNING id`, [alpha.owner]);
    const list = await readAdminDetails({ view: "feedback", filter: "all", page: 1 }, NOW);
    eq(list.total, 3, "every family's");
    eq(list.rows.map((r) => r.kind === "feedback" && [r.id, r.familyId, r.role, r.via, r.topic, r.rating, r.message, r.emailed, r.emailMasked]), [
      [Number(newer.id), 2, "owner", "prompt", null, "okay", null, false, null],
      [Number(own.id), 1, "owner", "chat", null, null, "Family 1 feedback", false, "a•••@•••"],
      [Number(older.id), 2, "member", "app", "idea", null, "Could pumping show a weekly total?", true, "f•••@•••"],
    ]);
    const [first, second, third] = list.rows;
    ok(first.kind === "feedback" && first.ref === null, "no reply address for the shared admin login");
    const body = JSON.stringify(list);
    ok(third.kind === "feedback" && third.ref !== null && !body.includes(beta.member) && !body.includes(alpha.owner), "senders masked");
    const ref = third.kind === "feedback" ? openAdminRef(third.ref) : null;
    eq(ref, { kind: "feedback", id: Number(older.id) });
    eq(await revealAdminEmail(ref!), beta.member);
    eq(await revealAdminEmail(second.kind === "feedback" ? openAdminRef(second.ref)! : ref!), alpha.owner, "the original family's sender can be revealed too");
    let missing = false;
    try { await revealAdminEmail({ kind: "feedback", id: Number(newer.id) }); } catch (error) { missing = error instanceof NotFound; }
    ok(missing, "no address to reveal for the admin login");
    await sql(`DELETE FROM maple_feedback`);
  });

  await test(`${shape}: waitlist list and explicit reveal reread current rows`, async () => {
    const list = await readAdminDetails({ view: "waitlist", filter: "all", page: 1 }, NOW);
    eq(list.total, 1);
    eq(list.rows[0].emailMasked, "w•••@•••");
    const ref = openAdminRef(list.rows[0].ref)!;
    eq(ref, { kind: "waitlist", id: Number(wait.id) });
    eq(await revealAdminEmail(ref), "wait.person@example.test");
    eq(await revealAdminEmail({ kind: "family", id: 2 }), beta.owner);
    eq(await revealAdminEmail({ kind: "person", email: beta.owner }), beta.owner);
    await sql(`DELETE FROM maple_waitlist WHERE id = $1`, [wait.id]);
    for (const missing of [ref, { kind: "family" as const, id: 1 }, { kind: "person" as const, email: alpha.owner }, { kind: "person" as const, email: beta.viewer }]) {
      let denied = false;
      try { await revealAdminEmail(missing); } catch (error) { denied = error instanceof NotFound; }
      ok(denied, "gone or excluded contact cannot be revealed");
    }
  });
  await sql(`INSERT INTO maple_families (id, timezone, status, created_at)
    SELECT n, 'UTC', 'onboarding', '2026-10-01T00:00:00Z'::timestamptz + n * INTERVAL '1 hour' FROM generate_series(3, 28) AS n`);
  if (shape === "final") await test("final: people belonging to multiple families appear only once", async () => {
    await sql(`INSERT INTO maple_members (family_id, email, role, accepted_at) VALUES (3, $1, 'member', '2026-10-28T10:00:00Z')`, [beta.owner]);
    const list = await readAdminDetails({ view: "people", filter: "all", page: 1 }, NOW);
    eq(list.total, 2);
    eq(list.rows[0].kind === "person" && list.rows[0].familyIds, [2, 3]);
  });
  await test(`${shape}: pagination is bounded, stable and retains total on empty pages`, async () => {
    const a = await readAdminDetails({ view: "families", filter: "all", page: 1 }, NOW);
    const b = await readAdminDetails({ view: "families", filter: "all", page: 2 }, NOW);
    const empty = await readAdminDetails({ view: "families", filter: "all", page: 3 }, NOW);
    eq([a.total, a.pageSize, a.rows.length, b.total, b.rows.length, empty.total, empty.rows.length], [27, 25, 25, 27, 2, 27, 0]);
    eq(new Set([...a.rows, ...b.rows].map((row) => row.kind === "family" && row.id)).size, 27);
  });
  await test(`${shape}: unauthenticated and other-family owners cannot list or reveal`, async () => {
    await sql(`ALTER TABLE maple_waitlist RENAME TO maple_waitlist_auth_sentinel`);
    eq((await detailsGet(request("details?view=waitlist"))).status, 401);
    eq((await revealPost(request("reveal", undefined, 1, { ref: "anything" }))).status, 401);
    eq((await detailsGet(request("details?view=waitlist", beta.owner, 2))).status, 403);
    eq((await revealPost(request("reveal", beta.owner, 2, { ref: "anything" }))).status, 403);
  });
}

async function operatorRoutes() {
  const operator = process.env.MAPLE_METRICS_TEST_ACCOUNT;
  if (!operator) return;
  await freshDb({ shape: "final" });
  await seedFamilies();
  await sql(`INSERT INTO maple_members (family_id, email, role, accepted_at) VALUES (1, $1, 'owner', NOW())`, [operator]);
  const [waiting] = await sql(`INSERT INTO maple_waitlist (email) VALUES ('route.person@example.test') RETURNING id`);
  const response = NextResponse.json({});
  grantMetricsAccess(response, operator, operator);
  const proof = response.headers.get("set-cookie")!.split(";")[0];
  const ref = sealAdminRef({ kind: "waitlist", id: Number(waiting.id) });
  await test("operator routes: proof is required, list is masked, reveal requires explicit same-origin POST", async () => {
    eq((await detailsGet(request("details?view=waitlist", operator))).status, 403);
    const list = await detailsGet(request("details?view=waitlist", operator, 1, undefined, proof));
    eq(list.status, 200);
    eq(list.headers.get("cache-control"), "no-store");
    const body = await list.text();
    ok(!body.includes("route.person@example.test"), "list has no raw email");
    const reveal = await revealPost(request("reveal", operator, 1, { ref }, proof));
    eq(reveal.status, 200);
    eq(reveal.headers.get("cache-control"), "no-store");
    eq(await reveal.json(), { email: "route.person@example.test" });
    for (const headers of [{ origin: "https://evil.example", "sec-fetch-site": "cross-site" }, { origin: "http://sibling.localhost:3000", "sec-fetch-site": "same-site" }]) {
      eq((await revealPost(request("reveal", operator, 1, { ref }, proof, headers))).status, 403);
    }
    eq((await revealPost(request("reveal", operator, 1, { ref: "x".repeat(9000) }, proof))).status, 400);
    eq((await revealPost(request("reveal", operator, 1, { ref }, proof, { "content-type": "text/plain" }))).status, 400);
    eq((await revealPost(request("reveal", operator, 1, { ref: sealAdminRef({ kind: "waitlist", id: Number(waiting.id) }, Date.now() - ADMIN_REF_TTL_MS) }, proof))).status, 400);
    await sql(`DELETE FROM maple_members WHERE email = $1`, [operator]);
    eq((await revealPost(request("reveal", operator, 1, { ref }, proof))).status, 401);
  });
}

async function main() {
  await references();
  for (const shape of ["production", "final"] as const) await data(shape);
  await operatorRoutes();
  await test("missing database does not return empty contact lists", async () => {
    process.env.DATABASE_URL = "";
    let offline = false;
    try { await readAdminDetails({ view: "waitlist", filter: "all", page: 1 }); } catch (error) { offline = error instanceof StoreUnavailable; }
    ok(offline, "missing database is unavailable");
  });
  done("admin-details.check.ts");
}

void main().catch((error) => { console.error(error); process.exit(1); });
