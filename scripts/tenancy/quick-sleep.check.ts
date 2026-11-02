/**
 * Siri's sleep-plan actions (POST /api/maple/quick, ./sleep.ts) on an
 * in-memory Postgres, with two made-up families in different zones:
 * put_down, outcome, asleep_in_arms, handoff, checkin and undo, minutes_ago
 * on sleep, wake and put_down, and the sleep line "Maple status" adds. By
 * role (owners and members write, viewers hear view-only, photos-only
 * guests get nothing), with retries, second taps, the Undo of each, and
 * families kept apart. Nothing leaves the machine.
 */
import { NextRequest } from "next/server";
import webpush from "web-push";
import { POST as QUICK } from "../../src/app/api/maple/quick/route";
import { checkinDueNight } from "../../src/app/api/maple/quick/sleep";
import { POST as SLEEP_POST } from "../../src/app/api/maple/sleep/route";
import { checkinDue } from "../../src/components/maple/sleep/SleepCheckin";
import { sealSession, SESSION_COOKIE } from "../../src/lib/maple/auth";
import { setLaterRunner } from "../../src/lib/maple/push-hooks";
import { numberTries, tryDayKey, tryDayLabel } from "../../src/lib/maple/sleep/engine";
import { lastNightKey } from "../../src/lib/maple/sleep/goals";
import { getShift, getTry, listTries, openShift, runningTry, startShift } from "../../src/lib/maple/sleep/store";
import type { BassinetTry, RosterWindow, SleepCheckin, SleepGoal } from "../../src/lib/maple/sleep/types";
import { activeTimers, getEntry, startTimer } from "../../src/lib/maple/store";
import { addDays, dayKey, formatTime, zonedTimeToUtc } from "../../src/lib/maple/time";
import type { FeedData, Role } from "../../src/lib/maple/types";
import { done, eq, freshDb, ok, seedFamilies, sha256, sql, test, type FamilySeed } from "./harness";

process.env.MCP_SECRET = "made-up-quick-sleep-secret";
process.env.MAPLE_SESSION_SECRET = "made-up-quick-sleep-session";
delete process.env.QSTASH_TOKEN;
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;

const MIN = 60_000;
const HOUR = 60 * MIN;

// Notifications are caught here; a hook only queues (holdingChanged's re-arm is checked by count).
(webpush as unknown as { sendNotification: unknown }).sendNotification = async () => ({ statusCode: 201, body: "", headers: {} });
const hooks: (() => Promise<void>)[] = [];
setLaterRunner((t) => void hooks.push(t));

// ── callers ──────────────────────────────────────────────────────────────

type Said = { status: number; ok?: boolean; speak: string } & Record<string, unknown>;

async function siri(token: string, body: Record<string, unknown>): Promise<Said> {
  const res = await QUICK(new NextRequest("http://localhost:3000/api/maple/quick", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, ...((await res.json()) as { speak: string }) };
}

/** The app's own sleep route, as a signed-in phone. */
async function app(email: string, familyId: number, body: Record<string, unknown>) {
  const res = await SLEEP_POST(
    new NextRequest("http://localhost:3000/api/maple/sleep", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealSession(email, familyId))}` },
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

type People = { owner: string; member: string; viewer: string; photos: string };
const tokens = new Map<string, People>();
const T = (f: FamilySeed) => tokens.get(f.name)!;

async function addToken(familyId: number, email: string, tag: string): Promise<string> {
  const token = `maple_${tag}QuickSleepMadeUp0123456789`;
  await sql(`INSERT INTO maple_tokens (family_id, member, token_hash, label) VALUES ($1, $2, $3, 'Made-up phone')`, [familyId, email, sha256(token)]);
  return token;
}

/** Each case starts from a family with nothing but its seed: no tries, turns, check-ins, goals or new entries. */
async function reset(f: FamilySeed) {
  for (const t of ["maple_sleep_tries", "maple_sleep_shifts", "maple_sleep_checkins", "maple_sleep_goals", "maple_sleep_plans"]) await sql(`DELETE FROM ${t} WHERE family_id = $1`, [f.familyId]);
  await sql(`DELETE FROM maple_entries WHERE family_id = $1 AND id <> ALL($2::bigint[])`, [f.familyId, [f.entries.diaper, f.entries.feed, f.entries.moment]]);
  await sql(`DELETE FROM maple_care_entries WHERE family_id = $1 AND source = 'shortcut'`, [f.familyId]);
}

const clock = (at: string | number | Date, tz: string) => formatTime(at, tz).replace(/\s*[AP]M$/i, "");
const tries = (f: FamilySeed) => sql(`SELECT * FROM maple_sleep_tries WHERE family_id = $1 ORDER BY id`, [f.familyId]);
const shifts = (f: FamilySeed) => sql(`SELECT * FROM maple_sleep_shifts WHERE family_id = $1 ORDER BY id`, [f.familyId]);
const sleepsOf = (f: FamilySeed) => sql(`SELECT id, started_at, active, ended_at, deleted_at, data, source, created_by FROM maple_entries WHERE family_id = $1 AND kind = 'sleep' ORDER BY id`, [f.familyId]);
const checkinsOf = (f: FamilySeed) => sql(`SELECT member, night, protected, source, deleted_at FROM maple_sleep_checkins WHERE family_id = $1 ORDER BY id`, [f.familyId]);
const near = (a: unknown, b: number, within = 5_000) => Math.abs(new Date(a as string).getTime() - b) <= within;

/** "Try 2 tonight": the try's number by the family's try day (noon to noon in its zone). */
async function labelOf(f: FamilySeed, t: BassinetTry): Promise<string> {
  const n = numberTries(await listTries(f.familyId, f.babyId, { from: new Date(Date.parse(t.started_at) - 2 * 24 * HOUR) }), f.tz).get(t.id)!;
  return `Try ${n.n} ${tryDayLabel(n.day, tryDayKey(new Date(), f.tz))}${n.retry ? ", a retry" : ""}`;
}

/** A finished feed (a timed one, as the app saves it) that ended `endedAgo` minutes ago. */
async function finishedFeed(f: FamilySeed, endedAgo: number, by: string): Promise<number> {
  const end = new Date(Date.now() - endedAgo * MIN);
  const start = new Date(end.getTime() - 15 * MIN);
  const data = { method: "breast", segments: [{ side: "L", start: start.toISOString(), end: end.toISOString() }], left_sec: 900, first_side: "L", last_side: "L" };
  const [r] = await sql(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, ended_at, active, data, created_by) VALUES ($1, $2, 'feed', $3, $4, FALSE, $5, $6) RETURNING id`, [f.familyId, f.babyId, start, end, data, by]);
  return Number(r.id);
}

