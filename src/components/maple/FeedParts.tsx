"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  describeChange,
  edgeBounds,
  feedCtx,
  FeedEditError,
  feedEditCopy,
  feedParts,
  minutesText,
  momentQuestion,
  moveEdge,
  partTotals,
  spanMinutes,
  type Part,
} from "@/lib/maple/feed";
import { DEFAULT_TZ, formatClock, formatRange, formatTime, formatTimeNear } from "@/lib/maple/time";
import type { Entry, FeedData, Side, StretchRef, TimerKind } from "@/lib/maple/types";
import { Icon } from "./icons";
import { SIDE_COLOR, SIDE_INK } from "./palette";
import { cx, TimeScrubber } from "./ui";
import { useMaple } from "./useMaple";

/**
 * The pieces a feed is drawn with, shared by the timer card, Fix times and
 * (for finished feeds) FeedSheet: the rows that say what happened (one per
 * side part and break, each time labelled), the live block, the moment
 * editor, and the two-line time chips.
 *
 * Words come from the feed engine (src/lib/maple/feed.ts) and clock text from
 * time.ts, so the card, the sheet, toasts and Claude say the same thing.
 */

export { formatRange };

export const SIDE_NAME: Record<Side, string> = { L: "Left", R: "Right" };
export const KIND_TITLE: Record<TimerKind, string> = { feed: "Nursing", sleep: "Asleep", tummy: "Tummy time", pump: "Pumping" };

/**
 * Where Fix times opens, resolved to a pin once the sheet is open: "current"
 * (the live part, or the end of a finished feed), "finish" (a finished feed's
 * end), a side part ({ ref }), or the break after the stretch `breakAfter`
 * (a Break row: it pins the side she went back on, with a way to the end of
 * the side before it).
 */
export type FixTarget = "current" | "finish" | { ref: StretchRef } | { breakAfter: StretchRef };
/** What the sheet starts with expanded: "She already finished" (Still nursing?) or "Already back on?" (She went back on…). */
export type FixExpand = "finished" | "backOn";
/**
 * `doneAt`: the Done tap that ended this feed at its pause (the Done toast's
 * "She went back on…"): she went back on and finished then, so the side
 * Fix times adds ends at `doneAt` and the feed stays finished.
 */
export type FixPreset = { fix: { target: FixTarget; expand?: FixExpand; doneAt?: string } };

/** open({ kind, entry, preset: fixPreset(target) }) opens Fix times instead of the entry's form. */
export const fixPreset = (target: FixTarget, expand?: FixExpand, doneAt?: string): FixPreset => ({
  fix: { target, ...(expand ? { expand } : {}), ...(doneAt ? { doneAt } : {}) },
});

type SidePart = Extract<Part, { kind: "side" }>;

/** A side's letter on a dot of its color: which breast, at a glance. */
export function SideMark({ side, size = 24, className }: { side: Side; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx("mp-kind-fill mp-side-mark inline-flex shrink-0 items-center justify-center rounded-full font-bold", className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46), backgroundColor: SIDE_COLOR[side], color: SIDE_INK[side] }}
    >
      {side}
    </span>
  );
}

/** A break: the pause glyph in a dashed ring (a gap, not a side). */
export function BreakMark({ size = 24, open, className }: { size?: number; open?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-full text-mp-ink-2",
        open ? "bg-mp-sunken" : "border border-dashed border-mp-ink-3",
        className
      )}
      style={{ width: size, height: size }}
    >
      <Icon name="pause" size={Math.round(size * 0.5)} />
    </span>
  );
}

/** "22 minutes", "less than a minute", "1 hour 12 minutes": whole minutes (minutesText), read aloud. */
export function minutesAloud(min: number): string {
  const m = minutesText(min);
  if (m === "<1 min") return "less than a minute";
  const hm = /^(\d+)h (\d+)m$/.exec(m);
  if (hm) return `${+hm[1]} hour${+hm[1] === 1 ? "" : "s"}${+hm[2] ? ` ${+hm[2]} minute${+hm[2] === 1 ? "" : "s"}` : ""}`;
  const n = parseInt(m, 10);
  return `${n} minute${n === 1 ? "" : "s"}`;
}

/** "6 minutes 2 seconds": a live clock, read aloud. */
export function clockAloud(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const bits = [h && `${h} hour${h === 1 ? "" : "s"}`, m && `${m} minute${m === 1 ? "" : "s"}`, (r || (!h && !m)) && `${r} second${r === 1 ? "" : "s"}`];
  return bits.filter(Boolean).join(" ");
}

