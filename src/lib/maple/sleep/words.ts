/**
 * The sleep plan's own words: stages, try times, outcomes, tags and places,
 * shared by the app, the routes and the MCP tools. This is plan copy (what
 * the family chose and how the log reads), not health guidance: anything
 * that makes a claim about babies lives in ../guidelines/sleep.ts with its
 * source. Copy about the baby takes a Voice (../voice.ts).
 */
import { formatTime, parseDayKey } from "../time";
import type { SleepPlace } from "../types";
import type { Voice } from "../voice";
import type { CheckinPlace, GoalStatus, GoalTarget, HandoffAnswer, PlanStage, ProtectedAnswer, RosterWindow, ShiftEnding, TargetKind, TryAnchor, TryOutcome, TrySlot, TryTag, UntimedTry } from "./types";
import { TRY_ANCHORS } from "./types";

export type StageInfo = {
  title: string;
  /** What this stage asks for, in one line. */
  goal: string;
  /** What moving to this stage sets (the family can change any of it after). */
  defaults: { tries_per_day: number; try_times: TrySlot[]; fallback: TrySlot | null };
};

/**
 * The ladder from held sleep to the bassinet, gentlest first. Parents move
 * between stages themselves; Maple only suggests the next one
 * (engine.ts stageSuggestion) and never changes it on its own.
 */
export const STAGE_INFO: Record<PlanStage, StageInfo> = {
  1: {
    title: "First tries",
    goal: "One bassinet try a day: the first long night stretch after a feed, or the first morning nap",
    defaults: { tries_per_day: 1, try_times: ["first_night_stretch"], fallback: "first_morning_nap" },
  },
  2: {
    title: "Two tries a day",
    goal: "The first long night stretch and the first morning nap",
    defaults: { tries_per_day: 2, try_times: ["first_night_stretch", "first_morning_nap"], fallback: null },
  },
  3: {
    title: "Night stretches",
    goal: "Every long night stretch after a feed starts in the bassinet",
    defaults: { tries_per_day: 3, try_times: ["night_stretch"], fallback: "first_morning_nap" },
  },
  4: {
    title: "Bassinet first",
    goal: "Night sleep and naps at home start in the bassinet",
    defaults: { tries_per_day: 5, try_times: ["night_stretch", "any_nap"], fallback: null },
  },
};

export const defaultGoal = (v: Voice) => `Sleeping in ${v.their} bassinet in our room`;

export const ANCHOR_LABEL: Record<TryAnchor, string> = {
  first_night_stretch: "The first long night stretch after a feed",
  night_stretch: "Each long night stretch after a feed",
  first_morning_nap: "The first morning nap",
  any_nap: "Naps at home",
};

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A try time as stored: a named moment or a local "HH:MM". */
export function isTrySlot(v: unknown): v is TrySlot {
  return typeof v === "string" && ((TRY_ANCHORS as readonly string[]).includes(v) || CLOCK.test(v));
}

/** "The first morning nap", "Around 10:30 PM". */
export function slotLabel(slot: TrySlot): string {
  const m = CLOCK.exec(slot);
  if (m) {
    // Any date works for a wall-clock label; UTC keeps it from shifting.
    const d = new Date(Date.UTC(2000, 0, 1, Number(m[1]), Number(m[2])));
    return `Around ${formatTime(d, "UTC")}`;
  }
  return ANCHOR_LABEL[slot as TryAnchor] ?? slot;
}

export const OUTCOME_LABEL: Record<TryOutcome, string> = {
  stayed_asleep: "Stayed asleep",
  woke_calm: "Woke calm",
  woke_crying: "Woke crying",
  picked_up: "Picked up",
};

/** The line under each outcome button: what it means, so two people log the same thing the same way. */
export const outcomeHint = (v: Voice): Record<TryOutcome, string> => ({
  stayed_asleep: `Slept there until ${v.they} woke or came out`,
  woke_calm: `Woke early, but calm`,
  woke_crying: `Woke early, crying`,
  picked_up: `Picked up while still asleep`,
});

/** Lowercase, mid-sentence ("ended: woke crying"). */
export const outcomeWords = (o: TryOutcome) => OUTCOME_LABEL[o].toLowerCase();

