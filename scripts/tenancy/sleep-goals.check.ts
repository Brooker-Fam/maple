/**
 * Sleep goals and the adults' check-ins on an in-memory Postgres: the store,
 * the /api/maple/sleep route, the app's state and its change token, the MCP
 * tools (the chat runs the same ones), maple_status, the chat's [App] lines
 * and undo_last, with two made-up families kept apart. A view-only guest
 * reads goals, steps, the roster and the baby's numbers, never a check-in.
 */
import { NextRequest } from "next/server";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GET as SLEEP_GET, POST as SLEEP_POST } from "../../src/app/api/maple/sleep/route";
import { GET as STATE_GET } from "../../src/app/api/maple/state/route";
import { sealSession, SESSION_COOKIE } from "../../src/lib/maple/auth";
import { chatLogState, chatTools, forModel, MODEL_TEXT_MAX, registrations } from "../../src/lib/maple/chat/tools";
import type { ChatToolOutput } from "../../src/lib/maple/chat/types";
import { FAMILY_ONE_COPY, type Extra } from "../../src/lib/maple/mcp-tools";
import { lastNightKey } from "../../src/lib/maple/sleep/goals";
import { logTry, saveCheckin } from "../../src/lib/maple/sleep/store";
import type { SleepCheckin, SleepGoal, SleepState } from "../../src/lib/maple/sleep/types";
import { rev } from "../../src/lib/maple/store";
import { addDays, dayKey } from "../../src/lib/maple/time";
import type { Role } from "../../src/lib/maple/types";
import { done, eq, freshDb, ok, seedFamilies, sql, test, type FamilySeed } from "./harness";

process.env.MCP_SECRET = "made-up-sleep-goals-secret";
process.env.MAPLE_SESSION_SECRET = "made-up-sleep-goals-session-secret";
delete process.env.QSTASH_TOKEN;
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;

const MIN = 60_000;
const HOUR = 60 * MIN;
const EVERY = [0, 1, 2, 3, 4, 5, 6];

// ── callers ──────────────────────────────────────────────────────────────

const { all } = registrations(FAMILY_ONE_COPY);
const handler = (name: string) => {
  const r = all.find((x) => x.name === name);
  if (!r) throw new Error(`no tool ${name}`);
  return r.handler;
};

type Who = Exclude<Role, "photos">;
type Call = { text: string; isError: boolean; sc: Record<string, unknown> };

function extraFor(family: FamilySeed, role: Who, via: "claude" | "chat" = "claude"): Extra {
  return {
    signal: new AbortController().signal,
    requestId: "sleep-goals-check",
    authInfo: { token: "sleep-goals-check", clientId: "sleep-goals-check", scopes: ["maple"], extra: { sub: `maple:${family[role]}`, fam: family.familyId, via, ...(via === "chat" ? { care: false, memoryEpoch: null } : {}) } },
    sendNotification: async () => {},
    sendRequest: async () => {
      throw new Error("unsupported");
    },
  } as unknown as Extra;
}

