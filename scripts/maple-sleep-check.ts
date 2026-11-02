/**
 * pnpm check:maple-sleep (first half): the sleep plan's engine and its
 * guidance, as pure functions on made-up records. No database, no network.
 * The second half (scripts/tenancy/sleep.check.ts) runs the store, the
 * route and the MCP tools on an in-memory Postgres.
 */
import { emergencySigns } from "../src/lib/maple/guidelines";
import { SLEEP_GUIDES, SLEEP_SECTIONS, pendingReview, sleepyLine, transferSteps, type SleepSection } from "../src/lib/maple/guidelines/sleep";
import {
  AGE_BANDS,
  chooseSleepLink,
  EARLY_MIN_TRIES,
  endsSleep,
  followSleep,
  nextHandoff,
  numberTries,
  planToday,
  planTodayLine,
  plannedTriesOn,
  progressLines,
  progressWindow,
  shiftStatus,
  sleepAge,
  sleepByPlace,
  sleepGuidance,
  sleepProgress,
  sleepSignals,
  stageSuggestion,
  SUGGEST,
  timeOfDay,
  tryDayBounds,
  tryDayKey,
  tryDayLabel,
} from "../src/lib/maple/sleep/engine";
import { SleepInputError } from "../src/lib/maple/sleep/errors";
import {
  checkinNights,
  cleanCheckinNight,
  cleanGoalInput,
  coachGuardrails,
  coachNotes,
  goalHeadLine,
  goalProgress,
  goalProgressLines,
  goalSpan,
  lastNightKey,
  lastNightLine,
  nextStep,
  seesCheckins,
  windowMinutes,
  windowOn,
  windowOnNight,
  type GoalData,
  type GoalRules,
} from "../src/lib/maple/sleep/goals";
import type { BassinetTry, GoalInput, HoldingShift, SleepCheckin, SleepGoal, SleepPlan, TryOutcome, TryTag } from "../src/lib/maple/sleep/types";
import { isTrySlot, nightsLabel, sleepyChoices, slotLabel, STAGE_INFO, weekdayOf } from "../src/lib/maple/sleep/words";
import { zonedTimeToUtc } from "../src/lib/maple/time";
import type { Entry, SleepPlace } from "../src/lib/maple/types";
import { makeVoice, type Voice } from "../src/lib/maple/voice";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const plain = (v: unknown) => (typeof v === "string" ? v.replace(/[  ]/g, " ") : v);
function eq(actual: unknown, expected: unknown, what = "value") {
  const a = JSON.stringify(plain(actual));
  const e = JSON.stringify(plain(expected));
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}
function ok(cond: unknown, what: string) {
  if (!cond) throw new Error(what);
}

const NY = "America/New_York";
const MIN = 60_000;
const HOUR = 60 * MIN;
/** A local wall-clock time in a zone, as an instant. */
const at = (y: number, mo: number, d: number, h: number, mi = 0, tz = NY) => zonedTimeToUtc(y, mo, d, h, mi, tz);
const iso = (d: Date | number) => new Date(d).toISOString();

const SHE: Voice = makeVoice({ name: "June", pronoun: "she" });
const HE: Voice = makeVoice({ name: "Ro", pronoun: "he" });
const THEY: Voice = makeVoice({ name: "the baby", pronoun: "they" });
const VOICES = [SHE, HE, THEY];

let nextId = 1;
function tryRow(start: Date, end: Date | null, outcome: TryOutcome | null, more: Partial<BassinetTry> = {}): BassinetTry {
  return {
    id: nextId++,
    started_at: iso(start),
    ended_at: end ? iso(end) : null,
    outcome,
    put_down_by: "parent@example.com",
    tags: [] as TryTag[],
    note: null,
    sleep_entry_id: null,
    made_sleep: false,
    created_by: "parent@example.com",
    updated_by: null,
    source: "web",
    created_at: iso(start),
    updated_at: iso(end ?? start),
    ...more,
  };
}
function sleepRow(start: Date, end: Date | null, place?: SleepPlace, id = nextId++): Entry {
  return {
    id,
    kind: "sleep",
    started_at: iso(start),
    ended_at: end ? iso(end) : null,
    active: end === null,
    data: place ? { place } : {},
    note: null,
    created_by: "parent@example.com",
    updated_by: null,
    source: "web",
    created_at: iso(start),
    updated_at: iso(end ?? start),
  } as Entry;
}

// ── age, from the birth date and the family's zone ───────────────────────

check("age: days come from born_at in her own zone, and the band follows (never a fixed age)", () => {
  // Born 3:12 AM local on a made-up date; two weeks less a day later she's 13 days old.
  const baby = { born_at: iso(at(2026, 10, 6, 3, 12)), timezone: NY };
  const a = sleepAge(baby, at(2026, 10, 19, 10));
  eq(a?.days, 13, "days");
  eq(a?.band.id, "first_weeks", "band");
  eq(sleepAge(baby, at(2026, 10, 20, 10))?.band.id, "early", "a day later");
  eq(sleepAge(baby, at(2026, 11, 17, 10))?.band.id, "settling", "6 weeks");
  eq(sleepAge(baby, at(2027, 1, 6, 10))?.band.id, "growing", "3 months");
  eq(sleepAge(baby, at(2027, 4, 10, 10))?.band.id, "older", "6 months");
  const other = { born_at: iso(at(2026, 9, 1, 9)), timezone: NY };
  eq(sleepAge(other, at(2026, 10, 19, 10))?.days, 48, "a different birth date gives a different age");
});

check("age: the same instant of birth is a different calendar day in another zone", () => {
  // 11:30 PM in New York is already the next day in UTC.
  const born = iso(at(2026, 10, 5, 23, 30));
  const now = at(2026, 10, 19, 15);
  eq(sleepAge({ born_at: born, timezone: NY }, now)?.days, 14, "New York");
  eq(sleepAge({ born_at: born, timezone: "UTC" }, now)?.days, 13, "UTC");
});

check("age: none before she's born, or for a birth time still ahead", () => {
  eq(sleepAge({ born_at: null, timezone: NY }, new Date()), null, "not born");
  eq(sleepAge({ born_at: iso(Date.now() + HOUR), timezone: NY }, new Date()), null, "future birth");
  ok(AGE_BANDS.every((b, i) => i === 0 || b.minDays === AGE_BANDS[i - 1].maxDays + 1), "bands meet with no gap");
});

// ── try days: noon to noon, through a clock change ────────────────────────

check("try day: noon to noon local, named by the day it starts", () => {
  eq(tryDayKey(at(2026, 10, 27, 23), NY), "2026-10-27", "11 PM");
  eq(tryDayKey(at(2026, 10, 28, 3), NY), "2026-10-27", "3 AM next morning");
  eq(tryDayKey(at(2026, 10, 28, 11, 59), NY), "2026-10-27", "11:59 AM");
  eq(tryDayKey(at(2026, 10, 28, 12), NY), "2026-10-28", "noon starts the next");
});

check("try day: the night the clocks fall back is 25 hours, and its repeated 1 AM hour stays in it", () => {
  const [a, b] = tryDayBounds("2026-10-31", NY);
  eq((b.getTime() - a.getTime()) / HOUR, 25, "hours");
  eq(iso(a), "2026-10-31T16:00:00.000Z", "starts at noon EDT");
  eq(iso(b), "2026-11-01T17:00:00.000Z", "ends at noon EST");
  // Both 1:30 AMs of Nov 1 (EDT, then EST) belong to the night of Oct 31.
  eq(tryDayKey(Date.parse("2026-11-01T05:30:00Z"), NY), "2026-10-31", "first 1:30");
  eq(tryDayKey(Date.parse("2026-11-01T06:30:00Z"), NY), "2026-10-31", "second 1:30");
});

check("try day: the night the clocks spring forward is 23 hours", () => {
  const [a, b] = tryDayBounds("2027-03-13", NY);
  eq((b.getTime() - a.getTime()) / HOUR, 23, "hours");
});

check("try day: a half-hour zone with no daylight saving", () => {
  const tz = "Asia/Kolkata";
  eq(tryDayKey(at(2026, 10, 28, 11, 59, tz), tz), "2026-10-27", "before noon");
  eq(tryDayKey(at(2026, 10, 28, 12, 0, tz), tz), "2026-10-28", "noon");
  const [a, b] = tryDayBounds("2026-10-28", tz);
  eq((b.getTime() - a.getTime()) / HOUR, 24, "hours");
});

check("try day labels", () => {
  eq(tryDayLabel("2026-10-27", "2026-10-27"), "tonight", "today");
  eq(tryDayLabel("2026-10-26", "2026-10-27"), "last night", "yesterday");
  eq(tryDayLabel("2026-10-24", "2026-10-27"), "Sat night", "this week");
});

