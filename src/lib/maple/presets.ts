import { feedCtx, feedParts, isTracked } from "./feed";
import type { Entry } from "./types";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Most one-tap times a question shows: two rows of three on a 375px phone. */
export const PRESET_LIMIT = 6;

/** Sides recent enough, and long enough in number, to call a length "usual". */
const USUAL_DAYS = 7;
const USUAL_MIN_SAMPLES = 4;
/** A side this long was left running, not a feed. */
const USUAL_MAX_SIDE_MIN = 60;

/** The middle value of whole numbers (the lower middle of an even count). */
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

/**
 * Her usual time on one side, in whole minutes: the median of the Left and
 * Right sides in her timed feeds over the last 7 days, once there are four.
 * A side over an hour is a forgotten timer and a side under 2 minutes a
 * stray tap, so neither counts. null until there is enough to go on.
 */
export function usualSideMin(entries: readonly Entry[], now: Date): number | null {
  const since = now.getTime() - USUAL_DAYS * DAY;
  const lengths: number[] = [];
  for (const e of entries) {
    if (e.kind !== "feed" || e.active || e.data.method !== "breast" || !e.data.segments?.length) continue;
    if (Date.parse(e.started_at) < since) continue;
    for (const p of feedParts(e.data, feedCtx(e, now))) {
      if (p.kind === "side" && isTracked(p.side) && p.end !== null && p.min >= 2 && p.min <= USUAL_MAX_SIDE_MIN) lengths.push(p.min);
    }
  }
  return lengths.length >= USUAL_MIN_SAMPLES ? median(lengths) : null;
}

/**
 * Her usual pause, in whole minutes (a burp, a diaper, a latch that needed
 * redoing): the median of the breaks inside her timed feeds over the last
 * 7 days, once there are four. Breaks over 30 minutes ended the feed.
 */
export function usualBreakMin(entries: readonly Entry[], now: Date): number | null {
  const since = now.getTime() - USUAL_DAYS * DAY;
  const lengths: number[] = [];
  for (const e of entries) {
    if (e.kind !== "feed" || e.active || e.data.method !== "breast" || !e.data.segments?.length) continue;
    if (Date.parse(e.started_at) < since) continue;
    for (const p of feedParts(e.data, feedCtx(e, now))) {
      if (p.kind === "break" && !p.legacy && p.end !== null && p.min >= 1 && p.min <= 30) lengths.push(p.min);
    }
  }
  return lengths.length >= USUAL_MIN_SAMPLES ? median(lengths) : null;
}

/**
 * Cap a ranked list: nothing outside [min, max], no two on one clock minute
 * (the higher-ranked stays), and no more than `limit` grid cells (a preset
 * with `wide` takes two, like "Since the last feed").
 */
export function fitPresets<T extends { at: number; wide?: boolean }>(ranked: readonly T[], bounds: { min: number; max: number }, limit = PRESET_LIMIT): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  let cells = 0;
  for (const p of ranked) {
    const minute = Math.floor(p.at / MIN);
    const width = p.wide ? 2 : 1;
    if (p.at < bounds.min || p.at > bounds.max || seen.has(minute) || cells + width > limit) continue;
    seen.add(minute);
    out.push(p);
    cells += width;
  }
  return out;
}

export type FinishPreset = {
  id: string;
  at: number;
  kind: "now" | "likely" | "usual" | "on" | "ago";
  /** "ago": minutes before now. "on": minutes after she went on. */
  minutes: number;
};

/** The "likely" end: exactly this long on the side. */
export const LIKELY_SIDE_MIN = 15;

/**
 * "When did she finish?" for the side she is on, most likely first: Now (when
 * Done was tapped), then "likely" (15 min on the side), then her usual side
 * length when it is a different time, then plain choices. A side left on for
 * hours gets "10 / 20 min after she went on" before the "ago" ones, which then
 * are hours, not minutes. Every time is at least a minute after `start` and
 * not after `now`, so the engine takes each one.
 */
