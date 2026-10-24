"use client";

import { describeEntry } from "@/lib/maple/describe";
import { formatRelative, formatTime } from "@/lib/maple/time";
import type { Entry } from "@/lib/maple/types";
import { Icon, KindBadge } from "./icons";
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