// ── numbering and retries ────────────────────────────────────────────────

check("numbering: per try day by start, a quick second go after a crying wake is a retry", () => {
  const a = tryRow(at(2026, 10, 27, 22), at(2026, 10, 27, 22, 5), "woke_crying");
  const b = tryRow(at(2026, 10, 27, 22, 25), at(2026, 10, 28, 1, 40), "stayed_asleep");
  const c = tryRow(at(2026, 10, 28, 9), at(2026, 10, 28, 9, 50), "stayed_asleep");
  const d = tryRow(at(2026, 10, 28, 21), null, null);
  const nums = numberTries([d, c, a, b], NY);
  eq([a, b, c].map((t) => nums.get(t.id)), [
    { day: "2026-10-27", n: 1, of: 3, retry: false },
    { day: "2026-10-27", n: 2, of: 3, retry: true },
    { day: "2026-10-27", n: 3, of: 3, retry: false },
  ], "the night and its morning");
  eq(nums.get(d.id), { day: "2026-10-28", n: 1, of: 1, retry: false }, "the next night starts again at 1");
  eq(plannedTriesOn([a, b, c, d], "2026-10-27", NY), 2, "a retry doesn't count against tries a day");
});

check("numbering: deleting a try renumbers its day (worked out, never stored)", () => {
  const a = tryRow(at(2026, 10, 27, 20), at(2026, 10, 27, 21), "stayed_asleep");
  const b = tryRow(at(2026, 10, 27, 23), at(2026, 10, 28, 1), "stayed_asleep");
  eq(numberTries([a, b], NY).get(b.id)?.n, 2, "second");
  eq(numberTries([{ ...a, deleted_at: iso(Date.now()) } as BassinetTry, b], NY).get(b.id)?.n, 1, "first once the other is gone");
});

check("numbering: a try 40 minutes after a crying wake is a new try, not a retry", () => {
  const a = tryRow(at(2026, 10, 27, 22), at(2026, 10, 27, 22, 5), "woke_crying");
  const b = tryRow(at(2026, 10, 27, 22, 45), null, null);
  eq(numberTries([a, b], NY).get(b.id)?.retry, false, "retry");
});

// ── which sleep a try sits on ────────────────────────────────────────────

check("link: a running sleep timer, else the logged sleep it overlaps most, else a new one", () => {
  const now = at(2026, 10, 28, 2).getTime();
  const running = sleepRow(at(2026, 10, 28, 1), null);
  eq(chooseSleepLink(at(2026, 10, 28, 1, 30).getTime(), null, [running], now).kind, "running", "running");
  const small = sleepRow(at(2026, 10, 27, 21), at(2026, 10, 27, 22, 10), "arms");
  const big = sleepRow(at(2026, 10, 27, 22, 0), at(2026, 10, 28, 0, 30));
  const pick = chooseSleepLink(at(2026, 10, 27, 22, 5).getTime(), at(2026, 10, 28, 0).getTime(), [small, big], now);
  eq(pick.kind === "overlap" && pick.entry.id, big.id, "largest overlap");
  const before = sleepRow(at(2026, 10, 27, 19), at(2026, 10, 27, 20));
  eq(chooseSleepLink(at(2026, 10, 27, 20, 5).getTime(), null, [before], now).kind, "create", "a sleep that ended before the try");
  eq(chooseSleepLink(at(2026, 10, 27, 20, 5).getTime(), null, [], now).kind, "create", "nothing logged");
});

check("link: waking ends the sleep with the try; picked up still asleep, it runs on", () => {
  eq((["stayed_asleep", "woke_calm", "woke_crying", "picked_up"] as TryOutcome[]).map(endsSleep), [true, true, true, false], "endsSleep");
});

check("corrections: only an edge that matched the try's moves the linked sleep", () => {
  const t0 = at(2026, 10, 27, 22).getTime();
  const t1 = at(2026, 10, 27, 23).getTime();
  // A sleep the try made: same start and end.
  eq(followSleep({ start: t0, end: t1 }, { start: t0 - 5 * MIN, end: t1 }, { start: t0, end: t1 }), { start: t0 - 5 * MIN }, "start moves along");
  eq(followSleep({ start: t0, end: t1 }, { start: t0, end: t1 + 10 * MIN }, { start: t0, end: t1 }), { end: t1 + 10 * MIN }, "end moves along");
  // A held sleep that began earlier: the transfer time moving doesn't move when she fell asleep.
  eq(followSleep({ start: t0, end: t1 }, { start: t0 + 2 * MIN, end: t1 }, { start: t0 - HOUR, end: t1 }), null, "earlier sleep start stays");
  eq(followSleep({ start: t0, end: null }, { start: t0 - MIN, end: null }, { start: t0, end: null }), { start: t0 - MIN }, "running");
  eq(followSleep({ start: t0, end: t1 }, { start: t1 + HOUR, end: t1 + 2 * HOUR }, { start: t0, end: t0 + 10 * MIN }), null, "never leaves a sleep ending before it starts");
});

// ── sleep by place: every second once ────────────────────────────────────

check("by place: a try's window is the bassinet, the rest is the sleep's own place, and they add up", () => {
  const held = sleepRow(at(2026, 10, 28, 1), at(2026, 10, 28, 4), "arms");
  const bare = sleepRow(at(2026, 10, 28, 5), at(2026, 10, 28, 6), "bassinet");
  const blank = sleepRow(at(2026, 10, 28, 7), at(2026, 10, 28, 8));
  const t = tryRow(at(2026, 10, 28, 2), at(2026, 10, 28, 4), "stayed_asleep", { sleep_entry_id: held.id });
  const r = sleepByPlace([held, bare, blank], [t], at(2026, 10, 27, 12).getTime(), at(2026, 10, 28, 12).getTime(), at(2026, 10, 28, 12).getTime());
  const sec = Object.fromEntries(r.places.map((p) => [p.place, p.sec]));
  eq(sec, { bassinet: 3 * 3600, arms: 3600, unknown: 3600 }, "seconds by place");
  eq(r.totalSec, 5 * 3600, "total");
  eq(r.places.reduce((n, p) => n + p.sec, 0), r.totalSec, "places add up to the total");
  eq(r.places.find((p) => p.place === "bassinet")?.sleeps, 2, "sleeps in the bassinet");
});

check("by place: overlapping tries on one sleep, a try past the sleep's end, and a try with no sleep count nothing twice", () => {
  const s = sleepRow(at(2026, 10, 28, 1), at(2026, 10, 28, 3), "arms");
  const a = tryRow(at(2026, 10, 28, 1, 30), at(2026, 10, 28, 2, 30), "picked_up", { sleep_entry_id: s.id });
  const b = tryRow(at(2026, 10, 28, 2), at(2026, 10, 28, 3, 30), "woke_calm", { sleep_entry_id: s.id });
  const orphan = tryRow(at(2026, 10, 28, 5), at(2026, 10, 28, 6), "stayed_asleep", { sleep_entry_id: 999_999 });
  const r = sleepByPlace([s], [a, b, orphan], 0, Number.MAX_SAFE_INTEGER, at(2026, 10, 28, 12).getTime());
  const sec = Object.fromEntries(r.places.map((p) => [p.place, p.sec]));
  eq(sec, { bassinet: 1.5 * 3600, arms: 0.5 * 3600 }, "seconds");
  eq(r.totalSec, 2 * 3600, "total is the sleep's two hours, not more");
});

check("by place: the window cuts sleeps at its edges", () => {
  const s = sleepRow(at(2026, 10, 27, 10), at(2026, 10, 27, 14), "carrier");
  const r = sleepByPlace([s], [], at(2026, 10, 27, 12).getTime(), at(2026, 10, 28, 12).getTime(), at(2026, 10, 28, 12).getTime());
  eq(r.totalSec, 2 * 3600, "only the part inside");
});

// ── the progress view ────────────────────────────────────────────────────

function week(now: Date, pattern: [number, number, TryOutcome, number, TryTag[]?][]): BassinetTry[] {
  // [days back, local hour, outcome, minutes down, tags]
  return pattern.map(([back, hour, outcome, mins, tags]) => {
    const start = new Date(at(2026, 10, 28, hour).getTime() - back * 24 * HOUR);
    return tryRow(start, new Date(start.getTime() + mins * MIN), outcome, { tags: tags ?? [] });
  });
}

