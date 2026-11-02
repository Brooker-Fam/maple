/**
 * Sleep goals' rules: pure functions shared by the app, the REST route and
 * the MCP tools (checked by scripts/maple-sleep-check.ts).
 *
 * - A goal's weeks run 7 nights at a time from the night it was set (the
 *   family's calendar date it was made), through its target date, or the
 *   last 4 weeks without one. Nights are try days (noon to noon, engine.ts
 *   tryDayKey), so a 2 AM try belongs to the evening before it, and a
 *   daylight-saving night is still one night.
 * - Every count says what it's out of ("3 of 5 nights"). No scores,
 *   streaks, grades, "failed" or best times; hard nights are counts too.
 * - Check-ins are the adults' own. A reader who can't see them (a
 *   view-only guest) gets null where their counts would be, never zeros.
 * - Roster hints read the log inside each adult's protected window (feeds,
 *   holding turns, tries): hints for the family, not verdicts.
 * - Nothing here is about anyone's health or recovery, and nothing here
 *   changes a goal: the family and the coach do that through the tools.
 */
import { addDays, dayKey, daysBetween, formatDuration, isDayKey, parseDayKey, zonedTimeToUtc } from "../time";
import type { Entry, Role } from "../types";
import type { Voice } from "../voice";
import { sleepByPlace, tryDayBounds, tryDayKey, tryDayLabel } from "./engine";
import { SleepInputError } from "./errors";
import {
  CHECKIN_NIGHTS_BACK,
  GOAL_AHEAD_DAYS,
  GOAL_CUSTOM_MAX,
  GOAL_STEP_TITLE_MAX,
  GOAL_STEPS_MAX,
  GOAL_TARGETS_MAX,
  GOAL_TITLE_MAX,
  GOAL_WHY_MAX,
  PROTECTED_ANSWERS,
  REVIEW_DUE_DAYS,
  ROSTER_MAX,
  TARGET_KINDS,
  WINDOW_MAX_MINUTES,
  WINDOW_MIN_MINUTES,
  type BassinetNightsTarget,
  type BassinetStretchTarget,
  type BassinetTry,
  type CustomTarget,
  type GoalInput,
  type GoalStatus,
  type GoalStep,
  type GoalTarget,
  type HoldingShift,
  type ProtectedAnswer,
  type ProtectedWindowTarget,
  type RosterWindow,
  type SleepCheckin,
  type SleepGoal,
} from "./types";
import { dateWords, GOAL_STATUS_LABEL, minutesWords, nightsLabel, PROTECTED_LABEL, targetWords, weekdayOf, windowTimes, windowWords } from "./words";

const MIN = 60_000;
const DAY_MIN = 24 * 60;
const NOON = 12 * 60;
const ms = (iso: string) => Date.parse(iso);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const live = <T extends object>(xs: readonly T[]): T[] => xs.filter((x) => !(x as { deleted_at?: unknown }).deleted_at);
const maxKey = (a: string, b: string) => (a > b ? a : b);
const minKey = (a: string, b: string) => (a < b ? a : b);

/** A goal's ref in tool text: g3 (a log entry is #123, a try t12). */
export const goalRef = (id: number) => `g${id}`;

/**
 * Who reads the adults' check-ins: owners and members, never a view-only
 * guest (or a photos-only one). Goals, steps, the roster and the baby's
 * numbers are for anyone in the family but photos-only guests.
 */
export const seesCheckins = (role: Role) => role === "owner" || role === "member";
/** Who changes goals and saves a check-in (their own only): owners and members. */
export const writesGoals = seesCheckins;

// ── clock windows ────────────────────────────────────────────────────────

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** A local "HH:MM" (24-hour). */
export const isClock = (v: unknown): v is string => typeof v === "string" && CLOCK.test(v);
const clockMin = (hhmm: string) => {
  const m = CLOCK.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};

/** A window's length on the clock, in minutes: from `from` to the next `to` (0 when they're the same). */
export function windowMinutes(from: string, to: string): number {
  return (clockMin(to) - clockMin(from) + DAY_MIN) % DAY_MIN;
}

/** Where a window sits in its night, in minutes after that evening's noon: [start, end). */
function inNight(w: Pick<RosterWindow, "from" | "to">): [number, number] {
  const start = (clockMin(w.from) - NOON + DAY_MIN) % DAY_MIN;
  return [start, start + windowMinutes(w.from, w.to)];
}

/**
 * The instants of a window on the night that begins on `night` (the date of
 * its evening). A time from noon on is that evening's, one before noon the
 * next morning's (as a try day), and the end is the next `to` after the
 * start. Built with zonedTimeToUtc, so across a clock change the real length
 * is an hour off the clock's and nothing shifts.
 */
export function windowOn(w: Pick<RosterWindow, "from" | "to">, night: string, tz: string): [Date, Date] {
  const f = clockMin(w.from);
  const startDay = f < NOON ? addDays(night, 1) : night;
  const endAt = f + windowMinutes(w.from, w.to);
  const endDay = addDays(startDay, Math.floor(endAt / DAY_MIN));
  const e = endAt % DAY_MIN;
  const a = parseDayKey(startDay);
  const b = parseDayKey(endDay);
  return [zonedTimeToUtc(a.year, a.month, a.day, Math.floor(f / 60), f % 60, tz), zonedTimeToUtc(b.year, b.month, b.day, Math.floor(e / 60), e % 60, tz)];
}

/** The window is on that night: its evening's weekday is one of its nights. */
export const windowOnNight = (w: Pick<RosterWindow, "nights">, night: string) => w.nights.includes(weekdayOf(night));

