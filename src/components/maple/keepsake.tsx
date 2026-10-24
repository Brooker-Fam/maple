"use client";

import { babyAge, parseDayKey } from "@/lib/maple/time";
import { MAPLE_LEAF_PATH } from "./Hero";
import { cx } from "./ui";

/**
 * Shared by the keepsakes (Moments, the celebration card): the maple leaf
 * that means "kept", and the way a kept thing is dated ("Day 4 · Fri, Oct 23").
 */

/**
 * Maple's leaf: the mark for something kept (a first that was found, a
 * celebration, a monthly moment without its photo). Not a stamp for every card.
 * Rust by day; at night it folds into the amber like every other color.
 */
export function LeafMark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="-11 -11 22 22" width={size} height={size} className={cx("shrink-0 text-mp-maple [.maple-night_&]:text-mp-ink-2", className)} aria-hidden focusable="false">
      <path d={MAPLE_LEAF_PATH} fill="currentColor" />
    </svg>
  );
}

/** Compact age for Firsts, cards and celebrations: "Day 3", "2w 3d", "3mo"; null before she's born. */
export function ageShort(bornAt: string | null, at: string, tz: string): string | null {
  if (!bornAt) return null;
  if (Date.parse(at) < Date.parse(bornAt)) return "Before birth";
  const age = babyAge(bornAt, new Date(at), tz);
  return age.days < 14 ? `Day ${age.dayOfLife}` : age.short;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * "Fri, Oct 23" for a day key, with the year once it isn't this year's. Never
 * "Yesterday": a keepsake keeps its date.
 */
export function keptDate(key: string, todayKey?: string): string {
  const { year, month, day } = parseDayKey(key);
  const wd = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const otherYear = todayKey && todayKey.slice(0, 4) !== key.slice(0, 4);
  return `${WEEKDAY[wd]}, ${MON[month - 1]} ${day}${otherYear ? `, ${year}` : ""}`;
}
