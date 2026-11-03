/**
 * The sleep plan on an in-memory Postgres: the store, the /api/maple/sleep
 * route, the app's state, the MCP tools (the chat runs the same ones), the
 * handoff reminder and undo_last, with two made-up families kept apart.
 * Sends are caught in-process; nothing leaves the machine.
 */
import { NextRequest } from "next/server";
import webpush from "web-push";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GET as SLEEP_GET, POST as SLEEP_POST } from "../../src/app/api/maple/sleep/route";
import { GET as STATE_GET } from "../../src/app/api/maple/state/route";
import { sealSession, SESSION_COOKIE } from "../../src/lib/maple/auth";
import { registrations } from "../../src/lib/maple/chat/tools";
import { familyScope } from "../../src/lib/maple/family";
import { dailyStats } from "../../src/lib/maple/insights";
import { FAMILY_ONE_COPY, logState, type Extra } from "../../src/lib/maple/mcp-tools";
import { notifyHandoffNow } from "../../src/lib/maple/notify";
import { runPushTick } from "../../src/lib/maple/push";
import { askState, chooseSleepLink, nextHandoff } from "../../src/lib/maple/sleep/engine";
import { windowAt } from "../../src/lib/maple/sleep/handoff";
import { activeRosters } from "../../src/lib/maple/sleep/roster-read";
import { askHandoff, deleteTry, endShift, finishTry, getTry, handOff, listShifts, logTry, openShift, startShift, startTry, undoFinish, updateTry, undoHandOff } from "../../src/lib/maple/sleep/store";
import type { BassinetTry, HoldingShift, SleepState } from "../../src/lib/maple/sleep/types";
import { createEntryOnce, getEntry, listEntries, startTimer, stopTimer } from "../../src/lib/maple/store";
import { addDays, dayKey, localParts } from "../../src/lib/maple/time";
import type { Entry, Role } from "../../src/lib/maple/types";
import { done, eq, freshDb, ok, seedFamilies, sql, test, type FamilySeed } from "./harness";

process.env.MCP_SECRET = "made-up-sleep-check-secret";
process.env.MAPLE_SESSION_SECRET = "made-up-sleep-session-secret";
delete process.env.QSTASH_TOKEN;
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;

const MIN = 60_000;
const HOUR = 60 * MIN;

// ── the push service, caught ──────────────────────────────────────────────

type Sent = { endpoint: string; tag: string; title: string; body: string; kind: string };
const sent: Sent[] = [];
(webpush as unknown as { sendNotification: unknown }).sendNotification = async (sub: { endpoint: string }, payload: string) => {
  const p = JSON.parse(payload) as { tag: string; title: string; body: string; data: { kind: string } };
  sent.push({ endpoint: sub.endpoint, tag: p.tag, title: p.title, body: p.body, kind: p.data.kind });
  return { statusCode: 201, body: "", headers: {} };
};

// ── callers ──────────────────────────────────────────────────────────────

const { all } = registrations(FAMILY_ONE_COPY);
const handler = (name: string) => {
  const r = all.find((x) => x.name === name);
  if (!r) throw new Error(`no tool ${name}`);
  return r.handler;
};

type Who = Exclude<Role, "photos">;
type Call = { text: string; isError: boolean; sc: Record<string, unknown> };

function extraFor(family: FamilySeed, role: Who): Extra {
  return {
    signal: new AbortController().signal,
    requestId: "sleep-check",
    authInfo: { token: "sleep-check", clientId: "sleep-check", scopes: ["maple"], extra: { sub: `maple:${family[role]}`, fam: family.familyId, via: "claude" } },
    sendNotification: async () => {},
    sendRequest: async () => {
      throw new Error("unsupported");
    },
  } as unknown as Extra;
}

async function call(name: string, args: Record<string, unknown>, family: FamilySeed, role: Who = "member"): Promise<Call> {
  const res: CallToolResult = await handler(name)(args, extraFor(family, role));
  return { text: res.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n"), isError: !!res.isError, sc: (res.structuredContent ?? {}) as Record<string, unknown> };
}

type Res = { status: number; json: Record<string, unknown> };

async function route(email: string, familyId: number, body?: Record<string, unknown>, query = ""): Promise<Res> {
  const request = new NextRequest(`http://localhost:3000/api/maple/sleep${query}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealSession(email, familyId))}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const res = await (body ? SLEEP_POST(request) : SLEEP_GET(request));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function state(email: string, familyId: number): Promise<Record<string, unknown>> {
  const request = new NextRequest("http://localhost:3000/api/maple/state", {
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealSession(email, familyId))}` },
  });
  return (await (await STATE_GET(request)).json()) as Record<string, unknown>;
}

const result = (r: Res) => r.json.result as { try: BassinetTry; status: string; link?: string; sleep?: Entry | null; endedShift?: { id: number } | null; sleepDeleted?: Entry | null };
const sleepState = (r: Res) => r.json.sleep as SleepState;
const BANNED = /cry[- ]?it[- ]?out(?!:)|sleep[- ]?train|\b(safe|okay|fine) to (sleep|nap|doze) (on|with)|\bco-?sleep|\bbed[- ]?shar(e|ing) is|\b\d+(\.\d+)?\s?(mg|ml)\b/i;

/** Clear a family's tries, shifts and sleeps between cases, so each starts from nothing. */
async function clean(f: FamilySeed) {
  await sql(`DELETE FROM maple_sleep_tries WHERE family_id = $1`, [f.familyId]);
  await sql(`DELETE FROM maple_sleep_shifts WHERE family_id = $1`, [f.familyId]);
  await sql(`DELETE FROM maple_entries WHERE family_id = $1 AND kind = 'sleep'`, [f.familyId]);
}

const sleeps = (f: FamilySeed) => sql(`SELECT id, active, ended_at, deleted_at, data FROM maple_entries WHERE family_id = $1 AND kind = 'sleep' ORDER BY id`, [f.familyId]);

/**
 * The statements the code sends to the in-memory Postgres until stop(), exactly as sent, so a check can EXPLAIN the
 * store's own SQL. Imported the way src/lib/db.ts imports it, so it's the same PGlite.
 */
async function captureQueries(): Promise<{ stop: () => { sql: string; params: unknown[] }[] }> {
  const { PGlite } = await import("@electric-sql/pglite");
  const proto = PGlite.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const own = Object.prototype.hasOwnProperty.call(proto, "query");
  const real = proto.query;
  const out: { sql: string; params: unknown[] }[] = [];
  proto.query = function (this: unknown, ...args: unknown[]) {
    out.push({ sql: String(args[0]), params: (args[1] as unknown[] | undefined) ?? [] });
    return real.apply(this, args);
  };
  return {
    stop: () => {
      if (own) proto.query = real;
      else delete (proto as { query?: unknown }).query;
      return out;
    },
  };
}

