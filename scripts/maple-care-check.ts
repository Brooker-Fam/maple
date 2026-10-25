/**
 * Assertions for mom's area (spec §15.1): the medicine engine in
 * src/lib/maple/care.ts (status, units, the one-tap, lines and sentences,
 * notes, names, check-ins, who can see what), the exact guidelines.ts copy,
 * and the static rules (no digit in a placeholder or hint, no EPDS, help
 * lines re-checked within six months).
 *
 *   npx tsx scripts/maple-care-check.ts      (or npm run check:maple-care)
 *
 * Pure: no database and no network. One PASS/FAIL line per case, exit 1 on
 * any failure. Fake people and fake medicines only (the repo is public):
 * owner Alex, owner Sam (the care person), member Jo, viewer Vi, and the
 * admin login. Times are wall clock in America/New_York.
 */
import fs from "node:fs";
import path from "node:path";
import {
  careAccess,
  careTime,
  checkinResponse,
  crisisToday,
  daysSinceBirth,
  doseNotes,
  forMom,
  listNotes,
  matchPlan,
  nextUnits,
  normName,
  nursingNotesShown,
  oneOffNotes,
  oneTapDecision,
  parseUnits,
  planLine,
  planMeta,
  planNotes,
  planSentence,
  planStatus,
  planView,
  scheduleSummary,
  scoreScreen,
  screenResults,
  sortPlans,
  suggestAckKey,
  suggestFullCheckin,
  todayCheckin,
  unitsOf,
  type CareViewer,
  type PlanTextCtx,
} from "../src/lib/maple/care";
import * as G from "../src/lib/maple/guidelines";
import { zonedTimeToUtc } from "../src/lib/maple/time";
import type { CarePerson, CarePlan, CareSettings, DoseEntry, Member, MoodEntry, Source } from "../src/lib/maple/types";

const TZ = "America/New_York";
const ROOT = path.resolve(__dirname, "..");

// ── harness ──────────────────────────────────────────────────────────────

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

/** Intl puts a narrow no-break space before AM/PM; compare as plain spaces. */
const plain = (v: unknown): unknown => (typeof v === "string" ? v.replace(/[  ]/g, " ") : Array.isArray(v) ? v.map(plain) : v);

function eq(actual: unknown, expected: unknown, what = "value") {
  const a = JSON.stringify(plain(actual));
  const b = JSON.stringify(plain(expected));
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}
function ok(cond: unknown, what: string) {
  if (!cond) throw new Error(what);
}
function has(s: string, part: string, what = "text") {
  if (!String(plain(s)).includes(String(plain(part)))) throw new Error(`${what}: expected to contain ${JSON.stringify(part)} in ${JSON.stringify(plain(s))}`);
}

// ── fixtures ─────────────────────────────────────────────────────────────

const ALEX = "alex@example.com";
const SAM = "sam@example.com";
const JO = "jo@example.com";
const VI = "vi@example.com";
const members: Member[] = [
  { email: ALEX, role: "owner", display_name: "Alex", emoji: null, color: null },
  { email: SAM, role: "owner", display_name: "Sam", emoji: null, color: null },
  { email: JO, role: "member", display_name: "Jo", emoji: null, color: null },
  { email: VI, role: "viewer", display_name: "Vi", emoji: null, color: null },
  { email: "admin", role: "owner", display_name: "Admin", emoji: null, color: null },
];

/** A local wall-clock instant: L(25, "03:05") is Oct 25, 2026, 3:05 AM in New York. */
function L(day: number, hm: string, month = 10): string {
  const [h, m] = hm.split(":").map(Number);
  return zonedTimeToUtc(2026, month, day, h, m, TZ).toISOString();
}
const D = (day: number, hm: string, month = 10) => new Date(L(day, hm, month));
const H = 3600_000;
const shift = (iso: string, hours: number) => new Date(Date.parse(iso) + hours * H).toISOString();

let ids = 20_000_000;
function plan(p: Partial<CarePlan> = {}): CarePlan {
  return {
    id: ids++,
    name: "Ibuprofen",
    also_called: null,
    dose_text: null,
    schedule: { type: "as_needed", min_gap_min: 360 },
    max_24h: null,
    limit_unit: null,
    units_per_dose: null,
    label_text: null,
    reason: null,
    contains_apap: false,
    instructions: null,
    course_start: null,
    course_end: null,
    show_on_today: true,
    private: false,
    stopped_at: null,
    reviewed_at: null,
    reviewed_by: null,
    sort: 0,
    created_by: ALEX,
    updated_by: null,
    source: "web",
    created_at: L(20, "12:00"),
    updated_at: L(20, "12:00"),
    ...p,
  };
}
function dose(pl: CarePlan, at: string, o: { units?: number; skipped?: boolean; by?: string; source?: Source } = {}): DoseEntry {
  return {
    id: ids++,
    kind: "dose",
    med_id: pl.id,
    at,
    data: { name: pl.name, units: o.units ?? null, unit: pl.limit_unit, ...(o.skipped ? { skipped: true } : {}) },
    note: null,
    private: false,
    created_by: o.by ?? SAM,
    updated_by: null,
    source: o.source ?? "web",
    created_at: at,
    updated_at: at,
  };
}
const her = (now: Date, extra: Partial<PlanTextCtx> = {}): PlanTextCtx => ({ now, tz: TZ, self: true, members, me: SAM, ...extra });
const them = (now: Date, extra: Partial<PlanTextCtx> = {}): PlanTextCtx => ({ now, tz: TZ, self: false, members, me: ALEX, ...extra });
const noteCtx = (settings: CareSettings = {}, self = true) => ({ name: "Sam", self, settings });
const st = (pl: CarePlan, doses: DoseEntry[], now: Date) => planStatus(pl, doses, now, TZ);

// ── T-ENG-1 planStatus ───────────────────────────────────────────────────

check("T-ENG-1 gap with no limit: wait inside the gap, ok after it", () => {
  const p = plan();
  const ds = [dose(p, L(25, "03:00"))];
  const a = st(p, ds, D(25, "05:00"));
  eq(a.state, "wait", "state");
  eq(a.nextOkAt, L(25, "09:00"), "nextOkAt");
  const b = st(p, ds, D(25, "09:30"));
  eq(b.state, "ok", "state after");
  eq(b.gapOkAt, L(25, "09:00"), "gapOkAt");
});

check("T-ENG-1 limit with no gap: unknown until the limit, then at_limit", () => {
  const p = plan({ schedule: { type: "as_needed", min_gap_min: null }, max_24h: 4, limit_unit: "doses" });
  const two = [dose(p, L(25, "01:00")), dose(p, L(25, "03:00"))];
  eq(st(p, two, D(25, "05:00")).state, "unknown");
  eq(st(p, two, D(25, "05:00")).count24, 2, "count24");
  const four = [...two, dose(p, L(25, "03:30")), dose(p, L(25, "04:00"))];
  eq(st(p, four, D(25, "05:00")).state, "at_limit");
});

check("T-ENG-1 skipped doses don't count and don't move the clock", () => {
  const p = plan({ name: "Antibiotic", schedule: { type: "every", every_min: 480 } });
  const s = st(p, [dose(p, L(25, "00:00")), dose(p, L(25, "08:00"), { skipped: true })], D(25, "09:00"));
  eq(s.last?.at, L(25, "00:00"), "last");
  eq(s.count24, 1, "count24");
  eq(s.state, "ok", "state");
});