export const TAG_LABEL: Record<TryTag, string> = {
  fed: "Recently fed",
  swaddled: "Swaddled",
  white_noise: "White noise",
};

export const SLEEP_PLACE_LABEL: Record<SleepPlace | "unknown", string> = {
  bassinet: "Bassinet",
  crib: "Crib",
  arms: "In arms",
  carrier: "Carrier",
  stroller: "Stroller",
  car: "Car seat",
  bed: "Grown-up bed",
  unknown: "Place not recorded",
};

export const SHIFT_ENDING_LABEL: Record<ShiftEnding, string> = {
  handoff: "Handed off",
  bassinet: "Into the bassinet",
  ended: "Ended",
};

/** Time-of-day buckets for the progress view, by the local hour a try began. */
export const TIME_OF_DAY = [
  { id: "night", label: "Night", from: 0, to: 6, range: "midnight to 6 AM" },
  { id: "morning", label: "Morning", from: 6, to: 12, range: "6 AM to noon" },
  { id: "afternoon", label: "Afternoon", from: 12, to: 18, range: "noon to 6 PM" },
  { id: "evening", label: "Evening", from: 18, to: 24, range: "6 PM to midnight" },
] as const;
export type TimeOfDay = (typeof TIME_OF_DAY)[number]["id"];

/**
 * "I'm getting sleepy": exactly these two choices, and never one that keeps
 * her on a sleepy adult. The safety line under them is guidelines/sleep.ts's
 * safe-sleepy item.
 */
export const sleepyChoices = (v: Voice, partner: string | null) =>
  [
    { id: "bassinet" as const, label: `Put ${v.them} in the bassinet now`, hint: `On ${v.their} back. This ends your turn.` },
    { id: "partner" as const, label: partner ? `Wake ${partner}` : "Wake your partner", hint: `Hand ${v.them} over now.` },
  ] as const;

// ── sleep goals ──────────────────────────────────────────────────────────
//
// Neutral words only: counts with their sample sizes, never a score, a
// streak, a grade, "failed" or a "best time" (scripts/maple-sleep-check.ts
// holds that for every line goals.ts writes).

export const TARGET_KIND_LABEL: Record<TargetKind, string> = {
  bassinet_nights: "Bassinet nights",
  bassinet_stretch: "Longest bassinet stretch",
  protected_window: "Protected sleep window",
  custom: "Another aim",
};

export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = {
  active: "Active",
  paused: "Paused",
  met: "Met",
  dropped: "Set aside",
};

/**
 * The check-in's question, and its three answers. Never "hold": a holding
 * turn is someone holding the baby awake, so the question names the sleep
 * itself (checkinQuestion has the window's times).
 */
export const CHECKIN_QUESTION = "Did you get your protected sleep last night?";
export const PROTECTED_LABEL: Record<ProtectedAnswer, string> = { yes: "Yes", partly: "Partly", no: "Not this time" };

/** "10 PM", "9:30 PM", "midnight", "noon" for a stored "22:00": short, for a question. */
export function shortClock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (m === 0 && h === 0) return "midnight";
  if (m === 0 && h === 12) return "noon";
  const hour = h % 12 || 12;
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

/** "Did you get your 10 PM–2 AM sleep?" for the adult's windows that night ("… and 4–6 AM …"); CHECKIN_QUESTION without one. */
export function checkinQuestion(windows: readonly Pick<RosterWindow, "from" | "to">[]): string {
  const times = [...new Set(windows.map((w) => `${shortClock(w.from)}–${shortClock(w.to)}`))];
  if (!times.length) return CHECKIN_QUESTION;
  return `Did you get your ${times.length > 1 ? `${times.slice(0, -1).join(", ")} and ${times[times.length - 1]}` : times[0]} sleep?`;
}

