/**
 * pnpm check:maple-sleep (first half): the sleep plan's engine and its
 * guidance, as pure functions on made-up records. No database, no network.
 * The second half (scripts/tenancy/sleep.check.ts) runs the store, the
 * route and the MCP tools on an in-memory Postgres.
 */
import { readFileSync } from "node:fs";
import { emergencySigns } from "../src/lib/maple/guidelines";
import { feedingSleepyWords, nightFeedLine, SLEEP_GUIDES, SLEEP_SECTIONS, pendingReview, sleepsNowNote, sleepyBassinetLine, sleepyLine, transferSteps, type SleepSection } from "../src/lib/maple/guidelines/sleep";
import { WORK_BOTTLES, WORK_DROWSY_DRIVING, WORK_GUIDES, WORK_NIGHT_NURSING, workGuide } from "../src/lib/maple/guidelines/sleep";
import {
  AGE_BANDS,
  askState,
  chooseSleepLink,
  EARLY_MIN_TRIES,
  endsSleep,
  followSleep,
  nextHandoff,
  numberTries,
  fromCheckinWords,
  planToday,
  planTodayLine,
  planTodayWords,
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
  tryDayNowLabel,
  tryWhenLabel,
} from "../src/lib/maple/sleep/engine";
import { SleepInputError } from "../src/lib/maple/sleep/errors";
import { handoffAroundRoster, handoffWhyWords, windowAt } from "../src/lib/maple/sleep/handoff";
import { feedCover, windowsBetween } from "../src/lib/maple/sleep/roster";
import {
  BOTTLE_SOURCE,
  citeWork,
  checkinTryOn,
  emptyNight,
  ENOUGH_NIGHTS,
  goalStartKey,
  HOW_ARE_YOU_NIGHTS,
  lookBack,
  lookBackStep,
  owedCheckins,
  QUIET_NIGHTS,
  quietNow,
  quietWords,
  readWeek,
  reviewIsDue,
  reviewWeek,
  tonightKey,
  weekEnough,
} from "../src/lib/maple/sleep/goals";
import { EASE_OFF_MAX_DAYS } from "../src/lib/maple/sleep/types";
import { ENOUGH_NIGHTS_LINE, nightsRange, tooFewWords } from "../src/lib/maple/sleep/words";
import {
  backToWorkGoal,
  backToWorkQuestions,
  checkinNights,
  cleanCheckinExtras,
  cleanCheckinNight,
  cleanGoalInput,
  coachGuardrails,
  coachNotes,
  goalCautions,
  goalHeadLine,
  goalProgress,
  goalProgressLines,
  goalSpan,
  goalsByUrgency,
  goalWeekLabel,
  lastNightKey,
  lastNightLine,
  loggedSpans,
  nextStep,
  nextStepNow,
  nightAnswers,
  nightLog,
  nightPicture,
  noCheckinWords,
  observationWords,
  plannedHandoff,
  refuseUnsafe,
  rosterHintBody,
  rosterWords,
  seesCheckins,
  sleepExemptions,
  stepsByWeek,
  turnLeftOpen,
  unsafeSleep,
  unsafeWords,
  weekEndedLastNight,
  windowMinutes,
  windowOn,
  windowOnNight,
  type BackToWorkAnswers,
  type GoalData,
  type GoalRules,
} from "../src/lib/maple/sleep/goals";
import type { BassinetTry, GoalInput, HoldingShift, RosterWindow, SleepCheckin, SleepGoal, SleepPlan, TryOutcome, TryTag } from "../src/lib/maple/sleep/types";
import { CHECKIN_QUESTION, checkinQuestion, cryingLine, downWords, isTrySlot, nightsLabel, shortClock, sleepyChoices, slotLabel, slotShort, STAGE_INFO, targetWords, weekdayOf } from "../src/lib/maple/sleep/words";
import { addDays as addDaysOf, zonedTimeToUtc } from "../src/lib/maple/time";
import { dateWords as dateWordsOf } from "../src/lib/maple/sleep/words";
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

check("asks: Wake [partner] is an ask with its time; ten minutes on with nobody taking over, it's stale; an ended turn has none open", () => {
  const start = at(2026, 10, 28, 1);
  const asked = at(2026, 10, 28, 2, 10);
  const s = { started_at: iso(start), ended_at: null, asked_to: "alex@example.com", asked_at: iso(asked) };
  eq(askState({ ...s, asked_to: null, asked_at: null }, asked).asked, false, "nobody asked");
  eq(askState(s, new Date(asked.getTime() + 9 * MIN)), { asked: true, to: "alex@example.com", at: iso(asked), minutes: 9, stale: false }, "nine minutes: still waking them");
  eq(askState(s, new Date(asked.getTime() + 10 * MIN)).stale, true, "ten minutes: the two safe choices again");
  eq(askState({ ...s, ended_at: iso(asked.getTime() + 5 * MIN) }, new Date(asked.getTime() + 20 * MIN)).asked, false, "taken over: no ask open");
  const older: Parameters<typeof askState>[0] = { ended_at: null };
  eq(askState(older, asked).asked, false, "a turn from a server older than asks");
});

check("try day in a phone's words: tonight through the night, since last night in the morning, this morning for a morning try", () => {
  const night = at(2026, 11, 4, 23);
  const twoAm = at(2026, 11, 5, 2, 10);
  const morning = at(2026, 11, 5, 7, 30);
  eq(tryDayNowLabel(twoAm, NY), "tonight", "2 AM is still tonight");
  eq(tryDayNowLabel(morning, NY), "since last night", "7:30 AM");
  eq(tryDayNowLabel(at(2026, 11, 5, 15), NY), "tonight", "the afternoon starts a new try day");
  eq(tryWhenLabel(iso(night), twoAm, NY), "tonight", "an 11 PM try at 2 AM");
  eq(tryWhenLabel(iso(night), morning, NY), "last night", "an 11 PM try at 7:30 AM");
  eq(tryWhenLabel(iso(at(2026, 11, 5, 7)), morning, NY), "this morning", "a 7 AM try at 7:30 AM");
  eq(tryWhenLabel(iso(at(2026, 11, 3, 23)), morning, NY), "Tue night", "the night before last, by its evening");
  eq(tryWhenLabel(iso(at(2026, 11, 3, 23)), at(2026, 11, 4, 21), NY), "last night", "in the evening, yesterday's is last night");
});