/** "Left, 11:04 to 11:26 PM, 22 minutes" (a row's accessible name, before "Fix this part."). */
export function partAria(p: Part, tz: string = DEFAULT_TZ): string {
  const name = p.kind === "side" ? SIDE_NAME[p.side] : "Break";
  const range = p.end === null ? `since ${formatTime(p.start, tz)}` : formatRange(p.start, p.end, tz).replace(" – ", " to ");
  return `${name}, ${range}, ${minutesAloud(p.min)}`;
}

/** The start of a range, with its AM/PM in a span that hides under 360px (where the range wraps under the name). */
function RangeText({ start, end, tz }: { start: string; end: string | null; tz: string }) {
  if (end === null) return <>since {formatTime(start, tz)}</>;
  const full = formatRange(start, end, tz);
  const [a, b] = full.split(" – ");
  const m = /^(.*?)(\s[AP]M)$/i.exec(a);
  return (
    <>
      {m ? (
        <>
          {m[1]}
          <span className="max-[359px]:hidden">{m[2]}</span>
        </>
      ) : (
        a
      )}
      {" – "}
      {b}
    </>
  );
}

// Past rows at night: marks dim to 65%; the text keeps 4.5:1 on the night card (amber at 72%, not ink-2 at 65%, which measured 2.6:1).
const NIGHT_TEXT = "[.maple-night_&]:text-[rgb(224_169_59/0.72)]";
const NIGHT_DIM = "[.maple-night_&]:opacity-65";

/**
 * The parts of a feed as rows: "(L) Left  11:04 – 11:26 PM  22 min  ›" and
 * "‖ Break  11:26 – 11:37 PM  11 min  ›". Each row is a button that opens
 * its fix (or, staged, its moment lines underneath).
 *
 *   mode "card"    the timer card's past rows: dimmed at night, chevrons.
 *   mode "sheet"   the same rows at full strength inside a sheet.
 *   mode "staged"  FeedSheet's Times list: tapping a row toggles `renderOpen`
 *                  under it (openIndex is the open one; one at a time).
 *
 * fold (Today): more than two parts show the newest one under a single
 * "Earlier · L 18 min · R 9 min · from 10:30 PM" row that expands in place
 * (the fold resets when the card remounts). readOnly (viewers) renders plain
 * text: no buttons, no chevrons.
 */
export function PartRows({
  parts,
  mode,
  tz,
  readOnly,
  fold,
  disabled,
  onPick,
  openIndex,
  renderOpen,
}: {
  parts: Part[];
  mode: "card" | "sheet" | "staged";
  tz: string;
  readOnly?: boolean;
  fold?: boolean;
  /** A timer still starting (temporary id): rows wait. */
  disabled?: boolean;
  onPick?: (part: Part, index: number) => void;
  openIndex?: number | null;
  renderOpen?: (part: Part, index: number) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!parts.length) return null;
  const folded = !!fold && !expanded && parts.length > 2;
  const shown = folded ? parts.slice(-1) : parts;
  const offset = folded ? parts.length - 1 : 0;
  const card = mode === "card";

  let earlier: ReactNode = null;
  if (folded) {
    const hidden = parts.slice(0, -1);
    const totals = partTotals(hidden);
    const t = totals.min;
    const has = (s: Side) => hidden.some((p) => p.kind === "side" && p.side === s);
    // A folded break still shows ("· break 18 min"), so the fold never hides that she was off.
    const brk = totals.breakCount ? `${totals.breakCount > 1 ? `${totals.breakCount} breaks` : "break"} ${minutesText(t.breaks)}` : "";
    const bits = [has("L") ? `L ${minutesText(t.left)}` : "", has("R") ? `R ${minutesText(t.right)}` : "", brk].filter(Boolean);
    const text = ["Earlier", ...bits, `from ${formatTime(hidden[0].start, tz)}`].join(" · ");
    earlier = readOnly ? (
      <div className={cx("flex min-h-[44px] items-center gap-2 text-[13px] text-mp-ink-2", card && NIGHT_TEXT)}>
        <span className="truncate">{text}</span>
      </div>
    ) : (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-expanded={false}
        aria-label={`${text}. Show every part`}
        className={cx("-mx-2 flex min-h-[44px] w-[calc(100%+16px)] items-center gap-2 rounded-xl px-2 text-left text-[13px] text-mp-ink-2 active:bg-mp-ink/5", card && NIGHT_TEXT)}
      >
        <span className="line-clamp-2 min-w-0 flex-1 leading-[17px]">{text}</span>
        <Icon name="chevron-down" size={16} className={cx("shrink-0 text-mp-ink-3", card && NIGHT_DIM)} />
      </button>
    );
  }

  return (
    <div>
      {earlier}
      {shown.map((p, j) => {
        const i = j + offset;
        const isOpen = mode === "staged" && openIndex === i;
        const body = (
          <>
            <span className={cx("flex w-7 shrink-0 justify-start", card && NIGHT_DIM)}>
              {p.kind === "side" ? <SideMark side={p.side} size={24} /> : <BreakMark size={24} />}
            </span>
            <span className="flex min-w-0 flex-1 items-baseline gap-2 max-[359px]:flex-col max-[359px]:gap-0">
              <span className={cx("w-[46px] shrink-0 text-mp-ink-2", p.kind === "side" ? "text-[15px] font-medium" : "text-[14px]", card && NIGHT_TEXT)}>
                {p.kind === "side" ? SIDE_NAME[p.side] : "Break"}
              </span>
              <span className={cx("min-w-0 text-[14px] text-mp-ink-2 tabular-nums", card && NIGHT_TEXT)}>
                <RangeText start={p.start} end={p.end} tz={tz} />
              </span>
            </span>
            <span className={cx("shrink-0 text-[14px] text-mp-ink-2 tabular-nums", card && NIGHT_TEXT)}>{minutesText(p.min)}</span>
            {!readOnly && <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={16} className={cx("shrink-0 text-mp-ink-3", card && NIGHT_DIM)} />}
          </>
        );
        const key = p.kind === "side" ? `s-${p.ref.start}` : `b-${p.start}`;
        return (
          <div key={key}>
            {readOnly ? (
              <div className="flex min-h-[44px] items-center gap-2">{body}</div>
            ) : (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPick?.(p, i)}
                aria-expanded={mode === "staged" ? isOpen : undefined}
                aria-label={`${partAria(p, tz)}. Fix this part.`}
                className="-mx-2 flex min-h-[44px] w-[calc(100%+16px)] items-center gap-2 rounded-xl px-2 text-left transition active:bg-mp-ink/5 disabled:opacity-50"
              >
                {body}
              </button>
            )}
            {isOpen && renderOpen?.(p, i)}
          </div>
        );
      })}
    </div>
  );
}

