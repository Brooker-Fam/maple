import webpush from "web-push";
import { familyScope, type FamilyScope } from "../../src/lib/maple/family";
import { notifyDoseLogged, notifyHandoffNow, notifyNursing } from "../../src/lib/maple/notify";
import { claim, cleanPrefs, liveSubs, markHeld, runPushTick } from "../../src/lib/maple/push";
import { quietPhones } from "../../src/lib/maple/push-quiet";
import { handoffFor, scheduleWakeups } from "../../src/lib/maple/push-wake";
import { catchUpLines } from "../../src/lib/maple/sleep/catchup";
import { feedCover, quietWindowWords, recapSpan, windowsBetween } from "../../src/lib/maple/sleep/roster";
import { makeVoice } from "../../src/lib/maple/voice";
import { askHandoff, startShift } from "../../src/lib/maple/sleep/store";
import type { SleepGoal } from "../../src/lib/maple/sleep/types";
import { formatTime, localParts } from "../../src/lib/maple/time";
import type { Member } from "../../src/lib/maple/types";
import { done, eq, freshDb, ok, seedFamilies, sql, test, type Seed } from "./harness";

/**
 * Who hears a holding turn's handoff (push.ts's tick, notify.ts): the
 * planned handoff reaches only the holder's and the next holder's phones,
 * and "Handoff now" only the phones of the person asked, never anyone else
 * in the family, with two made-up families kept apart. Sends are caught
 * in-process; nothing leaves the machine.
 */

process.env.MCP_SECRET = "made-up-push-quiet-secret";
delete process.env.QSTASH_TOKEN;
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

type Sent = { endpoint: string; tag: string; title: string; body: string; kind: string };
const sent: Sent[] = [];
(webpush as unknown as { sendNotification: unknown }).sendNotification = async (sub: { endpoint: string }, payload: string) => {
  const p = JSON.parse(payload) as { tag: string; title: string; body: string; data: { kind: string } };
  sent.push({ endpoint: sub.endpoint, tag: p.tag, title: p.title, body: p.body, kind: p.data.kind });
  return { statusCode: 201, body: "", headers: {} };
};

const MIN = 60_000;
const HARPER = "harper.alpha@example.com";

type World = Seed & { a: FamilyScope; b: FamilyScope; phone: (who: string) => string };

/** Both made-up families, with one phone per person (handoff reminders on) and nothing sent yet. */
async function world(): Promise<World> {
  await freshDb({ shape: "final" });
  const seed = await seedFamilies();
  await sql(`UPDATE maple_push_sent SET sent_at = '2020-01-01' WHERE key = 'floor:v2'`);
  await sql(`DELETE FROM maple_push_subs`);
  const phone = (who: string) => `https://push.example.test/quiet-${who.split("@")[0]}`;
  let n = 0;
  for (const f of [seed.alpha, seed.beta]) {
    for (const who of [f.owner, f.member, f.viewer]) {
      await sql(`INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, prefs, receipt_token) VALUES ($1, $2, $3, 'made-up', 'made-up', '{"handoff":true}', $4)`, [
        f.familyId,
        who,
        phone(who),
        String(++n).padStart(32, "0"),
      ]);
    }
  }
  sent.length = 0;
  return { ...seed, a: (await familyScope(1))!, b: (await familyScope(2))!, phone };
}

const heard = (kind: string) => [...new Set(sent.filter((s) => s.kind === kind).map((s) => s.endpoint))].sort();