const runningFeed = async (f: FamilySeed, by: string, agoMin = 20) =>
  (await startTimer(f.familyId, { babyId: f.babyId, kind: "feed", side: "L", at: new Date(Date.now() - agoMin * MIN), createdBy: by, source: "web" })).entry;

const runningSleep = async (f: FamilySeed, by: string, agoMin = 30) => (await startTimer(f.familyId, { babyId: f.babyId, kind: "sleep", at: new Date(Date.now() - agoMin * MIN), createdBy: by, source: "web" })).entry;

// ── the check-in rule, against the app's own ─────────────────────────────

function goalOf(o: { id: number; status?: SleepGoal["status"]; created: string; roster?: RosterWindow[]; target?: string | null }): SleepGoal {
  return {
    id: o.id,
    baby_id: 1,
    title: "Made-up goal",
    why: null,
    target_date: null,
    status: o.status ?? "active",
    targets: o.target ? [{ id: "a1", kind: "protected_window", member: o.target, per_week: 4 }] : [],
    steps: [],
    roster: o.roster ?? [],
    last_review_at: null,
    review_note: null,
    closed_at: null,
    revision: 1,
    created_by: null,
    updated_by: null,
    source: "web",
    created_at: o.created,
    updated_at: o.created,
  } as SleepGoal;
}

