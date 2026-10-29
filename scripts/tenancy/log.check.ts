import type { NextRequest } from "next/server";
import { encryptSecret } from "../../src/lib/secret-box";
import * as store from "../../src/lib/maple/store";
import { NotFound } from "../../src/lib/maple/store";
import { done, eq, freshDb, ok, seedFamilies, sql, test, type FamilySeed, type Shape } from "./harness";

/**
 * The log (src/lib/maple/store.ts and the entries, restore, timer and state
 * routes) across two made-up families, on both schema shapes: family B can
 * neither read nor change family A's baby, entries, timers, members,
 * invites or Siri tokens, another family's row answers exactly like a
 * missing one, and every write lands in the caller's family.
 */

const A = { familyId: 1 };
const B = { familyId: 2 };
const MISSING = 987654321;

async function notFound(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof NotFound) return;
    throw new Error(`${label}: threw ${err instanceof Error ? `${err.constructor.name} ${err.message}` : String(err)}, want NotFound`);
  }
  throw new Error(`${label}: succeeded, want NotFound`);
}

/** The same call on another family's id and on an id nobody has: both NotFound, with the same words. */
async function likeMissing(fn: (id: number) => Promise<unknown>, id: number, label: string): Promise<void> {
  const message = async (n: number) => {
    try {
      await fn(n);
      return "succeeded";
    } catch (err) {
      return err instanceof NotFound ? `NotFound ${err.message.replace(String(n), "<id>")}` : `${err instanceof Error ? err.constructor.name : "?"} ${String(err)}`;
    }
  };
  eq(await message(id), await message(MISSING), label);
  ok((await message(id)).startsWith("NotFound"), `${label}: not NotFound`);
}

const entryRow = async (id: number) => (await sql(`SELECT family_id, deleted_at, updated_at, active, started_at, ended_at, data FROM maple_entries WHERE id = $1`, [id]))[0];

async function startedFeed(fam: typeof A, seed: FamilySeed) {
  return (await store.startTimer(fam, { babyId: seed.babyId, kind: "feed", side: "L", at: new Date(Date.now() - 20 * 60_000), createdBy: seed.owner, source: "web" })).entry;
}

