/**
 * A feed's parts in a list: the bottles given with a nursing feed (its run's
 * top-ups, feed.ts: milk at the breast by SNS or syringe, a top-up by bottle)
 * read as part of that feed's row, not as rows of their own. They stay their
 * own entries (every milk total counts them, and each opens to edit or
 * delete); only where they show changes. Today's Recently logged, the
 * Timeline (its clusters too), Happening now and the feed form read the same
 * rule from here.
 */
import type { NursingRun } from "./feed";
import type { Entry, EntryOf } from "./types";

export type FeedRowParts = {
  /** A nursing entry's id → the bottles its row shows, oldest first. */
  byRow: Map<number, EntryOf<"feed">[]>;
  /** A bottle's id → the nursing entry whose row shows it. */
  rowOf: Map<number, number>;
};

const startOf = (e: Entry) => Date.parse(e.started_at);

/**
 * Which row shows each of a feed's parts: the run's last nursing entry that
 * began by the time the bottle was given (the side she was on), else its first
 * (milk readied a few minutes before she latched).
 */
export function feedRowParts(runs: readonly NursingRun[]): FeedRowParts {
  const byRow = new Map<number, EntryOf<"feed">[]>();
  const rowOf = new Map<number, number>();
  for (const r of runs) {
    if (!r.topUps.length || !r.entries.length) continue;
    const entries = [...r.entries].sort((a, b) => startOf(a) - startOf(b) || a.id - b.id);
    for (const b of r.topUps) {
      if (rowOf.has(b.id)) continue;
      const at = startOf(b);
      const row = entries.filter((e) => startOf(e) <= at).pop() ?? entries[0];
      rowOf.set(b.id, row.id);
      const list = byRow.get(row.id);
      if (list) list.push(b);
      else byRow.set(row.id, [b]);
    }
  }
  for (const list of byRow.values()) list.sort((a, b) => startOf(a) - startOf(b) || a.id - b.id);
  return { byRow, rowOf };
}

/**
 * Today's Recently logged: the newest `count` finished entries (newest
 * first, as given), a feed's parts riding on its row: one feed with its milk
 * at the breast and its top-up is one row, never three, and it sits where the
 * feed began (a top-up given late doesn't move it). A part of a feed still
 * running is on that feed's card on Today, so it isn't a row either.
 */
export function recentRows(entries: readonly Entry[], parts: FeedRowParts, count: number): Entry[] {
  return entries.filter((e) => !e.active && !parts.rowOf.has(e.id)).slice(0, count);
}

/** A row's parts as one list shows them: only those listed with it (the same day, the same filter). */
export function partsShown(parts: FeedRowParts, rowId: number, shown: ReadonlySet<number>): EntryOf<"feed">[] {
  return (parts.byRow.get(rowId) ?? []).filter((b) => shown.has(b.id));
}