/** Live numbers for a running timer: the current part (a side, or the open break), totals and parts. */
export function timerNumbers(e: Entry, now: Date) {
  const wallSec = Math.max(0, (now.getTime() - Date.parse(e.started_at)) / 1000);
  if (e.kind === "feed" && e.data.method === "breast" && e.data.segments?.length) {
    const parts = feedParts(e.data, feedCtx(e, now));
    const t = partTotals(parts);
    const sides = parts.filter((p): p is SidePart => p.kind === "side");
    const lastSide = sides[sides.length - 1];
    const last = parts[parts.length - 1];
    const paused = last?.kind === "break" && last.end === null;
    const side: Side = lastSide?.side ?? e.data.last_side ?? "L";
    // sec drives the live clock; min is the same part in the rows' whole minutes (for words like "Right side for 52 min").
    const current = paused
      ? { kind: "break" as const, side, since: last.start, sec: last.sec, min: last.min }
      : { kind: "side" as const, side, since: lastSide?.start ?? e.started_at, sec: lastSide?.sec ?? wallSec, min: lastSide?.min ?? spanMinutes(e.started_at, now) };
    return {
      /** Exact seconds nursing (stats, logic); `totalMin` is the one to show. */
      elapsed: t.nursing,
      /**
       * "Total nursing 13 min": every side row's whole minutes, the live one counted to now (spanMinutes), nothing
       * for a break. The rows' rule, so it equals the Done toast and the Today list, flips with them on the clock
       * minute, and never moves at a Switch or Pause (the row that closes has the minutes the live side had).
       */
      totalMin: t.min.nursing,
      wallSec,
      left: t.left,
      right: t.right,
      side: side as Side | null,
      paused,
      pausedSec: paused ? last.sec : 0,
      lastSegStart: Date.parse(lastSide?.start ?? e.started_at),
      parts,
      sideCount: sides.length,
      /** Closed breaks (an open one is the live part). */
      closedBreaks: parts.filter((p) => p.kind === "break" && p.end !== null).length,
      current,
    };
  }
  return {
    elapsed: wallSec,
    totalMin: spanMinutes(e.started_at, now),
    wallSec,
    left: 0,
    right: 0,
    side: null as Side | null,
    paused: false,
    pausedSec: 0,
    lastSegStart: Date.parse(e.started_at),
    parts: [] as Part[],
    sideCount: 0,
    closedBreaks: 0,
    current: { kind: "side" as const, side: undefined as Side | undefined, since: e.started_at, sec: wallSec, min: spanMinutes(e.started_at, now) },
  };
}

export type TimerNumbers = ReturnType<typeof timerNumbers>;

