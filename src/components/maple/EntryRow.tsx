"use client";

import { describeEntry, feedPartsSummary, feedPartWords, milkWords } from "@/lib/maple/describe";
import { minutesShort, nursingRuns, sideMinutesText, spanText, type NursingRun } from "@/lib/maple/feed";
import { dayKey, formatDayLabel, formatRelative, formatTime } from "@/lib/maple/time";
import type { Entry, EntryOf } from "@/lib/maple/types";
import { useMilestoneWords } from "./familyWords";
import { fixPreset } from "./FeedParts";
import { Icon, KIND_ICON, KindBadge } from "./icons";
import { KIND_COLOR } from "./palette";
import { photoUrl } from "./moments/photo";
import { Avatar, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

const VIA: Record<string, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  muse: "Muse",
  grok: "Grok",
  mcp: "AI",
  shortcut: "Siri",
  chat: "Maple chat",
  epic: "MyChart import",
};

export { photoUrl } from "./moments/photo";

/** The Timeline's hairline between badges (36px, inset 16px), stopping short of each. */
const THREAD = "pointer-events-none absolute left-[33.25px] w-[1.5px] bg-mp-line";

/**
 * One line in a list of entries: the kind's icon, what happened, when, and
 * who logged it (only when it wasn't you). Tap to edit. Lists put these in a
 * card with hairline dividers (tone.divide), or a thread (the Timeline).
 *
 * A nursing feed's parts (`parts`: the bottles given with it, its milk at the
 * breast and its top-up, feed-rows.ts) sit under its row as small pills, "+ 20
 * ml in the SNS" "+ 30 ml top-up", so the row tells the whole feed; each pill
 * opens that bottle to edit or delete (`onOpenPart`).
 */
