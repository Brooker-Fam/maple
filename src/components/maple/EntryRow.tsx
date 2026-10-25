"use client";

import { describeEntry } from "@/lib/maple/describe";
import { minutesShort, nursingRuns, sideMinutesText, spanText, type NursingRun } from "@/lib/maple/feed";
import { formatRelative, formatTime } from "@/lib/maple/time";
import type { Entry, EntryOf } from "@/lib/maple/types";
import { Icon, KIND_ICON, KindBadge } from "./icons";
import { KIND_COLOR } from "./palette";
import { Avatar, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

const VIA: Record<string, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  mcp: "AI",
  shortcut: "Siri",
};

/** Photo thumbnail URL for a moment's photo by position (served through the auth proxy). */
export function photoUrl(entryId: number, index: number, size: "thumb" | "full" = "thumb"): string {
  return `/api/maple/photo?entry=${entryId}&i=${index}&size=${size}`;
}

/**
 * One line in a list of entries: the kind's icon, what happened, when, and
 * who logged it (only when it wasn't you). Tap to edit. Lists put these in a
 * card with hairline dividers (tone.divide), or a thread (the Timeline).
 */
export default function EntryRow({
  entry,
  onClick,
  showRelative = false,
  now,
}: {
  entry: Entry;
  onClick?: () => void;
  /** "2h ago" under the clock time (Today screen). */
  showRelative?: boolean;
  now: Date;
}) {
  const { units, state, member } = useMaple();
  const tz = state?.baby.timezone ?? "America/New_York";
  const d = describeEntry(entry, { units, now });
  const who = member(entry.created_by);
  const firstPhoto = entry.kind === "moment" && entry.data.photos?.length && entry.id > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(tone.row, "min-h-[56px] py-2.5")}
    >
      {firstPhoto ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photoUrl(entry.id, 0)} alt="" className="h-9 w-9 shrink-0 rounded-[10px] object-cover" loading="lazy" />
      ) : (
        // No pulse on a live one: "Nursing now" and its minutes already say so, and a pulse reads as a loading skeleton.
        <KindBadge entry={entry} />
      )}
      {/* Two lines that share baselines: what + when, then detail + how long ago. A one-line entry stays one line. */}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-3">
          <span className={cx(tone.body, "min-w-0 flex-1 truncate text-[15px] font-medium")}>{d.title}</span>
          <span className={cx(tone.body, "inline-flex shrink-0 items-center gap-1.5 self-center text-sm tabular-nums")}>
            {entry.id < 0 && (
              <span title="Saving…" className="inline-flex text-mp-ink-3">
                <Icon name="refresh-cw" size={12} label="Not synced yet" />
              </span>
            )}
            {/* Your own rows go unmarked: the initial only says when someone else logged it. */}
            {entry.created_by && entry.created_by !== state?.me.email && <Avatar member={who} size={16} />}
            {formatTime(entry.started_at, tz)}
          </span>
        </span>
        {(d.detail || entry.note || VIA[entry.source] || showRelative) && (
          <span className="flex items-baseline gap-3">
            <span className={cx(tone.muted, "min-w-0 flex-1 truncate text-[13px]")}>
              {[d.detail, entry.note ? `“${entry.note}”` : ""].filter(Boolean).join(" · ")}
            </span>
            {(VIA[entry.source] || showRelative) && (
              <span className={cx(tone.faint, "shrink-0 text-[12px]")}>
                {[VIA[entry.source] && `via ${VIA[entry.source]}`, showRelative && formatRelative(entry.started_at, now)].filter(Boolean).join(" · ")}
              </span>
            )}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * A cluster on the Timeline: one row, "Cluster · 4 feeds" with its span in
 * the time column ("6:02–8:40 PM"), and its nursing and sides under it
 * ("nursed 1h 52m (L 18 · R 22 · both 1h 12m)"). The Timeline puts it where
 * its newest feed would be. Tapping opens it to its feeds, each opening its
 * own sheet, and a row about cluster feeding (the Cluster feeding sheet).
 * `entries` are that day's feeds in it, newest first (a cluster across
 * midnight shows on each day with that day's feeds); `runs` are the
 * cluster's own feeds (worked out from the whole log) that have one of those
 * entries, so the count and span are the cluster's, never recounted from a
 * subset (a feed's first half before a long pause isn't part of it).
 */
export function ClusterRow({
  entries,
  runs: given,
  now,
  expanded,
  onToggle,
  onOpenEntry,
  onInfo,
  glow,
}: {
  entries: EntryOf<"feed">[];
  runs?: readonly NursingRun[];
  now: Date;
  expanded: boolean;
  onToggle: () => void;
  onOpenEntry: (e: Entry) => void;
  onInfo: () => void;
  glow?: Set<number>;
}) {
  const { state } = useMaple();
  const tz = state?.baby.timezone ?? "America/New_York";
  const runs = given?.length ? given : nursingRuns(entries, now);
  const start = runs[0]?.start ?? Date.parse(entries[entries.length - 1].started_at);
  const last = runs[runs.length - 1];
  const end = last ? last.end : null;
  const min = { left: 0, right: 0, both: 0, total: 0, has: { L: false, R: false, B: false } };
  for (const r of runs) {
    min.left += r.min.left;
    min.right += r.min.right;
    min.both += r.min.both;
    min.total += r.min.total;
    min.has = { L: min.has.L || r.min.has.L, R: min.has.R || r.min.has.R, B: min.has.B || r.min.has.B };
  }
  const sides = sideMinutesText(min);
  const id = `maple-cluster-${entries[0].id}`;
  return (
    <div>
      <button type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={id} className={cx(tone.row, "min-h-[56px] py-2.5")}>
        {/* A feed badge without a side letter: the cluster is several feeds. */}
        <KindBadge icon={KIND_ICON.feed} color={KIND_COLOR.feed} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-3">
            <span className={cx(tone.body, "min-w-0 flex-1 truncate text-[15px] font-medium")}>
              Cluster · {runs.length} feed{runs.length === 1 ? "" : "s"}
            </span>
            {/* Its span where a row's time goes: the row sits at its newest feed, so the rows under it read in order. */}
            <span className={cx(tone.body, "inline-flex shrink-0 items-center gap-1 self-center text-sm tabular-nums")}>
              {spanText(start, end, tz)}
              <Icon name="chevron-down" size={15} className={cx("text-mp-ink-3 transition", expanded && "rotate-180")} />
            </span>
          </span>
          {/* Wraps between its parts, never inside the side minutes. */}
          <span className={cx(tone.muted, "block text-[13px] leading-snug")}>
            <span className="whitespace-nowrap">nursed {minutesShort(min.total)}</span>
            {sides && <span className="whitespace-nowrap"> ({sides})</span>}
          </span>
        </span>
      </button>
      {expanded && (
        <div id={id} className="mx-3 mb-3 overflow-hidden rounded-xl bg-mp-sunken">
          <div className={tone.divide}>
            {entries.map((e) => (
              <div key={e.id} data-entry-id={e.id} className={cx("transition-colors duration-700", glow?.has(e.id) && "bg-mp-focus/20")}>
                <EntryRow entry={e} now={now} onClick={() => onOpenEntry(e)} />
              </div>
            ))}
            <button type="button" onClick={onInfo} className={cx(tone.row, "min-h-[48px] py-2 text-[14px] text-mp-ink-2")}>
              <span aria-hidden className="flex w-9 shrink-0 justify-center text-mp-ink-3">
                <Icon name="info" size={17} />
              </span>
              <span className="min-w-0 flex-1">About cluster feeding</span>
              <Icon name="chevron-right" size={16} className="shrink-0 text-mp-ink-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
