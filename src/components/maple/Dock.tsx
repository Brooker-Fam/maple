"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tick } from "@/components/atlas/haptics";
import { STOOL_COLOR_INFO } from "@/lib/maple/guidelines";
import { formatClock, formatRelative, formatTime, DEFAULT_TZ } from "@/lib/maple/time";
import { formatVolume } from "@/lib/maple/units";
import type { DiaperData, Entry, Side, StoolColor } from "@/lib/maple/types";
import MoreSheet, { usePress } from "./MoreSheet";
import { useNightActive } from "./nightLook";
import { useSheets } from "./sheets";
import { SIDE_COLOR, SIDE_NAME, SWITCH_STYLE, timerNumbers, useTimerActions } from "./TimerCard";
import { cx } from "./ui";
import { useMaple, useNow, type ToastAction } from "./useMaple";

/**
 * The logging dock on Today: two rows of big buttons fixed just above the tab
 * bar, where a thumb lands at 3am. One tap does the common thing right away
 * (start the timer, log the diaper now); holding a button opens the full form
 * for one from earlier. The top row turns into timer controls while she nurses.
 */

const DUP_WINDOW_MS = 3 * 60_000;
/**
 * One cooldown for the whole dock: a tap can swap the tile under the thumb
 * (Sleep ↔ Woke up, Left → Switch to Right), so a double tap must not land on
 * the replacement and do the opposite thing.
 */
const TAP_COOLDOWN_MS = 800;
const DEFAULT_SWATCHES: StoolColor[] = ["black", "green", "yellow", "brown"];
const SHORT_COLOR: Record<StoolColor, string> = {
  black: "Black",
  green: "Green",
  yellow: "Yellow",
  mustard: "Mustard",
  brown: "Brown",
  orange: "Orange",
  pale_yellow: "Pale",
  gray: "Gray",
  white: "White",
  red: "Red",
};

const TILE = {
  L: SIDE_COLOR.L,
  R: SIDE_COLOR.R,
  bottle: "#C49A3C",
  more: "#5C7A4A",
  pee: "#7FA7B5",
  poop: "#8A5A2B",
  both: "#9C7E5A",
  sleep: "#8E7CB0",
};

// Daytime toasts get a little garnish now and then (never more than once every 3 logs, never at night).
const SUFFIXES = ["Zoe gives it two paws up.", "Bruce pretends not to have noticed.", "Another leaf on the tree.", "Noted in the forest ledger."];
let logsSinceSuffix = 0;
function garnish(night: boolean): string {
  logsSinceSuffix++;
  if (night || logsSinceSuffix < 3 || Math.random() < 0.5) return "";
  logsSinceSuffix = 0;
  return ` · ${SUFFIXES[Math.floor(Math.random() * SUFFIXES.length)]}`;
}