/** UX defaults (not health rules): when a running timer asks "still going?". Family settings can override. */
const CHECK_AFTER_MIN: Record<TimerKind, number> = { feed: 45, sleep: 300, tummy: 30, pump: 60 };
/** A break this long asks "Still on a break?". */
const CHECK_BREAK_MIN = 20;
const SNOOZE_MIN = 30;
const SNOOZE_KEY = "maple-timer-snooze";

/** Which check a running timer is on: a feed's side ("Still nursing?"), its break ("Still on a break?"), or another timer's length. */
export type StillCheck = "side" | "break" | "timer";

// Snoozes are shared by the card, the dock and the Lantern ("Still going" on the card un-asks all three), and kept
// per entry and check: "Still going" on a long side doesn't mute "Still on a break?" when she comes off.
let snoozeCache: Record<string, number> | null = null;
const snoozeSubs = new Set<() => void>();
const NO_SNOOZES: Record<string, number> = {};
function readSnoozes(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}
const snoozeSnapshot = () => (snoozeCache ??= readSnoozes());
function subscribeSnoozes(cb: () => void) {
  snoozeSubs.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== SNOOZE_KEY) return;
    snoozeCache = null;
    cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    snoozeSubs.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Has a running timer gone past its "still going?" check (the side she's on,
 * or the break, for a feed; wall time for the others), not snoozed? While it
 * has, the card asks "Still nursing?", the Lantern says so, and the dock's
 * Done asks when she finished instead of ending the feed now. Viewers and a
 * timer still starting are never asked.
 */
export function useStillGoing(entry: Entry | null, n: TimerNumbers | null, now: Date): { forgotten: boolean; check: StillCheck; snooze: () => void } {
  const { state, readOnly } = useMaple();
  const snoozes = useSyncExternalStore(subscribeSnoozes, snoozeSnapshot, () => NO_SNOOZES);
  const kind = (entry?.kind ?? "feed") as TimerKind;
  const check: StillCheck = !entry || !n || kind !== "feed" || !n.parts.length ? "timer" : n.paused ? "break" : "side";
  const settings = (state?.baby.settings ?? {}) as Record<string, unknown>;
  const checkMin = Number(settings[`timer_check_${kind}_min`]) || CHECK_AFTER_MIN[kind] || CHECK_AFTER_MIN.feed;
  const long = !n ? false : check === "break" ? n.current.sec / 60 >= CHECK_BREAK_MIN : check === "side" ? n.current.sec / 60 >= checkMin : n.wallSec / 60 >= checkMin;
  // Per part too: "Still going" on one break doesn't mute the next break (or side) of the same feed.
  const key = entry ? `${entry.id}:${check}${n && check !== "timer" ? `:${n.current.since}` : ""}` : "";
  const forgotten = !!entry && !readOnly && entry.id > 0 && long && now.getTime() > (snoozes[key] ?? 0);
  const snooze = () => {
    if (!key) return;
    const t = now.getTime();
    const next = { ...snoozeSnapshot(), [key]: t + SNOOZE_MIN * 60_000 };
    // Drop stale snoozes so the key never grows.
    for (const [k, v] of Object.entries(next)) if (v < t - 86_400_000) delete next[k];
    try {
      localStorage.setItem(SNOOZE_KEY, JSON.stringify(next));
    } catch {
      // storage blocked: the snooze lasts until reload
    }
    snoozeCache = next;
    for (const cb of snoozeSubs) cb();
  };
  return { forgotten, check, snooze };
}

/**
 * The live part of a running timer, as one button that opens Fix times on
 * it: "(R) Right side · since 11:37 PM ›" over the time on this side, with
 * "Total nursing 28 min / break not counted" beside it once there's more than
 * one part (the rows' whole minutes added up, see timerNumbers). Paused,
 * it's the break and its clock, dimmed. When the total can't fit beside a
 * long clock it drops under it as one line.
 */