async function storeChecks(shape: Shape) {
  await freshDb({ shape });
  const { alpha, beta } = await seedFamilies();

  await test(`${shape}: getBaby gives each family its own baby; a family with none gets NotFound`, async () => {
    eq([(await store.getBaby(A)).name, (await store.getBaby(B)).name, (await store.getBaby(2)).id], [alpha.babyName, beta.babyName, beta.babyId]);
    const [fam] = await sql(`INSERT INTO maple_families (timezone, status) VALUES ('America/Phoenix', 'onboarding') RETURNING id`);
    await notFound(() => store.getBaby(Number(fam.id)), "no baby");
  });

  await test(`${shape}: a store call without a family refuses to run`, async () => {
    for (const fam of [0, -1, Number.NaN, { familyId: 0 }, {} as typeof A, null as unknown as typeof A]) {
      let threw = "";
      try {
        await store.getBaby(fam);
      } catch (err) {
        threw = (err as Error).message;
      }
      eq(threw, "family_required", JSON.stringify(fam));
    }
  });

  await test(`${shape}: updateBaby on another family's baby is NotFound and changes nothing`, async () => {
    await likeMissing((id) => store.updateBaby(B, id, { name: "Changed", settings: { show_alerts: true } }), alpha.babyId, "updateBaby");
    eq((await store.getBaby(A)).name, alpha.babyName);
    eq((await store.updateBaby(B, beta.babyId, { nickname: "Roo" })).nickname, "Roo");
  });

  await test(`${shape}: listEntries, activeTimers and lifetimeCounts never return another family's rows, even naming its baby`, async () => {
    await startedFeed(A, alpha);
    eq(await store.listEntries(B, { babyId: alpha.babyId, includeActive: true }), []);
    eq(await store.activeTimers(B, alpha.babyId), []);
    eq((await store.listEntries(A, { babyId: alpha.babyId, includeActive: true })).length, 4);
    eq((await store.listEntries(B, { babyId: beta.babyId })).map((e) => e.id).sort(), Object.values(beta.entries).sort());
    const counts = await store.lifetimeCounts(B, alpha.babyId);
    eq([counts.diapers, counts.feeds, counts.week?.counts], [0, 0, []]);
    eq((await store.lifetimeCounts(A, alpha.babyId)).diapers, 1);
  });

  await test(`${shape}: getEntry by another family's id reads as missing, deleted ones included`, async () => {
    eq(await store.getEntry(B, alpha.entries.diaper), null);
    eq(await store.getEntry(B, alpha.entries.moment, { includeDeleted: true }), null);
    eq((await store.getEntry(A, alpha.entries.diaper))?.id, alpha.entries.diaper);
  });

  await test(`${shape}: updateEntry and softDeleteEntry on another family's entry are NotFound and change nothing`, async () => {
    const before = await entryRow(alpha.entries.feed);
    await likeMissing((id) => store.updateEntry(B, id, { note: "changed" }, beta.owner), alpha.entries.feed, "updateEntry");
    await likeMissing((id) => store.softDeleteEntry(B, id, beta.owner), alpha.entries.feed, "softDeleteEntry");
    eq(await entryRow(alpha.entries.feed), before);
    eq((await store.updateEntry(B, beta.entries.diaper, { note: "theirs" }, beta.owner)).note, "theirs");
  });

  await test(`${shape}: another family's deleted entry can't be listed, restored or traced to who removed it`, async () => {
    await store.softDeleteEntry(A, alpha.entries.moment, alpha.owner);
    const since = new Date(Date.now() - 3600_000);
    eq(await store.listDeleted(B, alpha.babyId, since), []);
    eq((await store.listDeleted(A, alpha.babyId, since)).map((e) => e.id), [alpha.entries.moment]);
    eq(await store.discardedBy(B, alpha.entries.moment), undefined);
    eq(await store.discardedBy(A, alpha.entries.moment), alpha.owner);
    await likeMissing((id) => store.restoreEntryDetailed(B, id, beta.owner), alpha.entries.moment, "restoreEntryDetailed");
    await likeMissing((id) => store.restoreEntry(B, id, beta.owner), alpha.entries.moment, "restoreEntry");
    ok((await entryRow(alpha.entries.moment)).deleted_at, "still deleted");
    eq((await store.restoreEntry(A, alpha.entries.moment, alpha.owner)).id, alpha.entries.moment);
  });

  await test(`${shape}: a new entry lands in the caller's family, and never on another family's baby`, async () => {
    const at = new Date(Date.now() - 3600_000);
    const mine = await store.createEntry(B, { babyId: beta.babyId, kind: "diaper", startedAt: at, data: { pee: true }, createdBy: beta.owner, source: "web" });
    eq((await entryRow(mine.id)).family_id, "2");
    const count = async () => Number((await sql(`SELECT COUNT(*)::int AS n FROM maple_entries WHERE baby_id = $1`, [alpha.babyId]))[0].n);
    const n = await count();
    await notFound(() => store.createEntryOnce(B, { babyId: alpha.babyId, kind: "diaper", startedAt: at, data: { pee: true }, createdBy: beta.owner, source: "web", clientId: "beta-onto-alpha-0001" }), "another family's baby");
    eq(await count(), n);
  });

  await test(`${shape}: a client_id replay returns the caller's own save, never another family's`, async () => {
    const at = new Date(Date.now() - 3600_000);
    const replay = await store.createEntryOnce(A, { babyId: alpha.babyId, kind: "diaper", startedAt: at, data: { poop: true }, createdBy: alpha.owner, source: "web", clientId: alpha.entryClientId });
    eq([replay.deduped, replay.entry.id], [true, alpha.entries.diaper]);
    let reused: Awaited<ReturnType<typeof store.createEntryOnce>> | string;
    try {
      reused = await store.createEntryOnce(B, { babyId: beta.babyId, kind: "diaper", startedAt: at, data: { poop: true }, createdBy: beta.owner, source: "web", clientId: alpha.entryClientId });
    } catch (err) {
      reused = String((err as { code?: unknown }).code);
    }
    if (shape === "production") {
      // The old global client_id key still stands beside the family one: the insert is refused, never answered with A's row.
      eq(reused, "23505");
    } else {
      ok(typeof reused === "object" && !reused.deduped && reused.entry.id !== alpha.entries.diaper, "a save of B's own");
      const own = (reused as { entry: { id: number } }).entry.id;
      eq((await entryRow(own)).family_id, "2");
      const again = await store.createEntryOnce(B, { babyId: beta.babyId, kind: "diaper", startedAt: at, data: { pee: true }, createdBy: beta.owner, source: "web", clientId: alpha.entryClientId });
      eq([again.deduped, again.entry.id], [true, own], "B's replay of the same id");
    }
    eq((await entryRow(alpha.entries.diaper)).data, { pee: true });
  });

  await test(`${shape}: every timer action on another family's timer is NotFound, worded as for a missing one, and changes nothing`, async () => {
    const [running] = await store.activeTimers(A, alpha.babyId);
    const before = await entryRow(running.id);
    const at = new Date(Date.now() - 60_000);
    const ref = { side: "L" as const, start: running.started_at };
    const actions: [string, (id: number) => Promise<unknown>][] = [
      ["switchSide", (id) => store.switchSide(B, id, "R", undefined, beta.owner)],
      ["pauseTimer", (id) => store.pauseTimer(B, id, undefined, beta.owner)],
      ["stopTimer", (id) => store.stopTimer(B, id, undefined, beta.owner)],
      ["retimeFeed move", (id) => store.retimeFeed(B, id, { op: "move", edge: "start", to: at.toISOString(), ref }, beta.owner)],
      ["retimeFeed set_side", (id) => store.retimeFeed(B, id, { op: "set_side", ref, side: "R" }, beta.owner)],
      ["adjustTimerStart", (id) => store.adjustTimerStart(B, id, at, beta.owner)],
      ["discardTimer", (id) => store.discardTimer(B, id, beta.owner)],
      ["discardTimer expect", (id) => store.discardTimer(B, id, beta.owner, { expectUpdatedAt: running.updated_at })],
      ["reopenTimer", (id) => store.reopenTimer(B, id, beta.owner)],
      ["reopenTimerDetailed", (id) => store.reopenTimerDetailed(B, id, beta.owner, { side: "R" })],
    ];
    for (const [label, fn] of actions) await likeMissing(fn, running.id, label);
    eq(await entryRow(running.id), before);
  });

  await test(`${shape}: starting a timer sees only the caller's family's running one, and refuses another family's baby`, async () => {
    const [aFeed] = await store.activeTimers(A, alpha.babyId);
    const started = await store.startTimer(B, { babyId: beta.babyId, kind: "feed", side: "R", at: new Date(), createdBy: beta.owner, source: "web" });
    ok(!started.alreadyRunning && started.entry.id !== aFeed.id, "B's own new feed");
    eq((await entryRow(started.entry.id)).family_id, "2");
    const again = await store.startTimer(B, { babyId: beta.babyId, kind: "feed", side: "R", at: new Date(), createdBy: beta.owner, source: "web" });
    eq([again.alreadyRunning, again.entry.id], [true, started.entry.id]);
    await notFound(() => store.startTimer(B, { babyId: alpha.babyId, kind: "sleep", at: new Date(), createdBy: beta.owner, source: "web" }), "another family's baby");
    eq((await store.activeTimers(A, alpha.babyId)).map((e) => e.id), [aFeed.id]);
  });

  await test(`${shape}: "Same feed as" never joins across families, and puts the caller's feed back`, async () => {
    const [aFeed] = await store.activeTimers(A, alpha.babyId);
    const [bFeed] = await store.activeTimers(B, beta.babyId);
    const aBefore = await entryRow(aFeed.id);
    await notFound(() => store.joinFeeds(B, bFeed.id, aFeed.id, "L", beta.owner), "into another family's feed");
    ok(!(await entryRow(bFeed.id)).deleted_at, "B's feed back");
    await notFound(() => store.joinFeeds(B, aFeed.id, bFeed.id, "L", beta.owner), "another family's feed joined in");
    eq(await entryRow(aFeed.id), aBefore);
  });

  await test(`${shape}: rev and touchLastSeen are per family: another family's writes never move the caller's token`, async () => {
    const before = [await store.rev(B, beta.babyId), await store.rev(B, alpha.babyId)];
    await store.createEntry(A, { babyId: alpha.babyId, kind: "note", startedAt: new Date(), data: { text: "made up" }, createdBy: alpha.owner, source: "web" });
    await store.updateBaby(A, alpha.babyId, { nickname: "Juni" });
    await sql(`INSERT INTO maple_members (family_id, email, role) VALUES (1, 'new.alpha@example.com', 'member')`);
    eq([await store.rev(B, beta.babyId), await store.rev(B, alpha.babyId)], before);
    eq(await store.touchLastSeen(B, alpha.owner), null);
    eq((await sql(`SELECT last_seen_at FROM maple_members WHERE email = $1`, [alpha.owner]))[0].last_seen_at, null);
  });

  await tokens(shape, alpha, beta);
}

