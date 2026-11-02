/**
 * The sleep plan's shapes: the family's plan for moving from held sleep to
 * the bassinet in their room, bassinet tries, and holding shifts (who is
 * holding the baby awake), and the family's sleep goals with each adult's
 * morning check-in. Isomorphic, like ../types.ts: no node or browser APIs.
 * Nothing here is about the care person: her page's things never belong in
 * a plan, a try, a shift, a goal or a check-in.
 */
import type { SleepPlace, Source } from "../types";

/** How a bassinet try ended. "picked_up": picked up before waking (she's still asleep, in arms). */
export const TRY_OUTCOMES = ["stayed_asleep", "woke_calm", "woke_crying", "picked_up"] as const;
export type TryOutcome = (typeof TRY_OUTCOMES)[number];

/** She woke, so the sleep the try sits on ended with it. */
export const WOKE_OUTCOMES: readonly TryOutcome[] = ["stayed_asleep", "woke_calm", "woke_crying"];

/** Optional context on a try. */
export const TRY_TAGS = ["fed", "swaddled", "white_noise"] as const;
export type TryTag = (typeof TRY_TAGS)[number];

/** Named moments a plan's try times can name; a local clock time ("22:30") is the other kind of slot. */
export const TRY_ANCHORS = ["first_night_stretch", "night_stretch", "first_morning_nap", "any_nap"] as const;
export type TryAnchor = (typeof TRY_ANCHORS)[number];
/** A preferred try time: a named moment or a local "HH:MM". */
export type TrySlot = string;

/** The plan's stages, from one try a day to bassinet first. Parents choose; Maple only suggests. */
export const PLAN_STAGES = [1, 2, 3, 4] as const;
export type PlanStage = (typeof PLAN_STAGES)[number];

export const SHIFT_ENDINGS = ["handoff", "bassinet", "ended"] as const;
export type ShiftEnding = (typeof SHIFT_ENDINGS)[number];

/** Limits shared by the store, the routes and the tools. */
export const TRY_NOTE_MAX = 200;
export const PLAN_GOAL_MAX = 160;
export const TRIES_PER_DAY_MAX = 8;
export const TRY_TIMES_MAX = 6;
/** A try or a shift longer than this is a forgotten one, not a real one: refused, as sleeps over 12 hours are. */
export const MAX_SPAN_MS = 12 * 3600_000;
/** How far back a try or shift may be logged or moved. */
export const LOOKBACK_MS = 7 * 24 * 3600_000;
/** A planned handoff at most this far ahead. */
export const HANDOFF_AHEAD_MS = 12 * 3600_000;

export type SleepPlan = {
  baby_id: number;
  stage: PlanStage;
  /** When the current stage began (a stage change resets it): the suggestion reads tries since then. */
  stage_since: string;
  /** Where she sleeps now, mostly. */
  sleeps_now: SleepPlace | null;
  /** The family's goal, in their words (null: the default, "Sleeping in her bassinet in our room"). */
  goal: string | null;
  tries_per_day: number;
  /** Preferred try times, in order. */
  try_times: TrySlot[];
  /** When the planned try doesn't happen. */
  fallback: TrySlot | null;
  /** "Not now" on the stage suggestion: no suggestion through this try day (YYYY-MM-DD). */
  snoozed_until: string | null;
  revision: number;
  created_by: string | null;
  updated_by: string | null;
  source: Source;
  created_at: string;
  updated_at: string;
};

export type BassinetTry = {
  id: number;
  /** When she was laid down. */
  started_at: string;
  /** Null while she's down. */
  ended_at: string | null;
  outcome: TryOutcome | null;
  put_down_by: string | null;
  tags: TryTag[];
  note: string | null;
  /** The sleep entry this try sits on; sleep totals come only from sleep entries. */
  sleep_entry_id: number | null;
  /** The try created that sleep entry (no sleep was running or logged), so deleting the try deletes it too. */
  made_sleep: boolean;
  created_by: string | null;
  updated_by: string | null;
  source: Source;
  created_at: string;
  updated_at: string;
  /** The app only: saved on this phone, not confirmed yet. */
  pending?: boolean;
};

export type HoldingShift = {
  id: number;
  /** The adult holding her, staying awake (a member id). */
  holder: string;
  started_at: string;
  /** The planned handoff. */
  handoff_at: string | null;
  /** Who takes over (a member id), when planned. */
  next_holder: string | null;
  ended_at: string | null;
  ended_how: ShiftEnding | null;
  created_by: string | null;
  updated_by: string | null;
  source: Source;
  created_at: string;
  updated_at: string;
  pending?: boolean;
};