check("progress: counts with their sample sizes, and no pattern until there are enough tries", () => {
  const now = at(2026, 10, 28, 15);
  const tries = week(now, [
    [6, 22, "stayed_asleep", 90],
    [5, 23, "woke_crying", 4],
    [4, 22, "stayed_asleep", 120],
    [3, 2, "woke_calm", 15],
    [1, 22, "picked_up", 20],
    [0, 9, "stayed_asleep", 45],
  ]);
  const p = sleepProgress({ tries, entries: [], now, tz: NY });
  // A 2 AM or 9 AM try belongs to the night before it (noon to noon): six tries on four try days.
  eq([p.tries, p.finished, p.tryDays], [6, 6, 4], "tries, finished, days");
  eq(p.stayedAsleep, { n: 3, of: 6 }, "stayed asleep");
  eq(p.outcomes, { stayed_asleep: 3, woke_calm: 1, woke_crying: 1, picked_up: 1 }, "outcomes");
  eq(p.byTimeOfDay.map((b) => [b.part, b.tries]), [["night", 1], ["morning", 1], ["afternoon", 0], ["evening", 4]], "by time of day");
  eq(p.enough, false, "enough");
  eq(p.observations, [], "no early observations under the threshold");
  const lines = progressLines(p, NY, now).join(" ");
  ok(/Stayed asleep in 3 of 6 finished tries/.test(lines), lines);
  ok(/Too few tries to see patterns yet \(6 of 10 finished\)/.test(lines), lines);
  ok(!/%/.test(lines), "no percentage under the threshold");
});

check("progress: with enough tries, a pattern shows only as an early observation with its numbers", () => {
  const now = at(2026, 10, 28, 21);
  const rows: [number, number, TryOutcome, number, TryTag[]?][] = [];
  for (let i = 0; i < 6; i++) rows.push([i, 2, i < 5 ? "stayed_asleep" : "woke_calm", 60, ["fed"]]);
  for (let i = 0; i < 6; i++) rows.push([i, 19, i < 1 ? "stayed_asleep" : "woke_crying", 5]);
  const p = sleepProgress({ tries: week(now, rows), entries: [], now, tz: NY });
  ok(p.finished >= EARLY_MIN_TRIES, "enough tries");
  ok(p.observations.length >= 1 && p.observations.every((o) => o.startsWith("Early observation (12 tries)")), JSON.stringify(p.observations));
  ok(p.observations.some((o) => /night tries stayed asleep in 5 of 6; evening tries, 1 of 6/.test(o)), JSON.stringify(p.observations));
  const lines = progressLines(p, NY, now).join(" ");
  ok(/about 50%/.test(lines), lines);
});

check("progress: the longest bassinet stretch and sleep by place over the week", () => {
  const now = at(2026, 10, 28, 15);
  const s1 = sleepRow(at(2026, 10, 27, 22), at(2026, 10, 28, 1, 30), "arms");
  const t1 = tryRow(at(2026, 10, 27, 22, 30), at(2026, 10, 28, 1, 30), "stayed_asleep", { sleep_entry_id: s1.id });
  const s2 = sleepRow(at(2026, 10, 26, 23), at(2026, 10, 27, 0), "bassinet");
  const p = sleepProgress({ tries: [t1], entries: [s1, s2], now, tz: NY });
  eq(p.longestBassinet?.sec, 3 * 3600, "longest");
  eq(p.places.map((x) => [x.place, x.sec]), [["bassinet", 4 * 3600], ["arms", 1800]], "places");
  ok(/Longest stretch in the bassinet: 3h 00m \(last night, from 10:30 PM\)/.test(progressLines(p, NY, now).join(" ")), "line");
});