// ── days ─────────────────────────────────────────────────────────────────

/** The night a morning check-in is about: the one that began yesterday evening, by the family's calendar. */
export const lastNightKey = (now: Date | number, tz: string) => addDays(dayKey(now, tz), -1);

/** The family's calendar date a goal was set: its weeks start with that evening's night. */
export const goalStartKey = (g: Pick<SleepGoal, "created_at">, tz: string) => dayKey(ms(g.created_at), tz);

/** A YYYY-MM-DD that names a real day (not 2026-02-30). */
export const isRealDay = (key: unknown): key is string => isDayKey(key) && addDays(key, 0) === key;

/** Nights a check-in can be for: the last CHECKIN_NIGHTS_BACK, ending with last night. */
export function checkinNights(now: Date | number, tz: string): { first: string; last: string } {
  const last = lastNightKey(now, tz);
  return { first: addDays(last, -(CHECKIN_NIGHTS_BACK - 1)), last };
}

// ── the input rules ──────────────────────────────────────────────────────

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function text(raw: unknown, label: string, max: number, required: boolean): string | null {
  if (raw == null || raw === "") {
    if (required) throw new SleepInputError(`${label} is needed.`);
    return null;
  }
  if (typeof raw !== "string") throw new SleepInputError(`${label} must be text.`);
  const t = raw.replace(CONTROL, "").replace(/\s+/g, " ").trim();
  if (!t) {
    if (required) throw new SleepInputError(`${label} is needed.`);
    return null;
  }
  if (t.length > max) throw new SleepInputError(`${label} is too long (${max} characters at most).`);
  return t;
}

function whole(raw: unknown, label: string, lo: number, hi: number): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < lo || raw > hi) throw new SleepInputError(`${label} must be a whole number from ${lo} to ${hi}.`);
  return raw;
}

/** A review's or a close's note: optional, at most GOAL_NOTE_MAX characters. */
export const cleanGoalNote = (raw: unknown, max: number) => text(raw, "The note", max, false);

/** A check-in's answer. */
export function cleanProtected(raw: unknown): ProtectedAnswer {
  if (!(PROTECTED_ANSWERS as readonly unknown[]).includes(raw)) throw new SleepInputError(`The answer must be ${PROTECTED_ANSWERS.join(", ")}.`);
  return raw as ProtectedAnswer;
}

/** A check-in's night: one of the last CHECKIN_NIGHTS_BACK, ending with last night (a night still going can't be checked in yet). */
export function cleanCheckinNight(raw: unknown, now: Date, tz: string): string {
  const { first, last } = checkinNights(now, tz);
  if (raw == null || raw === "") return last;
  if (!isRealDay(raw)) throw new SleepInputError("The night must be a date like 2026-11-01 (the evening it began).");
  if (raw > last) throw new SleepInputError(`That night isn't over yet: check in the morning after (last night is ${last}).`);
  if (raw < first) throw new SleepInputError(`That night is too long ago (the last ${CHECKIN_NIGHTS_BACK} nights at most).`);
  return raw;
}

/** What a goal write sets once checked: only the fields it gave. */
export type GoalFields = {
  title?: string;
  why?: string | null;
  target_date?: string | null;
  targets?: GoalTarget[];
  steps?: GoalStep[];
  roster?: RosterWindow[];
  status?: GoalStatus;
};

export type GoalRules = {
  /** The goal being changed, or null for a new one. */
  current: Pick<SleepGoal, "targets" | "steps" | "roster" | "target_date"> | null;
  /** The adults who check in (owners and members), by member id. */
  adults: ReadonlySet<string>;
  /** Their names, for the error words. */
  name: (id: string) => string;
  /** Today in the family's calendar. */
  today: string;
  /** The goal's id counter so far (0 for a new goal); new items take the next ones. */
  seq: number;
};

function adult(raw: unknown, rules: GoalRules, label: string): string {
  if (typeof raw !== "string" || !raw.trim()) throw new SleepInputError(`${label} needs the adult it's for.`);
  if (!rules.adults.has(raw)) throw new SleepInputError(`${label}: ${rules.name(raw)} isn't an owner or member of this family, so they can't check in. Windows and protected-window targets are for the adults who log.`);
  return raw;
}

/**
 * A goal write's input checked and filled in: titles trimmed, people named
 * by member id, ids kept for items that name one (a step keeps whether it's
 * done) and new ones for the rest, a protected window 30 minutes to 12
 * hours on the clock with no overlap for the same adult on the same night.
 * Throws SleepInputError in words a person can act on.
 */
