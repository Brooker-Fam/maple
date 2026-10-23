"use client";

import { describeEntry } from "@/lib/maple/describe";
import { formatRelative, formatTime } from "@/lib/maple/time";
import type { Entry } from "@/lib/maple/types";
import { KindBadge } from "./icons";
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
 * who logged it. Tap to edit. Lists put these in a card with hairline
 * dividers (tone.divide).
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
      className={cx(tone.row, "min-h-[60px] py-2.5")}
    >
      {firstPhoto ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photoUrl(entry.id, 0)} alt="" className="h-9 w-9 shrink-0 rounded-[10px] object-cover" loading="lazy" />
      ) : (
        <KindBadge entry={entry} className={cx(entry.active && "animate-pulse")} />
      )}
      <span className="min-w-0 flex-1">
        <span className={cx(tone.body, "block truncate text-[15px] font-medium")}>{d.title}</span>
        {(d.detail || entry.note) && (
          <span className={cx(tone.muted, "block truncate text-[13px]")}>
            {[d.detail, entry.note ? `“${entry.note}”` : ""].filter(Boolean).join(" · ")}
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <span className={cx(tone.body, "text-sm tabular-nums")}>
          {entry.id < 0 && <span className={cx(tone.faint, "mr-1 text-xs")} title="Saving…" aria-label="Not synced yet">⋯</span>}
          {formatTime(entry.started_at, tz)}
        </span>
        <span className={cx(tone.faint, "flex items-center gap-1 text-[11px]")}>
          {VIA[entry.source] && <span>via {VIA[entry.source]}</span>}
          {VIA[entry.source] && showRelative && <span aria-hidden>·</span>}
          {showRelative && formatRelative(entry.started_at, now)}
          <Avatar member={who} size={16} />
        </span>
      </span>
    </button>
  );
}