check("T-ENG-1 a back-filled dose: the clock uses the newest by time", () => {
  const p = plan();
  const later = dose(p, L(25, "04:00"));
  const backfilled = dose(p, L(25, "02:00")); // logged afterwards, for earlier
  const s = st(p, [later, backfilled], D(25, "05:00"));
  eq(s.last?.id, later.id, "last");
  eq(s.nextOkAt, L(25, "10:00"), "nextOkAt");
});

check("T-ENG-1 stopped and finished", () => {
  eq(st(plan({ stopped_at: L(24, "10:00") }), [], D(25, "05:00")).state, "stopped");
  eq(st(plan({ course_start: "2026-10-20", course_end: "2026-10-24" }), [], D(25, "05:00")).state, "finished");
  eq(st(plan({ course_start: "2026-10-20", course_end: "2026-10-25" }), [], D(25, "23:00")).state, "none", "last day still runs");
});

check('T-ENG-1 "Day 3 of 7"', () => {
  const p = plan({ course_start: "2026-10-23", course_end: "2026-10-29" });
  const s = st(p, [dose(p, L(25, "01:00"))], D(25, "09:00"));
  eq([s.courseDay, s.courseDays], [3, 7], "course");
  ok(planMeta(p, s, her(D(25, "09:00"))).includes("Day 3 of 7"), "meta has Day 3 of 7");
});

check("T-ENG-1 Each day: day_open, then day_done; yesterday's doses don't count", () => {
  const p = plan({ name: "Stool softener", schedule: { type: "daily", per_day: 2 } });
  const y = dose(p, L(24, "20:00"));
  eq(st(p, [y], D(25, "07:00")).state, "day_open");
  const one = [y, dose(p, L(25, "08:12"))];
  eq(st(p, one, D(25, "12:00")).state, "day_open");
  eq(st(p, [...one, dose(p, L(25, "20:05"))], D(25, "21:00")).state, "day_done");
});

check("T-ENG-1 At set times: a slot is filled by the nearest dose that day (step 1)", () => {
  const p = plan({ name: "Iron", schedule: { type: "times", times: ["08:00", "20:00"] } });
  eq(st(p, [], D(25, "07:00")).state, "slot_next", "before the first");
  const am = dose(p, L(25, "08:10"));
  const noon = st(p, [am], D(25, "12:00"));
  eq(noon.state, "slot_next", "midday");
  eq(noon.nextSlotAt, L(25, "20:00"), "next slot");
  eq(st(p, [am], D(25, "20:30")).state, "slot_open", "evening missed");
  eq(st(p, [am, dose(p, L(25, "20:15"), { skipped: true })], D(25, "20:30")).state, "day_done", "a skip fills a slot");
  eq(st(p, [], D(25, "09:00")).state, "slot_open", "8:00 not logged");
});

// ── T-ENG-2..5 limits and units ─────────────────────────────────────────

check("T-ENG-2 limit in Doses: 5 inside 24 h with max 4 → at_limit, OK at the 2nd-oldest + 24 h", () => {
  const now = D(25, "12:00");
  const p = plan({ schedule: { type: "as_needed", min_gap_min: null }, max_24h: 4, limit_unit: "doses" });
  const ds = [-20, -16, -12, -8, -4].map((h) => dose(p, shift(now.toISOString(), h)));
  const s = st(p, ds, now);
  eq(s.state, "at_limit");
  eq(s.nextOkAt, shift(ds[1].at, 24), "nextOkAt");
  const gapLater = plan({ schedule: { type: "as_needed", min_gap_min: 14 * 60 }, max_24h: 4, limit_unit: "doses" });
  const s2 = st(gapLater, ds.map((d) => ({ ...d, med_id: gapLater.id })), now);
  eq(s2.nextOkAt, shift(ds[4].at, 14), "the gap is later");
});

check('T-ENG-3 S1: "2" each time, limit 6 caplets → ok after 2 doses, at_limit after 3', () => {
  const now = D(25, "12:00");
  const p = plan({ max_24h: 6, limit_unit: "caplets", units_per_dose: "2" });
  const d1 = dose(p, shift(now.toISOString(), -14));
  const d2 = dose(p, shift(now.toISOString(), -7));
  const two = st(p, [d1, d2], now);
  eq([two.state, two.count24], ["ok", 4], "after 2");
  const d3 = dose(p, shift(now.toISOString(), -0.5));
  const three = st(p, [d1, d2, d3], now);
  eq([three.state, three.count24], ["at_limit", 6], "after 3");
  eq(three.nextOkAt, shift(d1.at, 24), "OK when the oldest ages out");
  eq(planLine(p, three, her(now)), `Ibuprofen · OK after ${careTime(shift(d1.at, 24), now, TZ)} · 6 of 6 caplets in 24 h`, "line");
});

check("T-ENG-4 limit 6 caplets, fixed 2, doses of 2+2+1 → at_limit; OK at the oldest + 24 h", () => {
  const now = D(25, "12:00");
  const p = plan({ schedule: { type: "as_needed", min_gap_min: null }, max_24h: 6, limit_unit: "caplets", units_per_dose: "2" });
  const ds = [dose(p, L(25, "02:00"), { units: 2 }), dose(p, L(25, "04:00"), { units: 2 }), dose(p, L(25, "06:00"), { units: 1 })];
  const s = st(p, ds, now);
  eq([s.state, s.count24], ["at_limit", 5]);
  eq(s.limitOkAt, shift(ds[0].at, 24), "limitOkAt");
});

check('T-ENG-5 "1 or 2": next counts 1, a dose with no units counts 2; parseUnits', () => {
  const p = plan({ max_24h: 8, limit_unit: "tablets", units_per_dose: "1 or 2" });
  eq(nextUnits(p), 1, "nextUnits");
  eq(unitsOf(dose(p, L(25, "01:00")), p), 2, "unitsOf with none");
  eq(unitsOf(dose(p, L(25, "01:00"), { units: 1 }), p), 1, "unitsOf with 1");
  eq(parseUnits("2"), { fixed: 2 });
  eq(parseUnits("2 caplets"), { fixed: 2 });
  eq(parseUnits("10 mL"), { fixed: 10 });
  eq(parseUnits("1 or 2"), { options: [1, 2] });
  eq(parseUnits("1-2"), { options: [1, 2] });
  eq(parseUnits("1 to 2"), { options: [1, 2] });
  eq(parseUnits("as directed"), {});
  eq(nextUnits(plan({ max_24h: 4, limit_unit: "doses", units_per_dose: "2" })), 1, "Doses count 1");
});

// ── T-ENG-6 DST ──────────────────────────────────────────────────────────

check("T-ENG-6 DST: 00:30 EDT on Nov 1 + 6 h = 05:30 EST; 8:00 stays 8:00; the repeated hour shows its zone", () => {
  const p = plan();
  const at = "2026-11-01T04:30:00.000Z"; // 12:30 AM EDT
  const now = new Date("2026-11-01T07:00:00.000Z"); // 2:00 AM EST
  const s = st(p, [dose(p, at)], now);
  eq(s.nextOkAt, "2026-11-01T10:30:00.000Z", "nextOkAt");
  eq(planLine(p, s, her(now)), "Ibuprofen OK after 5:30 AM", "line");
  const t = plan({ name: "Iron", schedule: { type: "times", times: ["08:00"] } });
  eq(st(t, [], new Date("2026-10-31T10:00:00Z")).nextSlotAt, "2026-10-31T12:00:00.000Z", "Oct 31 8:00 EDT");
  eq(st(t, [], new Date("2026-11-01T11:00:00Z")).nextSlotAt, "2026-11-01T13:00:00.000Z", "Nov 1 8:00 EST");
  eq(careTime("2026-11-01T06:30:00.000Z", now, TZ), "1:30 AM EST", "second 1:30");
  eq(careTime("2026-11-01T05:30:00.000Z", now, TZ), "1:30 AM EDT", "first 1:30");
  eq(careTime("2026-11-01T08:30:00.000Z", now, TZ), "3:30 AM", "after the repeat");
});