export function cleanGoalInput(raw: GoalInput, rules: GoalRules, mode: "create" | "update"): { fields: GoalFields; seq: number } {
  if (!raw || typeof raw !== "object") throw new SleepInputError("The goal is missing.");
  const out: GoalFields = {};
  let seq = rules.seq;
  const next = (prefix: string) => `${prefix}${++seq}`;
  if (mode === "create" || raw.title !== undefined) out.title = text(raw.title, "The goal's title", GOAL_TITLE_MAX, true)!;
  if (raw.why !== undefined) out.why = text(raw.why, "Why it matters", GOAL_WHY_MAX, false);
  if (raw.target_date !== undefined) {
    const d = raw.target_date;
    if (d == null || d === "") out.target_date = null;
    else {
      if (!isRealDay(d)) throw new SleepInputError("The target date must be a date like 2026-11-30.");
      // A date it already has stays, even once it's passed; a new one is from today on.
      if (d !== rules.current?.target_date) {
        if (d < rules.today) throw new SleepInputError("The target date has already passed. Pick today or a later day.");
        if (daysBetween(rules.today, d) > GOAL_AHEAD_DAYS) throw new SleepInputError("The target date can be up to a year away.");
      }
      out.target_date = d;
    }
  }

  if (raw.targets !== undefined) {
    if (!Array.isArray(raw.targets)) throw new SleepInputError("Targets must be a list.");
    if (raw.targets.length > GOAL_TARGETS_MAX) throw new SleepInputError(`A goal has ${GOAL_TARGETS_MAX} targets at most.`);
    const have = new Map((rules.current?.targets ?? []).map((t) => [t.id, t]));
    const seen = new Set<string>();
    out.targets = raw.targets.map((t, i) => {
      const label = `Target ${i + 1}`;
      if (!t || typeof t !== "object" || !(TARGET_KINDS as readonly unknown[]).includes(t.kind)) throw new SleepInputError(`${label} needs a kind: ${TARGET_KINDS.join(", ")}.`);
      const id = keepId(t.id, have, seen, "target", label) ?? next("a");
      switch (t.kind) {
        case "bassinet_nights":
          return { id, kind: t.kind, per_week: whole(t.per_week, `${label}: nights a week`, 1, 7), min_minutes: t.min_minutes == null ? 60 : whole(t.min_minutes, `${label}: minutes asleep`, 15, 720) } satisfies BassinetNightsTarget;
        case "bassinet_stretch":
          return { id, kind: t.kind, minutes: whole(t.minutes, `${label}: the stretch's minutes`, 15, 720) } satisfies BassinetStretchTarget;
        case "protected_window":
          return { id, kind: t.kind, member: adult(t.member, rules, label), per_week: whole(t.per_week, `${label}: nights a week`, 1, 7) } satisfies ProtectedWindowTarget;
        case "custom":
          return { id, kind: t.kind, text: text(t.text, `${label}'s words`, GOAL_CUSTOM_MAX, true)! } satisfies CustomTarget;
      }
    });
  }

  if (raw.steps !== undefined) {
    if (!Array.isArray(raw.steps)) throw new SleepInputError("Steps must be a list.");
    if (raw.steps.length > GOAL_STEPS_MAX) throw new SleepInputError(`A goal has ${GOAL_STEPS_MAX} steps at most.`);
    const have = new Map((rules.current?.steps ?? []).map((s) => [s.id, s]));
    const seen = new Set<string>();
    out.steps = raw.steps.map((s, i) => {
      const label = `Step ${i + 1}`;
      if (!s || typeof s !== "object") throw new SleepInputError(`${label} is missing.`);
      const kept = keepId(s.id, have, seen, "step", label);
      const title = text(s.title, `${label}'s words`, GOAL_STEP_TITLE_MAX, true)!;
      const week = s.week_of == null || s.week_of === "" ? null : s.week_of;
      if (week !== null && !isRealDay(week)) throw new SleepInputError(`${label}: the week must be a date like 2026-11-09.`);
      const was = kept ? have.get(kept)! : null;
      return { id: kept ?? next("s"), title, week_of: week, done_at: was?.done_at ?? null, done_by: was?.done_by ?? null };
    });
  }

  if (raw.roster !== undefined) {
    if (!Array.isArray(raw.roster)) throw new SleepInputError("The roster must be a list.");
    if (raw.roster.length > ROSTER_MAX) throw new SleepInputError(`The roster has ${ROSTER_MAX} windows at most.`);
    const have = new Map((rules.current?.roster ?? []).map((w) => [w.id, w]));
    const seen = new Set<string>();
    const windows = raw.roster.map((w, i) => {
      const label = `Window ${i + 1}`;
      if (!w || typeof w !== "object") throw new SleepInputError(`${label} is missing.`);
      const id = keepId(w.id, have, seen, "window", label) ?? next("w");
      const member = adult(w.member, rules, label);
      if (!isClock(w.from) || !isClock(w.to)) throw new SleepInputError(`${label}: from and to are local times like 22:00 and 02:00.`);
      const len = windowMinutes(w.from, w.to);
      if (len < WINDOW_MIN_MINUTES || len > WINDOW_MAX_MINUTES) throw new SleepInputError(`${label}: a protected window is ${WINDOW_MIN_MINUTES} minutes to ${WINDOW_MAX_MINUTES / 60} hours long.`);
      if (!Array.isArray(w.nights) || !w.nights.length || !w.nights.every((n) => Number.isInteger(n) && n >= 0 && n <= 6)) {
        throw new SleepInputError(`${label}: nights are the evenings it begins on, 0 (Sunday) to 6 (Saturday).`);
      }
      return { id, member, from: w.from, to: w.to, nights: [...new Set(w.nights)].sort((a, b) => a - b) } satisfies RosterWindow;
    });
    for (let i = 0; i < windows.length; i++) {
      for (let j = i + 1; j < windows.length; j++) {
        const a = windows[i];
        const b = windows[j];
        if (a.member !== b.member || !a.nights.some((n) => b.nights.includes(n))) continue;
        const [as, ae] = inNight(a);
        const [bs, be] = inNight(b);
        if (as < be && bs < ae) throw new SleepInputError(`Windows ${i + 1} and ${j + 1} overlap for ${rules.name(a.member)} on the same night. Make them one window, or move one.`);
      }
    }
    out.roster = windows;
  }

  if (raw.status !== undefined) {
    if (mode === "create") throw new SleepInputError("A new goal starts active.");
    if (raw.status !== "active" && raw.status !== "paused") throw new SleepInputError("A goal's status changes to active or paused here; closing it as met or dropped is its own step.");
    out.status = raw.status;
  }
  return { fields: out, seq };
}