const diaperName = (pee: boolean, poop: boolean) => (pee && poop ? "wet + dirty diaper" : poop ? "dirty diaper" : "wet diaper");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function Dock() {
  const { state, summary, log, remove, update, now, isNight, readOnly, memberName, units } = useMaple();
  const { open } = useSheets();
  const actions = useTimerActions();
  const clock = useNow(1000);
  const [moreOpen, setMoreOpen] = useState(false);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const ref = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const lastTap = useRef(-Infinity);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;

  // Portal to <body>: the tab content animates with a transform when tabs
  // change, and a transformed ancestor would pull a fixed dock off the bottom.
  useEffect(() => setHost(document.body), []);

  // Publish the dock's height so toasts stack above it (see ToastHost).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const set = () => root.style.setProperty("--maple-dock-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--maple-dock-h");
    };
  }, [readOnly, host]);

  if (readOnly || !state || !summary || !host) return null;

  const entries = state.entries;
  const me = state.me.email;
  const feed = summary.active.find((e) => e.kind === "feed") ?? null;
  const sleep = summary.active.find((e) => e.kind === "sleep") ?? null;
  const feedN = feed ? timerNumbers(feed, clock) : null;
  // A timer the server hasn't confirmed yet has a temporary id: hold its controls until it has a real one.
  const feedPending = !!feed && feed.id < 0;
  const sleepPending = !!sleep && sleep.id < 0;
  const next = summary.nextSide;
  const lastBottle = entries.find((e) => e.kind === "feed" && e.data.method === "bottle" && e.data.amount_ml);
  const showHint = !summary.age || summary.age.dayOfLife <= 3;

  /** Show ✓ on the tile for 1.2s and ignore repeat taps meanwhile. Returns false if it's cooling down. */
  const flash = (id: string) => {
    if (done[id]) return false;
    setDone((d) => ({ ...d, [id]: true }));
    window.setTimeout(
      () =>
        setDone((d) => {
          const n = { ...d };
          delete n[id];
          return n;
        }),
      1200
    );
    return true;
  };

  /** Wrap a tap so taps within the dock-wide cooldown are ignored. */
  const tap = (fn: () => void) => () => {
    // A monotonic local clock: the server-synced now() can jump on each poll.
    const t = performance.now();
    if (t - lastTap.current < TAP_COOLDOWN_MS) return;
    lastTap.current = t;
    fn();
  };

  const earlierAt = () => new Date(now().getTime() - 15 * 60_000).toISOString();

  // Stool colors used most this week first, so the usual one is the first swatch.
  const swatches = (): StoolColor[] => {
    const weekAgo = now().getTime() - 7 * 86_400_000;
    const counts = new Map<StoolColor, number>();
    for (const e of entries) {
      if (e.kind !== "diaper" || !e.data.color || Date.parse(e.started_at) < weekAgo) continue;
      counts.set(e.data.color, (counts.get(e.data.color) ?? 0) + 1);
    }
    const used = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    return [...new Set([...used, ...DEFAULT_SWATCHES])].slice(0, 4);
  };

  const logDiaper = async (id: string, pee: boolean, poop: boolean) => {
    if (!flash(id)) return;
    tick();
    const t = now();
    const name = diaperName(pee, poop);
    // Both parents are often up at once: log it anyway, then ask if it's the same one.
    const dup = entries.find(
      (e) =>
        e.kind === "diaper" &&
        e.id > 0 &&
        e.created_by !== me &&
        Math.abs(Date.parse(e.started_at) - t.getTime()) <= DUP_WINDOW_MS &&
        !!(e.data as DiaperData).pee === pee &&
        !!(e.data as DiaperData).poop === poop
    );
    const text = dup
      ? `${memberName(dup.created_by)} logged a ${name} ${formatRelative(dup.started_at, t)}. Same one?`
      : `${cap(name)} · ${formatTime(t, tz)}${garnish(isNight())}`;
    await log(
      { kind: "diaper", data: { pee, poop } },
      {
        toast: text,
        emoji: pee && poop ? "💧💩" : poop ? "💩" : "💧",
        actions: (saved: Entry): ToastAction[] => {
          if (dup) {
            return [
              { label: "Remove mine", onClick: () => void remove(saved.id, { toast: "Removed yours" }) },
              { label: "Keep both", onClick: () => {} },
            ];
          }
          if (!poop) return [];
          return [
            ...swatches().map((c) => ({
              label: SHORT_COLOR[c],
              color: STOOL_COLOR_INFO[c].hex,
              ariaLabel: `Poop color: ${STOOL_COLOR_INFO[c].label}`,
              onClick: () => void update(saved.id, { data: { color: c } }, { toast: `${cap(name)} · ${SHORT_COLOR[c].toLowerCase()}` }),
            })),
            { label: "More…", ariaLabel: "More diaper details", onClick: () => open({ kind: "diaper", entry: saved }) },
          ];
        },
      }
    );
  };

  const tapSide = (side: Side) => {
    if (!flash(side)) return;
    void actions.startFeed(side);
  };

  const holdFeed = (side: Side) => open({ kind: "feed", preset: { method: "breast", first_side: side, started_at: earlierAt() } });

  const lastBottleLabel = lastBottle?.kind === "feed" && lastBottle.data.amount_ml ? `${formatVolume(lastBottle.data.amount_ml, units)} last` : "formula or milk";

  return createPortal(
    <>
      <div
        ref={ref}
        className="fixed inset-x-0 bottom-[calc(64px+env(safe-area-inset-bottom))] z-[65] mx-auto max-w-lg"
        role="region"
        aria-label="Log something"
      >
        <div className="rounded-t-[26px] border-t border-[#1D4420]/10 bg-[#FDF8F0]/95 px-3 pt-2.5 pb-2 shadow-[0_-8px_24px_rgba(29,68,32,0.08)] backdrop-blur-md dark:border-[#C49A3C]/15 dark:bg-[#0F2014]/95 dark:shadow-[0_-8px_24px_rgba(0,0,0,0.35)] [.maple-night_&]:border-[#E0A93B]/10 [.maple-night_&]:bg-[#0B0F0A]/95">
          {showHint && (
            <p className="mb-1.5 text-center text-[11px] font-medium text-[#5C6B57] dark:text-[#B9B39C] [.maple-night_&]:text-[#E0A93B]/55">
              Hold a button to log an earlier one.
            </p>
          )}
          <div className="grid grid-cols-4 gap-2">
            {/* Row 1: feeding, which becomes the nursing controls while a feed runs. */}
            {feed && feedN && !feedN.paused ? (
              <>
                <Tile
                  id="switch"
                  className="col-span-2"
                  label={`Switch to ${SIDE_NAME[feedN.side === "L" ? "R" : "L"]}`}
                  sub={`on ${SIDE_NAME[feedN.side ?? "L"]} · ${formatClock(feedN.side === "L" ? feedN.left : feedN.right)}`}
                  icon="⇄"
                  color={SWITCH_STYLE[feedN.side === "L" ? "R" : "L"].bg}
                  ink={SWITCH_STYLE[feedN.side === "L" ? "R" : "L"].fg}
                  strong
                  disabled={feedPending}
                  onTap={tap(() => void actions.switchSide(feed, feedN.side === "L" ? "R" : "L"))}
                />
                <Tile id="done" label="Done ✓" sub={feedPending ? "starting…" : formatClock(feedN.elapsed)} color="#1D4420" disabled={feedPending} onTap={tap(() => void actions.stop(feed))} />
              </>
            ) : feed && feedN ? (
              <>
                {(["L", "R"] as Side[]).map((s) => (
                  <Tile key={s} id={`resume-${s}`} label={SIDE_NAME[s]} sub="▶ resume" letter={s} color={SIDE_COLOR[s]} disabled={feedPending} onTap={tap(() => void actions.resume(feed, s))} />
                ))}
                <Tile id="done" label="Done ✓" sub={`paused ${formatClock(feedN.pausedSec)}`} color="#1D4420" disabled={feedPending} onTap={tap(() => void actions.stop(feed))} />
              </>
            ) : (
              <>
                {(["L", "R"] as Side[]).map((s) => (
                  <Tile
                    key={s}
                    id={s}
                    label={SIDE_NAME[s]}
                    sub="nurse"
                    letter={s}
                    color={SIDE_COLOR[s]}
                    next={next === s}
                    done={done[s]}
                    onTap={tap(() => tapSide(s))}
                    onHold={() => holdFeed(s)}
                  />
                ))}
                <Tile
                  id="bottle"
                  label="Bottle"
                  sub={lastBottleLabel}
                  color={TILE.bottle}
                  onTap={tap(() => open({ kind: "feed", preset: { method: "bottle" } }))}
                  onHold={() => open({ kind: "feed", preset: { method: "bottle", started_at: earlierAt() } })}
                />
              </>
            )}
            <Tile id="more" label="More" sub="＋ log" color={TILE.more} onTap={tap(() => setMoreOpen(true))} />

            {/* Row 2: diapers and sleep. */}
            <Tile
              id="pee"
              label="Pee"
              sub="wet 💧"
              color={TILE.pee}
              done={done.pee}
              onTap={tap(() => void logDiaper("pee", true, false))}
              onHold={() => open({ kind: "diaper", preset: { pee: true, poop: false, started_at: earlierAt() } })}
            />
            <Tile
              id="poop"
              label="Poop"
              sub="dirty"
              color={TILE.poop}
              done={done.poop}
              onTap={tap(() => void logDiaper("poop", false, true))}
              onHold={() => open({ kind: "diaper", preset: { pee: false, poop: true, started_at: earlierAt() } })}
            />
            <Tile
              id="both"
              label="Both"
              sub="pee + poop"
              color={TILE.both}
              done={done.both}
              onTap={tap(() => void logDiaper("both", true, true))}
              onHold={() => open({ kind: "diaper", preset: { pee: true, poop: true, started_at: earlierAt() } })}
            />
            {sleep ? (
              <Tile
                id="wake"
                label="Woke up"
                sub={sleepPending ? "starting…" : `☀️ ${formatClock(timerNumbers(sleep, clock).elapsed)}`}
                color="#6E5C94"
                strong
                disabled={sleepPending}
                onTap={tap(() => void actions.stop(sleep))}
              />
            ) : (
              <Tile
                id="sleep"
                label="Sleep"
                sub="🌙"
                color={TILE.sleep}
                done={done.sleep}
                onTap={tap(() => flash("sleep") && void actions.startTimer("sleep"))}
                onHold={() => open({ kind: "sleep", preset: { started_at: earlierAt() } })}
              />
            )}
          </div>
        </div>
      </div>
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
    </>,
    host
  );
}

