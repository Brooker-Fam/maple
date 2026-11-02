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
import type { BassinetTry, SleepPlan, TryOutcome, TryTag } from "../src/lib/maple/sleep/types";
import { isTrySlot, sleepyChoices, slotLabel, STAGE_INFO } from "../src/lib/maple/sleep/words";
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

check("content: never crying it out, never sleep on or beside an adult as safe, no doses, no diagnosis", () => {
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

console.log(`\nmaple-sleep-check: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