function keepId<T>(raw: unknown, have: Map<string, T>, seen: Set<string>, what: string, label: string): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string" || !have.has(raw)) throw new SleepInputError(`${label}: this goal has no ${what} ${String(raw)}. Leave the id out for a new one.`);
  if (seen.has(raw)) throw new SleepInputError(`${label}: ${what} ${raw} is in the list twice.`);
  seen.add(raw);
  return raw;
}

/** The next step to do: the first undone one by its week (steps without a week last), then the order they're in. */
export function nextStep(steps: readonly GoalStep[]): GoalStep | null {
  const open = steps.map((s, i) => ({ s, i })).filter((x) => !x.s.done_at);
  open.sort((a, b) => (a.s.week_of ?? "9999-12-31").localeCompare(b.s.week_of ?? "9999-12-31") || a.i - b.i);
  return open[0]?.s ?? null;
}

// ── a goal's weeks ───────────────────────────────────────────────────────

/** Weeks shown without a target date, and at most with one. */
export const GOAL_WEEKS_NO_DATE = 4;
export const GOAL_WEEKS_SHOWN = 12;

export type GoalWeek = {
  /** 1-based, counted from the goal's start. */
  n: number;
  /** Its first and last nights (YYYY-MM-DD, the evenings), cut at the target date. */
  from: string;
  to: string;
  /** Its nights that have begun so far (try days under way or done). */
  nights: number;
  current: boolean;
};

export type GoalSpan = {
  startsOn: string;
  /** The target date, or null. */
  endsOn: string | null;
  today: string;
  /** Days from today to the target date: 0 on the day, negative once it's passed; null without one. */
  daysLeft: number | null;
  /** The week tonight is in (1-based); null once the target date has passed or the goal is closed. */
  weekNow: number | null;
  /** Weeks from the start through the target date; null without one. */
  weeksTotal: number | null;
  /** The weeks shown, oldest first: up to the last 4 without a target date, up to the last 12 with one. */
  weeks: GoalWeek[];
  /** Earlier weeks left out. */
  weeksHidden: number;
  /** The last night counted: tonight's, or the target date or the night it closed when earlier. */
  lastNight: string;
};

const isOpen = (s: GoalStatus) => s === "active" || s === "paused";

export function goalSpan(goal: Pick<SleepGoal, "created_at" | "target_date" | "closed_at" | "status">, now: Date, tz: string): GoalSpan {
  const startsOn = goalStartKey(goal, tz);
  const today = dayKey(now, tz);
  const cur = tryDayKey(now, tz);
  const endsOn = goal.target_date ? maxKey(goal.target_date, startsOn) : null;
  let last = cur;
  if (endsOn) last = minKey(last, endsOn);
  if (goal.closed_at) last = minKey(last, tryDayKey(ms(goal.closed_at), tz));
  // The week a night is in; the current week shows from the moment the goal is set, before its first night begins.
  const shownTo = maxKey(last, startsOn);
  const begun = Math.floor(daysBetween(startsOn, shownTo) / 7) + 1;
  const max = endsOn ? GOAL_WEEKS_SHOWN : GOAL_WEEKS_NO_DATE;
  const first = Math.max(0, begun - max);
  const inSpan = !endsOn || cur <= endsOn;
  const weekNow = isOpen(goal.status) && !goal.closed_at && inSpan ? Math.floor(daysBetween(startsOn, maxKey(cur, startsOn)) / 7) + 1 : null;
  const weeks: GoalWeek[] = [];
  for (let i = first; i < begun; i++) {
    const from = addDays(startsOn, 7 * i);
    const to = endsOn ? minKey(addDays(from, 6), endsOn) : addDays(from, 6);
    const through = minKey(to, last);
    weeks.push({ n: i + 1, from, to, nights: through >= from ? daysBetween(from, through) + 1 : 0, current: i + 1 === weekNow });
  }
  return {
    startsOn,
    endsOn,
    today,
    daysLeft: endsOn ? daysBetween(today, endsOn) : null,
    weekNow,
    weeksTotal: endsOn ? Math.floor(daysBetween(startsOn, endsOn) / 7) + 1 : null,
    weeks,
    weeksHidden: first,
    lastNight: last,
  };
}

/** The shown week a night falls in, or null. */
function weekOf(span: GoalSpan, night: string): GoalWeek | null {
  if (night < span.startsOn || night > span.lastNight) return null;
  const n = Math.floor(daysBetween(span.startsOn, night) / 7) + 1;
  return span.weeks.find((w) => w.n === n && night <= w.to) ?? null;
}

const nightsIn = (w: GoalWeek, through: string): string[] => {
  const end = minKey(w.to, through);
  return end < w.from ? [] : Array.from({ length: daysBetween(w.from, end) + 1 }, (_, i) => addDays(w.from, i));
};

// ── progress ─────────────────────────────────────────────────────────────

export type NightsWeek = {
  week: number;
  /** Nights with a bassinet try that stayed asleep at least the target's minutes. */
  counted: number;
  /** Nights with a finished try at all: the sample "counted" is out of. */
  tried: number;
  /** Nights of the week begun so far. */
  nights: number;
};

export type StretchWeek = {
  week: number;
  /** Bassinet stretches that began that week. */
  stretches: number;
  longestSec: number | null;
  /** Of them, how many reached the target's minutes. */
  atLeast: number;
};