check("progress: the window is the last 7 try days, through a clock change", () => {
  const w = progressWindow(at(2026, 11, 2, 9), NY);
  eq(w.keys, ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"], "keys");
  eq((w.to.getTime() - w.from.getTime()) / HOUR, 7 * 24 + 1, "hours (one 25-hour night)");
});

check("progress: no grades, streaks, scores, best times or failure words in any line", () => {
  const now = at(2026, 10, 28, 15);
  const rows: [number, number, TryOutcome, number][] = [];
  for (let i = 0; i < 12; i++) rows.push([i % 7, i % 2 ? 22 : 4, i % 3 ? "woke_crying" : "stayed_asleep", 30]);
  const text = progressLines(sleepProgress({ tries: week(now, rows), entries: [], now, tz: NY }), NY, now).join(" ");
  ok(!/\b(fail|failed|failure|streak|grade|score|best|worst|success)\b/i.test(text), text);
});

check("time of day buckets by the local hour a try began", () => {
  eq([0, 5, 6, 11, 12, 17, 18, 23].map((h) => timeOfDay(at(2026, 10, 28, h).getTime(), NY)), ["night", "night", "morning", "morning", "afternoon", "afternoon", "evening", "evening"], "buckets");
});

// ── the stage suggestion: shown, never applied ───────────────────────────

const plan = (over: Partial<SleepPlan> = {}): SleepPlan => ({
  baby_id: 1,
  stage: 1,
  stage_since: iso(at(2026, 10, 1, 12)),
  sleeps_now: "arms",
  goal: null,
  tries_per_day: 1,
  try_times: ["first_night_stretch"],
  fallback: "first_morning_nap",
  snoozed_until: null,
  revision: 1,
  created_by: null,
  updated_by: null,
  source: "web",
  created_at: iso(at(2026, 10, 1, 12)),
  updated_at: iso(at(2026, 10, 1, 12)),
  ...over,
});

check("suggestion: needs 5 tries on 4 days and 3 of the last 5 asleep 30+ minutes", () => {
  const now = at(2026, 10, 28, 15);
  const good = week(now, [
    [5, 22, "stayed_asleep", 60],
    [4, 22, "woke_crying", 3],
    [3, 22, "stayed_asleep", 45],
    [2, 22, "stayed_asleep", 90],
    [1, 22, "woke_calm", 10],
  ]);
  const p = plan();
  const before = JSON.stringify(p);
  const s = stageSuggestion(p, good, now, NY);
  eq(s && { from: s.from, to: s.to, tries: s.tries, days: s.days, stayed: s.stayed, snoozed: s.snoozed }, { from: 1, to: 2, tries: 5, days: 5, stayed: 3, snoozed: false }, "suggestion");
  eq(JSON.stringify(p), before, "the plan is never changed");
  eq(stageSuggestion(p, good.slice(0, 4), now, NY), null, "four tries isn't enough");
  const short = good.map((t, i) => (i === 0 ? { ...t, ended_at: iso(Date.parse(t.started_at) + 20 * MIN) } : t));
  eq(stageSuggestion(p, short, now, NY), null, "a 20-minute stay doesn't count as stayed 30+");
  eq(stageSuggestion(plan({ stage_since: iso(at(2026, 10, 27, 12)) }), good, now, NY), null, "tries before the stage began don't count");
  eq(stageSuggestion(plan({ stage: 4 }), good, now, NY), null, "nothing after the last stage");
  eq(stageSuggestion(plan({ snoozed_until: "2026-10-30" }), good, now, NY)?.snoozed, true, "not now");
  eq(stageSuggestion(null, good, now, NY), null, "no plan");
  eq(SUGGEST.recentStayed <= SUGGEST.recent, true, "thresholds hang together");
});

check("today: tries against the plan, retries not counted, and the morning-nap backup", () => {
  const p = plan();
  const night = at(2026, 10, 27, 23);
  eq(planTodayLine(planToday(p, [], night, NY)), "0 of 1 tonight; next: the first long night stretch after a feed.", "evening");
  const morning = at(2026, 10, 28, 8);
  const t = planToday(p, [], morning, NY);
  eq([t.next, t.fallback], ["first_morning_nap", true], "the night went by");
  const a = tryRow(at(2026, 10, 27, 23), at(2026, 10, 27, 23, 4), "woke_crying");
  const b = tryRow(at(2026, 10, 27, 23, 20), at(2026, 10, 28, 2), "stayed_asleep");
  eq(planToday(p, [a, b], morning, NY).done, 1, "a retry is part of its try");
  eq(planToday(p, [a, b], morning, NY).next, null, "done for the day");
});

check("shifts: due at the planned handoff, and the next one keeps the same length", () => {
  const start = at(2026, 10, 28, 1);
  const s = { started_at: iso(start), handoff_at: iso(start.getTime() + 2 * HOUR), ended_at: null };
  eq(shiftStatus(s, new Date(start.getTime() + HOUR)), { open: true, due: false, minutesLeft: 60 }, "an hour left");
  eq(shiftStatus(s, new Date(start.getTime() + 2 * HOUR + MIN)).due, true, "due");
  eq(shiftStatus({ ...s, ended_at: iso(start) }, new Date()).open, false, "ended");
  eq(nextHandoff(s, start.getTime() + 2 * HOUR), start.getTime() + 4 * HOUR, "same length");
  eq(nextHandoff({ started_at: s.started_at, handoff_at: null }, start.getTime()), start.getTime() + 2 * HOUR, "two hours by default");
});

// ── signals and guidance ─────────────────────────────────────────────────

check("signals: from the recent log", () => {
  const now = at(2026, 10, 28, 3);
  eq([...sleepSignals([], now, NY)], ["no_tries_yet"], "nothing yet");
  const cry = tryRow(at(2026, 10, 28, 2), at(2026, 10, 28, 2, 6), "woke_crying", { tags: ["swaddled"] });
  eq([...sleepSignals([cry], now, NY)].sort(), ["after_crying", "swaddled"], "a crying wake");
  const retry = tryRow(at(2026, 10, 28, 2, 20), at(2026, 10, 28, 2, 25), "woke_crying");
  eq([...sleepSignals([cry, retry], now, NY)].sort(), ["hard_day", "retry_done"], "the retry woke too");
  const old = tryRow(at(2026, 10, 24, 22), at(2026, 10, 25, 1), "stayed_asleep");
  eq([...sleepSignals([old], now, NY)], ["long_gap"], "a few days since");
});

const textOf = (v: Voice, days: number, stage: 1 | 2 | 3 | 4 | null, signals: Parameters<typeof sleepGuidance>[1]["signals"]) => {
  const g = sleepGuidance(v, { days, stage, signals });
  return { g, ids: [...g.now, ...g.sections.flatMap((s) => s.items)].map((x) => x.id) };
};

check("guidance: matched to her age, the stage and the log", () => {
  const { g, ids } = textOf(SHE, 13, 1, new Set());
  eq(g.sections.map((s) => s.section), ["next", "transfer", "crying", "normal", "safe", "call", "emergency"], "sections");
  ok(ids.includes("next-stage-1") && !ids.includes("next-stage-2"), "stage 1's next step only");
  ok(ids.includes("normal-feeds-first") && ids.includes("call-diapers-first-weeks"), "first-weeks items at 13 days");
  ok(!textOf(SHE, 60, 1, new Set()).ids.includes("normal-feeds-first"), "not at 2 months");
  ok(!textOf(SHE, 3, 1, new Set()).ids.includes("call-diapers-first-weeks"), "not before a week");
  ok(!ids.includes("bad-day-normal"), "no bad-day items without a hard day");
  const cry = textOf(SHE, 13, 1, new Set(["after_crying"]));
  eq(cry.g.now[0]?.id, "crying-soothe", "a crying wake lifts the soothe-and-retry item");
  const hard = textOf(SHE, 13, 1, new Set(["hard_day"]));
  ok(hard.ids.includes("bad-day-normal") && hard.ids.includes("bad-day-help"), "a hard day brings recovery guidance");
  eq(sleepGuidance(SHE, { days: null, stage: 1, signals: new Set() }), { now: [], sections: [] }, "nothing without an age");
});

// ── the content's own rules ──────────────────────────────────────────────

const ALLOWED_HOSTS = new Set(["www.healthychildren.org", "pubmed.ncbi.nlm.nih.gov", "publications.aap.org", "www.aap.org", "988lifeline.org"]);

check("content: every item has an age window, a source URL and a last-reviewed date", () => {
  const ids = new Set<string>();
  const today = new Date().toISOString().slice(0, 10);
  for (const g of SLEEP_GUIDES) {
    ok(!ids.has(g.id), `duplicate id ${g.id}`);
    ids.add(g.id);
    ok(Number.isInteger(g.minDays) && g.minDays >= 0 && g.maxDays >= g.minDays, `${g.id}: age window ${g.minDays}–${g.maxDays}`);
    ok(g.sources.length >= 1, `${g.id}: no source`);
    for (const s of g.sources) {
      const u = new URL(s.url);
      ok(u.protocol === "https:" && ALLOWED_HOSTS.has(u.host), `${g.id}: source ${s.url}`);
      ok(s.label.trim().length > 0, `${g.id}: source label`);
    }
    ok(/^\d{4}-\d{2}-\d{2}$/.test(g.reviewed) && g.reviewed <= today, `${g.id}: reviewed ${g.reviewed}`);
    ok((SLEEP_SECTIONS as readonly string[]).includes(g.section), `${g.id}: section`);
  }
});

check("content: safe sleep, call the pediatrician, emergency, transfer and crying cover every age to a year", () => {
  const need: SleepSection[] = ["safe", "call", "emergency", "transfer", "crying"];
  for (let d = 0; d <= 365; d++) {
    for (const s of need) ok(SLEEP_GUIDES.some((g) => g.section === s && d >= g.minDays && d <= g.maxDays && !g.when && !g.stages), `day ${d}: no ${s}`);
  }
});

check("content: the AAP safe-sleep points are all there", () => {
  const safe = SLEEP_GUIDES.filter((g) => g.section === "safe").map((g) => g.body(SHE)).join(" ");
  for (const [what, re] of [
    ["back", /on her back for every nap and at night/],
    ["firm and flat", /firm, flat surface/],
    ["nothing soft or loose", /nothing soft or loose/],
    ["room-sharing", /in your room, close to your bed but not in it, for at least the first 6 months/],
    ["swaddling and rolling", /Stop swaddling as soon as she shows any signs of trying to roll/],
  ] as const) ok(re.test(safe), `missing: ${what}`);
});

check("content: the five transfer steps, in the family's order", () => {
  const steps = transferSteps(SHE);
  eq(steps.length, 5, "steps");
  [/^Feed and burp her\.$/, /^Swaddle her/, /until she's deeply asleep/, /^Lay her on her back in the bassinet\.$/, /hand on her chest/].forEach((re, i) => ok(re.test(steps[i]), `step ${i + 1}: ${steps[i]}`));
});

check("content: if she wakes crying, soothe her, retry once, then pause; never crying it out", () => {
  const soothe = SLEEP_GUIDES.find((g) => g.id === "crying-soothe")!.body(SHE);
  ok(/soothe her/.test(soothe) && /try the bassinet once more/.test(soothe) && /never asks you to leave her to cry/.test(soothe), soothe);
  const pause = SLEEP_GUIDES.find((g) => g.id === "crying-pause")!.body(SHE);
  ok(/next planned try/.test(pause), pause);
});

check("content: call the pediatrician covers fever, breathing, crying, and feeding or diapers; emergency is the app's 911 line", () => {
  const call = SLEEP_GUIDES.filter((g) => g.section === "call");
  const text = call.map((g) => g.body(SHE)).join(" ");
  ok(/100\.4°F \(38\.0°C\)/.test(text) && /breathing/.test(text) && /cried nonstop for more than 2 hours/.test(text) && /wet diapers/.test(text), text);
  ok(call.every((g) => /pediatrician|911/.test(g.body(SHE))), "every call item says who to call");
  for (const v of VOICES) eq(SLEEP_GUIDES.find((g) => g.id === "emergency-911")!.body(v), emergencySigns(v), `emergency for ${v.name}`);
});

/** Everything the guidance and the plan's words can show, in each voice. */
function allText(v: Voice): string[] {
  const out: string[] = [];
  for (const g of SLEEP_GUIDES) out.push(g.title(v), g.body(v), ...(g.steps?.(v) ?? []));
  for (const s of Object.values(STAGE_INFO)) out.push(s.title, s.goal);
  for (const c of sleepyChoices(v, "Sam")) out.push(c.label, c.hint);
  out.push(sleepyLine(v));
  return out;
}

check("content: never crying it out, never sleep on an adult or sharing their bed, couch or armchair as safe, no doses, no diagnosis", () => {
  const banned: [string, RegExp][] = [
    ["crying it out", /cry[- ]?it[- ]?out|\blet (her|him|them|the baby) cry\b|sleep[- ]?train|\bferber|\bextinction\b|controlled crying/i],
    ["sleep with an adult as an option", /\b(safe|okay|ok|fine) to (sleep|nap|doze)\b|contact (nap|sleep)|co-?sleep|bed[- ]?shar|sleep (on|with) (you|your|an adult|a parent)/i],
    ["a dose", /\bdoses?\b|\b\d+(\.\d+)?\s?(mg|ml|mL|teaspoons?|tsp)\b/i],
    ["a diagnosis", /\bdiagnos|\bit'?s (probably|likely) (reflux|colic|an infection)/i],
  ];
  for (const v of VOICES) for (const line of allText(v)) for (const [what, re] of banned) ok(!re.test(line), `${what}: "${line}"`);
});

check("content: names and pronouns follow the family's profile, with agreeing verbs", () => {
  for (const line of allText(THEY)) {
    ok(!/\b(she|her|hers|herself|he|him|his|himself)\b/i.test(line), `they voice: "${line}"`);
    ok(!/\bthey (is|has|was|seems|wakes|shows|falls|cries|feeds|sleeps)\b|\bthey's\b/i.test(line), `they agreement: "${line}"`);
  }
  for (const line of allText(HE)) ok(!/\b(she|her|hers|herself)\b/i.test(line), `he voice: "${line}"`);
  ok(allText(SHE).some((l) => /\bJune\b/.test(l)), "her name is used");
});

check("sleepy: exactly two choices, the bassinet or the partner, and nothing that keeps her on a sleepy adult", () => {
  const c = sleepyChoices(SHE, "Sam");
  eq(c.map((x) => x.id), ["bassinet", "partner"], "choices");
  eq(c[1].label, "Wake Sam", "names the partner");
  eq(sleepyChoices(SHE, null)[1].label, "Wake your partner", "without a partner's name");
  ok(c.every((x) => !/keep holding|sleep with|your bed|couch|chair/i.test(`${x.label} ${x.hint}`)), "no unsafe option");
  ok(/lay her on her back in the bassinet or hand her to someone who's awake/.test(sleepyLine(SHE)), sleepyLine(SHE));
});

check("words: try times are named moments or a local clock time", () => {
  ok(isTrySlot("first_night_stretch") && isTrySlot("22:30") && isTrySlot("06:05"), "valid");
  ok(!isTrySlot("24:00") && !isTrySlot("bedtime") && !isTrySlot("9:30") && !isTrySlot(null), "invalid");
  eq(plain(slotLabel("22:30")), "Around 10:30 PM", "clock label");
  eq(slotLabel("first_morning_nap"), "The first morning nap", "anchor label");
  eq(STAGE_INFO[1].defaults, { tries_per_day: 1, try_times: ["first_night_stretch"], fallback: "first_morning_nap" }, "stage 1 is one try a day at the first long night stretch, the morning nap as a fallback");
});

check("review: every item is still waiting for a person's sign-off (listed for release)", () => {
  eq(pendingReview().length, SLEEP_GUIDES.length, "pending");
});

// ── sleep goals: weeks, targets, the roster, check-ins and coaching ──────

const SAM = "sam@example.test";
const ALEX = "alex@example.test";
const CASEY = "casey@example.test";
const NAMES: Record<string, string> = { [SAM]: "Sam", [ALEX]: "Alex", [CASEY]: "Casey" };
const nameOf = (id: string) => NAMES[id] ?? id;
const RULES: GoalRules = { current: null, adults: new Set([SAM, ALEX]), name: nameOf, today: "2026-11-02", seq: 0 };
const EVERY = [0, 1, 2, 3, 4, 5, 6];

function goalRow(over: Partial<SleepGoal> = {}): SleepGoal {
  return {
    id: 3,
    baby_id: 1,
    title: "Both of us get a 4-hour stretch",
    why: null,
    target_date: null,
    status: "active",
    targets: [],
    steps: [],
    roster: [],
    last_review_at: null,
    review_note: null,
    closed_at: null,
    revision: 1,
    created_by: SAM,
    updated_by: null,
    source: "chat",
    // A Monday, 9 AM in New York: the goal's first night is that evening's.
    created_at: iso(at(2026, 11, 2, 9)),
    updated_at: iso(at(2026, 11, 2, 9)),
    ...over,
  };
}
const checkinRow = (member: string, night: string, answer: SleepCheckin["protected"], more: Partial<SleepCheckin> & { deleted_at?: string } = {}): SleepCheckin => ({
  id: nextId++,
  member,
  night,
  protected: answer,
  note: null,
  source: "web",
  created_at: iso(at(2026, 11, 9, 8)),
  updated_at: iso(at(2026, 11, 9, 8)),
  ...more,
});
const feedRow = (start: Date, by = SAM): Entry =>
  ({ id: nextId++, kind: "feed", started_at: iso(start), ended_at: iso(start.getTime() + 20 * MIN), active: false, data: { method: "breast" }, note: null, created_by: by, updated_by: null, source: "web", created_at: iso(start), updated_at: iso(start) }) as Entry;
const shiftRow = (holder: string, start: Date, end: Date): HoldingShift => ({
  id: nextId++,
  holder,
  started_at: iso(start),
  handoff_at: null,
  next_holder: null,
  ended_at: iso(end),
  ended_how: "ended",
  created_by: holder,
  updated_by: null,
  source: "web",
  created_at: iso(start),
  updated_at: iso(end),
});
const data = (over: Partial<GoalData> = {}): GoalData => ({ tries: [], entries: [], shifts: [], checkins: [], ...over });
const words = (v: Voice, now: Date, tz = NY) => ({ v, name: nameOf, tz, now });
function throwsInput(fn: () => unknown, re: RegExp, what: string) {
  try {
    fn();
  } catch (e) {
    ok(e instanceof SleepInputError, `${what}: threw ${e instanceof Error ? e.constructor.name : typeof e}, not SleepInputError`);
    ok(re.test((e as Error).message), `${what}: "${(e as Error).message}"`);
    return;
  }
  throw new Error(`${what}: didn't throw`);
}

check("goal weeks: 7 nights at a time from the night it was set, through its target date, with days left by the family's calendar", () => {
  const g = goalRow({ target_date: "2026-11-30" });
  const s = goalSpan(g, at(2026, 11, 10, 21), NY);
  eq([s.startsOn, s.endsOn, s.daysLeft, s.weekNow, s.weeksTotal, s.weeksHidden], ["2026-11-02", "2026-11-30", 20, 2, 5, 0], "span");
  eq(s.weeks, [
    { n: 1, from: "2026-11-02", to: "2026-11-08", nights: 7, current: false },
    { n: 2, from: "2026-11-09", to: "2026-11-15", nights: 2, current: true },
  ], "weeks");
  const just = goalSpan(g, at(2026, 11, 2, 9, 30), NY);
  eq([just.weekNow, just.weeks], [1, [{ n: 1, from: "2026-11-02", to: "2026-11-08", nights: 0, current: true }]], "set this morning: week 1, its first night still ahead");
  const lastDay = goalSpan(g, at(2026, 12, 1, 10), NY);
  eq([lastDay.weekNow, lastDay.weeks.at(-1)], [5, { n: 5, from: "2026-11-30", to: "2026-11-30", nights: 1, current: true }], "the target date's night is the last, a short week");
  const after = goalSpan(g, at(2026, 12, 2, 21), NY);
  eq([after.weekNow, after.daysLeft, after.weeks.length, after.lastNight], [null, -2, 5, "2026-11-30"], "past the target date: nothing after it counts");
  ok(/Target date Mon, Nov 30 \(20 days left\); week 2 of 5\./.test(goalHeadLine(g, s, { tz: NY })), goalHeadLine(g, s, { tz: NY }));
});

check("goal weeks: without a target date the last 4; a closed goal stops at the night it closed", () => {
  const s = goalSpan(goalRow({ created_at: iso(at(2026, 9, 20, 9)) }), at(2026, 11, 10, 21), NY);
  eq([s.weeks.map((w) => w.n), s.weeksHidden, s.weeksTotal, s.daysLeft, s.weekNow], [[5, 6, 7, 8], 4, null, null, 8], "the last four");
  const closed = goalSpan(goalRow({ status: "met", closed_at: iso(at(2026, 11, 5, 20)) }), at(2026, 11, 10, 21), NY);
  eq([closed.weekNow, closed.weeks, closed.lastNight], [null, [{ n: 1, from: "2026-11-02", to: "2026-11-08", nights: 4, current: false }], "2026-11-05"], "closed on the 5th");
  ok(/\(Met on Thu, Nov 5\)/.test(goalHeadLine(goalRow({ status: "met", closed_at: iso(at(2026, 11, 5, 20)) }), closed, { tz: NY })), "met, with the day");
});

check("goal weeks: the night the clocks fall back is one night with both its 1:30s, and a window's real length follows the clock", () => {
  const g = goalRow({ created_at: iso(at(2026, 10, 28, 12)), targets: [{ id: "a1", kind: "bassinet_nights", per_week: 3, min_minutes: 60 }] });
  // Laid down at the first 1:30 AM (EDT), still asleep at the second (EST): an hour, on the night of Oct 31.
  const t1 = tryRow(new Date("2026-11-01T05:30:00Z"), new Date("2026-11-01T06:30:00Z"), "stayed_asleep");
  const t2 = tryRow(new Date("2026-11-01T06:45:00Z"), new Date("2026-11-01T07:00:00Z"), "woke_calm");
  const p = goalProgress(g, data({ tries: [t1, t2] }), at(2026, 11, 3, 10), NY);
  const tp = p.targets[0];
  eq(tp.kind === "bassinet_nights" && tp.weeks[0], { week: 1, counted: 1, tried: 1, nights: 6 }, "one night, counted once");
  const len = (w: { from: string; to: string }, night: string, tz = NY) => {
    const [a, b] = windowOn(w, night, tz);
    return (b.getTime() - a.getTime()) / HOUR;
  };
  eq([len({ from: "22:00", to: "06:00" }, "2026-10-31"), len({ from: "22:00", to: "06:00" }, "2027-03-13"), len({ from: "22:00", to: "06:00" }, "2026-11-07")], [9, 7, 8], "fall back, spring forward, an ordinary night");
  eq(len({ from: "22:00", to: "06:00" }, "2026-10-31", "Asia/Kolkata"), 8, "a zone with no clock change");
  eq(iso(windowOn({ from: "04:00", to: "07:00" }, "2026-11-02", NY)[0]), iso(at(2026, 11, 3, 4)), "a time before noon is the next morning's");
  eq(iso(windowOn({ from: "22:00", to: "02:00" }, "2026-11-02", NY)[1]), iso(at(2026, 11, 3, 2)), "across midnight");
});

check("goal weeks: the same moment set is a different first night in another zone", () => {
  const g = goalRow({ created_at: "2026-11-02T03:00:00.000Z" });
  eq([goalSpan(g, new Date("2026-11-05T12:00:00Z"), "America/Los_Angeles").startsOn, goalSpan(g, new Date("2026-11-05T12:00:00Z"), "Asia/Kolkata").startsOn], ["2026-11-01", "2026-11-02"], "8 PM in Los Angeles, 8:30 AM in Kolkata");
  // 10:30 AM in Kolkata belongs to the night before it, as a try day does.
  eq(lastNightKey(new Date("2026-11-05T05:00:00Z"), "Asia/Kolkata"), "2026-11-04", "last night there");
});

check("bassinet nights: a night counts once, with a try that stayed asleep the target's minutes; running, deleted and short ones don't", () => {
  const g = goalRow({ targets: [{ id: "a1", kind: "bassinet_nights", per_week: 4, min_minutes: 60 }] });
  const tries = [
    tryRow(at(2026, 11, 2, 22), at(2026, 11, 2, 23, 15), "stayed_asleep"),
    tryRow(at(2026, 11, 3, 22), at(2026, 11, 3, 22, 50), "stayed_asleep"),
    tryRow(at(2026, 11, 4, 23), at(2026, 11, 4, 23, 5), "woke_crying"),
    tryRow(at(2026, 11, 4, 23, 30), at(2026, 11, 5, 1), "stayed_asleep"),
    tryRow(at(2026, 11, 5, 2), at(2026, 11, 5, 3, 30), "picked_up"),
    { ...tryRow(at(2026, 11, 6, 22), at(2026, 11, 6, 23, 30), "stayed_asleep"), deleted_at: iso(at(2026, 11, 7, 9)) } as BassinetTry,
    tryRow(at(2026, 11, 8, 22), null, null),
  ];
  const p = goalProgress(g, data({ tries }), at(2026, 11, 9, 10), NY);
  const tp = p.targets[0];
  eq(tp.kind === "bassinet_nights" && tp.weeks, [{ week: 1, counted: 2, tried: 3, nights: 7 }], "two nights of three tried");
  const line = goalProgressLines(g, p, words(SHE, at(2026, 11, 9, 10))).join(" ");
  ok(/Aim: 4 nights a week with a bassinet try asleep 1 hour or more\. This week: 2 nights \(finished tries on 3 of 7 nights so far\)\./.test(line), line);
});

check("bassinet stretch: the longest each week and how many reached the aim, every stretch counted once", () => {
  const g = goalRow({ targets: [{ id: "a1", kind: "bassinet_stretch", minutes: 180 }] });
  const s1 = sleepRow(at(2026, 11, 3, 22), at(2026, 11, 4, 1, 30), "bassinet");
  const s2 = sleepRow(at(2026, 11, 5, 21), at(2026, 11, 6, 2), "arms");
  const t2 = tryRow(at(2026, 11, 5, 22), at(2026, 11, 6, 0), "picked_up", { sleep_entry_id: s2.id });
  const s3 = sleepRow(at(2026, 11, 10, 20), at(2026, 11, 10, 21), "bassinet");
  const p = goalProgress(g, data({ tries: [t2], entries: [s1, s2, s3] }), at(2026, 11, 11, 10), NY);
  const tp = p.targets[0];
  ok(tp.kind === "bassinet_stretch", "kind");
  if (tp.kind !== "bassinet_stretch") return;
  eq(tp.weeks, [{ week: 1, stretches: 2, longestSec: 3.5 * 3600, atLeast: 1 }, { week: 2, stretches: 1, longestSec: 3600, atLeast: 0 }], "weeks");
  eq(tp.longest?.sec, 3.5 * 3600, "longest");
  const line = goalProgressLines(g, p, words(SHE, at(2026, 11, 11, 10))).join(" ");
  ok(/This week: longest 1h 00m; 0 of 1 stretch were 3 hours or more\. Last week: longest 3h 30m; 1 of 2 stretches was 3 hours or more\./.test(line), line);
});

check("protected window: counted from that adult's own check-ins, against the nights on the roster; a reader who can't see check-ins gets none", () => {
  const g = goalRow({
    roster: [{ id: "w2", member: SAM, from: "22:00", to: "02:00", nights: [0, 1, 2, 3, 4] }],
    targets: [{ id: "a1", kind: "protected_window", member: SAM, per_week: 4 }],
  });
  const checkins = [
    checkinRow(SAM, "2026-11-02", "yes"),
    checkinRow(SAM, "2026-11-03", "partly"),
    checkinRow(SAM, "2026-11-04", "no"),
    checkinRow(SAM, "2026-11-05", "yes", { deleted_at: iso(at(2026, 11, 6, 8)) }),
    checkinRow(SAM, "2026-11-08", "yes"),
    checkinRow(ALEX, "2026-11-02", "yes"),
  ];
  const now = at(2026, 11, 9, 10);
  const p = goalProgress(g, data({ checkins }), now, NY);
  const tp = p.targets[0];
  // Mon to Sun: the Sun–Thu window is on 5 of the 7 nights.
  eq(tp.kind === "protected_window" && tp.weeks, [{ week: 1, yes: 2, partly: 1, no: 1, checkedIn: 4, planned: 5 }], "Sam's week");
  eq(p.checkins, [
    { member: SAM, nights: 4, yes: 2, partly: 1, no: 1, lastNight: "yes" },
    { member: ALEX, nights: 1, yes: 1, partly: 0, no: 0, lastNight: null },
  ], "per adult");
  const hidden = goalProgress(g, data({ checkins: null }), now, NY);
  eq([hidden.targets[0].kind === "protected_window" && hidden.targets[0].weeks, hidden.checkins], [null, null], "nothing for a view-only reader");
  const shown = goalProgressLines(g, p, words(SHE, now)).join(" ");
  ok(/This week: held on 2 of 4 nights checked in \(partly 1, not this time 1\); 5 nights on the roster so far\./.test(shown) && /Check-ins since Mon, Nov 2: Sam 4 nights/.test(shown), shown);
  const viewer = goalProgressLines(g, hidden, words(SHE, now)).join(" ");
  ok(!/Check-ins|checked in|partly|not this time/.test(viewer) && /counted from the adults' own check-ins/.test(viewer), viewer);
});

check("roster hints: a window across midnight reads the feeds, holding turns and tries inside it, as hints", () => {
  const g = goalRow({
    roster: [
      { id: "w1", member: SAM, from: "22:00", to: "02:00", nights: EVERY },
      { id: "w2", member: ALEX, from: "04:00", to: "07:00", nights: EVERY },
    ],
  });
  const entries = [
    feedRow(at(2026, 11, 2, 21, 59)),
    feedRow(at(2026, 11, 2, 23, 30), SAM),
    feedRow(at(2026, 11, 3, 1, 59), ALEX),
    feedRow(at(2026, 11, 3, 2, 0), ALEX),
    feedRow(at(2026, 11, 3, 5, 0), ALEX),
    feedRow(at(2026, 11, 3, 23, 0), SAM),
  ];
  const shifts = [shiftRow(ALEX, at(2026, 11, 2, 22, 30), at(2026, 11, 2, 23, 30)), shiftRow(SAM, at(2026, 11, 3, 22), at(2026, 11, 3, 22, 20)), shiftRow(SAM, at(2026, 11, 3, 5, 30), at(2026, 11, 3, 6))];
  const tries = [tryRow(at(2026, 11, 3, 0, 15), at(2026, 11, 3, 1), "stayed_asleep")];
  // Tonight's windows haven't happened yet, so the hints read the two nights before.
  const now = at(2026, 11, 4, 12, 30);
  const p = goalProgress(g, data({ entries, shifts, tries }), now, NY);
  eq(p.roster, [
    { windowId: "w1", member: SAM, nights: 2, feeds: 3, feedNights: 2, feedsLoggedBy: 2, heldNights: 1, cover: [{ member: ALEX, nights: 1 }], tries: 1 },
    { windowId: "w2", member: ALEX, nights: 2, feeds: 1, feedNights: 1, feedsLoggedBy: 1, heldNights: 0, cover: [{ member: SAM, nights: 1 }], tries: 0 },
  ], "hints");
  const text = goalProgressLines(g, p, words(SHE, now)).join("\n");
  ok(/Hint from the log, Sam's window 10:00 PM–2:00 AM \(the last 2 nights it was on\): feeds began inside it on 2 nights \(3 feeds, 2 logged by Sam\); Sam held June during it on 1 night; Alex held June during it on 1 night; 1 bassinet try began inside it\./.test(plain(text) as string), text);
  eq(goalProgress(g, data({ entries, shifts, tries }), at(2026, 11, 2, 23), NY).roster.map((h) => h.nights), [0, 0], "nothing before a window is over");
});

check("check-ins: last night by the family's calendar; a night still going, or too long ago, is refused", () => {
  const morning = at(2026, 11, 10, 8);
  eq([cleanCheckinNight(undefined, morning, NY), cleanCheckinNight("2026-11-03", morning, NY), cleanCheckinNight("2026-10-27", morning, NY)], ["2026-11-09", "2026-11-03", "2026-10-27"], "the last 14 nights");
  eq(checkinNights(morning, NY), { first: "2026-10-27", last: "2026-11-09" }, "the range");
  throwsInput(() => cleanCheckinNight("2026-11-10", morning, NY), /isn't over yet/, "tonight");
  throwsInput(() => cleanCheckinNight("2026-10-26", morning, NY), /too long ago/, "15 nights back");
  throwsInput(() => cleanCheckinNight("2026-02-30", morning, NY), /a date like/, "not a day");
  eq([lastNightKey(at(2026, 11, 10, 23), NY), lastNightKey(at(2026, 11, 11, 7), NY)], ["2026-11-09", "2026-11-10"], "evening and the next morning");
  const line = lastNightLine([SAM, ALEX], [checkinRow(SAM, "2026-11-09", "partly"), checkinRow(ALEX, "2026-11-08", "yes")], morning, NY, nameOf);
  eq(line, "Sam partly; not yet: Alex", "last night's");
});

check("coach notes: days left, a review once 7 days pass, the next undone step by its week, and who hasn't checked in", () => {
  const steps = [
    { id: "s1", title: "Alex takes the first night feed", week_of: "2026-11-09", done_at: null, done_by: null },
    { id: "s2", title: "Practice the transfer", week_of: "2026-11-02", done_at: iso(at(2026, 11, 3, 9)), done_by: SAM },
    { id: "s3", title: "White noise in the room", week_of: null, done_at: null, done_by: null },
    { id: "s4", title: "Bassinet after the 10 PM feed", week_of: "2026-11-02", done_at: null, done_by: null },
  ];
  const roster = [{ id: "w5", member: SAM, from: "22:00", to: "02:00", nights: EVERY }, { id: "w6", member: ALEX, from: "02:00", to: "06:00", nights: EVERY }];
  const g = goalRow({ target_date: "2026-11-30", steps, roster });
  eq(nextStep(steps)?.id, "s4", "this week's undone step first");
  const at6 = at(2026, 11, 8, 21);
  const c6 = coachNotes(g, goalProgress(g, data({ checkins: [checkinRow(SAM, "2026-11-07", "yes")] }), at6, NY), words(SHE, at6));
  eq([c6.reviewDue, c6.daysSinceReview, c6.daysLeft, c6.nextStep?.id, c6.notCheckedIn], [false, 6, 22, "s4", [ALEX]], "six days in");
  ok(c6.notes.includes("22 days to the target date (Mon, Nov 30).") && c6.notes.includes("Not checked in for last night yet: Alex.") && c6.notes.some((n) => /^Next step: "Bassinet after the 10 PM feed" \(week of Mon, Nov 2\)\.$/.test(n)), JSON.stringify(c6.notes));
  const at7 = at(2026, 11, 9, 21);
  eq(coachNotes(g, goalProgress(g, data(), at7, NY), words(SHE, at7)).reviewDue, true, "seven days: due");
  eq(coachNotes({ ...g, last_review_at: iso(at(2026, 11, 8, 20)) }, goalProgress(g, data(), at7, NY), words(SHE, at7)).reviewDue, false, "reviewed yesterday");
  const paused = coachNotes({ ...g, status: "paused" }, goalProgress({ ...g, status: "paused" }, data(), at7, NY), words(SHE, at7));
  ok(!paused.reviewDue && /^Paused/.test(paused.notes[0]), JSON.stringify(paused.notes));
  const viewer = coachNotes(g, goalProgress(g, data({ checkins: null }), at6, NY), words(SHE, at6));
  ok(viewer.notCheckedIn === null && !viewer.notes.some((n) => /checked in/.test(n)), "a view-only reader hears nothing about check-ins");
  const late = at(2026, 12, 2, 21);
  ok(coachNotes(g, goalProgress(g, data(), late, NY), words(SHE, late)).notes.some((n) => /^The target date \(Mon, Nov 30\) was 2 days ago: ask whether to close it as met, set a new date, or keep going\.$/.test(n)), "past its date");
});

check("goal input: titles, dates, targets, steps and windows are checked, in words a person can act on", () => {
  const base: GoalInput = { title: "Both of us get a 4-hour stretch" };
  throwsInput(() => cleanGoalInput({}, RULES, "create"), /title is needed/, "no title");
  throwsInput(() => cleanGoalInput({ title: "x".repeat(121) }, RULES, "create"), /too long \(120/, "a long title");
  throwsInput(() => cleanGoalInput({ ...base, why: "x".repeat(301) }, RULES, "create"), /too long \(300/, "a long why");
  throwsInput(() => cleanGoalInput({ ...base, target_date: "2026-11-01" }, RULES, "create"), /already passed/, "a past date");
  throwsInput(() => cleanGoalInput({ ...base, target_date: "2027-11-05" }, RULES, "create"), /up to a year/, "too far");
  throwsInput(() => cleanGoalInput({ ...base, target_date: "2026-02-30" }, RULES, "create"), /a date like/, "not a day");
  eq(cleanGoalInput({ ...base, target_date: "2026-11-30" }, RULES, "create").fields.target_date, "2026-11-30", "a date ahead");
  eq(cleanGoalInput({ target_date: "2026-10-30" }, { ...RULES, current: { ...goalRow(), target_date: "2026-10-30" } }, "update").fields.target_date, "2026-10-30", "the date it has stays once passed");
  const seven = Array.from({ length: 7 }, () => ({ kind: "custom" as const, text: "made-up" }));
  throwsInput(() => cleanGoalInput({ ...base, targets: seven }, RULES, "create"), /6 targets at most/, "seven targets");
  throwsInput(() => cleanGoalInput({ ...base, targets: [{ kind: "bassinet_nights", per_week: 8 }] }, RULES, "create"), /from 1 to 7/, "8 nights a week");
  throwsInput(() => cleanGoalInput({ ...base, targets: [{ kind: "nap_score" as never }] }, RULES, "create"), /needs a kind/, "an unknown kind");
  throwsInput(() => cleanGoalInput({ ...base, targets: [{ kind: "protected_window", member: CASEY, per_week: 3 }] }, RULES, "create"), /isn't an owner or member/, "a view-only guest's window");
  throwsInput(() => cleanGoalInput({ ...base, targets: [{ kind: "bassinet_stretch", minutes: 10 }] }, RULES, "create"), /from 15 to 720/, "a 10-minute stretch");
  eq(cleanGoalInput({ ...base, targets: [{ kind: "bassinet_nights", per_week: 4 }] }, RULES, "create").fields.targets, [{ id: "a1", kind: "bassinet_nights", per_week: 4, min_minutes: 60 }], "an hour unless they say");
  throwsInput(() => cleanGoalInput({ ...base, steps: Array.from({ length: 13 }, (_, i) => ({ title: `Step ${i}` })) }, RULES, "create"), /12 steps at most/, "13 steps");
  throwsInput(() => cleanGoalInput({ ...base, steps: [{ title: "x", week_of: "2026-13-01" }] }, RULES, "create"), /a date like/, "a bad week");
  const win = (over: Partial<{ member: string; from: string; to: string; nights: number[] }> = {}) => ({ member: SAM, from: "22:00", to: "02:00", nights: EVERY, ...over });
  throwsInput(() => cleanGoalInput({ ...base, roster: [win({ from: "9:00" })] }, RULES, "create"), /local times like 22:00/, "a time without its zero");
  throwsInput(() => cleanGoalInput({ ...base, roster: [win({ to: "22:20" })] }, RULES, "create"), /30 minutes to 12 hours/, "20 minutes");
  throwsInput(() => cleanGoalInput({ ...base, roster: [win({ from: "18:00", to: "07:00" })] }, RULES, "create"), /30 minutes to 12 hours/, "13 hours");
  throwsInput(() => cleanGoalInput({ ...base, roster: [win({ nights: [7] })] }, RULES, "create"), /0 \(Sunday\) to 6/, "no eighth evening");
  throwsInput(() => cleanGoalInput({ ...base, roster: [win({ nights: [] })] }, RULES, "create"), /0 \(Sunday\) to 6/, "no evenings");
  throwsInput(() => cleanGoalInput({ ...base, roster: Array.from({ length: 7 }, (_, i) => win({ nights: [i % 7], from: "12:00", to: "13:00" })) }, RULES, "create"), /6 windows at most/, "seven windows");
  throwsInput(() => cleanGoalInput({ ...base, roster: [win(), win({ from: "01:00", to: "03:00", nights: [1] })] }, RULES, "create"), /overlap for Sam/, "Sam twice at 1 AM on Monday nights");
  ok(cleanGoalInput({ ...base, roster: [win(), win({ member: ALEX, from: "01:00", to: "05:00" })] }, RULES, "create").fields.roster?.length === 2, "two adults may overlap");
  ok(cleanGoalInput({ ...base, roster: [win({ nights: [1] }), win({ from: "01:00", to: "03:00", nights: [2] })] }, RULES, "create").fields.roster?.length === 2, "the same adult on different nights");
  throwsInput(() => cleanGoalInput({ ...base, status: "paused" }, RULES, "create"), /starts active/, "a new goal paused");
  throwsInput(() => cleanGoalInput({ status: "met" as never }, { ...RULES, current: goalRow() }, "update"), /its own step/, "closing through update");
});

check("goal input: items keep their ids (a step keeps whether it's done), new ones get new ids, and none is reused", () => {
  const made = cleanGoalInput(
    { title: "Made-up goal", targets: [{ kind: "bassinet_nights", per_week: 4, min_minutes: 45 }, { kind: "custom", text: "Calm bedtimes" }], steps: [{ title: "First" }, { title: "Second", week_of: "2026-11-09" }], roster: [{ member: ALEX, from: "02:00", to: "06:00", nights: EVERY }] },
    RULES,
    "create"
  );
  eq([made.fields.targets?.map((t) => t.id), made.fields.steps?.map((s) => s.id), made.fields.roster?.map((w) => w.id), made.seq], [["a1", "a2"], ["s3", "s4"], ["w5"], 5], "ids across the lists");
  const current = goalRow({ targets: made.fields.targets!, roster: made.fields.roster!, steps: made.fields.steps!.map((s) => (s.id === "s4" ? { ...s, done_at: iso(at(2026, 11, 9, 9)), done_by: ALEX } : s)) });
  const next = cleanGoalInput({ steps: [{ id: "s4", title: "Second, reworded" }, { title: "Third" }] }, { ...RULES, current, seq: made.seq }, "update");
  eq(next.fields.steps?.map((s) => [s.id, s.title, !!s.done_at, s.done_by]), [["s4", "Second, reworded", true, ALEX], ["s6", "Third", false, null]], "kept and new");
  eq(next.seq, 6, "the counter moves on");
  // s3 was dropped: a new step never takes its id.
  ok(!next.fields.steps?.some((s) => s.id === "s3"), "s3 isn't reused");
  throwsInput(() => cleanGoalInput({ steps: [{ id: "s99", title: "x" }] }, { ...RULES, current, seq: 6 }, "update"), /no step s99/, "an id the goal doesn't have");
  throwsInput(() => cleanGoalInput({ steps: [{ id: "s4", title: "x" }, { id: "s4", title: "y" }] }, { ...RULES, current, seq: 6 }, "update"), /in the list twice/, "the same id twice");
});

check("goal words: neutral in every line and voice, names from the family, and the coach's guardrails", () => {
  const g = goalRow({
    target_date: "2026-11-30",
    why: "Back to work in four weeks",
    targets: [
      { id: "a1", kind: "bassinet_nights", per_week: 4, min_minutes: 60 },
      { id: "a2", kind: "bassinet_stretch", minutes: 180 },
      { id: "a3", kind: "protected_window", member: SAM, per_week: 5 },
      { id: "a4", kind: "custom", text: "Calm bedtimes" },
    ],
    steps: [{ id: "s5", title: "Bassinet after the 10 PM feed", week_of: "2026-11-02", done_at: null, done_by: null }],
    roster: [{ id: "w6", member: SAM, from: "22:00", to: "02:00", nights: EVERY }],
  });
  const now = at(2026, 11, 10, 21);
  const rows = [
    tryRow(at(2026, 11, 3, 22), at(2026, 11, 3, 22, 4), "woke_crying"),
    tryRow(at(2026, 11, 4, 22), at(2026, 11, 4, 22, 10), "woke_crying"),
    tryRow(at(2026, 11, 9, 22), at(2026, 11, 9, 22, 30), "picked_up"),
  ];
  const BAD = /\b(fail|failed|failing|failure|streaks?|grades?|scores?|best|worst|success(ful)?|perfect|missed|behind|bad|poor)\b/i;
  for (const v of VOICES) {
    for (const checkins of [[checkinRow(SAM, "2026-11-09", "no")], null]) {
      const p = goalProgress(g, data({ tries: rows, checkins, entries: [feedRow(at(2026, 11, 9, 23))], shifts: [shiftRow(ALEX, at(2026, 11, 9, 23), at(2026, 11, 9, 23, 30))] }), now, NY);
      const text = [goalHeadLine(g, p, { tz: NY }), ...goalProgressLines(g, p, words(v, now)), ...coachNotes(g, p, words(v, now)).notes];
      for (const line of text) ok(!BAD.test(line), `a judging word: "${line}"`);
      if (v === THEY) for (const line of text) ok(!/\b(she|her|hers|herself|he|him|his|himself)\b/i.test(line), `they voice: "${line}"`);
    }
  }
  const rules = coachGuardrails(SHE).join(" ");
  for (const re of [/one question at a time/, /ask_user/, /only after they say yes/, /memories/, /No medical advice/, /pediatrician or lactation consultant/, /Never crying it out/, /never June sleeping on an adult, or in a bed, couch or armchair with one/, /no blame/]) ok(re.test(rules), `guardrails: ${re}`);
  ok(!/\b(sleep train|cry it out|co-?sleep|bed[- ]?shar)/i.test(rules.replace(/Never crying it out/, "")), "nothing that suggests them");
  ok(coachGuardrails(THEY).every((l) => !/\b(she|her|he|him|his)\b/i.test(l)), "they voice");
});

check("goal words: the evenings a window is on, and who reads check-ins", () => {
  eq([nightsLabel(EVERY), nightsLabel([0, 1, 2, 3, 4]), nightsLabel([5, 6, 0]), nightsLabel([1, 3, 5]), nightsLabel([6]), nightsLabel([2, 4])], ["every night", "Sun–Thu nights", "Fri–Sun nights", "Mon, Wed and Fri nights", "Sat nights", "Tue and Thu nights"], "labels");
  eq([weekdayOf("2026-11-01"), weekdayOf("2026-11-07"), windowOnNight({ nights: [0] }, "2026-11-01"), windowOnNight({ nights: [1] }, "2026-11-01")], [0, 6, true, false], "weekdays");
  eq([windowMinutes("22:00", "02:00"), windowMinutes("02:00", "22:00"), windowMinutes("22:00", "22:00")], [240, 1200, 0], "lengths on the clock");
  eq((["owner", "member", "viewer", "photos"] as const).map(seesCheckins), [true, true, false, false], "owners and members only");
});

console.log(`\nmaple-sleep-check: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