check("night words: durations as a phone says them, the crying lines, and short try times", () => {
  eq([downWords(47), downWords(60), downWords(192)], ["47 min", "1h 00m", "3h 12m"], "never 192 min");
  for (const v of VOICES) {
    const soothe = cryingLine(v, "after_crying");
    ok(/^Soothe /.test(soothe) && /try once more when .+ deeply asleep$/.test(soothe), soothe);
    ok(!/cry[- ]it[- ]out|leave/i.test(soothe), soothe);
  }
  eq(cryingLine(SHE, "after_crying"), "Soothe her; try once more when she's deeply asleep", "her");
  eq(cryingLine(THEY, "after_crying"), "Soothe them; try once more when they're deeply asleep", "them");
  eq(cryingLine(SHE, "retry_done"), "Pause until the next try", "after the retry");
  eq([slotShort("first_morning_nap"), slotShort("first_night_stretch"), plain(slotShort("22:30"))], ["morning nap", "first night stretch", "around 10:30 PM"], "short try times");
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

const ALLOWED_HOSTS = new Set(["www.healthychildren.org", "pubmed.ncbi.nlm.nih.gov", "publications.aap.org", "www.aap.org", "988lifeline.org", "www.nichd.nih.gov"]);

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
    ["sleep with an adult as an option", /\b(safe|okay|ok|fine) to (sleep|nap|doze)\b|contact (nap|sleep)|co-?sleep|(?<!recommends against )bed[- ]?shar|sleep (on|with) (you|your|an adult|a parent)/i],
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
  eq(pendingReview().length, SLEEP_GUIDES.length + WORK_GUIDES.length, "pending");
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
/** A feed at 11 PM on each of these nights: something logged (partly), so a week has nights enough to read (ENOUGH_NIGHTS). */
const lateFeeds = (...nights: string[]) =>
  nights.map((k) => {
    const [y, m, d] = k.split("-").map(Number);
    return feedRow(at(y, m, d, 23));
  });
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
  // Set Mon, Nov 2 for Mon, Nov 30: 29 nights read as 4 weeks, the target date's night closing the 4th.
  eq([s.startsOn, s.endsOn, s.daysLeft, s.weekNow, s.weeksTotal, s.weeksHidden], ["2026-11-02", "2026-11-30", 20, 2, 4, 0], "span");
  eq(s.weeks, [
    { n: 1, from: "2026-11-02", to: "2026-11-08", nights: 7, current: false },
    { n: 2, from: "2026-11-09", to: "2026-11-15", nights: 2, current: true },
  ], "weeks");
  const just = goalSpan(g, at(2026, 11, 2, 9, 30), NY);
  eq([just.weekNow, just.weeks], [1, [{ n: 1, from: "2026-11-02", to: "2026-11-08", nights: 0, current: true }]], "set this morning: week 1, its first night still ahead");
  const lastDay = goalSpan(g, at(2026, 12, 1, 10), NY);
  eq([lastDay.weekNow, lastDay.weeks.at(-1)], [4, { n: 4, from: "2026-11-23", to: "2026-11-30", nights: 8, current: true }], "the target date's night closes the last week, never a week of one night");
  const after = goalSpan(g, at(2026, 12, 2, 21), NY);
  eq([after.weekNow, after.daysLeft, after.weeks.length, after.lastNight], [null, -2, 4, "2026-11-30"], "past the target date: nothing after it counts");
  ok(/Target date Mon, Nov 30 \(20 days left\); week 2 of 4\./.test(goalHeadLine(g, s, { tz: NY })), goalHeadLine(g, s, { tz: NY }));
  // Any other target date keeps its short last week: 31 nights are 5 weeks, the 5th of 3 nights.
  const odd = goalSpan(goalRow({ target_date: "2026-12-02" }), at(2026, 12, 2, 21), NY);
  eq([odd.weeksTotal, odd.weekNow, odd.weeks.at(-1)], [5, 5, { n: 5, from: "2026-11-30", to: "2026-12-02", nights: 3, current: true }], "31 nights");
  eq(goalSpan(goalRow({ target_date: "2026-11-09" }), at(2026, 11, 9, 21), NY).weeksTotal, 1, "in 1 week: one week of 8 nights");
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
  eq(tp.kind === "bassinet_nights" && tp.weeks[0], { week: 1, counted: 1, tried: 1, checkinTries: 0, nights: 6, fromCheckins: 0, known: 1, unknown: 5, feedsOnly: 0 }, "one night, counted once");
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
  // Known: the 4 nights with a try (the running one's too); nothing at all was logged on the other 3.
  eq(tp.kind === "bassinet_nights" && tp.weeks, [{ week: 1, counted: 2, tried: 3, checkinTries: 0, nights: 7, fromCheckins: 0, known: 4, unknown: 3, feedsOnly: 0 }], "two nights of three tried");
  // Monday morning: the try day is still Sunday night's, the last of week 1, while the calendar (and this week's step) is week 2's.
  const line = goalProgressLines(g, p, words(SHE, at(2026, 11, 9, 10))).join(" ");
  ok(/Aim: 4 nights a week with a bassinet try asleep 1 hour or more\. Week 1 \(ended last night\): 2 of the 4 nights aimed for \(tries logged on 3 of 7 nights\)\./.test(line), line);
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
  // Two nights logged in each week: too few to tell, so no count against the aim.
  const thin = goalProgressLines(g, p, words(SHE, at(2026, 11, 11, 10))).join(" ");
  ok(/This week: 1 night logged so far, too few to tell yet\. Last week: 2 nights logged, too few to tell\./.test(thin), thin);
  // A third logged night each week (a feed): the stretches read against the aim.
  const busy = goalProgress(g, data({ tries: [t2], entries: [s1, s2, s3, ...lateFeeds("2026-11-07", "2026-11-09", "2026-11-11")] }), at(2026, 11, 12, 10), NY);
  const line = goalProgressLines(g, busy, words(SHE, at(2026, 11, 12, 10))).join(" ");
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
  eq(tp.kind === "protected_window" && tp.weeks, [{ week: 1, yes: 2, partly: 1, no: 1, checkedIn: 4, planned: 5, nextNight: null }], "Sam's week");
  eq(p.checkins, [
    { member: SAM, nights: 4, yes: 2, partly: 1, no: 1, lastNight: "yes" },
    { member: ALEX, nights: 1, yes: 1, partly: 0, no: 0, lastNight: null },
  ], "per adult");
  const hidden = goalProgress(g, data({ checkins: null }), now, NY);
  eq([hidden.targets[0].kind === "protected_window" && hidden.targets[0].weeks, hidden.checkins], [null, null], "nothing for a view-only reader");
  const shown = goalProgressLines(g, p, words(SHE, now)).join(" ");
  ok(/Aim: Sam's protected sleep, 4 nights a week\. Week 1 \(ended last night\): yes on 2 of the 4 nights aimed for \(checked in on 4 of 5 roster nights; partly 1, not this time 1\)\./.test(shown) && /Check-ins since Mon, Nov 2: Sam 4 nights/.test(shown), shown);
  ok(!/\bhold(s|ing)?\b|\bheld\b/.test(shown), `never "hold" for a protected window (that's a holding turn's word): ${shown}`);
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
    {
      windowId: "w1", member: SAM, nights: 2, loggedNights: 2, feeds: 3, feedNights: 2, feedsLoggedBy: 2,
      feedsBy: [{ member: SAM, bottles: 0, nursing: 2 }, { member: ALEX, bottles: 0, nursing: 1 }],
      ownFeedNights: 2, ownFeedSpan: { first: iso(at(2026, 11, 3, 23)), last: iso(at(2026, 11, 2, 23, 30)) },
      heldNights: 1, cover: [{ member: ALEX, nights: 1 }], tries: 1, longTurns: [],
    },
    {
      windowId: "w2", member: ALEX, nights: 2, loggedNights: 1, feeds: 1, feedNights: 1, feedsLoggedBy: 1,
      feedsBy: [{ member: ALEX, bottles: 0, nursing: 1 }],
      ownFeedNights: 1, ownFeedSpan: { first: iso(at(2026, 11, 3, 5)), last: iso(at(2026, 11, 3, 5)) },
      heldNights: 0, cover: [{ member: SAM, nights: 1 }], tries: 0, longTurns: [],
    },
  ], "hints");
  const text = goalProgressLines(g, p, words(SHE, now)).join("\n");
  ok(/Hint from the log, Sam's window 10:00 PM–2:00 AM \(the last 2 nights it was on\): feeds began inside it on 2 of 2 nights \(3 feeds: 2 nursing logged by Sam, 1 nursing logged by Alex\); Sam held June during it on 1 night; Alex held June during it on 1 night; 1 bassinet try began inside it\./.test(plain(text) as string), text);
  ok(/Hint from the log, Alex's window 4:00 AM–7:00 AM \(the last 2 nights it was on\): feeds began inside it on 1 of 2 nights \(1 feed: 1 nursing logged by Alex\); nothing logged inside it on 1 of them; Sam held June during it on 1 night\./.test(plain(text) as string), text);
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
  ok(c6.notes.includes("22 days to the target date (Mon, Nov 30).") && c6.notes.includes("Not checked in for last night yet: Alex.") && c6.notes.includes(`This week's step: "Bassinet after the 10 PM feed" (s4).`), JSON.stringify(c6.notes));
  // Nothing was logged on five of those six nights (one has Sam's check-in): how they are comes first, and those nights are never asked about.
  eq(c6.notes[0], "Nothing logged on 5 of the last 6 nights: before anything about the goal, ask how they're doing. Leave those nights out of the counts, and don't ask about them.", "how they are, first");
  ok(!c6.notes.some((n) => /ask about it|before counting/.test(n)), JSON.stringify(c6.notes));
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
  for (const re of [/one question at a time/, /ask_user/, /only after they say yes/, /memories/, /No medical advice/, /pediatrician or lactation consultant/, /Never crying it out/, /or June asleep on an adult, in an adult bed, on a couch, armchair or recliner, or in a swing, car seat or other sitting device, as a plan/, /Never crying it out, medicine or supplements for sleep/, /no blame/]) ok(re.test(rules), `guardrails: ${re}`);
  ok(!/\b(sleep train|cry it out|co-?sleep|bed[- ]?shar)/i.test(rules.replace(/Never crying it out/, "")), "nothing that suggests them");
  ok(coachGuardrails(THEY).every((l) => !/\b(she|her|he|him|his)\b/i.test(l)), "they voice");
});

check("goal words: the evenings a window is on, and who reads check-ins", () => {
  eq([nightsLabel(EVERY), nightsLabel([0, 1, 2, 3, 4]), nightsLabel([5, 6, 0]), nightsLabel([1, 3, 5]), nightsLabel([6]), nightsLabel([2, 4])], ["every night", "Sun–Thu nights", "Fri–Sun nights", "Mon, Wed and Fri nights", "Sat nights", "Tue and Thu nights"], "labels");
  eq([weekdayOf("2026-11-01"), weekdayOf("2026-11-07"), windowOnNight({ nights: [0] }, "2026-11-01"), windowOnNight({ nights: [1] }, "2026-11-01")], [0, 6, true, false], "weekdays");
  eq([windowMinutes("22:00", "02:00"), windowMinutes("02:00", "22:00"), windowMinutes("22:00", "22:00")], [240, 1200, 0], "lengths on the clock");
  eq((["owner", "member", "viewer", "photos"] as const).map(seesCheckins), [true, true, false, false], "owners and members only");
});

// ── round 1: safer goals, honest counts, a next step, the morning ────────

const WREN = makeVoice({ name: "Wren", pronoun: "she" });
const FAMILY_ADULTS = ["Noor", "Theo"];
/** Phrases a plan never holds: crying it out, and the baby asleep on or with an adult, or in a bed, couch, recliner, armchair or swing. */
const REFUSED = [
  "Let her cry it out for 10 minutes before picking her up",
  "Theo naps on the couch with her on his chest after the 6 AM feed",
  "Wren sleeps in our bed between feeds",
  "Try the Ferber method from week 3",
  "CIO for the first nap",
  "Controlled crying at bedtime",
  "Graduated extinction",
  "Let him fuss for five minutes",
  "let them cry a little before going in",
  "Leave her to cry for a minute",
  "Contact naps after the 6 AM feed",
  "She naps in the swing",
  "Co-sleeping for the late feeds",
  "Bed-sharing on Theo's nights",
  "She naps on Theo's chest",
  "Wren sleeps in the recliner with Theo",
  "Let Wren sleep on the sofa with Noor",
  "She sleeps on me after the 2 AM feed",
  "Don't pick her up, let her cry",
  "Swing naps in the afternoon",
  "She sleeps in bed with us",
  "Noor dozes in the armchair with her",
  // A step away from the bassinet, toward the bed: the "from" is the bassinet's.
  "Move her from the bassinet into our bed for the rest of the night",
  "Move Wren from the bassinet into our bed for the rest of the night",
];
/** Phrases that must pass: the four from the review, feeding words, and steps away from unsafe sleep. */
const ALLOWED = [
  "bassinet beside our bed",
  "in our room",
  "if she wakes crying, soothe her",
  "she cries less after feeds",
  "Switch the 2 AM feed to formula",
  "Pump before bed so Theo can give a bottle",
  "Dream feed at 10:30 PM",
  "Wean the 3 AM feed",
  "Supplement with formula after the evening feed",
  "Swing her gently to settle her",
  "Noor sleeps on the couch downstairs on Theo's nights",
  "Noor sleeps in our bed with earplugs while Theo has the baby",
  "Hold her until she's deeply asleep in your arms",
  "Lay her on her back in the bassinet",
  "No cry it out",
  "Never let her cry it out",
  "Rather than letting her cry, soothe her and try again",
  "Move from contact naps to bassinet naps",
  "Fewer contact naps",
  "Stop co-sleeping by December",
  "Out of our bed by December",
  "Tummy time on Dad's chest after breakfast",
  "She sleeps in her bassinet next to our bed",
  "Sleeping in her bassinet in our room",
  "One bassinet try a night, after the first night feed",
  "She sleeps in the bassinet instead of in our bed",
  "Wren naps in the bassinet not in the swing",
];

check("safety: crying it out and the baby asleep on or with an adult, or in a bed, couch, recliner, armchair or swing, are refused", () => {
  for (const text of REFUSED) ok(unsafeSleep(text, { v: WREN, adults: FAMILY_ADULTS }), `refused: "${text}"`);
  // The app's form checks the same rules without the family's voice: the pronouns and "the baby" still catch these.
  for (const text of ["Let her cry it out", "She naps in the swing", "Theo naps on the couch with her on his chest", "Co-sleep after the late feed"]) ok(unsafeSleep(text), `refused without a voice: "${text}"`);
});

check("safety: no false positives: the bassinet beside our bed, in our room, soothing a crying wake, feeding words, and steps away from unsafe sleep pass", () => {
  for (const text of ALLOWED) {
    const found = unsafeSleep(text, { v: WREN, adults: FAMILY_ADULTS });
    ok(!found, `allowed: "${text}" (matched "${found?.phrase}")`);
  }
  // "Why it matters" says how things are now: the reason for the goal, not its plan.
  for (const text of ["She only sleeps on me", "She sleeps in our bed now and we're exhausted", "She only naps on Noor's chest"]) ok(!unsafeSleep(text, { v: WREN, adults: FAMILY_ADULTS, describing: true }), `a why: "${text}"`);
  ok(unsafeSleep("She sleeps in our bed between feeds", { v: WREN, adults: FAMILY_ADULTS, describing: true }), "a why that plans it is still refused");
});

check("safety: every goal text refuses with words by its field (title, why, steps, a custom target) and the plan's goal too", () => {
  const rules: GoalRules = { ...RULES, v: WREN };
  const said = /^Target 1: Maple won't plan Wren sleeping in an adult bed; if this is a step away from it, try "Move her from our bed to the bassinet"\.$/;
  throwsInput(() => cleanGoalInput({ title: "Learn to self-settle", steps: [{ title: "Let her cry it out for 10 minutes before picking her up" }] }, rules, "create"), /^Step 1: Maple won't plan leaving Wren to cry; if this is about settling her, try "Soothe her, then try the bassinet once more"\.$/, "a step");
  throwsInput(() => cleanGoalInput({ title: "Rest for Theo", steps: [{ title: "Bassinet after the 10 PM feed" }, { title: "Theo naps on the couch with her on his chest after the 6 AM feed" }] }, rules, "create"), /^Step 2: /, "the second step");
  throwsInput(() => cleanGoalInput({ title: "Easier nights", targets: [{ kind: "custom", text: "Wren sleeps in our bed between feeds" }] }, rules, "create"), said, "a custom target");
  throwsInput(() => cleanGoalInput({ title: "Easier nights", targets: [{ kind: "custom", text: "Wren sleeps in our bed between feeds" }] }, rules, "create"), /^Target 1: /, "by its field");
  throwsInput(() => cleanGoalInput({ title: "Ferber by week 6" }, rules, "create"), /^The goal's title: /, "the title");
  throwsInput(() => cleanGoalInput({ title: "Sleep", why: "So she can nap on Theo's chest while I sleep" }, rules, "create"), /^Why it matters: /, "the why");
  throwsInput(() => cleanGoalInput({ steps: [{ title: "Contact naps after lunch" }] }, { ...rules, current: goalRow() }, "update"), /^Step 1: /, "an update too");
  throwsInput(() => refuseUnsafe("Co-sleeping safely", "The goal", { v: WREN }), /^The goal: Maple won't plan Wren sleeping in an adult bed/, "the plan's goal");
  throwsInput(() => cleanGoalInput({ title: "Let her cry it out" }, RULES, "create"), /^The goal's title: Maple won't plan leaving the baby to cry; if this is about settling the baby, try "Soothe the baby, then try the bassinet once more"\.$/, "without a voice");
  // Feeding words save: the read-back asks for the clinician's yes instead.
  ok(cleanGoalInput({ title: "More sleep for Noor", steps: [{ title: "Switch the 2 AM feed to formula" }] }, rules, "create").fields.steps?.length === 1, "a feeding step saves");
  ok(cleanGoalInput({ title: "Sleeping in her bassinet in our room", why: "She only sleeps on us right now" }, rules, "create").fields.why, "a why about now");
});

check("cautions: feeds come first under 4 weeks (the app's own line, quoted), a window over 5 hours, and a feeding step asks for their clinician's yes", () => {
  const f = {
    targets: [
      { id: "a1", kind: "bassinet_stretch" as const, minutes: 360 },
      { id: "a2", kind: "bassinet_nights" as const, per_week: 7, min_minutes: 480 },
      { id: "a3", kind: "bassinet_nights" as const, per_week: 3, min_minutes: 90 },
    ],
    roster: [
      { id: "w4", member: SAM, from: "19:30", to: "07:30", nights: EVERY },
      { id: "w5", member: ALEX, from: "02:00", to: "06:00", nights: EVERY },
    ],
    steps: [
      { id: "s6", title: "Switch the 2 AM feed to formula", week_of: null, done_at: null, done_by: null },
      { id: "s7", title: "Ask the lactation consultant whether one pumped bottle fits our plan", week_of: null, done_at: null, done_by: null },
    ],
  };
  const young = goalCautions(f, { v: WREN, name: nameOf, ageDays: 24 });
  eq(young.map((c) => c.kind), ["feeds_first", "long_window", "feeding"], "kinds");
  const guide = SLEEP_GUIDES.find((g) => g.id === "normal-feeds-first")!.body(WREN);
  ok(young[0].text.includes(`"${guide}"`) && young[0].text.includes(`"${targetWords(f.targets[0], nameOf)}" and "${targetWords(f.targets[1], nameOf)}" ask for more than 4 hours in Wren's first 4 weeks`), young[0].text);
  ok(!young[0].text.includes("1h 30m"), "a target under 4 hours isn't named");
  // In her first weeks a window past 4 hours with nothing said about its feeds: the adult on duty brings her to nurse (P2-11's plainer words).
  ok(/^Sam's window, 7:30 PM–7:30 AM, is longer than 4 hours with no feed planned in it: in Wren's first weeks feeds come first, so whoever's on duty can bring her to nurse in it and settle her after \(a bottle for a nursing baby waits for their pediatrician's or lactation consultant's yes\)\.$/.test(plain(young[1].text) as string), young[1].text);
  ok(/^Sam's window, 7:30 PM–7:30 AM, is longer than 5 hours with no feed planned in it: say who covers a feed then \(bringing her to nurse, or a bottle\), and ask their pediatrician or lactation consultant before starting bottles for a nursing baby\.$/.test(plain(goalCautions(f, { v: WREN, name: nameOf, ageDays: 40 })[0].text) as string), "older: who covers it");
  ok(young[2].text.includes(`The step "Switch the 2 AM feed to formula" changes how Wren is fed: save it only if their pediatrician or lactation consultant agreed; otherwise phrase it as "Ask`) && !young[2].text.includes("pumped bottle"), young[2].text);
  eq(goalCautions(f, { v: WREN, name: nameOf, ageDays: 28 }).map((c) => c.kind), ["long_window", "feeding"], "from 4 weeks old, no feeds-first line");
  eq(goalCautions(f, { v: WREN, name: nameOf, ageDays: null }).map((c) => c.kind)[0], "feeds_first", "before she's born, the goal reaches her first weeks");
  eq(goalCautions(f, { v: WREN, name: nameOf }).map((c) => c.kind), ["long_window", "feeding"], "no age known (the form): not said");
  eq(goalCautions({ targets: [{ id: "a1", kind: "bassinet_stretch", minutes: 240 }] }, { v: WREN, name: nameOf, ageDays: 3 }), [], "4 hours exactly is the guidance's own line");
});

check("coverage: each night's core is logged, partly logged or not logged; weeks count them; nothing logged is unknown, never 'no feeds'", () => {
  const g = goalRow({ targets: [{ id: "a1", kind: "bassinet_nights", per_week: 3, min_minutes: 60 }], roster: [{ id: "w2", member: SAM, from: "22:00", to: "02:00", nights: EVERY }] });
  const diaper = (t: Date, id = nextId++): Entry => ({ ...feedRow(t), id, kind: "diaper", ended_at: null, data: { pee: true } }) as Entry;
  // Mon: feeds all through. Tue: one feed at 11 PM, then nothing until 5 AM. Wed: nothing. Thu: a try only (its sleep is in the log).
  const entries = [feedRow(at(2026, 11, 2, 22, 30)), feedRow(at(2026, 11, 3, 1)), diaper(at(2026, 11, 3, 3)), feedRow(at(2026, 11, 3, 4, 30)), feedRow(at(2026, 11, 3, 23)), feedRow(at(2026, 11, 4, 5))];
  const s5 = sleepRow(at(2026, 11, 5, 22), at(2026, 11, 6, 1), "bassinet");
  const t5 = tryRow(at(2026, 11, 5, 22), at(2026, 11, 6, 1), "stayed_asleep", { sleep_entry_id: s5.id });
  const spans = loggedSpans({ entries: [...entries, s5], tries: [t5], shifts: [] }, at(2026, 11, 9, 10).getTime());
  eq(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-09"].map((n) => nightLog(n, spans, NY, at(2026, 11, 9, 10).getTime())?.log ?? null), ["logged", "partly", "none", "partly", null], "per night (tonight not over)");
  const p = goalProgress(g, data({ entries: [...entries, s5], tries: [t5] }), at(2026, 11, 9, 10), NY);
  eq(p.coverage[0], { week: 1, over: 7, logged: 1, partly: 2, none: 4, feedNights: 2, tryNights: 1, checkinNights: 0, read: 3 }, "week 1");
  const tp = p.targets[0];
  // For a bassinet aim only Thu says anything about her sleep (a try); Mon and Tue had only feeds and a diaper.
  eq(tp.kind === "bassinet_nights" && [tp.weeks[0].known, tp.weeks[0].unknown, tp.weeks[0].feedsOnly], [1, 6, 2], "the target's own sample: 1 night known, 6 unknown, 2 of them with only feeds");
  const lines = goalProgressLines(g, p, words(WREN, at(2026, 11, 9, 10))).join("\n");
  ok(/Logged: week 1 \(ended last night\) something on 3 of 7 nights \(2 with a gap of 4 hours or more; feeds on 2, tries on 1, check-ins on 0\)\./.test(lines), lines);
  // One night says anything about her sleep (the try): the sample first, never a count against the aim.
  ok(/Week 1 \(ended last night\): a try, a sleep or a morning answer about her night on 1 of 7 nights, too few to tell\./.test(lines), lines);
  ok(!/\bno feeds\b|didn't happen|did not happen/i.test(lines), `never "no feeds" for a night nobody logged: ${lines}`);
  ok(/feeds began inside it on 2 of 7 nights \(3 feeds: 3 nursing logged by Sam\); nothing logged inside it on 4 of them/.test(plain(lines) as string), lines);
  const coach = coachNotes(g, p, words(WREN, at(2026, 11, 9, 10)));
  ok(coach.notes.includes("Nothing logged on 4 of the last 7 nights: leave those nights out of the counts, and don't ask about them. A night with nothing logged is unknown, not a night that went well or badly."), JSON.stringify(coach.notes));
  // A viewer gets the same log-only coverage, with no check-in count.
  eq(goalProgress(g, data({ entries: [...entries, s5], tries: [t5], checkins: null }), at(2026, 11, 9, 10), NY).coverage[0].checkinNights, null, "no check-ins for a view-only reader");
});

check("untimed tries: a check-in's try counts toward bassinet nights only with no try in the log, shown apart; a view-only reader gets none", () => {
  const g = goalRow({ targets: [{ id: "a1", kind: "bassinet_nights", per_week: 3, min_minutes: 90 }] });
  const timed = tryRow(at(2026, 11, 2, 22), at(2026, 11, 3, 0), "stayed_asleep");
  const checkins = [
    checkinRow(SAM, "2026-11-03", "yes", { untimed_try: "long", untimed_min: 90 }),
    checkinRow(ALEX, "2026-11-04", "partly", { untimed_try: "long", untimed_min: 60 }),
    checkinRow(SAM, "2026-11-05", "yes", { untimed_try: "short", untimed_min: 90 }),
    checkinRow(ALEX, "2026-11-02", "yes", { untimed_try: "long", untimed_min: 120 }),
  ];
  // Feeds on two more nights: three nights logged, enough to read the week (ENOUGH_NIGHTS).
  const p = goalProgress(g, data({ tries: [timed], checkins, entries: lateFeeds("2026-11-03", "2026-11-04") }), at(2026, 11, 9, 10), NY);
  const tp = p.targets[0];
  // Mon timed; Tue from a check-in (90 minutes); Wed's said 60, under the aim's 90; Thu shorter; Mon's check-in can't add to its timed try.
  eq(tp.kind === "bassinet_nights" && [tp.weeks[0].counted, tp.weeks[0].fromCheckins, tp.weeks[0].tried], [2, 1, 1], "2 nights: 1 timed, 1 from check-ins");
  const line = goalProgressLines(g, p, words(WREN, at(2026, 11, 9, 10))).join(" ");
  ok(/Week 1 \(ended last night\): 2 of the 3 nights aimed for \(1 timed, 1 from check-ins; tries logged on 1 of 7 nights\)\./.test(line), line);
  const viewer = goalProgress(g, data({ tries: [timed], checkins: null }), at(2026, 11, 9, 10), NY).targets[0];
  eq(viewer.kind === "bassinet_nights" && [viewer.weeks[0].counted, viewer.weeks[0].fromCheckins], [1, 0], "a viewer counts the log only");
});

check("check-in answers: each once a night (the first given), tallied by week; their inputs are checked", () => {
  const cs = [
    checkinRow(SAM, "2026-11-03", "yes", { place: "bassinet", handoff: "on_time" }),
    checkinRow(ALEX, "2026-11-03", "yes", { place: "held", handoff: "late" }),
    checkinRow(ALEX, "2026-11-04", "no", { place: "mixed" }),
  ];
  eq(nightAnswers(cs, "2026-11-03"), { checkedIn: true, place: "bassinet", untimed: null, handoff: "on_time" }, "Sam answered first");
  const g = goalRow({ roster: [{ id: "w1", member: SAM, from: "22:00", to: "02:00", nights: EVERY }, { id: "w2", member: ALEX, from: "02:00", to: "06:00", nights: EVERY }] });
  const p = goalProgress(g, data({ checkins: cs }), at(2026, 11, 9, 10), NY);
  eq(p.answers?.[0], { week: 1, place: { bassinet: 1, mixed: 1 }, placeNights: 2, handoff: { on_time: 1 }, handoffNights: 1 }, "tallies");
  const lines = goalProgressLines(g, p, words(WREN, at(2026, 11, 9, 10))).join("\n");
  ok(/From the adults' check-ins, week 1 \(ended last night\): where Wren spent most of the night, bassinet 1, some of each 1 \(2 nights answered\); the planned handoff, on time 1 \(1 night answered\)\./.test(lines), lines);
  eq(goalProgress(g, data({ checkins: null }), at(2026, 11, 9, 10), NY).answers, null, "none for a view-only reader");
  eq(cleanCheckinExtras({ place: "bassinet", untimed_try: "long", untimed_min: 90, handoff: null }), { place: "bassinet", untimed_try: "long", handoff: null, untimed_min: 90 }, "checked");
  eq(cleanCheckinExtras(undefined), {}, "none given");
  throwsInput(() => cleanCheckinExtras({ place: "car" }), /Where the baby spent the night must be one of/, "a place it doesn't know");
  throwsInput(() => cleanCheckinExtras({ handoff: "maybe" }), /The handoff must be one of/, "a handoff answer it doesn't know");
  throwsInput(() => cleanCheckinExtras({ untimed_min: 5 }), /from 15 to 720/, "minutes");
  // The roster plans the 2 AM handoff from Sam to Alex; a holding turn's own planned handoff counts too.
  eq(plannedHandoff([g], [], "2026-11-03", NY), { at: iso(at(2026, 11, 4, 2)), from: SAM, to: ALEX }, "from the roster");
  const turn = { ...shiftRow(SAM, at(2026, 11, 3, 21), at(2026, 11, 3, 23)), handoff_at: iso(at(2026, 11, 3, 23)), next_holder: ALEX };
  eq(plannedHandoff([goalRow()], [turn], "2026-11-03", NY), { at: iso(at(2026, 11, 3, 23)), from: SAM, to: ALEX }, "from a holding turn");
  eq(plannedHandoff([goalRow()], [], "2026-11-03", NY), null, "none planned");
});

check("roster hints: feeds by who logged them, bottles and nursing apart; a holding turn over 4 hours is flagged and left out", () => {
  const g = goalRow({ roster: [{ id: "w1", member: SAM, from: "21:30", to: "01:30", nights: EVERY }] });
  const bottle = (t: Date, by: string) => ({ ...feedRow(t, by), data: { method: "bottle", amount_ml: 70 } }) as Entry;
  const entries = [bottle(at(2026, 11, 2, 23, 45), ALEX), bottle(at(2026, 11, 3, 23, 50), ALEX), feedRow(at(2026, 11, 4, 22), SAM)];
  const shifts = [shiftRow(SAM, at(2026, 11, 2, 21, 30), at(2026, 11, 3, 7, 10)), shiftRow(ALEX, at(2026, 11, 3, 22), at(2026, 11, 3, 23))];
  const now = at(2026, 11, 5, 9);
  const p = goalProgress(g, data({ entries, shifts }), now, NY);
  const h = p.roster[0];
  eq([h.feeds, h.feedsBy, h.heldNights, h.cover, h.longTurns.length], [3, [{ member: ALEX, bottles: 2, nursing: 0 }, { member: SAM, bottles: 0, nursing: 1 }], 0, [{ member: ALEX, nights: 1 }], 1], "by who, and the long turn left out");
  const text = plain(goalProgressLines(g, p, words(WREN, now)).join("\n")) as string;
  ok(/\(3 feeds: 2 bottles logged by Alex, 1 nursing logged by Sam\)/.test(text) && /a holding turn over 4 hours \(Sam's, from 9:30 PM to 7:10 AM\) is left out: it may have been left open/.test(text), text);
});

check("focus: a window its own adult keeps logging feeds in gets one step to talk over, with the feeding-question rule", () => {
  const roster = [{ id: "w1", member: SAM, from: "21:30", to: "01:30", nights: EVERY }, { id: "w2", member: ALEX, from: "01:30", to: "06:30", nights: EVERY }];
  const g = goalRow({ roster });
  const entries = [feedRow(at(2026, 11, 2, 23, 50), SAM), feedRow(at(2026, 11, 4, 0, 30), SAM), feedRow(at(2026, 11, 5, 1, 25), SAM), feedRow(at(2026, 11, 5, 23, 55), SAM)];
  const now = at(2026, 11, 7, 9);
  const p = goalProgress(g, data({ entries }), now, NY);
  const c = coachNotes(g, p, words(WREN, now));
  ok(c.focus && /^Focus: Sam logged a feed inside Sam's window \(9:30 PM–1:30 AM\) on 4 of the 4 nights anything was logged inside it, 11:50 PM–1:25 AM\. One step to talk over: start Sam's window after that feed, or have Alex settle Wren then\. Bottles or pumping only as a question for their pediatrician or lactation consultant\.$/.test(plain(c.focus) as string), String(c.focus));
  ok(c.notes.includes(c.focus!), "it's a coach note");
  // Alex's bottles inside Sam's window protect it: no focus.
  const covered = entries.map((e) => ({ ...e, created_by: ALEX, data: { method: "bottle" } }) as Entry);
  eq(coachNotes(g, goalProgress(g, data({ entries: covered }), now, NY), words(WREN, now)).focus, null, "a partner's bottles: no focus");
  eq(coachNotes(g, goalProgress(g, data({ entries: entries.slice(0, 2) }), now, NY), words(WREN, now)).focus, null, "two nights isn't a pattern");
});

check("steps: this week's step by its week (the calendar day), still open from earlier, one for any week, and a habit-free reminder", () => {
  const steps = [
    { id: "s1", title: "One bassinet try a night", week_of: "2026-11-02", done_at: null, done_by: null },
    { id: "s2", title: "Handoff reminders on both phones", week_of: "2026-11-02", done_at: iso(at(2026, 11, 3, 9)), done_by: SAM },
    { id: "s3", title: "Ask the lactation consultant about a pumped bottle", week_of: "2026-11-09", done_at: null, done_by: null },
    { id: "s4", title: "Run the work-week roster 3 nights in a row", week_of: "2026-11-16", done_at: null, done_by: null },
  ];
  const g = goalRow({ target_date: "2026-11-30", steps });
  // Mon, Nov 16, 9:30 AM: the try day is still Sunday night's (week 2), but the calendar day is week 3's first.
  const now = at(2026, 11, 16, 9, 30);
  const span = goalSpan(g, now, NY);
  eq(span.weekNow, 2, "the nights' week");
  const by = stepsByWeek(steps, span);
  eq([by.thisWeek.map((s) => s.id), by.earlier.map((s) => s.id), by.later.map((s) => s.id)], [["s4"], ["s1", "s3"], []], "this week's, then earlier");
  eq(nextStepNow(steps, span)?.id, "s4", "this week's step is next, not the oldest undone");
  eq(nextStep(steps)?.id, "s1", "nextStep keeps its old order for callers that want it");
  // Three nights logged in the week just ended (feeds), so it reads, and it's no quiet stretch.
  const busy = data({ entries: lateFeeds("2026-11-13", "2026-11-14", "2026-11-15") });
  const c = coachNotes(g, goalProgress(g, busy, now, NY), words(WREN, now));
  ok(c.notes.includes(`This week's step: "Run the work-week roster 3 nights in a row" (s4).`), JSON.stringify(c.notes));
  ok(c.notes.includes(`Still open from earlier: "One bassinet try a night" (s1, week of Mon, Nov 2); "Ask the lactation consultant about a pumped bottle" (s3, week of Mon, Nov 9).`), JSON.stringify(c.notes));
  // No step planned for this week: the one still open carries on, never "No step for this week yet" beside it.
  const carried = coachNotes(goalRow({ steps: [steps[0]] }), goalProgress(goalRow({ steps: [steps[0]] }), busy, now, NY), words(WREN, now));
  ok(carried.notes.includes(`This week's step: carry on with "One bassinet try a night" (s1, week of Mon, Nov 2), unless they'd like another.`) && !carried.notes.some((n) => /No step for this week/.test(n)), JSON.stringify(carried.notes));
  const ahead = goalRow({ steps: [{ ...steps[3], week_of: "2026-11-30" }] });
  const none = coachNotes(ahead, goalProgress(ahead, busy, now, NY), words(WREN, now));
  ok(none.notes.some((n) => /^No step for this week yet; next planned: "Run the work-week roster 3 nights in a row" \(s4, week of Mon, Nov 30\)\. End the review with one small step they choose for this week, saved as a step\.$/.test(n)), JSON.stringify(none.notes));
  const lines = goalProgressLines(g, goalProgress(g, busy, now, NY), words(WREN, now)).join("\n");
  ok(lines.includes("Steps: 1 of 4 done; this week: s4; still open from earlier: s1, s3."), lines);
});

check("tonight: the plan's tries read 'tonight' from noon through the night and 'since noon yesterday' in the morning (5 AM, as the phone); the backup says no night try was logged", () => {
  const p = plan();
  const evening = planTodayWords(planToday(p, [], at(2026, 10, 27, 21), NY), at(2026, 10, 27, 21), NY);
  eq([evening.when, evening.count], ["tonight", "0 of 1; next: the first long night stretch after a feed"], "evening");
  eq(planTodayWords(planToday(p, [], at(2026, 10, 28, 2), NY), at(2026, 10, 28, 2), NY).when, "tonight", "2 AM is still tonight");
  const morning = planTodayWords(planToday(p, [], at(2026, 10, 28, 9, 30), NY), at(2026, 10, 28, 9, 30), NY);
  eq([morning.when, morning.count], ["since noon yesterday (last night and this morning)", "0 of 1; next: the first morning nap (the backup, since no night try was logged)"], "9:30 AM");
  ok(!/didn't happen/.test(planTodayLine(planToday(p, [], at(2026, 10, 28, 8), NY))), "planTodayLine too");
});

check("check-in words: never 'hold', the question names the window's own times, and the morning's other questions", () => {
  eq([shortClock("22:00"), shortClock("21:30"), shortClock("00:00"), shortClock("12:00"), shortClock("06:05")], ["10 PM", "9:30 PM", "midnight", "noon", "6:05 AM"], "short clocks");
  eq(checkinQuestion([{ from: "22:00", to: "02:00" }]), "Did you get your 10 PM–2 AM sleep?", "one window");
  eq(checkinQuestion([{ from: "22:00", to: "02:00" }, { from: "04:00", to: "06:00" }]), "Did you get your 10 PM–2 AM and 4 AM–6 AM sleep?", "two");
  eq(checkinQuestion([]), CHECKIN_QUESTION, "without a window");
  for (const q of [CHECKIN_QUESTION, checkinQuestion([{ from: "22:00", to: "02:00" }]), targetWords({ id: "a1", kind: "protected_window", member: SAM, per_week: 4 }, nameOf)]) ok(!/\bhold/i.test(q), `no "hold": ${q}`);
});

check("last night: the strip from the log, stretches over 90 minutes between two logged things, and a sleep timer left running", () => {
  // Wed night (Nov 4), seen at 7:30 AM Thu: a feed at 10 PM, a sleep 10:30 PM–1 AM, a feed 1 AM, then nothing until a diaper at 4:15 AM.
  const night = "2026-11-04";
  const entries = [feedRow(at(2026, 11, 4, 22)), sleepRow(at(2026, 11, 4, 22, 30), at(2026, 11, 5, 1), "bassinet"), feedRow(at(2026, 11, 5, 1)), { ...feedRow(at(2026, 11, 5, 4, 15)), kind: "diaper", ended_at: null, data: { pee: true } } as Entry];
  const now = at(2026, 11, 5, 7, 30).getTime();
  const pic = nightPicture({ night, entries, tries: [], shifts: [], tz: NY, now });
  eq(pic.gaps.map((g) => [iso(g.start), iso(g.end)]), [[iso(at(2026, 11, 5, 1, 20)), iso(at(2026, 11, 5, 4, 15))]], "only the stretch between two logged things (not before the first or after the last)");
  eq([pic.counts, pic.toNow, iso(pic.from), iso(pic.to)], [{ sleeps: 1, feeds: 2, diapers: 1, other: 0 }, true, iso(at(2026, 11, 4, 20)), iso(now)], "counts and the strip's span");
  // A sleep timer left running since 11 PM, with a feed at 3:10 AM after it: Woke at 3:10.
  const running = sleepRow(at(2026, 11, 4, 23), null, "bassinet");
  const feed310 = feedRow(at(2026, 11, 5, 3, 10));
  const left = nightPicture({ night, entries: [feedRow(at(2026, 11, 4, 22)), running, feed310], tries: [], shifts: [], tz: NY, now });
  eq([left.leftRunning?.sleep.id, left.leftRunning?.next.id], [running.id, feed310.id], "left running, and what came after");
  eq(nightPicture({ night, entries: [running], tries: [], shifts: [], tz: NY, now }).leftRunning, null, "a sleep still running with nothing after it may be real: not asked");
});

// ── round 2: a wider safety filter, sourced feeding-while-tired guidance, covered feeds, the "Back to work" template ──

/** Coach round 2's unsafe phrasings (safety.md), and more of the same: every one refused. */
const REFUSED_R2 = [
  // coach2's
  "Let her cry it out for 10 minutes",
  "Try the Ferber method from week 3",
  "Let her fuss for 5 minutes before going in",
  "Theo naps on the couch with her on his chest",
  "Co-sleep after the 3 AM feed",
  "She sleeps in our bed after the 4 AM feed",
  "Let her nap in the swing after lunch",
  "Doze with her in the recliner after the 2 AM feed",
  "Wren sleeps on Theo for the first stretch",
  "Nurse her to sleep in our bed, then move her",
  "Nurse her to sleep in bed and keep her there",
  "Wait 10 minutes before picking her up when she cries",
  "Leave her in the crib crying for 5 minutes",
  "Don't go in until 3 AM, whatever happens",
  "Graduated extinction, starting at 3 minutes",
  "The 5-10-15 check-ins method",
  "Put her to sleep on her tummy so she sleeps longer",
  "Let her sleep on her side, propped with a rolled towel",
  "Raise the head of the bassinet with a pillow for reflux",
  "Use a weighted sleep sack at night",
  "Let her finish naps in the car seat after drives",
  "Naps in the bouncer while I shower",
  "Put a blanket and bumpers in the crib so she settles",
  "Wren sleeps between us after the last feed",
  "Sleep with her on the sofa for the early-morning stretch",
  "Dejarla llorar 10 minutos antes de levantarla",
  "Colecho después de la toma de las 3",
  "Que duerma en nuestra cama después de las 4",
  "La laisser pleurer jusqu'à ce qu'elle s'endorme",
  "Im Familienbett schlafen lassen",
  // more of each kind
  "Wait a few minutes before going in when she wakes",
  "Never pick her up before 5 minutes",
  "Ignore her crying until the next feed",
  "Let her cry herself to sleep",
  "Timed checks at bedtime",
  "Sleep training from week 6",
  "Put her down on her tummy for naps",
  "Side sleeping so she doesn't spit up",
  "Lay her face down to sleep after the late feed",
  "Prop her up to sleep after feeds",
  "Elevate the crib mattress for her reflux",
  "A wedge under the bassinet mattress",
  "Let her nap on the Boppy",
  "Naps in the DockATot on the couch",
  "Sleeps in the lounger while we eat dinner",
  "Nursing pillow naps after lunch",
  "Contact naps on Theo after the 6 AM feed",
  "Skin-to-skin naps on my chest every afternoon",
  "She sleeps with us after the 2 AM feed",
  "Bed-sharing on the weekends",
  "Family bed until she sleeps through",
  "Let her nap in the stroller on walks",
  "She sleeps in the carrier while I cook",
  "Sling naps when we're out",
  "She naps in the car seat in the house",
  "A stuffed animal in the crib for comfort",
  "Toys and a lovey in the bassinet at night",
  "Tuck a blanket over her in the crib",
  "Weighted swaddle at bedtime",
  "Dozing with her in the glider for the 4 AM feed",
  "Theo falls asleep with her on the couch after the 6 AM feed",
  "Dejarla dormir boca abajo",
  "Siesta en el sofá con ella",
  "Dormir sur le ventre",
  "Im Autositz schlafen lassen",
  "Elle dort dans notre lit",
  "Sie schläft im Elternbett",
  "Duerme en el sofá",
  // A phone's curly apostrophe
  "Don’t go in until she’s been crying for 10 minutes",
];

/** Coach round 2's safe phrasings, the review's, and more: steps away, held sleep while awake, the transfer, the AAP's own words. */
const ALLOWED_R2 = [
  // coach2's
  "Stop letting her sleep in our bed",
  "Move her from our bed to the bassinet",
  "Contact naps on me while I'm awake",
  "Swaddle until she rolls",
  "Stop letting Wren sleep in our bed after the 4 AM feed",
  "No more letting her nap on the couch",
  "Get her out of our bed and into the bassinet",
  "Fewer contact naps, more bassinet naps",
  "Transition from co-sleeping to the crib",
  "Wean her off sleeping on me",
  "She stops falling asleep on my chest; the bassinet instead",
  "Theo holds her for her first nap while he's awake",
  "Hold her on my chest until she's deeply asleep, then the bassinet",
  "Rock her to sleep in the armchair, then lay her in the bassinet",
  "Feed her in the recliner, then put her in the bassinet before I get sleepy",
  "Theo sleeps on the couch so Noor can sleep",
  "Theo naps in our bed while Noor feeds Wren",
  "Bassinet right next to our bed",
  "Don't let her cry for long: pick her up and soothe her",
  "Respond quickly when she cries",
  "Use the swing only while she's awake",
  "Never fall asleep with her on the couch",
  "Put her down drowsy in the crib",
  // ux round 2's
  "No more falling asleep on the couch with her",
  "Let her fuss for a minute before picking her up",
  "Pause 1 minute before picking her up",
  "Move from contact naps to the bassinet",
  "She naps in the bassinet, not the swing",
  // the AAP's and NICHD's own words, as steps
  "If we bring her into our bed to feed or comfort her, place her back in her own sleep space before we go to sleep",
  "If there is any possibility that you might fall asleep while your baby is in your bed, remove pillows, blankets, sheets and other items that could cover your baby's face, head or neck or lead to overheating. If you do fall asleep, be sure to move your baby back to their own sleep space as soon as you wake up.",
  "If your baby falls asleep in a car seat, stroller, swing, infant carrier or sling, you should move them to a firm sleep surface on their back as soon as possible.",
  "Ask someone to stay with you while you're breastfeeding to keep you awake or to place the baby into a safe sleep area if you fall asleep",
  "If she falls asleep in the car seat, move her to the bassinet",
  // more
  "No pillows or blankets in the crib",
  "Remove the bumpers from the crib",
  "Skip weighted swaddles",
  "Swaddle her in a thin blanket, then the bassinet",
  "Tummy time on a blanket after breakfast",
  "Tummy time while she's awake",
  "Car seat for drives only",
  "Use the nursing pillow for feeds",
  "Tilt her head back gently to burp her",
  "Raise questions about reflux with the pediatrician",
  "Theo sleeps with earplugs in the spare room",
  "Sleeps in the bassinet next to our bed",
  "A sleep sack with no weights",
  "Pacifier at bedtime in the crib",
  "Nurse her to sleep in our bed, then move her to the bassinet",
  "Put her in bed by 8 in her crib",
  "Feed her on the couch, then lay her in the bassinet before I doze",
  "Évitez de la laisser pleurer",
  "Pas de cododo",
  "Ya no duerme en nuestra cama",
  "Que duerma en la cuna, no en nuestra cama",
  "Sie schläft nicht mehr im großen Bett",
  "Don’t let her cry: pick her up and soothe her",
];

check("safety (round 2): every unsafe phrasing is refused and every safe one passes (coach round 2's 57, the review's, the AAP's own words, and more)", () => {
  const refused = REFUSED_R2.filter((t) => unsafeSleep(t, { v: WREN, adults: FAMILY_ADULTS }));
  const passed = ALLOWED_R2.filter((t) => !unsafeSleep(t, { v: WREN, adults: FAMILY_ADULTS }));
  const whys = ["Right now she only sleeps on me", "She sleeps in our bed most nights right now and we want her in the bassinet", "We co-sleep now and want to stop", "She ends up in our bed by 3 AM"];
  const whyOk = whys.filter((t) => !unsafeSleep(t, { v: WREN, adults: FAMILY_ADULTS, describing: true }));
  console.log(`  safety lists: ${refused.length} of ${REFUSED_R2.length} unsafe refused, ${passed.length} of ${ALLOWED_R2.length} safe passed, ${whyOk.length} of ${whys.length} whys passed (plus round 1's ${REFUSED.length} and ${ALLOWED.length})`);
  for (const t of REFUSED_R2) ok(refused.includes(t), `refused: "${t}"`);
  for (const t of ALLOWED_R2) ok(passed.includes(t), `passed: "${t}" (matched "${unsafeSleep(t, { v: WREN, adults: FAMILY_ADULTS })?.phrase}")`);
  eq(whyOk.length, whys.length, "whys");
});

check("safety: each refusal says what Maple won't plan and a wording to try, which passes the filter itself", () => {
  const cases: [string, string][] = [
    ["Let her cry it out", "cry"],
    ["She naps on my chest", "adult"],
    ["Co-sleep after the late feed", "bed"],
    ["She naps on the couch", "couch"],
    ["Naps in the car seat", "seat"],
    ["Naps on the nursing pillow", "product"],
    ["Put her down on her tummy", "position"],
    ["Bumpers in the crib", "bedding"],
    ["A weighted sleep sack", "weighted"],
    ["Raise the head of the crib", "incline"],
  ];
  for (const [text, kind] of cases) {
    const find = unsafeSleep(text, { v: WREN, adults: FAMILY_ADULTS });
    eq(find?.kind, kind, text);
    for (const v of [WREN, undefined]) {
      const words = unsafeWords("Step 1", v, find);
      ok(/^Step 1: Maple won't plan /.test(words) && !/never leave|Reword it/.test(words), words);
      const tryThis = /try "([^"]+)"/.exec(words)?.[1];
      ok(tryThis && !unsafeSleep(tryThis, { v: WREN, adults: FAMILY_ADULTS }), `the suggestion passes: ${tryThis}`);
    }
  }
  eq(unsafeWords("Step 2", WREN, unsafeSleep("She naps on the couch", { v: WREN })), `Step 2: Maple won't plan sleep on a couch; if this is a step away from it, try "Bassinet before I get sleepy".`, "the review's own example");
  eq(unsafeWords("Step 1", WREN, unsafeSleep("Doze in the recliner with her", { v: WREN })), `Step 1: Maple won't plan sleep in a recliner; if this is a step away from it, try "Bassinet before I get sleepy".`, "by the furniture it names");
});

check("safety: held sleep passes only while an adult says they're awake (never the baby), and the transfer only without an adult dozing; both come with cautions", () => {
  const o = { v: WREN, adults: FAMILY_ADULTS };
  eq(sleepExemptions("Contact naps on me while I'm awake", o), { held: true, transfer: [] }, "awake adult");
  ok(unsafeSleep("Contact naps on me while she's awake", o), "she is the baby: still refused");
  ok(unsafeSleep("Contact naps on Theo after the 6 AM feed", o), "no one awake: refused");
  eq(sleepExemptions("Rock her to sleep in the armchair, then lay her in the bassinet", o), { held: false, transfer: ["couch"] }, "the transfer from a chair");
  eq(sleepExemptions("Nurse her to sleep in our bed, then move her to the bassinet", o), { held: false, transfer: ["bed"] }, "the transfer from a bed");
  ok(unsafeSleep("Doze with her in the recliner, then the bassinet", o), "an adult dozing is never the transfer");
  const c = goalCautions(
    { steps: [{ id: "s1", title: "Contact naps on me while I'm awake", week_of: null, done_at: null, done_by: null }, { id: "s2", title: "Nurse her to sleep in our bed, then move her to the bassinet", week_of: null, done_at: null, done_by: null }] },
    { v: WREN, name: nameOf, adults: FAMILY_ADULTS }
  );
  eq(c.map((x) => x.kind), ["awake", "transfer"], "kinds");
  ok(c[0].text.includes(`"${sleepyLine(WREN).split(/(?<=\.)\s+/)[0]}"`), c[0].text);
  ok(c[1].text.includes(`"${feedingSleepyWords(WREN).bed}"`), c[1].text);
});

// ── round 3: the filter's logic holes closed, coach round 3's phrasings and this round's own ──

/** Coach round 3's family: June, with Sam and Alex. */
const R3_ADULTS = ["Sam", "Alex"];
/** Coach round 3's unsafe phrasings (safety3.md): every one refused. */
const R3_REFUSED = [
  // euphemisms
  "Contact naps on the couch while I watch TV",
  "Contact naps on the couch while I'm awake",
  "Contact naps while I'm wide awake on the couch",
  "Dozing in the recliner with her on my chest",
  "Let her snooze on my chest in the glider after the 3am feed",
  "Nap together on the sofa after lunch",
  "She can finish the night on Dad's chest",
  "Family nap in the big bed on Sundays",
  "All three of us sleep in the king bed after the 4 AM feed",
  "Snuggle her to sleep in our bed and leave her there",
  "Babywearing for every nap",
  "Wrap naps on long walks",
  "Overnight in the MamaRoo next to our bed",
  "Let her sleep in the Snuggle Me lounger between us",
  "Never wake her if she falls asleep on my chest",
  "Let her nap in the swing but turn it off once she's out",
  "Car seat naps are ok if we're home",
  "A rolled blanket on each side to keep her from rolling",
  "A thin quilt over her at night",
  // negations that still plan it
  "Don't move her out of our bed once she's asleep",
  "No need to move her from the couch once she's asleep",
  "It's fine not to take her out of the swing when she dozes off",
  "Stop putting her in the bassinet and let her sleep in our bed",
  "Instead of the bassinet, she sleeps in our bed",
  // crying it out by other names
  "Let her self-soothe for 15 minutes before we go in",
  "Give her 10 minutes to settle on her own before going in",
  "Shut the door at 8 and don't come back until 6",
  "Let her work it out at night instead of rushing in",
  "Don't rush in when she cries; give it 10 minutes",
  "Leave the room and only come back if she's still crying after 10 minutes",
  "Try the Weissbluth method",
  "Interval soothing at bedtime",
  "Gentle sleep training: wait 10 minutes before going in",
  "Let her fuss it out",
  "Let her grizzle for a bit before we go in",
  "Night weaning by letting her cry",
  // typos
  "let her cri it out",
  "Ferbr method at bedtime",
  "We co-slept last night, do it again tonight",
  "she slepps in our bed after the last feed",
  "nap on the sofaa with her",
  "Let her sleep in the reclinr with me",
  // other languages
  "Dejar que llore hasta que se duerma",
  "Que llore un rato antes de cargarla",
  "Siesta en mi pecho después de comer",
  "Elle fait la sieste sur moi",
  "Méthode 5-10-15 le soir",
  "Sie schläft auf meiner Brust",
  "Kontaktschlaf auf dem Sofa",
  "Let her dormir en nuestra cama",
  "Colecho los fines de semana",
  "Dormir avec bébé dans notre lit",
];
/** Coach round 3's safe phrasings: gentle ways to settle her, and plans that keep her safe. */
const R3_ALLOWED = [
  "Pick up, put down until she settles in the bassinet",
  "Shush-pat in the bassinet until she's asleep",
  "Sit beside the bassinet and sing until she's asleep, without leaving her to cry",
  "Sit in the rocking chair by the bassinet and shush her to sleep",
  "Rest a hand on her tummy in the bassinet until she drifts off",
  "Keep a hand on her chest in the crib while she falls asleep",
  "Let her cry in my arms while I rock her",
  "Let her fuss a little while I change her diaper",
  "Stay with her and hum, never leaving her to cry",
  "If she cries, pick her up right away and soothe her",
  "Fading: a little less rocking each night before the crib",
  "Put her down drowsy but awake, and pick her up if she cries",
  "Swaddle arms-in until she shows signs of rolling",
  "White noise and a pacifier in the bassinet",
  "Feed her in the glider, burp, then lay her down in the bassinet",
  "Contact naps only when Alex is awake and watching her",
  "Never let her sleep on the couch",
  "She should not sleep in the swing",
  "No contact naps on the sofa",
  "Not in our bed anymore, bassinet only",
  "Don't fall asleep with her in the recliner",
  "We won't do cry it out",
  "No CIO, ever",
  "Avoid letting her doze in the car seat at home",
  "Move the car seat naps to the crib",
  "Stop the car seat naps at home",
  "If she dozes off in the stroller, lay her in the crib when we get home",
  "Daytime naps in the bassinet by the couch",
  "Alex naps on the couch while Sam has her in the bassinet",
  "Sam sleeps in the guest bed on Alex's nights",
  "Tummy time on the floor after every nap",
  "No blankets, just a sleep sack",
  "Take the bumpers out of the crib",
  "Pump before bed so Alex can do the 2 AM bottle",
  "Don't wait 10 minutes before going in",
  "Room-share in our room until 6 months, bassinet within arm's reach",
  "Sleep in the Snoo bassinet",
  "Pack 'n Play in our room for naps",
  "Que duerma en su moisés junto a nuestra cama",
  "Nie mehr im Elternbett schlafen",
];
/** Coach round 3's whys: how things are now, or what happened, is the reason. */
const R3_WHYS = [
  "We fell asleep on the couch with her twice this week",
  "She slept in the swing for 3 hours yesterday",
  "She ended up in our bed at 3 AM most nights",
  "I keep waking up with her on my chest in the recliner",
  "Alex dozed off holding her on the sofa and it scared us",
  "Right now the only place she naps is the car seat",
];
/**
 * This round's own: held sleep on a couch, chair or adult bed; a nap there
 * "then the bassinet"; a step away undone by how it's done or by a negation;
 * crying it out without the word "wait"; beds, devices and bedding; and the
 * edges these rules met (an overwhelmed parent's break, "together" while
 * someone else has her, a why that plans it).
 */
const OWN_REFUSED = [
  "Contact naps in our bed while I'm awake",
  "Let her sleep on my chest in the recliner as long as I stay awake",
  "Contact naps on the couch while Sam is awake, then the bassinet",
  "Contact naps in the armchair while I'm wide awake",
  "Contact naps on Dad on the sofa while he's awake",
  "Let her nap on the sofa, then move her to the crib",
  "Wean her off night feeds by letting her cry",
  "Stop the 3 AM feed using the Ferber method",
  "Night weaning by leaving her to cry",
  "Don't stop co-sleeping yet",
  "Never take her out of the car seat once she's asleep",
  "We won't move her from our bed after she falls asleep",
  "Leave her in the swing when she falls asleep",
  "Sit with her on the sofa while she sleeps",
  "Give her 5 minutes to cry before going in",
  "Give her 10 minutes before going in",
  "Leave the room and come back in 10 minutes if she's still crying",
  "Close the door and don't go back in until morning",
  "Don't come back in until she stops crying",
  "Let her figure it out on her own at bedtime",
  "Self-soothe for 10 minutes before we pick her up",
  "Elle dort sur papa après la tétée",
  "Laisse-la pleurer dix minutes",
  "Lass sie schreien, bis sie einschläft",
  "Sleep together in the guest bed on Sundays",
  "Let June sleep in the king-size bed after the 5 AM feed",
  "Rolled towels under the sheet to keep her on her back",
  "A quilt on top of her at night",
  "Naps in the baby rocker after lunch",
  "Feed her in the glider until she falls asleep",
  "Keep her in the car seat if she falls asleep on the drive",
  "Hold her on the sofa while she sleeps",
  "Don't take her out of the swing until she wakes",
  "Keep her on the couch with me until she wakes up",
  "Put her down, leave the room and don't come back until 6",
  "Cuddle together on the couch until she's asleep",
  "Nap together on the sofa, then the bassinet",
  "Nurse her to sleep in our bed or on the couch, then the bassinet",
  "Don't wean her off contact naps yet",
  "Let her cry it out when I'm frustrated",
];
const OWN_ALLOWED = [
  "Hold her while I'm awake, then the bassinet",
  "Rock her on the couch until she's drowsy, then lay her in the bassinet",
  "Sit in the glider next to the crib while she falls asleep in it",
  "Never move her from the bassinet into our bed to sleep",
  "Stop taking her out of the bassinet and into our bed to sleep",
  "Don't let her sleep in the car seat once we're home",
  "If she falls asleep in the stroller, move her to the crib when we get home",
  "Let her cry in Sam's arms while he walks her",
  "Let her cry while Sam holds her",
  "Let her fuss a little before I pick her up",
  "Give her 1 minute before going in",
  "Give her 10 minutes of tummy time after the feed",
  "Give it 15 minutes after the feed before laying her down",
  "If she's still crying after 20 minutes of rocking, hand her to Sam",
  "Sam goes to the guest room at 10 and doesn't come back until 6",
  "Sam, go to the guest room at 10 and don't come back until 6",
  "Leave the room for a shower and come back in 10 minutes",
  "When it's too much, put her in the crib, leave the room and come back in 10 minutes",
  // Round 4 (the safety review's P0 #2): the one-off break lays her on her back; without it, this is in BREAK_REFUSED.
  "If she cries and it's too much, lay her on her back in the bassinet, leave the room and come back in 10 minutes",
  "If I'm overwhelmed, lay her in the bassinet and step away for a few minutes",
  "Alex sleeps in our bed with earplugs while Sam has her in the bassinet",
  "We sleep in our bed, she sleeps in the bassinet",
  "We nap together on the couch while Gran has her in the bassinet",
  "Sam and Alex nap together on the couch while Gran has her",
  "Move the swing naps to the bassinet",
  "Keep pillows and blankets out of the crib",
  "Take the toys out of the bassinet before naps",
  "No contact naps in the recliner",
  "Instead of contact naps on the couch, the bassinet",
  "Contact naps while I'm awake, never on the couch",
  "Hold her in my arms in the glider until she's asleep, then lay her in the crib",
  "Burp her on my shoulder, then lay her in the bassinet",
  "Bassinet for naps, swing only while she's awake",
  "Swing her gently until she falls asleep, then lay her in the bassinet",
  "Babywearing for walks, bassinet for naps",
  "Elle dort dans son berceau, pas sur moi",
  "Wean off the swing for naps",
  "Night weaning, once the pediatrician says it's okay",
];
const OWN_WHYS = [
  "We napped on the couch together once and it scared us",
  "She slept in the car seat all afternoon yesterday",
  "Theo nodded off with her on the sofa last week",
  "Last night she ended up asleep on Alex's chest in the recliner",
  "I fell asleep feeding her in the recliner last week",
  "Sam keeps falling asleep with her on the couch",
  "The swing is the only place she naps",
  "She only naps on me on the couch",
  "She sleeps in our bed and we'd like that to stop",
];
/** Whys that plan it: still refused. */
const OWN_WHYS_REFUSED = ["So she can keep napping on the couch with me", "We want her to keep napping on my chest like she did yesterday", "Always let her sleep on my chest"];

check("safety (round 3): the three logic holes are closed: no held or transfer pass on a couch, chair, recliner or adult bed the sentence names; 'wean' steps away only before off or from; a negation before the verb undoes the step away", () => {
  const o = { v: SHE, adults: R3_ADULTS };
  // Held while awake is the holding turn, but never on a couch, chair or adult bed (the AAP: never a couch; dozing there is especially dangerous).
  for (const [text, kind, what] of [
    ["Contact naps on the couch while I'm awake", "couch", "on a couch"],
    ["Contact naps while I'm wide awake on the couch", "couch", "on a couch"],
    ["Contact naps in the armchair while I'm wide awake", "couch", "in an armchair"],
    ["Contact naps in our bed while I'm awake", "bed", null],
  ] as const) {
    const find = unsafeSleep(text, o);
    eq([find?.kind, find?.what, find?.awake], [kind, what, true], text);
    eq(sleepExemptions(text, o), { held: false, transfer: [] }, `no exemption: ${text}`);
  }
  eq(sleepExemptions("Contact naps on me while I'm awake", o), { held: true, transfer: [] }, "held while awake, nowhere unsafe: still the holding turn");
  eq(sleepExemptions("Contact naps while I'm awake, never on the couch", o), { held: true, transfer: [] }, "a couch it steps away from doesn't count");
  // The transfer: settling her somewhere, then the bassinet; never a nap there, held sleep there, or another couch or bed with it.
  eq(sleepExemptions("Rock her to sleep in the armchair, then lay her in the bassinet", o), { held: false, transfer: ["couch"] }, "the transfer still passes");
  for (const text of ["Let her nap on the sofa, then move her to the crib", "Contact naps on the couch while Sam is awake, then the bassinet", "Nurse her to sleep in our bed or on the couch, then the bassinet"]) ok(unsafeSleep(text, o), `no transfer: ${text}`);
  // "Wean" is a step away only before "off" or "from".
  eq(unsafeSleep("Night weaning by letting her cry", o)?.kind, "cry", "night weaning by letting her cry");
  ok(!unsafeSleep("Wean her off contact naps", o) && !unsafeSleep("Wean off the swing for naps", o), "weaning off them still steps away");
  ok(unsafeSleep("Wean her off night feeds by letting her cry", o), "how a step away is made isn't stepped away from");
  // A negation before the verb undoes the step away.
  eq(unsafeSleep("Don't move her out of our bed once she's asleep", o)?.kind, "bed", "don't move her out of our bed");
  eq(unsafeSleep("No need to move her from the couch once she's asleep", o)?.kind, "couch", "no need to move her from the couch");
  eq(unsafeSleep("It's fine not to take her out of the swing when she dozes off", o)?.kind, "seat", "fine not to take her out of the swing");
  eq(unsafeSleep("Don't stop co-sleeping yet", o)?.kind, "bed", "don't stop co-sleeping");
  ok(!unsafeSleep("Never move her from the bassinet into our bed to sleep", o), "never moving her from the bassinet into our bed steps away from the bed");
  ok(!unsafeSleep("Don't let her sleep in our bed", o) && !unsafeSleep("Stop letting her sleep in our bed", o), "the step-away words themselves still step away");
});

check("safety (round 3): coach round 3's 98 phrasings and this round's own, each as wanted; every refusal's suggestion passes the filter in each voice and without one", () => {
  eq([R3_REFUSED.length, R3_ALLOWED.length, R3_WHYS.length], [52, 40, 6], "coach round 3's 98");
  const o = { v: SHE, adults: R3_ADULTS };
  const why = { ...o, describing: true };
  const refused = [...R3_REFUSED, ...OWN_REFUSED].filter((t) => unsafeSleep(t, o));
  const passed = [...R3_ALLOWED, ...OWN_ALLOWED].filter((t) => !unsafeSleep(t, o));
  const whys = [...R3_WHYS, ...OWN_WHYS].filter((t) => !unsafeSleep(t, why));
  const plans = OWN_WHYS_REFUSED.filter((t) => unsafeSleep(t, why));
  console.log(
    `  round 3 lists: coach's ${R3_REFUSED.filter((t) => refused.includes(t)).length} of ${R3_REFUSED.length} unsafe refused, ${R3_ALLOWED.filter((t) => passed.includes(t)).length + R3_WHYS.filter((t) => whys.includes(t)).length} of ${R3_ALLOWED.length + R3_WHYS.length} safe passed; this round's ${OWN_REFUSED.filter((t) => refused.includes(t)).length + plans.length} of ${OWN_REFUSED.length + OWN_WHYS_REFUSED.length} unsafe refused, ${OWN_ALLOWED.filter((t) => passed.includes(t)).length + OWN_WHYS.filter((t) => whys.includes(t)).length} of ${OWN_ALLOWED.length + OWN_WHYS.length} safe passed`
  );
  for (const t of [...R3_REFUSED, ...OWN_REFUSED]) ok(refused.includes(t), `refused: "${t}"`);
  for (const t of [...R3_ALLOWED, ...OWN_ALLOWED]) ok(passed.includes(t), `passed: "${t}" (matched "${unsafeSleep(t, o)?.phrase}")`);
  for (const t of [...R3_WHYS, ...OWN_WHYS]) ok(whys.includes(t), `a why: "${t}" (matched "${unsafeSleep(t, why)?.phrase}")`);
  for (const t of OWN_WHYS_REFUSED) ok(plans.includes(t), `a why that plans it: "${t}"`);
  // None of these is already in round 1's or round 2's lists.
  const earlier = new Set([...REFUSED, ...ALLOWED, ...REFUSED_R2, ...ALLOWED_R2]);
  eq([...R3_REFUSED, ...R3_ALLOWED, ...R3_WHYS, ...OWN_REFUSED, ...OWN_ALLOWED, ...OWN_WHYS, ...OWN_WHYS_REFUSED].filter((t) => earlier.has(t)), [], "all new");
  // Every refusal's wording to try passes the filter, in each family's words and without a voice (the form).
  for (const text of [...R3_REFUSED, ...OWN_REFUSED]) {
    const find = unsafeSleep(text, o)!;
    for (const v of [...VOICES, undefined]) {
      const words = unsafeWords("Step 1", v, find);
      const tryThis = /try "([^"]+)"/.exec(words)?.[1];
      ok(tryThis && !unsafeSleep(tryThis, { v, adults: R3_ADULTS }) && !unsafeSleep(tryThis, { adults: R3_ADULTS }), `the suggestion passes: ${words}`);
      ok(/^Step 1: Maple won't plan /.test(words) && !/never leave|Reword it|dangerous/i.test(words), `helpful, not a lecture: ${words}`);
    }
  }
});

check("safety (round 3): the refusals say what they found and stay helpful: held sleep on a couch or bed says someone awake doesn't change it, in the family's words; a near miss in why it matters saves without a refusal", () => {
  const o = { v: SHE, adults: R3_ADULTS };
  eq(unsafeWords("Step 1", SHE, unsafeSleep("Contact naps on the couch while I'm awake", o)), `Step 1: Maple won't plan sleep on a couch, even with someone awake; try "Hold her while I'm awake, then the bassinet".`, "held on a couch");
  eq(unsafeWords("Step 2", SHE, unsafeSleep("Contact naps in our bed while I'm awake", o)), `Step 2: Maple won't plan June sleeping in an adult bed, even with someone awake; try "Hold her while I'm awake, then the bassinet".`, "held in an adult bed");
  eq(unsafeWords("Step 1", undefined, unsafeSleep("Contact naps in our bed while I'm awake", o)), `Step 1: Maple won't plan the baby sleeping in an adult bed, even with someone awake; try "Hold the baby while I'm awake, then the bassinet".`, "without a voice");
  eq(unsafeWords("Step 1", HE, unsafeSleep("Contact naps on the sofa while I'm awake", { v: HE, adults: R3_ADULTS })), `Step 1: Maple won't plan sleep on a sofa, even with someone awake; try "Hold him while I'm awake, then the bassinet".`, "his family's words");
  for (const [text, what] of [
    ["Babywearing for every nap", "a carrier"],
    ["Wrap naps on long walks", "a wrap"],
    ["Overnight in the MamaRoo next to our bed", "a baby swing"],
    ["Naps in the baby rocker after lunch", "a baby rocker"],
    ["Let her sleep in the reclinr with me", "in a recliner"],
    ["nap on the sofaa with her", "on a sofa"],
  ] as const) eq(unsafeSleep(text, o)?.what, what, text);
  eq(unsafeSleep("A rolled blanket on each side to keep her from rolling", o)?.kind, "bedding", "a rolled blanket is soft bedding in her sleep space");
  // The why's near miss saves as the reason for the goal; the same words as a step are still refused.
  const rules: GoalRules = { ...RULES, v: SHE };
  eq(cleanGoalInput({ title: "Safer nights", why: "Alex dozed off holding her on the sofa and it scared us" }, rules, "create").fields.why, "Alex dozed off holding her on the sofa and it scared us", "the near miss saves");
  throwsInput(() => cleanGoalInput({ title: "Safer nights", steps: [{ title: "Hold her on the sofa while she sleeps" }] }, rules, "create"), /^Step 1: Maple won't plan sleep on a sofa;/, "a step that plans it");
});

check("guidance (round 3): going back to work has sourced words for the coach to cite: bottles at the sooner of about 4 weeks or two weeks before (Texas HHS), more night nursing after (OWH's reverse cycling), a drowsy drive (a small survey and NIOSH), dated and waiting for review, never in the guidance list", () => {
  // Three more hosts, for these items: the Office on Women's Health, Texas HHS's Breastmilk Counts (Texas WIC) and CDC NIOSH.
  const hosts = new Set([...ALLOWED_HOSTS, "womenshealth.gov", "breastmilkcounts.com", "www.cdc.gov"]);
  eq(WORK_GUIDES.map((g) => g.id), [WORK_BOTTLES, WORK_NIGHT_NURSING, WORK_DROWSY_DRIVING], "the exported ids");
  const ids = new Set(SLEEP_GUIDES.map((g) => g.id));
  for (const g of WORK_GUIDES) {
    ok(!ids.has(g.id) && workGuide(g.id) === g, `${g.id}: its own id, found by workGuide`);
    // Round 4: the bottle and drowsy-drive items were changed after the safety review and checked again on 2026-11-03.
    eq([g.reviewed, g.needsReview, g.basis, pendingReview().includes(g)], [g.id === WORK_NIGHT_NURSING ? "2026-11-02" : "2026-11-03", true, "source", true], `${g.id}: reviewed and waiting for sign-off`);
    ok((SLEEP_SECTIONS as readonly string[]).includes(g.section) && g.minDays === 0 && g.maxDays >= 365, `${g.id}: section and ages`);
    for (const s of g.sources) ok(new URL(s.url).protocol === "https:" && hosts.has(new URL(s.url).host) && s.label.trim().length > 0, `${g.id}: source ${s.url}`);
  }
  eq(workGuide(WORK_BOTTLES)!.sources.map((s) => s.url), ["https://womenshealth.gov/breastfeeding/breastfeeding-home-work-and-public/breastfeeding-and-going-back-work", "https://breastmilkcounts.com/breastfeeding-basics/bottle-feeding-your-baby/"], "OWH, then Texas HHS");
  eq(workGuide(WORK_NIGHT_NURSING)!.sources.map((s) => s.url), ["https://womenshealth.gov/breastfeeding/breastfeeding-home-work-and-public/breastfeeding-and-going-back-work"], "OWH");
  eq(workGuide(WORK_DROWSY_DRIVING)!.sources.map((s) => s.url), ["https://pubmed.ncbi.nlm.nih.gov/26541593/", "https://www.cdc.gov/niosh/work-hour-training-for-nurses/longhours/mod11/05.html"], "the survey and NIOSH");
  // The words the sources say, in the family's voice: the sooner of the two, only after their clinician's yes.
  eq(workGuide(WORK_BOTTLES)!.body(SHE), "If June nurses, a bottle of expressed milk usually waits until about 4 weeks old. If the nursing parent goes back to work or school before then, ask her pediatrician or lactation consultant first.", "bottles: never before about 4 weeks old (round 4)");
  ok(/^If the baby nurses, .* ask their pediatrician/.test(workGuide(WORK_BOTTLES)!.body(THEY)) && /ask his pediatrician/.test(workGuide(WORK_BOTTLES)!.body(HE)), "bottles in each voice");
  ok(/nurse more often at night, which is called reverse cycling/.test(workGuide(WORK_NIGHT_NURSING)!.body(SHE)), "reverse cycling");
  ok(/72 new parents, poor sleep quality went with a sixfold increase in near misses/.test(workGuide(WORK_DROWSY_DRIVING)!.body(SHE)) && /a ride from family or a friend, or other transportation\. A short nap first may still not keep you awake enough to drive safely\./.test(workGuide(WORK_DROWSY_DRIVING)!.body(SHE)), "near misses, and what to do");
  for (const v of VOICES) {
    for (const g of WORK_GUIDES) {
      const line = `${g.title(v)} ${g.body(v)}`;
      ok(!/cry[- ]?it[- ]?out|sleep[- ]?train|contact (nap|sleep)|co-?sleep|bed[- ]?shar|\bdoses?\b|\bdiagnos/i.test(line), `${g.id}: nothing the guidance never says: ${line}`);
      if (v === THEY) ok(!/\b(she|her|hers|he|him|his)\b/i.test(line), `${g.id}: in the family's words: ${line}`);
    }
  }
  // Never in the family's guidance list, at any age, stage or signal.
  const shown = new Set([0, 13, 40, 120, 300].flatMap((days) => [null, 1, 2, 3, 4].flatMap((stage) => {
    const g = sleepGuidance(SHE, { days, stage: stage as 1 | 2 | 3 | 4 | null, signals: new Set(["no_tries_yet", "after_crying", "retry_done", "hard_day", "steady", "long_gap", "swaddled"]) });
    return [...g.now, ...g.sections.flatMap((s) => s.items)].map((x) => x.id);
  })));
  ok(WORK_GUIDES.every((g) => !shown.has(g.id)), "not in the guidance list");
});

check("guidance: feeding when tired (NICHD and the AAP: tiredness, someone to stay with you, a cleared bed, a bed less hazardous than a sofa but not recommended), the tired adult's bed, sitting devices, sourced and waiting for review", () => {
  const byId = (id: string) => SLEEP_GUIDES.find((g) => g.id === id)!;
  const feeding = byId("safe-feeding-sleepy");
  const body = feeding.body(WREN);
  for (const re of [
    /Be mindful of how tired you are, and avoid couches and armchairs for feeds if you think you might fall asleep\./,
    /Ask someone to stay with you while you feed her, to keep you awake or to lay her in the bassinet if you fall asleep\./,
    /remove|take away/,
    /pillows, blankets, sheets and anything else that could cover her face, head or neck or make her too warm/,
    /If you do fall asleep, move her back as soon as you wake\./,
    /The AAP recommends against bed sharing under any circumstances\. If you bring her into your bed to feed, put her back in her own sleep space before you sleep\./,
    /Falling asleep there by accident is relatively less hazardous than on a sofa or armchair, but still not recommended\./,
  ]) ok(re.test(body), `${re}: ${body}`);
  ok(/The AAP recommends against bed sharing under any circumstances, and the risk of a sleep-related death is more than 10 times higher when the adult is very tired, has taken medicine that makes it harder to wake, or has had alcohol or drugs/.test(byId("safe-sleepy").body(WREN)), "quote 6");
  eq(sleepyLine(WREN), byId("safe-sleepy").body(WREN).split(" The AAP recommends")[0], "the holding sheet keeps the two things to do");
  ok(/^Car seats, strollers, swings, carriers and slings aren't for routine sleep, especially before 4 months\. If she falls asleep in one, move her to the bassinet, on her back, as soon as you can\.$/.test(byId("safe-seats").body(WREN)), "quote 8 and 9");
  for (const id of ["safe-feeding-sleepy", "safe-sleepy", "safe-seats"]) {
    const g = byId(id);
    // Round 4: the first two were changed after the safety review and checked again on 2026-11-03.
    eq([g.reviewed, g.needsReview, pendingReview().includes(g)], [id === "safe-seats" ? "2026-11-02" : "2026-11-03", true, true], `${id}: reviewed and waiting for sign-off`);
  }
  eq(feeding.sources.map((x) => x.url), [
    "https://www.nichd.nih.gov/sites/default/files/2018-11/Breastfeed_Baby_SIDS_final.pdf",
    "https://www.healthychildren.org/English/ages-stages/baby/sleep/Pages/a-parents-guide-to-safe-sleep.aspx",
    "https://pubmed.ncbi.nlm.nih.gov/35921639/",
  ], "exact sources");
  ok(byId("safe-seats").sources.some((x) => x.url === "https://pubmed.ncbi.nlm.nih.gov/35921639/"), "the technical report for sitting devices");
  eq(nightFeedLine(WREN), "Feeling sleepy? Wake someone to sit with you, or lay her on her back in the bassinet.", "the feed card's night line");
  ok(!/\b(she|her|he|him)\b/i.test(nightFeedLine(THEY)), "the night line in the family's words");
});

check("cautions by how a window's feeds are covered and her age: nursing says nothing, a bottle is a question before 4 weeks and a pumping reminder after, no feed planned only past 4 hours (5 from 4 weeks)", () => {
  const w = (covers: RosterWindow["covers"] | undefined, from = "22:00", to = "03:00", member = SAM): RosterWindow => ({ id: "w1", member, from, to, nights: EVERY, ...(covers ? { covers } : {}) });
  const kinds = (roster: RosterWindow[], ageDays: number | null, template?: SleepGoal["template"]) => goalCautions({ roster, template }, { v: WREN, name: nameOf, ageDays }).map((c) => c.kind);
  eq(kinds([w("nurse")], 20), [], "nursing covers it (the review's P2-11)");
  eq(kinds([w("nurse", "19:30", "07:30")], 40), [], "even a long one");
  eq(kinds([w(undefined, "22:00", "02:30")], 20), ["long_window"], "4h 30m, nothing said, in the first weeks");
  eq(kinds([w(undefined, "22:00", "02:30")], 40), [], "4h 30m from 4 weeks: under 5 hours");
  eq(kinds([w("none", "22:00", "03:30")], 40), ["long_window"], "5h 30m with no feed planned");
  const young = goalCautions({ roster: [w("bottle")] }, { v: WREN, name: nameOf, ageDays: 20 })[0].text;
  eq(plain(young), "A bottle in Sam's window (10:00 PM–3:00 AM): If Wren nurses, a bottle of expressed milk usually waits until about 4 weeks old. If the nursing parent goes back to work or school before then, ask her pediatrician or lactation consultant first. Until then, whoever's on duty can bring her to nurse and settle her after.", "WORK_BOTTLES's words, undated without a day");
  const older = goalCautions({ roster: [w("bottle", "22:00", "03:00", ALEX)], template: { kind: "back_to_work", member: SAM, date: "2026-11-30", nursing: ALEX } }, { v: WREN, name: nameOf, ageDays: 40 })[0].text;
  eq(plain(older), "A bottle in Alex's window (10:00 PM–3:00 AM): plan when Alex pumps around that feed, as their lactation consultant advises.", "after 4 weeks, the research's reminder, naming who nurses");
  eq(kinds([w("bottle")], 20, { kind: "back_to_work", member: SAM, date: "2026-11-30", nursing: null }), [], "a baby on bottles only: nothing to say");
  throwsInput(() => cleanGoalInput({ title: "Nights", roster: [{ member: SAM, from: "22:00", to: "02:00", nights: EVERY, covers: "formula" as "bottle" }] }, RULES, "create"), /^Window 1: how its feeds are covered must be one of nurse, bottle, none\.$/, "a cover it doesn't know");
  const saved = cleanGoalInput({ title: "Nights", roster: [{ member: SAM, from: "22:00", to: "02:00", nights: EVERY, covers: "nurse" }, { member: ALEX, from: "02:00", to: "06:00", nights: EVERY }] }, RULES, "create").fields.roster!;
  eq([saved[0].covers, "covers" in saved[1]], ["nurse", false], "kept when said; a window without one stays as before");
  ok((plain(rosterWords(saved, nameOf)) as string).includes("Sam: 10:00 PM–2:00 AM, every night (feeds: nursing); Alex: 2:00 AM–6:00 AM, every night"), rosterWords(saved, nameOf));
});

check("template: five answers make a goal, a night roster with its feeds covered and three steps timed from the day back, with notes; what it can't use is said in words", () => {
  const adults = new Set([SAM, ALEX]);
  const o = { v: WREN, name: nameOf, today: "2026-11-02", adults };
  const answers: BackToWorkAnswers = { returning: SAM, return_date: "2026-11-30", feeding: "nursing", nursing: ALEX, sleeps: "bed", first_half: SAM, second_half: ALEX, off_duty: "other_room" };
  const { goal, notes } = backToWorkGoal(answers, o);
  eq([goal.title, goal.why, goal.target_date], ["Back to work: protected sleep for Sam and Alex", "Sam goes back to work on Mon, Nov 30.", "2026-12-13"], "title, why, two weeks after the day back");
  eq(goal.roster, [
    { member: ALEX, from: "22:00", to: "02:00", nights: EVERY, covers: "nurse" },
    { member: SAM, from: "02:00", to: "06:00", nights: [0, 1, 2, 3, 4], covers: "nurse" },
  ], "whoever's on first sleeps the second half; the one going back, on work nights");
  eq(goal.targets, [{ kind: "protected_window", member: SAM, per_week: 5 }, { kind: "protected_window", member: ALEX, per_week: 4 }], "a protected window each");
  // Nursing only: the night feeds' step, never a bottle (the coach re-test's P2 #13).
  eq(goal.steps!.map((x) => [x.title, x.week_of]), [
    ["Plan the night feeds: whoever's on duty brings her to Alex to nurse, then settles her", "2026-11-02"],
    ["Rehearse the work-week roster on 2 or 3 nights", "2026-11-16"],
    ["Plan a short first week back (a Wednesday or Thursday start, if work allows)", "2026-11-23"],
  ], "weeks −4, −2 and −1");
  eq(goal.template, { kind: "back_to_work", member: SAM, date: "2026-11-30", nursing: ALEX, roster_from: "2026-11-16", feeding: "nursing" }, "what the coach notes need later, and when the roster starts");
  ok(notes[0] === "Sam is back in 28 days, so the first step starts this week." && notes.some((n) => /^Wren sleeps in your bed now: Maple's plans keep her in her own sleep space, the bassinet in your room, close to your bed but not in it\./.test(n)), JSON.stringify(notes));
  ok(notes.includes("The adult who's off sleeps in another room. Night feeds: in Alex's window, Sam brings her to Alex to nurse, then settles her; in Sam's window, Alex nurses her."), JSON.stringify(notes));
  // It checks as any goal does: every word passes the filter, and there's nothing to caution about.
  const { fields } = cleanGoalInput(goal, { ...RULES, v: WREN }, "create");
  eq(goalCautions(fields, { v: WREN, name: nameOf, ageDays: 20 }), [], "nursing covers both windows; the bottle step is a question");
  for (const t of [goal.title!, ...goal.steps!.map((x) => x.title)]) ok(!unsafeSleep(t, { v: WREN }), t);
  // The nursing parent going back: more night nursing to expect. Both: a bottle in the nursing parent's window, after a question.
  const back = backToWorkGoal({ ...answers, returning: ALEX, first_half: ALEX, second_half: SAM, feeding: "both" }, o);
  ok(back.notes.some((n) => n === "When the nursing parent goes back to work, some babies eat less during the day and nurse more often at night, which is called reverse cycling. Others eat well during the day and still nurse more at night, maybe for the closeness. (Source: Office on Women's Health: Breastfeeding and going back to work.) Once Alex is back, the morning check-ins will show how the nights go, and the roster can change."), JSON.stringify(back.notes));
  eq(back.goal.roster!.map((x) => [nameOf(x.member), x.covers]), [["Sam", "nurse"], ["Alex", "bottle"]], "Alex nurses: a bottle in Alex's window");
  eq(back.goal.steps![0].title, "Ask the lactation consultant when Alex should pump around the night bottle", "both: the pumping question");
  const bottles = backToWorkGoal({ ...answers, feeding: "bottles", nursing: null, off_duty: "same_room" }, o);
  eq([bottles.goal.roster!.map((x) => x.covers), bottles.goal.steps![0].week_of, bottles.goal.template?.nursing], [["bottle", "bottle"], "2026-11-09", null], "bottles: no bottle question");
  // Round 4: no unsourced "one clinician's approach" (the safety review's P1 #9).
  ok(bottles.notes.some((n) => n.startsWith("The adult who's off sleeps in the same room. Night feeds: ")) && !bottles.notes.some((n) => /clinician's approach|two sleep spaces/.test(n)), JSON.stringify(bottles.notes));
  // Back in 5 days: every step this week.
  eq(backToWorkGoal({ ...answers, return_date: "2026-11-07" }, o).goal.steps!.map((x) => x.week_of), ["2026-11-02", "2026-11-02", "2026-11-02"], "never before this week");
  throwsInput(() => backToWorkGoal({ ...answers, second_half: SAM }, o), /^The two halves of the night need two different adults/, "one adult for both halves");
  throwsInput(() => backToWorkGoal({ ...answers, return_date: "2026-10-18" }, o), /^The day back at work was more than two weeks ago/, "a day back over two weeks past");
  throwsInput(() => backToWorkGoal({ ...answers, nursing: null }, o), /^Who nurses needs one of the family's adults\.$/, "who nurses");
  throwsInput(() => backToWorkGoal({ ...answers, returning: CASEY }, o), /^Who goes back to work: Casey isn't an owner or member of this family\.$/, "someone outside the family");
  eq(backToWorkQuestions(WREN).length, 5, "five questions");
});

check("long turns: one handed off as planned is never 'left open'; one an hour past its planned handoff is, and so is one over 4 hours with no plan", () => {
  const t0 = at(2026, 11, 2, 22);
  const turn = (hours: number, more: Partial<HoldingShift>) => ({ ...shiftRow(SAM, t0, new Date(t0.getTime() + hours * HOUR)), ...more });
  const now = at(2026, 11, 3, 9).getTime();
  eq(turnLeftOpen(turn(4, { handoff_at: iso(t0.getTime() + 4 * HOUR), ended_how: "handoff" }), now), false, "a 4-hour turn handed off on time (coach round 2's N4)");
  eq(turnLeftOpen(turn(6, { handoff_at: iso(t0.getTime() + 2 * HOUR), ended_how: "handoff" }), now), false, "taken over late: still a handoff");
  eq(turnLeftOpen(turn(3.5, { handoff_at: iso(t0.getTime() + 3 * HOUR) }), now), false, "ended half an hour past its plan");
  eq(turnLeftOpen(turn(4.5, { handoff_at: iso(t0.getTime() + 2 * HOUR) }), now), true, "ended 2h 30m past its plan");
  eq([turnLeftOpen(turn(3, {}), now), turnLeftOpen(turn(4.5, {}), now)], [false, true], "no plan: over 4 hours");
  const g = goalRow({ roster: [{ id: "w1", member: SAM, from: "21:30", to: "01:30", nights: EVERY }] });
  const p = goalProgress(g, data({ shifts: [turn(4.5, { handoff_at: iso(t0.getTime() + 2 * HOUR) })] }), at(2026, 11, 5, 9), NY);
  ok(/a holding turn an hour or more past its planned handoff \(Sam's, from 10:00 PM to 2:30 AM; planned for 12:00 AM\) is left out: it may have been left open/.test(plain(rosterHintBody(p.roster[0], nameOf, WREN, NY)) as string), rosterHintBody(p.roster[0], nameOf, WREN, NY));
});

check("feeds only: a week with only feeds logged never reads as 'no tries' (the lines and a coach note say whether she tried the bassinet isn't in the log)", () => {
  const g = goalRow({ targets: [{ id: "a1", kind: "bassinet_nights", per_week: 3, min_minutes: 90 }] });
  const entries = Array.from({ length: 7 }, (_, d) => [feedRow(at(2026, 11, 2 + d, 22)), feedRow(at(2026, 11, 3 + d, 1, 30)), feedRow(at(2026, 11, 3 + d, 5))]).flat();
  const now = at(2026, 11, 9, 13);
  const p = goalProgress(g, data({ entries }), now, NY);
  const tp = p.targets[0];
  eq(tp.kind === "bassinet_nights" && [tp.weeks[0].known, tp.weeks[0].unknown, tp.weeks[0].feedsOnly], [0, 7, 7], "seven nights of feeds, none known for a bassinet aim");
  const lines = goalProgressLines(g, p, words(WREN, now)).join("\n");
  // Nothing about her sleep on any night: the sample first, never "0 of the 3 nights aimed for".
  ok(lines.includes("Last week: a try, a sleep or a morning answer about her night on 0 of 7 nights, too few to tell.") && !/0 of the 3 nights aimed for/.test(lines), lines);
  const c = coachNotes(g, p, words(WREN, now));
  ok(c.notes.includes("Only feeds or other entries were logged on 7 of the last 7 nights, with no try, sleep or answer about Wren's night: whether Wren tried the bassinet then isn't in the log, so those nights stay out of the bassinet count; don't ask about each one."), JSON.stringify(c.notes));
});

check("focus: when her logged night feeds come closer together than the window is long, the step to talk over is a shorter window or someone else giving one feed", () => {
  const roster = [{ id: "w1", member: SAM, from: "21:30", to: "01:30", nights: EVERY }, { id: "w2", member: ALEX, from: "01:30", to: "06:30", nights: EVERY }];
  const g = goalRow({ roster });
  // Sam nurses about every 3h 20m: 10 PM, 1:20 AM, 4:40 AM.
  const entries = Array.from({ length: 5 }, (_, d) => [feedRow(at(2026, 11, 2 + d, 22), SAM), feedRow(at(2026, 11, 3 + d, 1, 20), SAM), feedRow(at(2026, 11, 3 + d, 4, 40), SAM)]).flat();
  const now = at(2026, 11, 7, 9);
  const p = goalProgress(g, data({ entries }), now, NY);
  eq(p.feedGap, { longestMin: 200, nights: 5 }, "the longest gap between her feeds");
  const c = coachNotes(g, p, words(WREN, now));
  ok(c.focus && /Wren's logged night feeds began at most 3h 20m apart \(over 5 nights\), less than the window's 4 hours, so a window that long will likely catch one\. One step to talk over: a shorter window, or Alex giving one feed in it \(a bottle is a question for their lactation consultant\)\.$/.test(plain(c.focus) as string), String(c.focus));
});

check("week labels: the morning after a week's last night its counts read 'Week 1 (ended last night)' while this week's step is week 2's; from noon, 'This week' is week 2", () => {
  const g = goalRow({ target_date: "2026-11-30", targets: [{ id: "a1", kind: "bassinet_nights", per_week: 3, min_minutes: 60 }], steps: [{ id: "s2", title: "Run the work-week roster", week_of: "2026-11-09", done_at: null, done_by: null }] });
  const morning = at(2026, 11, 9, 9, 30);
  // Three nights with a try (two short ones): enough to read the week, and one counted toward the aim.
  const tries = [tryRow(at(2026, 11, 3, 22), at(2026, 11, 4, 0), "stayed_asleep"), tryRow(at(2026, 11, 5, 22), at(2026, 11, 5, 22, 20), "woke_calm"), tryRow(at(2026, 11, 7, 22), at(2026, 11, 7, 22, 20), "woke_calm")];
  const p = goalProgress(g, data({ tries }), morning, NY);
  ok(weekEndedLastNight(p) && goalWeekLabel(p.weeks[p.weeks.length - 1], p) === "Week 1 (ended last night)", "the morning after");
  const lines = goalProgressLines(g, p, words(WREN, morning)).join("\n");
  ok(lines.includes("Week 1 (ended last night): 1 of the 3 nights aimed for (tries logged on 3 of 7 nights).") && !/This week:/.test(lines), lines);
  ok(coachNotes(g, p, words(WREN, morning)).notes.includes(`This week's step: "Run the work-week roster" (s2).`), "the step is week 2's");
  const noon = at(2026, 11, 9, 13);
  const q = goalProgress(g, data(), noon, NY);
  eq([weekEndedLastNight(q), q.weeks.map((w) => goalWeekLabel(w, q))], [false, ["Last week", "This week"]], "from noon");
});

check("urgency: active before paused, the nearest target date first (one already past leads), then a review due, then the newest", () => {
  const now = at(2026, 11, 20, 9);
  const g = (id: number, over: Partial<SleepGoal>) => goalRow({ id, ...over });
  const goals = [
    g(1, { target_date: "2026-12-20" }),
    g(2, { target_date: "2026-11-25" }),
    g(3, { target_date: "2026-11-18" }),
    g(4, { status: "paused", target_date: "2026-11-21" }),
    g(5, {}),
    g(6, { created_at: iso(at(2026, 11, 19, 9)) }),
  ];
  eq(goalsByUrgency(goals, now, NY).map((x) => x.id), [3, 2, 1, 5, 6, 4], "past date, nearest, later, review due (no date), newest (no date), paused");
});

check("check-in patterns: an early observation shows only with 5 nights or more on each side and a clear difference, from check-ins only", () => {
  const roster = [{ id: "w1", member: SAM, from: "22:00", to: "02:00", nights: EVERY }];
  const g = goalRow({ roster, targets: [{ id: "a1", kind: "protected_window", member: SAM, per_week: 4 }] });
  const nights = Array.from({ length: 10 }, (_, i) => `2026-11-${String(2 + i).padStart(2, "0")}`);
  // Alex gives a feed inside Sam's window on the first five nights; Sam gets the sleep on 4 of those, and on 1 of the other 5,
  // when Sam's own feed is logged inside it (a night "without" needs something logged inside the window).
  const entries = [
    ...nights.slice(0, 5).map((n) => ({ ...feedRow(at(2026, 11, Number(n.slice(8)), 23, 30), ALEX), data: { method: "bottle" } }) as Entry),
    ...nights.slice(5).map((n) => feedRow(at(2026, 11, Number(n.slice(8)), 23, 30), SAM)),
  ];
  const said: SleepCheckin["protected"][] = ["yes", "yes", "yes", "yes", "partly", "yes", "no", "partly", "no", "no"];
  const checkins = nights.map((n, i) => checkinRow(SAM, n, said[i]));
  const now = at(2026, 11, 12, 9);
  const p = goalProgress(g, data({ entries, checkins }), now, NY);
  eq(p.observations, [{ member: SAM, factor: "fed_by_other", with: { yes: 4, of: 5 }, without: { yes: 1, of: 5 } }], "fed by someone else");
  eq(observationWords(p.observations![0], nameOf), "Early observation (10 check-ins): Sam got the window's sleep on 4 of 5 nights when someone else logged a feed inside it, and on 1 of 5 nights without.", "words");
  ok(goalProgressLines(g, p, words(WREN, now)).includes(observationWords(p.observations![0], nameOf)), "in the lines");
  eq(goalProgress(g, data({ entries, checkins: checkins.slice(0, 9) }), now, NY).observations, [], "four nights on one side: none yet");
  eq(goalProgress(g, data({ entries, checkins: null }), now, NY).observations, null, "a view-only reader: none");
});

check("back to work: a coach note on drowsy driving when the adult back at work didn't get their window's sleep, and on more night nursing when the nursing parent went back", () => {
  const roster = [{ id: "w1", member: SAM, from: "02:00", to: "06:00", nights: [0, 1, 2, 3, 4] }];
  const g = goalRow({ roster, targets: [{ id: "a1", kind: "protected_window", member: SAM, per_week: 5 }], template: { kind: "back_to_work", member: SAM, date: "2026-11-09", nursing: SAM } });
  const now = at(2026, 11, 10, 8);
  const p = goalProgress(g, data({ checkins: [checkinRow(SAM, "2026-11-09", "partly")] }), now, NY);
  const notes = coachNotes(g, p, words(WREN, now)).notes;
  // In WORK_DROWSY_DRIVING's and WORK_NIGHT_NURSING's words, each cited by id with its sources.
  ok(
    notes.includes(
      `Sam said "partly" about last night's window and is back at work: mention drowsy driving gently, in Maple's sourced words (work-drowsy-driving: Malish, Arastu and O'Brien: A preliminary study of new parents, sleep disruption, and driving (Maternal and Child Health Journal, 2016); CDC NIOSH: Training for nurses on shift work and long work hours, module 11 (driving)): "In one small, early survey of 72 new parents, poor sleep quality went with a sixfold increase in near misses on the road. If you're very sleepy, plan how to avoid driving drowsy: a ride from family or a friend, or other transportation. A short nap first may still not keep you awake enough to drive safely."`
    ),
    JSON.stringify(notes)
  );
  ok(
    notes.includes(
      `Sam has been back at work since Mon, Nov 9. In Maple's sourced words (work-night-nursing: Office on Women's Health: Breastfeeding and going back to work): "When the nursing parent goes back to work, some babies eat less during the day and nurse more often at night, which is called reverse cycling. Others eat well during the day and still nurse more at night, maybe for the closeness." Read the check-ins and hints with that in mind, and offer to change the roster if it helps.`
    ),
    JSON.stringify(notes)
  );
  eq(citeWork(WORK_BOTTLES), "(work-bottles: Office on Women's Health: Breastfeeding and going back to work; Texas HHS, Breastmilk Counts (Texas WIC): Bottle feeding your baby)", "a citation names the item and its sources (round 4: OWH first)");
  const rested = coachNotes(g, goalProgress(g, data({ checkins: [checkinRow(SAM, "2026-11-09", "yes")] }), now, NY), words(WREN, now)).notes;
  ok(!rested.some((n) => /drowsy/.test(n)), "a yes: nothing about driving");
  const before = at(2026, 11, 6, 8);
  ok(!coachNotes(g, goalProgress(g, data({ checkins: [checkinRow(SAM, "2026-11-05", "no")] }), before, NY), words(WREN, before)).notes.some((n) => /drowsy|reverse cycling/.test(n)), "before the day back: neither");
});

check("roster nights: a week with none over yet says when the first one is (tonight, tomorrow night or its weekday), never '0 nights on the roster so far'", () => {
  const target = { id: "a1", kind: "protected_window" as const, member: SAM, per_week: 4 };
  // Set Monday at 9 AM; read at 10 AM, before any night of it is over.
  const now = at(2026, 11, 2, 10);
  const line = (nights: number[] | null) => {
    const g = goalRow({ targets: [target], roster: nights ? [{ id: "w1", member: SAM, from: "22:00", to: "02:00", nights }] : [] });
    return goalProgressLines(g, goalProgress(g, data(), now, NY), words(WREN, now)).find((l) => l.startsWith("Aim: Sam's"))!;
  };
  eq(line([0, 1, 2, 3, 4]), "Aim: Sam's protected sleep, 4 nights a week. This week: no check-ins yet; the first roster night is tonight.", "Mon is on the roster");
  // Nights are the evenings they begin on, 0 (Sun) to 6 (Sat): Nov 2 is a Monday.
  eq(line([3, 4]), "Aim: Sam's protected sleep, 4 nights a week. This week: no check-ins yet; the first roster night is Wed night.", "Wed and Thu");
  eq(line([3, 4]).includes("0 nights"), false, "never 0 nights");
  ok(line([2]).endsWith("is tomorrow night.") && line([1, 2]).endsWith("is tonight.") && line([4]).endsWith("is Thu night."), "by the night");
  eq(line([3]).replace("Wed night", "x"), line([4]).replace("Thu night", "x"), "the same words otherwise");
  eq(line(null), "Aim: Sam's protected sleep, 4 nights a week. This week: no check-ins yet; no window on the roster yet.", "no window at all");
  // The next morning: Monday night is over, so it's counted as a roster night, as before.
  const g = goalRow({ targets: [target], roster: [{ id: "w1", member: SAM, from: "22:00", to: "02:00", nights: [0, 1, 2, 3, 4] }] });
  const tue = at(2026, 11, 3, 10);
  ok(goalProgressLines(g, goalProgress(g, data(), tue, NY), words(WREN, tue)).some((l) => l.endsWith("This week: no check-ins yet; 1 night on the roster so far.")), "one over");
  eq(noCheckinWords({ planned: 0, nextNight: "2026-11-03" }, { ongoing: true, today: "2026-11-02", hasWindow: true }), "the first roster night is tomorrow night", "tomorrow");
  eq(noCheckinWords({ planned: 0, nextNight: null }, { ongoing: false, today: "2026-11-02", hasWindow: true }), "no roster nights that week", "a week that's over");
});

check("next handoff vs the roster: never inside the next holder's protected window (at its end, or none past 12 hours), only active goals, only their windows", () => {
  // Coach round 2, n12: Theo sleeps 1:30–6:30 AM every night; Noor took over at 12:24 AM from a 4-hour turn, so the default is 4:24 AM.
  const THEO = "theo@example.test";
  const NOOR = "noor@example.test";
  const every = [0, 1, 2, 3, 4, 5, 6];
  const goal = (roster: { member: string; from: string; to: string }[], status: "active" | "paused" = "active") => ({ status, roster: roster.map((w, i) => ({ id: `w${i}`, nights: every, ...w })) });
  const roster = [goal([{ member: NOOR, from: "21:30", to: "01:30" }, { member: THEO, from: "01:30", to: "06:30" }])];
  const from = at(2026, 10, 15, 0, 24).getTime();
  const def = at(2026, 10, 15, 4, 24).getTime();
  const r = handoffAroundRoster({ at: def, from, nextHolder: THEO, goals: roster, tz: NY });
  eq([iso(r.at!), r.why?.member, r.why?.planned_at, r.why?.default_at, r.why?.starts_at], [iso(at(2026, 10, 15, 6, 30)), THEO, iso(at(2026, 10, 15, 6, 30)), iso(def), iso(at(2026, 10, 15, 1, 30))], "at the end of Theo's window");
  eq(handoffWhyWords(r.why!, "Theo", NY), "after Theo's protected sleep (1:30–6:30 AM)", "why, in a phone's words");
  eq(windowAt(roster, THEO, def, NY)?.end, at(2026, 10, 15, 6, 30).getTime(), "the window it fell in");
  // n8: Noor accepted at 1:30 AM, the default 5:30 AM: the same.
  eq(iso(handoffAroundRoster({ at: at(2026, 10, 16, 5, 30).getTime(), from: at(2026, 10, 16, 1, 30).getTime(), nextHolder: THEO, goals: roster, tz: NY }).at!), iso(at(2026, 10, 16, 6, 30)), "n8 too");
  // Outside the window, to someone else's window, a paused goal's, or nobody next: the default stands, with no why.
  for (const [label, o] of [
    ["outside it", { at: at(2026, 10, 15, 7, 0).getTime(), nextHolder: THEO, goals: roster }],
    ["another adult's window", { at: def, nextHolder: NOOR, goals: roster }],
    ["a paused goal", { at: def, nextHolder: THEO, goals: [goal([{ member: THEO, from: "01:30", to: "06:30" }], "paused")] }],
    ["nobody next", { at: def, nextHolder: null, goals: roster }],
  ] as const) {
    const x = handoffAroundRoster({ from, tz: NY, ...o });
    eq([x.at, x.why], [o.at, null], label);
  }
  // At the window's start it's inside (they'd be woken as their sleep begins); at its end it isn't.
  eq(handoffAroundRoster({ at: at(2026, 10, 15, 1, 30).getTime(), from, nextHolder: THEO, goals: roster, tz: NY }).why?.member, THEO, "at its start");
  eq(handoffAroundRoster({ at: at(2026, 10, 15, 6, 30).getTime(), from, nextHolder: THEO, goals: roster, tz: NY }).why, null, "at its end");
  // Windows back to back count as one: the end of the last.
  const two = [goal([{ member: THEO, from: "01:30", to: "04:00" }]), goal([{ member: THEO, from: "04:00", to: "07:15" }])];
  eq(iso(handoffAroundRoster({ at: def, from, nextHolder: THEO, goals: two, tz: NY }).at!), iso(at(2026, 10, 15, 7, 15)), "back to back");
  // An evening window that crosses midnight, seen from the evening (as a try day: the night it began).
  const late = [goal([{ member: THEO, from: "22:00", to: "05:00" }])];
  eq(iso(handoffAroundRoster({ at: at(2026, 10, 14, 23, 30).getTime(), from: at(2026, 10, 14, 21, 30).getTime(), nextHolder: THEO, goals: late, tz: NY }).at!), iso(at(2026, 10, 15, 5, 0)), "across midnight");
  // A window's end more than 12 hours after the handoff: none planned, and why.
  const long = [goal([{ member: THEO, from: "13:00", to: "01:00" }])];
  const none = handoffAroundRoster({ at: at(2026, 10, 14, 13, 30).getTime(), from: at(2026, 10, 14, 12, 50).getTime(), nextHolder: THEO, goals: long, tz: NY });
  eq([none.at, none.why?.planned_at, handoffWhyWords(none.why!, "your", NY)], [null, null, "none planned: your protected sleep (1:00 PM–1:00 AM) runs past 12 hours from now"], "none past 12 hours");
  // Across the clocks going back (Sat night Oct 31 into Sun Nov 1, New York): the window ends at 6:30 AM on the clock.
  const dst = handoffAroundRoster({ at: at(2026, 11, 1, 3, 0).getTime(), from: at(2026, 11, 1, 0, 30).getTime(), nextHolder: THEO, goals: roster, tz: NY });
  eq(iso(dst.at!), iso(at(2026, 11, 1, 6, 30)), "6:30 AM on the clock, the night the clocks go back");
});

// ── round 3: light logging, a clean restart, the weekly look-back, and the coach and app re-tests ─────────────────

/** Neutral words for a thin week: never blame. */
const BLAME = /\b(judge|judged|fail(ed|s)?|miss(ed|es)?|behind|overdue|streak|score|grade)\b/i;

check("light logging: three nights read a week (ENOUGH_NIGHTS, Maple's own rule); below it each target says too few to tell, in neutral words, and the coach suggests no next step or stage change", () => {
  eq(ENOUGH_NIGHTS, 3, "three nights");
  eq(SUGGEST.minNights, ENOUGH_NIGHTS, "the stage suggestion needs as many logged nights in its window");
  eq([tooFewWords(2, { ongoing: true }), tooFewWords(1, { ongoing: false }), tooFewWords(0, { ongoing: false }), tooFewWords(2, { ongoing: false, what: "check-in" })], ["2 nights logged so far, too few to tell yet", "1 night logged, too few to tell", "no nights logged, too few to tell", "2 check-ins, too few to tell"], "the words");
  const g = goalRow({
    targets: [{ id: "a1", kind: "bassinet_nights", per_week: 3, min_minutes: 60 }, { id: "a2", kind: "protected_window", member: SAM, per_week: 4 }],
    roster: [{ id: "w3", member: SAM, from: "22:00", to: "02:00", nights: EVERY }],
  });
  const now = at(2026, 11, 9, 10);
  const long = (d: number) => tryRow(at(2026, 11, d, 22), at(2026, 11, d, 23, 30), "stayed_asleep");
  const two = data({ tries: [long(2), long(4)], checkins: [checkinRow(SAM, "2026-11-02", "yes"), checkinRow(SAM, "2026-11-03", "yes")] });
  const p = goalProgress(g, two, now, NY);
  eq([p.coverage[0].read, weekEnough(g, p.coverage[0]), readWeek(p)?.w.n], [2, false, 1], "two nights logged: not enough to read");
  const lines = goalProgressLines(g, p, words(WREN, now)).join("\n");
  ok(lines.includes("Week 1 (ended last night): 2 nights logged, too few to tell.") && !/aimed for/.test(lines), lines);
  // The window's own sample is Sam's check-ins: two of them, the sample first.
  ok(lines.includes("Week 1 (ended last night): checked in on 2 of 7 roster nights, too few to tell."), lines);
  ok(!BLAME.test(lines), lines);
  const c = coachNotes(g, p, words(WREN, now));
  ok(c.notes.includes(`Too few nights to read yet: week 1 (ended last night) has 2 of its 7 nights logged or answered in the morning. Suggest no next step and no stage change, and keep this week's step as it is. ${ENOUGH_NIGHTS_LINE}`), JSON.stringify(c.notes));
  ok(!c.notes.some((n) => /No weekly steps yet|End the review with one small step|ask whether to plan the next one/.test(n)), JSON.stringify(c.notes));
  // A third logged night: the week reads, against the aim, and the coach may suggest a step again.
  const three = goalProgress(g, data({ tries: [long(2), long(4), long(6)] }), now, NY);
  ok(goalProgressLines(g, three, words(WREN, now)).join("\n").includes("Week 1 (ended last night): 3 of the 3 nights aimed for (tries logged on 3 of 7 nights)."), "three nights read");
  ok(coachNotes(g, three, words(WREN, now)).notes.includes("No weekly steps yet: suggest one small step for this week."), "a step may be suggested");
  // Nothing logged at night, but the morning card answered every night (where she slept): the morning check-in is plenty.
  const answered = data({ checkins: ["02", "03", "04", "05", "06", "07", "08"].map((d) => checkinRow(SAM, `2026-11-${d}`, "yes", { place: "bassinet" })) });
  const q = goalProgress(g, answered, now, NY);
  eq([q.coverage[0].logged + q.coverage[0].partly, q.coverage[0].read, weekEnough(g, q.coverage[0])], [0, 7, true], "seven nights answered in the morning read the week");
  // The plan's stage suggestion: four try days, one of them tonight's (its night not over), still three logged nights.
  const tries = week(at(2026, 10, 28, 15), [
    [3, 22, "stayed_asleep", 60],
    [2, 22, "stayed_asleep", 45],
    [1, 22, "stayed_asleep", 90],
    [1, 23, "woke_calm", 10],
  ]);
  const tonight = tryRow(at(2026, 10, 28, 13, 30), at(2026, 10, 28, 14, 30), "stayed_asleep");
  const s = stageSuggestion(plan(), [...tries, tonight], at(2026, 10, 28, 15), NY);
  eq(s && [s.days, s.nights], [4, 3], "4 try days, 3 of their nights over");
});

check("quiet stretch: an empty night has nothing logged and no check-in; 7 in a row is said once with no tally, and the coach asks how they are before anything else", () => {
  eq(QUIET_NIGHTS, 7, "seven nights");
  eq([emptyNight({ log: "none", checkedIn: false }), emptyNight({ log: "none", checkedIn: true }), emptyNight({ log: "partly", checkedIn: false }), emptyNight({ log: "none", checkedIn: null })], [true, false, false, true], "empty: not logged, and no check-in");
  const g = goalRow({ target_date: "2026-11-30", targets: [{ id: "a1", kind: "bassinet_nights", per_week: 3, min_minutes: 60 }], steps: [{ id: "s2", title: "Bassinet after the 10 PM feed", week_of: "2026-11-02", done_at: null, done_by: null }], roster: [{ id: "w3", member: SAM, from: "22:00", to: "02:00", nights: EVERY }] });
  const now = at(2026, 11, 11, 10);
  // Feeds on Mon and Tue nights, then nothing from Wed night through last night (Tue, Nov 10): seven empty nights.
  const busy = data({ entries: lateFeeds("2026-11-02", "2026-11-03") });
  const p = goalProgress(g, busy, now, NY);
  eq(p.quiet, { from: "2026-11-04", to: "2026-11-10", nights: 7, going: true, before: false }, "the stretch");
  eq(quietWords(p.quiet!, p.today), "Nothing logged since Wed, Nov 4", "said once, plainly");
  const c = coachNotes(g, p, words(WREN, now));
  eq(c.notes.length, 1, `one note: ${JSON.stringify(c.notes)}`);
  ok(/^Nothing logged since Wed, Nov 4\. Before anything about the goal, ask how they're doing\. Don't ask about those nights or count them\./.test(c.notes[0]) && /counts_from "tonight"/.test(c.notes[0]) && /paused_until "in 1 week"/.test(c.notes[0]), c.notes[0]);
  const lines = goalProgressLines(g, p, words(WREN, now)).join("\n");
  ok(lines.includes("Nothing logged since Wed, Nov 4.") && !/too few|Logged:|of the last|nights? logged/.test(lines), `no tally of the nights: ${lines}`);
  // A check-in on one of them breaks the run; most of the week still empty, so how they are comes first.
  const broken = goalProgress(g, data({ entries: lateFeeds("2026-11-02", "2026-11-03"), checkins: [checkinRow(SAM, "2026-11-07", "yes")] }), now, NY);
  eq(broken.quiet, null, "a check-in breaks it");
  eq(HOW_ARE_YOU_NIGHTS, 5, "five of the last seven");
  ok(/^Nothing logged on 6 of the last 7 nights: before anything about the goal, ask how they're doing\./.test(coachNotes(g, broken, words(WREN, now)).notes[0]), "how they are, first");
  // A view-only reader can't tell a night with only a check-in in it: never a quiet stretch.
  eq(goalProgress(g, data({ ...busy, checkins: null }), now, NY).quiet, null, "none for a view-only reader");
  // Past the target date there's no restart to offer.
  eq(quietNow(goalProgress(g, busy, at(2026, 12, 3, 10), NY)), null, "past its target date");
  // Across the clocks going back (Sun, Nov 1): seven nights, each counted once.
  const fall = goalRow({ created_at: iso(at(2026, 10, 26, 9)), target_date: "2026-11-30" });
  const f = goalProgress(fall, data({ entries: lateFeeds("2026-10-26", "2026-10-27") }), at(2026, 11, 4, 10), NY);
  eq(f.quiet, { from: "2026-10-28", to: "2026-11-03", nights: 7, going: true, before: false }, "across the clock change");
  eq([nightsRange("2026-10-20", "2026-10-27", "2026-11-02"), nightsRange("2026-10-28", "2026-11-03", "2026-11-02"), nightsRange("2026-12-28", "2027-01-03", "2026-11-02"), nightsRange("2025-10-20", "2025-10-27", "2026-11-02")], ["Oct 20–27", "Oct 28–Nov 3", "Dec 28, 2026–Jan 3, 2027", "Oct 20–27, 2025"], "a run of nights in words");
});

check("a clean restart: picking up again (counts_from) and easing off (paused_until) are checked like any goal edit; weeks count from them, and easing off reads as that, never as missed", () => {
  const g = goalRow({ target_date: "2026-11-30", targets: [{ id: "a1", kind: "bassinet_nights", per_week: 3, min_minutes: 60 }], steps: [{ id: "s2", title: "Bassinet after the 10 PM feed", week_of: "2026-11-02", done_at: null, done_by: null }] });
  const rules = (today: string): GoalRules => ({ ...RULES, today, current: g, seq: 2 });
  eq(cleanGoalInput({ counts_from: "2026-11-12" }, rules("2026-11-12"), "update").fields, { counts_from: "2026-11-12" }, "pick up from tonight");
  throwsInput(() => cleanGoalInput({ counts_from: "2026-11-13" }, rules("2026-11-12"), "update"), /^Counting can start again from tonight at the latest\.$/, "not ahead");
  throwsInput(() => cleanGoalInput({ counts_from: "2026-12-01" }, rules("2026-12-01"), "update"), /after the target date/, "not after the target date");
  throwsInput(() => cleanGoalInput({ title: "Nights", counts_from: "2026-11-02" }, RULES, "create"), /^A new goal counts from the night it's set/, "a new goal");
  throwsInput(() => cleanGoalInput({ paused_until: "2026-12-11" }, rules("2026-11-12"), "update"), new RegExp(`up to ${EASE_OFF_MAX_DAYS / 7} weeks`), "easing off at most four weeks");
  eq(cleanGoalInput({ paused_until: null, counts_from: "" }, rules("2026-11-12"), "update").fields, { counts_from: null, paused_until: null }, "cleared");
  // Picked up again on Thu, Nov 12: its weeks count from that night, and the head line says since when.
  const picked = { ...g, counts_from: "2026-11-12" };
  const s = goalSpan(picked, at(2026, 11, 13, 10), NY);
  eq([s.startsOn, s.setOn, s.weekNow, s.weeksTotal, s.weeks[0].from, s.easingUntil], ["2026-11-12", "2026-11-02", 1, 3, "2026-11-12", null], "weeks from the night it was picked up");
  ok(goalHeadLine(picked, s, { tz: NY }).endsWith("Counting since Thu, Nov 12 (set Mon, Nov 2): the nights before it don't count."), goalHeadLine(picked, s, { tz: NY }));
  // Easing off until Thu, Nov 19: nothing counted, no week named, the steps and targets as they are, no review due.
  const eased = { ...g, paused_until: "2026-11-19" };
  const now = at(2026, 11, 12, 10);
  const e = goalProgress(eased, data({ tries: [tryRow(at(2026, 11, 2, 22), at(2026, 11, 2, 23, 30), "stayed_asleep")] }), now, NY);
  eq(e.easingUntil, "2026-11-19", "easing off");
  const head = goalHeadLine(eased, e, { tz: NY });
  ok(head.includes("Easing off until Thu, Nov 19, as the family chose: nothing is counted until then, and the steps and targets hold.") && !/week \d/.test(head), head);
  const lines = goalProgressLines(eased, e, words(WREN, now)).join("\n");
  ok(lines.includes("Easing off until Thu, Nov 19: nothing is counted until then.") && !/aimed for|too few|Logged:/.test(lines) && !BLAME.test(lines), lines);
  const c = coachNotes(eased, e, words(WREN, now));
  eq([c.notes.length, c.reviewDue, reviewIsDue(eased, e, NY)], [1, false, false], `one note, no review due: ${JSON.stringify(c.notes)}`);
  // Back from easing off: counting from that night, a fresh week 1.
  const back = goalSpan(eased, at(2026, 11, 20, 10), NY);
  eq([back.easingUntil, back.startsOn, back.weekNow], [null, "2026-11-19", 1], "counting again");
  eq([tonightKey(at(2026, 11, 12, 3), NY), tonightKey(at(2026, 11, 12, 7), NY), tonightKey(at(2026, 11, 12, 21), NY)], ["2026-11-11", "2026-11-12", "2026-11-12"], "tonight: the night still going before 6 AM");
  eq(goalStartKey({ ...g, counts_from: "2026-11-05", paused_until: "2026-11-04", template: { kind: "back_to_work", member: SAM, date: "2026-11-30", nursing: null, roster_from: "2026-11-16" } }, NY), "2026-11-16", "the latest of them all");
  // Picked up on the Saturday before the clocks go back: a week of seven nights, each counted once.
  const dst = goalSpan({ ...g, created_at: iso(at(2026, 10, 20, 9)), counts_from: "2026-10-31" }, at(2026, 11, 7, 10), NY);
  eq([dst.weeks[0].from, dst.weeks[0].to, dst.weeks[0].nights], ["2026-10-31", "2026-11-06", 7], "across the clock change");
  // Its review falls due a week after counting starts again, not a week after it was set.
  eq([reviewIsDue(picked, goalSpan(picked, at(2026, 11, 18, 10), NY), NY), reviewIsDue(picked, goalSpan(picked, at(2026, 11, 19, 10), NY), NY)], [false, true], "a week after picking up");
});

check("the weekly look-back: on a review day, each target with what it's out of, the step and each adult's check-ins; Next step waits for three nights read", () => {
  const steps = [
    { id: "s4", title: "Bassinet after the 10 PM feed", week_of: "2026-11-02", done_at: null, done_by: null },
    { id: "s5", title: "White noise on for every try", week_of: "2026-11-09", done_at: null, done_by: null },
  ];
  const g = goalRow({
    target_date: "2026-11-30",
    targets: [{ id: "a1", kind: "bassinet_nights", per_week: 3, min_minutes: 60 }, { id: "a2", kind: "protected_window", member: SAM, per_week: 4 }, { id: "a3", kind: "custom", text: "Calmer bedtimes" }],
    steps,
    roster: [{ id: "w6", member: SAM, from: "22:00", to: "02:00", nights: EVERY }],
  });
  const t = (d: number, min: number, outcome: TryOutcome = "stayed_asleep") => tryRow(at(2026, 11, d, 22), at(2026, 11, d, 22, min), outcome);
  // Four nights with a try (two of an hour or more), and Sam's check-ins on five.
  const log = data({ tries: [t(2, 90), t(3, 30), t(5, 75), t(6, 20, "woke_calm")], checkins: [2, 3, 4, 5, 6].map((d) => checkinRow(SAM, `2026-11-0${d}`, d === 6 ? "partly" : "yes")) });
  const day = at(2026, 11, 9, 8);
  const span = goalSpan(g, day, NY);
  eq(reviewWeek(g, span, day, NY)?.n, 1, "the day after week 1's last night");
  eq(reviewWeek(g, goalSpan(g, at(2026, 11, 10, 8), NY), at(2026, 11, 10, 8), NY), null, "only that day: never overdue");
  eq(reviewWeek({ ...g, last_review_at: iso(at(2026, 11, 8, 20)) }, span, day, NY), null, "reviewed already");
  eq(reviewWeek({ ...g, steps: [] }, span, day, NY), null, "a goal with no steps");
  eq(reviewWeek({ ...g, paused_until: "2026-11-12" }, goalSpan({ ...g, paused_until: "2026-11-12" }, day, NY), day, NY), null, "easing off");
  const p = goalProgress(g, log, day, NY);
  const lb = lookBack(g, p, span.weeks[0], { name: nameOf });
  eq(lb.title, "Week 1 look-back", "title");
  eq(lb.targets.map((x) => [x.label, x.line]), [
    ["Bassinet nights", "2 of the 3 aimed for · 4 nights logged"],
    ["Sam's protected sleep", "yes on 4 of the 4 aimed for"],
    ["Calmer bedtimes", "not counted from the log"],
  ], "each with what it's out of");
  eq(lb.checkins, [{ member: SAM, line: "5 of 7 nights" }], "Sam's check-ins");
  eq([lb.enough, lb.step.current?.id, lb.step.following?.id, lb.step.bringTo, lb.prompt], [true, "s4", "s5", null, "Week 1 look-back: what's a good next step?"], "the step, and the one Next step moves to");
  ok(!BLAME.test(JSON.stringify(lb)), JSON.stringify(lb));
  // The next step planned for a later week is brought into this one.
  eq(lookBackStep([steps[0], { ...steps[1], week_of: "2026-11-23" }], span).bringTo, "2026-11-09", "brought into this week");
  // A view-only reader: no check-ins.
  eq(lookBack(g, goalProgress(g, { ...log, checkins: null }, day, NY), span.weeks[0], { name: nameOf }).checkins, null, "no check-ins for a view-only reader");
  // Two nights read: too few to tell, and Next step waits.
  const thin = lookBack(g, goalProgress(g, data({ tries: [t(2, 90), t(3, 30)] }), day, NY), span.weeks[0], { name: nameOf });
  eq([thin.enough, thin.targets[0].line], [false, "2 nights logged, too few to tell"], "too few");
});

check("back to work timing (coach P1 #3): a step with no time left is left out, a day back up to two weeks past is planned for, and the roster, check-ins and counts start with its rehearsal", () => {
  const o = { v: WREN, name: nameOf, today: "2026-11-02", adults: new Set([SAM, ALEX]) };
  const base: BackToWorkAnswers = { returning: SAM, return_date: "2026-11-30", feeding: "nursing", nursing: ALEX, sleeps: "bassinet", first_half: SAM, second_half: ALEX, off_duty: "other_room" };
  const at0 = backToWorkGoal({ ...base, return_date: "2026-11-02" }, o);
  eq(at0.goal.steps, [], "back today: nothing left to do before it");
  ok(at0.notes[0] === "Sam is back today, so the night feeds' step, the rehearsal and the short first week are left out, with no time for them before the day back.", at0.notes[0]);
  const at1 = backToWorkGoal({ ...base, return_date: "2026-11-03" }, o);
  eq(at1.goal.steps!.map((x) => x.week_of), ["2026-11-02"], "back tomorrow: the night feeds' step only");
  ok(at1.notes[0] === "Sam is back tomorrow, so the rehearsal and the short first week are left out, with no time for them before the day back, and the other step starts this week.", at1.notes[0]);
  eq(backToWorkGoal({ ...base, return_date: "2026-11-04" }, o).goal.steps!.length, 2, "in two days: the rehearsal too");
  // A Wednesday day back: the short first week is already one.
  eq(backToWorkGoal({ ...base, return_date: "2026-11-11" }, o).goal.steps![2].title, "Plan a short first week back (it starts on a Wednesday)", "a Wednesday start");
  // Back ten days ago: planned for, with no steps for before it, a week of nights at least, counting from tonight.
  const past = backToWorkGoal({ ...base, return_date: "2026-10-23" }, o);
  eq([past.goal.steps, past.goal.target_date, past.goal.template?.roster_from], [[], "2026-11-08", "2026-11-02"], "a day back past");
  ok(past.notes[0].startsWith("Sam has been back since Fri, Oct 23, so the night feeds' step, the rehearsal and the short first week are left out"), past.notes[0]);
  throwsInput(() => backToWorkGoal({ ...base, return_date: "2026-10-18" }, o), /more than two weeks ago/, "over two weeks past");
  // Four weeks out: the roster starts with its rehearsal two weeks before the day back.
  const ahead = backToWorkGoal(base, o);
  ok(ahead.notes.includes("The roster starts on Mon, Nov 16, two weeks before the day back, with its rehearsal: the morning check-ins and the counts begin then."), JSON.stringify(ahead.notes));
  const { fields } = cleanGoalInput(ahead.goal, { ...RULES, v: WREN }, "create");
  const g = goalRow({ ...fields, steps: fields.steps!, roster: fields.roster!, targets: fields.targets!, template: fields.template ?? null });
  eq(goalStartKey(g, NY), "2026-11-16", "counting starts with the roster");
  const now = at(2026, 11, 9, 10);
  const p = goalProgress(g, data({ checkins: [] }), now, NY);
  const c = coachNotes(g, p, words(WREN, now));
  eq(c.notCheckedIn, [], "nobody owes a check-in before the roster starts");
  ok(c.notes.includes("Counting starts Mon, Nov 16, with the roster (its rehearsal, two weeks before the day back): no check-ins or counts before then.") && !c.notes.some((n) => /Too few nights|Not checked in/.test(n)), JSON.stringify(c.notes));
  eq(stepsByWeek(g.steps, p).thisWeek.map((x) => x.title), ["Plan the night feeds: whoever's on duty brings her to Alex to nurse, then settles her"], "the night feeds' step is this week's");
  throwsInput(() => cleanGoalInput({ title: "Back", template: { kind: "back_to_work", member: SAM, date: "2026-11-30", nursing: null, roster_from: "2026-12-01" } }, { ...RULES, v: WREN }, "create"), /^The roster starts between two weeks ago and the day back at work\.$/, "a roster start after the day back");
  throwsInput(() => cleanGoalInput({ title: "Back", template: { kind: "back_to_work", member: SAM, date: "2026-11-30", nursing: null, feeding: "formula" as "bottles" } }, { ...RULES, v: WREN }, "create"), /^How the baby is fed must be one of nursing, bottles, both\.$/, "a feeding it doesn't know");
  eq(cleanGoalInput({ title: "Back", template: { kind: "back_to_work", member: SAM, date: "2026-10-25", nursing: null } }, { ...RULES, v: WREN }, "create").fields.template?.date, "2026-10-25", "a day back last week is kept");
});

check("feeds wording (coach P1 #4, P2 #13): each window's feeds from how they're covered; a bottle never before about 4 weeks old (OWH, Texas HHS), dated, with its source; never 'bring her to nurse' for bottles only", () => {
  const o = { v: WREN, name: nameOf, today: "2026-11-02", adults: new Set([SAM, ALEX]) };
  const both = backToWorkGoal({ returning: ALEX, return_date: "2026-11-30", feeding: "both", nursing: ALEX, sleeps: "bassinet", first_half: ALEX, second_half: SAM, off_duty: "other_room" }, o);
  ok(both.notes.includes("The adult who's off sleeps in another room. Night feeds: in Sam's window, Alex nurses her; in Alex's window, Sam gives her a bottle of expressed milk."), JSON.stringify(both.notes));
  eq(both.goal.template?.feeding, "both", "how she's fed, kept");
  const bottles = backToWorkGoal({ returning: SAM, return_date: "2026-11-30", feeding: "bottles", nursing: null, sleeps: "crib", first_half: SAM, second_half: ALEX, off_duty: "same_room" }, o);
  ok(bottles.notes.some((n) => n.endsWith("Night feeds: in Alex's window, Sam gives her a bottle; in Sam's window, Alex gives her a bottle.")) && !bottles.notes.some((n) => /to nurse/.test(n)), JSON.stringify(bottles.notes));
  const w = (covers: RosterWindow["covers"] | undefined, to = "02:00"): RosterWindow => ({ id: "w1", member: SAM, from: "21:00", to, nights: EVERY, ...(covers ? { covers } : {}) });
  // Ten days old, the nursing parent back in 18 days: the bottle still waits until about 4 weeks old (round 4: OWH's "at least a month"), and a day back sooner is a question for their clinicians.
  const soon = goalCautions({ roster: [w("bottle")], template: { kind: "back_to_work", member: ALEX, date: "2026-11-20", nursing: ALEX } }, { v: WREN, name: nameOf, ageDays: 10, today: "2026-11-02" })[0];
  eq(plain(soon.text), "A bottle in Sam's window (9:00 PM–2:00 AM): If Wren nurses, a bottle of expressed milk usually waits until about 4 weeks old. For this plan, that's Fri, Nov 20. If the nursing parent goes back to work or school before then, ask her pediatrician or lactation consultant first. Until then, whoever's on duty can bring her to nurse and settle her after.", "WORK_BOTTLES's words, dated by 4 weeks old");
  eq([soon.source, soon.guide], [BOTTLE_SOURCE, WORK_BOTTLES], "its source, and the item it cites");
  eq(BOTTLE_SOURCE, { title: workGuide(WORK_BOTTLES)!.sources[0].label, url: workGuide(WORK_BOTTLES)!.sources[0].url }, "the item's own source");
  ok(BOTTLE_SOURCE.url.startsWith("https://womenshealth.gov/"), "the Office on Women's Health (round 4)");
  const now = goalCautions({ roster: [w("bottle")], template: { kind: "back_to_work", member: ALEX, date: "2026-11-10", nursing: ALEX } }, { v: WREN, name: nameOf, ageDays: 10, today: "2026-11-02" })[0];
  ok(plain(now.text)!.toString().includes("For this plan, that's Fri, Nov 20.") && !/that's now/.test(now.text), now.text);
  // The other adult going back: the nursing parent stays home, so only 4 weeks old dates it.
  const other = goalCautions({ roster: [w("bottle")], template: { kind: "back_to_work", member: SAM, date: "2026-11-10", nursing: ALEX } }, { v: WREN, name: nameOf, ageDays: 10, today: "2026-11-02" })[0];
  ok(plain(other.text)!.toString().includes("For this plan, that's Fri, Nov 20."), other.text);
  // On bottles only: a long window says who gives a bottle, never "bring her to nurse".
  const young = goalCautions({ roster: [w("none", "02:30")], template: { kind: "back_to_work", member: SAM, date: "2026-11-30", nursing: null } }, { v: WREN, name: nameOf, ageDays: 10 })[0];
  ok(young.kind === "long_window" && young.text.includes("whoever's on duty can give her a bottle in it.") && !/nurse/.test(young.text), young.text);
  const older = goalCautions({ roster: [w("none", "03:00")], template: { kind: "back_to_work", member: SAM, date: "2026-11-30", nursing: null } }, { v: WREN, name: nameOf, ageDays: 60 })[0];
  ok(older.text.endsWith("say who gives her a bottle then.") && !/nurse/.test(older.text), older.text);
});

check("roster nights, patterns, the focus and known nights (coach P1 #7, #8, P2 #10, #14): check-ins count only on roster nights, a 'without' night needs something logged, the focus reads how feeds are covered, and a check-in alone isn't a bassinet night", () => {
  // Sam's window is on Sun–Thu nights; Sam checks in all seven mornings of week 1: "5 of 5", never "7 of 5".
  const g = goalRow({ targets: [{ id: "a1", kind: "protected_window", member: SAM, per_week: 4 }], roster: [{ id: "w2", member: SAM, from: "22:00", to: "02:00", nights: [0, 1, 2, 3, 4] }] });
  const all = ["02", "03", "04", "05", "06", "07", "08"].map((d) => checkinRow(SAM, `2026-11-${d}`, "yes"));
  const p = goalProgress(g, data({ checkins: all, entries: lateFeeds("2026-11-02", "2026-11-03", "2026-11-04") }), at(2026, 11, 9, 10), NY);
  const tp = p.targets[0];
  eq(tp.kind === "protected_window" && [tp.weeks![0].checkedIn, tp.weeks![0].planned], [5, 5], "roster nights only");
  eq(p.checkins?.find((x) => x.member === SAM)?.nights, 5, "and in the per-adult counts");
  ok(goalProgressLines(g, p, words(WREN, at(2026, 11, 9, 10))).join("\n").includes("checked in on 5 of 5 roster nights"), "5 of 5");
  // Saturday morning: Friday night's window was off, so nobody owes a check-in for it.
  eq(owedCheckins(g, "2026-11-06"), [], "a night the window was off");
  const sat = at(2026, 11, 7, 9);
  eq(coachNotes(g, goalProgress(g, data({ checkins: [] }), sat, NY), words(WREN, sat)).notCheckedIn, [], "never named for a night off");
  // The pattern's "without" side: nothing logged on those nights is unknown, so no observation (obs3 A).
  const every = goalRow({ targets: [{ id: "a1", kind: "protected_window", member: SAM, per_week: 4 }], roster: [{ id: "w1", member: SAM, from: "22:00", to: "02:00", nights: EVERY }] });
  const nights = Array.from({ length: 10 }, (_, i) => `2026-11-${String(2 + i).padStart(2, "0")}`);
  const bottles = nights.slice(0, 5).map((n) => ({ ...feedRow(at(2026, 11, Number(n.slice(8)), 23, 30), ALEX), data: { method: "bottle" } }) as Entry);
  const said = nights.map((n, i) => checkinRow(SAM, n, i < 5 ? "yes" : "no"));
  eq(goalProgress(every, data({ entries: bottles, checkins: said }), at(2026, 11, 12, 9), NY).observations, [], "nothing logged on the 'without' nights: no pattern");
  // The focus: Sam logs a feed inside Sam's own window on 4 nights.
  const own = ["02", "03", "04", "05"].map((d) => feedRow(at(2026, 11, Number(d), 23, 40), SAM));
  const focusFor = (covers?: RosterWindow["covers"]) => {
    const fg = goalRow({ roster: [{ id: "w1", member: SAM, from: "22:00", to: "02:00", nights: EVERY, ...(covers ? { covers } : {}) }, { id: "w2", member: ALEX, from: "02:00", to: "06:00", nights: EVERY }] });
    return coachNotes(fg, goalProgress(fg, data({ entries: own }), at(2026, 11, 6, 10), NY), words(WREN, at(2026, 11, 6, 10))).focus;
  };
  eq(focusFor("nurse"), null, "nursing planned in it: nothing to talk over");
  ok(/The roster has Alex giving a bottle then: ask gently what got in the way, with no blame\./.test(focusFor("bottle") ?? ""), String(focusFor("bottle")));
  ok(/One step to talk over: start Sam's window after that feed, or have Alex settle Wren then\./.test(focusFor() ?? ""), String(focusFor()));
  // A check-in alone says nothing about the bassinet; an answer about her night does (obs3 G).
  const bassinet = goalRow({ targets: [{ id: "a1", kind: "bassinet_nights", per_week: 3, min_minutes: 60 }] });
  const known = (more: Partial<SleepCheckin>) => {
    const q = goalProgress(bassinet, data({ checkins: all.map((c) => ({ ...c, ...more })) }), at(2026, 11, 9, 10), NY).targets[0];
    return q.kind === "bassinet_nights" ? q.weeks[0].known : -1;
  };
  eq([known({}), known({ place: "held" })], [0, 7], "known by an answer about her night, not a check-in alone");
});

check("steps carry on (coach P2 #11): an open step carries into a week with none planned; once the day back has come, the steps for before it are asked about once, never carried", () => {
  const steps = [
    { id: "s1", title: "Ask the lactation consultant about a pumped bottle", week_of: "2026-11-02", done_at: null, done_by: null },
    { id: "s2", title: "Rehearse the work-week roster on 2 or 3 nights", week_of: "2026-11-09", done_at: null, done_by: null },
  ];
  const g = goalRow({ target_date: "2026-11-30", steps, roster: [{ id: "w3", member: SAM, from: "22:00", to: "02:00", nights: EVERY }], template: { kind: "back_to_work", member: SAM, date: "2026-11-16", nursing: ALEX } });
  const busy = (now: Date) => coachNotes(g, goalProgress(g, data({ entries: lateFeeds("2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17") }), now, NY), words(WREN, now));
  const back = busy(at(2026, 11, 18, 10));
  ok(back.notes.includes(`Sam is back at work: ask once whether these steps for before the day back happened, then mark them done (step) or drop them (update): "Ask the lactation consultant about a pumped bottle" (s1, week of Mon, Nov 2); "Rehearse the work-week roster on 2 or 3 nights" (s2, week of Mon, Nov 9).`), JSON.stringify(back.notes));
  ok(!back.notes.some((n) => /carry on with/.test(n)), "never carried on after the day back");
  ok(!busy(at(2026, 11, 24, 10)).notes.some((n) => /ask once whether these steps/.test(n)), "only the first week back");
});

check("the plan's tally (app re-test #6): a try last night's check-in said happened counts toward the day's, shown apart, and the morning backup isn't offered", () => {
  const p = plan();
  const morning = at(2026, 11, 3, 8);
  const t = planToday(p, [], morning, NY, { fromCheckins: 1 });
  eq([t.done, t.fromCheckins, t.fallback], [1, 1, false], "counted from the check-in");
  eq(planTodayWords(t, morning, NY).count, "1 of 1 (from a check-in)", "said apart");
  eq(fromCheckinWords(planToday(p, [], morning, NY)), "", "nothing to say without one");
  const logged = planToday(p, [tryRow(at(2026, 11, 2, 22), at(2026, 11, 2, 23), "stayed_asleep")], morning, NY, { fromCheckins: 1 });
  eq([logged.done, logged.fromCheckins], [1, 0], "a try in the log is the one counted");
  eq([checkinTryOn([checkinRow(SAM, "2026-11-02", "yes", { untimed_try: "short", untimed_min: 60 })], "2026-11-02"), checkinTryOn([checkinRow(SAM, "2026-11-02", "yes", { untimed_try: "no" })], "2026-11-02"), checkinTryOn(null, "2026-11-02")], [1, 0, 0], "from the night's answers");
});

check("a Back to work roster starts on its own night (roster_from): before it no window is on, for quiet hours, the next handoff and the catch-up alike; an older template's roster is on from the start", () => {
  const roster: RosterWindow[] = [{ id: "w1", member: SAM, from: "22:00", to: "02:00", nights: EVERY, covers: "nurse" }];
  const g = goalRow({ roster, template: { kind: "back_to_work", member: ALEX, date: "2026-11-30", nursing: SAM, roster_from: "2026-11-16" } });
  const before = at(2026, 11, 10, 23).getTime();
  const after = at(2026, 11, 16, 23).getTime();
  eq([windowAt([g], SAM, before, NY), windowAt([g], SAM, after, NY)?.start], [null, at(2026, 11, 16, 22).getTime()], "windowAt");
  eq([windowsBetween([g], SAM, before - HOUR, before + HOUR, NY).length, windowsBetween([g], SAM, after - HOUR, after + HOUR, NY).length], [0, 1], "windowsBetween");
  eq([feedCover([g], SAM, before, before + 2 * HOUR, NY), feedCover([g], SAM, after, after + 2 * HOUR, NY)?.covers], [null, "nurse"], "the catch-up's feeding line");
  eq(handoffAroundRoster({ at: before, from: before - HOUR, nextHolder: SAM, goals: [g], tz: NY }).why, null, "a handoff isn't moved off a window that isn't on yet");
  ok(handoffAroundRoster({ at: after, from: after - HOUR, nextHolder: SAM, goals: [g], tz: NY }).why != null, "and is once the roster starts");
  // The night it starts on is on: a window that night (10 PM Nov 16) counts, the night before (Nov 15) doesn't.
  eq([windowAt([g], SAM, at(2026, 11, 16, 1).getTime(), NY), windowAt([g], SAM, at(2026, 11, 17, 1).getTime(), NY)?.start], [null, at(2026, 11, 16, 22).getTime()], "after midnight, by the night it began");
  const older = goalRow({ roster, template: { kind: "back_to_work", member: ALEX, date: "2026-11-30", nursing: SAM } });
  ok(windowAt([older], SAM, before, NY) != null && windowsBetween([older], SAM, before - HOUR, before + HOUR, NY).length === 1, "without roster_from, as before");
});

// ── round 4: the health and safety review (2026-11-03) ───────────────────

check("sleepy (safety P0 #1): I'm getting sleepy, then the bassinet, says one thing in the family's words, never the transfer steps", () => {
  eq(sleepyBassinetLine(SHE), "Lay her on her back in the bassinet now, even if she's awake.", "she");
  eq(sleepyBassinetLine(HE), "Lay him on his back in the bassinet now, even if he's awake.", "he");
  eq(sleepyBassinetLine(THEY), "Lay them on their back in the bassinet now, even if they're awake.", "they");
  const sheet = readFileSync("src/components/maple/sleep/SleepSheets.tsx", "utf8");
  const sleepy = sheet.slice(sheet.indexOf("export function SleepySheet"), sheet.indexOf("export function HoldingSheet"));
  ok(sleepy.length > 0 && sleepy.includes("sleepyBassinetLine(v)") && !/transferSteps\s*\(/.test(sleepy) && !/import[^;]*\btransferSteps\b/.test(sheet), "the sleepy sheet shows the one line, never the steps");
  ok(transferSteps(SHE).some((x) => /until she's deeply asleep/.test(x)), "the transfer steps stay as they are everywhere else");
});

/** Safety P0 #2: crying it out worded as a break (the review's probes and more): every one refused. */
const BREAK_REFUSED = [
  // the review's
  "Let her cry while I take a break",
  "Every night at 2 AM, let her cry for 20 minutes so I can take a break",
  "When I need a break, let her cry for 30 minutes",
  "Let her cry until she falls asleep, so I can calm down",
  "Wait 15 minutes before going in when she cries, so I can calm down",
  "Don't go in until 3 AM, I need a break",
  "Leave her crying in the bassinet if it's too much",
  "If I feel angry, leave her in the bassinet crying and leave the room until morning",
  "When frustrated, put her in the crib and shut the door for an hour",
  "Take a break: let her cry for an hour in the bassinet every night",
  "Step away for an hour and let her cry",
  "When it's too much, let her scream in the bassinet",
  "Let her cry for 15 minutes when I'm frustrated",
  "If I'm losing it, let her cry in the crib and go for a walk",
  // a one-off break that isn't one: too long, a routine, an "until", a clock time, no sleep space or back, no check
  "If I'm overwhelmed, lay her on her back in the bassinet and let her cry for 20 minutes, then check on her",
  "If I need a break, let her cry for 10 to 20 minutes in the bassinet on her back, then check on her",
  "Every night when it's too much, lay her on her back in the crib, let her cry for 10 minutes, then check on her",
  "Whenever I'm overwhelmed, lay her on her back in the bassinet, let her cry for 10 minutes, then check on her",
  "If I'm frustrated, lay her on her back in the bassinet and let her cry until I calm down, then check on her",
  "If it's too much at 3 AM, lay her on her back in the crib, let her cry for 10 minutes and check on her",
  "If I'm overwhelmed, let her cry for 10 minutes, then check on her",
  "If I'm overwhelmed, lay her on her back in the bassinet and let her cry for 10 minutes",
  "If she cries and it's too much, lay her in the bassinet, leave the room and come back in 10 minutes",
  "When I'm angry, shut the door and leave her crying for half an hour",
  "If I can't cope, leave the room for an hour while she cries in the crib",
  "If it's too much, close the door and don't come back until she's asleep",
  "When it's too much, step away for the rest of the night and let her cry",
];
/** …and the AAP's one-off break, in the family's words: every one passes. */
const BREAK_ALLOWED = [
  "If I'm overwhelmed, lay her on her back in the bassinet and step away for a few minutes",
  "If I'm overwhelmed, lay her on her back in the bassinet, let her cry for 10 minutes, then check on her",
  "If it's too much, lay her on her back in the crib, leave the room for 10 to 15 minutes and let her cry, then check on her",
  "When I'm frustrated, put her on her back in the crib, step away for 5 minutes and let her fuss, then come back",
  "If I'm losing it, lay her on her back in her crib, take a breather for a couple of minutes and go back in",
  "Lay her down and leave the room for 10 to 15 minutes when frustrated",
  "When it's too much, put her in the crib, leave the room and come back in 10 minutes",
  "Hand her to Alex and step away for an hour when it's too much",
  "When it's too much, Alex takes her and I go for a walk for an hour",
];

check("safety (P0 #2): an overwhelmed adult's one-off break passes, never a routine, an 'until' or a longer time; the refusal offers the break, which passes in each voice", () => {
  const o = { v: SHE, adults: R3_ADULTS };
  const refused = BREAK_REFUSED.filter((t) => unsafeSleep(t, o));
  const passed = BREAK_ALLOWED.filter((t) => !unsafeSleep(t, o));
  console.log(`  break lists: ${refused.length} of ${BREAK_REFUSED.length} unsafe refused, ${passed.length} of ${BREAK_ALLOWED.length} safe passed`);
  for (const t of BREAK_REFUSED) ok(refused.includes(t), `refused: "${t}"`);
  for (const t of BREAK_ALLOWED) ok(passed.includes(t), `passed: "${t}" (matched "${unsafeSleep(t, o)?.phrase}")`);
  // In his and their families' words too.
  ok(!unsafeSleep("If I'm overwhelmed, lay him on his back in the bassinet, let him cry for 10 minutes, then check on him", { v: HE, adults: R3_ADULTS }), "his words");
  ok(!unsafeSleep("If I'm overwhelmed, lay them on their back in the bassinet, let them cry for 10 minutes, then check on them", { v: THEY, adults: R3_ADULTS }), "their words");
  ok(unsafeSleep("If I'm overwhelmed, lay them on their back in the bassinet, let them cry for an hour, then check on them", { v: THEY, adults: R3_ADULTS }), "their words, an hour");
  // What happened, in why it matters, is the reason for the goal.
  ok(!unsafeSleep("Last week I let her cry for an hour because I was overwhelmed, and it scared us", { ...o, describing: true }), "a why");
  // The refusal offers the break (its suggestion passes in each voice and without one); a method by name too.
  eq(unsafeWords("Step 1", SHE, unsafeSleep("Let her cry while I take a break", o)), `Step 1: Maple won't plan leaving June to cry; for a break when it's too much, try "If I'm overwhelmed, lay her on her back in the bassinet and step away for a few minutes".`, "the break");
  eq(unsafeWords("Step 1", undefined, unsafeSleep("Let her cry it out when it's too much", o)), `Step 1: Maple won't plan leaving the baby to cry; for a break when it's too much, try "If I'm overwhelmed, lay the baby on their back in the bassinet and step away for a few minutes".`, "without a voice");
  eq(unsafeWords("Step 1", SHE, unsafeSleep("Let her cry it out", o)), `Step 1: Maple won't plan leaving June to cry; if this is about settling her, try "Soothe her, then try the bassinet once more".`, "no break asked for: soothe and retry");
  for (const text of BREAK_REFUSED) {
    const find = unsafeSleep(text, o)!;
    for (const v of [...VOICES, undefined]) {
      const words = unsafeWords("Step 1", v, find);
      const tryThis = /try "([^"]+)"/.exec(words)?.[1];
      ok(tryThis && !unsafeSleep(tryThis, { v, adults: R3_ADULTS }) && !unsafeSleep(tryThis, { adults: R3_ADULTS }), `the suggestion passes: ${words}`);
    }
  }
});

/** Safety P0 #3: medicine or supplements for her sleep, or at her sleep times (the review's probes and more): every one refused. */
const MED_REFUSED = [
  // the review's
  "Give her melatonin at bedtime",
  "A little Benadryl so she sleeps through",
  "Gripe water before every nap",
  "Tylenol before bed",
  "Give her Tylenol at bedtime so she sleeps",
  "Give her gripe water before bed",
  // more of each kind
  "Diphenhydramine before the long stretch",
  "An antihistamine at night to help her sleep",
  "Zyrtec at bedtime",
  "Use Benadryl if she won't settle",
  "Benadryl on the flight so she naps",
  "Motrin before her nap",
  "Ibuprofen so she sleeps through the night",
  "Acetaminophen at bedtime while she's teething",
  "Give June Tylenol before bed",
  "Chamomile tea in her bottle at night",
  "Sleep drops before bed",
  "Melatonin gummies for naps",
  "Homeopathic drops at bedtime",
  "Herbal tea so she settles at bedtime",
  "Gas drops before bed",
  "Teething gel before naps",
  "Infant cough syrup at night so she sleeps",
  "A drop of whiskey on her gums at bedtime",
  "A little medicine to help her sleep",
  "Give her something to help her sleep",
  "Ask her pediatrician, then give her melatonin at bedtime",
];
/** …and what passes: a question for her pediatrician, a step away, an adult's own medicine, medicine that isn't for sleep. */
const MED_ALLOWED = [
  "Ask her pediatrician about melatonin",
  "Ask her pediatrician whether Tylenol before bed is okay while she's teething",
  "Ask the pediatrician if we can give her Benadryl at bedtime",
  "Check with the pharmacist about gripe water before naps",
  "No melatonin, just a dark room and white noise",
  "Never give her Benadryl to make her sleep",
  "Stop the gripe water before naps",
  "Vitamin D drops after the morning feed",
  "Vitamin D drops at bedtime",
  "Saline drops before feeds for her stuffy nose",
  "Gas drops after feeds",
  "Tylenol after her shots, as her pediatrician said",
  "Motrin for teething during the day, never before naps",
  "Lavender bath before bed",
  "Chamomile bath wash at bedtime",
  "Sam takes melatonin, so Alex does the first half of the night",
  "I take ibuprofen before bed, so Sam does the 2 AM feed",
  "Mom takes Benadryl for allergies, so Dad does nights",
];

check("safety (P0 #3): medicine or supplements for her sleep, or at her sleep times, are refused as her pediatrician's call; an 'Ask her pediatrician about …' step passes, and so does each refusal's suggestion, in each voice", () => {
  const o = { v: SHE, adults: R3_ADULTS };
  const refused = MED_REFUSED.filter((t) => unsafeSleep(t, o)?.kind === "medicine");
  const passed = MED_ALLOWED.filter((t) => !unsafeSleep(t, o));
  console.log(`  medicine lists: ${refused.length} of ${MED_REFUSED.length} unsafe refused, ${passed.length} of ${MED_ALLOWED.length} safe passed`);
  for (const t of MED_REFUSED) ok(refused.includes(t), `refused as medicine: "${t}" (${unsafeSleep(t, o)?.kind ?? "passed"})`);
  for (const t of MED_ALLOWED) ok(passed.includes(t), `passed: "${t}" (matched "${unsafeSleep(t, o)?.phrase}")`);
  ok(unsafeSleep("Give him melatonin at bedtime", { v: HE, adults: R3_ADULTS })?.kind === "medicine" && unsafeSleep("Give them melatonin at bedtime", { v: THEY, adults: R3_ADULTS })?.kind === "medicine", "his and their words");
  ok(unsafeSleep("Tylenol before bed")?.kind === "medicine", "without a voice (the form)");
  // What happened, in why it matters, is the reason for the goal.
  for (const why of ["She had Tylenol after her shots and slept for 6 hours", "We tried melatonin last month and stopped"]) ok(!unsafeSleep(why, { ...o, describing: true }), `a why: ${why}`);
  // The coordinator's words, in the family's voice, with the question to take to their pediatrician.
  eq(unsafeWords("Step 1", SHE, unsafeSleep("Give her melatonin at bedtime", o)), `Step 1: Maple won't plan medicine or supplements for sleep; that's her pediatrician's call. To raise it with them, try "Ask her pediatrician about melatonin".`, "she");
  eq(unsafeWords("Step 2", THEY, unsafeSleep("Tylenol before bed", { v: THEY })), `Step 2: Maple won't plan medicine or supplements for sleep; that's their pediatrician's call. To raise it with them, try "Ask their pediatrician about Tylenol".`, "they");
  eq(unsafeWords("Step 1", undefined, unsafeSleep("A little medicine to help her sleep", o)), `Step 1: Maple won't plan medicine or supplements for sleep; that's the baby's pediatrician's call. To raise it with them, try "Ask the baby's pediatrician about medicine for sleep".`, "without a voice");
  for (const text of MED_REFUSED) {
    const find = unsafeSleep(text, o)!;
    for (const v of [...VOICES, undefined]) {
      const words = unsafeWords("Step 1", v, find);
      const tryThis = /try "([^"]+)"/.exec(words)?.[1];
      ok(tryThis && !unsafeSleep(tryThis, { v, adults: R3_ADULTS }) && !unsafeSleep(tryThis, { adults: R3_ADULTS }), `the suggestion passes: ${words}`);
      ok(!/\b\d+(\.\d+)?\s?(mg|ml|mL|teaspoons?|tsp)\b|\bdoses?\b/i.test(words), `never a dose: ${words}`);
    }
  }
  // Every goal text refuses it, by its field; the plan's goal too.
  throwsInput(() => cleanGoalInput({ title: "Longer nights", steps: [{ title: "A little Benadryl so she sleeps through" }] }, { ...RULES, v: SHE }, "create"), /^Step 1: Maple won't plan medicine or supplements for sleep; that's her pediatrician's call\./, "a step");
  throwsInput(() => refuseUnsafe("Melatonin so she sleeps", "The goal", { v: SHE }), /^The goal: Maple won't plan medicine or supplements for sleep;/, "the plan's goal");
  ok(cleanGoalInput({ title: "Longer nights", steps: [{ title: "Ask her pediatrician about melatonin" }] }, { ...RULES, v: SHE }, "create").fields.steps?.length === 1, "the question saves");
});

/** The items the safety review changed (rechecked 2026-11-03, still waiting for sign-off). */
const RECHECKED_IDS = ["next-stage-3", "next-stage-4", "safe-swaddle", "safe-warm", "safe-sleepy", "safe-feeding-sleepy", "call-breathing", "call-crying", "call-feeding", "call-help", "emergency-911", WORK_BOTTLES, WORK_DROWSY_DRIVING];

check("guidance (safety P1 #4, #6–#8, P2 #12–#16, #21, #22): faithful to its sources, as urgent as they are, in the family's words, each change rechecked on 2026-11-03 and waiting for sign-off", () => {
  const byId = (id: string) => [...SLEEP_GUIDES, ...WORK_GUIDES].find((g) => g.id === id)!;
  const url = (id: string) => byId(id).sources.map((s) => s.url);
  // #4: the adult bed's words begin with the AAP's own, keep the guide's steps in order, and the comparison is an accident's, never said alone.
  const bed = feedingSleepyWords(SHE).bed;
  eq(bed, "The AAP recommends against bed sharing under any circumstances. If you bring her into your bed to feed, put her back in her own sleep space before you sleep. If you might fall asleep first, take away pillows, blankets, sheets and anything else that could cover her face, head or neck or make her too warm. Falling asleep there by accident is relatively less hazardous than on a sofa or armchair, but still not recommended. If you do fall asleep, move her back as soon as you wake.", "the bed passage");
  eq(Object.keys(feedingSleepyWords(SHE)), ["mindful", "someone", "bed"], "no comparison to quote on its own");
  ok(byId("safe-feeding-sleepy").body(SHE).endsWith(bed) && !/If you might doze off|a cleared adult bed is less hazardous/.test(byId("safe-feeding-sleepy").body(SHE)), "the item says the passage, and never the old sentence");
  const bedCaution = goalCautions({ steps: [{ id: "s1", title: "Nurse her to sleep in our bed, then move her to the bassinet", week_of: null, done_at: null, done_by: null }] }, { v: SHE, name: nameOf, adults: R3_ADULTS }).find((c) => c.kind === "transfer")!;
  ok(bedCaution.text.endsWith(`say this with it: "${bed}"`) && bedCaution.source?.url === "https://www.healthychildren.org/English/ages-stages/baby/sleep/Pages/a-parents-guide-to-safe-sleep.aspx", bedCaution.text);
  // #12: the tired adult's bed in the guide's own words.
  ok(byId("safe-sleepy").body(SHE).includes("The AAP recommends against bed sharing under any circumstances, and the risk of a sleep-related death is more than 10 times higher") && !/isn't recommended/.test(byId("safe-sleepy").body(SHE)), "safe-sleepy");
  // #6: as urgent as the sources (any trouble breathing under a year: the ER now; drinking very little for 8 hours: now).
  eq(byId("call-breathing").body(SHE), "Go to the ER now for any trouble breathing; call her pediatrician now if she's breathing much faster than usual.", "breathing");
  ok(byId("call-feeding").body(SHE).startsWith("Call her pediatrician now if she won't feed, or feeds very little, for more than 8 hours"), "feeding");
  // #21: the family's words, with agreeing verbs.
  eq(byId("call-breathing").body(THEY), "Go to the ER now for any trouble breathing; call their pediatrician now if they're breathing much faster than usual.", "breathing, they");
  ok(byId("call-crying").body(THEY).endsWith("or if they're under a month old and look or act unusual in any way."), byId("call-crying").body(THEY));
  for (const v of VOICES) for (const g of [...SLEEP_GUIDES, ...WORK_GUIDES]) ok(!/\bthey (is|has|was|seems|wakes|shows|falls|cries|feeds|sleeps|looks|acts)\b|\bthey's\b/i.test(g.body(v)), `${g.id}: agreement in ${v.pronoun}`);
  // #7: a bottle never before about 4 weeks old (OWH, Texas HHS); a day back sooner is a question first, and never "that's now".
  eq(byId(WORK_BOTTLES).body(SHE), "If June nurses, a bottle of expressed milk usually waits until about 4 weeks old. If the nursing parent goes back to work or school before then, ask her pediatrician or lactation consultant first.", "bottles");
  eq(url(WORK_BOTTLES)[0], "https://womenshealth.gov/breastfeeding/breastfeeding-home-work-and-public/breastfeeding-and-going-back-work", "OWH first");
  const w = { id: "w1", member: SAM, from: "22:00", to: "02:00", nights: EVERY, covers: "bottle" as const };
  for (const [ageDays, back] of [[3, "2026-11-05"], [10, "2026-11-20"], [27, "2026-11-04"]] as const) {
    const c = goalCautions({ roster: [w], template: { kind: "back_to_work", member: ALEX, date: back, nursing: ALEX } }, { v: SHE, name: nameOf, ageDays, today: "2026-11-03" })[0];
    ok(c.kind === "bottle" && !/that's now|whichever is sooner/.test(c.text) && c.text.includes(`For this plan, that's ${dateWordsOf(addDaysOf("2026-11-03", 28 - ageDays), "2026-11-03")}.`), c.text);
  }
  // #8: held sleep only while awake, with what to do if you might fall asleep, citing the technical report; the sleepy line as soon as sleep might come.
  for (const id of ["next-stage-3", "next-stage-4"]) ok(byId(id).body(SHE).endsWith("If you might fall asleep, lay her on her back in the bassinet.") && url(id).includes("https://pubmed.ncbi.nlm.nih.gov/35921639/"), id);
  ok(sleepyLine(SHE).startsWith("If you start to feel sleepy while holding her, lay her on her back in the bassinet or hand her to someone who's awake.") && !/feel yourself dozing/.test(sleepyLine(SHE)), sleepyLine(SHE));
  const awake = goalCautions({ steps: [{ id: "s1", title: "Contact naps on me while I'm awake", week_of: null, done_at: null, done_by: null }] }, { v: SHE, name: nameOf, adults: R3_ADULTS })[0];
  eq([awake.kind, awake.source?.url, awake.guide], ["awake", "https://pubmed.ncbi.nlm.nih.gov/35921639/", "safe-sleepy"], "the awake caution's source");
  // #9: no unsourced "two sleep spaces", and the arms note says what to do if you might fall asleep.
  const arms = backToWorkGoal({ returning: SAM, return_date: "2026-11-30", feeding: "nursing", nursing: ALEX, sleeps: "arms", first_half: SAM, second_half: ALEX, off_duty: "same_room" }, { v: SHE, name: nameOf, today: "2026-11-03", adults: new Set([SAM, ALEX]) }).notes;
  ok(arms.includes("June sleeps in arms now: holding her is fine while you're awake. If you might fall asleep, lay her on her back in the bassinet. The Plan tab's first stage is one bassinet try a day.") && !arms.some((n) => /clinician's approach|two sleep spaces/.test(n)), JSON.stringify(arms));
  // #13, #14, #15, #16, #22.
  ok(byId("safe-warm").body(SHE) === "Dress her in only one layer more than you're wearing, and skip the hat indoors." && /as early as 2 months/.test(byId("safe-swaddle").body(SHE)), "layers and rolling");
  eq(byId("call-help").body(SHE), "Lay her on her back in the bassinet, step away for about 10 to 15 minutes and get help from family or a friend, then check on her. Never shake or hit her, however tired or angry you feel. If anyone might hurt her or themselves, call 911 if anyone is in immediate danger; otherwise call or text 988, any time.", "call-help");
  ok(url("call-help").includes("https://www.healthychildren.org/English/safety-prevention/at-home/Pages/Abusive-Head-Trauma-Shaken-Baby-Syndrome.aspx") && url("call-help").includes("https://988lifeline.org/get-help/"), "the shaken baby page, and 988's help page");
  ok(url("emergency-911").includes("https://www.healthychildren.org/English/ages-stages/baby/sleep/Pages/Sleep-Apnea-Detection.aspx"), "the 20 seconds' source");
  ok(byId(WORK_DROWSY_DRIVING).body(SHE).endsWith("a ride from family or a friend, or other transportation. A short nap first may still not keep you awake enough to drive safely."), "NIOSH's nap caveat");
  ok(![...SLEEP_GUIDES, ...WORK_GUIDES].some((g) => g.sources.some((s) => s.url.includes("talk-to-someone-now"))), "988's current URL");
  // Each change rechecked on 2026-11-03 and still waiting for a person's sign-off, listed first; nothing else re-dated.
  for (const id of RECHECKED_IDS) eq([byId(id).reviewed, byId(id).needsReview, pendingReview().includes(byId(id))], ["2026-11-03", true, true], `${id}: rechecked and waiting for sign-off`);
  eq(pendingReview().slice(0, RECHECKED_IDS.length).map((g) => g.id).sort(), [...RECHECKED_IDS].sort(), "the review's changes lead the sign-off list");
  ok([...SLEEP_GUIDES, ...WORK_GUIDES].filter((g) => !RECHECKED_IDS.includes(g.id)).every((g) => g.reviewed === "2026-11-02"), "nothing else re-dated");
});

check("guidance (safety P2 #17, #19, P1 #8 in the app): the plan editor's place note, the holding sheet's line on her back, the plan's held-sleep line, and the quick setup's cautions with their sources", () => {
  for (const v of VOICES) {
    eq(sleepsNowNote(v, "car"), SLEEP_GUIDES.find((g) => g.id === "safe-seats")!.body(v), `a car seat: safe-seats' words (${v.pronoun})`);
    ok(sleepsNowNote(v, "stroller") === sleepsNowNote(v, "car") && sleepsNowNote(v, "carrier") === sleepsNowNote(v, "car"), "a stroller or carrier, the same");
    eq(sleepsNowNote(v, "bed"), `The AAP recommends against bed sharing under any circumstances. ${SLEEP_GUIDES.find((g) => g.id === "safe-room")!.body(v)}`, "a grown-up bed");
    ok(/^Holding (her|him|them) is fine while you're awake\. If you might fall asleep, lay (her|him|them) on (her|his|their) back in the bassinet\.$/.test(sleepsNowNote(v, "arms")!), "arms");
    eq([sleepsNowNote(v, "bassinet"), sleepsNowNote(v, "crib"), sleepsNowNote(v, null)], [null, null, null], "her own sleep space: nothing");
    if (v === THEY) for (const p of ["car", "bed", "arms"]) ok(!/\b(she|her|he|him|his)\b/i.test(sleepsNowNote(v, p)!), `${p}: their words`);
  }
  const plan = readFileSync("src/components/maple/sleep/SleepPlanSheet.tsx", "utf8");
  ok(/sleepsNowNote\(v, where\)/.test(plan) && /fine while you&apos;re awake\. \{mightFallAsleep\(v\)\}/.test(plan), "the plan sheet says them");
  const sheets = readFileSync("src/components/maple/sleep/SleepSheets.tsx", "utf8");
  ok(sheets.includes("If you start to feel sleepy before then, lay {v.them} on {v.their} back in the bassinet or wake someone."), "the holding sheet: on her back");
  const goals = readFileSync("src/components/maple/sleep/SleepGoals.tsx", "utf8");
  ok(goals.includes("cautions={cautions} onSave=") && /cautions: GoalCaution\[\]/.test(goals) && (goals.match(/<CautionNote /g) ?? []).length === 2, "the quick setup's read-back shows each caution with its source, as the goal card does");
});

/** Safety P1 #10 and this round's: swaddling once she's rolling, or so tight she can't move (the AAP's swaddling page). */
const SWADDLE_REFUSED = [
  "Keep swaddling after she starts rolling",
  "Swaddle her arms in even though she's rolling",
  "Keep the swaddle on even once she rolls",
  "Still swaddle her at night now that she rolls over",
  "She rolls now, but keep swaddling for naps",
  "When she starts rolling, swaddle her arms out",
  "Swaddle her tight so she can't move",
  "Swaddle her as tight as possible so she stays asleep",
];
const SWADDLE_ALLOWED = [
  "Swaddle her until she rolls",
  "Stop swaddling once she rolls",
  "Once she rolls, a sleep sack instead of the swaddle",
  "Since she's rolling now, stop swaddling",
  "She's rolling, so no more swaddle",
  "Now that she rolls over, stop the swaddle",
  "Swaddle her snugly with room for her hips",
  "Swaddle her for naps; she isn't rolling yet",
  "Once she starts rolling, switch from the swaddle to a sleep sack",
];
/** Coach review #6 (t10): common unsafe phrasings that got through, and this round's more of each. */
const COACH_MISSES = [
  "If she cries, wait 10 minutes",
  "It's okay if she cries for 10 minutes",
  "She can cry for 10 minutes",
  "Don't respond to her cries at night",
  "Don't go to her when she cries",
  "Leave the room even if she cries",
  "Put her down awake and walk out, even if she cries",
  "Let her self-settle for 20 minutes",
  "Hold off on going in for 10 minutes",
  "Let her spend the night in our bed",
  "Let her finish the night in our bed",
  "Keep her in our bed for the rest of the night",
  "Bring her into bed with us at 4am",
  "Let her nap in the Snuggle Me",
  "Naps in the Snuggle Me",
  "Put her in the DockATot at night",
  "Put her in the Dock-a-Tot overnight",
  "Prop the bassinet up for reflux",
  "Leave her in the swing after she falls asleep",
  // more of each
  "If she fusses, wait 5 minutes",
  "When she cries at night, wait 10 minutes",
  "Hold off 10 minutes before going in when she cries",
  "She can cry for 15 minutes before we go in",
  "It's fine if she cries for 20 minutes",
  "Don't go in to her when she cries at night",
  "Stop comforting her when she wakes at night",
  "Don't pick her up or soothe her when she cries",
  "Don't check on her when she cries after midnight",
  "Shut the door and leave even if she screams",
  "Let her self-settle for 15 minutes before picking her up",
  "Teach her to self-soothe by walking out",
  "Let her protest cry before the bassinet",
  "Bring her into our bed after the 3am feed",
  "She sleeps the rest of the night with us",
  "Use the DockATot in the crib",
  "Put her in the lounger at night",
  "Use a positioner in the bassinet",
  "Prop the head of the crib up a little",
  "Naps in the Ergo",
];
/** Coach review #5 (t10, t11): plainly safe steps that were refused, and this round's more of each. */
const COACH_FALSE_REFUSALS = [
  "No blankets, pillows or bumpers in the crib, ever",
  "Use a nursing pillow for feeds, never for sleep",
  "Swing only while she's awake, never for naps",
  "Car seat only in the car, never for naps at home",
  "A stroller walk to help her fall asleep, then the crib",
  "Walk her to sleep in the carrier, then lay her in the bassinet",
  "Bassinet only: no swing, car seat or couch naps",
  // more of each
  "Without pillows, blankets or bumpers in the bassinet",
  "Nursing pillow for feeds at night, then the bassinet",
  "No DockATot in the crib",
  "Take the Snuggle Me out of the crib",
  "Snuggle Me for supervised play on the floor, never for sleep",
  "Walk her in the stroller until she's asleep, then move her to the crib",
  "Ergo for walks, bassinet for naps",
  "Bring her into our bed to nurse, then back to the bassinet",
  "Bring her into our bed in the morning for cuddles",
  "If she cries, pick her up right away",
  "When she cries, wait a minute, then go in",
  "If she wakes, wait 2 minutes to see if she's hungry",
  "She can cry in my arms while I rock her",
  "It's fine if she cries a little while I change her",
  "Don't respond to every cry with a feed; soothe her first",
  "Never stop responding to her cries",
  "Don't pick her up when she cries, pat and shush her in the crib instead",
  "Don't pick her up at every stir; just a hand on her chest",
  "Sam can leave the room even if she cries, because Alex is holding her",
  "Give her a minute to self-settle in the bassinet",
  "Hold off on the pacifier for 10 minutes after feeds",
];

check("safety (P1 #10, coach review #5 and #6): swaddling once she's rolling is refused; the coach review's misses are refused and its false refusals pass; every refusal's suggestion passes in each voice and without one", () => {
  const o = { v: SHE, adults: R3_ADULTS };
  const lists: [string, string[], boolean][] = [
    ["swaddling refused", SWADDLE_REFUSED, true],
    ["swaddling done safely", SWADDLE_ALLOWED, false],
    ["the coach review's misses", COACH_MISSES, true],
    ["the coach review's false refusals", COACH_FALSE_REFUSALS, false],
  ];
  for (const [label, xs, refuse] of lists) {
    const right = xs.filter((t) => !!unsafeSleep(t, o) === refuse);
    console.log(`  ${label}: ${right.length} of ${xs.length} as wanted`);
    for (const t of xs) ok(right.includes(t), `${refuse ? "refused" : "passed"}: "${t}" (${unsafeSleep(t, o)?.phrase ?? "passed"})`);
  }
  eq(SWADDLE_REFUSED.map((t) => unsafeSleep(t, o)?.kind), SWADDLE_REFUSED.map(() => "swaddle"), "swaddling, by its kind");
  eq(unsafeWords("Step 1", SHE, unsafeSleep("Keep swaddling after she starts rolling", o)), `Step 1: Maple won't plan swaddling once she shows signs of trying to roll; try "Stop swaddling once she shows any signs of trying to roll".`, "past rolling");
  eq(unsafeWords("Step 1", THEY, unsafeSleep("Swaddle them tight so they can't move", { v: THEY })), `Step 1: Maple won't plan a swaddle so tight they can't move; try "Swaddle them loose enough that their hips can move".`, "too tight, their words");
  // His family's words: "he" is the baby there.
  ok(unsafeSleep("He can cry for 15 minutes before we go in", { v: HE, adults: R3_ADULTS }) && unsafeSleep("Keep swaddling him after he starts rolling", { v: HE, adults: R3_ADULTS })?.kind === "swaddle", "his words");
  // A step away from a sitting device's transfer passes with the AAP's words for it, and its source.
  const c = goalCautions({ steps: [{ id: "s1", title: "Walk her to sleep in the carrier, then lay her in the bassinet", week_of: null, done_at: null, done_by: null }] }, { v: SHE, name: nameOf, adults: R3_ADULTS });
  ok(c.length === 1 && c[0].kind === "transfer" && c[0].text.endsWith(`say this with it: "${SLEEP_GUIDES.find((g) => g.id === "safe-seats")!.body(SHE)}"`) && c[0].guide === "safe-seats" && !!c[0].source, JSON.stringify(c));
  eq(goalCautions({ steps: [{ id: "s1", title: "If she falls asleep in the car seat, move her to the bassinet", week_of: null, done_at: null, done_by: null }] }, { v: SHE, name: nameOf, adults: R3_ADULTS }), [], "the AAP's own words need nothing said");
  // Every refusal's wording to try passes the filter, in each family's words and without a voice (the form).
  for (const text of [...SWADDLE_REFUSED, ...COACH_MISSES]) {
    const find = unsafeSleep(text, o)!;
    for (const v of [...VOICES, undefined]) {
      const words = unsafeWords("Step 1", v, find);
      const tryThis = /try "([^"]+)"/.exec(words)?.[1];
      ok(tryThis && !unsafeSleep(tryThis, { v, adults: R3_ADULTS }) && !unsafeSleep(tryThis, { adults: R3_ADULTS }), `the suggestion passes: ${words}`);
    }
  }
  // Every refusal kind's suggestion passes in each voice, whatever found it.
  const kinds: [string, string][] = [["cry", "Let her cry it out"], ["adult", "She naps on my chest"], ["bed", "Co-sleep after the late feed"], ["couch", "She naps on the couch"], ["seat", "Naps in the car seat"], ["product", "Naps on the nursing pillow"], ["position", "Put her down on her tummy"], ["bedding", "Bumpers in the crib"], ["weighted", "A weighted sleep sack"], ["incline", "Raise the head of the crib"], ["medicine", "Melatonin at bedtime"], ["swaddle", "Keep swaddling after she starts rolling"]];
  for (const [kind, text] of kinds) {
    const find = unsafeSleep(text, o);
    eq(find?.kind, kind, text);
    for (const v of [...VOICES, undefined]) {
      const tryThis = /try "([^"]+)"/.exec(unsafeWords("Step 1", v, find))?.[1];
      ok(tryThis && !unsafeSleep(tryThis, { v, adults: R3_ADULTS }) && !unsafeSleep(tryThis), `${kind} in ${v?.pronoun ?? "no"} voice: ${tryThis}`);
    }
  }
});

console.log(`\nmaple-sleep-check: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