// ── sleep goals and the adults' check-ins ───────────────────────────────

/**
 * A goal is active or paused while the family works on it, and met or
 * dropped once they close it (update can open it again). Only active goals
 * count toward GOALS_ACTIVE_MAX.
 */
export const GOAL_STATUSES = ["active", "paused", "met", "dropped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const OPEN_GOAL_STATUSES: readonly GoalStatus[] = ["active", "paused"];
export const CLOSED_GOAL_STATUSES: readonly GoalStatus[] = ["met", "dropped"];

/**
 * What a goal measures, each counted from the log (goals.ts goalProgress):
 * - bassinet_nights: nights a week with a bassinet try that stayed asleep at
 *   least min_minutes (outcome stayed_asleep, laid down to the end).
 * - bassinet_stretch: the longest bassinet stretch, against `minutes`.
 * - protected_window: nights a week an adult's protected window held, from
 *   that adult's own check-ins (never shown to view-only guests).
 * - custom: the family's words; Maple doesn't count it.
 */
export const TARGET_KINDS = ["bassinet_nights", "bassinet_stretch", "protected_window", "custom"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export type BassinetNightsTarget = { id: string; kind: "bassinet_nights"; per_week: number; min_minutes: number };
export type BassinetStretchTarget = { id: string; kind: "bassinet_stretch"; minutes: number };
/** `member`: the adult (a member id) whose window it is. */
export type ProtectedWindowTarget = { id: string; kind: "protected_window"; member: string; per_week: number };
export type CustomTarget = { id: string; kind: "custom"; text: string };
export type GoalTarget = BassinetNightsTarget | BassinetStretchTarget | ProtectedWindowTarget | CustomTarget;

/** A weekly step: `week_of` is a date in the week it's planned for (the family's calendar), or null for "any time". */
export type GoalStep = { id: string; title: string; week_of: string | null; done_at: string | null; done_by: string | null };

/**
 * A protected sleep window on the night roster: `member` (a member id)
 * sleeps from `from` to `to` (local "HH:MM"), on the nights that begin on
 * the evenings in `nights` (0 = Sunday … 6 = Saturday). It may cross
 * midnight; a time before noon belongs to the morning after that evening,
 * as a try day does.
 */
export type RosterWindow = { id: string; member: string; from: string; to: string; nights: number[] };

export type SleepGoal = {
  id: number;
  baby_id: number;
  title: string;
  /** Why it matters to them, in their words. */
  why: string | null;
  /** YYYY-MM-DD in the family's calendar, or none. */
  target_date: string | null;
  status: GoalStatus;
  targets: GoalTarget[];
  steps: GoalStep[];
  roster: RosterWindow[];
  /** The last review (sleep_goal review, or closing it), with its short note. */
  last_review_at: string | null;
  review_note: string | null;
  /** When it was closed as met or dropped; null while it's open. */
  closed_at: string | null;
  revision: number;
  created_by: string | null;
  updated_by: string | null;
  source: Source;
  created_at: string;
  updated_at: string;
};

/** Did you get your protected sleep last night? Nothing else: never hours slept, mood, or anything about anyone's health. */
export const PROTECTED_ANSWERS = ["yes", "partly", "no"] as const;
export type ProtectedAnswer = (typeof PROTECTED_ANSWERS)[number];

/**
 * One adult's check-in for one night (`night`: the try day key, the date of
 * the evening it began), saved only by that adult for themselves. Owners and
 * members read every adult's; view-only guests never see them.
 */
export type SleepCheckin = {
  id: number;
  /** The adult it's about, who saved it (a member id). */
  member: string;
  night: string;
  protected: ProtectedAnswer;
  note: string | null;
  /**
   * Optional one-tap answers about the baby's night (CheckinExtras), on the
   * check-in of whoever answered first; absent from older rows, which an
   * older release reads past.
   */
  place?: CheckinPlace | null;
  untimed_try?: UntimedTry | null;
  /** The minutes "long" meant when it was asked (the goal's bassinet-nights minutes). */
  untimed_min?: number | null;
  handoff?: HandoffAnswer | null;
  source: Source;
  created_at: string;
  updated_at: string;
};

// ── the morning's extra answers (nullable columns on maple_sleep_checkins) ──

/** "Where did the baby spend most of last night?" Asked once a night: whoever answers first. */
export const CHECKIN_PLACES = ["bassinet", "held", "mixed", "elsewhere", "unsure"] as const;
export type CheckinPlace = (typeof CHECKIN_PLACES)[number];

/**
 * "Any bassinet try that isn't in the log?", asked only for a night with no
 * try logged: none, one that stayed asleep `untimed_min` or more (it counts
 * toward bassinet nights, shown apart as "from check-ins"), or a shorter one.
 */
export const UNTIMED_TRIES = ["no", "long", "short"] as const;
export type UntimedTry = (typeof UNTIMED_TRIES)[number];

/** "Did the handoff happen as planned?", asked only for a night with a planned handoff. */
export const HANDOFF_ANSWERS = ["on_time", "early", "late", "none"] as const;
export type HandoffAnswer = (typeof HANDOFF_ANSWERS)[number];

/** The extra answers as a write sends them: undefined leaves one as it is, null clears it. */
export type CheckinExtras = {
  place?: CheckinPlace | null;
  untimed_try?: UntimedTry | null;
  untimed_min?: number | null;
  handoff?: HandoffAnswer | null;
};

/** Goal limits, shared by the rules, the store, the route and the tool. */
export const GOAL_TITLE_MAX = 120;
export const GOAL_WHY_MAX = 300;
export const GOAL_NOTE_MAX = 300;
/** Active goals per baby, and open ones (active or paused). */
export const GOALS_ACTIVE_MAX = 5;
export const GOALS_OPEN_MAX = 10;
export const GOAL_TARGETS_MAX = 6;
export const GOAL_STEPS_MAX = 12;
export const GOAL_STEP_TITLE_MAX = 120;
export const GOAL_CUSTOM_MAX = 120;
export const ROSTER_MAX = 6;
/** A target date at most this many days ahead. */
export const GOAL_AHEAD_DAYS = 366;
/** A protected window's length on the clock. */
export const WINDOW_MIN_MINUTES = 30;
export const WINDOW_MAX_MINUTES = 12 * 60;
export const CHECKIN_NOTE_MAX = 200;
/** A check-in can be for one of this many most recent nights. */
export const CHECKIN_NIGHTS_BACK = 14;
/** A goal is due a review once this many days pass since its last one (or since it was set). */
export const REVIEW_DUE_DAYS = 7;
/** An untimed try's "long" is at least this many minutes (the goal's bassinet-nights minutes, 15 to 720). */
export const UNTIMED_MIN_RANGE = [15, 720] as const;

/** MapleState.sleep: what every phone shows. */
export type SleepState = {
  plan: SleepPlan | null;
  /** The last 8 days of tries, plus the running one, newest first. */
  tries: BassinetTry[];
  /** The open shift and the last 2 days' shifts, newest first. */
  shifts: HoldingShift[];
  /** Open goals and those closed in the last 60 days, newest first (sleep/goal-store.ts). */
  goals: SleepGoal[];
  /** The adults' check-ins for the last 14 nights, newest night first: owners and members only, absent for a view-only guest. */
  checkins?: SleepCheckin[];
};

/** A plan as an edit sends it: any subset, with the revision it was made from. */
export type PlanPatch = {
  stage?: PlanStage;
  sleeps_now?: SleepPlace | null;
  goal?: string | null;
  tries_per_day?: number;
  try_times?: TrySlot[];
  fallback?: TrySlot | null;
  snoozed_until?: string | null;
};

/**
 * A goal as goal.create and goal.update send it (POST /api/maple/sleep), and
 * what sleep_goal builds from a model's arguments once names are resolved:
 * people are member ids. On update every field is optional; a list given
 * replaces the whole list, and an item that names an existing `id` keeps it
 * (a step keeps whether it's done). New items get new ids.
 */
export type GoalTargetInput = {
  id?: string | null;
  kind: TargetKind;
  per_week?: number | null;
  min_minutes?: number | null;
  minutes?: number | null;
  member?: string | null;
  text?: string | null;
};
export type GoalStepInput = { id?: string | null; title: string; week_of?: string | null };
export type RosterWindowInput = { id?: string | null; member: string; from: string; to: string; nights: number[] };
export type GoalInput = {
  title?: string;
  why?: string | null;
  /** YYYY-MM-DD, or null for none. */
  target_date?: string | null;
  targets?: GoalTargetInput[];
  steps?: GoalStepInput[];
  roster?: RosterWindowInput[];
  /** goal.update only: between active and paused (and back from met or dropped). Closing is goal.close. */
  status?: "active" | "paused";
};
