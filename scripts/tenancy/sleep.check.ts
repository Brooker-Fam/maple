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
import { deleteTry, finishTry, getTry, handOff, logTry, openShift, startShift, startTry, updateTry, undoHandOff } from "../../src/lib/maple/sleep/store";
import type { BassinetTry, SleepState } from "../../src/lib/maple/sleep/types";
import { getEntry, listEntries, startTimer } from "../../src/lib/maple/store";
import { addDays, dayKey } from "../../src/lib/maple/time";
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
    const said = "The goal: Maple's plans never leave June to cry, or have her sleep on or with an adult, or in a bed, couch, recliner, armchair or swing. Reword it.";
    const rev = Number((await sql(`SELECT revision FROM maple_sleep_plans WHERE family_id = 1`))[0].revision);
    for (const goal of ["Co-sleeping safely", "Let her cry it out at bedtime", "June naps in the swing after lunch"]) {
      const r = await route(alpha.owner, 1, { action: "plan.update", revision: rev, patch: { goal } });
      eq([r.status, r.json.error], [400, said], `route: "${goal}"`);
      const t = await call("set_sleep_plan", { revision: rev, goal }, alpha);
      ok(t.isError && t.text.startsWith(said) && /Nothing was saved/.test(t.text), t.text);
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

  await test("MCP holding: start, hand off with sleepy, end; who's named comes from the family", async () => {
    await clean(alpha);
    const s = await call("holding", { action: "start", handoff_in_minutes: 120, next_holder: "Avery" }, alpha);
    ok(!s.isError && /Blake is holding June awake/.test(s.text), s.text);
    const h = await call("holding", { action: "hand_off", to: "Avery", sleepy: true }, alpha);
    ok(!h.isError && /Avery is holding June now/.test(h.text) && /get a notice now/.test(h.text), h.text);
    const nobody = await call("holding", { action: "hand_off", to: "Zed" }, alpha);
    ok(nobody.isError && /isn't someone in this family/.test(nobody.text), nobody.text);
    const e = await call("holding", { action: "end" }, alpha, "owner");
    ok(!e.isError && /Ended Avery's holding shift/.test(e.text), e.text);
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

  // ── the handoff reminder ───────────────────────────────────────────────

  await test("push: a planned handoff reaches the phones that turned handoff reminders on, once, naming no one; beta hears nothing", async () => {
    await clean(alpha);
    await sql(`UPDATE maple_push_subs SET prefs = '{"meds":true,"handoff":true}'::jsonb, device_id = 'made-up-phone-a1' WHERE id = $1`, [alpha.pushSubId]);
    await sql(
      `INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, prefs, device_id, receipt_token) VALUES (1, $1, 'https://push.example.test/alpha-phone-2', 'k', 'a', '{"handoff":true}', 'made-up-phone-a2', $2)`,
      [alpha.owner, "b".repeat(32)]
    );
    await sql(`UPDATE maple_push_subs SET prefs = '{"meds":true,"handoff":true}'::jsonb WHERE id = $1`, [beta.pushSubId]);
    const plannedFor = new Date(Date.now() + MIN);
    const s = await startShift(1, { babyId: alpha.babyId, holder: alpha.member, handoffAt: plannedFor, by: alpha.member, source: "web" });
    sent.length = 0;
    const at = new Date(plannedFor.getTime() + 30_000);
    await runPushTick(at, { via: "wake", trusted: true, familyId: 1 });
    const mine = sent.filter((x) => x.kind === "handoff");
    eq(mine.map((x) => [x.tag, x.title]).sort(), [[`handoff:${s.shift.id}`, "Handoff time"], [`handoff:${s.shift.id}`, "Handoff time"]], "both of alpha's phones");
    ok(mine.every((x) => !/Avery|Blake|Casey|June|Juniper|Dana/.test(`${x.title} ${x.body}`)), JSON.stringify(mine));
    sent.length = 0;
    await runPushTick(new Date(at.getTime() + MIN), { via: "wake", trusted: true, familyId: 1 });
    eq(sent.filter((x) => x.kind === "handoff").length, 0, "once per phone");
    await runPushTick(at, { via: "wake", trusted: true, familyId: 2 });
    eq(sent.filter((x) => x.kind === "handoff").length, 0, "beta has no shift");
  });

  await test("push: Wake [partner] tells the family's other phones now, never the phone that asked", async () => {
    const open = (await openShift(1, alpha.babyId))!;
    const h = await handOff(1, open.id, { to: alpha.owner, by: alpha.member, source: "web", device: "made-up-phone-a1" });
    sent.length = 0;
    const scope = (await familyScope(1))!;
    await notifyHandoffNow(scope, h.shift.id, "made-up-phone-a1");
    eq(sent.map((x) => [x.endpoint, x.title]), [["https://push.example.test/alpha-phone-2", "Handoff now"]], "only the other phone");
    sent.length = 0;
    await notifyHandoffNow(scope, h.shift.id, "made-up-phone-a1");
    eq(sent.length, 0, "once");
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