/** The morning's other questions (each once a night, whoever answers first), and their answers. */
export const placeQuestion = (v: Voice) => `Where did ${v.name} spend most of last night?`;
export const PLACE_LABEL: Record<CheckinPlace, string> = { bassinet: "Bassinet", held: "Held by someone awake", mixed: "Some of each", elsewhere: "Somewhere else", unsure: "Not sure" };
export const UNTIMED_QUESTION = "Any bassinet try that isn't in the log?";
export const untimedLabels = (minutes: number): Record<UntimedTry, string> => ({ no: "No", long: `Yes, ${minutesWords(minutes)} or more`, short: "Yes, shorter" });
export const handoffQuestion = (at: string | null) => (at ? `Did the ${at} handoff happen as planned?` : "Did the handoff happen as planned?");
export const HANDOFF_LABEL: Record<HandoffAnswer, string> = { on_time: "On time", early: "Early", late: "Late", none: "No handoff" };

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The weekday of a night (0 = Sunday), named by the date of the evening it begins. */
export function weekdayOf(key: string): number {
  const { year, month, day } = parseDayKey(key);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** "Mon, Nov 30" ("Mon, Nov 30, 2027" outside today's year): a calendar date, never "Today". */
export function dateWords(key: string, todayKey: string): string {
  const { year, month, day } = parseDayKey(key);
  return `${WEEKDAY_SHORT[weekdayOf(key)]}, ${MONTH_SHORT[month - 1]} ${day}${todayKey.slice(0, 4) === key.slice(0, 4) ? "" : `, ${year}`}`;
}

/** "10:00 PM" for a stored "22:00". */
export function clockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  // Any date works for a wall-clock label; UTC keeps it from shifting.
  return formatTime(new Date(Date.UTC(2000, 0, 1, h, m)), "UTC");
}

/** "10:00 PM–2:00 AM". */
export const windowTimes = (w: Pick<RosterWindow, "from" | "to">) => `${clockLabel(w.from)}–${clockLabel(w.to)}`;

/** "every night", "Sun–Thu nights", "Fri–Sun nights", "Mon, Wed and Fri nights": the evenings a window begins on. */
export function nightsLabel(nights: readonly number[]): string {
  const set = [...new Set(nights)].filter((n) => Number.isInteger(n) && n >= 0 && n <= 6).sort((a, b) => a - b);
  if (set.length === 7) return "every night";
  if (!set.length) return "no nights";
  // A run of 3 or more evenings in a row, possibly through Saturday into Sunday, reads as a range.
  const gaps = set.map((n, i) => ((set[(i + 1) % set.length] - n + 7) % 7) || 7);
  const breaks = gaps.filter((g) => g > 1).length;
  if (set.length >= 3 && breaks === 1) {
    const at = gaps.findIndex((g) => g > 1);
    const first = set[(at + 1) % set.length];
    const last = set[at];
    return `${WEEKDAY_SHORT[first]}–${WEEKDAY_SHORT[last]} nights`;
  }
  const names = set.map((n) => WEEKDAY_SHORT[n]);
  return `${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]} nights`;
}

/** "45 minutes", "3 hours", "1h 30m". */
export function minutesWords(min: number): string {
  if (min < 60) return `${min} minutes`;
  if (min % 60 === 0) return `${min / 60} ${min === 60 ? "hour" : "hours"}`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}

/** A target in a few words: "4 nights a week with a bassinet try asleep 1 hour or more". `name`: a member id's name. */
export function targetWords(t: GoalTarget, name: (id: string) => string): string {
  switch (t.kind) {
    case "bassinet_nights":
      return `${t.per_week} ${t.per_week === 1 ? "night" : "nights"} a week with a bassinet try asleep ${minutesWords(t.min_minutes)} or more`;
    case "bassinet_stretch":
      return `a bassinet stretch of ${minutesWords(t.minutes)} or more`;
    case "protected_window":
      // Never "holding": that's someone holding the baby awake.
      return `${name(t.member)}'s protected sleep, ${t.per_week} ${t.per_week === 1 ? "night" : "nights"} a week`;
    case "custom":
      return t.text;
  }
}

/** "Sam: 10:00 PM–2:00 AM, Sun–Thu nights". */
export const windowWords = (w: RosterWindow, name: (id: string) => string) => `${name(w.member)}: ${windowTimes(w)}, ${nightsLabel(w.nights)}`;