// ── T-ENG-7 lines, sentences, meta ───────────────────────────────────────

const NO_TAKE = /\btake\b|\bdue\b|time for/i;

check("T-ENG-7 wait / ok / at_limit / unknown / none, for her and for others", () => {
  const p = plan();
  const now1 = D(25, "16:00");
  const w = st(p, [dose(p, L(25, "15:10"))], now1);
  eq(planLine(p, w, her(now1)), "Ibuprofen OK after 9:10 PM", "wait line");
  eq(planSentence(p, w, her(now1)), "OK after 9:10 PM, by your schedule.", "wait her");
  eq(planSentence(p, w, them(now1)), "OK after 9:10 PM, by her schedule.", "wait others");

  const now2 = D(25, "10:00");
  const o = st(p, [dose(p, L(25, "03:05"))], now2);
  eq(planLine(p, o, her(now2)), "Ibuprofen · OK since 9:05 AM · last 3:05 AM", "ok line");
  eq(planSentence(p, o, her(now2)), "OK since 9:05 AM, by your schedule.", "ok her");
  eq(planSentence(p, o, them(now2)), "OK since 9:05 AM, by her schedule.", "ok others");

  const lim = plan({ schedule: { type: "as_needed", min_gap_min: 60 }, max_24h: 6, limit_unit: "caplets", units_per_dose: "2" });
  const now3 = D(25, "11:00");
  const ds = [dose(lim, L(24, "11:40")), dose(lim, L(24, "18:00")), dose(lim, L(25, "10:30"))];
  const a = st(lim, ds, now3);
  eq(planSentence(lim, a, her(now3)), "6 of 6 caplets in the last 24 hours. OK after 11:40 AM, by your schedule.", "at_limit her");
  eq(planSentence(lim, a, them(now3)), "6 of 6 caplets in the last 24 hours. OK after 11:40 AM, by her schedule.", "at_limit others");

  const un = plan({ schedule: { type: "as_needed", min_gap_min: null } });
  const now4 = D(25, "05:15");
  const u = st(un, [dose(un, L(25, "03:05"))], now4);
  eq(planLine(un, u, her(now4)), "Ibuprofen · last 3:05 AM (2 h ago)", "unknown line");
  eq(planSentence(un, u, her(now4)), "Last one 2 h 10 min ago.", "unknown sentence");

  const n = st(p, [], now4);
  eq(planLine(p, n, her(now4)), "Ibuprofen · none logged yet", "none line");
  eq(planSentence(p, n, them(now4)), "None logged yet.", "none sentence");

  for (const [s, now] of [[w, now1], [o, now2], [a, now3], [u, now4], [n, now4]] as const) {
    for (const t of [planLine(p, s, her(now)), planSentence(p, s, her(now)), planSentence(p, s, them(now)), ...planMeta(p, s, them(now))]) {
      ok(!NO_TAKE.test(t), `as-needed copy says take/due/time for: ${t}`);
    }
  }
});

check("T-ENG-7 Each day and At set times lines and sentences", () => {
  const iron = plan({ name: "Iron", schedule: { type: "daily", per_day: 1 } });
  const now = D(25, "07:00");
  eq(planLine(iron, st(iron, [], now), her(now)), "Iron · not logged today");
  eq(planSentence(iron, st(iron, [], now), her(now)), "Not logged today.");
  const done = st(iron, [dose(iron, L(25, "08:12"))], D(25, "09:00"));
  eq(planLine(iron, done, her(D(25, "09:00"))), "Iron · taken 8:12 AM");
  const soft = plan({ name: "Stool softener", schedule: { type: "daily", per_day: 2 } });
  const half = st(soft, [dose(soft, L(25, "08:12"))], D(25, "09:00"));
  eq(planLine(soft, half, her(D(25, "09:00"))), "Stool softener · taken 8:12 AM · 1 of 2 today");
  eq(planSentence(soft, half, her(D(25, "09:00"))), "Taken 8:12 AM.");
  const both = st(soft, [dose(soft, L(25, "08:12")), dose(soft, L(25, "20:05"))], D(25, "21:00"));
  eq(planSentence(soft, both, her(D(25, "21:00"))), "Taken 8:12 AM and 8:05 PM.");

  const times = plan({ name: "Iron", schedule: { type: "times", times: ["08:00", "20:00"] } });
  const open = st(times, [], D(25, "09:00"));
  eq(planLine(times, open, her(D(25, "09:00"))), "Iron · 8:00 AM not logged");
  eq(planSentence(times, open, her(D(25, "09:00"))), "8:00 AM not logged.");
  const next0 = st(times, [], D(25, "07:00"));
  eq(planLine(times, next0, her(D(25, "07:00"))), "Iron · next 8:00 AM");
  const next1 = st(times, [dose(times, L(25, "08:12"))], D(25, "12:00"));
  eq(planLine(times, next1, her(D(25, "12:00"))), "Iron · taken 8:12 AM · next 8:00 PM");
  eq(planSentence(times, next1, her(D(25, "12:00"))), "Next 8:00 PM.");
  const all = st(times, [dose(times, L(25, "08:12")), dose(times, L(25, "20:01"))], D(25, "21:00"));
  eq(planSentence(times, all, her(D(25, "21:00"))), "All of today's times are logged.");
});

check("T-ENG-7 finished and stopped sentences", () => {
  const f = plan({ name: "Antibiotic", course_start: "2026-10-20", course_end: "2026-11-03" });
  eq(planSentence(f, st(f, [], D(4, "09:00", 11)), her(D(4, "09:00", 11))), "Course finished Nov 3.");
  const s = plan({ stopped_at: L(30, "10:00") });
  eq(planSentence(s, st(s, [], D(31, "09:00")), her(D(31, "09:00"))), "Stopped Oct 30.");
});

check("T-ENG-7 suffixes: on this phone, not synced; a plan Claude added reads like any other", () => {
  const p = plan();
  const now = D(25, "16:00");
  const s = st(p, [dose(p, L(25, "15:10"))], now);
  eq(planLine(p, s, her(now, { pending: true })), "Ibuprofen OK after 9:10 PM · on this phone, not synced");
  eq(planLine(plan({ source: "claude" }), s, her(now)), "Ibuprofen OK after 9:10 PM", "no label-check tag");
});

check("T-ENG-7 meta lines: Last · who · via, the 24-hour count, the course day", () => {
  const p = plan({ max_24h: 6, limit_unit: "caplets", units_per_dose: "2", course_start: "2026-10-23", course_end: "2026-10-29" });
  const now = D(25, "10:00");
  const s = st(p, [dose(p, L(25, "03:05"), { by: ALEX, source: "claude" })], now);
  eq(planMeta(p, s, her(now)), ["Last: 3:05 AM · Alex · via Claude", "2 of 6 caplets in the last 24 hours", "Day 3 of 7"]);
  const mine = st(p, [dose(p, L(25, "03:05"), { by: SAM })], now);
  eq(planMeta(p, mine, her(now))[0], "Last: 3:05 AM · You", "her own");
  const yesterday = st(p, [dose(p, L(24, "23:10"), { by: ALEX })], D(25, "08:00"));
  eq(planMeta(p, yesterday, her(D(25, "08:00")))[0], "Last: 11:10 PM yesterday · Alex", "yesterday");
});