export function finishPresets(o: {
  start: number;
  now: number;
  fromDone: boolean;
  usualMin: number | null;
  /** Back and forth, or not nursing at all (sleep, tummy time): there is no one side's 15 minutes. */
  both: boolean;
  /** Plain choices for a short side (default 5 / 10 / 20 / 30). */
  agoMins?: number[];
  /** "After N min" choices for a side left on for hours (default 10 / 20; none for sleep). */
  onMins?: number[];
}): FinishPreset[] {
  const { start, now } = o;
  const ago = (m: number) => now - m * MIN;
  const fits = (m: number) => ago(m) >= start + MIN;
  const forgotten = fits(60);
  const agoOf = (t: number) => Math.max(1, Math.round((now - t) / MIN));
  const ranked: FinishPreset[] = [];
  if (o.fromDone) ranked.push({ id: "stop-now", at: now, kind: "now", minutes: 0 });
  // The tag goes on a time a couple of minutes back at least: a "likely" that is nearly now is just Now.
  const tagged = (kind: "likely" | "usual", onSide: number) => {
    const t = start + onSide * MIN;
    if (o.both || t < start + MIN || t >= now - 2 * MIN) return;
    const m = agoOf(t);
    ranked.push({ id: `stop-${kind}`, at: ago(m), kind, minutes: m });
  };
  tagged("likely", LIKELY_SIDE_MIN);
  if (o.usualMin !== null && Math.abs(o.usualMin - LIKELY_SIDE_MIN) >= 3) tagged("usual", o.usualMin);
  if (forgotten) {
    for (const k of o.onMins ?? [10, 20]) ranked.push({ id: `stop-on-${k}`, at: start + k * MIN, kind: "on", minutes: k });
  }
  let mins = forgotten ? [10, 30, 60, 120, 180] : (o.agoMins ?? [5, 10, 20, 30]);
  mins = mins.filter(fits);
  if (mins.length < 2) mins = [1, 2, 3, 5, 10, 20, 30].filter(fits);
  for (const m of mins) ranked.push({ id: `stop-${m}`, at: ago(m), kind: "ago", minutes: m });
  return fitPresets(ranked, { min: start + MIN, max: now });
}

export type EarlierPreset = {
  id: string;
  at: number;
  kind: "likely" | "usual" | "floor" | "feed" | "earlier";
  /** Minutes before the recorded time (every kind but "floor" and "feed", which land where they land). */
  minutes: number;
  wide?: boolean;
};

export const EARLIER_MINS = [2, 5, 10, 15, 20, 30];
/** When fewer than three of those fit (a short stretch), the small ones too. */
const EARLIER_MINS_SHORT = [1, 2, 3, 5, 10, 15, 20, 30];

/**
 * "Was it earlier?" for a moment the tap recorded (a start, a switch, a
 * Resume, a Done): the guesses first ("likely", "usual"), then "No break"
 * (`floor`, when she came off) and "Since the last feed" (`feedFloor`), then
 * plain "N min earlier" chips. Each is N whole minutes before `recorded`, so
 * tapping two never adds up. Nothing lands before `min` (the edgeBounds
 * `uiMin`), at or before `floor`, or over the feed before (`feedFloor`, where
 * "Since the last feed" takes the place of what it clipped).
 */