export function LiveBlock({
  entry,
  n,
  tz,
  onPick,
  disabled,
  readOnly,
  compact,
}: {
  entry: Entry;
  n: TimerNumbers;
  tz: string;
  onPick?: () => void;
  disabled?: boolean;
  readOnly?: boolean;
  /** Short screens: a 44px clock instead of 56px. */
  compact?: boolean;
}) {
  const isFeed = entry.kind === "feed" && n.parts.length > 0;
  const paused = isFeed && n.paused;
  const since = formatTime(n.current.since, tz);
  const what = !isFeed ? KIND_TITLE[entry.kind as TimerKind] ?? "Timer" : paused ? "On a break" : `${SIDE_NAME[n.current.side ?? "L"]} side`;
  const showTotal = isFeed && (n.sideCount >= 2 || n.parts.some((p) => p.kind === "break"));
  const note = n.closedBreaks ? (n.closedBreaks > 1 ? "breaks not counted" : "break not counted") : null;

  // Does the stacked total fit beside the clock? Measured, since the clock's width changes as it runs.
  const row = useRef<HTMLDivElement>(null);
  const big = useRef<HTMLParagraphElement>(null);
  const [inline, setInline] = useState(false);
  const clockText = formatClock(n.current.sec);
  useLayoutEffect(() => {
    if (!showTotal || !row.current || !big.current) return;
    const room = row.current.clientWidth - big.current.offsetWidth - 12;
    setInline(room < 104);
  }, [showTotal, clockText, compact]);

  const aria = `${what}, ${clockAloud(n.current.sec)}, since ${since}.${showTotal ? ` Total nursing ${minutesAloud(n.totalMin)}.` : ""}${readOnly ? "" : " Fix times."}`;
  const body = (
    <>
      <span className="flex min-h-[24px] items-center gap-2">
        {isFeed && (paused ? <BreakMark open size={24} /> : <SideMark side={n.current.side ?? "L"} size={24} />)}
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-mp-ink">
          {/* The card's title already names a nap or tummy time ("Asleep"), so only a feed says which part this is. */}
          {isFeed ? `${what} · since ${since}` : `Since ${since}`}
        </span>
        {!readOnly && <Icon name="chevron-right" size={18} className="shrink-0 text-mp-ink-3" />}
      </span>
      <span ref={row} className={cx("flex flex-wrap items-end justify-between gap-x-3", compact ? "mt-0.5" : "mt-1.5")}>
        <span
          ref={big}
          className={cx(
            "leading-none font-semibold tracking-[-0.03em] tabular-nums",
            compact ? "text-[44px]" : "text-[56px]",
            // The one live number on screen gets a soft amber glow at night (never by day, never paused).
            paused ? "text-mp-ink-2 opacity-45" : "text-mp-ink [.maple-night_&]:[text-shadow:0_0_22px_rgb(224_169_59/0.3)]"
          )}
        >
          {clockText}
        </span>
        {showTotal &&
          (inline ? (
            <span className="mt-1 w-full text-[13px] text-mp-ink-2 tabular-nums">
              Total nursing {minutesText(n.totalMin)}
              {note && ` · ${note}`}
            </span>
          ) : (
            // Compact: the three lines fit the 44px clock's height (leading-none), so the card keeps its budget.
            <span className={cx("ml-auto flex flex-col items-end text-right", compact ? "leading-none" : "leading-tight")}>
              <span className="text-[12px] text-mp-ink-2">Total nursing</span>
              <span className="text-[20px] font-semibold text-mp-ink-2 tabular-nums">{minutesText(n.totalMin)}</span>
              {note && <span className="text-[11px] text-mp-ink-2">{note}</span>}
            </span>
          ))}
      </span>
    </>
  );
  if (readOnly) {
    return (
      <div role="group" aria-label={aria} className="block">
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onPick}
      aria-label={aria}
      className="-mx-2 -my-1 block w-[calc(100%+16px)] rounded-2xl px-2 py-1 text-left transition active:bg-mp-ink/5 disabled:opacity-60"
    >
      {body}
    </button>
  );
}

/** A small ring that turns while a chip saves (it rests at night, like every animation). */
export function Spinner({ size = 14 }: { size?: number }) {
  return <span aria-hidden className="inline-block shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" style={{ width: size, height: size }} />;
}

/**
 * A two-line time chip: "5 min earlier" over the time it produces. "move"
 * chips (they move a recorded moment) are outlined; "stop" chips (they end
 * the timer) are filled with a check, so the two never look alike. While
 * saving, line 2 becomes "Saving…".
 */