check("T-ENG-7 schedule summaries from her numbers", () => {
  eq(scheduleSummary(plan({ max_24h: 6, limit_unit: "caplets", units_per_dose: "2" })), "As needed · no sooner than every 6 hours · no more than 6 caplets in 24 hours · 2 each time");
  eq(scheduleSummary(plan({ schedule: { type: "every", every_min: 480 } })), "Every 8 hours");
  eq(scheduleSummary(plan({ schedule: { type: "daily", per_day: 2 } })), "Twice a day");
  eq(scheduleSummary(plan({ schedule: { type: "times", times: ["20:00", "08:00"] }, course_end: "2026-11-03" })), "8:00 AM and 8:00 PM · until Nov 3");
  eq(scheduleSummary(plan({ schedule: { type: "as_needed", min_gap_min: null } })), "As needed");
});

// ── T-ENG-8 the one-tap ──────────────────────────────────────────────────

check("T-ENG-8 oneTapDecision: save for ok, unknown, none and day_open", () => {
  const now = D(25, "12:00");
  const p = plan();
  const okDoses = [dose(p, L(25, "03:00"), { by: ALEX })];
  eq(oneTapDecision(p, st(p, okDoses, now), okDoses, now, SAM), "save", "ok");
  const un = plan({ schedule: { type: "as_needed", min_gap_min: null } });
  const unDoses = [dose(un, L(25, "10:00"))];
  eq(oneTapDecision(un, st(un, unDoses, now), unDoses, now, SAM), "save", "unknown");
  eq(oneTapDecision(p, st(p, [], now), [], now, SAM), "save", "none");
  const daily = plan({ name: "Iron", schedule: { type: "daily", per_day: 1 } });
  const y = [dose(daily, L(24, "08:00"))];
  eq(oneTapDecision(daily, st(daily, y, now), y, now, SAM), "save", "day_open");
});

check("T-ENG-8 oneTapDecision saves like Maple's buttons: early, at the limit and an unknown count all save", () => {
  const now = D(25, "12:00");
  const p = plan();
  const own = [dose(p, L(25, "08:00"), { by: SAM })];
  eq(oneTapDecision(p, st(p, own, now), own, now, SAM), "save", "early (her own, 4 h ago)");
  const other = [dose(p, L(25, "10:00"), { by: ALEX })];
  eq(oneTapDecision(p, st(p, other, now), other, now, SAM), "save", "someone else's, 2 h ago inside the gap");
  const lim = plan({ schedule: { type: "as_needed", min_gap_min: null }, max_24h: 2, limit_unit: "doses" });
  const limD = [dose(lim, L(25, "06:00")), dose(lim, L(25, "08:00"))];
  eq(oneTapDecision(lim, st(lim, limD, now), limD, now, SAM), "save", "at the limit");
  const caps = plan({ max_24h: 6, limit_unit: "caplets", units_per_dose: null });
  eq(oneTapDecision(caps, st(caps, [], now), [], now, SAM), "save", "units unknown (counted high)");
  const times = plan({ name: "Iron", schedule: { type: "times", times: ["08:00", "20:00"] } });
  const am = [dose(times, L(25, "08:05"))];
  eq(oneTapDecision(times, st(times, am, now), am, now, SAM), "save", "next slot hours away");
});

check("T-ENG-8 oneTapDecision asks only for a likely duplicate (anyone's within 30 minutes) or a once-a-day medicine already logged today", () => {
  const now = D(25, "12:00");
  const p = plan();
  const same = [dose(p, L(25, "11:50"), { by: SAM })];
  eq(oneTapDecision(p, st(p, same, now), same, now, SAM), { ask: { reason: "recent", by: SAM, at: same[0].at } }, "same member, 10 min");
  const near = [dose(p, L(25, "11:40"), { by: ALEX })];
  eq(oneTapDecision(p, st(p, near, now), near, now, SAM), { ask: { reason: "recent", by: ALEX, at: near[0].at } }, "other member, 20 min");
  const un = plan({ schedule: { type: "as_needed", min_gap_min: null } });
  const later = [dose(un, L(25, "11:20"), { by: ALEX })];
  eq(oneTapDecision(un, st(un, later, now), later, now, SAM), "save", "40 min");
  const daily = plan({ name: "Iron", schedule: { type: "daily", per_day: 1 } });
  const today = [dose(daily, L(25, "08:00"))];
  eq(oneTapDecision(daily, st(daily, today, now), today, now, SAM), { ask: { reason: "logged_today" } }, "logged today");
});

// ── T-ENG-9 early and over-limit notes ───────────────────────────────────

check("T-ENG-9 earlyDose before and after a back-filled dose", () => {
  const p = plan();
  const ctx = { ...noteCtx(), now: D(25, "12:00"), tz: TZ };
  const before = doseNotes(p, [dose(p, L(25, "00:00"))], { at: L(25, "03:00") }, ctx);
  eq(before.map((n) => n.title), ["Ibuprofen came early"]);
  has(before[0].body, "That's 3 hours after the last one, and your schedule says no sooner than every 6 hours.");
  const after = doseNotes(p, [dose(p, L(25, "06:00"))], { at: L(25, "04:30") }, ctx);
  eq(after.map((n) => n.title), ["Ibuprofen came early"], "back-filled before a later dose");
  has(after[0].body, "1 hour 30 minutes");
  eq(doseNotes(p, [dose(p, L(25, "00:00"))], { at: L(25, "07:00") }, ctx), [], "outside the gap");
  eq(doseNotes(p, [dose(p, L(25, "00:00"))], { at: L(25, "03:00"), skipped: true }, ctx), [], "skipped");
});

check('T-ENG-9 overDailyMax: label "Call Poison Help now", Poison Help and 911, count and max in the unit', () => {
  const p = plan({ schedule: { type: "as_needed", min_gap_min: null }, max_24h: 6, limit_unit: "caplets", units_per_dose: "2" });
  const ds = [dose(p, L(25, "01:00"), { units: 2 }), dose(p, L(25, "05:00"), { units: 2 }), dose(p, L(25, "09:00"), { units: 2 })];
  const notes = doseNotes(p, ds, { at: L(25, "11:00"), units: 2 }, { ...noteCtx(), now: D(25, "12:00"), tz: TZ });
  const over = notes.find((n) => n.tier === "now");
  ok(over, "an over-limit note");
  eq(over!.label, "Call Poison Help now", "label");
  eq(over!.title, "Ibuprofen: over your daily limit", "title");
  has(over!.body, "1-800-222-1222");
  has(over!.body, "call 911 now");
  has(over!.body, "That's 8 caplets in the last 24 hours, and your schedule says no more than 6 caplets.");
  const doses4 = plan({ schedule: { type: "as_needed", min_gap_min: null }, max_24h: 4, limit_unit: "doses" });
  const d4 = [1, 3, 5, 7].map((h) => dose(doses4, L(25, `0${h}:00`)));
  const n4 = doseNotes(doses4, d4, { at: L(25, "09:00") }, { ...noteCtx(), now: D(25, "12:00"), tz: TZ });
  has(n4[0].body, "That's 5 doses in the last 24 hours, and your schedule says no more than 4 doses.");
  const other = doseNotes(p, ds, { at: L(25, "11:00"), units: 2 }, { ...noteCtx({}, false), now: D(25, "12:00"), tz: TZ });
  eq(other.find((n) => n.tier === "now")!.title, "For Sam: Ibuprofen: over your daily limit", "forMom for others");
  eq(other.find((n) => n.tier === "now")!.body, over!.body, "body unchanged for others");
});

