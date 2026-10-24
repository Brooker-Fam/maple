"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tick } from "@/components/atlas/haptics";
import { STOOL_COLOR_INFO } from "@/lib/maple/guidelines";
import { other, staleFeed } from "@/lib/maple/feed";
import { formatRelative, formatTime, formatTimeNear, DEFAULT_TZ } from "@/lib/maple/time";
import { formatVolume } from "@/lib/maple/units";
import type { DiaperData, Entry, FeedData, Side, StoolColor } from "@/lib/maple/types";
import { fixPreset, useStillGoing } from "./FeedParts";
import { Icon, type IconName } from "./icons";
import MoreSheet, { usePress } from "./MoreSheet";
import { useNightActive } from "./nightLook";
import { DETAIL_COLOR } from "./palette";
import { useSheets } from "./sheets";
import { SIDE_COLOR, SIDE_NAME, SWITCH_STYLE, timerNumbers, useTimerActions } from "./TimerCard";
import { cx } from "./ui";
import { useHoldTimerToasts, useMaple, useNow, type ToastAction } from "./useMaple";

/**
 * The logging dock on Today: two rows of big buttons fixed just above the tab
 * bar, where a thumb lands at 3am. One tap does the common thing right away
 * (start the timer, log the diaper now); holding a button opens the full form
 * for one from earlier. The top row turns into the feed's controls while she
 * nurses, and they are the only ones on screen: Switch and Pause while she's
 * on (columns 1 and 2); during a break, the other side where Switch was
 * (filled like it, "Next side") and the side she came off where Pause was
 * ("Resume"), so Pause and Resume toggle in one spot; Done in column 3, More
 * in 4. Once the side she's on has run past the card's "Still nursing?"
 * check, Done asks when she finished ("when?") instead of ending the feed now.
 */

const DUP_WINDOW_MS = 3 * 60_000;
/**
 * One cooldown for the whole dock: a tap can swap the tile under the thumb
 * (Sleep ↔ Woke up, Left → Switch to Right), so a double tap must not land on
 * the replacement and do the opposite thing.
 */
const TAP_COOLDOWN_MS = 800;
/**
 * After a tap on columns 1 or 2 (start, switch, pause, resume), both wait
 * 1.2 s; column 1 waits 2.5 s after its own tap. That one changes the side
 * (Left → "Switch to Right", "Next side" → "Switch to Left"), so a late
 * second tap there would put her straight back; column 2 stays quick so a
 * late second Pause still lands on Resume and merges.
 */
const SWAP_COOL_MS = 1200;
const SIDE_COOL_MS = 2500;

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
  bottle: DETAIL_COLOR.bottle,
  pee: DETAIL_COLOR.pee,
  poop: DETAIL_COLOR.poop,
  sleep: DETAIL_COLOR.sleep,
  wake: "#6E5C94",
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

/**
 * Flags that clear themselves: cool(key, ms) sets `key` for at least `ms`
 * (a longer cooldown already running on it is kept, never cut short).
 */
function useCooldowns(): [Record<string, boolean>, (key: string, ms: number) => void] {
  const [on, setOn] = useState<Record<string, boolean>>({});
  const timers = useRef(new Map<string, { until: number; timer: number }>());
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach((c) => window.clearTimeout(c.timer));
  }, []);
  const cool = useCallback((key: string, ms: number) => {
    // A monotonic clock: the server-synced now() can jump on each poll.
    const until = performance.now() + ms;
    const c = timers.current.get(key);
    if (c && c.until >= until) return;
    if (c) window.clearTimeout(c.timer);
    const timer = window.setTimeout(() => {
      timers.current.delete(key);
      setOn((d) => {
        const n = { ...d };
        delete n[key];
        return n;
      });
    }, ms);
    timers.current.set(key, { until, timer });
    setOn((d) => (d[key] ? d : { ...d, [key]: true }));
  }, []);
  return [on, cool];
}