function Tile({
  id,
  label,
  sub,
  color,
  onTap,
  onHold,
  next,
  done,
  letter,
  icon,
  strong,
  ink,
  disabled,
  className,
}: {
  id: string;
  label: string;
  sub: string;
  color: string;
  onTap: () => void;
  onHold?: () => void;
  next?: boolean;
  done?: boolean;
  letter?: Side;
  icon?: string;
  /** Filled (the action you most likely want right now). */
  strong?: boolean;
  /** Text color on a filled tile (default white). */
  ink?: string;
  /** Not tappable yet (a timer still starting). */
  disabled?: boolean;
  className?: string;
}) {
  const press = usePress(onTap, onHold);
  // At night a filled tile glows softly instead of blazing.
  const night = useNightActive();
  const fill = strong ? (night ? `${color}55` : color) : `${color}${next ? "2E" : "1F"}`;
  return (
    <button
      type="button"
      data-tile={id}
      disabled={disabled}
      aria-label={`${label}${next ? " (next side)" : ""}${onHold ? ". Hold to log an earlier one" : ""}`}
      {...press}
      className={cx(
        "relative flex min-h-[60px] flex-col items-center justify-center rounded-2xl px-1 py-1.5 text-center transition select-none active:scale-[0.96] disabled:opacity-50 disabled:active:scale-100",
        strong ? "text-white" : "text-[#1D4420] dark:text-[#F5EDDF] [.maple-night_&]:text-[#E0A93B]/85",
        next && "ring-2 ring-[#C49A3C] ring-offset-2 ring-offset-[#FDF8F0] dark:ring-offset-[#0F2014] [.maple-night_&]:ring-[#E0A93B]/70 [.maple-night_&]:ring-offset-[#0B0F0A]",
        className
      )}
      style={{
        backgroundColor: fill,
        color: strong ? (night ? "#E8A23F" : ink) : undefined,
        boxShadow: strong ? "0 2px 10px rgba(0,0,0,0.15)" : next ? `inset 0 0 0 1.5px ${color}99, 0 0 18px ${color}55` : `inset 0 0 0 1.5px ${color}55`,
        WebkitTouchCallout: "none",
      }}
    >
      {next && (
        <span className="absolute -top-2 right-1 rounded-full bg-[#C49A3C] px-1.5 py-px text-[10px] font-bold text-[#1D2A12] shadow-sm [.maple-night_&]:bg-[#D9772B]/45 [.maple-night_&]:text-[#F0C27A]">
          🍁 next
        </span>
      )}
      <AnimatePresence mode="wait" initial={false}>
        {done ? (
          <motion.span key="done" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ opacity: 0 }} className="text-2xl leading-none font-bold" aria-hidden>
            ✓
          </motion.span>
        ) : (
          <motion.span key="label" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center">
            <span className="flex items-center gap-1 text-[15px] leading-tight font-semibold">
              {letter && (
                <span
                  aria-hidden
                  className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full text-[10px] font-bold text-white"
                  style={{ backgroundColor: color }}
                >
                  {letter}
                </span>
              )}
              {icon && <span aria-hidden>{icon}</span>}
              {label}
            </span>
            <span className={cx("mt-0.5 text-[11px] leading-tight tabular-nums", strong ? "opacity-90" : "opacity-70")}>{sub}</span>
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}