export default function EntryRow({
  entry,
  onClick,
  showRelative = false,
  quietAction = false,
  topUp = false,
  now,
  parts,
  onOpenPart,
  thread,
  glow,
}: {
  entry: Entry;
  onClick?: () => void;
  /** "2h ago" under the clock time (Today screen). */
  showRelative?: boolean;
  /**
   * Today's short list: no "Edit" / "Edit time" word on the right, only a faint chevron after the time, which sits on
   * the title's line. The whole row is still the tap, and its accessible name still says what the tap does.
   */
  quietAction?: boolean;
  /**
   * A bottle given with a nursing feed (feed.ts topUpIds), shown on its own row (its feed isn't in this list): it reads
   * as part of that feed ("Top-up", "SNS at the breast"). The list works it out from its own entries.
   */
  topUp?: boolean;
  now: Date;
  /** A nursing feed's parts, oldest first: pills under its row. */
  parts?: readonly EntryOf<"feed">[];
  onOpenPart?: (e: EntryOf<"feed">) => void;
  /** On the Timeline, for a row with parts: the thread up to its badge, and down past its parts to the next row. */
  thread?: { up: boolean; down: boolean };
  /** Parts that just arrived from another phone (they glow, as rows do). */
  glow?: ReadonlySet<number>;
}) {
  const { units, state, member, readOnly } = useMaple();
  const words = useMilestoneWords();
  const tz = state?.baby.timezone ?? "America/New_York";
  const d = describeEntry(entry, { units, now, words, topUp });
  const who = member(entry.created_by);
  const firstPhoto = entry.kind === "moment" && entry.data.photos?.length && entry.id > 0;

  const canEdit = !!onClick && !readOnly && entry.id > 0;
  const editLabel = entry.source === "epic" ? "View" : entryEditPreset(entry) ? "Edit time" : "Edit";
  const entryDay = dayKey(new Date(entry.started_at), tz);
  const today = dayKey(now, tz);
  // A date-only clinical observation has an internal day anchor, not a known clock time.
  const entryWhen = entry.source === "epic" ? formatDayLabel(entryDay, today) : `${formatDayLabel(entryDay, today)} at ${formatTime(entry.started_at, tz)}`;

  const row = (
    <button
      type="button"
      onClick={onClick}
      aria-label={canEdit ? `${editLabel}: ${d.title}, ${entryWhen}` : undefined}
      className={cx(tone.row, "@container/entry min-h-[64px] py-3")}
    >
      <span className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 @min-[18rem]/entry:grid-cols-[auto_minmax(0,1fr)_auto]">
        {firstPhoto ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photoUrl(entry.id, entry.kind === "moment" ? entry.data.photos?.[0]?.id ?? 0 : 0)} alt="" className="h-9 w-9 shrink-0 rounded-[10px] object-cover" loading="lazy" />
        ) : (
          <KindBadge entry={entry} />
        )}
        <span className="col-span-2 row-start-2 min-w-0 @min-[18rem]/entry:col-span-1 @min-[18rem]/entry:col-start-2 @min-[18rem]/entry:row-start-1">
          <span className={cx(tone.body, "block text-[15px] leading-snug font-medium")}>{d.title}</span>
          {(d.detail || entry.note) && (
            <span className={cx(tone.muted, "mt-0.5 block text-[13px] break-words")}>
              {[d.detail, entry.note ? `“${entry.note}”` : ""].filter(Boolean).join(" · ")}
            </span>
          )}
          {(VIA[entry.source] || showRelative) && (
            <span className={cx(tone.faint, "mt-0.5 block text-[12px]")}>
              {[VIA[entry.source] && `via ${VIA[entry.source]}`, showRelative && entry.source !== "epic" && formatRelative(entry.started_at, now)].filter(Boolean).join(" · ")}
            </span>
          )}
        </span>
        <span className={cx("col-start-2 row-start-1 flex min-w-0 flex-col items-end gap-0.5 text-right @min-[18rem]/entry:col-start-3", quietAction && "@min-[18rem]/entry:self-start")}>
          {entryDay !== today && entry.source !== "epic" && <span className={cx(tone.muted, "text-[12px]")}>{formatDayLabel(entryDay, today)}</span>}
          <span className={cx(tone.body, "inline-flex items-center gap-1.5 text-sm tabular-nums")}>
            {entry.id < 0 && <Icon name="refresh-cw" size={12} label="Not synced yet" className="text-mp-ink-3" />}
            {entry.created_by && entry.created_by !== state?.me.email && <Avatar member={who} size={16} />}
            {entry.source === "epic" ? formatDayLabel(entryDay, today) : formatTime(entry.started_at, tz)}
            {canEdit && quietAction && <Icon name="chevron-right" size={15} className="-mx-0.5 shrink-0 text-mp-ink-3" />}
          </span>
          {canEdit && !quietAction && <span className="text-[13px] font-medium text-mp-accent-fg">{editLabel}</span>}
        </span>
      </span>
    </button>
  );
  if (!parts?.length) return row;
  return (
    <div>
      <div className="relative">
        {thread?.up && <span aria-hidden className={cx(THREAD, "top-0 h-[calc(50%-22px)]")} />}
        {thread?.down && <span aria-hidden className={cx(THREAD, "bottom-0 h-[calc(50%-22px)]")} />}
        {row}
      </div>
      <FeedPartsLine parts={parts} now={now} onOpen={onOpenPart} glow={glow} thread={!!thread?.down} />
    </div>
  );
}

/**
 * A nursing row's parts, under its words: "+ 20 ml in the SNS", "+ 30 ml
 * top-up", one pill each, lighter than the row (they're part of it). Each is a
 * bottle entry of its own, so a tap opens it to edit or delete; its name says
 * what it is in full ("Edit: + 20 ml in the SNS · formula, Today at 9:52 AM").
 * Overlaps the row's bottom padding, letting taps there through to the row.
 */