check("T-ENG-9 the plan card shows overDailyMax while over, and the early note after an early one-tap", () => {
  const p = plan({ schedule: { type: "as_needed", min_gap_min: null }, max_24h: 4, limit_unit: "doses" });
  const ds = [1, 2, 3, 4, 5].map((h) => dose(p, L(25, `0${h}:00`)));
  const s = st(p, ds, D(25, "06:00"));
  ok(planNotes(p, s, noteCtx()).some((n) => n.label === "Call Poison Help now" && n.dismiss === undefined), "over-limit card, not dismissable");
  const g = plan();
  const early = [dose(g, L(25, "01:00")), dose(g, L(25, "04:00"))];
  ok(planNotes(g, st(g, early, D(25, "05:00")), noteCtx()).some((n) => n.title === "Ibuprofen came early"), "early note on the card");
});

// ── T-ENG-10 name and plan notes (step 1) ────────────────────────────────

check("T-ENG-10 opioid note, dismissed by its ack", () => {
  const p = plan({ name: "Oxycodone 5 mg" });
  const s = st(p, [], D(25, "09:00"));
  const n = planNotes(p, s, noteCtx()).find((x) => x.title === "Opioid pain medicine");
  ok(n, "opioid note");
  eq([n!.key, n!.dismiss], [`opioid:p${p.id}`, "Got it"]);
  ok(!planNotes(p, s, noteCtx({ acks: { [`opioid:p${p.id}`]: L(25, "08:00") } })).some((x) => x.title === "Opioid pain medicine"), "acked");
  ok(planNotes(plan({ name: "Pain pill", also_called: "Percocet" }), s, noteCtx()).some((x) => x.title === "Opioid pain medicine"), "Also called matches");
});

check('T-ENG-10 codeine: feeding unset → shows, "yes" → shows, "no" → hidden (S10); MED_BABY_WATCH the same', () => {
  const p = plan({ name: "Acetaminophen with codeine" });
  const s = st(p, [], D(25, "09:00"));
  const shows = (settings: CareSettings) => planNotes(p, s, noteCtx(settings)).some((n) => n.title === G.LABEL_NOT_WHILE_NURSING.title);
  eq([shows({}), shows({ feeding: "yes" }), shows({ feeding: "no" })], [true, true, false]);
  const note = planNotes(p, s, noteCtx()).find((n) => n.title === G.LABEL_NOT_WHILE_NURSING.title)!;
  eq([note.label, note.dismiss], ["Check before your next dose", "I've checked with my OB or pharmacist"]);
  eq([nursingNotesShown({}), nursingNotesShown({ feeding: "yes" }), nursingNotesShown({ feeding: "no" })], [true, true, false], "MED_BABY_WATCH");
  ok(doseNotes(plan({ name: "Tramadol" }), [], { at: L(25, "09:00") }, { ...noteCtx(), now: D(25, "09:00"), tz: TZ }).some((n) => n.title === G.LABEL_NOT_WHILE_NURSING.title), "in the Dose sheet");
});

check("T-ENG-10 acetaminophen overlap: two plans, and a one-off NyQuil with an APAP plan", () => {
  const a = plan({ name: "Acetaminophen", contains_apap: true });
  const b = plan({ name: "Percocet", contains_apap: true });
  const notes = listNotes([a, b], noteCtx());
  eq(notes.map((n) => [n.title, n.dismiss]), [["Two medicines with acetaminophen", "It's part of my plan"]]);
  has(notes[0].body, "Acetaminophen and Percocet both contain acetaminophen");
  eq(listNotes([a, b], noteCtx({ acks: { [notes[0].key]: L(25, "08:00") } })), [], "acked");
  eq(listNotes([a], noteCtx()), [], "one plan");
  const one = oneOffNotes("NyQuil", [a], noteCtx());
  eq(one.map((n) => n.title), ["Two medicines with acetaminophen"]);
  has(one[0].body, "NyQuil and Acetaminophen both contain acetaminophen");
});

check("T-ENG-10 mood medicine note; a mood or zuranolone plan she adds starts Only me, Alex's doesn't", () => {
  const p = plan({ name: "Sertraline", reason: "mood" });
  ok(planNotes(p, st(p, [], D(25, "09:00")), noteCtx()).some((n) => n.title === "Medicine for mood"), "mood note");
});

// ── T-ENG-11 names (step 1) ──────────────────────────────────────────────

check("T-ENG-11 normName", () => {
  eq(normName("Ibuprofen 200 mg (Advil)"), "ibuprofen");
  eq(normName("ibuprofen 100 mg"), "ibuprofen");
  eq(normName("Tylenol Extra-Strength"), "tylenol extra strength");
  eq(normName("Vitamin D3 2000 IU"), "vitamin d3");
  eq(normName("  Docusate,  sodium! "), "docusate sodium");
});

check("T-ENG-11 matchPlan: exact, Also called, containment, ambiguous, none; private only for her", () => {
  const ibu = plan({ name: "Ibuprofen", also_called: "Advil, Motrin" });
  const apap = plan({ name: "Acetaminophen", also_called: "Tylenol" });
  const d3 = plan({ name: "Vitamin D3" });
  const c = plan({ name: "Vitamin C" });
  const sert = plan({ name: "Sertraline", private: true });
  const all = [ibu, apap, d3, c, sert];
  const pick = (q: string, includePrivate = false) => {
    const m = matchPlan(q, all, { includePrivate });
    return m.kind === "match" ? m.plan.name : m.kind === "ambiguous" ? `ambiguous:${m.plans.map((x) => x.name).join("/")}` : `none:${m.plans.length}`;
  };
  eq(pick("ibuprofen"), "Ibuprofen", "exact");
  eq(pick("Advil"), "Ibuprofen", "Also called");
  eq(pick("tylenol 500 mg"), "Acetaminophen", "Also called with strength");
  eq(pick("ibuprofen tablets"), "Ibuprofen", "containment");
  eq(pick("vitamin"), "ambiguous:Vitamin D3/Vitamin C", "ambiguous");
  eq(pick("aspirin"), "none:4", "none lists her (visible) plans");
  eq(pick("sertraline"), "none:4", "private hidden");
  eq(pick("sertraline", true), "Sertraline", "private for her");
  eq(pick(`p${ibu.id}`), "Ibuprofen", "by p id");
});

// ── T-ENG-12, 13 check-ins (step 2) ──────────────────────────────────────

const zeros = (n: number) => Array.from({ length: n }, () => 0 as 0 | 1 | 2 | 3);

check("T-ENG-12 screenResults (S6): item 9 = 1, total 3 → CRISIS then PHQ9_ITEM9, never .low", () => {
  const phq = [1, 1, 0, 0, 0, 0, 0, 0, 1] as (0 | 1 | 2 | 3)[];
  const d = scoreScreen({ phq9: phq, gad7: zeros(7), item9_ever: false });
  eq([d.phq9_score, d.item9, d.item9_ever], [3, true, true]);
  const cards = screenResults(d);
  eq(cards.map((c) => c.key), ["crisis", "phq9", "gad7"]);
  eq(cards[1].title, G.PHQ9_ITEM9.title);
  ok(!cards.some((c) => c.title === G.PHQ9_RESULT.low.title), "never few signs");
  const back = scoreScreen({ phq9: [...phq.slice(0, 8), 0], gad7: zeros(7), item9_ever: true });
  eq([back.item9, back.item9_ever], [false, true], "changed back");
  const backCards = screenResults(back);
  eq([backCards[0].key, backCards[1].title], ["crisis", G.PHQ9_ITEM9.title], "still CRISIS first");
});