async function tokens(shape: Shape, alpha: FamilySeed, beta: FamilySeed) {
  await test(`${shape}: Siri tokens: listed and revoked per family; a token names its own family`, async () => {
    eq(await store.listPersonalTokens(B, alpha.owner), []);
    eq(await store.revokePersonalToken(B, alpha.owner, alpha.tokenId), false);
    eq(await store.memberForPersonalToken(alpha.token), { member: alpha.owner, family_id: 1 });
    eq(await store.memberForPersonalToken(beta.token), { member: beta.owner, family_id: 2 });
    const made = await store.createPersonalToken(B, beta.member, "Made-up phone");
    eq((await sql(`SELECT family_id FROM maple_tokens WHERE id = $1`, [made.record.id]))[0].family_id, "2");
    eq(await store.memberForPersonalToken(made.token), { member: beta.member, family_id: 2 });
    eq(await store.revokePersonalToken(A, beta.member, made.record.id), false);
    eq(await store.revokePersonalToken(B, beta.member, made.record.id), true);
  });
}

// ── the routes, signed in with made-up session cookies ───────────────

process.env.GOOGLE_CLIENT_SECRET ??= "made-up-secret-for-tenancy-checks";

type Handler = (request: NextRequest) => Promise<Response>;
type Answer = { status: number; body: Record<string, unknown> };