export function TimeChip({
  line1,
  line2,
  onClick,
  disabled,
  busy,
  variant = "move",
  ring,
  ariaLabel,
  tall,
  className,
}: {
  line1: string;
  line2: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  variant?: "move" | "stop";
  /** The likely end, when the sheet was opened from "Still nursing?". */
  ring?: boolean;
  ariaLabel?: string;
  /** 56px (the chip grids) instead of 48px. */
  tall?: boolean;
  /** Grid placement ("col-span-2" for a chip with a long first line). */
  className?: string;
}) {
  const stop = variant === "stop";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      className={cx(
        "flex min-w-0 flex-col items-center justify-center rounded-xl px-1 text-center transition active:scale-[0.97] disabled:opacity-45 disabled:active:scale-100",
        tall ? "min-h-[56px]" : "min-h-[48px]",
        stop
          ? "bg-mp-sunken text-mp-ink [.maple-night_&]:bg-[rgb(224_169_59/0.15)]"
          : "border border-mp-line bg-mp-surface text-mp-ink active:bg-mp-sunken [.maple-night_&]:border-[rgb(224_169_59/0.55)] [.maple-night_&]:bg-transparent [.maple-night_&]:text-[#E8A23F] [.maple-night_&]:active:bg-[rgb(224_169_59/0.2)]",
        ring && "ring-2 ring-mp-accent-fg",
        className
      )}
    >
      {/* One line at 375 px ("20 min ago" never wraps); no check on stop chips, which made every one look already picked. */}
      <span className="text-[15px] leading-tight font-semibold tracking-[-0.01em] whitespace-nowrap max-[350px]:text-[13px]">{line1}</span>
      <span className="mt-0.5 flex items-center gap-1.5 text-[13px] leading-tight text-mp-ink-2 tabular-nums">
        {busy ? (
          <>
            <Spinner size={12} />
            Saving…
          </>
        ) : (
          line2
        )}
      </span>
    </button>
  );
}

/** A 48px row that opens something: "Other time… ›", "Feed started 4:00 PM ›", "She already finished ›". */
export function LinkRow({
  children,
  onClick,
  disabled,
  expanded,
  trailing,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** For a row that opens a section in place (chevron turns down). */
  expanded?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-expanded={expanded}
      className="-mx-2 flex min-h-[48px] w-[calc(100%+16px)] items-center gap-2 rounded-xl px-2 text-left text-[15px] font-medium text-mp-ink transition active:bg-mp-ink/5 disabled:opacity-45"
    >
      <span className="min-w-0 flex-1">{children}</span>
      {trailing}
      <Icon name={expanded ? "chevron-down" : "chevron-right"} size={18} className="shrink-0 text-mp-ink-3" />
    </button>
  );
}

/** A moment of a feed: one edge of one stretch ("ended" is a finished feed's ended_at alone). */
export type MomentEdge = { edge: "start" | "end" | "ended"; ref?: StretchRef };

type MomentEditorProps = {
  /**
   * The feed whose moment this is. Staged mode (FeedSheet): the feed as it
   * is before this moment's change (the saved entry, or the draft without
   * this edit), never the result of the edit itself.
   */
  entry: Entry;
  tz: string;
  /** A recorded moment: the title, bounds and preview come from the engine… */
  edge?: MomentEdge;
  /**
   * …or a new moment with its own bounds ("When did she go back on the
   * Right?", "When did the feed end?"). `notes` are the limit lines.
   */
  free?: { title: string; recorded: Date; min: Date; max: Date; notes?: { low?: string; high?: string } };
  /**
   * "commit" (Fix times): [Cancel] [Save · 4:20 PM]; Save waits for a change.
   * "staged" (FeedSheet): no buttons; every nudge or exact time calls onDraft
   * at once, and the sheet's own Save sends it.
   */
  mode: "commit" | "staged";
  /** Staged: the current draft (defaults to the recorded value). */
  draft?: Date;
  onDraft?: (to: Date) => void;
  onSave?: (to: Date) => void;
  onCancel?: () => void;
  /** Commit: saving (Save shows "Saving…", everything waits). */
  busy?: boolean;
  disabled?: boolean;
  /** Who changed the recorded value from another phone, for "{Who} just changed this to 4:22" (null: unnamed). */
  who?: string | null;
  /** The change was the viewer's own (the same login elsewhere): unnamed, and not "on another device". */
  mine?: boolean;
};

/**
 * The editor for one moment: its question ("When did she go back on the
 * Right?"), "Logged as 4:25 PM" (a recorded moment), a TimeScrubber spelled in words and
 * bounded by the engine (the neighbouring moments), a preview of what the
 * change does ("Break 15 → 10 min · Right 5 min longer · Left unchanged"),
 * and the limit it stops at. Keyed by the moment and its recorded value, so
 * if the other phone moves it the editor starts over from the new time (and
 * says so) instead of showing a label and a picker that disagree.
 */
export function MomentEditor(props: MomentEditorProps) {
  const { now } = useMaple();
  const info = useMemo(() => momentInfo(props.entry, props.edge, props.free, now()), [props.entry, props.edge, props.free, now]);
  const key = info ? `${info.keyBase}|${info.recorded.toISOString()}` : "none";
  const [first] = useState(key);
  const changed = key !== first;
  if (!info) return <p className="text-[13px] text-mp-ink-2">This part changed, so it can&apos;t be edited here.</p>;
  return <MomentEditorInner key={key} {...props} info={info} changed={changed} />;
}

type MomentInfo = {
  keyBase: string;
  title: string;
  recorded: Date;
  min: Date;
  max: Date;
  edge?: MomentEdge;
  notes?: { low?: string; high?: string };
};

