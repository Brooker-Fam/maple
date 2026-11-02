/**
 * The sleep plan's own words: stages, try times, outcomes, tags and places,
 * shared by the app, the routes and the MCP tools. This is plan copy (what
 * the family chose and how the log reads), not health guidance: anything
 * that makes a claim about babies lives in ../guidelines/sleep.ts with its
 * source. Copy about the baby takes a Voice (../voice.ts).
 */
import { formatTime } from "../time";
import type { SleepPlace } from "../types";
import type { Voice } from "../voice";
import type { PlanStage, ShiftEnding, TryAnchor, TryOutcome, TrySlot, TryTag } from "./types";
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
