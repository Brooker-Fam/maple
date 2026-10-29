import { feedCtx, feedParts } from "./feed";
import type { EntryOf, StretchSide } from "./types";

export type NursingSpan = { start: number; end: number; side: StretchSide; live: boolean };

/**
 * The nursing stretches drawn by clocks and ribbons. The shared feed parts
 * supply timed stretches, so pauses are never painted as nursing. Typed
 * minutes keep the dial's existing order: first side, other side, then both.
 * Counts and totals still come from nursingRuns/statsFor, never these marks.
 */
export function nursingSpans(entry: EntryOf<"feed">, now: Date): NursingSpan[] {
  if (entry.data.method === "bottle") return [];
  const spans: NursingSpan[] = [];
  const nowMs = now.getTime();
  const add = (start: number, end: number, side: StretchSide, live: boolean) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > nowMs || end < start) return;
    spans.push({ start, end: Math.min(end, nowMs), side, live });
  };
  const data = entry.data;
  if (data.segments?.length) {
    for (const part of feedParts(data, feedCtx(entry, now))) {
      if (part.kind !== "side") continue;
      const start = Date.parse(part.start);
      const end = part.end ? Date.parse(part.end) : entry.active ? nowMs : entry.ended_at ? Date.parse(entry.ended_at) : start;
      add(start, end, part.side, entry.active && part.end === null);
    }
  } else {
    const first = data.first_side ?? (data.left_sec ? "L" : "R");
    const other = first === "L" ? "R" : "L";
    const firstSec = Math.max(0, (first === "L" ? data.left_sec : data.right_sec) ?? 0);
    const otherSec = Math.max(0, (other === "L" ? data.left_sec : data.right_sec) ?? 0);
    const bothSec = Math.max(0, data.both_sec ?? 0);
    const start = Date.parse(entry.started_at);
    if (firstSec || (!otherSec && !bothSec)) add(start, start + firstSec * 1000, first, false);
    if (otherSec) add(start + firstSec * 1000, start + (firstSec + otherSec) * 1000, other, false);
    if (bothSec) add(start + (firstSec + otherSec) * 1000, start + (firstSec + otherSec + bothSec) * 1000, "B", false);
  }
  return spans;
}