export function earlierPresets(o: {
  recorded: number;
  min: number;
  floor?: number | null;
  feedFloor?: number | null;
  smart?: { kind: "likely" | "usual"; at: number }[];
  mins?: number[];
  limit?: number;
}): EarlierPreset[] {
  const { recorded } = o;
  const floor = o.floor ?? null;
  const feedFloor = o.feedFloor ?? null;
  const open = (to: number) => (floor !== null ? to > floor : to >= o.min) && (feedFloor === null || to >= feedFloor);
  const ranked: EarlierPreset[] = [];
  for (const g of o.smart ?? []) {
    const m = Math.round((recorded - g.at) / MIN);
    const at = recorded - m * MIN;
    if (m >= 2 && open(at) && at >= o.min) ranked.push({ id: `a-${g.kind}`, at, kind: g.kind, minutes: m });
  }
  if (floor !== null) ranked.push({ id: "a-floor", at: floor, kind: "floor", minutes: Math.round((recorded - floor) / MIN) });
  let plain: EarlierPreset[] = [];
  let clipped = false;
  const gather = (mins: number[]) => {
    plain = [];
    clipped = false;
    for (const n of mins) {
      const at = recorded - n * MIN;
      if (feedFloor !== null && at < feedFloor && at >= o.min) clipped = true;
      if (open(at) && at >= o.min) plain.push({ id: `a-${n}`, at, kind: "earlier", minutes: n });
    }
  };
  gather(o.mins ?? EARLIER_MINS);
  if (!o.mins && plain.length + (floor !== null ? 1 : 0) + (clipped ? 1 : 0) < 3) gather(EARLIER_MINS_SHORT);
  const lastTo = Math.min(recorded, ...plain.map((p) => p.at), ...(floor !== null ? [floor] : []));
  if (clipped && feedFloor !== null && lastTo - feedFloor >= MIN && feedFloor >= o.min) {
    ranked.push({ id: "a-feed", at: feedFloor, kind: "feed", minutes: Math.round((recorded - feedFloor) / MIN), wide: true });
  }
  ranked.push(...plain);
  const chosen = fitPresets(ranked, { min: Math.min(o.min, floor ?? o.min), max: recorded }, o.limit);
  // Named and guessed ones lead; the plain minutes follow in time order.
  return [...chosen.filter((p) => p.kind !== "earlier"), ...chosen.filter((p) => p.kind === "earlier").sort((a, b) => a.minutes - b.minutes)];
}

export type BackOnPreset = {
  id: string;
  /** null: now, taken when it is tapped. */
  at: number | null;
  kind: "now" | "usual" | "floor" | "ago";
  /** "ago": minutes before now. "usual": minutes after she came off. */
  minutes: number;
};

/**
 * "Already back on?" / "When did she go back on?" after a break that began at
 * `pauseAt`: Now (`withNow`), then her usual break, "No break" (back on the
 * moment she came off), then plain "N min ago". Nothing lands at or before
 * the pause, in the pause's own minute (that is "No break"), or after
 * `latest` (now, or the Done tap less a minute). A break that ran for hours
 * is asked in hours, as "When did she finish?" is.
 */
export function backOnPresets(o: { pauseAt: number; now: number; latest: number; withNow: boolean; usualMin: number | null; agoMins?: number[] }): BackOnPreset[] {
  const { pauseAt, now, latest } = o;
  const pauseMinute = Math.floor(pauseAt / MIN);
  const open = (at: number) => at > pauseAt && Math.floor(at / MIN) !== pauseMinute && at <= latest;
  const ranked: BackOnPreset[] = [];
  if (o.withNow && now <= latest) ranked.push({ id: "back-now", at: null, kind: "now", minutes: 0 });
  if (o.usualMin !== null) {
    const at = pauseAt + o.usualMin * MIN;
    if (open(at) && at <= now - 2 * MIN) ranked.push({ id: "back-usual", at, kind: "usual", minutes: o.usualMin });
  }
  ranked.push({ id: "back-floor", at: pauseAt, kind: "floor", minutes: 0 });
  const forgotten = now - pauseAt >= 60 * MIN;
  for (const m of o.agoMins ?? (forgotten ? [10, 30, 60, 120, 180] : [2, 5, 10, 20])) {
    const at = now - m * MIN;
    if (open(at)) ranked.push({ id: `back-${m}`, at, kind: "ago", minutes: m });
  }
  const bounds = { min: pauseAt, max: latest };
  const kept = fitPresets(
    ranked.map((p) => ({ ...p, at: p.at ?? now })),
    bounds
  );
  return kept.map((p) => (p.kind === "now" ? { ...p, at: null } : p));
}