async function main() {
  await freshDb();
  const { alpha, beta } = await seedFamilies();
  for (const f of [alpha, beta]) {
    const tag = f.name.split(" ")[1].toLowerCase();
    const photos = `photos.${tag}@example.com`;
    await sql(`INSERT INTO maple_members (family_id, email, role, display_name, added_by, accepted_at) VALUES ($1, $2, 'photos', 'Photo Guest', 'self', NOW())`, [f.familyId, photos]);
    tokens.set(f.name, {
      owner: f.token,
      member: await addToken(f.familyId, f.member, `${tag}Member`),
      viewer: await addToken(f.familyId, f.viewer, `${tag}Viewer`),
      photos: await addToken(f.familyId, photos, `${tag}Photos`),
    });
  }

  // ── roles ──────────────────────────────────────────────────────────────

  await test("roles: a viewer hears view-only for every sleep action and nothing saves; a photos-only guest gets nothing", async () => {
    for (const f of [alpha, beta]) {
      await reset(f);
      await runningSleep(f, f.owner);
      await startShift(f.familyId, { babyId: f.babyId, holder: f.owner, by: f.owner, source: "web" });
      const bodies = [{ action: "put_down" }, { action: "outcome", outcome: "woke_calm" }, { action: "asleep_in_arms" }, { action: "handoff" }, { action: "checkin", answer: "yes" }, { action: "undo" }, { action: "sleep", minutes_ago: 5 }, { action: "wake", minutes_ago: 5 }];
      for (const body of bodies) {
        const v = await siri(T(f).viewer, body);
        eq([v.status, v.speak], [403, "You have view-only access to Maple's log."], `${f.name} viewer ${body.action}`);
        const p = await siri(T(f).photos, body);
        eq([p.status, p.speak], [401, "That shortcut isn't connected to Maple's log anymore."], `${f.name} photos ${body.action}`);
      }
      eq((await tries(f)).length, 0, "no try");
      eq((await shifts(f)).map((s) => s.holder), [f.owner], "the turn stays");
      eq((await checkinsOf(f)).length, 0, "no check-in");
      eq((await sleepsOf(f)).map((s) => s.active), [true], "the sleep runs on");
      // A viewer still hears status, with the turn in it (Today shows it to everyone in the family).
      const st = await siri(T(f).viewer, { action: "status" });
      ok(st.status === 200 && st.speak.includes("been holding"), `${f.name} viewer status: ${st.speak}`);
    }
  });

  // ── put_down ───────────────────────────────────────────────────────────

  await test("put_down: a try on a new bassinet sleep, its number by the family's try day, the turn it ends, and Recently fed after a feed", async () => {
    await reset(alpha);
    await finishedFeed(alpha, 10, alpha.owner);
    const shift = (await startShift(1, { babyId: alpha.babyId, holder: alpha.owner, by: alpha.owner, source: "web" })).shift;
    const before = hooks.length;
    const r = await siri(T(alpha).member, { action: "put_down" });
    eq([r.status, r.ok], [200, true], JSON.stringify(r));
    const [t] = await tries(alpha);
    const tr = (await getTry(1, Number(t.id)))!;
    eq([tr.source, tr.created_by, tr.put_down_by, tr.tags, tr.made_sleep, tr.ended_at], ["shortcut", alpha.member, alpha.member, ["fed"], true, null], "the try");
    const s = (await getEntry(1, tr.sleep_entry_id!))!;
    eq([s.active, (s.data as { place?: string }).place, s.source], [true, "bassinet", "shortcut"], "a running bassinet sleep");
    eq(r.speak, `${await labelOf(alpha, tr)}, down at ${clock(tr.started_at, alpha.tz)}. The holding turn ended.`, "said");
    ok(/^Try 1 (tonight|last night), down at \d{1,2}:\d{2}\. The holding turn ended\.$/.test(r.speak), r.speak);
    const after = (await getShift(1, shift.id))!;
    eq([after.ended_how, near(after.ended_at, Date.parse(tr.started_at), 1500)], ["bassinet", true], "the turn ended then");
    ok(hooks.length > before, "the family's handoff wake-ups are re-armed");
  });

  await test("put_down: a second one while she's down is the try already running; a retry with its client_id is the same save", async () => {
    await reset(alpha);
    const a = await siri(T(alpha).owner, { action: "put_down", client_id: "made-up-put-1" });
    const again = await siri(T(alpha).owner, { action: "put_down", client_id: "made-up-put-1" });
    eq([again.speak, again.deduped], [a.speak, true], "the retry answers the same");
    const second = await siri(T(alpha).member, { action: "put_down" });
    const [t] = await tries(alpha);
    eq((await tries(alpha)).length, 1, "one try");
    ok(second.speak.startsWith(`Already in the bassinet since ${clock(t.started_at as string, alpha.tz)}, try 1 `), second.speak);
    eq((await sleepsOf(alpha)).length, 1, "one sleep");
    // A client id is the family's own: beta's same id is beta's own try, on a sleep of its own (no clash with alpha's).
    await reset(beta);
    const b = await siri(T(beta).owner, { action: "put_down", client_id: "made-up-put-1" });
    eq([b.ok, (await tries(beta)).length, (await tries(alpha)).length, (await sleepsOf(beta)).length, (await sleepsOf(alpha)).length], [true, 1, 1, 1, 1], "beta's id is beta's");
    await reset(beta);
  });

  await test("put_down: on a running sleep timer it links (no second sleep); a running feed is said, never stopped", async () => {
    await reset(alpha);
    const sleep = await runningSleep(alpha, alpha.owner, 40);
    const r = await siri(T(alpha).owner, { action: "put_down" });
    const tr = (await runningTry(1, alpha.babyId))!;
    eq([tr.sleep_entry_id, tr.made_sleep, tr.tags], [sleep.id, false, []], "on her sleep, no fed tag without a feed");
    eq((await sleepsOf(alpha)).length, 1, "one sleep");
    ok(!r.speak.includes("holding turn") && !r.speak.includes("nursing"), r.speak);
    await reset(alpha);
    const feed = await runningFeed(alpha, alpha.owner);
    const r2 = await siri(T(alpha).owner, { action: "put_down" });
    ok(r2.speak.endsWith(" The nursing timer is still running."), r2.speak);
    eq((await getEntry(1, feed.id))?.active, true, "the feed still runs");
  });

  await test("put_down: minutes_ago in each family's own zone, up to 4 hours; anything else saves nothing", async () => {
    for (const f of [alpha, beta]) {
      await reset(f);
      const r = await siri(T(f).owner, { action: "put_down", minutes_ago: 20 });
      const [t] = await tries(f);
      ok(near(t.started_at, Date.now() - 20 * MIN), `${f.name}: laid down 20 minutes ago`);
      ok(r.speak.includes(`down at ${clock(t.started_at as string, f.tz)}.`), `${f.name}: said in ${f.tz}: ${r.speak}`);
    }
    const a = (await tries(alpha))[0].started_at as string;
    eq(formatTime(a, alpha.tz) === formatTime(a, beta.tz), false, "Chicago and Los Angeles say different clocks");
    for (const bad of [300, -5, "soon"]) {
      await reset(alpha);
      const r = await siri(T(alpha).owner, { action: "put_down", minutes_ago: bad });
      eq([r.status, r.ok], [400, false], `minutes_ago ${bad}`);
      ok(/nothing was saved/.test(r.speak), r.speak);
      eq((await tries(alpha)).length, 0, "nothing saved");
    }
    await reset(alpha);
    const zero = await siri(T(alpha).owner, { action: "put_down", minutes_ago: "0" });
    ok(zero.ok && near((await tries(alpha))[0].started_at, Date.now()), "0 is now");
    await reset(beta);
  });

  // ── outcome ────────────────────────────────────────────────────────────

  await test("outcome: woke crying ends the try and its sleep then; picked up leaves her asleep in arms", async () => {
    await reset(alpha);
    await siri(T(alpha).owner, { action: "put_down", minutes_ago: 25 });
    const r = await siri(T(alpha).member, { action: "outcome", outcome: "woke crying" });
    const tr = (await getTry(1, Number((await tries(alpha))[0].id)))!;
    eq([tr.outcome, tr.updated_by, r.speak], ["woke_crying", alpha.member, "Woke crying after 25 minutes. Sleep timer stopped."], "said");
    const s = (await getEntry(1, tr.sleep_entry_id!))!;
    eq([s.active, near(s.ended_at, Date.parse(tr.ended_at!), 1500)], [false, true], "her sleep ended with it");
    await reset(beta);
    await siri(T(beta).member, { action: "put_down", minutes_ago: 40 });
    const p = await siri(T(beta).owner, { action: "outcome", outcome: "Picked up" });
    eq(p.speak, "Picked up after 40 minutes. He's still asleep, so his sleep timer keeps running.", "beta's baby is a boy");
    const [bs] = await sleepsOf(beta);
    eq([bs.active, (bs.data as { place?: string }).place], [true, "arms"], "still asleep, in arms");
    await reset(alpha);
    await siri(T(alpha).owner, { action: "put_down", minutes_ago: 70 });
    const st = await siri(T(alpha).owner, { action: "outcome", outcome: "stayed_asleep" });
    eq(st.speak, "Stayed asleep for 1 hour 10 minutes. Sleep timer stopped.", "stayed asleep reads 'for'");
    await reset(beta);
  });

  await test("outcome: nothing running says so; a second tap says how it went; no outcome asks with the four choices; minutes_ago ends it then", async () => {
    await reset(alpha);
    const none = await siri(T(alpha).owner, { action: "outcome", outcome: "woke_calm" });
    eq([none.ok, none.speak], [false, "No bassinet try is running."], "nothing running");
    await siri(T(alpha).owner, { action: "put_down", minutes_ago: 30 });
    const ask = await siri(T(alpha).owner, { action: "outcome" });
    eq([ask.ok, ask.speak, (ask.choices as { id: string }[]).map((c) => c.id)], [false, "How did it go: stayed asleep, woke calm, woke crying or picked up?", ["stayed_asleep", "woke_calm", "woke_crying", "picked_up"]], "asks");
    const early = await siri(T(alpha).owner, { action: "outcome", outcome: "woke_calm", minutes_ago: 45 });
    eq([early.status, early.ok], [400, false], "before she was laid down");
    eq((await runningTry(1, alpha.babyId)) !== null, true, "still running");
    const done1 = await siri(T(alpha).owner, { action: "outcome", outcome: "woke_calm", minutes_ago: 10 });
    eq(done1.speak, "Woke calm after 20 minutes. Sleep timer stopped.", "ended 10 minutes ago");
    const t = (await tries(alpha))[0];
    ok(near(t.ended_at, Date.now() - 10 * MIN), "ended then");
    const again = await siri(T(alpha).member, { action: "outcome", outcome: "woke_crying" });
    eq([again.speak, again.already_finished], [`That try already ended at ${clock(t.ended_at as string, alpha.tz)}: woke calm.`, true], "a second tap");
    eq((await getTry(1, Number(t.id)))?.outcome, "woke_calm", "unchanged");
  });

  // ── asleep_in_arms ─────────────────────────────────────────────────────

  await test("asleep_in_arms: a running sleep in arms; a feed stops first (then, with minutes_ago); a retry is the same save; one already running is said", async () => {
    await reset(alpha);
    const r = await siri(T(alpha).member, { action: "asleep_in_arms", client_id: "made-up-arms-1" });
    const [s] = await sleepsOf(alpha);
    eq([s.active, (s.data as { place?: string }).place, s.source, s.created_by], [true, "arms", "shortcut", alpha.member], "in arms");
    eq(r.speak, `Sleep timer started at ${clock(s.started_at as string, alpha.tz)}, in arms.`, "said, with no sweet dreams");
    const again = await siri(T(alpha).member, { action: "asleep_in_arms", client_id: "made-up-arms-1" });
    eq([again.speak, again.deduped, (await sleepsOf(alpha)).length], [r.speak, true, 1], "the retry");
    const other = await siri(T(alpha).owner, { action: "asleep_in_arms" });
    eq([other.speak, (await sleepsOf(alpha)).length], [`A sleep timer is already running, since ${clock(s.started_at as string, alpha.tz)}.`, 1], "already running");
    await reset(alpha);
    const feed = await runningFeed(alpha, alpha.owner, 25);
    const f = await siri(T(alpha).owner, { action: "asleep_in_arms", minutes_ago: 5 });
    const fe = (await getEntry(1, feed.id))!;
    const [s2] = await sleepsOf(alpha);
    eq([fe.active, near(fe.ended_at, Date.now() - 5 * MIN), near((await getEntry(1, Number(s2.id)))!.started_at, Date.now() - 5 * MIN)], [false, true, true], "the feed ended when she fell asleep");
    ok(f.speak.startsWith("Feed stopped and sleep timer started at "), f.speak);
  });

  await test("asleep_in_arms: while a try runs she's in the bassinet, so it points to picked up and saves nothing", async () => {
    await reset(alpha);
    await siri(T(alpha).owner, { action: "put_down" });
    const r = await siri(T(alpha).owner, { action: "asleep_in_arms" });
    ok(!r.ok && r.speak.startsWith("A bassinet try is running, since ") && r.speak.endsWith("If you picked her up still asleep, say picked up."), r.speak);
    eq((await sleepsOf(alpha)).length, 1, "no second sleep");
  });

  // ── handoff ────────────────────────────────────────────────────────────

  await test("handoff: the holder hands to the other adult, the other adult takes it, the next turn keeps the planned length, and it says who has her", async () => {
    await reset(alpha);
    const start = new Date(Date.now() - 60 * MIN);
    await startShift(1, { babyId: alpha.babyId, holder: alpha.owner, at: start, handoffAt: new Date(start.getTime() + 90 * MIN), by: alpha.owner, source: "web" });
    const before = hooks.length;
    const r = await siri(T(alpha).owner, { action: "handoff" });
    const open = (await openShift(1, alpha.babyId))!;
    eq([open.holder, open.source, open.created_by, open.next_holder], [alpha.member, "shortcut", alpha.owner, alpha.owner], "Blake has her, Avery is next");
    ok(near(open.handoff_at, Date.now() + 90 * MIN), "the next handoff is as long as the last one was planned");
    eq(r.speak, `Blake has her now, next handoff at ${clock(open.handoff_at!, alpha.tz)}.`, "said");
    ok(hooks.length > before, "re-armed");
    const twice = await siri(T(alpha).owner, { action: "handoff" });
    eq([twice.speak, (await openShift(1, alpha.babyId))!.holder], ["Already handed off: Blake has her now.", alpha.member], "a second tap never hands her back");
    // The one holding her now can hand back at once (to the turn's planned next: Avery): it's their handoff, not a repeat.
    const back = await siri(T(alpha).member, { action: "handoff" });
    eq([back.speak.startsWith("Avery has her now, next handoff at "), (await openShift(1, alpha.babyId))!.holder], [true, alpha.owner], "back to Avery");
    // Taking over: the one who says it, when they aren't holding her.
    await reset(alpha);
    await startShift(1, { babyId: alpha.babyId, holder: alpha.owner, by: alpha.owner, source: "web" });
    const take = await siri(T(alpha).member, { action: "handoff" });
    eq([take.speak.startsWith("You have her now"), (await openShift(1, alpha.babyId))!.holder], [true, alpha.member], "Blake took her");
  });

  await test("handoff: no turn says so; with more than one other adult and nobody planned next it asks for the app", async () => {
    await reset(beta);
    eq((await siri(T(beta).owner, { action: "handoff" })).speak, "Nobody is on a holding turn right now.", "no turn");
    await sql(`INSERT INTO maple_members (family_id, email, role, display_name, added_by, accepted_at) VALUES (2, 'third.beta@example.com', 'member', 'Harper', 'self', NOW())`);
    await startShift(2, { babyId: beta.babyId, holder: beta.owner, by: beta.owner, source: "web" });
    const r = await siri(T(beta).owner, { action: "handoff" });
    eq([r.ok, r.speak, (await openShift(2, beta.babyId))!.holder], [false, "Who's taking over? Hand off in the app.", beta.owner], "unclear, nothing saved");
    await sql(`UPDATE maple_sleep_shifts SET next_holder = 'third.beta@example.com' WHERE family_id = 2 AND ended_at IS NULL`);
    const planned = await siri(T(beta).owner, { action: "handoff" });
    eq([planned.speak.startsWith("Harper has him now"), (await openShift(2, beta.babyId))!.holder], [true, "third.beta@example.com"], "the planned next one");
    await sql(`DELETE FROM maple_members WHERE family_id = 2 AND email = 'third.beta@example.com'`);
    await reset(beta);
  });

  // ── checkin ────────────────────────────────────────────────────────────

  await test("checkin: the speaker's own for last night by the family's calendar; again changes it; a retry is deduped; no answer asks", async () => {
    for (const f of [alpha, beta]) {
      await reset(f);
      const r = await siri(T(f).member, { action: "checkin", answer: "partly", client_id: `made-up-checkin-${f.familyId}` });
      eq(r.speak, "Checked in for last night: partly.", `${f.name} said`);
      eq(await checkinsOf(f), [{ member: f.member, night: lastNightKey(new Date(), f.tz), protected: "partly", source: "shortcut", deleted_at: null }], `${f.name}: theirs, last night in ${f.tz}`);
      const retry = await siri(T(f).member, { action: "checkin", answer: "partly", client_id: `made-up-checkin-${f.familyId}` });
      eq([retry.speak, retry.deduped], [r.speak, true], "the retry");
      eq((await siri(T(f).member, { action: "checkin", answer: "Not this time" })).speak, "Changed your check-in for last night to not this time.", "changed");
      eq((await siri(T(f).member, { action: "checkin", answer: "no" })).speak, "Your check-in for last night already says not this time.", "unchanged");
      eq((await checkinsOf(f)).length, 1, "one per adult per night");
    }
    const ask = await siri(T(alpha).owner, { action: "checkin" });
    // The app's own question (CHECKIN_QUESTION), never "hold", which is a holding turn's word.
    eq([ask.ok, ask.speak, (ask.choices as { id: string }[]).map((c) => c.id)], [false, "Did you get your protected sleep last night? Yes, partly or not this time?", ["yes", "partly", "no"]], "asks");
    eq((await checkinsOf(alpha)).filter((c) => c.member === alpha.owner).length, 0, "the owner's isn't saved by asking");
  });

  // ── sleep and wake with minutes_ago ────────────────────────────────────

  await test("sleep and wake take minutes_ago in the family's zone; a wake before the sleep began is refused; a retry is the same save; one already running is said", async () => {
    await reset(beta);
    const s = await siri(T(beta).owner, { action: "sleep", minutes_ago: 30, client_id: "made-up-sleep-1" });
    const [row] = await sleepsOf(beta);
    const e = (await getEntry(2, Number(row.id)))!;
    ok(near(e.started_at, Date.now() - 30 * MIN), "started 30 minutes ago");
    eq(s.speak, `Sleep timer started at ${clock(e.started_at, beta.tz)}. Sweet dreams, Ro.`, "said in Los Angeles time");
    eq((await siri(T(beta).owner, { action: "sleep", minutes_ago: 30, client_id: "made-up-sleep-1" })).speak, s.speak, "the retry");
    eq((await siri(T(beta).member, { action: "sleep" })).speak, `A sleep timer is already running, since ${clock(e.started_at, beta.tz)}.`, "already running");
    const early = await siri(T(beta).owner, { action: "wake", minutes_ago: 45 });
    eq([early.status, early.speak], [400, `That's before the sleep timer started at ${clock(e.started_at, beta.tz)}, so nothing was changed.`], "before it began");
    eq([(await siri(T(beta).owner, { action: "wake", minutes_ago: 999 })).status, (await getEntry(2, e.id))?.active], [400, true], "up to 4 hours");
    const w = await siri(T(beta).owner, { action: "wake", minutes_ago: 10 });
    const after = (await getEntry(2, e.id))!;
    eq([after.active, near(after.ended_at, Date.now() - 10 * MIN)], [false, true], "ended 10 minutes ago");
    ok(w.speak.startsWith("Stopped. Slept · 20m"), w.speak);
    await reset(beta);
  });

  await test("wake with a try on that sleep: the try stays open and the reply says so; the outcome then ends it when she woke", async () => {
    await reset(alpha);
    await siri(T(alpha).owner, { action: "put_down", minutes_ago: 40 });
    const w = await siri(T(alpha).owner, { action: "wake", minutes_ago: 5 });
    ok(w.speak.endsWith(" The bassinet try is still open: say how it went."), w.speak);
    const o = await siri(T(alpha).owner, { action: "outcome", outcome: "stayed_asleep" });
    eq(o.speak, "Stayed asleep for 35 minutes.", "ends when she woke, and the sleep was already stopped");
    ok(near((await tries(alpha))[0].ended_at, Date.now() - 5 * MIN), "when she woke");
  });

  // ── undo ───────────────────────────────────────────────────────────────

  await test("undo put_down: the try and the sleep it made go, and the holding turn it ended comes back", async () => {
    await reset(alpha);
    const shift = (await startShift(1, { babyId: alpha.babyId, holder: alpha.member, by: alpha.member, source: "web" })).shift;
    await siri(T(alpha).member, { action: "put_down" });
    const [t] = await tries(alpha);
    const u = await siri(T(alpha).member, { action: "undo" });
    eq(u.speak, `Undone: the bassinet try from ${clock(t.started_at as string, alpha.tz)} is gone, with the sleep it started. The holding turn is back on.`, "said");
    eq([(await tries(alpha))[0].deleted_at !== null, (await sleepsOf(alpha))[0].deleted_at !== null], [true, true], "both gone");
    const back = (await getShift(1, shift.id))!;
    eq([back.ended_at, back.ended_how], [null, null], "the turn is open again");
    // Saying it again takes nothing more back.
    const again = await siri(T(alpha).member, { action: "undo" });
    eq([again.ok, again.speak], [false, "Your newest change was to the holding turn, so nothing was undone. Fix it in the app."], "one thing per undo");
  });

  await test("undo put_down on a running sleep: only the try goes; her sleep runs on", async () => {
    await reset(alpha);
    const sleep = await runningSleep(alpha, alpha.owner);
    await siri(T(alpha).owner, { action: "put_down" });
    const u = await siri(T(alpha).owner, { action: "undo" });
    ok(u.ok && !u.speak.includes("with the sleep"), u.speak);
    eq([(await getEntry(1, sleep.id))?.active, (await runningTry(1, alpha.babyId)) === null], [true, true], "her sleep stays, the try is gone");
  });

  await test("undo outcome: the try runs again with the sleep timer it stopped; after picked up her sleep goes back to the bassinet", async () => {
    await reset(alpha);
    await siri(T(alpha).owner, { action: "put_down", minutes_ago: 20 });
    await siri(T(alpha).member, { action: "outcome", outcome: "woke_calm" });
    const u = await siri(T(alpha).member, { action: "undo" });
    eq(u.speak, "Undone: the bassinet try is running again, and so is the sleep timer.", "said");
    const t = (await runningTry(1, alpha.babyId))!;
    eq([t.outcome, (await getEntry(1, t.sleep_entry_id!))?.active], [null, true], "both running");
    await siri(T(alpha).member, { action: "outcome", outcome: "picked_up" });
    eq((((await getEntry(1, t.sleep_entry_id!))!).data as { place?: string }).place, "arms", "in arms");
    const u2 = await siri(T(alpha).member, { action: "undo" });
    eq(u2.speak, "Undone: the bassinet try is running again.", "said");
    const s = (await getEntry(1, t.sleep_entry_id!))!;
    eq([(await runningTry(1, alpha.babyId))?.id, s.active, (s.data as { place?: string }).place], [t.id, true, "bassinet"], "back in the bassinet");
  });

  await test("undo asleep_in_arms and sleep: the sleep goes and the feed it stopped runs again", async () => {
    for (const action of ["asleep_in_arms", "sleep"]) {
      await reset(alpha);
      const feed = await runningFeed(alpha, alpha.owner, 15);
      await siri(T(alpha).owner, { action });
      eq((await getEntry(1, feed.id))?.active, false, `${action} stopped the feed`);
      const [s] = await sleepsOf(alpha);
      const u = await siri(T(alpha).owner, { action: "undo" });
      eq(u.speak, `Undone: the sleep timer from ${clock(s.started_at as string, alpha.tz)} is gone, and the nursing timer is running again.`, `${action} said`);
      eq([(await sleepsOf(alpha))[0].deleted_at !== null, (await getEntry(1, feed.id))?.active, Number(s.id) > 0], [true, true, true], `${action} undone`);
    }
  });

  await test("undo handoff: the one who handed over has her again", async () => {
    await reset(beta);
    const first = (await startShift(2, { babyId: beta.babyId, holder: beta.owner, by: beta.owner, source: "web" })).shift;
    await siri(T(beta).member, { action: "handoff" });
    const second = (await openShift(2, beta.babyId))!;
    eq(second.holder, beta.member, "Finley took him");
    const before = hooks.length;
    const u = await siri(T(beta).member, { action: "undo" });
    eq(u.speak, "Undone: Emery has him again.", "said");
    const open = (await openShift(2, beta.babyId))!;
    eq([open.id, open.holder, (await getShift(2, second.id)) === null], [first.id, beta.owner, true], "the first turn is open again; the second is gone");
    ok(hooks.length > before, "re-armed");
    await reset(beta);
  });

  await test("undo checkin: a new one goes; a changed one stays and says so", async () => {
    await reset(alpha);
    await siri(T(alpha).owner, { action: "checkin", answer: "yes" });
    eq((await siri(T(alpha).owner, { action: "undo" })).speak, "Undone: your check-in for last night is gone.", "said");
    eq((await checkinsOf(alpha))[0].deleted_at !== null, true, "deleted");
    await reset(alpha);
    await app(alpha.owner, 1, { action: "checkin.save", protected: "yes", client_id: "made-up-app-checkin-1" });
    await siri(T(alpha).owner, { action: "checkin", answer: "partly" });
    const u = await siri(T(alpha).owner, { action: "undo" });
    eq([u.ok, u.speak], [false, "Your check-in for last night was a change, so it stays partly. Check in again to change it."], "explained");
    eq((await checkinsOf(alpha)).map((c) => [c.protected, c.deleted_at]), [["partly", null]], "kept");
  });

  await test("undo something else Siri logged, and a wake: a diaper goes; the sleep it stopped runs again", async () => {
    await reset(beta);
    const pee = await siri(T(beta).owner, { action: "pee" });
    const diaper = pee.entry as { started_at: string };
    eq((await siri(T(beta).owner, { action: "undo" })).speak, `Undone: the wet diaper at ${clock(diaper.started_at, beta.tz)} is gone.`, "a diaper");
    await reset(beta);
    const sleep = await runningSleep(beta, beta.owner, 50);
    await siri(T(beta).owner, { action: "wake" });
    const u = await siri(T(beta).owner, { action: "undo" });
    eq([u.speak, (await getEntry(2, sleep.id))?.active], ["Undone: the sleep timer is running again.", true], "the wake is taken back");
    // A feed Siri started stopped the sleep: undoing the feed brings the sleep back.
    const nurse = await siri(T(beta).owner, { action: "nurse_left" });
    eq((await getEntry(2, sleep.id))?.active, false, "the feed stopped the sleep");
    const u2 = await siri(T(beta).owner, { action: "undo" });
    eq(u2.speak, `Undone: the nursing timer from ${clock((nurse.entry as { started_at: string }).started_at, beta.tz)} is gone, and the sleep timer is running again.`, "said");
    eq([(await getEntry(2, sleep.id))?.active, await getEntry(2, (nurse.entry as { id: number }).id)], [true, null], "the sleep runs, the feed is gone");
    await reset(beta);
  });

  await test("undo: a medicine logged with Siri on her page is newer, so nothing of Maple's is taken back for it", async () => {
    await reset(alpha);
    await siri(T(alpha).owner, { action: "put_down" });
    const dose = await siri(T(alpha).owner, { action: "mom_dose", med: "Ibuprofen" });
    eq(dose.ok, true, JSON.stringify(dose));
    const u = await siri(T(alpha).owner, { action: "undo" });
    eq([u.ok, u.speak], [false, "Your newest change was to Dana's medicines, so nothing was undone. Fix it in the app."], "said");
    ok(await runningTry(1, alpha.babyId), "the try stays");
    await reset(alpha);
  });

  await test("undo stops at a newer change of theirs (a switch), at someone else's change since, and with nothing to undo", async () => {
    await reset(alpha);
    await siri(T(alpha).member, { action: "nurse_left" });
    await siri(T(alpha).member, { action: "switch" });
    const blocked = await siri(T(alpha).member, { action: "undo" });
    eq([blocked.ok, blocked.speak], [false, "Your newest change was to the nursing timer, so nothing was undone. Fix it in the app."], "a switch has no voice undo");
    eq((await activeTimers(1, alpha.babyId)).map((e) => (e.data as FeedData).last_side), ["R"], "the feed is as it was");
    await reset(alpha);
    await siri(T(alpha).member, { action: "put_down" });
    const t = (await runningTry(1, alpha.babyId))!;
    const fin = await app(alpha.owner, 1, { action: "try.finish", id: t.id, outcome: "woke_calm", expect_updated_at: t.updated_at });
    eq(fin.status, 200, "Avery finished it in the app");
    const changed = await siri(T(alpha).member, { action: "undo" });
    eq([changed.status, changed.speak], [409, "That bassinet try changed since, so nothing was undone. Fix it in the app."], "someone else's change since");
    eq((await getTry(1, t.id))?.outcome, "woke_calm", "kept");
    await reset(alpha);
    eq((await siri(T(alpha).member, { action: "undo" })).speak, "There's nothing from Siri in the last 30 minutes to undo.", "nothing");
  });

  await test("undo keeps a sleep Siri started once someone's bassinet try sits on it", async () => {
    await reset(alpha);
    await siri(T(alpha).member, { action: "sleep" });
    await app(alpha.owner, 1, { action: "try.start", client_id: "made-up-app-try-on-siri-sleep" });
    const t = (await runningTry(1, alpha.babyId))!;
    const u = await siri(T(alpha).member, { action: "undo" });
    eq([u.status, u.speak], [409, "A bassinet try sits on that sleep now, so nothing was undone. Fix it in the app."], "said");
    eq([(await getEntry(1, t.sleep_entry_id!))?.active, t.made_sleep], [true, false], "the sleep stays under the try");
  });

  await test("undo never reaches another family or another person", async () => {
    await reset(alpha);
    await reset(beta);
    await siri(T(alpha).owner, { action: "put_down" });
    await siri(T(alpha).member, { action: "poop" });
    eq((await siri(T(beta).owner, { action: "undo" })).speak, "There's nothing from Siri in the last 30 minutes to undo.", "beta has nothing of alpha's");
    const u = await siri(T(alpha).owner, { action: "undo" });
    ok(u.speak.startsWith("Undone: the bassinet try"), `the owner's own, not the member's newer diaper: ${u.speak}`);
    eq((await sql(`SELECT deleted_at FROM maple_entries WHERE family_id = 1 AND kind = 'diaper' AND source = 'shortcut'`))[0].deleted_at, null, "the member's diaper stays");
  });

  // ── "Maple status" ─────────────────────────────────────────────────────

  await test("status: one sleep line for a running try (never 'a sleep timer is running' too), else who's holding her; none without sleep rows", async () => {
    await reset(beta);
    const plain = await siri(T(beta).owner, { action: "status" });
    ok(!/bassinet|holding|check-in/.test(plain.speak), `as before: ${plain.speak}`);
    await siri(T(beta).owner, { action: "put_down", minutes_ago: 25 });
    const t = (await runningTry(2, beta.babyId))!;
    const s = await siri(T(beta).viewer, { action: "status" });
    ok(s.speak.includes(`Ro has been in the bassinet 25 minutes, since ${clock(t.started_at, beta.tz)}, ${(await labelOf(beta, t)).replace(/^Try/, "try")}.`), s.speak);
    ok(!s.speak.includes("A sleep timer is running"), `said once: ${s.speak}`);
    eq((s.speak.match(/bassinet/g) ?? []).length, 1, "one sleep line");
    await reset(beta);
    await startShift(2, { babyId: beta.babyId, holder: beta.member, at: new Date(Date.now() - 30 * MIN), handoffAt: new Date(Date.now() + 60 * MIN), by: beta.member, source: "web" });
    const h = await siri(T(beta).owner, { action: "status" });
    const sh = (await openShift(2, beta.babyId))!;
    ok(h.speak.includes(`Finley has been holding him since ${clock(sh.started_at, beta.tz)}; handoff at ${clock(sh.handoff_at!, beta.tz)}.`), h.speak);
    const mine = await siri(T(beta).member, { action: "status" });
    ok(mine.speak.includes(`You've been holding him since ${clock(sh.started_at, beta.tz)}`), mine.speak);
    const fam1 = await siri(T(alpha).owner, { action: "status" });
    ok(!fam1.speak.includes("holding"), "alpha hears nothing of beta's turn");
    await reset(beta);
  });

  await test("status: an adult's check-in for last night is said while it's due, by Today's rule, and not once they've checked in", async () => {
    await reset(alpha);
    const night = lastNightKey(new Date(), alpha.tz);
    const roster = [{ id: "w1", member: alpha.member, from: "22:00", to: "02:00", nights: [0, 1, 2, 3, 4, 5, 6] }];
    await sql(
      `INSERT INTO maple_sleep_goals (family_id, baby_id, title, status, roster, item_seq, created_by, created_at, updated_at) VALUES (1, $1, 'Made-up goal', 'active', $2::jsonb, 1, $3, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')`,
      [alpha.babyId, JSON.stringify(roster), alpha.owner]
    );
    const goal = (await sql(`SELECT * FROM maple_sleep_goals WHERE family_id = 1`))[0];
    const asApp = checkinDue({ goals: [goalOf({ id: Number(goal.id), created: new Date(goal.created_at as string).toISOString(), roster })], checkins: [], me: alpha.member, role: "member", now: new Date(), tz: alpha.tz });
    const s = await siri(T(alpha).member, { action: "status" });
    eq(s.speak.includes("Your sleep check-in for last night is due."), asApp?.night === night, `as Today would ask (${asApp ? "due" : "not due"} now): ${s.speak}`);
    ok(!(await siri(T(alpha).owner, { action: "status" })).speak.includes("check-in"), "only the adult on the roster");
    ok(!(await siri(T(alpha).viewer, { action: "status" })).speak.includes("check-in"), "never a viewer");
    await siri(T(alpha).member, { action: "checkin", answer: "yes" });
    ok(!(await siri(T(alpha).member, { action: "status" })).speak.includes("check-in"), "not once they've checked in");
  });

  await test("the check-in rule matches the app's checkinDue across mornings, windows, zones and goals", () => {
    let cases = 0;
    for (const tz of ["America/Chicago", "Pacific/Auckland", "Europe/London"]) {
      const today = dayKey(new Date("2026-11-04T18:00:00Z"), tz);
      const night = addDays(today, -1);
      const [y, m, d] = today.split("-").map(Number);
      const at = (h: number, min = 0) => zonedTimeToUtc(y, m, d, h, min, tz);
      const created = "2026-10-30T18:00:00.000Z";
      const createdToday = at(1).toISOString();
      const me = "sam.made-up@example.com";
      const nightDay = new Date(`${night}T12:00:00Z`).getUTCDay();
      const w = (from: string, to: string, nights = [nightDay]): RosterWindow => ({ id: `w${from}`, member: me, from, to, nights });
      const goalsSets: SleepGoal[][] = [
        [],
        [goalOf({ id: 1, created, roster: [w("22:00", "02:00")] })],
        [goalOf({ id: 2, created, roster: [w("03:00", "07:30")] })],
        [goalOf({ id: 3, created, roster: [w("22:00", "02:00", [(nightDay + 1) % 7])] })],
        [goalOf({ id: 4, created, target: me })],
        [goalOf({ id: 5, created, target: me, roster: [w("22:00", "02:00", [(nightDay + 1) % 7])] })],
        [goalOf({ id: 6, created, status: "paused", roster: [w("22:00", "02:00")] })],
        [goalOf({ id: 7, created: createdToday, roster: [w("22:00", "02:00")] })],
        [goalOf({ id: 8, created, roster: [{ ...w("22:00", "02:00"), member: "someone.else@example.com" }] })],
      ];
      const checkinSets: SleepCheckin[][] = [[], [{ id: 1, member: me, night, protected: "yes", note: null, source: "web", created_at: created, updated_at: created }]];
      for (const goals of goalsSets)
        for (const checkins of checkinSets)
          for (const role of ["owner", "member", "viewer"] as Role[])
            for (const now of [at(4, 59), at(5), at(7, 29), at(7, 31), at(11)]) {
              const o = { goals, checkins, me, role, now, tz };
              eq(checkinDueNight(o), checkinDue(o)?.night ?? null, `${tz} ${now.toISOString()} goals ${goals.map((g) => g.id)} ${role} checkins ${checkins.length}`);
              cases++;
            }
    }
    ok(cases > 700, `${cases} cases`);
    // And it does say due somewhere, and not due somewhere.
    const due = checkinDueNight({ goals: [goalOf({ id: 4, created: "2026-10-01T12:00:00Z", target: "x@example.com" })], checkins: [], me: "x@example.com", role: "member", now: new Date("2026-11-04T15:00:00Z"), tz: "America/Chicago" });
    eq(due, "2026-11-03", "due at 9 AM in Chicago");
  });

  done("quick-sleep.check.ts");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