export default function Dock() {
  const { state, summary, log, remove, update, now, isNight, readOnly, memberLabel, units } = useMaple();
  const { open } = useSheets();
  const actions = useTimerActions();
  const clock = useNow(1000);
  const night = useNightActive();
  const [moreOpen, setMoreOpen] = useState(false);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const ref = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const lastTap = useRef(-Infinity);
  const [cooling, cool] = useCooldowns();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const feed = summary?.active.find((e) => e.kind === "feed") ?? null;
  const feedN = feed ? timerNumbers(feed, clock) : null;
  // The card's "Still nursing?" (the side she's on has run long, not snoozed): Done asks when she finished.
  const still = useStillGoing(feed, feedN, clock);
  const askWhen = still.forgotten && still.check === "side";

  // More is a sheet too: a timer toast answering a tap still out waits under it, like under the other sheets (SheetProvider).
  useHoldTimerToasts(moreOpen);

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
  const sleep = summary.active.find((e) => e.kind === "sleep") ?? null;
  // A timed nursing feed: the dock runs it (an untimed one only has Done).
  const nursing = !!feedN && feedN.parts.length > 0;
  // A timer the server hasn't confirmed yet has a temporary id: hold its controls until it has a real one.
  const feedPending = !!feed && feed.id < 0;
  const sleepPending = !!sleep && sleep.id < 0;
  const next = summary.nextSide;
  const lastBottle = entries.find((e) => e.kind === "feed" && e.data.method === "bottle" && e.data.amount_ml);
  const showHint = (!summary.age || summary.age.dayOfLife <= 3) && !summary.active.length;

  /** Show a check on the tile for 1.2s and ignore repeat taps meanwhile. Returns false if it's cooling down. */
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

  /** Wrap a tap so taps within the dock-wide cooldown are ignored. Any tap closes the timer toast. */
  const tap = (fn: () => void) => () => {
    // A monotonic local clock: the server-synced now() can jump on each poll.
    const t = performance.now();
    if (t - lastTap.current < TAP_COOLDOWN_MS) return;
    lastTap.current = t;
    actions.dismissToast();
    fn();
  };

  /**
   * A hold opens a form for an earlier one. It closes the timer toast as a
   * tap does, so the toast's chips ("5 min earlier") never sit over the form's
   * own times; the sheet holds any newer one until it closes.
   */
  const hold = (fn: () => void) => () => {
    actions.dismissToast();
    fn();
  };

  /**
   * A tap that changes what columns 1 and 2 mean (start, switch, pause,
   * resume): both ignore taps for a moment (SWAP_COOL_MS, SIDE_COOL_MS), so
   * a double tap can't land on the tile that just appeared under the thumb.
   * Only the tapped one shows the check (then its new label, dimmed, while
   * it still waits); the other shows its new label, dimmed, so it never
   * looks as if two buttons were pressed.
   */
  const swap = (col: "col1" | "col2", fn: () => void) => {
    if (cooling[col]) return;
    cool("col1", col === "col1" ? SIDE_COOL_MS : SWAP_COOL_MS);
    cool("col2", SWAP_COOL_MS);
    cool(`check-${col}`, SWAP_COOL_MS);
    fn();
  };

  /** This phone just started a timer: bring "Right now" to the top (no glide at night or with reduced motion). */
  const toTop = () => {
    const still = night || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: still ? "auto" : "smooth" });
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
      ? // Never "Admin": the shared login reads as the member it acts for, or as the other phone.
        `${memberLabel(dup.created_by) ?? "The other phone"} logged a ${name} ${formatRelative(dup.started_at, t)}. Same one?`
      : `${cap(name)} · ${formatTime(t, tz)}${garnish(isNight())}`;
    await log(
      { kind: "diaper", data: { pee, poop } },
      {
        toast: text,
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

  const tapSide = (side: Side) =>
    swap(side === "L" ? "col1" : "col2", () => {
      toTop();
      void actions.startFeed(side);
    });

  const holdFeed = (side: Side) => open({ kind: "feed", preset: { method: "breast", first_side: side, started_at: earlierAt() } });

  const lastBottleLabel = lastBottle?.kind === "feed" && lastBottle.data.amount_ml ? `${formatVolume(lastBottle.data.amount_ml, units)} last` : undefined;

  return createPortal(
    <>
      <div
        ref={ref}
        className="fixed inset-x-0 bottom-[calc(57px+env(safe-area-inset-bottom))] z-[65] mx-auto max-w-lg"
        role="region"
        aria-label="Log something"
      >
        <div className="rounded-t-[22px] border-t border-mp-line bg-mp-bg/95 px-3 pt-2.5 pb-2.5 shadow-[0_-6px_20px_rgba(0,0,0,0.05)] backdrop-blur-xl">
          {showHint && <p className="mb-2 text-center text-[11px] text-mp-ink-3">Hold a button to log an earlier one.</p>}
          <div className="grid grid-cols-4 gap-2">
            {/* Row 1: feeding, which becomes the nursing controls while a feed runs. No tile shows a feed clock (the card has it). */}
            {feed && feedN && nursing && !feedN.paused ? (
              <>
                <Tile
                  id="switch"
                  label="Switch"
                  sub={`to ${SIDE_NAME[other(feedN.side ?? "L")]}`}
                  aria={`Switch to ${SIDE_NAME[other(feedN.side ?? "L")]}`}
                  letter={other(feedN.side ?? "L")}
                  color={SWITCH_STYLE[other(feedN.side ?? "L")].bg}
                  ink={SWITCH_STYLE[other(feedN.side ?? "L")].fg}
                  strong
                  done={cooling["check-col1"]}
                  disabled={feedPending || cooling.col1}
                  onTap={tap(() => swap("col1", () => void actions.switchSide(feed, other(feedN.side ?? "L"))))}
                />
                <Tile
                  id="pause"
                  label="Pause"
                  icon="pause"
                  aria="Pause the feed"
                  done={cooling["check-col2"]}
                  disabled={feedPending || cooling.col2}
                  onTap={tap(() => swap("col2", () => void actions.pause(feed)))}
                />
                {/* Past "Still nursing?" a tap here would record a feed that ran on unwatched: it asks when she finished (Fix times, "Ended at…"). */}
                <Tile
                  id="done"
                  label="Done"
                  icon="check"
                  aria={askWhen ? "Done: choose when the feed ended" : "Done: end the feed now"}
                  sub={feedPending ? "starting…" : askWhen ? "when?" : undefined}
                  accent
                  disabled={feedPending}
                  onTap={tap(() => (askWhen ? open({ kind: "feed", entry: feed, preset: fixPreset("current", "finished") }) : void actions.stop(feed)))}
                />
              </>
            ) : feed && feedN && nursing ? (
              <>
                {/*
                  Paused: each column keeps its job from while she nursed. Column 1 (where Switch was)
                  is the other side, filled like Switch and marked "Next side"; column 2 (where Pause
                  was) is the side she came off, "Resume". So Pause and Resume toggle in one spot, and
                  a late second tap on Pause goes back on the same side and merges (no break) instead
                  of starting the other side. The sides move with the feed, so their letters are big.
                  Both turn off after a tap (column 1 for 2.5 s after its own), so a double tap can't land on the new tile.
                */}
                {[other(feedN.side ?? "L"), feedN.side ?? "L"].map((s, i) => {
                  const col = i === 0 ? "col1" : "col2";
                  const suggested = i === 0;
                  // On a break for over an hour (the Siri/Claude rule): a tap starts a new feed, ending this one at its pause.
                  const fresh = staleFeed(feed as Entry & { data: FeedData }, clock);
                  return (
                    <Tile
                      key={col}
                      id={`resume-${s}`}
                      label={SIDE_NAME[s]}
                      sub={fresh ? "New feed" : suggested ? "Next side" : "Resume"}
                      aria={fresh ? `Start a new feed on ${SIDE_NAME[s]} (this one ends at its pause)` : `Resume on ${SIDE_NAME[s]}${suggested ? " (next side)" : ""}`}
                      letter={s}
                      bigLetter
                      color={suggested ? SWITCH_STYLE[s].bg : SIDE_COLOR[s]}
                      ink={suggested ? SWITCH_STYLE[s].fg : undefined}
                      strong={suggested}
                      done={cooling[`check-${col}`]}
                      disabled={feedPending || cooling[col]}
                      onTap={tap(() => swap(col, () => void (fresh ? actions.freshFeed(feed, s) : actions.resume(feed, s))))}
                    />
                  );
                })}
                {/* Quiet while paused: it ends the feed at the pause ("ends 4:10"), the riskier choice here. */}
                <Tile
                  id="done"
                  label="Done"
                  icon="check"
                  inline
                  sub={feedPending ? "starting…" : `ends ${formatTimeNear(feedN.current.since, feedN.current.since, tz)}`}
                  aria={`Done: end the feed at ${formatTime(feedN.current.since, tz)}, when you paused`}
                  disabled={feedPending}
                  onTap={tap(() => void actions.stop(feed))}
                />
              </>
            ) : feed ? (
              <>
                {/* An untimed feed (logged by voice without sides): just its Done. */}
                <Tile id="bottle" label="Bottle" sub={lastBottleLabel} icon="bottle" color={TILE.bottle} onTap={tap(() => open({ kind: "feed", preset: { method: "bottle" } }))} />
                <div aria-hidden />
                <Tile id="done" label="Done" icon="check" aria="Done: end the feed now" accent disabled={feedPending} onTap={tap(() => void actions.stop(feed))} />
              </>
            ) : (
              <>
                {(["L", "R"] as Side[]).map((s) => (
                  <Tile
                    key={s}
                    id={s}
                    label={SIDE_NAME[s]}
                    sub={next === s ? "Next side" : "Nurse"}
                    letter={s}
                    color={SIDE_COLOR[s]}
                    next={next === s}
                    done={cooling[s === "L" ? "check-col1" : "check-col2"]}
                    disabled={s === "L" ? cooling.col1 : cooling.col2}
                    onTap={tap(() => tapSide(s))}
                    onHold={hold(() => holdFeed(s))}
                  />
                ))}
                <Tile
                  id="bottle"
                  label="Bottle"
                  sub={lastBottleLabel}
                  icon="bottle"
                  color={TILE.bottle}
                  onTap={tap(() => open({ kind: "feed", preset: { method: "bottle" } }))}
                  onHold={hold(() => open({ kind: "feed", preset: { method: "bottle", started_at: earlierAt() } }))}
                />
              </>
            )}
            <Tile id="more" label="More" icon="plus" onTap={tap(() => setMoreOpen(true))} />

            {/* Row 2: diapers and sleep. */}
            <Tile
              id="pee"
              label="Pee"
              dots={[TILE.pee]}
              done={done.pee}
              onTap={tap(() => void logDiaper("pee", true, false))}
              onHold={hold(() => open({ kind: "diaper", preset: { pee: true, poop: false, started_at: earlierAt() } }))}
            />
            <Tile
              id="poop"
              label="Poop"
              dots={[TILE.poop]}
              done={done.poop}
              onTap={tap(() => void logDiaper("poop", false, true))}
              onHold={hold(() => open({ kind: "diaper", preset: { pee: false, poop: true, started_at: earlierAt() } }))}
            />
            <Tile
              id="both"
              label="Both"
              dots={[TILE.pee, TILE.poop]}
              done={done.both}
              onTap={tap(() => void logDiaper("both", true, true))}
              onHold={hold(() => open({ kind: "diaper", preset: { pee: true, poop: true, started_at: earlierAt() } }))}
            />
            {sleep ? (
              <Tile
                id="wake"
                label="Woke up"
                icon="sun"
                sub={sleepPending ? "starting…" : undefined}
                color={TILE.wake}
                strong
                disabled={sleepPending}
                onTap={tap(() => void actions.stop(sleep))}
              />
            ) : (
              <Tile
                id="sleep"
                label="Sleep"
                icon="moon"
                color={TILE.sleep}
                done={done.sleep}
                onTap={tap(() => {
                  if (!flash("sleep")) return;
                  toTop();
                  void actions.startTimer("sleep");
                })}
                onHold={hold(() => open({ kind: "sleep", preset: { started_at: earlierAt() } }))}
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

/**
 * One dock button: a quiet surface with one colored mark (a side letter, an
 * icon or diaper dots) so the eye finds it, a label, and an optional live
 * subline. `strong` fills it with its color (the action you most likely
 * want now); `accent` fills it with the app's primary color (Done).
 */
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
  dots,
  strong,
  accent,
  ink,
  disabled,
  aria,
  inline: inlineProp,
  bigLetter,
}: {
  id: string;
  label: string;
  sub?: string;
  /** The tile's mark color (and its fill when strong). */
  color?: string;
  onTap: () => void;
  onHold?: () => void;
  next?: boolean;
  done?: boolean;
  letter?: Side;
  icon?: IconName;
  /** Diaper dots (pee, poop, or both), matching the day dial. */
  dots?: string[];
  /** Filled with its color (the action you most likely want right now). */
  strong?: boolean;
  /** Filled with the primary color. */
  accent?: boolean;
  /** Text color on a strong tile (default white). */
  ink?: string;
  /** Not tappable yet (a timer still starting, or a tile that just changed meaning). */
  disabled?: boolean;
  /** The accessible name, when the label alone doesn't say it ("Switch to Right", "Pause the feed"). */
  aria?: string;
  /** Icon and label on one line even when quiet (the paused Done, so its "ends 4:10" fits the same height). */
  inline?: boolean;
  /** A bigger side letter that never hides (the paused sides, whose columns follow the feed rather than Left/Right). */
  bigLetter?: boolean;
}) {
  const press = usePress(onTap, onHold);
  // At night a filled tile glows softly instead of blazing, in the amber like
  // every other kind color (a violet "Woke up" or a rust "Switch to Left" would
  // be the only cool or red patch on the 3am screen).
  const night = useNightActive();
  const filled = strong || accent;
  // Icon and label share a line when there's room (a side letter, Done); "Woke up" and Pause stack.
  const inline = !!letter || accent || !!inlineProp;
  const fill = strong && color ? (night ? "rgb(224 169 59 / 0.25)" : color) : undefined;
  return (
    <button
      type="button"
      data-tile={id}
      disabled={disabled}
      aria-label={`${aria ?? label}${next ? " (next side)" : ""}${onHold ? ". Hold to log an earlier one" : ""}`}
      {...press}
      className={cx(
        "relative flex min-h-[64px] flex-col items-center justify-center rounded-2xl border px-1 py-1.5 text-center transition select-none active:scale-[0.96] disabled:opacity-50 disabled:active:scale-100",
        accent
          ? "border-transparent bg-mp-accent text-mp-on-accent"
          : strong
            ? "border-transparent"
            : next
              ? "border-mp-accent-fg/70 bg-mp-surface text-mp-ink"
              : "border-mp-line bg-mp-surface text-mp-ink"
      )}
      style={{
        backgroundColor: fill,
        color: strong ? (night ? "#E8A23F" : ink ?? "#FFFFFF") : undefined,
        boxShadow: next ? "inset 0 0 0 1px var(--mp-accent-fg)" : undefined,
        WebkitTouchCallout: "none",
      }}
    >
      <AnimatePresence mode="wait" initial={false}>
        {done ? (
          <motion.span key="done" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ opacity: 0 }} aria-hidden>
            <Icon name="check" size={26} strokeWidth={2.4} />
          </motion.span>
        ) : (
          <motion.span key="label" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center gap-1">
            <span className="flex items-center gap-1.5">
              {letter && (
                <span
                  aria-hidden
                  // Under 360px "Switch" needs the room; its "to Left" already names the side.
                  // mp-side-mark: the side letters' own night look, shared with the card's SideMark.
                  className={cx(
                    "mp-kind-fill mp-side-mark inline-flex shrink-0 items-center justify-center rounded-full font-bold",
                    bigLetter ? "h-6 w-6 text-[13px] max-[359px]:h-5 max-[359px]:w-5 max-[359px]:text-[11px]" : "h-5 w-5 text-[11px]",
                    strong && !bigLetter && "max-[359px]:hidden"
                  )}
                  // On a tile filled with the side's color, the mark turns over (ink disc, colored letter) so it still shows.
                  style={strong ? { backgroundColor: ink ?? "#FFFFFF", color } : { backgroundColor: color, color: SWITCH_STYLE[letter].fg }}
                >
                  {letter}
                </span>
              )}
              {icon && <Icon name={icon} size={20} className={cx(!filled && color && "mp-kind-ink")} style={!filled && color ? { color } : undefined} />}
              {dots?.map((c) => (
                <span key={c} aria-hidden className="mp-kind-fill h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c }} />
              ))}
              {inline && <span className="text-[15px] leading-tight font-semibold">{label}</span>}
            </span>
            {!inline && <span className={cx("leading-tight font-semibold", filled ? "text-[15px]" : "text-[14px]")}>{label}</span>}
            {sub && (
              // 11px needs ink-2 (ink-3 is 3:1 at night); on a filled tile it's full strength at night (85% was 4.46:1).
              <span
                className={cx(
                  "text-[11px] leading-tight tabular-nums",
                  filled ? "opacity-85 [.maple-night_&]:opacity-100" : next ? "font-semibold text-mp-accent-fg" : "text-mp-ink-2"
                )}
              >
                {sub}
              </span>
            )}
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}