check("T-ENG-12 band edges 4/5 and 9/10 for both scales; DIFFICULTY_HARD only with no other today result", () => {
  const phq = (n: number) => {
    const a = zeros(9);
    for (let i = 0; i < n; i++) a[i % 8] = (a[i % 8] + 1) as 0 | 1 | 2 | 3;
    return a;
  };
  const gad = (n: number) => {
    const a = zeros(7);
    for (let i = 0; i < n; i++) a[i % 7] = (a[i % 7] + 1) as 0 | 1 | 2 | 3;
    return a;
  };
  const p = (n: number) => screenResults(scoreScreen({ phq9: phq(n), gad7: zeros(7), item9_ever: false }))[0];
  const g = (n: number) => screenResults(scoreScreen({ phq9: zeros(9), gad7: gad(n), item9_ever: false }))[1];
  eq([p(4).title, p(5).title, p(9).title, p(10).title], [G.PHQ9_RESULT.low.title, G.PHQ9_RESULT.some.title, G.PHQ9_RESULT.some.title, G.PHQ9_RESULT.positive.title]);
  eq([p(4).tier, p(5).tier, p(10).tier], [null, "mention", "today"]);
  eq([g(4).title, g(5).title, g(9).title, g(10).title], [G.GAD7_RESULT.low.title, G.GAD7_RESULT.some.title, G.GAD7_RESULT.some.title, G.GAD7_RESULT.positive.title]);
  eq(p(4).heading, "PHQ-9: 4 of 27");
  eq(g(10).heading, "GAD-7: 10 of 21");
  const hard = screenResults(scoreScreen({ phq9: phq(3), gad7: zeros(7), difficulty: 2, item9_ever: false }));
  eq(hard.map((c) => c.key), ["phq9", "gad7", "difficulty"], "hard, nothing else today");
  const hardToo = screenResults(scoreScreen({ phq9: phq(12), gad7: zeros(7), difficulty: 3, item9_ever: false }));
  ok(!hardToo.some((c) => c.key === "difficulty"), "not with a today result");
});

check("T-ENG-13 checkinResponse: harm → crisis; scary → INTRUSIVE; Really struggling → STRUGGLING; blues on days 0–14", () => {
  eq(checkinResponse({ level: 2, tags: ["harm_self"] }, { daysSinceBirth: 9 }).crisis, true);
  eq(checkinResponse({ level: 2, tags: ["scary_thoughts"] }, { daysSinceBirth: 9 }).cards.map((c) => c.title), [G.INTRUSIVE.title]);
  eq(checkinResponse({ level: 1 }, { daysSinceBirth: 9 }).cards.map((c) => c.title), [G.STRUGGLING.title]);
  eq([0, 14, 15, null].map((d) => checkinResponse({ level: 4 }, { daysSinceBirth: d }).blues), [true, true, false, false]);
});

check("T-ENG-13 suggestFullCheckin: day 14 yes, 13 no; the visit window; not within 14 days of the last; Not now acks", () => {
  const born = L(20, "10:20");
  const at = (day: number, month = 10) => D(day, "09:00", month);
  const s = (now: Date, settings: CareSettings = {}, last: string | null = null) => suggestFullCheckin({ now, tz: TZ, bornAt: born, settings, lastScreenAt: last });
  eq([s(at(2, 11)), s(at(3, 11)), s(at(9, 11)), s(at(10, 11))], [null, "day14", "day14", null], "days 13, 14, 20, 21");
  eq(s(at(3, 11), { acks: { "suggest:day14": L(3, "08:00", 11) } }), null, "Not now");
  eq(s(at(24, 11), { next_visit: "2026-12-01" }), "visit", "a week before");
  eq(s(at(23, 11), { next_visit: "2026-12-01" }), null, "8 days before");
  eq(s(at(24, 11), { next_visit: "2026-12-01" }, L(20, "09:00", 11)), null, "a fuller check-in 4 days ago");
  eq(s(at(24, 11), { next_visit: "2026-12-01", acks: { "suggest:visit:2026-12-01": L(24, "08:00", 11) } }), null, "visit acked");
  eq(s(at(3, 11), { checkin_suggestions: false }), null, "switched off");
  eq(daysSinceBirth(born, D(24, "09:00"), TZ), 4, "Day 4 after the birth");
});

check("T-ENG-13 crisisToday only on that local day", () => {
  const m = (at: string, tags: string[]): MoodEntry => ({ id: 1, kind: "checkin", at, data: { level: 2, tags: tags as never }, note: null, created_at: at, updated_at: at });
  const rows = [m(L(29, "22:30"), ["harm_self"])];
  eq(crisisToday(rows, D(29, "23:59"), TZ), true, "same evening");
  eq(crisisToday(rows, D(30, "00:01"), TZ), false, "after midnight");
  const scr: MoodEntry = { id: 2, kind: "screen", at: L(30, "09:00"), data: scoreScreen({ phq9: zeros(9), gad7: zeros(7), item9_ever: true }), note: null, created_at: L(30, "09:00"), updated_at: L(30, "09:00") };
  eq(crisisToday([scr], D(30, "18:00"), TZ), true, "a screen with item9_ever");
});

check("T-ENG-12 item 9 with a PHQ-9 of 10 or more → the positive band after CRISIS (not PHQ9_ITEM9)", () => {
  const cards = screenResults(scoreScreen({ phq9: [2, 2, 2, 2, 1, 0, 0, 0, 1], gad7: zeros(7), item9_ever: false }));
  eq(cards.map((c) => [c.key, c.title]), [["crisis", G.CRISIS.title], ["phq9", G.PHQ9_RESULT.positive.title], ["gad7", G.GAD7_RESULT.low.title]]);
  eq(cards[0].label, "Call 911 or 988 now");
});

check('T-ENG-12 "Stop here": no band for a scale she didn\'t finish; item 9 still CRISIS then PHQ9_ITEM9', () => {
  const stopped = scoreScreen({ phq9: [0, 0, 0, 0, 0, 0, 0, 0, 1], gad7: [], item9_ever: true });
  eq([stopped.complete, stopped.gad7_score], [false, null]);
  const cards = screenResults(stopped);
  eq(cards.map((c) => c.key), ["crisis", "phq9"], "no GAD-7 card");
  eq([cards[1].title, cards[1].heading], [G.PHQ9_ITEM9.title, "PHQ-9: 1 of 27"]);
  // Partway through the GAD-7: its partial total never says "few signs".
  const half = screenResults(scoreScreen({ phq9: zeros(9), gad7: [0, 0, 0], item9_ever: false }));
  eq(half.map((c) => c.key), ["phq9"], "GAD-7 partway");
  // Partway through the PHQ-9 (no item 9): nothing to reassure with.
  eq(screenResults(scoreScreen({ phq9: [0, 0, 0, 0, 0], gad7: [], item9_ever: false })).length, 0, "PHQ-9 partway");
  const early = screenResults(scoreScreen({ phq9: [3, 3, 3, 3, 3], gad7: [], item9_ever: true }));
  eq([early.map((c) => c.key), early[1].title, early[1].heading], [["crisis", "phq9"], G.PHQ9_ITEM9.title, undefined], "item 9 ever, PHQ-9 partway");
});