async function main() {
  await freshDb();
  const { alpha, beta } = await seedFamilies();
  const photos = "dana.photos@example.com";
  await sql(`INSERT INTO maple_members (family_id, email, role, display_name, added_by, accepted_at) VALUES (1, $1, 'photos', 'Photo Guest', 'self', NOW())`, [photos]);

  // ── the plan ───────────────────────────────────────────────────────────

  await test("plan: set up with stage 1's defaults (one try a day at the first long night stretch, the morning nap as backup), one per baby", async () => {
    const r = await route(alpha.member, 1, { action: "plan.create" });
    eq(r.status, 200, JSON.stringify(r.json));
    const p = (r.json.plan as Record<string, unknown>);
    eq([p.stage, p.tries_per_day, p.try_times, p.fallback, p.sleeps_now, p.revision], [1, 1, ["first_night_stretch"], "first_morning_nap", "arms", 1], "defaults");
    const again = await route(alpha.owner, 1, { action: "plan.create" });
    eq([again.json.created, (again.json.plan as { revision: number }).revision], [false, 1], "a second setup gets the same plan");
    eq((await sql(`SELECT COUNT(*)::int AS n FROM maple_sleep_plans WHERE family_id = 1`))[0].n, 1, "one row");
  });

  await test("plan: viewers read it but can't change it; photos-only guests can't read it", async () => {
    eq((await route(alpha.viewer, 1, { action: "plan.update", revision: 1, patch: { stage: 2 } })).status, 403, "viewer write");
    const read = await route(alpha.viewer, 1);
    eq([read.status, sleepState(read).plan?.stage], [200, 1], "viewer read");
    eq((await route(photos, 1)).status, 403, "photos-only read");
    const mcp = await call("set_sleep_plan", { revision: 1, stage: 2 }, alpha, "viewer");
    ok(mcp.isError && /viewer/i.test(mcp.text), mcp.text);
  });

  await test("plan: an edit names its revision (a stale one is 409 with the plan as it is), and a new stage brings its defaults", async () => {
    const r = await route(alpha.member, 1, { action: "plan.update", revision: 1, patch: { stage: 2 } });
    const p = r.json.plan as Record<string, unknown>;
    eq([p.stage, p.tries_per_day, p.try_times, p.fallback, p.revision], [2, 2, ["first_night_stretch", "first_morning_nap"], null, 2], "stage 2");
    const stale = await route(alpha.owner, 1, { action: "plan.update", revision: 1, patch: { goal: "made-up goal" } });
    eq([stale.status, stale.json.code, (stale.json.current as { revision: number }).revision], [409, "changed", 2], "stale");
    const bad = await route(alpha.owner, 1, { action: "plan.update", revision: 2, patch: { try_times: ["bedtime"] } });
    eq(bad.status, 400, "a try time that isn't one");
    await route(alpha.owner, 1, { action: "plan.update", revision: 2, patch: { stage: 1 } });
  });

  await test("plan: its goal never leaves her to cry or has her asleep on or with an adult, or in a bed, couch, recliner, armchair or swing, through the route and set_sleep_plan", async () => {
    // Each refusal says what Maple won't plan and what to try instead (goals.ts unsafeWords).
    const said: Record<string, string> = {
      "Co-sleeping safely": `The goal: Maple won't plan June sleeping in an adult bed; if this is a step away from it, try "Move her from our bed to the bassinet".`,
      "Let her cry it out at bedtime": `The goal: Maple won't plan leaving June to cry; if this is about settling her, try "Soothe her, then try the bassinet once more".`,
      "June naps in the swing after lunch": `The goal: Maple won't plan sleep in a swing; try "If she falls asleep in the swing, move her to the bassinet".`,
    };
    const rev = Number((await sql(`SELECT revision FROM maple_sleep_plans WHERE family_id = 1`))[0].revision);
    for (const [goal, words] of Object.entries(said)) {
      const r = await route(alpha.owner, 1, { action: "plan.update", revision: rev, patch: { goal } });
      eq([r.status, r.json.error], [400, words], `route: "${goal}"`);
      const t = await call("set_sleep_plan", { revision: rev, goal }, alpha);
      ok(t.isError && t.text.startsWith(words) && /Nothing was saved/.test(t.text), t.text);
    }
    eq(Number((await sql(`SELECT revision FROM maple_sleep_plans WHERE family_id = 1`))[0].revision), rev, "nothing saved");
    const okGoal = await route(alpha.owner, 1, { action: "plan.update", revision: rev, patch: { goal: "Sleeping in her bassinet beside our bed" } });
    eq([okGoal.status, (okGoal.json.plan as { goal: string }).goal], [200, "Sleeping in her bassinet beside our bed"], "the bassinet beside their bed saves");
    await route(alpha.owner, 1, { action: "plan.update", revision: rev + 1, patch: { goal: null } });
  });

  await test("families: another family's plan, tries and shifts read as missing", async () => {
    eq(sleepState(await route(beta.member, 2)).plan, null, "beta has no plan");
    await clean(alpha);
    const t = result(await route(alpha.member, 1, { action: "try.start", client_id: "alpha-try-families-1" })).try;
    const r = await route(beta.member, 2, { action: "try.finish", id: t.id, outcome: "woke_calm" });
    eq(r.status, 404, "beta can't finish alpha's try");
    const fix = await call("bassinet_try", { action: "fix", id: `t${t.id}`, note: "made-up" }, beta);
    const none = await call("bassinet_try", { action: "fix", id: "t999999", note: "made-up" }, beta);
    eq(fix.text.replace(String(t.id), "N"), none.text.replace("999999", "N"), "the same words as an id nobody has");
    eq(sleepState(await route(beta.owner, 2)).tries, [], "nothing of alpha's in beta's state");
    eq((await getTry(2, t.id)), null, "the store too");
  });

  // ── tries and the sleep they sit on ────────────────────────────────────

  await test("link: a try laid down during a running sleep timer sits on it; no second sleep", async () => {
    await clean(alpha);
    const { entry: sleep } = await startTimer(1, { babyId: alpha.babyId, kind: "sleep", at: new Date(Date.now() - 30 * MIN), createdBy: alpha.owner, source: "web" });
    const r = await route(alpha.member, 1, { action: "try.start", client_id: "alpha-try-link-1", tags: ["fed", "swaddled"] });
    const w = result(r);
    eq([w.status, w.link, w.try.sleep_entry_id, w.try.made_sleep, w.try.tags], ["created", "running", sleep.id, false, ["fed", "swaddled"]], "linked");
    eq((await sleeps(alpha)).length, 1, "one sleep");
    eq((r.json.entries as Entry[]).map((e) => e.id), [sleep.id], "the sleep comes back with the answer");
  });

  await test("finish: a crying wake ends the sleep timer then, and the day's sleep counts it once", async () => {
    const running = sleepState(await route(alpha.member, 1)).tries.find((t) => !t.ended_at)!;
    const r = await route(alpha.member, 1, { action: "try.finish", id: running.id, outcome: "woke_crying", expect_updated_at: running.updated_at });
    eq(r.status, 200, JSON.stringify(r.json));
    const w = result(r);
    const s = (await getEntry(1, w.try.sleep_entry_id!))!;
    eq([s.active, Math.abs(Date.parse(s.ended_at!) - Date.parse(w.try.ended_at!)) <= 1500], [false, true], "stopped at the try's end");
    const all = await listEntries(1, { babyId: alpha.babyId, from: new Date(Date.now() - 3 * HOUR), includeActive: true });
    const today = dayKey(new Date(), alpha.tz);
    const stats = dailyStats(all, addDays(today, -1), today, new Date(), alpha.tz);
    const total = stats.reduce((n, d) => n + d.sleepSec, 0);
    eq(Math.round(total / 60), Math.round((Date.parse(s.ended_at!) - Date.parse(s.started_at)) / MIN), "sleep is the sleep entry's, not the try's on top");
    const again = await route(alpha.owner, 1, { action: "try.finish", id: running.id, outcome: "stayed_asleep" });
    eq(result(again).status, "already_finished", "a second finish changes nothing");
  });

  await test("start with no sleep logged: one write makes a running bassinet sleep; two phones at once make one try", async () => {
    await clean(alpha);
    const [a, b] = await Promise.all([
      route(alpha.member, 1, { action: "try.start", client_id: "alpha-try-race-a" }),
      route(alpha.owner, 1, { action: "try.start", client_id: "alpha-try-race-b" }),
    ]);
    const ids = [result(a).try.id, result(b).try.id];
    eq(ids[0], ids[1], "the same try");
    eq([result(a).status, result(b).status].sort(), ["created", "running"], "one made it, the other joined it");
    const ss = await sleeps(alpha);
    eq([ss.length, ss[0].active, (ss[0].data as { place?: string }).place], [1, true, "bassinet"], "one running bassinet sleep");
    const t = (await getTry(1, ids[0]))!;
    eq([t.made_sleep, t.sleep_entry_id], [true, Number(ss[0].id)], "made it");
    const retry = await route(alpha.member, 1, { action: "try.start", client_id: "alpha-try-race-a" });
    eq([result(retry).status, result(retry).try.id], ["deduped", ids[0]], "a retried request gets its first save");
  });

  await test("picked up still asleep: the try ends, the sleep runs on in arms; deleting the try keeps her sleep", async () => {
    const t = sleepState(await route(alpha.member, 1)).tries.find((x) => !x.ended_at)!;
    const w = result(await route(alpha.member, 1, { action: "try.finish", id: t.id, outcome: "picked_up" }));
    const s = (await getEntry(1, w.try.sleep_entry_id!))!;
    eq([s.active, (s.data as { place?: string }).place], [true, "arms"], "still asleep, in arms");
    const d = result(await route(alpha.member, 1, { action: "try.delete", id: t.id }));
    eq(d.sleepDeleted ?? null, null, "her ongoing sleep stays");
    ok(await getEntry(1, s.id), "still there");
  });

  await test("undo a start: deleting a just-started try removes the sleep it made, and restore brings both back", async () => {
    await clean(alpha);
    const w = result(await route(alpha.member, 1, { action: "try.start", client_id: "alpha-try-undo-1" }));
    const d = result(await route(alpha.member, 1, { action: "try.delete", id: w.try.id, expect_updated_at: w.try.updated_at }));
    eq(d.sleepDeleted?.id, w.try.sleep_entry_id, "the sleep it made went too");
    eq(await getEntry(1, w.try.sleep_entry_id!), null, "gone from the log");
    const back = await route(alpha.member, 1, { action: "try.restore", id: w.try.id, sleep_id: w.try.sleep_entry_id });
    eq(back.status, 200, JSON.stringify(back.json));
    eq([(await getTry(1, w.try.id))?.ended_at, (await getEntry(1, w.try.sleep_entry_id!))?.active], [null, true], "both back, running");
  });

  await test("undo a finish: the try runs again and the sleep timer it stopped comes back", async () => {
    const t = sleepState(await route(alpha.member, 1)).tries.find((x) => !x.ended_at)!;
    const f = await route(alpha.member, 1, { action: "try.finish", id: t.id, outcome: "woke_calm" });
    const after = result(f);
    const s = (f.json.entries as Entry[])[0];
    eq(s.active, false, "stopped");
    const u = await route(alpha.member, 1, { action: "try.undo_finish", id: t.id, expect_updated_at: after.try.updated_at, sleep: { id: s.id, expect_updated_at: s.updated_at, was_active: true } });
    eq(u.status, 200, JSON.stringify(u.json));
    eq([(await getTry(1, t.id))?.outcome, (await getEntry(1, s.id))?.active], [null, true], "running again, both");
  });

  await test("corrections: moving a try's start moves the sleep it made; a stale edit is 409 and saves nothing", async () => {
    const t = sleepState(await route(alpha.member, 1)).tries.find((x) => !x.ended_at)!;
    const to = new Date(Date.parse(t.started_at) - 5 * MIN).toISOString();
    const r = await route(alpha.member, 1, { action: "try.update", id: t.id, started_at: to, expect_updated_at: t.updated_at });
    eq(r.status, 200, JSON.stringify(r.json));
    const s = (await getEntry(1, t.sleep_entry_id!))!;
    eq(Math.abs(Date.parse(s.started_at) - Date.parse(to)) <= 1500, true, "the sleep's start followed");
    const stale = await route(alpha.owner, 1, { action: "try.update", id: t.id, note: "made-up", expect_updated_at: t.updated_at });
    eq([stale.status, stale.json.code], [409, "changed"], "stale");
    eq((await getTry(1, t.id))?.note, null, "nothing saved");
  });

  await test("a later try on a held sleep: correcting the transfer time leaves when she fell asleep alone", async () => {
    await clean(alpha);
    const { entry: sleep } = await startTimer(1, { babyId: alpha.babyId, kind: "sleep", at: new Date(Date.now() - 40 * MIN), createdBy: alpha.owner, source: "web" });
    const w = await startTry(1, { babyId: alpha.babyId, at: new Date(Date.now() - 10 * MIN), putDownBy: alpha.member, tags: [], note: null, by: alpha.member, source: "web" });
    const u = await updateTry(1, w.try.id, { started_at: new Date(Date.now() - 12 * MIN) }, { by: alpha.member, expectUpdatedAt: w.try.updated_at });
    eq(u.sleepMoved, false, "nothing to move");
    eq((await getEntry(1, sleep.id))?.started_at, sleep.started_at, "fell asleep when she did");
  });

  await test("logged tries: with nothing logged it adds a finished bassinet sleep; inside a logged sleep it links and changes nothing", async () => {
    await clean(alpha);
    const t0 = new Date(Date.now() - 5 * HOUR);
    const w = await logTry(1, { babyId: alpha.babyId, start: t0, end: new Date(t0.getTime() + 50 * MIN), outcome: "stayed_asleep", putDownBy: alpha.member, tags: [], note: null, by: alpha.member, source: "web" });
    const made = (await getEntry(1, w.try.sleep_entry_id!))!;
    eq([w.link, made.active, (made.data as { place?: string }).place, made.ended_at], ["create", false, "bassinet", w.try.ended_at], "made");
    const [held] = await sql(
      `INSERT INTO maple_entries (family_id, baby_id, kind, started_at, ended_at, data, created_by) VALUES (1, $1, 'sleep', $2, $3, '{"place":"arms"}', $4) RETURNING *`,
      [alpha.babyId, new Date(Date.now() - 3 * HOUR).toISOString(), new Date(Date.now() - 1 * HOUR).toISOString(), alpha.owner]
    );
    const inside = await logTry(1, { babyId: alpha.babyId, start: new Date(Date.now() - 2 * HOUR), end: new Date(Date.now() - 70 * MIN), outcome: "woke_calm", putDownBy: alpha.member, tags: [], note: null, by: alpha.member, source: "web" });
    eq([inside.link, inside.try.sleep_entry_id], ["overlap", Number(held.id)], "linked");
    const after = (await getEntry(1, Number(held.id)))!;
    eq([after.ended_at, (after.data as { place?: string }).place], [new Date(held.ended_at as string).toISOString(), "arms"], "unchanged");
    eq((await sleeps(alpha)).length, 2, "no sleep added");
  });

  await test("duplicates: a client_ref retry returns the first save; an overlapping try is possible_duplicate until allowed", async () => {
    await clean(alpha);
    const base = { action: "log", minutes_ago: 240, duration_minutes: 40, outcome: "stayed_asleep" };
    const a = await call("bassinet_try", { ...base, client_ref: "made-up-ref-1" }, alpha);
    ok(!a.isError && a.sc.created === true, a.text);
    const b = await call("bassinet_try", { ...base, client_ref: "made-up-ref-1" }, alpha);
    eq(b.sc.deduped, true, b.text);
    const c = await call("bassinet_try", { ...base, minutes_ago: 230, duration_minutes: 20, outcome: "woke_calm" }, alpha, "owner");
    ok(c.sc.created === false && c.sc.possible_duplicate && /allow_duplicate/.test(c.text), c.text);
    const d = await call("bassinet_try", { ...base, minutes_ago: 230, duration_minutes: 20, outcome: "woke_calm", allow_duplicate: true }, alpha, "owner");
    eq(d.sc.created, true, d.text);
    eq((await sql(`SELECT COUNT(*)::int AS n FROM maple_sleep_tries WHERE family_id = 1 AND deleted_at IS NULL`))[0].n, 2, "two saved");
  });

  await test("link: a put-down dated inside a sleep that already ended (try.start's at, the tool's minutes_ago, another phone's Woke up landing first) makes its own bassinet sleep, and How did it go? ends it now", async () => {
    await clean(alpha);
    // A sleep logged as ending 10 minutes ago, then a put-down dated 20 minutes ago.
    const loggedSleep = async () =>
      (await createEntryOnce(1, { babyId: alpha.babyId, kind: "sleep", startedAt: new Date(Date.now() - 60 * MIN), endedAt: new Date(Date.now() - 10 * MIN), data: { place: "arms" }, createdBy: alpha.owner, source: "web" })).entry;
    const logged = await loggedSleep();
    const r = await route(alpha.member, 1, { action: "try.start", at: new Date(Date.now() - 20 * MIN).toISOString(), client_id: "alpha-try-ended-sleep-1" });
    const w = result(r);
    const made = (await getEntry(1, w.try.sleep_entry_id!))!;
    eq([w.link, w.try.made_sleep, made.id === logged.id, made.active, (made.data as { place?: string }).place], ["create", true, false, true, "bassinet"], "its own running bassinet sleep");
    const f = result(await route(alpha.member, 1, { action: "try.finish", id: w.try.id, outcome: "stayed_asleep", expect_updated_at: w.try.updated_at }));
    ok(Math.abs(Date.parse(f.try.ended_at!) - Date.now()) < MIN, `she stayed asleep until it was finished, now: ${f.try.ended_at}`);
    const after = (await getEntry(1, w.try.sleep_entry_id!))!;
    eq([after.active, Math.abs(Date.parse(after.ended_at!) - Date.parse(f.try.ended_at!)) <= 1500], [false, true], "its sleep stopped with it");
    eq((await getEntry(1, logged.id))?.ended_at, logged.ended_at, "the logged sleep stays as it was");
    // The tool, as Claude and the chat call it.
    await clean(alpha);
    await loggedSleep();
    const s = await call("bassinet_try", { action: "start", minutes_ago: 20 }, alpha);
    ok(!s.isError && (s.sc.sleep_entry as { linked?: string } | undefined)?.linked === "create", s.text);
    const fin = await call("bassinet_try", { action: "finish", outcome: "stayed_asleep" }, alpha);
    ok(!fin.isError && !/after 10 min down/.test(fin.text), fin.text);
    // Another phone's Woke up lands first; this phone's put-down, tapped a moment before it, comes after.
    await clean(alpha);
    const { entry: arms } = await startTimer(1, { babyId: alpha.babyId, kind: "sleep", at: new Date(Date.now() - 30 * MIN), createdBy: alpha.owner, source: "web" });
    const woke = await stopTimer(1, arms.id, undefined, alpha.owner);
    const late = await startTry(1, { babyId: alpha.babyId, at: new Date(Date.parse(woke.ended_at!) - 2000), putDownBy: alpha.member, tags: [], note: null, by: alpha.member, source: "web" });
    eq([late.link, late.try.sleep_entry_id === arms.id, late.try.made_sleep], ["create", false, true], "never the sleep that ended");
    // The rule itself: a try still running sits only on the sleep timer running now.
    const ended = { ...woke, started_at: new Date(Date.now() - HOUR).toISOString() } as Entry;
    eq(chooseSleepLink(Date.now() - 20 * MIN, null, [ended], Date.now()).kind, "create", "running try, ended sleep");
    eq(chooseSleepLink(Date.now() - 20 * MIN, Date.now() - 5 * MIN, [ended], Date.now()).kind, "overlap", "a try that already happened still sits on the sleep it overlaps");
  });

  await test("undo a finish puts back exactly what was there: the tags, note and who put her down that How did it go? replaced (the route, the tool's reopen); a try changed since keeps the newer details", async () => {
    await clean(alpha);
    const w = await startTry(1, { babyId: alpha.babyId, putDownBy: alpha.owner, tags: ["fed"], note: null, by: alpha.owner, source: "web", clientId: "alpha-try-undo-details-1" });
    // How did it go? with Add details: other tags, a note and who put her down.
    const f = await finishTry(1, w.try.id, { outcome: "woke_calm", tags: ["swaddled", "white_noise"], note: "Made-up note", putDownBy: alpha.member, by: alpha.owner, expectUpdatedAt: w.try.updated_at });
    const s = f.sleep!;
    const u = await route(alpha.owner, 1, { action: "try.undo_finish", id: w.try.id, expect_updated_at: f.try.updated_at, sleep: { id: s.id, expect_updated_at: s.updated_at, was_active: true } });
    eq(u.status, 200, JSON.stringify(u.json).slice(0, 300));
    const back = (await getTry(1, w.try.id))!;
    eq([back.ended_at, back.outcome, back.tags, back.note, back.put_down_by], [null, null, ["fed"], null, alpha.owner], "as before the finish");
    eq((await getEntry(1, s.id))?.active, true, "and her sleep runs again");
    // The tool's finish with details, then its reopen (the finish's Undo there).
    const tf = await call("bassinet_try", { action: "finish", outcome: "woke_crying", tags: ["swaddled"], note: "Made-up tool note" }, alpha, "owner");
    ok(!tf.isError, tf.text);
    const re = await call("bassinet_try", { action: "reopen", id: `t${w.try.id}` }, alpha, "owner");
    ok(!re.isError, re.text);
    const again = (await getTry(1, w.try.id))!;
    eq([again.ended_at, again.tags, again.note], [null, ["fed"], null], "the tool's reopen too");
    // A fix after the finish is someone's newer change: reopening then keeps it.
    const f2 = await finishTry(1, w.try.id, { outcome: "woke_calm", note: "Made-up finish note", by: alpha.owner });
    const fixed = await updateTry(1, w.try.id, { note: "Made-up fix" }, { by: alpha.member, expectUpdatedAt: f2.try.updated_at });
    await undoFinish(1, w.try.id, { expectUpdatedAt: fixed.try.updated_at, by: alpha.owner });
    eq([(await getTry(1, w.try.id))?.ended_at, (await getTry(1, w.try.id))?.note], [null, "Made-up fix"], "the fix since stays");
    // Rollback: an additive, nullable column that migrates twice and never reaches the app's state.
    const cols = await sql(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'maple_sleep_tries' AND column_name = 'finish_before'`);
    eq(cols.map((c) => [c.data_type, c.is_nullable]), [["jsonb", "YES"]], "nullable JSONB");
    const { migrateSleep } = await import("../../src/lib/maple/sleep/schema");
    await migrateSleep();
    await migrateSleep();
    await finishTry(1, w.try.id, { outcome: "woke_calm", by: alpha.owner });
    ok(sleepState(await route(alpha.member, 1)).tries.every((t) => !("finish_before" in t)), "not in the state");
  });

  await test("a fix that ends a running try (try.update with an end and how it went, the tool's fix) ends her sleep as a finish does; picked up still asleep, the sleep it made runs on in arms; its Undo runs both again", async () => {
    await clean(alpha);
    const w = await startTry(1, { babyId: alpha.babyId, at: new Date(Date.now() - 10 * MIN), putDownBy: alpha.member, tags: [], note: null, by: alpha.member, source: "web", clientId: "alpha-try-fix-end-1" });
    eq([w.link, w.try.made_sleep], ["create", true], "a running bassinet sleep");
    const end = new Date(Date.now() - MIN).toISOString();
    const r = await route(alpha.member, 1, { action: "try.update", id: w.try.id, ended_at: end, outcome: "stayed_asleep", expect_updated_at: w.try.updated_at });
    eq(r.status, 200, JSON.stringify(r.json).slice(0, 300));
    const s = (await getEntry(1, w.try.sleep_entry_id!))!;
    eq([s.active, Math.abs(Date.parse(s.ended_at!) - Date.parse(end)) <= 1500], [false, true], "her sleep stopped when the try ended");
    eq((r.json.entries as Entry[]).map((e) => [e.id, e.active]), [[s.id, false]], "the answer carries the sleep it stopped");
    // The finish's Undo there (the tool's reopen): both run again.
    const re = await call("bassinet_try", { action: "reopen", id: `t${w.try.id}` }, alpha);
    ok(!re.isError, re.text);
    eq([(await getTry(1, w.try.id))?.ended_at, (await getEntry(1, s.id))?.active], [null, true], "both running again");
    // The tool's fix, picked up still asleep: the try ends, and the sleep it made runs on, in arms.
    const fix = await call("bassinet_try", { action: "fix", id: `t${w.try.id}`, outcome: "picked_up", ended_minutes_ago: 0 }, alpha);
    ok(!fix.isError, fix.text);
    const arms = (await getEntry(1, s.id))!;
    eq([(await getTry(1, w.try.id))?.outcome, arms.active, (arms.data as { place?: string }).place], ["picked_up", true, "arms"], "picked up still asleep");
    // A wake through the tool's fix stops it then.
    await sql(`UPDATE maple_sleep_tries SET ended_at = NULL, outcome = NULL WHERE id = $1`, [w.try.id]);
    const woke = await call("bassinet_try", { action: "fix", id: `t${w.try.id}`, outcome: "woke_calm", ended_minutes_ago: 0 }, alpha);
    ok(!woke.isError, woke.text);
    eq((await getEntry(1, s.id))?.active, false, "a wake ends it");
  });

  await test("finish: How did it go? with no time ends when her sleep stopped after the try began (Woke up on another phone); a sleep that had already ended when an older release laid the try on it is never the end", async () => {
    await clean(alpha);
    const w = await startTry(1, { babyId: alpha.babyId, at: new Date(Date.now() - 20 * MIN), putDownBy: alpha.member, tags: [], note: null, by: alpha.member, source: "web" });
    const woke = await stopTimer(1, w.try.sleep_entry_id!, new Date(Date.now() - 5 * MIN), alpha.owner);
    const f = await finishTry(1, w.try.id, { outcome: "woke_calm", by: alpha.member });
    eq(f.try.ended_at, woke.ended_at, "when she woke");
    // An older release laid this one on the sleep it overlapped, though that sleep had already ended.
    await clean(alpha);
    const { entry: logged } = await createEntryOnce(1, { babyId: alpha.babyId, kind: "sleep", startedAt: new Date(Date.now() - 60 * MIN), endedAt: new Date(Date.now() - 10 * MIN), data: { place: "arms" }, createdBy: alpha.owner, source: "web" });
    const [row] = await sql(`INSERT INTO maple_sleep_tries (family_id, baby_id, started_at, put_down_by, created_by, sleep_entry_id, made_sleep) VALUES (1, $1, $2, $3, $3, $4, FALSE) RETURNING id`, [
      alpha.babyId,
      new Date(Date.now() - 20 * MIN).toISOString(),
      alpha.member,
      logged.id,
    ]);
    const old = await finishTry(1, Number(row.id), { outcome: "stayed_asleep", by: alpha.member });
    ok(Math.abs(Date.parse(old.try.ended_at!) - Date.now()) < MIN, `now, not that sleep's end: ${old.try.ended_at}`);
    eq((await getEntry(1, logged.id))?.ended_at, logged.ended_at, "and that sleep stays as it was");
  });

  // ── holding shifts ─────────────────────────────────────────────────────

  await test("holding: start, a second start is the open one, hand off keeps the planned length, and a try ends the shift", async () => {
    await clean(alpha);
    const handoff = new Date(Date.now() + 2 * HOUR).toISOString();
    const s1 = await route(alpha.member, 1, { action: "shift.start", handoff_at: handoff, next_holder: alpha.owner, client_id: "alpha-shift-1" });
    const first = (s1.json.result as { shift: { id: number; holder: string; handoff_at: string; updated_at: string } }).shift;
    eq([first.holder, first.handoff_at], [alpha.member, handoff], "Blake holds her until the plan");
    eq(((await route(alpha.owner, 1, { action: "shift.start" })).json.result as { status: string }).status, "open", "one open shift");
    const h = await route(alpha.member, 1, { action: "shift.handoff", id: first.id, to: alpha.owner, expect_updated_at: first.updated_at });
    eq(h.status, 200, JSON.stringify(h.json));
    const next = (h.json.result as { shift: { holder: string; started_at: string; handoff_at: string; next_holder: string }; ended: { ended_how: string } });
    eq([next.shift.holder, next.shift.next_holder, next.ended.ended_how], [alpha.owner, alpha.member, "handoff"], "swapped");
    const span = Date.parse(next.shift.handoff_at) - Date.parse(next.shift.started_at);
    ok(Math.abs(span - 2 * HOUR) < 2 * MIN, `the next planned handoff is as far off as the first one was (${Math.round(span / MIN)} min)`);
    eq((await sql(`SELECT COUNT(*)::int AS n FROM maple_sleep_shifts WHERE family_id = 1 AND ended_at IS NULL AND deleted_at IS NULL`))[0].n, 1, "one open");
    const t = result(await route(alpha.owner, 1, { action: "try.start", client_id: "alpha-try-ends-shift" }));
    ok(t.endedShift, "the try ended the shift");
    eq(await openShift(1, alpha.babyId), null, "nobody holding her now");
  });

  await test("holding: undoing a handoff opens the first shift again and removes the second", async () => {
    await clean(alpha);
    const a = await startShift(1, { babyId: alpha.babyId, holder: alpha.member, handoffAt: new Date(Date.now() + HOUR), by: alpha.member, source: "web" });
    const h = await handOff(1, a.shift.id, { to: alpha.owner, by: alpha.member, source: "web" });
    await undoHandOff(1, { startedId: h.shift.id, startedUpdatedAt: h.shift.updated_at, endedId: a.shift.id, endedUpdatedAt: h.ended!.updated_at, by: alpha.member });
    const open = await openShift(1, alpha.babyId);
    eq([open?.id, open?.holder], [a.shift.id, alpha.member], "Blake's shift is open again");
  });

  await test("asks: Wake [partner] only asks (every phone sees it); nothing changes hands until the person asked has her; Undo takes an ask back", async () => {
    await clean(alpha);
    const turn = (await route(alpha.member, 1, { action: "shift.start", client_id: "alpha-ask-1" })).json.result as { shift: HoldingShift };
    const a = await route(alpha.member, 1, { action: "shift.ask", id: turn.shift.id, to: alpha.owner });
    eq(a.status, 200, JSON.stringify(a.json));
    const asked = a.json.result as { shift: HoldingShift; status: string };
    eq([asked.status, asked.shift.holder, asked.shift.asked_to, asked.shift.ended_at], ["asked", alpha.member, alpha.owner, null], "an ask, not a handoff");
    const seen = sleepState(await route(alpha.owner, 1)).shifts.find((x) => !x.ended_at)!;
    eq([seen.holder, seen.asked_to], [alpha.member, alpha.owner], "Avery's phone sees Blake holding her, Avery asked");
    eq(sleepState(await route(alpha.viewer, 1)).shifts.find((x) => !x.ended_at)?.asked_to, alpha.owner, "a view-only guest sees it too");
    const undo = await route(alpha.member, 1, { action: "shift.cancel_ask", id: turn.shift.id, expect_updated_at: asked.shift.updated_at });
    const unasked = (undo.json.result as { shift: HoldingShift }).shift;
    eq([undo.status, unasked.asked_to, unasked.ended_at], [200, null, null], "Undo: nobody asked, the turn goes on");
    await route(alpha.member, 1, { action: "shift.ask", id: turn.shift.id, to: alpha.owner });
    const took = await route(alpha.owner, 1, { action: "shift.accept", id: turn.shift.id });
    eq(took.status, 200, JSON.stringify(took.json));
    const r = took.json.result as { shift: HoldingShift; ended: HoldingShift };
    eq([r.shift.holder, r.shift.next_holder, r.shift.asked_to, r.ended.ended_how, r.ended.asked_to], [alpha.owner, alpha.member, null, "handoff", alpha.owner], "taken over; the turn handed over keeps its ask");
    const twice = await route(alpha.member, 1, { action: "shift.accept", id: turn.shift.id });
    eq([twice.status, twice.json.code], [409, "changed"], "a second I've got her changes nothing");
    const u = await route(alpha.owner, 1, { action: "shift.undo_handoff", started_id: r.shift.id, started_updated_at: r.shift.updated_at, ended_id: r.ended.id, ended_updated_at: r.ended.updated_at });
    eq(u.status, 200, JSON.stringify(u.json));
    const open = (await openShift(1, alpha.babyId))!;
    eq([open.id, open.holder, open.asked_to], [turn.shift.id, alpha.member, alpha.owner], "Undo: Blake's turn is open again, still asked");
    const has = await route(alpha.member, 1, { action: "shift.handoff", id: open.id, to: alpha.owner, expect_updated_at: open.updated_at });
    eq((has.json.result as { shift: HoldingShift }).shift.holder, alpha.owner, "the holder's Avery has her records it");
  });

  await test("asks: an app from before asks (shift.handoff with wake) only asks now; viewers can't ask or accept; another family's turn reads as missing", async () => {
    await clean(alpha);
    const t = (await route(alpha.member, 1, { action: "shift.start" })).json.result as { shift: HoldingShift };
    const w = await route(alpha.member, 1, { action: "shift.handoff", id: t.shift.id, to: alpha.owner, wake: true, expect_updated_at: t.shift.updated_at });
    const res = w.json.result as { shift: HoldingShift; status: string };
    eq([w.status, res.status, res.shift.holder, res.shift.asked_to], [200, "asked", alpha.member, alpha.owner], "asked, not handed over");
    eq((await route(alpha.viewer, 1, { action: "shift.ask", id: t.shift.id, to: alpha.owner })).status, 403, "viewer ask");
    eq((await route(alpha.viewer, 1, { action: "shift.accept", id: t.shift.id })).status, 403, "viewer accept");
    const theirs = await route(beta.member, 2, { action: "shift.accept", id: t.shift.id });
    const none = await route(beta.member, 2, { action: "shift.accept", id: 999999 });
    eq([theirs.status, String(theirs.json.error).replace(String(t.shift.id), "N")], [404, String(none.json.error).replace("999999", "N")], "the same words as an id nobody has");
    eq((await route(alpha.member, 1, { action: "shift.ask", id: t.shift.id, to: alpha.member })).status, 400, "the holder can't be asked to take over");
  });

  await test("asks: ten minutes on with nobody taking over, the tools give the holder the two safe choices again", async () => {
    await clean(alpha);
    const t = (await startShift(1, { babyId: alpha.babyId, holder: alpha.member, by: alpha.member, source: "web" })).shift;
    const a = await askHandoff(1, { babyId: alpha.babyId, id: t.id, to: alpha.owner, by: alpha.member, source: "web" });
    eq(askState(a.shift, new Date()).stale, false, "fresh");
    await sql(`UPDATE maple_sleep_shifts SET asked_at = NOW() - INTERVAL '11 minutes' WHERE id = $1`, [t.id]);
    const later = (await openShift(1, alpha.babyId))!;
    const st = askState(later, new Date());
    eq([st.asked, st.stale, st.minutes >= 10], [true, true, true], "stale after ten minutes");
    const s = await call("maple_status", {}, alpha);
    ok(/Nobody has taken over yet: the two safe choices are laying her on her back in the bassinet now/.test(s.text) && /waking Avery again/.test(s.text), s.text);
    ok(!/keep holding/i.test(s.text), "never keep holding");
    eq(((s.sc.sleep as { holding?: { nobody_took_over?: boolean } }).holding ?? {}).nobody_took_over, true, s.text);
  });

  await test("asleep in arms: a turn can start a sleep in arms that runs across a handoff; into the bassinet, the try sits on it; the try's wake ends it", async () => {
    await clean(alpha);
    const s = await route(alpha.member, 1, { action: "shift.start", asleep: true, client_id: "alpha-arms-1" });
    const w = s.json.result as { shift: HoldingShift; sleep: Entry; madeSleep: boolean };
    eq([w.madeSleep, w.sleep.active, (w.sleep.data as { place?: string }).place], [true, true, "arms"], "a running sleep in arms");
    eq((s.json.entries as Entry[]).map((e) => e.id), [w.sleep.id], "the sleep comes back with the answer");
    const again = await route(alpha.member, 1, { action: "shift.start", asleep: true, client_id: "alpha-arms-1" });
    eq((again.json.result as { status: string }).status, "deduped", "a retried start");
    eq((await sleeps(alpha)).filter((x) => x.deleted_at == null).length, 1, "one sleep");
    await route(alpha.member, 1, { action: "shift.ask", id: w.shift.id, to: alpha.owner });
    await route(alpha.owner, 1, { action: "shift.accept", id: w.shift.id });
    eq((await getEntry(1, w.sleep.id))?.active, true, "still asleep after the handoff");
    const t = result(await route(alpha.owner, 1, { action: "try.start", client_id: "alpha-arms-try" }));
    eq([t.link, t.try.sleep_entry_id, t.try.made_sleep], ["running", w.sleep.id, false], "the try sits on her sleep in arms (chooseSleepLink)");
    ok(t.endedShift, "into the bassinet ends the turn");
    await route(alpha.owner, 1, { action: "try.finish", id: t.try.id, outcome: "woke_calm" });
    const after = (await getEntry(1, w.sleep.id))!;
    eq([after.active, (after.data as { place?: string }).place], [false, "arms"], "woke: the sleep ended with the try, still the arms sleep");
    eq((await sleeps(alpha)).filter((x) => x.deleted_at == null).length, 1, "sleep counted once");
  });

  await test("asleep in arms: ending the turn awake stops it and Undo runs both again; undoing a start removes the sleep it made; a running sleep is left as it is", async () => {
    await clean(alpha);
    const w = (await route(alpha.member, 1, { action: "shift.start", asleep: true })).json.result as { shift: HoldingShift; sleep: Entry };
    const e = await route(alpha.member, 1, { action: "shift.end", id: w.shift.id, expect_updated_at: w.shift.updated_at });
    const ended = e.json.result as { shift: HoldingShift; sleep: Entry; sleepBefore: Entry };
    eq([ended.sleep?.id, ended.sleep?.active, ended.sleepBefore?.active], [w.sleep.id, false, true], "the sleep stopped with the turn");
    const back = await route(alpha.member, 1, { action: "shift.reopen", id: w.shift.id, expect_updated_at: ended.shift.updated_at, sleep: { id: ended.sleep.id, expect_updated_at: ended.sleep.updated_at } });
    eq(back.status, 200, JSON.stringify(back.json));
    eq([(await openShift(1, alpha.babyId))?.id, (await getEntry(1, w.sleep.id))?.active], [w.shift.id, true], "Undo: both running again");
    const open = (await openShift(1, alpha.babyId))!;
    const sl = (await getEntry(1, w.sleep.id))!;
    const d = await route(alpha.member, 1, { action: "shift.delete", id: open.id, expect_updated_at: open.updated_at, sleep: { id: sl.id, expect_updated_at: sl.updated_at } });
    eq([d.status, d.json.removed], [200, [sl.id]], JSON.stringify(d.json));
    eq(await getEntry(1, sl.id), null, "the sleep it made went too");
    const chip = await route(alpha.member, 1, { action: "shift.asleep", client_id: "alpha-arms-chip" });
    const made = chip.json.result as { sleep: Entry; made: boolean };
    eq([made.made, (made.sleep.data as { place?: string }).place], [true, "arms"], "the card's Asleep in arms");
    const undone = await route(alpha.member, 1, { action: "shift.asleep_undo", sleep: { id: made.sleep.id, expect_updated_at: made.sleep.updated_at } });
    eq(undone.json.removed, [made.sleep.id], "its Undo");
    const { entry: timer } = await startTimer(1, { babyId: alpha.babyId, kind: "sleep", at: new Date(Date.now() - 20 * MIN), createdBy: alpha.owner, source: "web" });
    const w2 = (await route(alpha.member, 1, { action: "shift.start", asleep: true })).json.result as { sleep: Entry; madeSleep: boolean };
    eq([w2.sleep.id, w2.madeSleep], [timer.id, false], "a sleep timer already running stays the one");
    eq((await route(alpha.viewer, 1, { action: "shift.asleep" })).status, 403, "viewers can't");
  });

  // ── the MCP tools ──────────────────────────────────────────────────────

  await test("MCP: a viewer gets the plan, never a write", async () => {
    const r = await call("sleep_plan", {}, alpha, "viewer");
    ok(!r.isError && /Sleep plan: stage 1/.test(r.text), r.text);
    for (const [name, args] of [["bassinet_try", { action: "start" }], ["holding", { action: "start" }], ["set_sleep_plan", { stage: 2, revision: 1 }]] as const) {
      const w = await call(name, args, alpha, "viewer");
      ok(w.isError && /viewer/i.test(w.text), `${name}: ${w.text}`);
    }
  });

  await test("MCP sleep_plan: her age from her birth date in her zone, the plan, and guidance for her age with no dose and no crying it out", async () => {
    const r = await call("sleep_plan", {}, alpha);
    ok(/June is \d+ (days|weeks?)/.test(r.text) && /by her birth date/.test(r.text), r.text);
    const age = r.sc.age as { days: number };
    const born = dayKey(new Date("2026-10-10T08:00:00Z"), alpha.tz);
    eq(age.days, Math.round((Date.parse(dayKey(new Date(), alpha.tz)) - Date.parse(born)) / (24 * HOUR)), "days by the family's calendar");
    const g = r.sc.guidance as { sections: { section: string; items: { body: string; source: string }[] }[] };
    ok(g.sections.some((s) => s.section === "Call the pediatrician") && g.sections.some((s) => s.section === "Emergency") && g.sections.some((s) => s.section === "Safe sleep"), JSON.stringify(g.sections.map((s) => s.section)));
    const text = JSON.stringify(g);
    ok(!BANNED.test(text), text.match(BANNED)?.[0] ?? "");
    ok(g.sections.every((s) => s.items.every((i) => i.source?.startsWith("https://"))), "every item has a source");
    const ro = await call("sleep_plan", {}, beta);
    ok(/Ro is/.test(ro.text) && /No sleep plan yet/.test(ro.text) && !/June|Avery|Blake/.test(ro.text), ro.text);
  });

  await test("MCP: start, finish and reopen a try; undo_last takes back the newest try and the sleep it made", async () => {
    await clean(alpha);
    const s = await call("bassinet_try", { action: "start", tags: ["white_noise"] }, alpha);
    ok(!s.isError && /^Saved bassinet try t\d+: June laid down at/.test(s.text) && /never|don't also|sleep in the log/i.test(s.text), s.text);
    ok(!/Saved #\d+:/.test(s.text), "never a log entry's receipt line");
    const f = await call("bassinet_try", { action: "finish", outcome: "woke_crying" }, alpha);
    ok(!f.isError && /woke crying/.test(f.text) && /sleep timer stopped then too/.test(f.text) && /soothe her/i.test(f.text), f.text);
    const id = (f.sc.try as { id: string }).id;
    const re = await call("bassinet_try", { action: "reopen", id }, alpha);
    ok(!re.isError && /running again/.test(re.text), re.text);
    // The last action was a change to that try, not a new one: undo_last explains instead of removing it.
    const u = await call("undo_last", {}, alpha);
    ok(u.isError && new RegExp(`change to bassinet try ${id}`).test(u.text), u.text);
    await clean(alpha);
    const fresh = await call("bassinet_try", { action: "start" }, alpha);
    const fid = (fresh.sc.try as { id: string }).id;
    const undo = await call("undo_last", {}, alpha);
    ok(!undo.isError && new RegExp(`Removed bassinet try ${fid}`).test(undo.text) && /the sleep it started/.test(undo.text), undo.text);
    eq((await sleeps(alpha)).filter((x) => x.deleted_at == null).length, 0, "the sleep it made went with it");
  });

  await test("MCP holding: start, ask (hand_off with sleepy is an ask too), accept, hand off, end; who's named comes from the family", async () => {
    await clean(alpha);
    const s = await call("holding", { action: "start", handoff_in_minutes: 120, next_holder: "Avery" }, alpha);
    ok(!s.isError && /Blake is holding June awake/.test(s.text), s.text);
    const asked = await call("holding", { action: "hand_off", to: "Avery", sleepy: true }, alpha);
    ok(!asked.isError && /^Asked Avery to take over/.test(asked.text) && /Nothing has changed hands: Blake is still holding June/.test(asked.text) && /Avery's phone gets a notice now if handoff reminders are on there/.test(asked.text) && /bassinet now/.test(asked.text), asked.text);
    eq([(await openShift(1, alpha.babyId))?.holder, (await openShift(1, alpha.babyId))?.asked_to], [alpha.member, alpha.owner], "still Blake's turn, Avery asked");
    const st = await call("maple_status", {}, alpha, "owner");
    ok(/Blake asked Avery to take over at/.test(st.text) && /until Avery has her/.test(st.text), st.text);
    const accepted = await call("holding", { action: "accept" }, alpha, "owner");
    ok(!accepted.isError && /^Avery has June now/.test(accepted.text) && /taking over from Blake/.test(accepted.text) && /maple_status/.test(accepted.text), accepted.text);
    const mine = await call("holding", { action: "accept" }, alpha, "owner");
    ok(mine.isError && /You're the one holding her/.test(mine.text), mine.text);
    const back = await call("holding", { action: "hand_off", to: "Blake" }, alpha, "owner");
    ok(!back.isError && /Blake is holding June now/.test(back.text), back.text);
    const nobody = await call("holding", { action: "ask", to: "Zed" }, alpha);
    ok(nobody.isError && /isn't someone in this family/.test(nobody.text), nobody.text);
    const e = await call("holding", { action: "end" }, alpha, "owner");
    ok(!e.isError && /Ended Blake's holding shift/.test(e.text), e.text);
    ok(![s, asked, accepted, back, e].some((r) => /keep holding|safe to (sleep|doze)/i.test(r.text)), "nothing suggests staying put or dozing");
  });

  await test("MCP holding: undo_last after an ask takes back the ask, never the turn; asleep in arms starts and stops with the turn", async () => {
    await clean(alpha);
    const s = await call("holding", { action: "start", asleep: true }, alpha);
    ok(!s.isError && /sleep in arms is logged from/.test(s.text) && /Don't also log this sleep/.test(s.text), s.text);
    const turn = (await openShift(1, alpha.babyId))!;
    await call("holding", { action: "ask", to: "Avery" }, alpha);
    const undo = await call("undo_last", {}, alpha);
    ok(!undo.isError && /^Took back the ask/.test(undo.text), undo.text);
    const open = (await openShift(1, alpha.babyId))!;
    eq([open.id, open.asked_to, open.ended_at], [turn.id, null, null], "the turn goes on, nobody asked");
    const arms = (await sleeps(alpha)).find((x) => x.deleted_at == null)!;
    eq([arms.active, (arms.data as { place?: string }).place], [true, "arms"], "her sleep in arms runs");
    const e = await call("holding", { action: "end" }, alpha);
    ok(!e.isError && new RegExp(`sleep in arms \\(#${arms.id}\\) stopped then too`).test(e.text), e.text);
    eq((await getEntry(1, Number(arms.id)))?.active, false, "ended awake: the sleep stopped");
  });

  await test("next handoff vs the roster: a handoff never plans the next one inside the next holder's protected window (the route, the tool, the store), says why, and an explicit time stands", async () => {
    await clean(alpha);
    await sql(`DELETE FROM maple_sleep_goals WHERE family_id = 1`);
    // Blake's protected window from an hour to three hours from now, every night, on an active goal (as Theo's 1:30–6:30 AM).
    const hhmm = (t: number) => {
      const p = localParts(t, alpha.tz);
      return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    };
    const winEnd = Math.floor((Date.now() + 180 * MIN) / MIN) * MIN;
    const roster = [{ id: "w1", member: alpha.member, from: hhmm(Date.now() + 60 * MIN), to: hhmm(winEnd), nights: [0, 1, 2, 3, 4, 5, 6] }];
    await sql(
      `INSERT INTO maple_sleep_goals (family_id, baby_id, title, status, roster, item_seq, created_by, created_at, updated_at) VALUES (1, $1, 'Made-up goal', 'active', $2::jsonb, 1, $3, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')`,
      [alpha.babyId, JSON.stringify(roster), alpha.member]
    );
    // Blake's two-hour turn; Avery takes over now (the app's I've got her): the default, two hours on, is inside Blake's window.
    const t = (await route(alpha.member, 1, { action: "shift.start", handoff_at: new Date(Date.now() + 2 * HOUR).toISOString() })).json.result as { shift: HoldingShift };
    const acc = await route(alpha.owner, 1, { action: "shift.accept", id: t.shift.id });
    const w = acc.json.result as { shift: HoldingShift; handoffWhy: { member: string; planned_at: string; default_at: string; ends_at: string } };
    eq([w.shift.next_holder, Date.parse(w.shift.handoff_at!), w.handoffWhy.member, w.handoffWhy.planned_at], [alpha.member, winEnd, alpha.member, new Date(winEnd).toISOString()], "at the window's end, with why");
    ok(Math.abs(Date.parse(w.handoffWhy.default_at) - (Date.now() + 2 * HOUR)) < 2 * MIN, "the default it moved from");
    // The tool: accept says why; hand_off back and forth the same.
    await route(alpha.owner, 1, { action: "shift.undo_handoff", started_id: w.shift.id, started_updated_at: w.shift.updated_at, ended_id: t.shift.id, ended_updated_at: ((acc.json.result as { ended: HoldingShift }).ended).updated_at });
    const viaTool = await call("holding", { action: "accept" }, alpha, "owner");
    ok(!viaTool.isError && /the next handoff is planned for .+, the end of Blake's protected sleep \(.+ on the roster\), not .+, so Blake isn't woken inside it\./.test(viaTool.text), viaTool.text);
    eq(Date.parse((await openShift(1, alpha.babyId))!.handoff_at!), winEnd, "the tool's accept too");
    // Without a window for the next holder (or with a paused goal), the default stands.
    const back = await call("holding", { action: "hand_off", to: "Blake" }, alpha, "owner");
    ok(!back.isError && !/protected sleep/.test(back.text), back.text);
    await sql(`UPDATE maple_sleep_goals SET status = 'paused' WHERE family_id = 1`);
    const blakes = (await openShift(1, alpha.babyId))!;
    const paused = await handOff(1, blakes.id, { to: alpha.owner, by: alpha.owner, source: "web" });
    eq([paused.handoffWhy ?? null, Math.abs(Date.parse(paused.shift.handoff_at!) - nextHandoff(blakes, Date.now())) < 2 * MIN], [null, true], "a paused goal's roster doesn't move it");
    await sql(`UPDATE maple_sleep_goals SET status = 'active' WHERE family_id = 1`);
    // An explicit time someone picked (the app's chips, handoff_in_minutes) is theirs, even inside the window.
    const open = (await openShift(1, alpha.babyId))!;
    const pick = await route(alpha.owner, 1, { action: "shift.handoff", id: open.id, to: alpha.member, handoff_at: new Date(Date.now() + 90 * MIN).toISOString(), expect_updated_at: open.updated_at });
    const picked = pick.json.result as { shift: HoldingShift; handoffWhy?: unknown };
    eq([Math.abs(Date.parse(picked.shift.handoff_at!) - (Date.now() + 90 * MIN)) < MIN, picked.handoffWhy ?? null], [true, null], "the picked time stands");
    // Families apart: beta's handoffs never read alpha's roster.
    await clean(beta);
    const bt = (await route(beta.member, 2, { action: "shift.start", handoff_at: new Date(Date.now() + 2 * HOUR).toISOString() })).json.result as { shift: HoldingShift };
    const bacc = (await route(beta.owner, 2, { action: "shift.accept", id: bt.shift.id })).json.result as { shift: HoldingShift; handoffWhy?: unknown };
    eq(bacc.handoffWhy ?? null, null, "beta has no roster");
    await sql(`DELETE FROM maple_sleep_goals WHERE family_id = 1`);
    await clean(beta);
  });

  await test("next handoff vs a Back to work roster that hasn't started: before its roster_from night the window protects no one yet, so the default stands (I've got her, the holder's handoff, the tool), never moved or left unplanned; once on, it moves", async () => {
    await clean(alpha);
    await sql(`DELETE FROM maple_sleep_goals WHERE family_id = 1`);
    const hhmm = (t: number) => {
      const p = localParts(t, alpha.tz);
      return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    };
    const today = dayKey(Date.now(), alpha.tz);
    // Blake's 12-hour window from an hour from now, every night; the roster starts in two weeks (its rehearsal), the day back in four.
    const g = await route(alpha.owner, 1, {
      action: "goal.create",
      goal: {
        title: "Back to work: protected sleep for Blake",
        target_date: addDays(today, 42),
        roster: [{ member: alpha.member, from: hhmm(Date.now() + HOUR), to: hhmm(Date.now() + 13 * HOUR), nights: [0, 1, 2, 3, 4, 5, 6], covers: "bottle" }],
        template: { kind: "back_to_work", member: alpha.member, date: addDays(today, 28), nursing: null, roster_from: addDays(today, 14), feeding: "bottles" },
      },
    });
    eq(g.status, 200, JSON.stringify(g.json).slice(0, 300));
    eq(windowAt(await activeRosters({ familyId: 1, babyId: alpha.babyId }), alpha.member, Date.now() + 2 * HOUR, alpha.tz), null, "quiet hours, the catch-up and Siri: not on yet");
    const twoHours = (s: HoldingShift) => !!s.handoff_at && Math.abs(Date.parse(s.handoff_at) - (Date.now() + 2 * HOUR)) < 2 * MIN;
    // Blake's two-hour turn; Avery takes over with I've got her: the next handoff, back to Blake, is the default two hours on.
    const t = (await route(alpha.member, 1, { action: "shift.start", at: new Date(Date.now() - 5 * MIN).toISOString(), handoff_at: new Date(Date.now() - 5 * MIN + 2 * HOUR).toISOString() })).json.result as { shift: HoldingShift };
    const acc = await route(alpha.owner, 1, { action: "shift.accept", id: t.shift.id });
    const w = acc.json.result as { shift: HoldingShift; handoffWhy?: unknown };
    eq([acc.status, twoHours(w.shift), w.handoffWhy ?? null], [200, true, null], `I've got her: ${JSON.stringify(w.shift)}`);
    // Back to Blake, then Blake hands over (the store's handOff, as Siri and the tool use it): the same.
    await handOff(1, w.shift.id, { to: alpha.member, by: alpha.owner, source: "web", tz: alpha.tz });
    const blakes = (await openShift(1, alpha.babyId))!;
    const h = await handOff(1, blakes.id, { to: alpha.owner, by: alpha.member, source: "web", tz: alpha.tz });
    eq([twoHours(h.shift), h.handoffWhy ?? null], [true, null], `the holder's handoff: ${JSON.stringify(h.shift)}`);
    await handOff(1, h.shift.id, { to: alpha.member, by: alpha.owner, source: "web", tz: alpha.tz });
    const viaTool = await call("holding", { action: "accept" }, alpha, "owner");
    ok(!viaTool.isError && !/protected sleep|none planned/i.test(viaTool.text), viaTool.text);
    ok(twoHours((await openShift(1, alpha.babyId))!), "the tool's accept too");
    // Once the roster has started, the same window moves it (here past 12 hours away: none planned, with why).
    await sql(`UPDATE maple_sleep_goals SET template = jsonb_set(template, '{roster_from}', to_jsonb($1::text)) WHERE family_id = 1`, [addDays(today, -1)]);
    await handOff(1, (await openShift(1, alpha.babyId))!.id, { to: alpha.member, by: alpha.owner, source: "web", tz: alpha.tz });
    const on = await handOff(1, (await openShift(1, alpha.babyId))!.id, { to: alpha.owner, by: alpha.member, source: "web", tz: alpha.tz });
    eq([on.shift.handoff_at, (on.handoffWhy as { member?: string } | undefined)?.member], [null, alpha.member], "on from roster_from: Blake's window counts");
    await sql(`DELETE FROM maple_sleep_goals WHERE family_id = 1`);
    await clean(alpha);
  });

  await test("asleep in arms: a feed starting ends it then (start_timer, as the dock and Siri end a nap), so the feed never counts as sleep; a handoff keeps it running and says so; a nap elsewhere is left as before", async () => {
    await clean(alpha);
    await sql(`DELETE FROM maple_entries WHERE family_id = 1 AND kind = 'feed' AND active`);
    // Asleep in Blake's arms since half an hour ago.
    const s = await call("holding", { action: "start", asleep: true, handoff_in_minutes: 120, minutes_ago: 30 }, alpha);
    ok(!s.isError, s.text);
    const arms = (await sleeps(alpha)).find((x) => x.deleted_at == null)!;
    // Avery takes over: the sleep in arms runs on (the documented rule), and the reply says so, to stop it if she's awake.
    const acc = await call("holding", { action: "accept" }, alpha, "owner");
    ok(new RegExp(`June's sleep in arms has been running since .+ \\(#${arms.id}\\); if she's awake, stop it \\(stop_timer\\)\\.`).test(acc.text), acc.text);
    eq((await getEntry(1, Number(arms.id)))?.active, true, "a handoff keeps it running");
    // A feed starts: the sleep in arms ends then.
    const feed = await call("start_timer", { timer: "nursing", side: "left", minutes_ago: 2 }, alpha, "owner");
    ok(!feed.isError && new RegExp(`June's sleep in arms \\(#${arms.id}, since .+\\) ended at .+, when the feed began`).test(feed.text) && !/Also running: .*[Ss]leep/.test(feed.text), feed.text);
    const ended = (await getEntry(1, Number(arms.id)))!;
    const fe = (await listEntries(1, { babyId: alpha.babyId, kinds: ["feed"], includeActive: true })).find((e) => e.active)!;
    eq([ended.active, ended.ended_at], [false, fe.started_at], "ended when the feed began");
    // Sleep counts no feed time: the sleep ends where the feed begins.
    ok(Date.parse(ended.ended_at!) <= Date.parse(fe.started_at), "no overlap");
    await call("stop_timer", { timer: "nursing" }, alpha, "owner");
    // A nap that isn't in arms (a sleep timer, a bassinet sleep) is left as start_timer always has: still running, said.
    await clean(alpha);
    await startTimer(1, { babyId: alpha.babyId, kind: "sleep", at: new Date(Date.now() - 30 * MIN), createdBy: alpha.owner, source: "web" });
    const other = await call("start_timer", { timer: "nursing", side: "right" }, alpha, "owner");
    ok(!other.isError && /Also running: .*[Ss]leep/.test(other.text) && !/sleep in arms/.test(other.text), other.text);
    eq((await sleeps(alpha)).filter((x) => x.active).length, 1, "still running");
    await call("stop_timer", { timer: "nursing" }, alpha, "owner");
    await sql(`DELETE FROM maple_entries WHERE family_id = 1 AND kind = 'feed' AND created_at > NOW() - INTERVAL '5 minutes'`);
    await clean(alpha);
  });

  await test("maple_status and the chat's [App] lines carry a running try and who's holding her; a family without a plan reads as before", async () => {
    await clean(alpha);
    await call("holding", { action: "start" }, alpha);
    let st = await call("maple_status", {}, alpha);
    ok(/Holding: Blake is holding June awake/.test(st.text) && st.sc.sleep, st.text);
    await call("bassinet_try", { action: "start" }, alpha);
    st = await call("maple_status", {}, alpha);
    ok(/Bassinet try t\d+ running/.test(st.text) && !/Holding:/.test(st.text), st.text);
    const b = await call("maple_status", {}, beta);
    ok(!("sleep" in b.sc) && !/Bassinet|Sleep plan/.test(b.text), b.text);
    const ctxLines = await logState({
      fam: { familyId: 1, babyId: alpha.babyId, tz: alpha.tz, member: alpha.member, role: "member", status: "active" },
      now: new Date(),
      baby: { id: alpha.babyId, name: "Juniper Test", nickname: "June", sex: "female", due_date: null, born_at: "2026-10-10T08:00:00Z", birth_weight_g: null, birth_length_cm: null, birth_head_cm: null, timezone: alpha.tz, settings: {} },
      tz: alpha.tz,
      members: [],
      who: { id: alpha.member, via: "chat", role: "member", name: "Blake", viaAdmin: false },
      device: null,
      care: false,
      memoryEpoch: null,
    });
    ok(ctxLines.some((l) => /Bassinet try t\d+ running/.test(l)), JSON.stringify(ctxLines));
  });

  await test("progress over the log: counts with sample sizes, and sleep by place adds up to the sleep logged", async () => {
    await clean(alpha);
    const t0 = new Date(Date.now() - 6 * HOUR);
    await logTry(1, { babyId: alpha.babyId, start: t0, end: new Date(t0.getTime() + 90 * MIN), outcome: "stayed_asleep", putDownBy: alpha.member, tags: ["fed"], note: null, by: alpha.member, source: "web" });
    await logTry(1, { babyId: alpha.babyId, start: new Date(t0.getTime() + 2 * HOUR), end: new Date(t0.getTime() + 2 * HOUR + 4 * MIN), outcome: "woke_crying", putDownBy: alpha.member, tags: [], note: null, by: alpha.member, source: "web" });
    const r = await call("sleep_plan", { progress_days: 7 }, alpha);
    const p = r.sc.progress as { tries: number; stayed_asleep: { n: number; of: number }; sleep_by_place: { place: string; hours: number }[]; early_observations: string[] };
    eq([p.tries, p.stayed_asleep], [2, { n: 1, of: 2 }], "counts");
    eq(p.sleep_by_place.map((x) => x.place), ["Bassinet"], "all of it in the bassinet");
    eq(p.early_observations, [], "too few for a pattern");
    ok(/Stayed asleep in 1 of 2 finished tries/.test(r.text) && /Too few tries to see patterns yet/.test(r.text), r.text);
    const g = await route(alpha.viewer, 1, undefined, "?view=progress&days=7");
    eq([(g.json.progress as { tries: number }).tries, Array.isArray(g.json.lines)], [2, true], "the route's progress view");
  });

  await test("state: the app's state carries the plan, tries and shifts, and a try changes its rev; beta's state has none", async () => {
    await clean(alpha);
    const before = await state(alpha.member, 1);
    ok(before.sleep && (before.sleep as SleepState).plan, "plan in the state");
    await route(alpha.member, 1, { action: "try.start", client_id: "alpha-try-rev-1" });
    const after = await state(alpha.member, 1);
    ok(after.rev !== before.rev, "the rev moved");
    eq((after.sleep as SleepState).tries.filter((t) => !t.ended_at).length, 1, "the running try is on every phone");
    const beta2 = await state(beta.member, 2);
    ok(!("sleep" in beta2), "a family with nothing reads as before");
    // The sleep segment is the only part of the token with commas: none for a family without any sleep rows.
    ok(String(before.rev).includes(",") && !String(beta2.rev).includes(","), `beta's rev keeps its old shape: ${beta2.rev}`);
  });

  await test("load: the state's and goals' read of holding turns is bounded by when they ended, so an index serves it instead of every turn the baby ever had", async () => {
    await clean(alpha);
    // A year of a busy family's turns, all over a month ago, then one that ended an hour ago and the open one.
    await sql(
      `INSERT INTO maple_sleep_shifts (family_id, baby_id, holder, started_at, ended_at, ended_how, created_by)
       SELECT 1, $1, $2, NOW() - INTERVAL '30 days' - (g || ' hours')::interval, NOW() - INTERVAL '30 days' - (g || ' hours')::interval + INTERVAL '20 minutes', 'ended', $2 FROM generate_series(1, 3000) g`,
      [alpha.babyId, alpha.owner]
    );
    const recent = (await startShift(1, { babyId: alpha.babyId, holder: alpha.member, at: new Date(Date.now() - 2 * HOUR), by: alpha.member, source: "web" })).shift;
    await endShift(1, recent.id, { at: new Date(Date.now() - HOUR), by: alpha.member });
    const open = (await startShift(1, { babyId: alpha.babyId, holder: alpha.owner, by: alpha.owner, source: "web" })).shift;
    await sql(`ANALYZE maple_sleep_shifts`);
    const seen = await captureQueries();
    const got = await listShifts(1, alpha.babyId, { from: new Date(Date.now() - 2 * 24 * HOUR), limit: 100 });
    const stmt = seen.stop().find((s) => /FROM maple_sleep_shifts/.test(s.sql))!;
    eq(got.map((s) => s.id), [open.id, recent.id], "the open turn and the one that ended an hour ago, nothing older");
    const plan = (await sql(`EXPLAIN (ANALYZE, BUFFERS OFF, TIMING OFF, SUMMARY OFF) ${stmt.sql}`, stmt.params)).map((r) => String(r["QUERY PLAN"])).join("\n");
    ok(/idx_maple_sleep_shifts_ended/.test(plan) && !/Rows Removed by Filter: \d{3,}/.test(plan), plan);
    await sql(`DELETE FROM maple_sleep_shifts WHERE family_id = 1`);
  });

  // ── the handoff reminder ───────────────────────────────────────────────

  await test("push: a planned handoff reaches the holder's and the next holder's phones with handoff reminders on, once, naming no one; nobody else's, and beta hears nothing", async () => {
    await clean(alpha);
    await sql(`UPDATE maple_push_subs SET prefs = '{"meds":true,"handoff":true}'::jsonb, device_id = 'made-up-phone-a1' WHERE id = $1`, [alpha.pushSubId]);
    await sql(
      `INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, prefs, device_id, receipt_token) VALUES (1, $1, 'https://push.example.test/alpha-phone-2', 'k', 'a', '{"handoff":true}', 'made-up-phone-a2', $2)`,
      [alpha.owner, "b".repeat(32)]
    );
    // Casey (view-only) turned handoff reminders on too: a handoff between Blake and Avery isn't Casey's to hear.
    await sql(
      `INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, prefs, device_id, receipt_token) VALUES (1, $1, 'https://push.example.test/alpha-viewer-phone', 'k', 'a', '{"handoff":true}', 'made-up-phone-a3', $2)`,
      [alpha.viewer, "d".repeat(32)]
    );
    await sql(`UPDATE maple_push_subs SET prefs = '{"meds":true,"handoff":true}'::jsonb WHERE id = $1`, [beta.pushSubId]);
    const plannedFor = new Date(Date.now() + MIN);
    // Blake holds her with nobody planned next: the next holder is the only other adult, Avery.
    const s = await startShift(1, { babyId: alpha.babyId, holder: alpha.member, handoffAt: plannedFor, by: alpha.member, source: "web" });
    sent.length = 0;
    const at = new Date(plannedFor.getTime() + 30_000);
    await runPushTick(at, { via: "wake", trusted: true, familyId: 1 });
    const mine = sent.filter((x) => x.kind === "handoff");
    eq(mine.map((x) => [x.tag, x.title]).sort(), [[`handoff:${s.shift.id}`, "Handoff time"], [`handoff:${s.shift.id}`, "Handoff time"]], "both of Avery's phones");
    ok(!sent.some((x) => x.endpoint.endsWith("alpha-viewer-phone")), "not Casey's");
    ok(mine.every((x) => !/Avery|Blake|Casey|June|Juniper|Dana/.test(`${x.title} ${x.body}`)), JSON.stringify(mine));
    sent.length = 0;
    await runPushTick(new Date(at.getTime() + MIN), { via: "wake", trusted: true, familyId: 1 });
    eq(sent.filter((x) => x.kind === "handoff").length, 0, "once per phone");
    await runPushTick(at, { via: "wake", trusted: true, familyId: 2 });
    eq(sent.filter((x) => x.kind === "handoff").length, 0, "beta has no shift");
    await sql(`DELETE FROM maple_push_subs WHERE endpoint = 'https://push.example.test/alpha-viewer-phone'`);
  });

  await test("push: an ask (Wake [partner]) tells the asked person's phones now, never the phone that asked; once per ask, and asking again sounds again", async () => {
    await clean(alpha);
    const t = (await startShift(1, { babyId: alpha.babyId, holder: alpha.member, by: alpha.member, source: "web" })).shift;
    const scope = (await familyScope(1))!;
    sent.length = 0;
    await notifyHandoffNow(scope, t.id, "made-up-phone-a1");
    eq(sent.length, 0, "no ask, no Handoff now");
    await askHandoff(1, { babyId: alpha.babyId, id: t.id, to: alpha.owner, by: alpha.member, source: "web", device: "made-up-phone-a1" });
    await notifyHandoffNow(scope, t.id, "made-up-phone-a1");
    eq(sent.map((x) => [x.endpoint, x.title, x.tag]), [["https://push.example.test/alpha-phone-2", "Handoff now", `handoff:${t.id}`]], "only the other phone");
    ok(sent.every((x) => !/Avery|Blake|Casey|June|Juniper|Dana/.test(`${x.title} ${x.body}`)), JSON.stringify(sent));
    sent.length = 0;
    await notifyHandoffNow(scope, t.id, "made-up-phone-a1");
    eq(sent.length, 0, "once per ask");
    await sql(`UPDATE maple_sleep_shifts SET asked_at = asked_at - INTERVAL '11 minutes' WHERE id = $1`, [t.id]);
    await askHandoff(1, { babyId: alpha.babyId, id: t.id, to: alpha.owner, by: alpha.member, source: "web", device: "made-up-phone-a1" });
    await notifyHandoffNow(scope, t.id, "made-up-phone-a1");
    eq(sent.length, 1, "asking again sounds again");
    sent.length = 0;
    const open = (await openShift(1, alpha.babyId))!;
    await handOff(1, open.id, { to: alpha.owner, by: alpha.owner, source: "web" });
    await notifyHandoffNow(scope, t.id, null);
    eq(sent.length, 0, "taken over: nothing more");
  });

  // ── a direct store edge ────────────────────────────────────────────────

  await test("store: a finish with a time before she was laid down, or a try over 12 hours, is refused and saves nothing", async () => {
    await clean(alpha);
    const w = await startTry(1, { babyId: alpha.babyId, putDownBy: alpha.member, tags: [], note: null, by: alpha.member, source: "web" });
    let refused = "";
    try {
      await finishTry(1, w.try.id, { outcome: "woke_calm", at: new Date(Date.parse(w.try.started_at) - 10 * MIN), by: alpha.member });
    } catch (e) {
      refused = (e as Error).message;
    }
    ok(/before she was laid down/.test(refused), refused);
    eq((await getTry(1, w.try.id))?.ended_at, null, "still running");
    let long = "";
    try {
      await logTry(1, { babyId: alpha.babyId, start: new Date(Date.now() - 14 * HOUR), end: new Date(Date.now() - MIN), outcome: "stayed_asleep", putDownBy: null, tags: [], note: null, by: alpha.member, source: "web" });
    } catch (e) {
      long = (e as Error).message;
    }
    ok(/over 12 hours/.test(long), long);
    await deleteTry(1, w.try.id, alpha.member);
  });

  done("sleep.check.ts");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
