import { localParts } from "./time";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type ClockSpan = {
  /** Real instants, clipped to the requested window, with an exclusive end. */
  start: number;
  end: number;
  /** Positions on a 24-hour wall-clock scale, starting at midnight or noon. */
  x1: number;
  x2: number;
};

/** Position on the family's wall clock; repeated hours occupy the same place. */
export function clockFraction(t: number, wallStartMin: number, tz: string): number {
  const p = localParts(t, tz);
  const millis = ((t % 1000) + 1000) % 1000;
  const minutes = p.hour * 60 + p.minute + p.second / 60 + millis / MINUTE;
  return (((minutes - wallStartMin) % 1440) + 1440) % 1440 / 1440;
}

/** Hit testing shares the drawn clock pieces, including either repeated hour. */
export function clockContains(fraction: number, x1: number, x2: number, toleranceMinutes = 0): boolean {
  const padding = toleranceMinutes / 1440;
  return [fraction - 1, fraction, fraction + 1].some((f) => f >= x1 - padding && f <= x2 + padding);
}

/** Offset at whole-second precision, matching Intl's local clock parts. */
function offsetAt(t: number, tz: string): number {
  const second = Math.floor(t / 1000) * 1000;
  const p = localParts(second, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - second;
}

/**
 * Draw an interval on a local-clock scale without moving its endpoints when
 * the clocks change. A spring interval leaves the nonexistent hour blank; a
 * fall interval can cover the same part of the clock twice. Totals should keep
 * using elapsed real time, not the union or width of these display pieces.
 *
 * Split at both offset changes and the scale's origin (midnight/noon). This
 * also lets a rolling window cross midnight without drawing through noon.
 * Zero-length events are points, so callers draw those separately.
 */
export function clockSpans(
  from: number,
  to: number,
  windowStart: number,
  windowEnd: number,
  wallStartMin: number,
  tz: string
): ClockSpan[] {
  const start = Math.max(from, windowStart);
  const end = Math.min(to, windowEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

  const cuts = [start];
  let cursor = start;
  let offset = offsetAt(cursor, tz);
  // Modern IANA clock changes are separated by much more than an hour. The
  // hour scan finds a change; binary search finds its exact boundary rather
  // than rounding a mark to a sampled minute.
  while (cursor < end - 1) {
    const probe = Math.min(cursor + HOUR, end - 1);
    const nextOffset = offsetAt(probe, tz);
    if (nextOffset === offset) {
      cursor = probe;
      continue;
    }
    let left = cursor;
    let right = probe;
    while (right - left > 1) {
      const middle = Math.floor((left + right) / 2);
      if (offsetAt(middle, tz) === offset) left = middle;
      else right = middle;
    }
    cuts.push(right);
    cursor = right;
    offset = nextOffset;
  }
  cuts.push(end);

  const spans: ClockSpan[] = [];
  for (let i = 1; i < cuts.length; i++) {
    let a = cuts[i - 1];
    const limit = cuts[i];
    while (a < limit) {
      const x1 = clockFraction(a, wallStartMin, tz);
      const nextOrigin = Math.round(a + (1 - x1) * DAY);
      const b = Math.min(limit, nextOrigin);
      if (b <= a) break;
      // Within this piece the offset is constant. Deriving the end from its
      // elapsed time keeps the old side of a transition (e.g. 2 AM, not 1 AM).
      spans.push({ start: a, end: b, x1, x2: Math.min(1, x1 + (b - a) / DAY) });
      a = b;
    }
  }
  return spans;
}