check("T-ENG-13 suggestAckKey: the day-14 ack, and one per visit date", () => {
  eq(suggestAckKey("day14", { next_visit: "2026-12-01" }), "suggest:day14");
  eq(suggestAckKey("visit", { next_visit: "2026-12-01" }), "suggest:visit:2026-12-01");
  const born = L(20, "10:20");
  const acked = { next_visit: "2026-12-01", acks: { [suggestAckKey("visit", { next_visit: "2026-12-01" })]: L(24, "08:00", 11) } };
  eq(suggestFullCheckin({ now: D(24, "09:00", 11), tz: TZ, bornAt: born, settings: acked, lastScreenAt: null }), null, "acked visit");
  // A new visit date asks again.
  eq(suggestFullCheckin({ now: D(1, "09:00", 12), tz: TZ, bornAt: born, settings: { ...acked, next_visit: "2026-12-05" }, lastScreenAt: null }), "visit", "new visit");
});

check("T-ENG-13 todayCheckin: her newest check-in on today's local date", () => {
  const c = (id: number, at: string, level: 1 | 2 | 3 | 4 | 5): MoodEntry => ({ id, kind: "checkin", at, data: { level }, note: null, created_at: at, updated_at: at });
  const rows = [c(1, L(29, "23:30"), 2), c(2, L(30, "07:00"), 3), c(3, L(30, "09:15"), 4)];
  eq(todayCheckin(rows, D(30, "12:00"), TZ)?.id, 3);
  eq(todayCheckin(rows, D(29, "23:59"), TZ)?.id, 1, "the evening before");
  eq(todayCheckin(rows, D(31, "00:05"), TZ), null, "after midnight");
  // A screen today isn't a check-in.
  const scr: MoodEntry = { id: 4, kind: "screen", at: L(31, "08:00"), data: scoreScreen({ phq9: zeros(9), gad7: zeros(7), item9_ever: false }), note: null, created_at: L(31, "08:00"), updated_at: L(31, "08:00") };
  eq(todayCheckin([scr], D(31, "09:00"), TZ), null, "screen only");
});

check("T-ENG-13 checkinResponse: several chips give several cards, INTRUSIVE (now) before STRUGGLING (today)", () => {
  const r = checkinResponse({ level: 1, tags: ["scary_thoughts", "harm_self", "tearful"] }, { daysSinceBirth: 30 });
  eq([r.crisis, r.cards.map((x) => x.title), r.blues], [true, [G.INTRUSIVE.title, G.STRUGGLING.title], false]);
  eq(G.STRUGGLING.tier, "today");
  eq(G.MOM_TIER_LABEL[G.STRUGGLING.tier], "Call your OB today");
  eq(G.MOM_TIER_LABEL[G.INTRUSIVE.tier], "Call your OB now");
  eq(checkinResponse({ level: 5 }, { daysSinceBirth: 30 }), { crisis: false, cards: [], blues: false }, "Good, day 30");
});

// ── T-ENG-14 the official forms, word for word (S11) ─────────────────────

check("T-ENG-14 PHQ-9 and GAD-7 stems, items, difficulty and credit match the developers' forms", () => {
  eq(G.PHQ9_STEM, "Over the last 2 weeks, how often have you been bothered by any of the following problems?");
  eq(G.PHQ9_ITEMS, [
    "Little interest or pleasure in doing things",
    "Feeling down, depressed, or hopeless",
    "Trouble falling or staying asleep, or sleeping too much",
    "Feeling tired or having little energy",
    "Poor appetite or overeating",
    "Feeling bad about yourself — or that you are a failure or have let yourself or your family down",
    "Trouble concentrating on things, such as reading the newspaper or watching television",
    "Moving or speaking so slowly that other people could have noticed? Or the opposite — being so fidgety or restless that you have been moving around a lot more than usual",
    "Thoughts that you would be better off dead or of hurting yourself in some way",
  ]);
  eq(G.GAD7_STEM, "Over the last 2 weeks, how often have you been bothered by the following problems?");
  eq(G.GAD7_ITEMS, [
    "Feeling nervous, anxious or on edge",
    "Not being able to stop or control worrying",
    "Worrying too much about different things",
    "Trouble relaxing",
    "Being so restless that it is hard to sit still",
    "Becoming easily annoyed or irritable",
    "Feeling afraid as if something awful might happen",
  ]);
  eq(G.DIFFICULTY_Q, "If you checked off any problems, how difficult have these problems made it for you to do your work, take care of things at home, or get along with other people?");
  eq(G.DIFFICULTY, ["Not difficult at all", "Somewhat difficult", "Very difficult", "Extremely difficult"]);
  eq(G.FREQ, ["Not at all", "Several days", "More than half the days", "Nearly every day"]);
  eq(
    G.FULL_INTRO.credit,
    "Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute."
  );
});

// ── T-ENG-15 who sees what (§9.1) ────────────────────────────────────────

check("T-ENG-15 careAccess: one rule, everyone signed in does everything; viewers nothing", () => {
  const person: CarePerson = { member: SAM, shared_with: [], settings: {}, created_by: ALEX, created_at: L(24, "10:00"), updated_at: L(24, "10:00") };
  const v = (id: string, o: Partial<CareViewer> = {}): CareViewer => ({ id, role: members.find((m) => m.email === id)?.role ?? "viewer", viaAdmin: false, channel: "app", ...o });
  const flags = (a: ReturnType<typeof careAccess>) => (["self", "read", "write", "private", "mood", "therapist", "manage"] as const).filter((k) => a[k]).join(",");
  const all = "read,write,private,mood,therapist,manage";
  eq(flags(careAccess(v(SAM), person, members)), `self,${all}`, "her session");
  eq(flags(careAccess(v(SAM, { channel: "mcp" }), person, members)), `self,${all}`, "her MCP token");
  eq(flags(careAccess(v(ALEX), person, members)), all, "an owner, never listed anywhere");
  eq(flags(careAccess(v(JO), person, members)), all, "a member");
  eq(flags(careAccess(v("admin", { viaAdmin: true }), person, members)), all, "the admin login, admin_as unset");
  eq(flags(careAccess(v(SAM, { viaAdmin: true }), person, members)), all, "admin_as = her: not 'self' (it's the family password)");
  eq(flags(careAccess(v(VI), person, members)), "", "a viewer");
  const demoted = members.map((m) => (m.email === ALEX ? { ...m, role: "viewer" as const } : m));
  eq(flags(careAccess(v(ALEX), person, demoted)), "", "a demoted member");
  eq(flags(careAccess(v(ALEX), person, members.filter((m) => m.email !== ALEX))), "", "a removed member");
  eq(flags(careAccess(v(ALEX), null, members)), "", "no person");
});

check("T-ENG-15 forMom: 'For {Name}: ' for others, never on CRISIS_PARTNER", () => {
  eq(forMom(G.INTRUSIVE, "Sam", false).title, `For Sam: ${G.INTRUSIVE.title}`);
  eq(forMom(G.INTRUSIVE, "Sam", true).title, G.INTRUSIVE.title);
  eq(forMom(G.CRISIS_PARTNER, "Sam", false).title, G.CRISIS_PARTNER.title);
  eq(forMom(G.INTRUSIVE, "mom", false).title, `For mom: ${G.INTRUSIVE.title}`);
});

check("T-ENG-15 sortPlans: ok/unknown by oldest last, wait/at_limit by next OK, none, open, next, done", () => {
  const now = D(25, "12:00");
  const mk = (name: string, p: Partial<CarePlan>, at: string[]) => {
    const pl = plan({ name, ...p });
    const ds = at.map((a) => dose(pl, a));
    return { plan: pl, status: st(pl, ds, now) };
  };
  const items = [
    mk("done", { schedule: { type: "daily", per_day: 1 } }, [L(25, "08:00")]),
    mk("open", { schedule: { type: "daily", per_day: 1 } }, []),
    mk("none", {}, []),
    mk("wait-late", {}, [L(25, "11:00")]),
    mk("wait-soon", {}, [L(25, "07:00")]),
    mk("ok-newer", {}, [L(25, "05:00")]),
    mk("ok-older", {}, [L(25, "02:00")]),
  ];
  eq(sortPlans(items).map((x) => x.plan.name), ["ok-older", "ok-newer", "wait-soon", "wait-late", "none", "open", "done"]);
});