async function audiences() {
  await test("handoffFor: the holder and the planned next person; with none planned, the only other adult; with two others and none planned, the holder alone", () => {
    const m = (email: string, role: Member["role"]): Member => ({ email, role, display_name: null, emoji: null, color: null });
    const family = [m("sam@example.test", "owner"), m("alex@example.test", "member"), m("noor@example.test", "viewer"), m("theo@example.test", "photos")];
    eq(handoffFor({ holder: "sam@example.test", next: "alex@example.test" }, family), ["sam@example.test", "alex@example.test"]);
    eq(handoffFor({ holder: "sam@example.test", next: null }, family), ["sam@example.test", "alex@example.test"], "the only other adult");
    eq(handoffFor({ holder: "sam@example.test", next: "theo@example.test" }, family), ["sam@example.test", "alex@example.test"], "a photos-only guest is never next");
    eq(handoffFor({ holder: "sam@example.test", next: "sam@example.test" }, family), ["sam@example.test", "alex@example.test"], "never the holder twice");
    const three = [...family, m("harper@example.test", "member")];
    eq(handoffFor({ holder: "sam@example.test", next: null }, three), ["sam@example.test"], "two other adults: nobody is guessed");
    eq(handoffFor({ holder: "sam@example.test", next: "harper@example.test" }, three), ["sam@example.test", "harper@example.test"]);
    eq(handoffFor({ holder: "sam@example.test", next: "noor@example.test" }, three), ["sam@example.test", "noor@example.test"], "a view-only guest planned next hears it");
  });

  await test("the planned handoff reaches the holder's and the next holder's phones only, once each; beta hears nothing", async () => {
    const w = await world();
    const plannedFor = new Date(Date.now() + MIN);
    const s = await startShift(1, { babyId: w.alpha.babyId, holder: w.alpha.owner, handoffAt: plannedFor, nextHolder: w.alpha.member, by: w.alpha.owner, source: "web" });
    await runPushTick(new Date(plannedFor.getTime() + 30_000), { via: "wake", trusted: true, familyId: 1 });
    eq(heard("handoff"), [w.phone(w.alpha.member), w.phone(w.alpha.owner)].sort(), "Avery (holding her) and Blake (next), not Casey");
    ok(sent.every((x) => x.tag === `handoff:${s.shift.id}` && x.title === "Handoff time"), JSON.stringify(sent));
    sent.length = 0;
    await runPushTick(new Date(plannedFor.getTime() + 90_000), { via: "wake", trusted: true, familyId: 1 });
    eq(sent.length, 0, "once per phone");
    await runPushTick(new Date(plannedFor.getTime() + 90_000), { via: "wake", trusted: true, familyId: 2 });
    eq(sent.length, 0, "beta has no turn");
  });

  await test("the planned handoff with nobody planned next and two other adults reaches only the holder's phone", async () => {
    const w = await world();
    await sql(`INSERT INTO maple_members (family_id, email, role, display_name, added_by, accepted_at) VALUES (1, $1, 'member', 'Harper', 'self', NOW())`, [HARPER]);
    await sql(`INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, prefs, receipt_token) VALUES (1, $1, $2, 'made-up', 'made-up', '{"handoff":true}', $3)`, [HARPER, w.phone(HARPER), "f".repeat(32)]);
    const plannedFor = new Date(Date.now() + MIN);
    await startShift(1, { babyId: w.alpha.babyId, holder: w.alpha.member, handoffAt: plannedFor, by: w.alpha.member, source: "web" });
    await runPushTick(new Date(plannedFor.getTime() + 30_000), { via: "wake", trusted: true, familyId: 1 });
    eq(heard("handoff"), [w.phone(w.alpha.member)], "Blake, holding her: who's next isn't known, so nobody else is woken");
  });

  await test("Handoff now reaches only the phones of the person asked: not the holder's, not the viewer's, not another adult's", async () => {
    const w = await world();
    await sql(`INSERT INTO maple_members (family_id, email, role, display_name, added_by, accepted_at) VALUES (1, $1, 'member', 'Harper', 'self', NOW())`, [HARPER]);
    await sql(`INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, prefs, receipt_token) VALUES (1, $1, $2, 'made-up', 'made-up', '{"handoff":true}', $3)`, [HARPER, w.phone(HARPER), "f".repeat(32)]);
    // Blake has a second phone: both of Blake's hear it.
    const second = "https://push.example.test/quiet-blake-second";
    await sql(`INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, prefs, receipt_token) VALUES (1, $1, $2, 'made-up', 'made-up', '{"handoff":true}', $3)`, [w.alpha.member, second, "a".repeat(32)]);
    const t = (await startShift(1, { babyId: w.alpha.babyId, holder: w.alpha.owner, by: w.alpha.owner, source: "web" })).shift;
    await askHandoff(1, { babyId: w.alpha.babyId, id: t.id, to: w.alpha.member, by: w.alpha.owner, source: "web" });
    await notifyHandoffNow(w.a, t.id, null);
    eq(heard("handoff"), [second, w.phone(w.alpha.member)].sort(), "Blake's two phones only");
    ok(sent.every((x) => x.title === "Handoff now" && !/Avery|Blake|Casey|Harper|June|Juniper|Dana/.test(`${x.title} ${x.body}`)), JSON.stringify(sent));
    // Beta's same shift id reads as missing.
    sent.length = 0;
    await notifyHandoffNow(w.b, t.id, null);
    eq(sent.length, 0, "family B can't send family A's ask");
  });
}

// ── Quiet during my protected sleep ───────────────────────────────────────

const PLAN = 10000001;
const DANA = "Dana";
const ALL = '{"meds":true,"nursing":true,"logged":true,"handoff":true}';