export function FeedPartsLine({
  parts,
  now,
  onOpen,
  glow,
  thread,
}: {
  parts: readonly EntryOf<"feed">[];
  now: Date;
  onOpen?: (e: EntryOf<"feed">) => void;
  glow?: ReadonlySet<number>;
  /** The Timeline's thread runs on past the parts to the next row. */
  thread?: boolean;
}) {
  const { units, state, readOnly } = useMaple();
  const tz = state?.baby.timezone ?? "America/New_York";
  const today = dayKey(now, tz);
  return (
    <div className="pointer-events-none relative -mt-2.5 pb-1.5 @container/parts">
      {thread && <span aria-hidden className={cx(THREAD, "top-0 bottom-0")} />}
      {/* In line with the row's words (past the badge), or under it on a narrow row, as EntryRow lays them out. */}
      <div className="flex flex-wrap gap-x-1.5 pr-4 pl-4 @min-[18rem]/parts:pl-16">
        {parts.map((b) => {
          const words = feedPartWords(b, units);
          // Its name holds what the pill says (what a voice-control user says to tap it), then the rest of it.
          const more = [milkWords(b.data, units), b.data.via === "paced" ? "paced bottle" : null].filter(Boolean).join(" · ");
          const day = dayKey(new Date(b.started_at), tz);
          const when = `${formatDayLabel(day, today)} at ${formatTime(b.started_at, tz)}`;
          return (
            <button
              key={b.id}
              type="button"
              data-entry-id={b.id}
              onClick={onOpen ? () => onOpen(b) : undefined}
              aria-label={`${!readOnly && b.id > 0 ? "Edit: " : ""}${words}${more ? ` · ${more}` : ""}, ${when}`}
              className="group pointer-events-auto flex min-h-[44px] items-center"
            >
              <span
                className={cx(
                  "inline-flex min-h-[30px] items-center gap-1 rounded-full bg-mp-sunken px-2.5 text-[13px] font-medium text-mp-ink-2 transition group-active:scale-[0.97] in-[.bg-mp-sunken]:bg-mp-raised",
                  glow?.has(b.id) && "ring-2 ring-mp-focus/50"
                )}
              >
                {b.id < 0 && <Icon name="refresh-cw" size={11} label="Not synced yet" className="text-mp-ink-3" />}
                {words}
                {!readOnly && <Icon name="chevron-right" size={13} className="-mr-0.5 shrink-0 text-mp-ink-3" />}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Editors get quick corrections; viewers retain the complete read-only record. */
export function entryEditPreset(entry: Entry, readOnly = false): Record<string, unknown> | undefined {
  return !readOnly && entry.kind === "feed" && entry.data.method === "breast" && !entry.active && entry.data.segments?.length ? fixPreset("finish") : undefined;
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
 * `parts`: each feed's parts listed with it that day (its milk at the breast,
 * its top-ups): summed in the line under the count ("+ 60 ml in 2 top-ups"),
 * and pills under each feed once it's open.
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
  parts,
}: {
  entries: EntryOf<"feed">[];
  runs?: readonly NursingRun[];
  now: Date;
  expanded: boolean;
  onToggle: () => void;
  onOpenEntry: (e: Entry) => void;
  onInfo: () => void;
  glow?: Set<number>;
  parts?: ReadonlyMap<number, readonly EntryOf<"feed">[]>;
}) {
  const { state, units } = useMaple();
  const tz = state?.baby.timezone ?? "America/New_York";
  const allParts = entries.flatMap((e) => parts?.get(e.id) ?? []);
  const partsLine = feedPartsSummary(allParts, units);
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
            {/* Its newest feed's time, where it sits in the list (newest first), so the rows around it read in order; the
                span goes in the line under it, so a span across noon or midnight never squeezes the count. */}
            <span className={cx(tone.body, "inline-flex shrink-0 items-center gap-1 self-center text-sm tabular-nums")}>
              {formatTime(entries[0].started_at, tz)}
              <Icon name="chevron-down" size={15} className={cx("text-mp-ink-3 transition", expanded && "rotate-180")} />
            </span>
          </span>
          {/* Wraps between its parts, never inside the span or the side minutes. */}
          <span className={cx(tone.muted, "block text-[13px] leading-snug")}>
            {/* The spaces between the parts sit outside them: those are where the line may wrap. */}
            <span className="whitespace-nowrap">{spanText(start, end, tz)}</span>{" "}
            <span className="whitespace-nowrap">· nursed {minutesShort(min.total)}</span>
            {sides && (
              <>
                {" "}
                <span className="whitespace-nowrap">({sides})</span>
              </>
            )}
            {partsLine && (
              <>
                {" "}
                <span className="whitespace-nowrap">· {partsLine}</span>
              </>
            )}
          </span>
        </span>
      </button>
      {expanded && (
        <div id={id} className="mx-3 mb-3 overflow-hidden rounded-xl bg-mp-sunken">
          <div className={tone.divide}>
            {entries.map((e) => (
              <div key={e.id} data-entry-id={e.id} className={cx("transition-colors duration-700", glow?.has(e.id) && "bg-mp-focus/20")}>
                <EntryRow entry={e} now={now} onClick={() => onOpenEntry(e)} parts={parts?.get(e.id)} onOpenPart={onOpenEntry} glow={glow} />
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
