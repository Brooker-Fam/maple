/**
 * The sleep plan's shapes: the family's plan for moving from held sleep to
 * the bassinet in their room, bassinet tries, and holding shifts (who is
 * holding the baby awake). Isomorphic, like ../types.ts: no node or browser
 * APIs. Nothing here is about the care person: her page's things never
 * belong in a plan, a try or a shift.
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

/** MapleState.sleep: what every phone shows. */
export type SleepState = {
  plan: SleepPlan | null;
  /** The last 8 days of tries, plus the running one, newest first. */
  tries: BassinetTry[];
  /** The open shift and the last 2 days' shifts, newest first. */
  shifts: HoldingShift[];
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