function momentInfo(entry: Entry, edge: MomentEdge | undefined, free: MomentEditorProps["free"], now: Date): MomentInfo | null {
  if (free) return { keyBase: `free|${free.title}`, title: free.title, recorded: free.recorded, min: free.min, max: free.max, notes: free.notes };
  if (!edge || entry.kind !== "feed") return null;
  try {
    const ctx = feedCtx(entry, now);
    const b = edgeBounds(entry.data, edge, ctx);
    // The side a moment names: the stretch it starts (switch, resume) or ends (pause).
    const sides = feedParts(entry.data, ctx).filter((p): p is SidePart => p.kind === "side");
    const i = edge.ref ? sides.findIndex((s) => s.side === edge.ref!.side && Math.abs(Date.parse(s.start) - Date.parse(edge.ref!.start)) <= 1500) : edge.edge === "start" ? 0 : sides.length - 1;
    const side = edge.edge === "end" && b.moment === "switch" ? sides[i + 1]?.side : sides[i]?.side;
    // A start moved later eats into its own side: it keeps a minute, as an end moved earlier does (uiMin),
    // unless it's already shorter. A running side has no end to keep a minute before (the engine's own limit).
    const shrinks = edge.edge === "start" ? sides[i] : b.moment === "switch" ? sides[i + 1] : undefined;
    const ceiling = shrinks?.end ? Date.parse(shrinks.end) - 60_000 : null;
    const soft = ceiling !== null && ceiling >= b.recorded.getTime() && ceiling < b.max.getTime();
    // Where a minute stops it, the note says so ("Can't be after Left ended (6:24 AM)" read wrong at 6:23).
    const shortest = (p: SidePart | undefined) => (p ? `${SIDE_NAME[p.side]} can't be shorter than a minute.` : undefined);
    const notes = {
      low: b.uiMin.getTime() > b.min.getTime() + 1000 ? shortest(edge.edge === "start" ? sides[i - 1] : sides[i]) : undefined,
      high: soft ? shortest(shrinks) : undefined,
    };
    return {
      keyBase: `${edge.ref?.side ?? ""}|${edge.ref?.start ?? ""}|${edge.edge}|${b.moment}`,
      // "go back on the Right" only if she was on the Right before the break.
      title: momentQuestion(b.moment, side ?? "L", b.moment === "resume" && i > 0 ? sides[i - 1]?.side : undefined),
      recorded: b.recorded,
      min: b.uiMin,
      max: soft ? new Date(ceiling) : b.max,
      edge,
      notes,
    };
  } catch {
    return null;
  }
}

const sameMinute = (a: Date, b: Date) => Math.floor(a.getTime() / 60_000) === Math.floor(b.getTime() / 60_000);
/** The engine's "same moment" slack. */
const NEAR_MS = 1500;