/** "22:00": a local clock in the family's zone. */
const local = (t: number, tz: string) => {
  const p = localParts(t, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};
const minuteOf = (t: number) => Math.floor(t / MIN) * MIN;

type Quiet = World & { phones: Record<"avery" | "blake" | "casey" | "dana", number>; window: (member: string, from: number, to: number) => Promise<void> };

/**
 * Family Alpha with her page's person a member too (Dana, signed in as
 * herself), an every-6-hours medicine OK again `okIn` minutes from now
 * (negative: due), one phone each for Avery (owner), Blake (member), Casey
 * (view-only) and Dana with everything on, and an active goal whose roster
 * gives Avery, Blake and Dana a protected window from an hour ago to two
 * hours on, every night. Nobody has been in Maple lately (the seed's rows
 * are made days old).
 */
async function quietWorld(okIn = -2, opts: { roster?: boolean } = {}): Promise<Quiet> {
  const w = await world();
  const { alpha } = w;
  await sql(`INSERT INTO maple_members (family_id, email, role, display_name, added_by, accepted_at) VALUES (1, $1, 'member', 'Dana', 'self', NOW())`, [DANA]);
  await sql(`DELETE FROM maple_push_subs WHERE family_id = 1`);
  await sql(`UPDATE maple_care_meds SET schedule = '{"type":"every","every_min":360}', created_at = NOW() - INTERVAL '5 days' WHERE id = $1`, [PLAN]);
  await sql(`UPDATE maple_care_entries SET deleted_at = NOW() WHERE family_id = 1`);
  await dose(Date.now() - 360 * MIN + okIn * MIN, 10000031);
  for (const t of ["maple_entries", "maple_care_entries"]) await sql(`UPDATE ${t} SET created_at = NOW() - INTERVAL '3 days', updated_at = NOW() - INTERVAL '3 days'`);
  await sql(`UPDATE maple_members SET last_seen_at = NULL`);
  const phones = {} as Quiet["phones"];
  for (const [k, who] of [["avery", alpha.owner], ["blake", alpha.member], ["casey", alpha.viewer], ["dana", DANA]] as const) {
    const [row] = await sql(`INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, prefs, receipt_token) VALUES (1, $1, $2, 'made-up', 'made-up', $3::jsonb, $4) RETURNING id`, [
      who,
      w.phone(who),
      ALL,
      `${k}`.padEnd(32, "0"),
    ]);
    phones[k] = Number(row.id);
  }
  const window = async (member: string, from: number, to: number) => {
    const roster = [{ id: `w-${member}`, member, from: local(from, alpha.tz), to: local(to, alpha.tz), nights: [0, 1, 2, 3, 4, 5, 6] }];
    await sql(
      `INSERT INTO maple_sleep_goals (family_id, baby_id, title, status, roster, item_seq, created_by, created_at, updated_at) VALUES (1, $1, 'Made-up goal', 'active', $2::jsonb, 1, $3, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')`,
      [alpha.babyId, JSON.stringify(roster), alpha.owner]
    );
  };
  if (opts.roster !== false) {
    const now = minuteOf(Date.now());
    for (const who of [alpha.owner, alpha.member, DANA]) await window(who, now - 60 * MIN, now + 120 * MIN);
  }
  sent.length = 0;
  return { ...w, phones, window };
}

/** A dose of her medicine at `at` (logged by nobody in the family, days ago as far as the clock of who's awake goes). */
const dose = (at: number, id: number) =>
  sql(`INSERT INTO maple_care_entries (family_id, id, person, kind, med_id, at, data, created_by, created_at, updated_at) VALUES (1, $1, $2, 'dose', $3, $4, '{"name":"x"}', 'made-up', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')`, [
    id,
    DANA,
    PLAN,
    new Date(at).toISOString(),
  ]);

const subsOf = async () => liveSubs({ familyId: 1 });
const quietNow = async (w: Quiet, now = new Date()) => [...(await quietPhones(w.a, await subsOf(), now)).keys()].sort((x, y) => x - y);
const got = (w: Quiet, who: string, kind?: string) => sent.filter((s) => s.endpoint === w.phone(who) && (!kind || s.kind === kind));
const heldRows = async (key: string) => (await sql(`SELECT key FROM maple_push_sent WHERE state = 'held' AND key LIKE $1 ORDER BY key`, [`%|${key}`])).map((r) => String(r.key));

async function quiet() {
  await test("quiet phones: the roster's adults inside their own window, not holding her and not in Maple for 15 minutes; a view-only guest off the roster isn't", async () => {
    const w = await quietWorld();
    eq(await quietNow(w), [w.phones.avery, w.phones.blake, w.phones.dana].sort((x, y) => x - y));
    // A paused goal protects no one.
    await sql(`UPDATE maple_sleep_goals SET status = 'paused' WHERE family_id = 1`);
    eq(await quietNow(w), [], "paused goals");
    await sql(`UPDATE maple_sleep_goals SET status = 'active' WHERE family_id = 1`);
    // Outside the window (three hours on), nobody is quiet.
    eq(await quietNow(w, new Date(Date.now() + 3 * 60 * MIN)), [], "after the window");
  });

  await test("the switch: quiet_window off on a phone keeps it hearing everything; unset is on", async () => {
    const w = await quietWorld();
    await sql(`UPDATE maple_push_subs SET prefs = prefs || '{"quiet_window":false}'::jsonb WHERE id = $1`, [w.phones.blake]);
    eq(await quietNow(w), [w.phones.avery, w.phones.dana].sort((x, y) => x - y));
    eq(cleanPrefs({ quiet_window: false, handoff: true }), { handoff: true, quiet_window: false }, "the pref is kept");
    eq(cleanPrefs({ quiet_window: "no" }), {}, "only a boolean");
  });

  await test("awake: holding her on an open turn, or in Maple in the last 15 minutes (the app open, or anything they logged or changed, from any channel), keeps a phone hearing", async () => {
    const w = await quietWorld();
    const { alpha } = w;
    const quietFor = async (who: "avery" | "blake") => (await quietNow(w)).includes(w.phones[who]);
    // Holding her.
    const turn = (await startShift(1, { babyId: alpha.babyId, holder: alpha.member, by: alpha.member, source: "web" })).shift;
    await sql(`UPDATE maple_sleep_shifts SET created_at = NOW() - INTERVAL '1 hour', updated_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [turn.id]);
    eq([await quietFor("blake"), await quietFor("avery")], [false, true], "Blake holds her: awake");
    await sql(`UPDATE maple_sleep_shifts SET started_at = NOW() - INTERVAL '1 hour', ended_at = NOW() - INTERVAL '30 minutes', ended_how = 'ended' WHERE id = $1`, [turn.id]);
    eq(await quietFor("blake"), true, "the turn ended half an hour ago");
    // The app on screen: last_seen_at moves while it's open.
    await sql(`UPDATE maple_members SET last_seen_at = NOW() - INTERVAL '14 minutes' WHERE family_id = 1 AND email = $1`, [alpha.owner]);
    eq(await quietFor("avery"), false, "the app open 14 minutes ago");
    await sql(`UPDATE maple_members SET last_seen_at = NOW() - INTERVAL '16 minutes' WHERE family_id = 1 AND email = $1`, [alpha.owner]);
    eq(await quietFor("avery"), true, "16 minutes ago");
    // Each kind of write, as the one who made or changed it.
    const writes: [string, string][] = [
      [`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, data, created_by, created_at, updated_at) VALUES (1, ${alpha.babyId}, 'diaper', NOW(), '{"pee":true}', $1, NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '5 minutes')`, "a diaper they logged"],
      [`UPDATE maple_entries SET updated_by = $1, updated_at = NOW() - INTERVAL '2 minutes' WHERE id = ${alpha.entries.feed}`, "an entry they changed"],
      [`INSERT INTO maple_care_entries (family_id, id, person, kind, med_id, at, data, created_by) VALUES (1, 10000077, '${DANA}', 'dose', ${PLAN}, NOW(), '{"name":"x"}', $1)`, "a dose they logged on her page"],
      [`INSERT INTO maple_sleep_tries (family_id, baby_id, started_at, created_by) VALUES (1, ${alpha.babyId}, NOW() - INTERVAL '3 minutes', $1)`, "a try they started"],
      [`INSERT INTO maple_sleep_shifts (family_id, baby_id, holder, started_at, ended_at, ended_how, created_by, updated_by) VALUES (1, ${alpha.babyId}, 'someone.else@example.com', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour', 'ended', 'someone.else@example.com', $1)`, "a turn they changed"],
      [`INSERT INTO maple_sleep_checkins (family_id, baby_id, member, night, protected) VALUES (1, ${alpha.babyId}, $1, '2026-10-01', 'yes')`, "their check-in"],
    ];
    for (const [stmt, label] of writes) {
      await sql(`UPDATE maple_members SET last_seen_at = NULL`);
      eq(await quietFor("avery"), true, `before ${label}`);
      await sql(stmt, [alpha.owner]);
      eq(await quietFor("avery"), false, label);
      // Fifteen minutes on, it no longer counts.
      eq((await quietPhones(w.a, await subsOf(), new Date(Date.now() + 16 * MIN))).has(w.phones.avery), true, `${label}, 16 minutes on`);
      for (const t of ["maple_entries", "maple_care_entries", "maple_sleep_tries", "maple_sleep_shifts", "maple_sleep_checkins"]) await sql(`UPDATE ${t} SET created_at = NOW() - INTERVAL '3 days', updated_at = NOW() - INTERVAL '3 days' WHERE family_id = 1`);
    }
  });

  await test("medicine reminders: held on a quiet phone, never on her own; a phone with the switch off, or someone holding her, hears it", async () => {
    const w = await quietWorld();
    await sql(`UPDATE maple_push_subs SET prefs = prefs || '{"quiet_window":false}'::jsonb WHERE id = $1`, [w.phones.blake]);
    await runPushTick(new Date(), { via: "wake", trusted: true, familyId: 1 });
    eq(got(w, DANA, "ok").map((s) => s.title), ["Ibuprofen is OK again"], "her own phone: her own reminder, in her own words");
    eq(got(w, w.alpha.member, "ok").length, 1, "Blake turned quiet off");
    eq([got(w, w.alpha.owner).length, got(w, w.alpha.viewer).length], [0, 0], "Avery's is held; Casey never hears her medicines");
    // Held means unclaimed: Avery opens the app and the next tick sends it, once.
    await sql(`UPDATE maple_members SET last_seen_at = NOW() WHERE family_id = 1 AND email = $1`, [w.alpha.owner]);
    sent.length = 0;
    await runPushTick(new Date(Date.now() + 1000), { via: "wake", trusted: true, familyId: 1 });
    eq(got(w, w.alpha.owner, "ok").map((s) => s.title), ["Ibuprofen is OK again for Dana"], "awake now: it goes");
    eq([got(w, DANA).length, got(w, w.alpha.member).length], [0, 0], "nobody hears it twice");
  });

  await test("medicine reminders: someone holding her on an open turn hears them in their window", async () => {
    const w = await quietWorld();
    const turn = (await startShift(1, { babyId: w.alpha.babyId, holder: w.alpha.member, by: w.alpha.member, source: "web" })).shift;
    await sql(`UPDATE maple_sleep_shifts SET created_at = NOW() - INTERVAL '1 hour', updated_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [turn.id]);
    await runPushTick(new Date(), { via: "wake", trusted: true, familyId: 1 });
    eq([got(w, w.alpha.member, "ok").length, got(w, w.alpha.owner, "ok").length], [1, 0], "Blake (holding her) hears it; Avery (asleep) doesn't");
  });

  await test("window's end: a reminder held in the window goes once when it ends, while still due; one past its cutoff, or logged meanwhile, doesn't", async () => {
    const end = minuteOf(Date.now()) - MIN;
    // Avery's window: five hours, ending a minute ago. Her medicine came due 40 minutes before it ended.
    const w = await quietWorld(-41, { roster: false });
    await w.window(w.alpha.owner, end - 5 * 60 * MIN, end);
    const okAt = end - 40 * MIN;
    await runPushTick(new Date(okAt + 5 * MIN), { via: "wake", trusted: true, familyId: 1 });
    eq(got(w, w.alpha.owner).length, 0, "held in the window");
    ok(got(w, w.alpha.member, "ok").length === 1, "Blake (no window) heard it at once");
    sent.length = 0;
    await runPushTick(new Date(end + 30_000), { via: "wake", trusted: true, familyId: 1 });
    const late = got(w, w.alpha.owner, "ok");
    eq(late.map((s) => s.title), [`Ibuprofen has been OK for Dana since ${formatTime(okAt, w.alpha.tz)}`], "once at the window's end, in the usual words");
    ok(!/missed|take it|dose/i.test(`${late[0].title} ${late[0].body}`), `never a missed dose: ${late[0].body}`);
    sent.length = 0;
    await runPushTick(new Date(end + 2 * MIN), { via: "wake", trusted: true, familyId: 1 });
    eq(got(w, w.alpha.owner).length, 0, "and only once");

    // Due three hours and ten minutes before the window ended: past its cutoff then, so it never goes.
    const w2 = await quietWorld(-(3 * 60 + 11), { roster: false });
    await w2.window(w2.alpha.owner, end - 5 * 60 * MIN, end);
    await runPushTick(new Date(end - (3 * 60 + 5) * MIN), { via: "wake", trusted: true, familyId: 1 });
    eq(got(w2, w2.alpha.owner).length, 0, "held");
    await runPushTick(new Date(end + 30_000), { via: "wake", trusted: true, familyId: 1 });
    eq(got(w2, w2.alpha.owner).length, 0, "past its cutoff at the window's end");

    // Logged in the window: nothing is due at its end.
    const w3 = await quietWorld(-41, { roster: false });
    await w3.window(w3.alpha.owner, end - 5 * 60 * MIN, end);
    await runPushTick(new Date(okAt + 5 * MIN), { via: "wake", trusted: true, familyId: 1 });
    await dose(okAt + 10 * MIN, 10000032);
    sent.length = 0;
    await runPushTick(new Date(end + 30_000), { via: "wake", trusted: true, familyId: 1 });
    eq(got(w3, w3.alpha.owner, "ok").length, 0, "taken since: no reminder at the window's end");
  });

  await test("window's end: the wake-ups include the end of a window that holds one of her reminders on a quiet phone; not when none falls inside it, past the cutoff, or with the switch off", async () => {
    const published: number[] = [];
    const realFetch = globalThis.fetch;
    process.env.QSTASH_TOKEN = "made-up-qstash-token";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/v2/publish/")) published.push((JSON.parse(String(init?.body ?? "{}")) as { at: number }).at);
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const now = minuteOf(Date.now());
      const wakeFor = (t: number) => Math.ceil(t / 1000) + 10;
      const cases: { label: string; from: number; to: number; quietOff?: boolean; wake: boolean }[] = [
        { label: "her reminder at +2h inside Avery's +1h to +4h window", from: now + 60 * MIN, to: now + 4 * 60 * MIN, wake: true },
        { label: "the reminder comes before the window", from: now + 150 * MIN, to: now + 4 * 60 * MIN, wake: false },
        { label: "the window ends over 3 hours after the reminder", from: now + 60 * MIN, to: now + 6 * 60 * MIN, wake: false },
        { label: "every phone turned quiet off", from: now + 60 * MIN, to: now + 4 * 60 * MIN, quietOff: true, wake: false },
      ];
      for (const c of cases) {
        const w = await quietWorld(120, { roster: false });
        await w.window(w.alpha.owner, c.from, c.to);
        if (c.quietOff) await sql(`UPDATE maple_push_subs SET prefs = prefs || '{"quiet_window":false}'::jsonb WHERE family_id = 1`);
        published.length = 0;
        await scheduleWakeups(w.a);
        ok(published.some((at) => Math.abs(at * 1000 - (now + 120 * MIN)) < 2 * MIN), `${c.label}: the reminder's own wake (${published})`);
        eq(published.includes(wakeFor(c.to)), c.wake, `${c.label}: a wake at the window's end`);
      }
    } finally {
      delete process.env.QSTASH_TOKEN;
      globalThis.fetch = realFetch;
    }
  });

  await test("Logged: held on every quiet phone (hers too), claimed as held so a retry never sends it later; a phone not quiet hears it", async () => {
    const w = await quietWorld(-60);
    await sql(`UPDATE maple_push_subs SET prefs = prefs || '{"quiet_window":false}'::jsonb WHERE id = $1`, [w.phones.blake]);
    await dose(Date.now() - MIN, 10000040);
    await notifyDoseLogged(w.a, 10000040, null);
    eq(got(w, w.alpha.member, "logged").length, 1, "Blake (quiet off) hears it");
    eq([got(w, w.alpha.owner).length, got(w, DANA).length, got(w, w.alpha.viewer).length], [0, 0, 0], "Avery's and Dana's are held; Casey never hears her medicines");
    eq(await heldRows("log:10000040"), [`s${w.phones.avery}|log:10000040`, `s${w.phones.dana}|log:10000040`].sort());
    // After the window, a retry of that dose's Logged (retryWriteNotices) finds the held claims and sends nothing.
    sent.length = 0;
    await notifyDoseLogged(w.a, 10000040, null, new Date(Date.now() + 3 * 60 * MIN));
    eq(sent.length, 0, "never later");
  });

  await test("nursing timer: held on a quiet phone, unless its person started or changed the feed; held updates never count as showing", async () => {
    const w = await quietWorld();
    const { alpha } = w;
    await sql(`UPDATE maple_push_subs SET prefs = '{"nursing":true}'::jsonb WHERE family_id = 1`);
    const start = new Date(Date.now() - 10 * MIN).toISOString();
    const [feed] = await sql(
      `INSERT INTO maple_entries (family_id, baby_id, kind, started_at, active, data, created_by, created_at, updated_at) VALUES (1, $1, 'feed', $2, TRUE, $3, $4, NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '20 minutes') RETURNING id`,
      [alpha.babyId, start, { method: "breast", segments: [{ side: "L", start }] }, alpha.member]
    );
    const id = Number(feed.id);
    await notifyNursing(w.a, id);
    eq([got(w, alpha.member, "nurse").length, got(w, alpha.owner).length, got(w, DANA).length], [1, 0, 0], "Blake started it: Blake's phone shows it; Avery's and Dana's hold it");
    eq((await heldRows(`nurse:${id}:%`)).length, 2, "held, per phone");
    // Avery switches the side (from her phone, twenty minutes ago as far as being awake goes): she changed the feed, so she hears it.
    const switched = new Date(Date.now() - 2 * MIN).toISOString();
    await sql(`UPDATE maple_entries SET data = $2, updated_by = $3, updated_at = NOW() - INTERVAL '20 minutes' WHERE id = $1`, [
      id,
      { method: "breast", segments: [{ side: "L", start, end: switched }, { side: "R", start: switched }] },
      alpha.owner,
    ]);
    sent.length = 0;
    await notifyNursing(w.a, id);
    eq([got(w, alpha.owner, "nurse").length, got(w, alpha.member, "nurse").length, got(w, DANA).length], [1, 1, 0], "Avery changed it, Blake started it; Dana's still holds");
    // Blake finishes it twenty minutes on: Avery's switch isn't the feed's latest change any more, and she hasn't been in Maple since, so hers holds.
    await sql(`UPDATE maple_entries SET active = FALSE, ended_at = NOW(), data = $2, updated_by = $3, updated_at = NOW() - INTERVAL '20 minutes' WHERE id = $1`, [
      id,
      { method: "breast", segments: [{ side: "L", start, end: switched }, { side: "R", start: switched, end: new Date().toISOString() }] },
      alpha.member,
    ]);
    sent.length = 0;
    await notifyNursing(w.a, id);
    eq([got(w, alpha.owner, "nurse").length, got(w, alpha.member, "nurse").length, got(w, DANA).length], [0, 1, 0], "done: Blake hears it; Avery and Dana hold it");
    // Removed, with Dana's quiet off now: a held update never counted as showing, so her phone (never showing it) hears nothing.
    await sql(`UPDATE maple_push_subs SET prefs = prefs || '{"quiet_window":false}'::jsonb WHERE id = $1`, [w.phones.dana]);
    await sql(`UPDATE maple_entries SET deleted_at = NOW(), updated_by = $2, updated_at = NOW() - INTERVAL '20 minutes' WHERE id = $1`, [id, alpha.member]);
    sent.length = 0;
    await notifyNursing(w.a, id);
    eq([got(w, alpha.member, "nurse").map((s) => s.title), got(w, DANA).length], [["Feed removed"], 0], "only a phone that was showing it");
  });

  await test("handoffs are never held: the planned handoff reaches a quiet next holder, and Handoff now the quiet person asked", async () => {
    const w = await quietWorld();
    const { alpha } = w;
    eq((await quietNow(w)).includes(w.phones.blake), true, "Blake's phone is quiet");
    const plannedFor = new Date(Date.now() + MIN);
    const turn = (await startShift(1, { babyId: alpha.babyId, holder: alpha.owner, handoffAt: plannedFor, nextHolder: alpha.member, by: alpha.owner, source: "web" })).shift;
    await sql(`UPDATE maple_sleep_shifts SET created_at = NOW() - INTERVAL '1 hour', updated_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [turn.id]);
    await runPushTick(new Date(plannedFor.getTime() + 30_000), { via: "wake", trusted: true, familyId: 1 });
    eq(heard("handoff"), [w.phone(alpha.member), w.phone(alpha.owner)].sort(), "the holder and the quiet next holder");
    sent.length = 0;
    await askHandoff(1, { babyId: alpha.babyId, id: turn.id, to: alpha.member, by: alpha.owner, source: "web" });
    await notifyHandoffNow(w.a, turn.id, null);
    eq(heard("handoff"), [w.phone(alpha.member)], "Handoff now wakes Blake");
  });

  await test("a held claim is never claimed again", async () => {
    const w = await quietWorld();
    const sub = (await subsOf()).find((s) => s.id === w.phones.avery)!;
    await markHeld(sub, "log:made-up-1", null);
    eq(await claim(sub, "log:made-up-1", null), null, "taken");
    ok(await claim(sub, "log:made-up-2", null), "another key claims as before");
  });

  await test("families apart: someone in two families is quiet only by each family's own roster", async () => {
    const w = await quietWorld(-2, { roster: false });
    const { alpha, beta } = w;
    // Avery is in Beta too, with a window on Beta's roster now and none on Alpha's.
    await sql(`INSERT INTO maple_members (family_id, email, role, display_name, accepted_at) VALUES (2, $1, 'member', 'Avery', NOW())`, [alpha.owner]);
    const [row] = await sql(`INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, prefs, receipt_token) VALUES (2, $1, 'https://push.example.test/quiet-avery-in-beta', 'made-up', 'made-up', '{"meds":true}', $2) RETURNING id`, [
      alpha.owner,
      "9".repeat(32),
    ]);
    const now = minuteOf(Date.now());
    const roster = [{ id: "w1", member: alpha.owner, from: local(now - 60 * MIN, beta.tz), to: local(now + 120 * MIN, beta.tz), nights: [0, 1, 2, 3, 4, 5, 6] }];
    await sql(`INSERT INTO maple_sleep_goals (family_id, baby_id, title, status, roster, item_seq, created_by, created_at, updated_at) VALUES (2, $1, 'Made-up goal', 'active', $2::jsonb, 1, $3, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')`, [
      beta.babyId,
      JSON.stringify(roster),
      beta.owner,
    ]);
    await sql(`UPDATE maple_entries SET created_at = NOW() - INTERVAL '3 days', updated_at = NOW() - INTERVAL '3 days' WHERE family_id = 2`);
    eq(await quietNow(w), [], "Avery's phone in Alpha hears everything");
    eq([...(await quietPhones(w.b, await liveSubs({ familyId: 2 }), new Date())).keys()], [Number(row.id)], "her phone in Beta is quiet");
    // And the same person awake in Alpha (the app open there) doesn't wake her Beta phone's quiet: activity is read in the family.
    await sql(`UPDATE maple_members SET last_seen_at = NOW() WHERE family_id = 1 AND email = $1`, [alpha.owner]);
    eq([...(await quietPhones(w.b, await liveSubs({ familyId: 2 }), new Date())).keys()], [Number(row.id)], "Alpha's visit is Alpha's");
  });
}