export type WindowWeek = {
  week: number;
  /** That adult's check-ins by answer, and how many nights they checked in. */
  yes: number;
  partly: number;
  no: number;
  checkedIn: number;
  /** Nights their window was on the roster that are over (so could be checked in). */
  planned: number;
};

export type TargetProgress =
  | { id: string; kind: "bassinet_nights"; target: BassinetNightsTarget; weeks: NightsWeek[] }
  | { id: string; kind: "bassinet_stretch"; target: BassinetStretchTarget; weeks: StretchWeek[]; longest: { sec: number; start: string; end: string } | null }
  /** `weeks` is null for a reader who can't see check-ins (a view-only guest). */
  | { id: string; kind: "protected_window"; target: ProtectedWindowTarget; weeks: WindowWeek[] | null }
  | { id: string; kind: "custom"; target: CustomTarget };

export type CheckinCounts = {
  member: string;
  /** Nights checked in over the shown weeks, by answer. */
  nights: number;
  yes: number;
  partly: number;
  no: number;
  /** Their answer for last night, or null before they've checked in. */
  lastNight: ProtectedAnswer | null;
};

export type RosterHint = {
  windowId: string;
  member: string;
  /** Nights of the last week (within the goal) the window was on and is over. */
  nights: number;
  /** Feeds that began inside it, and on how many of those nights. */
  feeds: number;
  feedNights: number;
  /** Of those feeds, how many this adult logged. */
  feedsLoggedBy: number;
  /** Nights this adult had a holding turn during their own window. */
  heldNights: number;
  /** Nights someone else held the baby during it, by who. */
  cover: { member: string; nights: number }[];
  /** Bassinet tries that began inside it. */
  tries: number;
};

export type GoalProgress = GoalSpan & {
  goalId: number;
  targets: TargetProgress[];
  steps: { done: number; of: number; next: GoalStep | null };
  /** Per adult; null for a reader who can't see check-ins. */
  checkins: CheckinCounts[] | null;
  roster: RosterHint[];
};

/** What progress reads: the log over the goal's nights. */
export type GoalData = {
  tries: readonly BassinetTry[];
  /** Sleep and feed entries (other kinds are skipped). */
  entries: readonly Entry[];
  shifts: readonly HoldingShift[];
  /** Null when this reader can't see check-ins. */
  checkins: readonly SleepCheckin[] | null;
};

/** Hints look at the last week of nights. */
const HINT_NIGHTS = 7;