function MomentEditorInner({
  entry,
  tz,
  mode,
  draft: controlled,
  onDraft,
  onSave,
  onCancel,
  busy,
  disabled,
  who,
  mine,
  info,
  changed,
}: MomentEditorProps & { info: MomentInfo; changed: boolean }) {
  const { state, now } = useMaple();
  const [local, setLocal] = useState(info.recorded);
  const [touched, setTouched] = useState(false);
  const draft = mode === "staged" ? controlled ?? info.recorded : local;
  const draftMs = draft.getTime();
  const set = (d: Date) => {
    setTouched(true);
    if (mode === "staged") onDraft?.(d);
    else setLocal(d);
  };

  // What the change does, worked out only when the draft moves (never on the clock tick).
  const preview = useMemo(() => {
    if (!info.edge || entry.kind !== "feed" || sameMinute(new Date(draftMs), info.recorded)) return null;
    try {
      const ctx = feedCtx(entry, now());
      const moved = moveEdge(entry.data, { ...info.edge, to: new Date(draftMs) }, ctx);
      const after = feedParts(moved.data as FeedData, { ...ctx, endedAt: moved.endedAt, pausedAtStop: moved.data.paused_at_stop === true });
      let text = describeChange(feedParts(entry.data, ctx), after);
      // A feed start moved back past the end of the feed before this one: allowed, but worth a word. Only for the
      // feed start, and with the engine's 1.5 s slack (a stored started_at can sit a moment off its first side).
      const to = Date.parse(moved.startedAt);
      const earlier = moved.moment === "feed_start" && to < Date.parse(entry.started_at) - NEAR_MS;
      const prev = earlier
        ? state?.entries.find((x) => x.kind === "feed" && x.id !== entry.id && !x.active && x.ended_at && Date.parse(x.started_at) < Date.parse(entry.started_at))
        : undefined;
      if (prev?.ended_at && to < Date.parse(prev.ended_at) - NEAR_MS) text += ` · overlaps the ${formatTimeNear(prev.started_at, prev.started_at, tz)} feed`;
      return text;
    } catch (err) {
      return err instanceof FeedEditError ? feedEditCopy(err, "ui", tz) : null;
    }
  }, [draftMs, entry, info, now, state?.entries, tz]);

  // The limit line, from the engine's own copy for one step past the limit.
  const limitNote = (side: "low" | "high"): string | null => {
    const own = info.notes?.[side];
    if (own) return own;
    if (!info.edge || entry.kind !== "feed") return null;
    const to = side === "low" ? info.min.getTime() - 60_000 : info.max.getTime() + 60_000;
    try {
      moveEdge(entry.data, { ...info.edge, to: new Date(to) }, feedCtx(entry, now()));
      return null;
    } catch (err) {
      if (!(err instanceof FeedEditError)) return null;
      // At the floor already (the low note only shows there): "For no break, pick 5:15" would ask for what's picked.
      if (side === "low" && err.code === "before_break" && err.params.t) return `Can't be before she came off (${formatTime(err.params.t, tz)}), so this is no break.`;
      return feedEditCopy(err, "ui", tz);
    }
  };
  const atLow = draftMs <= info.min.getTime() + 999;
  const atHigh = draftMs >= Math.min(info.max.getTime(), now().getTime() - 30_000) - 999;
  const note = touched ? (atLow ? limitNote("low") : atHigh ? limitNote("high") : null) : null;
  const locked = busy || disabled;

  return (
    <div className="space-y-3">
      <div>
        <p className="text-[17px] leading-snug font-semibold text-mp-ink">{info.title}</p>
        {/* What's logged for this moment ("Recorded now" read as "recorded this minute"); a new moment has nothing logged yet. */}
        {info.edge && <p className="mt-0.5 text-[13px] text-mp-ink-2">Logged as {formatTime(info.recorded, tz)}</p>}
        {changed && (
          <p role="status" className="mt-2 rounded-xl bg-mp-sunken px-3 py-2 text-[13px] text-mp-ink-2">
            {who
              ? `${who} just changed this to ${formatTime(info.recorded, tz)}`
              : `This just changed to ${formatTime(info.recorded, tz)}${mine ? "" : " on another device or through Claude"}`}
          </p>
        )}
      </div>
      <fieldset disabled={locked} className="min-w-0">
        <TimeScrubber value={draft} onChange={set} tz={tz} quick={false} nudgeStyle="words" min={info.min} max={info.max} label={info.title} hideLabel />
      </fieldset>
      {preview && (
        <p aria-live="polite" className="text-[13px] leading-snug text-mp-ink-2">
          {preview.split(" · ").map((bit, i) => (
            <span key={i}>
              {i > 0 && " · "}
              <span className={bit.endsWith("unchanged") ? undefined : "text-mp-accent-fg"}>{bit}</span>
            </span>
          ))}
        </p>
      )}
      {note && <p className="text-[13px] leading-snug text-mp-ink-2">{note}</p>}
      {mode === "commit" && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={locked}
            className="min-h-[48px] rounded-[14px] bg-mp-sunken px-5 text-[15px] font-semibold text-mp-ink disabled:opacity-45"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave?.(draft)}
            disabled={locked || sameMinute(draft, info.recorded)}
            className="inline-flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-[14px] bg-mp-accent px-5 text-[15px] font-semibold text-mp-on-accent disabled:opacity-45"
          >
            {busy ? (
              <>
                <Spinner />
                Saving…
              </>
            ) : (
              `Save · ${formatTime(draft, tz)}`
            )}
          </button>
        </div>
      )}
    </div>
  );
}

/** True on short screens (under 720px tall): the card tightens so it and the Since tiles clear the dock. */
export function useCompact(): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const check = () => setCompact(window.innerHeight < 720);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return compact;
}

/**
 * "Now", re-read just after each clock minute (server-corrected), for lists
 * that show a running feed's minutes: those count whole clock minutes
 * (feedMinutes), so they flip on the minute, all together, instead of up to
 * a minute late on a 30 or 60 s tick.
 */
export function useClockMinute(): Date {
  const { now } = useMaple();
  const [t, setT] = useState(() => now());
  useEffect(() => {
    let id: ReturnType<typeof setTimeout>;
    const arm = () => {
      // 50 ms past the minute, so the read lands in the new one.
      id = setTimeout(() => {
        setT(now());
        arm();
      }, 60_000 - (now().getTime() % 60_000) + 50);
    };
    arm();
    return () => clearTimeout(id);
  }, [now]);
  return t;
}