// ── the roster's pure helpers ─────────────────────────────────────────────

async function roster() {
  const tz = "America/Chicago";
  const HOUR_MS = 60 * MIN;
  const at = (iso: string) => Date.parse(iso);
  const goal = (windows: { member: string; from: string; to: string; nights?: number[] }[], status: SleepGoal["status"] = "active") => ({
    status,
    roster: windows.map((w, i) => ({ id: `w${i}`, member: w.member, from: w.from, to: w.to, nights: w.nights ?? [0, 1, 2, 3, 4, 5, 6] })),
  });
  const SAM = "sam@example.test";

  await test("quietWindowWords: the adult's own window times (and nights when not every night), or none off the roster", () => {
    eq(quietWindowWords([goal([{ member: SAM, from: "22:00", to: "02:00" }])], SAM), "10 PM–2 AM");
    eq(quietWindowWords([goal([{ member: SAM, from: "22:00", to: "02:00", nights: [0, 1, 2, 3, 4] }])], SAM), "10 PM–2 AM, Sun–Thu nights");
    eq(quietWindowWords([goal([{ member: SAM, from: "22:00", to: "02:00" }, { member: SAM, from: "04:00", to: "06:00" }])], SAM), "10 PM–2 AM and 4 AM–6 AM");
    eq(
      quietWindowWords([goal([{ member: SAM, from: "22:00", to: "02:00", nights: [0, 1, 2, 3, 4] }]), goal([{ member: SAM, from: "01:00", to: "06:30", nights: [5, 6] }])], SAM),
      "10 PM–2 AM, Sun–Thu nights; 1 AM–6:30 AM, Fri and Sat nights"
    );
    eq(quietWindowWords([goal([{ member: SAM, from: "22:00", to: "02:00" }], "paused")], SAM), null, "a paused goal");
    eq(quietWindowWords([goal([{ member: "alex@example.test", from: "22:00", to: "02:00" }])], SAM), null, "someone else's window");
  });

  await test("windowsBetween: each night's window as instants in the family's zone, across midnight, once even when two goals share it", () => {
    const g = [goal([{ member: SAM, from: "22:00", to: "02:00" }]), goal([{ member: SAM, from: "22:00", to: "02:00" }])];
    const spans = windowsBetween(g, SAM, at("2026-11-03T02:00:00Z"), at("2026-11-04T14:00:00Z"), tz);
    // Chicago is UTC-6 in November: 10 PM is 04:00Z the next day.
    eq(
      spans.map((s) => [new Date(s.start).toISOString(), new Date(s.end).toISOString()]),
      [
        ["2026-11-03T04:00:00.000Z", "2026-11-03T08:00:00.000Z"],
        ["2026-11-04T04:00:00.000Z", "2026-11-04T08:00:00.000Z"],
      ]
    );
    eq(windowsBetween(g, "alex@example.test", at("2026-11-03T02:00:00Z"), at("2026-11-04T14:00:00Z"), tz), [], "nobody else's");
  });

  await test("feedCover and the catch-up's If hungry line: the off-duty adult's window going on now, or next before the handoff, by its covers and who nurses", () => {
    const ALEX = "alex@example.test";
    const g = (covers?: string, nursing?: string | null) => [
      { ...goal([{ member: SAM, from: "22:00", to: "02:00" }]), roster: [{ id: "w1", member: SAM, from: "22:00", to: "02:00", nights: [0, 1, 2, 3, 4, 5, 6], ...(covers ? { covers: covers as "nurse" } : {}) }], template: nursing === undefined ? null : { kind: "back_to_work" as const, member: SAM, date: "2026-12-01", nursing } },
    ];
    const now = at("2026-11-03T05:00:00Z"); // 11 PM in Chicago, inside Sam's window
    eq(feedCover(g("nurse", SAM), SAM, now, now + 3 * HOUR_MS, tz), { member: SAM, end: at("2026-11-03T08:00:00Z"), covers: "nurse", nursing: SAM });
    eq(feedCover(g("bottle"), SAM, at("2026-11-03T02:00:00Z"), at("2026-11-03T05:00:00Z"), tz)?.end, at("2026-11-03T08:00:00Z"), "8 PM: the window that begins before the 11 PM handoff");
    eq(feedCover(g("bottle"), SAM, at("2026-11-03T01:00:00Z"), at("2026-11-03T03:00:00Z"), tz), null, "7 PM, handoff at 9 PM: the window begins after it");
    eq(feedCover(g("bottle"), ALEX, now, now + 3 * HOUR_MS, tz), null, "nobody else's window");
    const v = makeVoice({ name: "Wren", pronoun: "she" });
    const name = (id: string | null | undefined) => (id === SAM ? "Sam" : id === ALEX ? "Alex" : "someone");
    const line = (covers?: string, nursing?: string | null, care: string | null = null) =>
      catchUpLines({ summary: null, now: new Date(now), tz, v, me: ALEX, memberName: name, next: null, nextHolder: null, cover: feedCover(g(covers, nursing), SAM, now, now + 3 * HOUR_MS, tz), careMember: care }).find((l) => l.label === "If hungry")?.text ?? null;
    eq(line("nurse", SAM), "Before 2:00 AM: bring her to Sam to nurse");
    eq(line("nurse", undefined, SAM), "Before 2:00 AM: bring her to Sam to nurse", "her page's person, off duty, is the one who nurses");
    eq(line("nurse"), "Before 2:00 AM: nursing, as planned", "nobody named");
    eq(line("nurse", ALEX), null, "the one taking over nurses: nothing to say");
    eq(line("bottle"), "Before 2:00 AM: a bottle of expressed milk");
    eq(line("bottle", null), "Before 2:00 AM: a bottle", "bottles only");
    eq([line("none"), line(undefined)], [null, null], "no feed planned, or not said: no line, never a word against feeding her");
  });

  await test("recapSpan: the window they're in, else the one that ended by now this try day (back-to-back windows as one), else none", () => {
    const g = [goal([{ member: SAM, from: "22:00", to: "02:00" }, { member: SAM, from: "02:00", to: "05:00" }])];
    const span = (iso: string) => {
      const s = recapSpan(g, SAM, new Date(iso), tz);
      return s ? [new Date(s.start).toISOString(), s.now] : null;
    };
    eq(span("2026-11-03T05:30:00Z"), ["2026-11-03T04:00:00.000Z", true], "11:30 PM: in it, since 10 PM");
    eq(span("2026-11-03T09:00:00Z"), ["2026-11-03T04:00:00.000Z", true], "3 AM: in the second, read with the first, since 10 PM");
    eq(span("2026-11-03T13:00:00Z"), ["2026-11-03T04:00:00.000Z", false], "7 AM: just out of it, last night's");
    eq(span("2026-11-03T19:00:00Z"), null, "1 PM: a new try day, none yet");
    eq(recapSpan([goal([{ member: SAM, from: "22:00", to: "02:00" }], "met")], SAM, new Date("2026-11-03T05:30:00Z"), tz), null, "a met goal");
  });
}

audiences()
  .then(quiet)
  .then(roster)
  .then(() => done("push-quiet.check.ts"));