export function goalProgress(goal: SleepGoal, data: GoalData, now: Date, tz: string): GoalProgress {
  const span = goalSpan(goal, now, tz);
  const t = now.getTime();
  const tries = live(data.tries).filter((x) => ms(x.started_at) <= t);
  const finished = tries.filter((x) => x.ended_at && x.outcome);
  const byNight = new Map<string, BassinetTry[]>();
  for (const x of finished) {
    const k = tryDayKey(ms(x.started_at), tz);
    byNight.set(k, [...(byNight.get(k) ?? []), x]);
  }
  const checkedTo = minKey(span.lastNight, lastNightKey(now, tz));
  const shownFrom = span.weeks[0]?.from ?? span.startsOn;

  // Bassinet stretches over the shown nights, each counted on the night it began.
  let stretches: { start: number; end: number }[] = [];
  if (goal.targets.some((x) => x.kind === "bassinet_stretch")) {
    const lo = tryDayBounds(shownFrom, tz)[0].getTime();
    const hi = Math.min(tryDayBounds(span.lastNight, tz)[1].getTime(), t + 1);
    if (hi > lo) stretches = sleepByPlace(data.entries.filter((e) => e.kind === "sleep"), data.tries, lo, hi, t).stretches.filter((s) => s.start >= lo && s.start < hi);
  }

  const windowsOf = (member: string) => goal.roster.filter((w) => w.member === member);
  const targets: TargetProgress[] = goal.targets.map((target): TargetProgress => {
    switch (target.kind) {
      case "bassinet_nights":
        return {
          id: target.id,
          kind: target.kind,
          target,
          weeks: span.weeks.map((w) => {
            const nights = nightsIn(w, span.lastNight);
            const tried = nights.filter((k) => byNight.has(k));
            const counted = tried.filter((k) => byNight.get(k)!.some((x) => x.outcome === "stayed_asleep" && ms(x.ended_at!) - ms(x.started_at) >= target.min_minutes * MIN));
            return { week: w.n, counted: counted.length, tried: tried.length, nights: nights.length };
          }),
        };
      case "bassinet_stretch": {
        const mine = stretches.map((s) => ({ ...s, week: weekOf(span, tryDayKey(s.start, tz))?.n ?? null })).filter((s) => s.week != null);
        const longest = mine.slice().sort((a, b) => b.end - b.start - (a.end - a.start))[0];
        return {
          id: target.id,
          kind: target.kind,
          target,
          weeks: span.weeks.map((w) => {
            const here = mine.filter((s) => s.week === w.n);
            const top = here.reduce((m, s) => Math.max(m, s.end - s.start), 0);
            return { week: w.n, stretches: here.length, longestSec: here.length ? Math.round(top / 1000) : null, atLeast: here.filter((s) => s.end - s.start >= target.minutes * MIN).length };
          }),
          longest: longest ? { sec: Math.round((longest.end - longest.start) / 1000), start: new Date(longest.start).toISOString(), end: new Date(longest.end).toISOString() } : null,
        };
      }
      case "protected_window": {
        if (!data.checkins) return { id: target.id, kind: target.kind, target, weeks: null };
        const theirs = live(data.checkins).filter((c) => c.member === target.member);
        const windows = windowsOf(target.member);
        return {
          id: target.id,
          kind: target.kind,
          target,
          weeks: span.weeks.map((w) => {
            const nights = new Set(nightsIn(w, checkedTo));
            const here = theirs.filter((c) => nights.has(c.night));
            const count = (a: ProtectedAnswer) => here.filter((c) => c.protected === a).length;
            return { week: w.n, yes: count("yes"), partly: count("partly"), no: count("no"), checkedIn: here.length, planned: [...nights].filter((k) => windows.some((x) => windowOnNight(x, k))).length };
          }),
        };
      }
      case "custom":
        return { id: target.id, kind: target.kind, target };
    }
  });

  let checkins: CheckinCounts[] | null = null;
  if (data.checkins) {
    const last = lastNightKey(now, tz);
    const inShown = live(data.checkins).filter((c) => c.night >= shownFrom && c.night <= checkedTo);
    const people = new Set<string>([...inShown.map((c) => c.member), ...goalAdults(goal)]);
    checkins = [...people].map((member) => {
      const theirs = inShown.filter((c) => c.member === member);
      const count = (a: ProtectedAnswer) => theirs.filter((c) => c.protected === a).length;
      const lastOne = live(data.checkins!).find((c) => c.member === member && c.night === last);
      return { member, nights: theirs.length, yes: count("yes"), partly: count("partly"), no: count("no"), lastNight: lastOne?.protected ?? null };
    });
  }

  // Roster hints: the last week of nights each window was on and is over, inside the goal.
  const cur = tryDayKey(now, tz);
  const feeds = data.entries.filter((e) => e.kind === "feed");
  const shifts = live(data.shifts);
  const roster: RosterHint[] = goal.roster.map((w) => {
    const keys: string[] = [];
    for (let i = HINT_NIGHTS; i >= 0; i--) {
      const k = addDays(cur, -i);
      if (k < span.startsOn || k > span.lastNight || !windowOnNight(w, k)) continue;
      if (windowOn(w, k, tz)[1].getTime() > t) continue;
      keys.push(k);
    }
    const hint: RosterHint = { windowId: w.id, member: w.member, nights: 0, feeds: 0, feedNights: 0, feedsLoggedBy: 0, heldNights: 0, cover: [], tries: 0 };
    const cover = new Map<string, number>();
    for (const k of keys.slice(-HINT_NIGHTS)) {
      const [a, b] = windowOn(w, k, tz).map((d) => d.getTime());
      hint.nights++;
      const inside = feeds.filter((e) => ms(e.started_at) >= a && ms(e.started_at) < b);
      hint.feeds += inside.length;
      if (inside.length) hint.feedNights++;
      hint.feedsLoggedBy += inside.filter((e) => e.created_by === w.member).length;
      hint.tries += tries.filter((x) => ms(x.started_at) >= a && ms(x.started_at) < b).length;
      const during = shifts.filter((s) => ms(s.started_at) < b && (s.ended_at ? ms(s.ended_at) : t) > a);
      if (during.some((s) => s.holder === w.member)) hint.heldNights++;
      for (const who of new Set(during.filter((s) => s.holder !== w.member).map((s) => s.holder))) cover.set(who, (cover.get(who) ?? 0) + 1);
    }
    hint.cover = [...cover.entries()].map(([member, nights]) => ({ member, nights })).sort((x, y) => y.nights - x.nights || x.member.localeCompare(y.member));
    return hint;
  });

  return {
    ...span,
    goalId: goal.id,
    targets,
    steps: { done: goal.steps.filter((s) => s.done_at).length, of: goal.steps.length, next: nextStep(goal.steps) },
    checkins,
    roster,
  };
}

/** The adults a goal names: its roster's and its protected-window targets'. */
export function goalAdults(goal: Pick<SleepGoal, "roster" | "targets">): string[] {
  return [...new Set([...goal.roster.map((w) => w.member), ...goal.targets.flatMap((x) => (x.kind === "protected_window" ? [x.member] : []))])];
}

// ── words ────────────────────────────────────────────────────────────────

export type GoalWords = {
  v: Voice;
  /** A member id's name. */
  name: (id: string) => string;
  tz: string;
  now: Date;
};

const answers = (c: { yes: number; partly: number; no: number }) =>
  (["yes", "partly", "no"] as const)
    .filter((a) => c[a])
    .map((a) => `${PROTECTED_LABEL[a].toLowerCase()} ${c[a]}`)
    .join(", ");

/** The goal's header line: "Sleep goal g3 (Active): "Both of us get a 4-hour stretch". Target date Mon, Nov 30 (28 days left); week 1 of 5." */
export function goalHeadLine(goal: SleepGoal, p: GoalSpan, words: Pick<GoalWords, "tz">): string {
  const status = goal.status === "met" || goal.status === "dropped" ? `${GOAL_STATUS_LABEL[goal.status]}${goal.closed_at ? ` on ${dateWords(dayKey(ms(goal.closed_at), words.tz), p.today)}` : ""}` : GOAL_STATUS_LABEL[goal.status];
  const parts = [`Sleep goal ${goalRef(goal.id)} (${status}): "${goal.title}".`];
  if (goal.why) parts.push(`Why: "${goal.why}".`);
  if (p.endsOn) {
    const left = p.daysLeft ?? 0;
    const when = left > 1 ? `${left} days left` : left === 1 ? "tomorrow" : left === 0 ? "today" : `${plural(-left, "day")} ago`;
    parts.push(`Target date ${dateWords(p.endsOn, p.today)} (${when})${p.weekNow ? `; week ${p.weekNow} of ${p.weeksTotal}` : ""}.`);
  } else {
    parts.push(`No target date${p.weekNow ? `; week ${p.weekNow}` : ""}.`);
  }
  return parts.join(" ");
}