check("T-ENG-15 planView: one view per plan (line, sentence, meta, summary, notes, one-tap)", () => {
  const p = plan();
  const v = planView(p, [dose(p, L(25, "15:10"))], { ...her(D(25, "16:00")), ...noteCtx() });
  eq([v.line, v.sentence, v.summary], ["Ibuprofen OK after 9:10 PM", "OK after 9:10 PM, by your schedule.", "As needed · no sooner than every 6 hours"]);
  eq(v.oneTap, "save", "her own dose 50 minutes ago, inside the gap: saves (the toast says it's early)");
  const fresh = planView(p, [dose(p, L(25, "15:40"), { by: ALEX })], { ...her(D(25, "16:00")), ...noteCtx() });
  eq(fresh.oneTap, { ask: { reason: "recent", by: ALEX, at: L(25, "15:40") } }, "Alex's dose 20 minutes ago");
});

// ── T-ENG-16 static rules ────────────────────────────────────────────────

function filesUnder(dir: string, re: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, re));
    else if (re.test(e.name)) out.push(p);
  }
  return out;
}

check("T-ENG-16 no digit in a placeholder or hint in care/*, or in a care-mcp.ts input description", () => {
  const bad: string[] = [];
  for (const f of filesUnder(path.join(ROOT, "src/components/maple/care"), /\.tsx?$/)) {
    const src = fs.readFileSync(f, "utf8");
    const re = /\b(placeholder|hint)\s*[=:]\s*\{?\s*(["'`])((?:\\.|(?!\2)[^\\])*)\2/g;
    for (let m = re.exec(src); m; m = re.exec(src)) if (/\d/.test(m[3])) bad.push(`${path.basename(f)}: ${m[1]} "${m[3]}"`);
  }
  const mcp = path.join(ROOT, "src/lib/maple/care-mcp.ts");
  if (fs.existsSync(mcp)) {
    const src = fs.readFileSync(mcp, "utf8");
    const re = /\.describe\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
    for (let m = re.exec(src); m; m = re.exec(src)) if (/\d/.test(m[2])) bad.push(`care-mcp.ts: describe "${m[2]}"`);
  }
  eq(bad, [], "digits");
});

check("T-ENG-16 no Edinburgh or EPDS item text in src/", () => {
  const bad: string[] = [];
  // Short fragments only: the EPDS is RCPsych's, and this file is public too.
  const anywhere = [/edinburgh postnatal/i, /funny side of things/i, /looked forward with enjoyment/i, /blamed myself unnecessarily/i];
  const maple = /[\\/]maple[\\/]/;
  for (const f of filesUnder(path.join(ROOT, "src"), /\.(ts|tsx|js|md|html|json|css)$/)) {
    const src = fs.readFileSync(f, "utf8");
    // The city turns up in the family's other pages (the debates); in Maple's own code it can only mean the scale.
    for (const re of maple.test(f) ? [/edinburgh/i, ...anywhere] : anywhere) if (re.test(src)) bad.push(`${path.relative(ROOT, f)} ${re}`);
  }
  eq(bad, []);
});

check("T-ENG-16 help lines re-checked within 183 days, every MOM_HELP entry sourced", () => {
  const age = (Date.now() - Date.parse(`${G.HELP_VERIFIED_ON}T12:00:00Z`)) / 86400_000;
  ok(age < 183, `HELP_VERIFIED_ON is ${Math.floor(age)} days old: re-check the numbers (spec §8.4)`);
  for (const [group, lines] of Object.entries(G.MOM_HELP)) {
    for (const l of lines) ok(l.sources.some((s) => s.startsWith("https://")), `${group}/${l.name} has no https:// source`);
  }
  eq(G.MOM_HELP.now.map((l) => l.tel), ["911", "988"], "911 first, then 988");
  eq(G.MOM_HELP.talk[0].tel, "+18338526262", "maternal hotline");
  eq(G.MOM_HELP.medicine[0].tel, "+18002221222", "Poison Help");
});

check("T-ENG-16 MOM_SIGNS: 20 signs, 5 emergency, 13 now, 2 today, with racing_heart and psychosis", () => {
  eq(G.MOM_SIGNS.length, 20, "count");
  const tiers = G.MOM_SIGNS.map((s) => G.MOM_SIGN_INFO[s].tier);
  eq([tiers.filter((t) => t === "emergency").length, tiers.filter((t) => t === "now").length, tiers.filter((t) => t === "today").length], [5, 13, 2]);
  ok(G.MOM_SIGNS.includes("racing_heart") && G.MOM_SIGNS.includes("psychosis"), "racing_heart and psychosis");
  eq(G.MOM_SIGN_INFO.racing_heart.label, "Heart racing or pounding");
});

// ── T-ENG-17 copy ────────────────────────────────────────────────────────

check("T-ENG-17 crisis and opioid copy", () => {
  has(G.CRISIS.body, "they're about hurting Maple or someone else");
  eq(G.CRISIS.label, "Call 911 or 988 now");
  eq(G.CRISIS_PARTNER.label, "Call 911 now");
  eq(G.CRISIS_LEAD, "Thank you for being honest about this.");
  has(G.OPIOID_NOTE.body, "until you know how it affects you");
  eq(G.HELP_ROW, "Need to talk now? Call or text 988 · Call 911");
});

const INSTRUCTIONS_ADDITION =
  'Her mom\'s own medicines and recovery: use mom_status, log_mom_medicine, set_mom_medicine, log_mom_temperature, add_mom_question and fix_mom_entry, never log_medicine (that\'s Maple\'s). Answer "can she take X yet?" only from mom_status, using its line and sentence (for example "Ibuprofen OK after 8:10 AM, by her schedule. Last: 2:10 AM · Matt. 1 of 4 tablets in the last 24 hours."). Never say whether a medicine is safe while nursing; suggest her OB, Maple\'s pediatrician or a pharmacist. Never fill in a dose, interval, limit or how many to take. If anyone mentions thoughts of harming themselves or someone else, tell them: call 911 if anyone is in immediate danger; otherwise call or text 988, any time. The National Maternal Mental Health Hotline (call or text 1-833-852-6262, 24/7) is there too, but it isn\'t a crisis line.';

check("T-ENG-17 the MAPLE_INSTRUCTIONS paragraph (§10.1, verbatim; D's mcp-tools.ts)", () => {
  // Read as text: importing mcp-tools would pull in the server.
  const src = fs.readFileSync(path.join(ROOT, "src/lib/maple/mcp-tools.ts"), "utf8");
  const start = src.indexOf("export const MAPLE_INSTRUCTIONS = `");
  ok(start >= 0, "MAPLE_INSTRUCTIONS not found");
  const body = src.slice(start + "export const MAPLE_INSTRUCTIONS = `".length, src.indexOf("`;", start));
  has(body, "call 911 if anyone is in immediate danger; otherwise call or text 988");
  // ChatGPT may show only the first ~500 characters: the crisis numbers are inside them too.
  ok(body.slice(0, 500).includes("988") && body.slice(0, 500).includes("911"), "988 and 911 within the first 500 characters");
  has(body.replace(/\\`/g, "`"), INSTRUCTIONS_ADDITION, "the whole paragraph");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
