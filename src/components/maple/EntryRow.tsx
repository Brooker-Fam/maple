"use client";

import { describeEntry, entryEmoji } from "@/lib/maple/describe";
import { formatRelative, formatTime } from "@/lib/maple/time";
import type { Entry } from "@/lib/maple/types";
import { entryColor } from "./palette";
import { Avatar, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

const VIA: Record<string, { label: string; className: string }> = {
  claude: { label: "✦ Claude", className: "bg-[#B8A9C9]/30 text-[#4A2A6A] dark:text-[#D4C8E0]" },
  chatgpt: { label: "✦ ChatGPT", className: "bg-[#5C7A4A]/20 text-[#2E4A22] dark:text-[#C0D4A8]" },
  mcp: { label: "✦ AI", className: "bg-[#B8A9C9]/30 text-[#4A2A6A] dark:text-[#D4C8E0]" },
  shortcut: { label: "Siri", className: "bg-[#6FA3B8]/20 text-[#24505F] dark:text-[#B8D8E4]" },
};

/** Photo thumbnail URL for a moment's photo by position (served through the auth proxy). */
export function photoUrl(entryId: number, index: number, size: "thumb" | "full" = "thumb"): string {
  return `/api/maple/photo?entry=${entryId}&i=${index}&size=${size}`;
}

/**
 * One line in a list of entries: colored emoji badge, what happened, when,
 * and who logged it. Tap to edit.
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
  const color = entryColor(entry);
  const emoji = entryEmoji(entry);
  const firstPhoto = entry.kind === "moment" && entry.data.photos?.length && entry.id > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left transition hover:bg-[#1D4420]/[0.04] active:scale-[0.99] dark:hover:bg-[#F5EDDF]/5"
    >
      {firstPhoto ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photoUrl(entry.id, 0)} alt="" className="h-11 w-11 shrink-0 rounded-2xl object-cover" loading="lazy" />
      ) : (
        <span
          className={cx(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl",
            // Two-emoji badges (wet + dirty) need to shrink to fit the tile.
            [...emoji].length > 2 ? "whitespace-nowrap text-[12px] leading-none tracking-[-0.15em]" : "text-xl",
            entry.active && "animate-pulse"
          )}
          style={{ backgroundColor: `${color}22`, boxShadow: `inset 0 0 0 1.5px ${color}55` }}
          aria-hidden
        >
          {emoji}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className={cx(tone.body, "block truncate text-[15px] font-semibold")}>{d.title}</span>
        {(d.detail || entry.note) && (
          <span className={cx(tone.muted, "block truncate text-[13px]")}>
            {[d.detail, entry.note ? `“${entry.note}”` : ""].filter(Boolean).join(" · ")}
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <span className={cx(tone.body, "text-sm font-semibold tabular-nums")}>
          {entry.id < 0 && <span className={cx(tone.muted, "mr-1 text-xs")} title="Saving…" aria-label="Not synced yet">⋯</span>}
          {formatTime(entry.started_at, tz)}
        </span>
        <span className={cx(tone.muted, "flex items-center gap-1 text-[11px]")}>
          {VIA[entry.source] && (
            <span className={cx("rounded-full px-1.5 py-px text-[10px] font-semibold", VIA[entry.source].className)}>
              {VIA[entry.source].label}
            </span>
          )}
          {showRelative && formatRelative(entry.started_at, now)}
          <Avatar member={who} size={18} />
        </span>
      </span>
    </button>
  );
}
