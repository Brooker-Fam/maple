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
import { activeTimers, getEntry, startTimer, stopTimer, updateEntry } from "../../src/lib/maple/store";
import { addDays, dayKey, formatTime, localParts, zonedTimeToUtc } from "../../src/lib/maple/time";
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

// Notifications are caught here; a hook only queues (holdingChanged's re-arm is checked by count, and run where a test needs its notice).
type Sent = { endpoint: string; title: string; tag: string; body: string };
const sent: Sent[] = [];
(webpush as unknown as { sendNotification: unknown }).sendNotification = async (sub: { endpoint: string }, payload: string) => {
  const p = JSON.parse(payload) as { title: string; tag: string; body: string };
  sent.push({ endpoint: sub.endpoint, title: p.title, tag: p.tag, body: p.body });
  return { statusCode: 201, body: "", headers: {} };
};
const hooks: (() => Promise<void>)[] = [];
setLaterRunner((t) => void hooks.push(t));
/** Run the hooks queued since `from` (holdingChanged's notices), as after() would once the answer is sent. */
const runHooks = async (from: number) => {
  for (const h of hooks.slice(from)) await h();
};

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

/** Each case starts from a family with nothing but its seed: no tries, turns, check-ins, goals or new entries, and no Siri action kept for Undo. */
async function reset(f: FamilySeed) {
  for (const t of ["maple_sleep_tries", "maple_sleep_shifts", "maple_sleep_checkins", "maple_sleep_goals", "maple_sleep_plans"]) await sql(`DELETE FROM ${t} WHERE family_id = $1`, [f.familyId]);
  await sql(`DELETE FROM maple_entries WHERE family_id = $1 AND id <> ALL($2::bigint[])`, [f.familyId, [f.entries.diaper, f.entries.feed, f.entries.moment]]);
  await sql(`DELETE FROM maple_care_entries WHERE family_id = $1 AND source = 'shortcut'`, [f.familyId]);
  await sql(`UPDATE maple_tokens SET last_act = NULL WHERE family_id = $1`, [f.familyId]);
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

  await test("put_down said with a time over a try already logged runs Log an earlier try's twin check: nothing saved; a retry of its own request is still its first answer", async () => {
    await reset(alpha);
    await siri(T(alpha).owner, { action: "put_down", minutes_ago: 60 });
    await siri(T(alpha).owner, { action: "outcome", outcome: "stayed asleep", minutes_ago: 20 });
    const [first] = await tries(alpha);
    // Overlapping it (laid down 45 minutes ago, while that try ran until 20 minutes ago): the same try, said twice.
    const twin = await siri(T(alpha).member, { action: "put_down", minutes_ago: 45 });
    eq([twin.ok, twin.speak, twin.duplicate], [false, `A try from ${clock(first.started_at as string, alpha.tz)} is already logged; nothing saved.`, true], "said, nothing saved");
    // Starting within 3 minutes of it counts too.
    const close = await siri(T(alpha).member, { action: "put_down", minutes_ago: 62 });
    eq(close.ok, false, "within 3 minutes of its start");
    eq([(await tries(alpha)).length, (await sleepsOf(alpha)).length], [1, 1], "one try, one sleep");
    // After it ended, a new one: saved. (Its number depends on the try day, noon to noon: just after noon it's the first of a new one.)
    const later = await siri(T(alpha).member, { action: "put_down", minutes_ago: 10 });
    const newest = (await listTries(1, alpha.babyId, { from: new Date(Date.now() - 2 * HOUR) }))[0];
    eq([later.ok, later.speak], [true, `${await labelOf(alpha, newest)}, down at ${clock(newest.started_at, alpha.tz)}.`], "a new try, numbered from the log");
    ok(/^Try [12] [\w ]+, down at \d{1,2}:\d\d\.$/.test(later.speak), later.speak);
    eq((await tries(alpha)).length, 2, "a new try after the first ended");
    // A Shortcut retrying its own backdated put down gets its first answer, never "already logged".
    await reset(alpha);
    const a = await siri(T(alpha).owner, { action: "put_down", minutes_ago: 30, client_id: "made-up-backdated-1" });
    const again = await siri(T(alpha).owner, { action: "put_down", minutes_ago: 30, client_id: "made-up-backdated-1" });
    eq([again.ok, again.speak, again.deduped, (await tries(alpha)).length], [true, a.speak, true, 1], "the retry");
  });

  await test("crying: the outcome ends with the app's line; after the retry, put_down says the plan pauses until the next try, and said again within two minutes it goes ahead", async () => {
    await reset(beta);
    await siri(T(beta).owner, { action: "put_down", minutes_ago: 45 });
    const c1 = await siri(T(beta).owner, { action: "outcome", outcome: "woke crying", minutes_ago: 25 });
    eq(c1.speak, "Woke crying after 20 minutes. Sleep timer stopped. Soothe him; try once more when he's deeply asleep.", "soothe, then one retry");
    const retry = await siri(T(beta).owner, { action: "put_down", minutes_ago: 10 });
    ok(/, a retry, down at /.test(retry.speak), retry.speak);
    const c2 = await siri(T(beta).member, { action: "outcome", outcome: "woke_crying" });
    eq(c2.speak, "Woke crying after 10 minutes. Sleep timer stopped. Pause until the next try.", "after the retry: pause");
    const third = await siri(T(beta).member, { action: "put_down" });
    // Holding him through the pause is for an adult who's awake: sleepy, the bassinet comes first (in the family's words).
    eq(
      [third.ok, third.speak, third.pause],
      [false, "The plan says pause until the next try, unless you're getting sleepy: then lay him on his back in the bassinet. Say it again to try anyway.", true],
      "the plan's pause first"
    );
    eq((await tries(beta)).length, 2, "nothing saved");
    // Said again within two minutes (by anyone): it goes ahead, a retry like the app's soft Put down.
    const anyway = await siri(T(beta).owner, { action: "put_down" });
    // (Its number depends on the try day, noon to noon, so it's read from the log.)
    const newest = (await listTries(2, beta.babyId, { from: new Date(Date.now() - 2 * HOUR) }))[0];
    eq([anyway.ok, anyway.speak], [true, `${await labelOf(beta, newest)}, down at ${clock(newest.started_at, beta.tz)}.`], "saved");
    ok(/, a retry, down at /.test(anyway.speak), anyway.speak);
    eq((await tries(beta)).length, 3, "saved");
    // The try's own row keeps when Siri said pause; its updated_at (and so Undo and the phones' change token) didn't move for it.
    const [retryRow] = await sql(`SELECT pause_said_at, updated_at FROM maple_sleep_tries WHERE family_id = 2 ORDER BY started_at DESC OFFSET 1 LIMIT 1`);
    ok(retryRow.pause_said_at && new Date(retryRow.updated_at as string).getTime() < new Date(retryRow.pause_said_at as string).getTime(), JSON.stringify(retryRow));
    // Undo takes back that try; the pause holds again, and a pause said over two minutes ago is said again.
    await siri(T(beta).owner, { action: "undo" });
    await sql(`UPDATE maple_sleep_tries SET pause_said_at = NOW() - INTERVAL '3 minutes' WHERE family_id = 2 AND pause_said_at IS NOT NULL`);
    eq((await siri(T(beta).owner, { action: "put_down" })).pause, true, "a pause said 3 minutes ago is said again");
    eq((await tries(beta)).filter((x) => x.deleted_at == null).length, 2, "nothing saved by it");
    await reset(beta);
  });

  // ── outcome ────────────────────────────────────────────────────────────

  await test("outcome: woke crying ends the try and its sleep then; picked up leaves her asleep in arms", async () => {
    await reset(alpha);
    await siri(T(alpha).owner, { action: "put_down", minutes_ago: 25 });
    const r = await siri(T(alpha).member, { action: "outcome", outcome: "woke crying" });
    const tr = (await getTry(1, Number((await tries(alpha))[0].id)))!;
    // The app's own crying line ends it (cryingLine after_crying), as the outcome's toast and the strip say it.
    eq([tr.outcome, tr.updated_by, r.speak], ["woke_crying", alpha.member, "Woke crying after 25 minutes. Sleep timer stopped. Soothe her; try once more when she's deeply asleep."], "said");
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
    eq(r.speak, `Sleep timer started at ${clock(s.started_at as string, alpha.tz)}, in arms. If you start to feel sleepy, lay her on her back in the bassinet.`, "said, with no sweet dreams, and the bassinet if sleepy");
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
    ok(f.speak.startsWith("Feed stopped and sleep timer started at ") && f.speak.endsWith(", in arms. If you start to feel sleepy, lay her on her back in the bassinet."), f.speak);
    // Beta's words: his name and pronouns.
    await reset(beta);
    ok((await siri(T(beta).owner, { action: "asleep_in_arms" })).speak.endsWith("If you start to feel sleepy, lay him on his back in the bassinet."), "beta's pronouns");
    await reset(beta);
  });

  await test("asleep_in_arms: while a try runs she's in the bassinet, so it points to picked up and saves nothing", async () => {
    await reset(alpha);
    await siri(T(alpha).owner, { action: "put_down" });
    const r = await siri(T(alpha).owner, { action: "asleep_in_arms" });
    ok(!r.ok && r.speak.startsWith("A bassinet try is running, since ") && r.speak.endsWith("If you picked her up still asleep, say picked up."), r.speak);
    eq((await sleepsOf(alpha)).length, 1, "no second sleep");
  });

  // ── handoff ────────────────────────────────────────────────────────────

  await test("handoff from the holder only asks: nothing changes hands, the asked person's phone with handoff reminders on hears Handoff now (nobody else's), and it says to go wake them", async () => {
    await reset(alpha);
    // Avery (holding her) and Blake (the one asked) both turned handoff reminders on: only Blake's phone hears the ask.
    await sql(`UPDATE maple_push_subs SET prefs = '{"meds":true,"handoff":true}'::jsonb WHERE id = $1`, [alpha.pushSubId]);
    const blakePhone = "https://push.example.test/alpha-blake-quick";
    await sql(`INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, prefs, receipt_token) VALUES (1, $1, $2, 'k', 'a', '{"handoff":true}', $3)`, [alpha.member, blakePhone, "e".repeat(32)]);
    const start = new Date(Date.now() - 60 * MIN);
    const t = (await startShift(1, { babyId: alpha.babyId, holder: alpha.owner, at: start, handoffAt: new Date(start.getTime() + 90 * MIN), by: alpha.owner, source: "web" })).shift;
    const before = hooks.length;
    sent.length = 0;
    const r = await siri(T(alpha).owner, { action: "handoff" });
    eq([r.ok, r.speak], [true, "Asked Blake to take over. Blake's phone only sounds if handoff reminders are on, so go wake Blake. Getting sleepy? Put her on her back in the bassinet."], "said, with the bassinet if sleepy");
    const open = (await openShift(1, alpha.babyId))!;
    eq([open.id, open.holder, open.asked_to, open.ended_at], [t.id, alpha.owner, alpha.member, null], "an ask: Avery still holds her");
    eq((await shifts(alpha)).length, 1, "no second turn");
    await runHooks(before);
    const now1 = sent.filter((x) => x.title === "Handoff now");
    eq(now1.map((x) => [x.endpoint, x.tag]), [[blakePhone, `handoff:${t.id}`]], "Blake's phone hears it; Avery's, holding her, doesn't");
    ok(sent.every((x) => !/Avery|Blake|Casey|June|Dana/.test(`${x.title} ${x.body}`)), `names no one: ${JSON.stringify(sent)}`);
    // Said again at once (Back Tap twice, a retry): the ask stands, and no second notice.
    const b2 = hooks.length;
    sent.length = 0;
    const again = await siri(T(alpha).owner, { action: "handoff" });
    eq([again.speak, again.already_asked], [`Already asked Blake at ${clock(open.asked_at!, alpha.tz)}. Blake's phone only sounds if handoff reminders are on, so go wake Blake. Getting sleepy? Put her on her back in the bassinet.`, true], "said once more, not asked twice");
    await runHooks(b2);
    eq(sent.filter((x) => x.title === "Handoff now").length, 0, "no second notice");
    eq((await openShift(1, alpha.babyId))!.asked_at, open.asked_at, "the ask's time stays");
    // Three minutes on with nobody there: asking again sounds again.
    await sql(`UPDATE maple_sleep_shifts SET asked_at = asked_at - INTERVAL '3 minutes', updated_at = updated_at - INTERVAL '3 minutes' WHERE id = $1`, [t.id]);
    const b3 = hooks.length;
    const third = await siri(T(alpha).owner, { action: "handoff" });
    ok(third.speak.startsWith("Asked Blake again to take over."), third.speak);
    await runHooks(b3);
    eq(sent.filter((x) => x.title === "Handoff now").map((x) => x.endpoint), [blakePhone], "asked again: heard again, on Blake's phone");
    await sql(`UPDATE maple_push_subs SET prefs = '{"meds":true}'::jsonb WHERE id = $1`, [alpha.pushSubId]);
    await sql(`DELETE FROM maple_push_subs WHERE endpoint = $1`, [blakePhone]);
  });

  await test("handoff from anyone else takes the turn as it is now: they have her, with the next handoff as long as the last one and the catch-up; a second tap never hands her back", async () => {
    await reset(alpha);
    // A feed on the left that ended 40 minutes ago, and a wet diaper 20 minutes ago.
    const feedId = await finishedFeed(alpha, 40, alpha.owner);
    const fedAt = (await getEntry(1, feedId))!.started_at;
    const diaperAt = new Date(Date.now() - 20 * MIN).toISOString();
    await sql(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, data, created_by) VALUES (1, $1, 'diaper', $2, '{"pee":true}', $3)`, [alpha.babyId, diaperAt, alpha.owner]);
    const start = new Date(Date.now() - 60 * MIN);
    const t = (await startShift(1, { babyId: alpha.babyId, holder: alpha.owner, at: start, handoffAt: new Date(start.getTime() + 90 * MIN), by: alpha.owner, source: "web" })).shift;
    await siri(T(alpha).owner, { action: "handoff" });
    const before = hooks.length;
    const take = await siri(T(alpha).member, { action: "handoff" });
    const open = (await openShift(1, alpha.babyId))!;
    eq([open.holder, open.source, open.created_by, open.next_holder, open.asked_to], [alpha.member, "shortcut", alpha.member, alpha.owner, null], "Blake has her, Avery is next");
    eq([(await getShift(1, t.id))?.ended_how, (await getShift(1, t.id))?.asked_to], ["handoff", alpha.member], "Avery's turn handed over, its ask kept");
    ok(near(open.handoff_at, Date.now() + 90 * MIN), "the next handoff is as long as the last one was planned");
    eq(
      take.speak,
      `You have her now, from Avery. Next handoff at ${clock(open.handoff_at!, alpha.tz)}. Last fed at ${clock(fedAt, alpha.tz)} on the left; right is next. Wet diaper at ${clock(diaperAt, alpha.tz)}.`,
      "said, with the catch-up: the last feed, its side and the next side, and the last diaper"
    );
    ok(hooks.length > before, "re-armed");
    const twice = await siri(T(alpha).member, { action: "handoff" });
    eq([twice.speak, (await openShift(1, alpha.babyId))!.holder], ["Already handed off: you have her now.", alpha.member], "a second tap never hands her back (nor asks Avery)");
    // Not asked first: whoever says it takes over all the same; with nothing logged lately, the catch-up says so.
    await reset(alpha);
    await startShift(1, { babyId: alpha.babyId, holder: alpha.owner, by: alpha.owner, source: "web" });
    const plain = await siri(T(alpha).member, { action: "handoff" });
    const took = (await openShift(1, alpha.babyId))!;
    eq(
      [plain.speak, took.holder],
      [`You have her now, from Avery. Next handoff at ${clock(took.handoff_at!, alpha.tz)}. No feed logged lately. No diaper logged lately.`, alpha.member],
      "Blake took her; the next handoff two hours on by default"
    );
  });

  await test("handoff: the catch-up says what's running and how to feed her in the off-duty adult's window, by the roster's covers, in the family's words", async () => {
    const local = (f: FamilySeed, t: number) => {
      const p = localParts(t, f.tz);
      return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    };
    const cases: { f: FamilySeed; covers?: string; template?: { nursing: string | null }; care?: boolean; want: (end: string) => string | null }[] = [
      { f: alpha, covers: "bottle", want: (end) => `If she's hungry before ${end}: a bottle of expressed milk.` },
      { f: alpha, covers: "nurse", template: { nursing: alpha.owner }, want: (end) => `If she's hungry before ${end}: bring her to Avery to nurse.` },
      { f: alpha, covers: "nurse", template: { nursing: alpha.member }, want: () => null },
      { f: alpha, covers: "nurse", want: (end) => `If she's hungry before ${end}: nursing, as planned.` },
      { f: alpha, covers: "bottle", template: { nursing: null }, want: (end) => `If she's hungry before ${end}: a bottle.` },
      { f: alpha, covers: "none", want: () => null },
      { f: alpha, want: () => null },
      { f: beta, covers: "nurse", template: { nursing: beta.owner }, want: (end) => `If he's hungry before ${end}: bring him to Emery to nurse.` },
    ];
    for (const c of cases) {
      const { f } = c;
      await reset(f);
      // The holder's protected window from an hour to three hours from now; a nap timer runs in the bassinet.
      const from = Date.now() + 60 * MIN;
      const to = Date.now() + 180 * MIN;
      const roster = [{ id: "w1", member: f.owner, from: local(f, from), to: local(f, to), nights: [0, 1, 2, 3, 4, 5, 6], ...(c.covers ? { covers: c.covers } : {}) }];
      const template = c.template ? { kind: "back_to_work", member: f.owner, date: "2026-12-01", nursing: c.template.nursing } : null;
      await sql(
        `INSERT INTO maple_sleep_goals (family_id, baby_id, title, status, roster, template, item_seq, created_by, created_at, updated_at) VALUES ($1, $2, 'Made-up goal', 'active', $3::jsonb, $4::jsonb, 1, $5, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')`,
        [f.familyId, f.babyId, JSON.stringify(roster), template ? JSON.stringify(template) : null, f.owner]
      );
      const nap = (await startTimer(f.familyId, { babyId: f.babyId, kind: "sleep", at: new Date(Date.now() - 25 * MIN), createdBy: f.owner, source: "web" })).entry;
      await sql(`UPDATE maple_entries SET data = '{"place":"bassinet"}' WHERE id = $1`, [nap.id]);
      const start = new Date(Date.now() - 60 * MIN);
      await startShift(f.familyId, { babyId: f.babyId, holder: f.owner, at: start, handoffAt: new Date(start.getTime() + 120 * MIN), by: f.owner, source: "web" });
      const take = await siri(T(f).member, { action: "handoff" });
      const open = (await openShift(f.familyId, f.babyId))!;
      ok(take.speak.includes(`Asleep since ${clock(nap.started_at, f.tz)}, in the bassinet.`), `${f.name} ${c.covers}: what's running (${take.speak})`);
      const want = c.want(clock(open.handoff_at!, f.tz));
      if (want) ok(take.speak.endsWith(want), `${f.name} ${c.covers} ${JSON.stringify(c.template)}: ${take.speak}`);
      else ok(!/hungry/.test(take.speak), `${f.name} ${c.covers} ${JSON.stringify(c.template)}: no feeding line (${take.speak})`);
      await sql(`DELETE FROM maple_sleep_goals WHERE family_id = $1`, [f.familyId]);
      await reset(f);
    }
  });

  await test("handoff: taking over never plans the next handoff inside the next holder's protected window on the roster, and says why; a sleep in arms running on is said", async () => {
    await reset(alpha);
    // Avery's protected window from an hour to three hours from now, every night, on an active goal set days ago.
    const local = (t: number) => {
      const p = localParts(t, alpha.tz);
      return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    };
    const from = Date.now() + 60 * MIN;
    const to = Date.now() + 180 * MIN;
    const roster = [{ id: "w1", member: alpha.owner, from: local(from), to: local(to), nights: [0, 1, 2, 3, 4, 5, 6] }];
    await sql(
      `INSERT INTO maple_sleep_goals (family_id, baby_id, title, status, roster, item_seq, created_by, created_at, updated_at) VALUES (1, $1, 'Made-up goal', 'active', $2::jsonb, 1, $3, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')`,
      [alpha.babyId, JSON.stringify(roster), alpha.owner]
    );
    const start = new Date(Date.now() - 60 * MIN);
    // A two-hour turn: the default next handoff (two hours from now) falls inside Avery's window.
    await startShift(1, { babyId: alpha.babyId, holder: alpha.owner, at: start, handoffAt: new Date(start.getTime() + 120 * MIN), asleep: true, by: alpha.owner, source: "web" });
    const arms = (await sleepsOf(alpha))[0];
    const take = await siri(T(alpha).member, { action: "handoff" });
    const open = (await openShift(1, alpha.babyId))!;
    ok(Math.abs(Date.parse(open.handoff_at!) - Math.floor(to / MIN) * MIN) <= MIN, `planned for the window's end, not two hours on (${open.handoff_at})`);
    eq(
      take.speak,
      `You have her now, from Avery. Next handoff at ${clock(open.handoff_at!, alpha.tz)}, after Avery's protected sleep. Her sleep in arms has been running since ${clock(arms.started_at as string, alpha.tz)}; if she's awake, say Maple awake. No feed logged lately. No diaper logged lately.`,
      "said why, and the sleep in arms (once: the catch-up doesn't say it again)"
    );
    const moved = take.next_handoff_moved as { member: string; planned_at: string; default_at: string };
    eq([moved.member, moved.planned_at, near(moved.default_at, Date.now() + 120 * MIN)], [alpha.owner, open.handoff_at, true], "the reply carries why");
    eq((await getEntry(1, Number(arms.id)))?.active, true, "a handoff keeps her sleep in arms running");
    await sql(`DELETE FROM maple_sleep_goals WHERE family_id = 1`);
  });

  await test("undo after the holder's handoff takes the ask back (the turn goes on); after taking over, the turn goes back", async () => {
    await reset(alpha);
    const t = (await startShift(1, { babyId: alpha.babyId, holder: alpha.owner, by: alpha.owner, source: "web" })).shift;
    await siri(T(alpha).owner, { action: "handoff" });
    const before = hooks.length;
    const u = await siri(T(alpha).owner, { action: "undo" });
    eq([u.ok, u.speak], [true, "Undone: nobody is asked to take over now."], "said");
    const open = (await openShift(1, alpha.babyId))!;
    eq([open.id, open.holder, open.asked_to, open.asked_at], [t.id, alpha.owner, null, null], "the turn goes on, nobody asked");
    ok(hooks.length > before, "the phones hear of it");
    eq((await siri(T(alpha).owner, { action: "undo" })).ok, false, "one thing per undo");
    await siri(T(alpha).owner, { action: "handoff" });
    await siri(T(alpha).member, { action: "handoff" });
    const back = await siri(T(alpha).member, { action: "undo" });
    eq([back.speak, (await openShift(1, alpha.babyId))!.holder], ["Undone: Avery has her again.", alpha.owner], "taken over, then undone");
  });

  await test("handoff with no turn starts the speaker's own with the ask on it, as the app does (Handoff now to the person asked, Undo takes the ask back); with more than one other adult and nobody planned next it asks for the app", async () => {
    await reset(beta);
    const finleyPhone = "https://push.example.test/beta-finley-quick";
    await sql(`UPDATE maple_push_subs SET prefs = '{"handoff":true}'::jsonb WHERE id = $1`, [beta.pushSubId]);
    await sql(`INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, prefs, receipt_token) VALUES (2, $1, $2, 'k', 'a', '{"handoff":true}', $3)`, [beta.member, finleyPhone, "7".repeat(32)]);
    const b0 = hooks.length;
    sent.length = 0;
    const r0 = await siri(T(beta).owner, { action: "handoff" });
    eq(
      [r0.ok, r0.speak],
      [true, "Started your holding turn and asked Finley to take over. Finley's phone only sounds if handoff reminders are on, so go wake Finley. Getting sleepy? Put him on his back in the bassinet."],
      "no turn: Emery's own starts, with the ask on it"
    );
    const mine = (await openShift(2, beta.babyId))!;
    eq([mine.holder, mine.asked_to, mine.source], [beta.owner, beta.member, "shortcut"], "Emery holds him; Finley is asked");
    await runHooks(b0);
    eq(sent.filter((x) => x.title === "Handoff now").map((x) => x.endpoint), [finleyPhone], "Finley's phone hears it, never Emery's");
    eq((await siri(T(beta).owner, { action: "handoff" })).already_asked, true, "said again at once: already asked");
    eq((await siri(T(beta).owner, { action: "undo" })).speak, "Undone: nobody is asked to take over now.", "Undo takes the ask back");
    await sql(`DELETE FROM maple_push_subs WHERE endpoint = $1`, [finleyPhone]);
    await sql(`UPDATE maple_push_subs SET prefs = '{"meds":true}'::jsonb WHERE id = $1`, [beta.pushSubId]);
    await reset(beta);
    await sql(`INSERT INTO maple_members (family_id, email, role, display_name, added_by, accepted_at) VALUES (2, 'third.beta@example.com', 'member', 'Harper', 'self', NOW())`);
    const none = await siri(T(beta).owner, { action: "handoff" });
    eq([none.ok, none.speak, (await shifts(beta)).length], [false, "Nobody is on a holding turn right now. To ask someone to take over, use the app.", 0], "two other adults, no turn: nobody is guessed, nothing saved");
    await startShift(2, { babyId: beta.babyId, holder: beta.owner, by: beta.owner, source: "web" });
    const r = await siri(T(beta).owner, { action: "handoff" });
    eq([r.ok, r.speak, (await openShift(2, beta.babyId))!.holder, (await openShift(2, beta.babyId))!.asked_to], [false, "Who should take over? Ask in the app.", beta.owner, null], "unclear, nothing saved");
    await sql(`UPDATE maple_sleep_shifts SET next_holder = 'third.beta@example.com' WHERE family_id = 2 AND ended_at IS NULL`);
    const planned = await siri(T(beta).owner, { action: "handoff" });
    const after = (await openShift(2, beta.babyId))!;
    eq([planned.speak.startsWith("Asked Harper to take over."), after.holder, after.asked_to], [true, beta.owner, "third.beta@example.com"], "the planned next one is asked; Emery still holds him");
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
    // Said as a sentence, never the card's "Slept · 20m".
    eq(w.speak, "Stopped. He slept 20 minutes.", "said");
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

  // Undo acts on the speaker's newest Siri action as Siri kept it (quick/acts.ts), never on a change read off the log.
  await test("undo never reaches past a newer change by anyone to its action's row: a feed Siri stopped and someone fixed since stays, and the older sleep stop is never taken back", async () => {
    await reset(alpha);
    const sleep = await runningSleep(alpha, alpha.member, 60);
    ok((await siri(T(alpha).owner, { action: "wake" })).speak.startsWith("Stopped."), "Maple awake");
    const feed = await runningFeed(alpha, alpha.member, 8);
    ok((await siri(T(alpha).owner, { action: "stop" })).speak.startsWith("Stopped."), "Maple stop: the feed");
    // Blake fixes that feed in the app.
    const f = (await getEntry(1, feed.id))!;
    await updateEntry(1, feed.id, { note: "made-up fix on the other phone" }, alpha.member, { expectUpdatedAt: f.updated_at });
    const u = await siri(T(alpha).owner, { action: "undo" });
    eq([u.status, u.ok, u.speak], [409, false, "The nursing timer changed since, so nothing was undone. Fix it in the app."], "said, nothing undone");
    eq([(await getEntry(1, sleep.id))?.active, (await activeTimers(1, alpha.babyId)).length], [false, 0], "the sleep stays stopped, and nothing runs");
  });

  await test("undo never takes an app edit for a Siri stop: a finished nap, tummy time or pumping edited in the app never runs again", async () => {
    for (const kind of ["sleep", "tummy", "pump"] as const) {
      await reset(alpha);
      const start = new Date(Date.now() - 20 * HOUR);
      const [row] = await sql(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, ended_at, active, data, created_by, source) VALUES (1, $1, $2, $3, $4, FALSE, '{}', $5, 'web') RETURNING id, updated_at`, [
        alpha.babyId,
        kind,
        start,
        new Date(start.getTime() + HOUR),
        alpha.owner,
      ]);
      // Yesterday's, edited now in the app (its note) by the one who then says Maple undo.
      await updateEntry(1, Number(row.id), { note: "made-up note" }, alpha.owner, { expectUpdatedAt: new Date(row.updated_at as string).toISOString() });
      const u = await siri(T(alpha).owner, { action: "undo" });
      eq([u.ok, (await getEntry(1, Number(row.id)))?.active], [false, false], `${kind}: still finished (${u.speak})`);
    }
    // With an older Siri action kept (a diaper), the edit is a newer change of theirs: said, and nothing is undone.
    await reset(alpha);
    await siri(T(alpha).owner, { action: "pee" });
    const start = new Date(Date.now() - 20 * HOUR);
    const [nap] = await sql(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, ended_at, active, data, created_by, source) VALUES (1, $1, 'sleep', $2, $3, FALSE, '{"place":"crib"}', $4, 'web') RETURNING id, updated_at`, [
      alpha.babyId,
      start,
      new Date(start.getTime() + HOUR),
      alpha.owner,
    ]);
    await updateEntry(1, Number(nap.id), { note: "nap in the crib" }, alpha.owner, { expectUpdatedAt: new Date(nap.updated_at as string).toISOString() });
    const u = await siri(T(alpha).owner, { action: "undo" });
    eq([u.ok, u.speak], [false, "Your newest change was to the sleep timer, so nothing was undone. Fix it in the app."], "the newer change is said");
    eq((await getEntry(1, Number(nap.id)))?.active, false, "the nap stays finished");
    eq((await sql(`SELECT deleted_at FROM maple_entries WHERE family_id = 1 AND kind = 'diaper' AND source = 'shortcut'`))[0].deleted_at, null, "and the diaper stays");
  });

  await test("undo never takes back a timer stopped in the app; a stop Siri made with a time said (woke 10 minutes ago) it does", async () => {
    await reset(alpha);
    const inApp = await runningSleep(alpha, alpha.owner, 40);
    await stopTimer(1, inApp.id, undefined, alpha.owner);
    const u = await siri(T(alpha).owner, { action: "undo" });
    eq([u.ok, (await getEntry(1, inApp.id))?.active], [false, false], `the app's Done stays (${u.speak})`);
    await reset(alpha);
    const bySiri = await runningSleep(alpha, alpha.owner, 40);
    await siri(T(alpha).owner, { action: "wake", minutes_ago: 10 });
    const u2 = await siri(T(alpha).owner, { action: "undo" });
    eq([u2.speak, (await getEntry(1, bySiri.id))?.active], ["Undone: the sleep timer is running again.", true], "Siri's own stop");
  });

  await test("undo is the speaker's whichever of their Siri keys said it; the action kept names rows, never what's in them", async () => {
    await reset(beta);
    const pee = await siri(T(beta).owner, { action: "pee" });
    const [kept] = await sql(`SELECT last_act FROM maple_tokens WHERE family_id = 2 AND member = $1 AND revoked_at IS NULL`, [beta.owner]);
    const act = kept.last_act as { kind: string; rows: { t: string; id: number; u: string }[] };
    eq([act.kind, act.rows.map((r) => [r.t, r.id])], ["entry", [["entry", (pee.entry as { id: number }).id]]], "the diaper's row, as it left it");
    ok(!/pee|poop|wet|diaper/i.test(JSON.stringify(act)), JSON.stringify(act));
    const second = await addToken(2, beta.owner, "betaOwnerSecondKey");
    const u = await siri(second, { action: "undo" });
    eq(u.speak, `Undone: the wet diaper at ${clock((pee.entry as { started_at: string }).started_at, beta.tz)} is gone.`, "taken back with their other key");
    eq((await siri(T(beta).owner, { action: "undo" })).ok, false, "and with the first, nothing more");
    await reset(beta);
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

  await test("status: the person asked to take over hears it's them, and how to say they have her; nobody else does; with no diapers logged it says so, never 0 wet and 0 dirty", async () => {
    await reset(alpha);
    const t = (await startShift(1, { babyId: alpha.babyId, holder: alpha.owner, at: new Date(Date.now() - 50 * MIN), by: alpha.owner, source: "web" })).shift;
    await siri(T(alpha).owner, { action: "handoff" });
    const asked = (await openShift(1, alpha.babyId))!;
    const blake = await siri(T(alpha).member, { action: "status" });
    ok(blake.speak.includes(`Avery has been holding her since ${clock(t.started_at, alpha.tz)}. Avery asked you to take over at ${clock(asked.asked_at!, alpha.tz)}; say Maple handoff once you have her.`), blake.speak);
    for (const who of ["owner", "viewer"] as const) ok(!(await siri(T(alpha)[who], { action: "status" })).speak.includes("asked you"), `not the ${who}`);
    ok(blake.speak.includes("No diapers logged in the last 24 hours."), `no diapers logged: ${blake.speak}`);
    ok(!/0 wet and 0 dirty/.test(blake.speak), blake.speak);
    await siri(T(alpha).member, { action: "pee" });
    ok((await siri(T(alpha).member, { action: "status" })).speak.includes("1 wet and 0 dirty diapers in the last 24 hours."), "a diaper logged: the counts");
    // Beta says him.
    await reset(beta);
    await startShift(2, { babyId: beta.babyId, holder: beta.owner, by: beta.owner, source: "web" });
    await siri(T(beta).owner, { action: "handoff" });
    ok((await siri(T(beta).member, { action: "status" })).speak.includes("asked you to take over at") && (await siri(T(beta).member, { action: "status" })).speak.includes("once you have him."), "beta's words");
    await reset(beta);
  });

  await test("recap: since the speaker's protected window began, in it or just out of it; counts as Today does, says what's going on now and the next side, in at most three sentences", async () => {
    await reset(alpha);
    const local = (t: number) => {
      const p = localParts(t, alpha.tz);
      return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    };
    // Blake's window began three hours ago and runs another hour.
    const from = Math.floor((Date.now() - 3 * HOUR) / MIN) * MIN;
    const roster = [{ id: "w1", member: alpha.member, from: local(from), to: local(Date.now() + HOUR), nights: [0, 1, 2, 3, 4, 5, 6] }];
    await sql(`INSERT INTO maple_sleep_goals (family_id, baby_id, title, status, roster, item_seq, created_by, created_at, updated_at) VALUES (1, $1, 'Made-up goal', 'active', $2::jsonb, 1, $3, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')`, [
      alpha.babyId,
      JSON.stringify(roster),
      alpha.owner,
    ]);
    // Before the window: a feed (not counted). In it: two feeds on the left (one stopped and restarted under 10 minutes later counts once), a wet diaper, a try that stayed asleep 1 hour 50 minutes.
    await finishedFeed(alpha, 4 * 60, alpha.owner);
    await finishedFeed(alpha, 150, alpha.owner);
    const lastFeed = await finishedFeed(alpha, 75, alpha.owner);
    await finishedFeed(alpha, 55, alpha.owner);
    await sql(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, data, created_by) VALUES (1, $1, 'diaper', NOW() - INTERVAL '100 minutes', '{"pee":true}', $2)`, [alpha.babyId, alpha.owner]);
    const tryStart = new Date(Date.now() - 170 * MIN);
    await sql(`INSERT INTO maple_sleep_tries (family_id, baby_id, started_at, ended_at, outcome, created_by) VALUES (1, $1, $2, $3, 'stayed_asleep', $4)`, [alpha.babyId, tryStart, new Date(tryStart.getTime() + 110 * MIN), alpha.owner]);
    const seenBefore = (await sql(`SELECT last_seen_at FROM maple_members WHERE family_id = 1 AND email = $1`, [alpha.member]))[0].last_seen_at;
    const r = await siri(T(alpha).member, { action: "recap" });
    const sinceWords = formatTime(from, alpha.tz).replace(/:00(?=\s[AP]M)/, "");
    eq(r.basis, "protected_window", JSON.stringify(r));
    eq(
      r.speak,
      `Since ${sinceWords}: 2 feeds, the last at ${formatTime((await getEntry(1, lastFeed))!.started_at, alpha.tz)} on the left; 1 wet diaper; a bassinet try that stayed asleep 1 hour 50 minutes. Start on the right next.`,
      "counted from the window's start (the feed before it isn't counted; one stopped and started again under 10 minutes later is one feed)"
    );
    ok((r.speak.match(/[.!?](\s|$)/g) ?? []).length <= 3, "at most three sentences");
    eq((await sql(`SELECT last_seen_at FROM maple_members WHERE family_id = 1 AND email = $1`, [alpha.member]))[0].last_seen_at, seenBefore, "never moves last_seen_at");
    eq((await tries(alpha)).length, 1, "read only: nothing saved");
    // Going on now: a nursing feed (said, not counted), and Avery holding her otherwise.
    const feed = await runningFeed(alpha, alpha.owner, 5);
    const now1 = await siri(T(alpha).member, { action: "recap" });
    ok(now1.speak.includes(`She's nursing now, on the left, since ${formatTime(feed.started_at, alpha.tz)}.`) && !now1.speak.includes("Start on the"), now1.speak);
    await sql(`DELETE FROM maple_entries WHERE id = $1`, [feed.id]);
    const turn = (await startShift(1, { babyId: alpha.babyId, holder: alpha.owner, at: new Date(Date.now() - 20 * MIN), by: alpha.owner, source: "web" })).shift;
    ok((await siri(T(alpha).member, { action: "recap" })).speak.includes(`Avery has been holding her since ${formatTime(turn.started_at, alpha.tz)}.`), "the holding turn");
    // The viewer (no window) hears it from their last visit; a photos-only guest gets nothing.
    await sql(`UPDATE maple_members SET last_seen_at = NOW() - INTERVAL '30 minutes' WHERE family_id = 1 AND email = $1`, [alpha.viewer]);
    const v = await siri(T(alpha).viewer, { action: "recap" });
    eq([v.status, v.basis], [200, "last_visit"], JSON.stringify(v));
    ok(v.speak.startsWith("Since ") && Math.abs(Date.parse(String(v.since)) - (Date.now() - 30 * MIN)) < 2 * MIN, `${v.speak} (${v.since})`);
    eq((await siri(T(alpha).photos, { action: "recap" })).status, 401, "photos-only");
    ok(!/Ibuprofen|Dana|medicine/.test(`${r.speak} ${v.speak}`), "nothing of her page");
    await sql(`DELETE FROM maple_sleep_goals WHERE family_id = 1`);
  });

  await test("recap: just out of the window counts from its start; with none, from the last visit (24 hours at most), else the last 8 hours; nothing logged says so; beta's words and zone", async () => {
    await reset(alpha);
    const local = (t: number, tz: string) => {
      const p = localParts(t, tz);
      return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    };
    // Avery's window ended ten minutes ago; it began two hours before that.
    const from = Math.floor((Date.now() - 130 * MIN) / MIN) * MIN;
    const to = Math.floor((Date.now() - 10 * MIN) / MIN) * MIN;
    const roster = [{ id: "w1", member: alpha.owner, from: local(from, alpha.tz), to: local(to, alpha.tz), nights: [0, 1, 2, 3, 4, 5, 6] }];
    await sql(`INSERT INTO maple_sleep_goals (family_id, baby_id, title, status, roster, item_seq, created_by, created_at, updated_at) VALUES (1, $1, 'Made-up goal', 'active', $2::jsonb, 1, $3, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')`, [
      alpha.babyId,
      JSON.stringify(roster),
      alpha.owner,
    ]);
    const out = await siri(T(alpha).owner, { action: "recap" });
    // (Unless the window crossed noon, which ends a try day.)
    if (tryDayKey(from, alpha.tz) === tryDayKey(Date.now(), alpha.tz)) {
      eq([out.basis, out.speak], ["last_window", `Since ${formatTime(from, alpha.tz).replace(/:00(?=\s[AP]M)/, "")}, nothing was logged.`], "just out of it, nothing logged");
    }
    await sql(`DELETE FROM maple_sleep_goals WHERE family_id = 1`);
    // No window: the last visit, read and left as it was.
    await sql(`UPDATE maple_members SET last_seen_at = NOW() - INTERVAL '2 hours' WHERE family_id = 1 AND email = $1`, [alpha.owner]);
    await sql(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, data, created_by) VALUES (1, $1, 'diaper', NOW() - INTERVAL '30 minutes', '{"pee":true,"poop":true}', $2)`, [alpha.babyId, alpha.member]);
    const visit = await siri(T(alpha).owner, { action: "recap" });
    eq(visit.basis, "last_visit");
    ok(/^Since \d{1,2}(:\d{2})? [AP]M: no feeds logged; 1 wet and dirty diaper\.$/.test(visit.speak), visit.speak);
    // A visit two days ago: the last 24 hours. None on record: the last 8 hours.
    await sql(`UPDATE maple_members SET last_seen_at = NOW() - INTERVAL '2 days' WHERE family_id = 1 AND email = $1`, [alpha.owner]);
    eq((await siri(T(alpha).owner, { action: "recap" })).speak, "In the last 24 hours: no feeds logged; 1 wet and dirty diaper.");
    await sql(`UPDATE maple_members SET last_seen_at = NULL WHERE family_id = 1 AND email = $1`, [alpha.owner]);
    eq((await siri(T(alpha).owner, { action: "recap" })).basis, "last_8_hours");
    // Beta: his name and pronouns, its own zone, nothing of alpha's.
    await reset(beta);
    await sql(`UPDATE maple_members SET last_seen_at = NULL WHERE family_id = 2`);
    await finishedFeed(beta, 30, beta.owner);
    const b = await siri(T(beta).member, { action: "recap" });
    ok(/^In the last 8 hours: 1 feed, the last at \d{1,2}:\d{2}\s[AP]M on the left\. Start on the right next\.$/.test(b.speak), b.speak);
    ok(!/wet and dirty/.test(b.speak), "alpha's diaper isn't beta's");
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