/**
 * The progress in plain lines, for the tools and the app's screen readers:
 * each target this week and last, the steps, the adults' check-ins (only
 * when this reader can see them), the roster and its hints. Neutral words,
 * every count with what it's out of.
 */
export function goalProgressLines(goal: SleepGoal, p: GoalProgress, words: GoalWords): string[] {
  const { v, name } = words;
  const lines: string[] = [];
  // The week tonight is in and the one before (or the last two, once the goal is past its date or closed).
  const cur = p.weeks[p.weeks.length - 1];
  const prev = p.weeks.length > 1 ? p.weeks[p.weeks.length - 2] : null;
  const label = (w: GoalWeek) => (w.current ? "This week" : w === prev && cur?.current ? "Last week" : `Week ${w.n}${p.weeksTotal ? ` of ${p.weeksTotal}` : ""}`);
  const shown = [cur, prev].filter((w): w is GoalWeek => !!w);
  const sentence = (head: string, parts: string[]) => lines.push(`${head}. ${parts.join(" ")}`);
  for (const tp of p.targets) {
    const head = `Aim: ${targetWords(tp.target, name)}`;
    switch (tp.kind) {
      case "bassinet_nights":
        sentence(
          head,
          shown.map((w) => {
            const x = tp.weeks.find((y) => y.week === w.n)!;
            return `${label(w)}: ${plural(x.counted, "night")} (finished tries on ${x.tried} of ${plural(x.nights, "night")}${w.current ? " so far" : ""}).`;
          })
        );
        break;
      case "bassinet_stretch":
        sentence(
          head,
          shown.map((w) => {
            const x = tp.weeks.find((y) => y.week === w.n)!;
            return x.stretches
              ? `${label(w)}: longest ${formatDuration(x.longestSec ?? 0)}; ${x.atLeast} of ${plural(x.stretches, "stretch", "stretches")} ${x.atLeast === 1 ? "was" : "were"} ${minutesWords(tp.target.minutes)} or more.`
              : `${label(w)}: no bassinet stretches logged${w.current ? " yet" : ""}.`;
          })
        );
        break;
      case "protected_window":
        if (!tp.weeks) {
          lines.push(`${head} (counted from the adults' own check-ins).`);
          break;
        }
        sentence(
          head,
          shown.map((w) => {
            const x = tp.weeks!.find((y) => y.week === w.n)!;
            const other = answers({ yes: 0, partly: x.partly, no: x.no });
            const roster = `${plural(x.planned, "night")} on the roster${w.current ? " so far" : ""}`;
            return x.checkedIn ? `${label(w)}: held on ${x.yes} of ${plural(x.checkedIn, "night")} checked in${other ? ` (${other})` : ""}; ${roster}.` : `${label(w)}: no check-ins yet; ${roster}.`;
          })
        );
        break;
      case "custom":
        lines.push(`${head} (not counted from the log; ask how it's going).`);
        break;
    }
  }
  if (goal.steps.length) {
    const n = p.steps.next;
    const nextWords = n ? `; next: "${n.title}" (${n.id}${n.week_of ? `, week of ${dateWords(n.week_of, p.today)}` : ""})` : "; all done";
    lines.push(`Steps: ${p.steps.done} of ${p.steps.of} done${nextWords}.`);
  }
  if (p.checkins) {
    const people = p.checkins.filter((c) => c.nights);
    lines.push(
      people.length
        ? `Check-ins since ${dateWords(p.weeks[0]?.from ?? p.startsOn, p.today)}: ${people.map((c) => `${name(c.member)} ${plural(c.nights, "night")} (${answers(c)})`).join("; ")}.`
        : "No check-ins yet over these weeks."
    );
  }
  if (goal.roster.length) {
    lines.push(`Roster: ${goal.roster.map((w) => windowWords(w, name)).join("; ")}.`);
    for (const h of p.roster) {
      if (!h.nights) continue;
      const parts = [
        h.feeds ? `feeds began inside it on ${plural(h.feedNights, "night")} (${plural(h.feeds, "feed")}${h.feedsLoggedBy ? `, ${h.feedsLoggedBy} logged by ${name(h.member)}` : ""})` : "no feeds began inside it",
        ...(h.heldNights ? [`${name(h.member)} held ${v.name} during it on ${plural(h.heldNights, "night")}`] : []),
        ...h.cover.map((c) => `${name(c.member)} held ${v.name} during it on ${plural(c.nights, "night")}`),
        ...(h.tries ? [`${plural(h.tries, "bassinet try", "bassinet tries")} began inside it`] : []),
      ];
      const w = goal.roster.find((x) => x.id === h.windowId)!;
      lines.push(`Hint from the log, ${name(h.member)}'s window ${windowTimes(w)} (the last ${plural(h.nights, "night")} it was on): ${parts.join("; ")}.`);
    }
  }
  return lines;
}

// ── coaching ─────────────────────────────────────────────────────────────