/** A session cookie as auth.ts seals it; no `fam` is one from before families. */
const cookie = (id: string, fam?: number) => encryptSecret(JSON.stringify({ id, ...(fam === undefined ? {} : { fam }), iat: Date.now() }));

async function call(handler: Handler, method: string, path: string, session: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const { NextRequest } = await import("next/server");
  const request = new NextRequest(new URL(path, "http://localhost:3000"), {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  request.cookies.set("maple_session", session);
  const res = await handler(request);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Another family's id answers exactly as an id nobody has: same status, same body but for the id itself. */
async function routeLikeMissing(ask: (id: number) => Promise<Answer>, id: number, label: string): Promise<void> {
  const seen = async (n: number) => {
    const a = await ask(n);
    return { status: a.status, body: JSON.parse(JSON.stringify(a.body).split(String(n)).join("<id>")) };
  };
  const got = await seen(id);
  eq(got, await seen(MISSING), label);
  eq(got.status, 404, `${label}: status`);
}

async function routeChecks(shape: Shape) {
  await freshDb({ shape });
  const { alpha, beta } = await seedFamilies();
  const entries = await import("../../src/app/api/maple/entries/route");
  const restore = await import("../../src/app/api/maple/entries/restore/route");
  const timer = await import("../../src/app/api/maple/timer/route");
  const state = await import("../../src/app/api/maple/state/route");
  const oldA = cookie(alpha.owner);
  const sessA = cookie(alpha.owner, 1);
  const sessB = cookie(beta.owner, 2);
  const ids = (body: Record<string, unknown>) => ((body.entries ?? []) as { id: number }[]).map((e) => e.id).sort((x, y) => x - y);

  await test(`${shape}: GET state: each family sees only its own baby, people and log; an old cookie opens family 1 only`, async () => {
    const recent = async (fam: number, seed: FamilySeed) =>
      (await store.createEntry(fam, { babyId: seed.babyId, kind: "diaper", startedAt: new Date(Date.now() - 3600_000), data: { pee: true }, createdBy: seed.owner, source: "web" })).id;
    const [mineA, mineB] = [await recent(1, alpha), await recent(2, beta)];
    const a = await call(state.GET, "GET", "/api/maple/state", oldA);
    eq([a.status, (a.body.baby as { name: string }).name, ids(a.body)], [200, alpha.babyName, [mineA]]);
    eq(((a.body.members as { email: string }[]) ?? []).map((m) => m.email).sort(), [alpha.member, alpha.owner, alpha.viewer].sort());
    const b = await call(state.GET, "GET", "/api/maple/state", sessB);
    eq([b.status, (b.body.baby as { name: string }).name, ids(b.body)], [200, beta.babyName, [mineB]]);
    eq(((b.body.members as { email: string }[]) ?? []).map((m) => m.email).sort(), [beta.member, beta.owner, beta.viewer].sort());
    eq((await call(state.GET, "GET", "/api/maple/state", cookie(beta.owner))).status, 401);
    eq((await call(state.GET, "GET", "/api/maple/state", cookie(beta.owner, 1))).status, 401);
    eq([a.body.family, b.body.family], [{ id: 1, ask: "Avery" }, { id: 2, ask: "Emery" }], "who a viewer asks comes from that family's current owners");
  });

  await test(`${shape}: GET state: family A's writes never change family B's rev`, async () => {
    const before = (await call(state.GET, "GET", "/api/maple/state", sessB)).body.rev as string;
    await store.createEntry(1, { babyId: alpha.babyId, kind: "note", startedAt: new Date(), data: { text: "made up" }, createdBy: alpha.owner, source: "web" });
    await sql(`INSERT INTO maple_members (family_id, email, role) VALUES (1, 'route.alpha@example.com', 'member')`);
    const after = await call(state.GET, "GET", `/api/maple/state?rev=${encodeURIComponent(before)}`, sessB);
    eq(after.body.unchanged, true);
  });

  await test(`${shape}: GET entries lists the caller's family only, removed ones included`, async () => {
    const listed = ids((await call(entries.GET, "GET", "/api/maple/entries", sessB)).body);
    eq(listed, (await store.listEntries(2, { babyId: beta.babyId })).map((e) => e.id).sort((x, y) => x - y));
    ok(Object.values(beta.entries).every((id) => listed.includes(id)) && !Object.values(alpha.entries).some((id) => listed.includes(id)), "B's own entries only");
    await store.softDeleteEntry(1, alpha.entries.moment, alpha.owner);
    eq(ids((await call(entries.GET, "GET", "/api/maple/entries?deleted=1", sessB)).body), []);
    eq(ids((await call(entries.GET, "GET", "/api/maple/entries?deleted=1", sessA)).body), [alpha.entries.moment]);
  });

  await test(`${shape}: POST entries files the entry under the caller's family and baby; an old cookie keeps family 1`, async () => {
    const b = await call(entries.POST, "POST", "/api/maple/entries", sessB, { kind: "diaper", data: { pee: true }, client_id: "route-beta-diaper-1" });
    eq(b.status, 201);
    const [rowB] = await sql(`SELECT family_id, baby_id FROM maple_entries WHERE id = $1`, [(b.body.entry as { id: number }).id]);
    eq([rowB.family_id, Number(rowB.baby_id)], ["2", beta.babyId]);
    const a = await call(entries.POST, "POST", "/api/maple/entries", oldA, { kind: "diaper", data: { poop: true } });
    const [rowA] = await sql(`SELECT family_id, baby_id FROM maple_entries WHERE id = $1`, [(a.body.entry as { id: number }).id]);
    eq([a.status, rowA.family_id, Number(rowA.baby_id)], [201, "1", alpha.babyId]);
  });

  await test(`${shape}: a queued write replayed under another family's session is refused and saves nothing`, async () => {
    const before = Number((await sql(`SELECT count(*)::int AS n FROM maple_entries`))[0].n);
    const wrong = await call(entries.POST, "POST", "/api/maple/entries", sessB, { kind: "diaper", data: { pee: true }, client_id: "queued-in-alpha-1" }, { "x-maple-family": "1" });
    eq([wrong.status, wrong.body.code], [409, "family_mismatch"]);
    eq(Number((await sql(`SELECT count(*)::int AS n FROM maple_entries`))[0].n), before, "nothing saved");
    const care = await import("../../src/app/api/maple/care/entries/route");
    eq((await call(care.POST, "POST", "/api/maple/care/entries", sessB, { kind: "temp", data: { temp_c: 37 } }, { "x-maple-family": "1" })).status, 409, "a care write too");
    const right = await call(entries.POST, "POST", "/api/maple/entries", sessA, { kind: "diaper", data: { pee: true }, client_id: "queued-in-alpha-1" }, { "x-maple-family": "1" });
    eq([right.status, (await sql(`SELECT family_id FROM maple_entries WHERE client_id = 'queued-in-alpha-1'`)).map((r) => r.family_id)], [201, ["1"]], "back in its own family");
  });

  await test(`${shape}: PATCH, DELETE and restore of another family's entry answer as for a missing one and change nothing`, async () => {
    const before = await entryRow(alpha.entries.diaper);
    const deleted = await entryRow(alpha.entries.moment);
    for (const id of [alpha.entries.diaper, alpha.entries.moment]) {
      await routeLikeMissing((n) => call(entries.PATCH, "PATCH", `/api/maple/entries?id=${n}`, sessB, { note: "changed" }), id, `PATCH ${id}`);
      await routeLikeMissing((n) => call(entries.DELETE, "DELETE", `/api/maple/entries?id=${n}`, sessB), id, `DELETE ${id}`);
      await routeLikeMissing((n) => call(restore.POST, "POST", `/api/maple/entries/restore?id=${n}`, sessB), id, `restore ${id}`);
    }
    eq([await entryRow(alpha.entries.diaper), await entryRow(alpha.entries.moment)], [before, deleted]);
    eq((await call(entries.PATCH, "PATCH", `/api/maple/entries?id=${alpha.entries.moment}`, sessA, { note: "x" })).body.reason, "discarded");
  });

  await test(`${shape}: every timer action on another family's timer answers as for a missing one and changes nothing`, async () => {
    const aFeed = await startedFeed({ familyId: 1 }, alpha);
    const before = await entryRow(aFeed.id);
    const ref = { side: "L", start: aFeed.started_at };
    const at = new Date(Date.now() - 60_000).toISOString();
    const bodies: [string, (id: number) => Record<string, unknown>][] = [
      ["switch", (id) => ({ action: "switch", id, side: "R" })],
      ["resume", (id) => ({ action: "resume", id, side: "R" })],
      ["pause", (id) => ({ action: "pause", id })],
      ["stop", (id) => ({ action: "stop", id })],
      ["retime", (id) => ({ action: "retime", id, edit: { op: "set_side", ref, side: "R" } })],
      ["adjust", (id) => ({ action: "adjust", id, at })],
      ["discard", (id) => ({ action: "discard", id })],
      ["reopen", (id) => ({ action: "reopen", id })],
    ];
    for (const [label, body] of bodies) await routeLikeMissing((n) => call(timer.POST, "POST", "/api/maple/timer", sessB, body(n)), aFeed.id, label);
    const mine = await call(timer.POST, "POST", "/api/maple/timer", sessB, { action: "start", kind: "feed", side: "L" });
    const bFeed = (mine.body.entry as { id: number }).id;
    eq([mine.status, mine.body.alreadyRunning, (await entryRow(bFeed)).family_id], [200, false, "2"]);
    await routeLikeMissing((n) => call(timer.POST, "POST", "/api/maple/timer", sessB, { action: "join", id: bFeed, into: n, side: "L" }), aFeed.id, "join into");
    await routeLikeMissing((n) => call(timer.POST, "POST", "/api/maple/timer", sessB, { action: "join", id: n, into: bFeed, side: "L" }), aFeed.id, "join from");
    eq(await entryRow(aFeed.id), before);
    ok(!(await entryRow(bFeed)).deleted_at, "B's own feed is back");
  });
}

async function familyOneUnchanged() {
  await test("family 1 alone: the scoped rev reads exactly what the unscoped one did, so no phone refetches", async () => {
    await freshDb();
    const { alpha } = await seedFamilies();
    for (const t of ["maple_ai_usage", "maple_chat_messages", "maple_chat_daily", "maple_chat_threads", "maple_consents", "maple_removed", "maple_invites", "maple_tokens", "maple_push_subs", "maple_entries", "maple_members", "maple_babies"]) {
      await sql(`DELETE FROM ${t} WHERE family_id = 2`);
    }
    await sql(`DELETE FROM maple_families WHERE id = 2`);
    const [old] = await sql(
      `SELECT
         (SELECT COALESCE(MAX(updated_at)::text, '') || '/' || COUNT(*) FROM maple_entries WHERE baby_id = $1) AS e,
         (SELECT COALESCE(updated_at::text, '') FROM maple_babies WHERE id = $1) AS b,
         (SELECT COALESCE(MAX(updated_at)::text, '') || '/' || COUNT(*) FROM maple_members) AS m`,
      [alpha.babyId]
    );
    eq((await store.rev(A, alpha.babyId)).split("|").slice(0, 3), [old.e, old.b, old.m]);
  });
}

async function main() {
  for (const shape of ["production", "final"] as const) {
    await storeChecks(shape);
    await routeChecks(shape);
  }
  await familyOneUnchanged();
}

main().then(() => done("log.check.ts"));