async function call(name: string, args: Record<string, unknown>, family: FamilySeed, role: Who = "member", via: "claude" | "chat" = "claude"): Promise<Call> {
  const res: CallToolResult = await handler(name)(args, extraFor(family, role, via));
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

const goalOf = (r: Res) => (r.json.result as { goal: SleepGoal; status: string }).goal;
const statusOf = (r: Res) => (r.json.result as { status: string }).status;
const checkinOf = (r: Res) => (r.json.result as { checkin: SleepCheckin; status: string }).checkin;
const sleepState = (r: Res) => r.json.sleep as SleepState;
const count = async (table: string, where: string, params: unknown[]) => Number((await sql(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`, params))[0].n);
/** The token without its hourly part, so a check that crosses the hour still compares the rest. */
const steady = (r: unknown) => String(r).split("|").slice(0, -1).join("|");

async function main() {
  await freshDb();
  const { alpha, beta } = await seedFamilies();
  const photos = "dana.photos@example.test";
  await sql(`INSERT INTO maple_members (family_id, email, role, display_name, added_by, accepted_at) VALUES (1, $1, 'photos', 'Photo Guest', 'self', NOW())`, [photos]);
  const today = dayKey(new Date(), alpha.tz);
  const lastNight = lastNightKey(new Date(), alpha.tz);
  const goalBody = (title: string, more: Record<string, unknown> = {}) => ({
    title,
    target_date: addDays(today, 28),
    targets: [
      { kind: "bassinet_nights", per_week: 4, min_minutes: 60 },
      { kind: "protected_window", member: alpha.member, per_week: 5 },
    ],
    steps: [{ title: "Bassinet after the late evening feed", week_of: today }, { title: "Swap the 2 AM feed every other night" }],
    roster: [
      { member: alpha.member, from: "22:00", to: "02:00", nights: EVERY },
      { member: alpha.owner, from: "02:00", to: "06:00", nights: EVERY },
    ],
    ...more,
  });
  let goal: SleepGoal | null = null;

  // ── the route, by role ──────────────────────────────────────────────────

  await test("REST: owners and members set goals; a view-only guest reads them and writes nothing; a photos-only guest reads nothing", async () => {
    const r = await route(alpha.owner, 1, { action: "goal.create", goal: goalBody("Both of us get a 4-hour stretch"), client_id: "alpha-goal-made-up-1" });
    eq(r.status, 200, JSON.stringify(r.json));
    goal = goalOf(r);
    eq([statusOf(r), goal.status, goal.revision, goal.targets.map((t) => t.id), goal.steps.map((s) => s.id), goal.roster.map((w) => w.id)], ["created", "active", 1, ["a1", "a2"], ["s3", "s4"], ["w5", "w6"]], "saved with its ids");
    // Set three days ago, so last night's check-ins fall inside it.
    await sql(`UPDATE maple_sleep_goals SET created_at = NOW() - INTERVAL '3 days' WHERE id = $1`, [goal.id]);
    const u = await route(alpha.member, 1, { action: "goal.update", id: goal.id, revision: 1, patch: { why: "Back to work in four weeks" } });
    eq([u.status, goalOf(u).revision, goalOf(u).why], [200, 2, "Back to work in four weeks"], "a member changes it");
    goal = goalOf(u);
    for (const body of [
      { action: "goal.update", id: goal.id, revision: 2, patch: { title: "made-up" } },
      { action: "goal.step", id: goal.id, step: "s3" },
      { action: "goal.review", id: goal.id, note: "made-up" },
      { action: "goal.close", id: goal.id, status: "met" },
      { action: "checkin.save", protected: "yes" },
      { action: "goal.create", goal: { title: "made-up" } },
    ]) eq((await route(alpha.viewer, 1, body)).status, 403, `viewer ${body.action}`);
    const read = await route(alpha.viewer, 1);
    eq([read.status, sleepState(read).goals.map((g) => g.id), "checkins" in sleepState(read)], [200, [goal.id], false], "viewer reads goals, no check-ins");
    eq((await route(photos, 1)).status, 403, "photos-only GET");
    eq((await route(photos, 1, { action: "checkin.save", protected: "yes" })).status, 403, "photos-only write");
    eq((await route(photos, 1, undefined, "?view=goals")).status, 403, "photos-only goals view");
  });

  await test("REST: a stale update is 409 with the goal as it is now, and saves nothing; goal.create retried with its client_id returns the first save", async () => {
    const stale = await route(alpha.owner, 1, { action: "goal.update", id: goal!.id, revision: 1, patch: { title: "made-up stale title" } });
    eq([stale.status, stale.json.code, (stale.json.current as SleepGoal).revision], [409, "changed", 2], "stale");
    eq((await sql(`SELECT title FROM maple_sleep_goals WHERE id = $1`, [goal!.id]))[0].title, "Both of us get a 4-hour stretch", "nothing saved");
    const again = await route(alpha.owner, 1, { action: "goal.create", goal: goalBody("Both of us get a 4-hour stretch"), client_id: "alpha-goal-made-up-1" });
    eq([again.status, statusOf(again), goalOf(again).id], [200, "deduped", goal!.id], "the first save comes back");
    eq(await count("maple_sleep_goals", "family_id = 1 AND deleted_at IS NULL", []), 1, "one goal");
    const bad = await route(alpha.owner, 1, { action: "goal.update", id: goal!.id, revision: 2, patch: { roster: [{ member: alpha.viewer, from: "22:00", to: "02:00", nights: EVERY }] } });
    eq([bad.status, /isn't an owner or member/.test(String(bad.json.error))], [400, true], "a window for a view-only guest");
  });

  // ── check-ins ──────────────────────────────────────────────────────────

  await test("check-ins: saved only for the signed-in adult, one per adult per night, idempotent by client_id", async () => {
    const r = await route(alpha.member, 1, { action: "checkin.save", protected: "yes", note: "Made-up note about the night", client_id: "alpha-checkin-1", member: alpha.owner });
    eq(r.status, 200, JSON.stringify(r.json));
    const c = checkinOf(r);
    eq([c.member, c.night, c.protected, statusOf(r)], [alpha.member, lastNight, "yes", "created"], "the caller's own, for last night, whoever the body names");
    const retry = await route(alpha.member, 1, { action: "checkin.save", protected: "yes", client_id: "alpha-checkin-1" });
    eq([statusOf(retry), checkinOf(retry).id], ["deduped", c.id], "a retry");
    const change = await route(alpha.member, 1, { action: "checkin.save", protected: "partly" });
    eq([statusOf(change), checkinOf(change).id, checkinOf(change).protected, checkinOf(change).note], ["updated", c.id, "partly", "Made-up note about the night"], "saving again changes that one and keeps its note");
    const [a, b] = await Promise.all([
      route(alpha.owner, 1, { action: "checkin.save", protected: "no", client_id: "alpha-checkin-race-a" }),
      route(alpha.owner, 1, { action: "checkin.save", protected: "yes", client_id: "alpha-checkin-race-b" }),
    ]);
    eq([a.status, b.status], [200, 200], "both phones answered");
    eq(await count("maple_sleep_checkins", "family_id = 1 AND member = $1 AND night = $2 AND deleted_at IS NULL", [alpha.owner, lastNight]), 1, "one for the owner");
    eq(await count("maple_sleep_checkins", "family_id = 1 AND member = $1 AND night = $2 AND deleted_at IS NULL", [alpha.member, lastNight]), 1, "one for the member");
    eq((await route(alpha.member, 1, { action: "checkin.save", protected: "yes", night: today })).status, 400, "tonight isn't over");
    eq((await route(alpha.member, 1, { action: "checkin.save", protected: "yes", night: addDays(lastNight, -14) })).status, 400, "too long ago");
    eq((await route(alpha.member, 1, { action: "checkin.save", protected: "maybe" })).status, 400, "an answer it doesn't know");
    eq((await route(alpha.member, 1, { action: "checkin.save", protected: "yes", note: "x".repeat(201) })).status, 400, "a long note");
  });

  await test("check-ins: each adult deletes only their own; someone else's reads as missing", async () => {
    const mine = (await sql(`SELECT id FROM maple_sleep_checkins WHERE family_id = 1 AND member = $1 AND night = $2 AND deleted_at IS NULL`, [alpha.member, lastNight]))[0];
    eq((await route(alpha.owner, 1, { action: "checkin.delete", id: Number(mine.id) })).status, 404, "the owner can't delete the member's");
    eq(await count("maple_sleep_checkins", "id = $1 AND deleted_at IS NULL", [mine.id]), 1, "still there");
    const two = addDays(lastNight, -1);
    const saved = checkinOf(await route(alpha.member, 1, { action: "checkin.save", protected: "no", night: two }));
    const del = await route(alpha.member, 1, { action: "checkin.delete", night: two });
    eq([del.status, checkinOf(del).id], [200, saved.id], "their own, by night");
    const back = await route(alpha.member, 1, { action: "checkin.save", protected: "partly", night: two });
    eq([statusOf(back), checkinOf(back).id !== saved.id], ["created", true], "saved again after a delete is a new one");
    eq((await route(beta.member, 2, { action: "checkin.delete", id: Number(mine.id) })).status, 404, "another family");
  });

  // ── visibility everywhere ──────────────────────────────────────────────

  await test("visibility: the state carries check-ins for owners and members only, and a check-in never moves a view-only guest's token", async () => {
    const member = await state(alpha.member, 1);
    const viewer = await state(alpha.viewer, 1);
    ok((member.sleep as SleepState).checkins?.some((c) => c.member === alpha.member), "the member sees check-ins");
    ok((member.sleep as SleepState).checkins?.some((c) => c.member === alpha.owner), "everyone's");
    eq([(viewer.sleep as SleepState).goals.length >= 1, "checkins" in (viewer.sleep as SleepState)], [true, false], "the viewer: goals, no check-ins");
    await route(alpha.owner, 1, { action: "checkin.save", protected: "partly" });
    const member2 = await state(alpha.member, 1);
    const viewer2 = await state(alpha.viewer, 1);
    ok(steady(member2.rev) !== steady(member.rev), "the member's token moved");
    eq(steady(viewer2.rev), steady(viewer.rev), "the viewer's didn't");
    ok(!JSON.stringify(viewer2).includes("Made-up note about the night"), "no check-in note anywhere in the viewer's state");
  });

  await test("visibility: the goals view gives a view-only guest the baby's numbers and the roster, never a check-in count", async () => {
    const v = await route(alpha.viewer, 1, undefined, "?view=goals");
    eq(v.status, 200, JSON.stringify(v.json));
    const [g] = v.json.goals as { goal: SleepGoal; progress: { checkins: unknown; targets: { kind: string; weeks: unknown }[]; roster: unknown[] }; coach: { notCheckedIn: unknown; notes: string[] }; lines: string[] }[];
    eq([g.progress.checkins, g.progress.targets.find((t) => t.kind === "protected_window")?.weeks, g.coach.notCheckedIn, g.progress.roster.length], [null, null, null, 2], "no check-in counts; the roster's hints stay");
    ok(g.lines.every((l) => !/checked in|Check-ins/.test(l)) && g.coach.notes.every((n) => !/checked in/.test(n)), JSON.stringify(g.lines));
    const m = await route(alpha.member, 1, undefined, "?view=goals");
    const [mg] = m.json.goals as { progress: { checkins: { member: string; lastNight: string | null }[] } }[];
    ok(mg.progress.checkins.some((c) => c.member === alpha.member && c.lastNight === "partly"), JSON.stringify(mg.progress.checkins));
  });

  await test("visibility: sleep_plan, maple_status and the chat give check-ins to owners and members only", async () => {
    const vp = await call("sleep_plan", {}, alpha, "viewer");
    ok(!vp.isError && /Sleep goal g\d+ \(Active\): "Both of us get a 4-hour stretch"/.test(vp.text), vp.text);
    ok(!/Check-ins|checked in|Not checked in|check-ins on|From the adults/.test(vp.text), `viewer sleep_plan: ${vp.text}`);
    const vpa = await call("sleep_plan", { view: "all" }, alpha, "viewer");
    ok(!/Check-ins|checked in|Not checked in|check-ins on|From the adults/.test(vpa.text), `viewer sleep_plan, view all: ${vpa.text}`);
    const vg = (vpa.sc.goals as { progress: Record<string, unknown> }[])[0];
    ok(!("checkins" in vg.progress), "no check-ins in the viewer's goal JSON");
    const mp = await call("sleep_plan", { view: "all" }, alpha, "member");
    ok(/Check-ins since/.test(mp.text) && "checkins" in (mp.sc.goals as { progress: Record<string, unknown> }[])[0].progress, mp.text);
    const vs = await call("maple_status", {}, alpha, "viewer");
    ok(/Sleep goals: g\d+ "Both of us get a 4-hour stretch"/.test(vs.text) && !/Check-ins for last night/.test(vs.text), vs.text);
    ok(!("checkins_last_night" in (vs.sc.sleep as Record<string, unknown>)), "viewer maple_status JSON");
    const ms = await call("maple_status", {}, alpha, "member");
    ok(/Check-ins for last night: .*Blake partly/.test(ms.text), ms.text);
    const viewerLines = await chatLogState({ email: alpha.viewer }, { fam: 1, care: false, now: new Date() });
    const memberLines = await chatLogState({ email: alpha.member }, { fam: 1, care: false, now: new Date() });
    ok(viewerLines.some((l) => /^Sleep goals:/.test(l)) && !viewerLines.some((l) => /Check-ins/.test(l)), JSON.stringify(viewerLines));
    ok(memberLines.some((l) => /^Check-ins for last night:/.test(l)), JSON.stringify(memberLines));
    const vt = chatTools({ email: alpha.viewer, role: "viewer" }, { fam: 1, born: true, care: false, copy: FAMILY_ONE_COPY });
    ok(!("sleep_goal" in vt) && "sleep_plan" in vt, "a viewer's chat has sleep_plan, not sleep_goal");
    const out = (await vt.sleep_plan.execute!({}, { toolCallId: "made-up-call", messages: [], context: {} })) as ChatToolOutput;
    ok(out.ok && /Sleep goal g\d+/.test(out.text) && !/Check-ins|checked in/.test(out.text), out.text);
    const viaChat = await call("sleep_plan", {}, alpha, "viewer", "chat");
    ok(!/Check-ins|checked in/.test(viaChat.text), "the chat's own call");
  });

  // ── families apart ─────────────────────────────────────────────────────

  await test("families: another family's goals and check-ins read as missing everywhere", async () => {
    const b = await route(beta.member, 2);
    eq([b.status, sleepState(b).goals, sleepState(b).checkins], [200, [], []], "nothing of alpha's in beta's sleep");
    ok(!("sleep" in (await state(beta.member, 2))), "beta's state reads as before");
    for (const body of [
      { action: "goal.update", id: goal!.id, revision: 2, patch: { title: "made-up" } },
      { action: "goal.step", id: goal!.id, step: "s3" },
      { action: "goal.review", id: goal!.id },
      { action: "goal.close", id: goal!.id, status: "dropped" },
    ]) eq((await route(beta.owner, 2, body)).status, 404, `beta ${body.action}`);
    eq((await route(beta.owner, 2, undefined, `?view=goals&id=${goal!.id}`)).json.goals, [], "beta's goals view of alpha's id");
    const theirs = await call("sleep_goal", { action: "step", id: `g${goal!.id}`, step: "s3" }, beta);
    const nobody = await call("sleep_goal", { action: "step", id: "g999999", step: "s3" }, beta);
    eq([theirs.isError, theirs.text.replace(String(goal!.id), "N")], [true, nobody.text.replace("999999", "N")], "the same words as an id nobody has");
    const bp = await call("sleep_plan", {}, beta);
    ok(!/Sleep goal g/.test(bp.text) && !("goals" in bp.sc), bp.text);
    eq((await sql(`SELECT title FROM maple_sleep_goals WHERE id = $1`, [goal!.id]))[0].title, "Both of us get a 4-hour stretch", "unchanged");
  });

  // ── caps ───────────────────────────────────────────────────────────────

  await test("caps: 5 active goals at most; paused ones don't count, and making one active again is checked", async () => {
    const ids: number[] = [];
    for (let i = 2; i <= 5; i++) {
      const r = await route(alpha.owner, 1, { action: "goal.create", goal: { title: `Made-up goal ${i}` } });
      eq(r.status, 200, JSON.stringify(r.json));
      ids.push(goalOf(r).id);
    }
    const sixth = await route(alpha.owner, 1, { action: "goal.create", goal: { title: "Made-up goal 6" } });
    eq([sixth.status, /5 active sleep goals/.test(String(sixth.json.error))], [400, true], "the sixth");
    const g5 = (await sql(`SELECT revision FROM maple_sleep_goals WHERE id = $1`, [ids[3]]))[0];
    const paused = await route(alpha.owner, 1, { action: "goal.update", id: ids[3], revision: Number(g5.revision), patch: { status: "paused" } });
    eq([paused.status, goalOf(paused).status], [200, "paused"], "paused");
    const sixthAgain = await route(alpha.owner, 1, { action: "goal.create", goal: { title: "Made-up goal 6" } });
    eq(sixthAgain.status, 200, "with one paused there's room");
    const back = await route(alpha.owner, 1, { action: "goal.update", id: ids[3], revision: goalOf(paused).revision, patch: { status: "active" } });
    eq([back.status, /5 active sleep goals/.test(String(back.json.error))], [400, true], "making the paused one active again is checked");
    await sql(`DELETE FROM maple_sleep_goals WHERE family_id = 1 AND id <> $1`, [goal!.id]);
  });

  // ── the MCP tool ───────────────────────────────────────────────────────

  await test("MCP sleep_goal: add without confirmed reads it back and saves nothing; with it, it saves once", async () => {
    const args = {
      action: "add",
      title: "Sleep in our room, both of us rested",
      target_date: "in 4 weeks",
      targets: [{ kind: "bassinet_stretch", minutes: 180 }, { kind: "protected_window", member: "me", per_week: 4 }],
      steps: [{ title: "First bassinet try after the 10 PM feed", week_of: today }],
      roster: [{ member: "me", from: "21:30", to: "01:30", nights: [0, 1, 2, 3, 4] }],
    };
    const before = await count("maple_sleep_goals", "family_id = 1", []);
    const preview = await call("sleep_goal", args, alpha);
    ok(!preview.isError && preview.sc.confirm_needed === true && /^Nothing saved yet\. Read this back to them: a sleep goal "Sleep in our room, both of us rested"/.test(preview.text), preview.text);
    ok(/target date \w+, \w+ \d+/.test(preview.text) && /Blake's protected sleep, 4 nights a week/.test(preview.text) && /Blake: 9:30 PM–1:30 AM, Sun–Thu nights/.test(preview.text.replace(/[  ]/g, " ")), preview.text);
    eq(await count("maple_sleep_goals", "family_id = 1", []), before, "nothing saved");
    const saved = await call("sleep_goal", { ...args, confirmed: true, client_ref: "made-up-goal-ref" }, alpha);
    ok(!saved.isError && saved.sc.created === true && /^Saved sleep goal g\d+: "Sleep in our room, both of us rested" \(set by Blake\)\./.test(saved.text), saved.text);
    ok(!/Saved #\d+:/.test(saved.text), "never a log entry's receipt line");
    const g = saved.sc.goal as { id: string; target_date: string };
    eq(g.target_date, addDays(today, 28), "in 4 weeks, by the family's calendar");
    const again = await call("sleep_goal", { ...args, confirmed: true, client_ref: "made-up-goal-ref" }, alpha);
    eq([again.sc.deduped, (again.sc.goal as { id: string }).id], [true, g.id], "a retry");
    const bad = await call("sleep_goal", { ...args, roster: [{ member: "Zed", from: "22:00", to: "02:00", nights: EVERY }] }, alpha);
    ok(bad.isError && /isn't someone in this family/.test(bad.text), bad.text);
    const viewer = await call("sleep_goal", { ...args, confirmed: true }, alpha, "viewer");
    ok(viewer.isError && /viewer/i.test(viewer.text), viewer.text);
    const viewerCheckin = await call("sleep_goal", { action: "check_in", protected: "yes" }, alpha, "viewer");
    ok(viewerCheckin.isError && /viewer/i.test(viewerCheckin.text), viewerCheckin.text);
  });

  await test("MCP sleep_goal: update needs its revision and a yes; step, review and close; close needs a yes and update opens it again", async () => {
    const id = `g${goal!.id}`;
    const noRev = await call("sleep_goal", { action: "update", id, title: "Made-up new title" }, alpha);
    ok(noRev.isError && /Pass the goal's revision \(2 now/.test(noRev.text), noRev.text);
    const stale = await call("sleep_goal", { action: "update", id, revision: 1, title: "Made-up new title", confirmed: true }, alpha);
    ok(stale.isError && /revision 2 now/.test(stale.text) && /Nothing was saved/.test(stale.text), stale.text);
    const ask = await call("sleep_goal", { action: "update", id, revision: 2, target_date: "none" }, alpha);
    ok(ask.sc.confirm_needed === true && /\("Both of us get a 4-hour stretch"\): no target date \(was \w+, \w+ \d+\)\./.test(ask.text), ask.text);
    const up = await call("sleep_goal", { action: "update", id, revision: 2, target_date: "none", confirmed: true }, alpha);
    ok(!up.isError && /Updated sleep goal g\d+ \(revision 3 now\)/.test(up.text) && (up.sc.goal as { target_date: unknown }).target_date === null, up.text);
    const step = await call("sleep_goal", { action: "step", id, step: "s3" }, alpha);
    ok(!step.isError && /Marked step s3 done/.test(step.text) && /Steps: 1 of 2 done; next: "Swap the 2 AM feed every other night" \(s4\)/.test(step.text), step.text);
    const twice = await call("sleep_goal", { action: "step", id, step: "s3" }, alpha, "owner");
    ok(/was already done \(Blake/.test(twice.text) && twice.sc.updated === false, twice.text);
    const missing = await call("sleep_goal", { action: "step", id, step: "s99" }, alpha);
    ok(missing.isError && /no step s99/.test(missing.text), missing.text);
    const review = await call("sleep_goal", { action: "review", id, note: "Made-up: the first week went gently." }, alpha);
    ok(!review.isError && /Reviewed sleep goal g\d+ .* with the note "Made-up: the first week went gently\."/.test(review.text), review.text);
    eq((await sql(`SELECT last_review_at IS NOT NULL AS r, review_note FROM maple_sleep_goals WHERE id = $1`, [goal!.id]))[0], { r: true, review_note: "Made-up: the first week went gently." }, "stamped");
    const closeAsk = await call("sleep_goal", { action: "close", id, status: "met" }, alpha);
    ok(closeAsk.sc.confirm_needed === true && /close sleep goal g\d+ .* as met/.test(closeAsk.text), closeAsk.text);
    eq((await sql(`SELECT status FROM maple_sleep_goals WHERE id = $1`, [goal!.id]))[0].status, "active", "not closed yet");
    const closed = await call("sleep_goal", { action: "close", id, status: "met", confirmed: true }, alpha);
    ok(!closed.isError && /Closed sleep goal g\d+ .* as met/.test(closed.text), closed.text);
    const row = (await sql(`SELECT status, closed_at IS NOT NULL AS c, revision FROM maple_sleep_goals WHERE id = $1`, [goal!.id]))[0];
    eq([row.status, row.c], ["met", true], "met");
    const open = await call("sleep_goal", { action: "update", id, revision: Number(row.revision), status: "active", confirmed: true }, alpha);
    ok(!open.isError && (open.sc.goal as { status: string }).status === "active", open.text);
    eq((await sql(`SELECT closed_at FROM maple_sleep_goals WHERE id = $1`, [goal!.id]))[0].closed_at, null, "open again");
    const closeVia = await call("sleep_goal", { action: "update", id, revision: 99, status: "met", confirmed: true }, alpha);
    ok(closeVia.isError && /use action "close"/.test(closeVia.text), closeVia.text);
  });

  await test("MCP sleep_goal check_in: the signed-in adult's own answer for last night", async () => {
    const r = await call("sleep_goal", { action: "check_in", protected: "no", note: "Made-up: up twice" }, alpha, "owner");
    ok(!r.isError && /^Changed your check-in for last night/.test(r.text) && /Owners and members of the family see check-ins/.test(r.text), r.text);
    const row = (await sql(`SELECT protected, note FROM maple_sleep_checkins WHERE family_id = 1 AND member = $1 AND night = $2 AND deleted_at IS NULL`, [alpha.owner, lastNight]))[0];
    eq([row.protected, row.note], ["no", "Made-up: up twice"], "the owner's own");
    const tonight = await call("sleep_goal", { action: "check_in", protected: "yes", night: today }, alpha);
    ok(tonight.isError && /isn't over yet/.test(tonight.text), tonight.text);
  });

  // ── progress and coaching ──────────────────────────────────────────────

  await test("sleep_plan carries each goal's progress from the log, its coach notes and the guardrails", async () => {
    // Set eight days ago, with a try that stayed asleep 90 minutes three nights back.
    await sql(`UPDATE maple_sleep_goals SET created_at = NOW() - INTERVAL '8 days', last_review_at = NULL WHERE id = $1`, [goal!.id]);
    const t0 = new Date(Date.now() - 3 * 24 * HOUR);
    await logTry(1, { babyId: alpha.babyId, start: t0, end: new Date(t0.getTime() + 90 * MIN), outcome: "stayed_asleep", putDownBy: alpha.member, tags: [], note: null, by: alpha.member, source: "web" });
    const r = await call("sleep_plan", { view: "all" }, alpha);
    const g = (r.sc.goals as { id: string; progress: { targets: { id: string; weeks: { nights_counted: number }[] }[]; weeks: unknown[] }; coach: { review_due: boolean; notes: string[] } }[]).find((x) => x.id === `g${goal!.id}`)!;
    ok(g, JSON.stringify(r.sc.goals));
    eq(g.progress.weeks.length, 2, "two weeks begun");
    eq(g.progress.targets[0].weeks.reduce((n, w) => n + w.nights_counted, 0), 1, "the night with the 90-minute try counts once");
    eq(g.coach.review_due, true, "eight days without a review");
    ok(/Coach note: Review due/.test(r.text) && /Coaching: Ask one question at a time/.test(r.text), r.text);
    ok(Array.isArray(r.sc.coach_guardrails) && (r.sc.coach_guardrails as string[]).some((l) => /lactation consultant/.test(l)), "guardrails");
    const keys = Object.keys(r.sc);
    ok(keys.indexOf("guidance") >= 0 && keys.indexOf("guidance") < keys.indexOf("goals"), `the safety guidance comes before the goals, so a cut never loses it: ${keys.join(", ")}`);
    // A goal six weeks in: the tool's JSON carries its last four weeks, and says how many came before.
    await sql(`UPDATE maple_sleep_goals SET created_at = NOW() - INTERVAL '40 days' WHERE family_id = 1 AND title = 'Sleep in our room, both of us rested'`);
    const long = ((await call("sleep_plan", { view: "all" }, alpha)).sc.goals as { title: string; progress: { weeks: { n: number }[]; earlier_weeks_not_shown?: number; targets: { weeks?: unknown[] }[] } }[]).find((x) => x.title === "Sleep in our room, both of us rested")!;
    eq([long.progress.weeks.map((w) => w.n), long.progress.earlier_weeks_not_shown, long.progress.targets[0].weeks?.length], [[3, 4, 5, 6], 2, 4], "the last four of six weeks");
    const goalText = r.text.split("\n").filter((l) => /^(Sleep goal|Aim:|Steps:|Check-ins|Roster:|Hint|Coach note:)/.test(l)).join("\n");
    const judged = goalText.match(/\b(fail(ed|ure)?|streaks?|grades?|scores?|best|worst)\b/i);
    ok(goalText.length > 0 && !judged, `a judging word: ${judged?.[0]}`);
  });

  await test("maple_status: a line for the active goals; nothing new for a family without any", async () => {
    const st = await call("maple_status", {}, alpha);
    ok(/Sleep goals: .*g\d+ "Both of us get a 4-hour stretch"/.test(st.text) && (st.sc.sleep as { goals: unknown[] }).goals.length >= 2, st.text);
    const b = await call("maple_status", {}, beta);
    ok(!("sleep" in b.sc) && !/Sleep goals|Check-ins/.test(b.text), b.text);
  });

  // ── undo_last ──────────────────────────────────────────────────────────

  await test("undo_last: a check-in just saved through an assistant goes; a goal it saved, or a step, is explained and kept", async () => {
    const night = addDays(lastNight, -3);
    const c = await call("sleep_goal", { action: "check_in", protected: "partly", night }, alpha);
    ok(!c.isError && /^Saved your check-in/.test(c.text), c.text);
    const u = await call("undo_last", {}, alpha);
    ok(!u.isError && /^Removed your check-in for/.test(u.text), u.text);
    eq(await count("maple_sleep_checkins", "family_id = 1 AND member = $1 AND night = $2 AND deleted_at IS NULL", [alpha.member, night]), 0, "gone");
    const added = await call("sleep_goal", { action: "add", title: "Made-up goal to undo", confirmed: true }, alpha);
    const gid = (added.sc.goal as { id: string }).id;
    const u2 = await call("undo_last", {}, alpha);
    ok(u2.isError && /Nothing was removed\. Your last action was saving sleep goal g\d+/.test(u2.text) && /status:"dropped"/.test(u2.text), u2.text);
    eq(await count("maple_sleep_goals", "id = $1 AND deleted_at IS NULL", [Number(gid.slice(1))]), 1, "kept");
    const rev2 = Number((await sql(`SELECT revision FROM maple_sleep_goals WHERE id = $1`, [goal!.id]))[0].revision);
    await call("sleep_goal", { action: "step", id: `g${goal!.id}`, step: "s4" }, alpha);
    const u3 = await call("undo_last", {}, alpha);
    ok(u3.isError && /marked step s4 .* done/.test(u3.text) && /done:false/.test(u3.text), u3.text);
    ok(Number((await sql(`SELECT revision FROM maple_sleep_goals WHERE id = $1`, [goal!.id]))[0].revision) === rev2 + 1, "the step stays done");
  });

  // ── the change token ───────────────────────────────────────────────────

  // ── round 1: safety, cautions, read-backs, a shorter sleep_plan, the morning's answers ──

  const REFUSAL = "Maple's plans never leave June to cry, or have her sleep on or with an adult, or in a bed, couch, recliner, armchair or swing. Reword it.";
  const goalRevision = async () => Number((await sql(`SELECT revision FROM maple_sleep_goals WHERE id = $1`, [goal!.id]))[0].revision);

  await test("safety: the tool and the route refuse crying it out and unsafe sleep in every goal text; the allowed phrases save", async () => {
    const before = await count("maple_sleep_goals", "family_id = 1", []);
    const refused: [Record<string, unknown>, string][] = [
      [{ title: "Learn to self-settle", steps: [{ title: "Let her cry it out for 10 minutes before picking her up" }] }, "Step 1"],
      [{ title: "Rest for Blake", steps: [{ title: "Bassinet after the 10 PM feed" }, { title: "Blake naps on the couch with her on his chest after the 6 AM feed" }] }, "Step 2"],
      [{ title: "Easier nights", targets: [{ kind: "custom", text: "June sleeps in our bed between feeds" }] }, "Target 1"],
      [{ title: "Ferber by week 6" }, "The goal's title"],
      [{ title: "More sleep", why: "So June can nap on Avery's chest while I sleep" }, "Why it matters"],
      [{ title: "Gentle nights", steps: [{ title: "Swing naps in the afternoon" }] }, "Step 1"],
    ];
    for (const [args, field] of refused) {
      for (const confirmed of [false, true]) {
        const r = await call("sleep_goal", { action: "add", ...args, ...(confirmed ? { confirmed: true } : {}) }, alpha);
        ok(r.isError && r.text.startsWith(`${field}: ${REFUSAL}`) && /Nothing was saved/.test(r.text), `tool ${confirmed ? "add" : "read-back"}: ${r.text}`);
      }
      const rc = await route(alpha.owner, 1, { action: "goal.create", goal: args });
      eq([rc.status, rc.json.error], [400, `${field}: ${REFUSAL}`], `route: ${JSON.stringify(args)}`);
    }
    const rev = await goalRevision();
    const tu = await call("sleep_goal", { action: "update", id: `g${goal!.id}`, revision: rev, steps: [{ title: "Contact naps after lunch" }] }, alpha);
    ok(tu.isError && tu.text.startsWith(`Step 1: ${REFUSAL}`), tu.text);
    const ru = await route(alpha.owner, 1, { action: "goal.update", id: goal!.id, revision: rev, patch: { why: "So she can co-sleep with us" } });
    eq([ru.status, ru.json.error], [400, `Why it matters: ${REFUSAL}`], "route update");
    eq([await count("maple_sleep_goals", "family_id = 1", []), await goalRevision()], [before, rev], "nothing saved");
    // The review's four, and feeding words, save.
    const t = await call("sleep_goal", { action: "add", title: "Bassinet beside our bed", why: "She cries less after feeds", steps: [{ title: "If she wakes crying, soothe her" }, { title: "Bassinet in our room" }], confirmed: true }, alpha);
    ok(!t.isError && t.sc.created === true, t.text);
    const r = await route(alpha.owner, 1, { action: "goal.create", goal: { title: "Switch the 2 AM feed to formula", steps: [{ title: "Pump before bed so Blake can give a bottle" }, { title: "Dream feed at 10:30 PM" }, { title: "Wean the 3 AM feed" }, { title: "Supplement after the evening feed" }] } });
    eq(r.status, 200, JSON.stringify(r.json));
    await sql(`DELETE FROM maple_sleep_goals WHERE family_id = 1 AND id <> $1`, [goal!.id]);
  });

  await test("cautions: a read-back quotes feeds-first for a baby under 4 weeks, says a long window's feeds are someone else's, and asks for the clinician's yes on a feeding step", async () => {
    const born = (await sql(`SELECT born_at FROM maple_babies WHERE id = $1`, [alpha.babyId]))[0].born_at;
    try {
      await sql(`UPDATE maple_babies SET born_at = NOW() - INTERVAL '20 days' WHERE id = $1`, [alpha.babyId]);
      const args = { action: "add", title: "Six hours in the bassinet", targets: [{ kind: "bassinet_stretch", minutes: 360 }, { kind: "bassinet_nights", per_week: 3, min_minutes: 90 }], roster: [{ member: "Blake", from: "19:30", to: "07:30", nights: EVERY }], steps: [{ title: "Switch the 2 AM feed to formula" }, { title: "Ask the lactation consultant about one pumped bottle" }] };
      const r = await call("sleep_goal", args, alpha);
      const text = r.text.replace(/[  ]/g, " ");
      ok(r.sc.confirm_needed === true && (r.sc.cautions as string[]).length === 3, r.text);
      ok(text.includes(`Say this too: "a bassinet stretch of 6 hours or more" asks for more than 4 hours in June's first 4 weeks. Maple's guidance for her age: "In the first weeks, long stretches aren't the goal. If June sleeps longer than 4 hours at night, wake her to feed, unless her pediatrician has told you otherwise."`), text);
      ok(text.includes("Say this too: Blake's window, 7:30 PM–7:30 AM, is longer than 5 hours: someone else covers any feeds in it, and bottles or pumping to make that work go to their pediatrician or lactation consultant first."), text);
      ok(text.includes(`Say this too: The step "Switch the 2 AM feed to formula" changes how June is fed: save it only if their pediatrician or lactation consultant agreed`) && !text.includes(`The step "Ask the lactation`), text);
      // Saved through the route, the answer carries them for the app.
      const saved = await route(alpha.owner, 1, { action: "goal.create", goal: { title: "Six hours", targets: [{ kind: "bassinet_stretch", minutes: 360 }] } });
      ok((saved.json.cautions as string[]).some((c) => /June's first 4 weeks/.test(c)), JSON.stringify(saved.json.cautions));
      await sql(`UPDATE maple_babies SET born_at = NOW() - INTERVAL '40 days' WHERE id = $1`, [alpha.babyId]);
      const older = await call("sleep_goal", args, alpha);
      ok(!/first 4 weeks/.test(older.text) && /longer than 5 hours/.test(older.text), older.text);
    } finally {
      await sql(`UPDATE maple_babies SET born_at = $2 WHERE id = $1`, [alpha.babyId, born]);
      await sql(`DELETE FROM maple_sleep_goals WHERE family_id = 1 AND id <> $1`, [goal!.id]);
    }
  });

  await test("update read-backs say what changes: a step added, the ones kept and how many are done, one removed", async () => {
    const g = (await sql(`SELECT steps, revision FROM maple_sleep_goals WHERE id = $1`, [goal!.id]))[0] as { steps: { id: string; title: string; week_of: string | null; done_at: string | null }[]; revision: number };
    const steps = [...g.steps.map((s) => ({ id: s.id, title: s.title, week_of: s.week_of })), { title: "Avery gives the late feed with a pumped bottle on 3 nights" }];
    const done = g.steps.filter((s) => s.done_at).length;
    const r = await call("sleep_goal", { action: "update", id: `g${goal!.id}`, revision: Number(g.revision), steps }, alpha);
    ok(r.sc.confirm_needed === true && r.text.includes(`steps: adds step 3: "Avery gives the late feed with a pumped bottle on 3 nights"; keeps 1–2${done ? ` (${done} done)` : ""}.`), r.text);
    ok(/Say this too: The step "Avery gives the late feed with a pumped bottle on 3 nights" changes how June is fed/.test(r.text) && !/Say this too: The step "Swap/.test(r.text), `only the new step's caution: ${r.text}`);
    const drop = await call("sleep_goal", { action: "update", id: `g${goal!.id}`, revision: Number(g.revision), steps: [{ id: g.steps[1].id, title: "Swap the 2 AM feed on Avery's nights" }] }, alpha);
    ok(drop.text.includes(`steps: changes step 1 to "Swap the 2 AM feed on Avery's nights" (was "${g.steps[1].title}"); removes "${g.steps[0].title}"`), drop.text);
    eq(await goalRevision(), Number(g.revision), "read-backs save nothing");
  });

  await test("sleep_plan: with goals, a compact read with the safety titles, well under the chat's cut with 3 goals; views guidance and all; a family without goals reads as before", async () => {
    const big = (n: number) => ({
      title: `Made-up goal ${n}: both of us get a protected stretch before work starts again`,
      why: "Made-up: back to work in four weeks, still nursing, and we both need sleep.",
      target_date: addDays(today, 27),
      targets: [
        { kind: "bassinet_nights", per_week: 3, min_minutes: 90 },
        { kind: "bassinet_stretch", minutes: 180 },
        { kind: "protected_window", member: alpha.member, per_week: 4 },
        { kind: "protected_window", member: alpha.owner, per_week: 4 },
        { kind: "custom", text: "Calmer bedtimes for everyone" },
      ],
      steps: Array.from({ length: 8 }, (_, i) => ({ title: `Made-up step ${i + 1}: one bassinet try a night after the first night feed`, week_of: addDays(today, 7 * (i % 4)) })),
      roster: [
        { member: alpha.member, from: "21:30", to: "01:30", nights: EVERY },
        { member: alpha.owner, from: "01:30", to: "06:30", nights: EVERY },
      ],
    });
    const made: number[] = [];
    for (const n of [2, 3]) made.push(goalOf(await route(alpha.owner, 1, { action: "goal.create", goal: big(n) })).id);
    await sql(`UPDATE maple_sleep_goals SET created_at = NOW() - INTERVAL '10 days' WHERE id = ANY($1::bigint[])`, [made]);
    // A week of nights: feeds, tries and check-in notes, so every line has something to say.
    for (let d = 1; d <= 7; d++) {
      const night = new Date(Date.now() - d * 24 * HOUR);
      await sql(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, ended_at, data, created_by) VALUES (1, $1, 'feed', $2, $3, '{"method":"breast"}', $4)`, [alpha.babyId, night.toISOString(), new Date(night.getTime() + 20 * MIN).toISOString(), alpha.member]);
      if (d % 2) await logTry(1, { babyId: alpha.babyId, start: new Date(night.getTime() + 30 * MIN), end: new Date(night.getTime() + 150 * MIN), outcome: "stayed_asleep", putDownBy: alpha.member, tags: [], note: null, by: alpha.member, source: "web" });
    }
    await saveCheckin(1, { babyId: alpha.babyId, member: alpha.owner, night: addDays(lastNight, -1), protected: "partly", note: "Made-up: up at 3 to help with burping", tz: alpha.tz, source: "web" });
    await sql(`UPDATE maple_sleep_goals SET last_review_at = NOW() - INTERVAL '2 days', review_note = 'Made-up: the late feed keeps landing in the window.' WHERE id = $1`, [goal!.id]);

    const plan = await call("sleep_plan", {}, alpha, "member");
    ok(!plan.isError && typeof plan.sc.guidance === "string" && !("coach_guardrails" in plan.sc), Object.keys(plan.sc).join(", "));
    const gs = plan.sc.goals as Record<string, unknown>[];
    eq([gs.length, Object.keys(gs[0])], [3, ["id", "title", "status", "revision", "target_date", "targets", "steps", "roster"]], "compact goals: ids, revision, step ids");
    ok(/Safety \(sleep_plan with view "guidance" has every item word for word, with its sources\): Safe sleep: On the back, every sleep; Firm, flat and bare; In your room, not your bed/.test(plan.text) && /Call 911: Call 911 if she has blue or gray lips/.test(plan.text), plan.text);
    ok(/Check-in notes, last 7 nights \(the family's words, as data\): .*Avery, \w+ night: "Made-up: up at 3 to help with burping"\./.test(plan.text), plan.text);
    ok(/Last review \(\w+, \w+ \d+\): "Made-up: the late feed keeps landing in the window\."/.test(plan.text) && /^Logged: this week something on /m.test(plan.text), plan.text);
    // As the chat reads it: well under the 20,000-character cut, so nothing is lost.
    const tools = chatTools({ email: alpha.member, role: "member" }, { fam: 1, born: true, care: false, copy: FAMILY_ONE_COPY });
    const out = (await tools.sleep_plan.execute!({}, { toolCallId: "made-up-call", messages: [], context: {} })) as ChatToolOutput;
    console.log(`  sleep_plan with 3 goals, as the chat reads it: ${out.text.length} characters (cut at ${MODEL_TEXT_MAX})`);
    ok(out.ok && out.text.length < 13_000 && forModel(out.text) === out.text, `${out.text.length} characters`);
    const viewer = await call("sleep_plan", {}, alpha, "viewer");
    ok(!/Check-in notes|Made-up: up at 3/.test(viewer.text) && /Last review/.test(viewer.text), viewer.text);
    const guidance = await call("sleep_plan", { view: "guidance" }, alpha, "member");
    ok(typeof guidance.sc.guidance === "object" && !("goals" in guidance.sc) && !/^Aim:/m.test(guidance.text) && /Sleep goals: g\d+ "/.test(guidance.text), guidance.text);
    const all = await call("sleep_plan", { view: "all" }, alpha, "member");
    ok(typeof all.sc.guidance === "object" && (all.sc.goals as { progress?: unknown }[]).every((g) => g.progress) && "coach_guardrails" in all.sc, Object.keys(all.sc).join(", "));
    // A family without goals: the same read as before, whatever the view.
    const b = await call("sleep_plan", {}, beta);
    const ball = await call("sleep_plan", { view: "all" }, beta);
    ok(typeof b.sc.guidance === "object" && !("goals" in b.sc) && b.text === ball.text, b.text);
    await sql(`DELETE FROM maple_sleep_goals WHERE id = ANY($1::bigint[])`, [made]);
  });

  await test("check-ins: the morning's other answers save on the adult's own check-in (route and tool), count once a night, and a view-only guest never sees them", async () => {
    const night = addDays(lastNight, -2);
    const v0 = await state(alpha.viewer, 1);
    const r = await route(alpha.member, 1, { action: "checkin.save", night, protected: "yes", place: "bassinet", untimed_try: "long", untimed_min: 60, handoff: "late", client_id: "alpha-extras-1" });
    eq(r.status, 200, JSON.stringify(r.json));
    const c = checkinOf(r);
    eq([c.place, c.untimed_try, c.untimed_min, c.handoff], ["bassinet", "long", 60, "late"], "saved with it");
    const again = await route(alpha.member, 1, { action: "checkin.save", night, protected: "yes", place: null, client_id: "alpha-extras-2" });
    eq([statusOf(again), checkinOf(again).place, checkinOf(again).handoff], ["updated", undefined, "late"], "null clears one; the others stay");
    eq((await route(alpha.member, 1, { action: "checkin.save", night, protected: "yes", place: "car" })).status, 400, "a place it doesn't know");
    const t = await call("sleep_goal", { action: "check_in", night, protected: "yes", place: "held" }, alpha);
    ok(!t.isError && /^Updated your check-in for/.test(t.text) && /With it: where June spent most of the night: held by someone awake; a try not in the log: one asleep 60 minutes or more; the planned handoff: late\./.test(t.text), t.text);
    const member = await state(alpha.member, 1);
    ok((member.sleep as SleepState).checkins?.some((x) => x.night === night && x.place === "held"), "the member's state carries it");
    const v1 = await state(alpha.viewer, 1);
    ok(!("checkins" in (v1.sleep as SleepState)) && !JSON.stringify(v1).includes('"untimed_try"'), "nothing in the viewer's state");
    eq(steady(v1.rev), steady(v0.rev), "and the viewer's token didn't move");
    const lines = (await call("sleep_plan", {}, alpha, "member")).text;
    ok(/From the adults' check-ins, (this|last) week: where June spent most of the night, held by someone awake 1 \(1 night answered\); the planned handoff, late 1 \(1 night answered\)/.test(lines), lines);
  });

  await test("the change token: a family without sleep rows keeps its old shape and value; goals move it for everyone, check-ins only for owners and members", async () => {
    const b1 = await rev(2, beta.babyId);
    const b2 = await rev(2, beta.babyId, { checkins: true });
    eq([String(b1).split("|").length, steady(b1) === steady(b2)], [4, true], "beta: entries, baby, members and the hour, as before sleep goals");
    const a1 = await rev(1, alpha.babyId);
    const k1 = await rev(1, alpha.babyId, { checkins: true });
    ok(/[|,]g\d/.test(a1) && !/[|,]k\d/.test(a1) && /,k\d/.test(k1), `${a1} / ${k1}`);
    await saveCheckin(1, { babyId: alpha.babyId, member: alpha.owner, night: addDays(lastNight, -5), protected: "yes", tz: alpha.tz, source: "web" });
    eq(steady(await rev(1, alpha.babyId)), steady(a1), "a check-in leaves the token without them alone");
    ok(steady(await rev(1, alpha.babyId, { checkins: true })) !== steady(k1), "and moves the one with them");
    eq(steady(await rev(2, beta.babyId)), steady(b1), "beta never moved");
  });

  done("sleep-goals.check.ts");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