export type CoachNotes = {
  goalId: number;
  daysLeft: number | null;
  /** An active goal's last review (or, without one, when it was set) is REVIEW_DUE_DAYS or more days ago. */
  reviewDue: boolean;
  daysSinceReview: number;
  nextStep: GoalStep | null;
  /** The goal's adults without a check-in for last night; null for a reader who can't see check-ins. */
  notCheckedIn: string[] | null;
  /** Short lines for the coach (and the app, if it shows them). */
  notes: string[];
};

export function coachNotes(goal: SleepGoal, p: GoalProgress, words: Pick<GoalWords, "name" | "tz" | "now">): CoachNotes {
  const open = isOpen(goal.status);
  const since = daysBetween(dayKey(ms(goal.last_review_at ?? goal.created_at), words.tz), p.today);
  const reviewDue = goal.status === "active" && since >= REVIEW_DUE_DAYS;
  const notes: string[] = [];
  if (goal.status === "paused") notes.push("Paused: ask whether they want to pick it back up before coaching on it.");
  if (open && p.endsOn && p.daysLeft != null) {
    const d = dateWords(p.endsOn, p.today);
    if (p.daysLeft > 1) notes.push(`${p.daysLeft} days to the target date (${d}).`);
    else if (p.daysLeft === 1) notes.push(`The target date is tomorrow (${d}).`);
    else if (p.daysLeft === 0) notes.push("The target date is today: a good moment to look back at it together.");
    else notes.push(`The target date (${d}) was ${plural(-p.daysLeft, "day")} ago: ask whether to close it as met, set a new date, or keep going.`);
  }
  if (reviewDue) notes.push(goal.last_review_at ? `Review due: the last one was ${plural(since, "day")} ago.` : `Review due: it was set ${plural(since, "day")} ago and hasn't had one yet.`);
  const next = nextStep(goal.steps);
  if (open) {
    if (next) notes.push(`Next step: "${next.title}"${next.week_of ? ` (week of ${dateWords(next.week_of, p.today)})` : ""}.`);
    else if (goal.steps.length) notes.push("Every step is done: ask whether to plan the next one.");
    else notes.push("No weekly steps yet: suggest one small step for this week.");
  }
  let notCheckedIn: string[] | null = null;
  if (p.checkins) {
    // Nobody owes a check-in for a night before the goal's first one.
    const owed = lastNightKey(words.now, words.tz) >= p.startsOn;
    notCheckedIn = owed ? goalAdults(goal).filter((m) => !p.checkins!.some((c) => c.member === m && c.lastNight)) : [];
    if (open && notCheckedIn.length) notes.push(`Not checked in for last night yet: ${notCheckedIn.map(words.name).join(", ")}.`);
  }
  return { goalId: goal.id, daysLeft: p.daysLeft, reviewDue, daysSinceReview: since, nextStep: next, notCheckedIn, notes };
}

/**
 * How the coach works, for sleep_goal's description and sleep_plan's
 * coach notes. Nothing here is medical advice; feeding changes are only
 * ever something to raise with the family's own clinicians.
 */
export const coachGuardrails = (v: Voice): string[] => [
  "Ask one question at a time (in Maple chat, with ask_user).",
  "Propose a goal with its steps, read it back, and save it only after they say yes.",
  "Use the family's memories for their constraints (work dates, feeding, who's home), and the log for what happened.",
  "No medical advice: questions about health go to their pediatrician.",
  "Feeding changes (bottles, pumping, formula) only as options to raise with their pediatrician or lactation consultant.",
  `Never crying it out, and never ${v.name} sleeping on or beside an adult as a plan.`,
  "Hard nights are part of it: give the counts plainly, with no blame, scores or streaks.",
];

/** A check-in's night in a sentence, by the calendar (as lastNightKey): "last night" all day after it, then "Sat night". */
export const nightWords = (night: string, now: Date, tz: string) => tryDayLabel(night, dayKey(now, tz));

/** "Sam yes, Alex partly; not yet: Robin": last night's check-ins for these adults. */
export function lastNightLine(adults: readonly string[], checkins: readonly SleepCheckin[], now: Date, tz: string, name: (id: string) => string): string {
  const last = lastNightKey(now, tz);
  const done = adults.flatMap((m) => {
    const c = live(checkins).find((x) => x.member === m && x.night === last);
    return c ? [`${name(m)} ${PROTECTED_LABEL[c.protected].toLowerCase()}`] : [];
  });
  const notYet = adults.filter((m) => !live(checkins).some((x) => x.member === m && x.night === last)).map(name);
  return [done.join(", "), notYet.length ? `not yet: ${notYet.join(", ")}` : ""].filter(Boolean).join("; ");
}

/** A check-in in a sentence: "Sat night (Oct 31): yes". */
export function checkinWords(c: Pick<SleepCheckin, "night" | "protected">, now: Date, tz: string): string {
  return `${nightWords(c.night, now, tz)} (${dateWords(c.night, dayKey(now, tz)).replace(/^\w+, /, "")}): ${PROTECTED_LABEL[c.protected].toLowerCase()}`;
}

/** A goal's roster in one line: "Sam: 10:00 PM–2:00 AM, Sun–Thu nights; Alex: …". */
export const rosterWords = (roster: readonly RosterWindow[], name: (id: string) => string) => roster.map((w) => windowWords(w, name)).join("; ");

/** A goal's targets in one line, for a read-back. */
export const targetsWords = (targets: readonly GoalTarget[], name: (id: string) => string) => targets.map((t) => targetWords(t, name)).join("; ");

/** The evenings a window is on, for a read-back: "Sun–Thu nights". */
export const windowNights = (w: Pick<RosterWindow, "nights">) => nightsLabel(w.nights);
