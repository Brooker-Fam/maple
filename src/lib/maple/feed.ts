/**
 * Breastfeeding timer math. Pure and isomorphic so the server (REST + MCP)
 * and the client (optimistic updates, live clocks) agree on the numbers.
 *
 * A running nursing session is a list of segments, one per stretch on a side.
 * Exactly zero or one segment is open (end = null); zero open while the entry
 * is still active means "paused".
 */
import type { FeedData, Segment, Side } from "./types";

export const other = (s: Side): Side => (s === "L" ? "R" : "L");

export function openSegment(segments: Segment[] | undefined): Segment | null {
  if (!segments?.length) return null;
  const last = segments[segments.length - 1];
  return last.end === null ? last : null;
}

/** Close any open segment at `at` (never before its own start). */
export function closeSegments(segments: Segment[] | undefined, at: Date): Segment[] {
  return (segments ?? []).map((s) => {
    if (s.end !== null) return s;
    const end = Math.max(at.getTime(), Date.parse(s.start));
    return { ...s, end: new Date(end).toISOString() };
  });
}

/** Seconds per side; an open segment counts up to `now`. */
export function sideTotals(segments: Segment[] | undefined, now: Date): { left: number; right: number } {
  let left = 0;
  let right = 0;
  for (const s of segments ?? []) {
    const end = s.end ? Date.parse(s.end) : now.getTime();
    const sec = Math.max(0, (end - Date.parse(s.start)) / 1000);
    if (s.side === "L") left += sec;
    else right += sec;
  }
  return { left: Math.round(left), right: Math.round(right) };
}

/** Totals for any feed: from segments when present, else the manual numbers. */
export function feedTotals(data: FeedData, now: Date): { left: number; right: number; total: number } {
  if (data.segments?.length) {
    const t = sideTotals(data.segments, now);
    return { ...t, total: t.left + t.right };
  }
  const left = Math.round(data.left_sec ?? 0);
  const right = Math.round(data.right_sec ?? 0);
  return { left, right, total: left + right };
}

export function startBreast(side: Side, at: Date): FeedData {
  return {
    method: "breast",
    segments: [{ side, start: at.toISOString(), end: null }],
    first_side: side,
    last_side: side,
  };
}

/** Switch to a side (or resume on it when paused). No-op if already on that side. */
export function switchTo(data: FeedData, side: Side, at: Date): FeedData {
  const open = openSegment(data.segments);
  if (open && open.side === side) return data;
  const closed = closeSegments(data.segments, at);
  return {
    ...data,
    segments: [...closed, { side, start: at.toISOString(), end: null }],
    first_side: data.first_side ?? side,
    last_side: side,
  };
}

export function pause(data: FeedData, at: Date): FeedData {
  return { ...data, segments: closeSegments(data.segments, at) };
}

/** Freeze a finished nursing session: close segments, store totals + sides. */
export function finalizeBreast(data: FeedData, at: Date): FeedData {
  const segments = closeSegments(data.segments, at);
  const { left, right } = sideTotals(segments, at);
  const used = segments.filter((s) => Date.parse(s.end!) - Date.parse(s.start) >= 1000);
  return {
    ...data,
    segments,
    left_sec: left,
    right_sec: right,
    first_side: used[0]?.side ?? data.first_side,
    last_side: used[used.length - 1]?.side ?? data.last_side,
  };
}

/**
 * Which side to offer first next time: the opposite of the side the last
 * nursing session started on. (L→R last time? start on R. Only L? start on R.)
 */
export function suggestNextSide(last: FeedData | null | undefined): Side | null {
  if (!last || last.method !== "breast") return null;
  const first = last.first_side ?? last.segments?.[0]?.side;
  if (first) return other(first);
  const { left_sec = 0, right_sec = 0 } = last;
  if (left_sec > 0 && right_sec === 0) return "R";
  if (right_sec > 0 && left_sec === 0) return "L";
  return null;
}
