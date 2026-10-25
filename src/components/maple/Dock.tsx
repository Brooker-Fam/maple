"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tick } from "@/components/atlas/haptics";
import { STOOL_COLOR_INFO } from "@/lib/maple/guidelines";
import { isTracked, other, staleFeed } from "@/lib/maple/feed";
import { formatRelative, formatTime, formatTimeNear, DEFAULT_TZ } from "@/lib/maple/time";
import { formatVolume } from "@/lib/maple/units";
import type { DiaperData, Entry, FeedData, Side, StoolColor, StretchSide } from "@/lib/maple/types";
import { CareStrip } from "./care/CareLine";
import { fixPreset, useStillGoing } from "./FeedParts";
import { Icon, type IconName } from "./icons";
import MoreSheet, { logSwitches, usePress } from "./MoreSheet";
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
 *
 * Going back and forth (both sides, not tracked), Switch's place is a quiet
 * "Back & forth" tile: a tap only asks "Which side is she on now?" (a toast,
 * nothing saved until it's answered), so a habit tap there is harmless; Pause
 * and Done stay put. On a break after it, column 1 is "Track sides" (the same
 * question) and column 2, where Pause was, is "Back on", filled, so a late
 * second Pause tap still rejoins with no break.
 *
 * With Bottles off (Family → On Today; logSwitches), row 1 is Left, Right
 * and More: Left and Right take the Bottle tile's room between them (an
 * eight-column grid, each tile two columns, the sides three), still Left then
 * Right. A start from a wide side also holds Done (column 3, under the
 * Right's right half) for the side tiles' cooldown.
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
  const { state, summary, log, remove, update, now, readOnly, memberLabel, units, toast } = useMaple();
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
  // Family → On Today: no Bottle tile, so Left and Right share its room.
  const { bottles } = logSwitches(state.baby);
  // The part she's on (or came off) goes back and forth; the side the paused tiles count from is the last one tracked.
  const both = !!feedN?.both;
  const sideNow: Side = feedN ? (isTracked(feedN.side) ? feedN.side : feedN.tracked ?? "L") : "L";

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
  const swap = (col: "col1" | "col2", fn: () => void, opts: { long?: boolean; wide?: boolean } = {}) => {
    if (cooling[col]) return;
    // Column 1's own taps, and any start (the tapped tile turns into Pause or Switch), wait the longer while.
    cool(col, col === "col1" || opts.long ? SIDE_COOL_MS : SWAP_COOL_MS);
    // A wide side (Bottles off) also covered part of the next column: that one waits as long, and Done (column 3) too.
    cool(col === "col1" ? "col2" : "col1", opts.wide ? SIDE_COOL_MS : SWAP_COOL_MS);
    if (opts.wide) cool("col3", SIDE_COOL_MS);
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

  /** A diaper's icon in its own toasts: the drop, the pile, or both as the dock shows them. */
  const diaperIcon = (poop: boolean): IconName => (poop ? "poop" : "droplet");

  /** Move a diaper just logged to an earlier time (Undo puts it back). Its toast keeps Edit for anything else. */
  const moveDiaper = async (saved: Entry, to: number, name: string, pee: boolean, poop: boolean) => {
    const from = saved.started_at;
    const moved = await update(saved.id, { started_at: new Date(to).toISOString() }, { toast: "" });
    if (!moved) return;
    toast(`${cap(name)} · ${formatTime(to, tz)}`, {
      icon: diaperIcon(poop),
      undo: () => void update(saved.id, { started_at: from }, { toast: `${cap(name)} · back to ${formatTime(from, tz)}` }),
      actions: [{ label: "Edit", ariaLabel: `Edit this ${name}`, onClick: () => open({ kind: "diaper", entry: moved }) }],
    });
  };

  /**
   * After a quick diaper: "15 min ago", "1 hr ago", "2 hr ago" (each with the
   * time it sets), for one changed a while back, and Edit for the rest.
   */
  const diaperFixes = (saved: Entry, name: string, pee: boolean, poop: boolean): ToastAction[] => {
    const base = Date.parse(saved.started_at);
    return [
      ...[15, 60, 120].map((m) => {
        const to = base - m * 60_000;
        const ago = m < 60 ? `${m} min ago` : `${m / 60} hr ago`;
        return {
          label: ago,
          sub: formatTimeNear(to, base, tz),
          ariaLabel: `${cap(name)} ${m < 60 ? `${m} minutes` : m === 60 ? "an hour" : `${m / 60} hours`} ago, at ${formatTime(to, tz)}`,
          onClick: () => void moveDiaper(saved, to, name, pee, poop),
        };
      }),
      { label: "Edit", ariaLabel: `Edit this ${name}`, onClick: () => open({ kind: "diaper", entry: saved }) },
    ];
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
      : `${cap(name)} · ${formatTime(t, tz)}`;
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
          if (!poop) return diaperFixes(saved, name, pee, poop);
          // A poop asks its color first; once it's picked, the next toast offers the earlier times.
          return [
            ...swatches().map((c) => ({
              label: SHORT_COLOR[c],
              color: STOOL_COLOR_INFO[c].hex,
              ariaLabel: `Poop color: ${STOOL_COLOR_INFO[c].label}`,
              onClick: () =>
                void update(saved.id, { data: { color: c } }, { toast: "" }).then((colored) => {
                  if (colored) toast(`${cap(name)} · ${SHORT_COLOR[c].toLowerCase()}`, { icon: diaperIcon(poop), actions: diaperFixes(colored, name, pee, poop) });
                }),
            })),
            { label: "Edit", ariaLabel: `Edit this ${name}`, onClick: () => open({ kind: "diaper", entry: saved }) },
          ];
        },
      }
    );
  };

  const tapSide = (side: Side) =>
    swap(
      side === "L" ? "col1" : "col2",
      () => {
        toTop();
        void actions.startFeed(side);
      },
      { long: true, wide: !bottles }
    );

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
        {/* Opaque at night: through the blur, the page's amber text ghosted under the tiles. */}
        <div className="rounded-t-[22px] border-t border-mp-line bg-mp-bg/95 px-3 pt-2.5 pb-2.5 shadow-[0_-6px_20px_rgba(0,0,0,0.05)] backdrop-blur-xl [.maple-night_&]:bg-mp-bg [.maple-night_&]:backdrop-blur-none">
          {/* Her strip (her next medicine, 44px) rides on top; Maple's eight tiles stay exactly where they were. */}
          <CareStrip />
          {showHint && <p className="mb-2 text-center text-[11px] text-mp-ink-3">Hold a button to log an earlier one.</p>}
          {/* Eight columns, each tile two of them (four abreast), so Left and Right can take three each when Bottles is off. */}
          <div className="grid grid-cols-8 gap-2">
            {/* Row 1: feeding, which becomes the nursing controls while a feed runs. No tile shows a feed clock (the card has it). */}
            {feed && feedN && nursing && !feedN.paused ? (
              <>
                {both ? (
                  // Going back and forth: Switch's place only asks which side she's on (nothing saved until it's answered).
                  <Tile
                    id="back-and-forth"
                    label="Back & forth"
                    sub="Track sides"
                    aria="Going back and forth. Track sides again: which side is she on now?"
                    letter="B"
                    stack
                    disabled={feedPending || cooling.col1}
                    onTap={tap(() => actions.askSide(feed))}
                  />
                ) : (
                  <Tile
                    id="switch"
                    label="Switch"
                    sub={`to ${SIDE_NAME[other(sideNow)]}`}
                    aria={`Switch to ${SIDE_NAME[other(sideNow)]}`}
                    letter={other(sideNow)}
                    color={SWITCH_STYLE[other(sideNow)].bg}
                    ink={SWITCH_STYLE[other(sideNow)].fg}
                    strong
                    done={cooling["check-col1"]}
                    disabled={feedPending || cooling.col1}
                    onTap={tap(() => swap("col1", () => void actions.switchSide(feed, other(sideNow))))}
                  />
                )}
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
                  inline={feedPending || askWhen}
                  accent
                  disabled={feedPending || cooling.col3}
                  onTap={tap(() => (askWhen ? open({ kind: "feed", entry: feed, preset: fixPreset("current", "done") }) : void actions.stop(feed)))}
                />
              </>
            ) : feed && feedN && nursing && both && !staleFeed(feed as Entry & { data: FeedData }, clock) ? (
              <>
                {/*
                  On a break after going back and forth: column 1 asks which side she's on (and goes back on
                  there); column 2, where Pause was, is "Back on", still going back and forth, filled, so a late
                  second Pause tap rejoins with no break (under a minute, the engine merges it).
                */}
                <Tile
                  id="track"
                  label="Track sides"
                  sub="Left or Right"
                  aria="Back on a side: which side is she on now?"
                  letter="B"
                  stack
                  disabled={feedPending || cooling.col1}
                  onTap={tap(() => actions.askSide(feed))}
                />
                <Tile
                  id="back-on"
                  label="Back on"
                  sub="both sides"
                  letter="B"
                  stack
                  aria="Back on, going back and forth"
                  accent
                  done={cooling["check-col2"]}
                  disabled={feedPending || cooling.col2}
                  onTap={tap(() => swap("col2", () => void actions.resume(feed, "B")))}
                />
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
            ) : feed && feedN && nursing ? (
              <>
                {/*
                  Paused: each column keeps its job from while she nursed. Column 1 (where Switch was)
                  is the other side, filled like Switch and marked "Next side"; column 2 (where Pause
                  was) is the side she came off, "Resume". So Pause and Resume toggle in one spot, and
                  a late second tap on Pause goes back on the same side and merges (no break) instead
                  of starting the other side. The sides move with the feed, so their letters are big.
                  Both turn off after a tap (column 1 for 2.5 s after its own), so a double tap can't land on the new tile.
                  (After an hour off a back-and-forth part, the sides count from the last side tracked.)
                */}
                {[other(sideNow), sideNow].map((s, i) => {
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
                      onTap={tap(() => swap(col, () => void (fresh ? actions.freshFeed(feed, s) : actions.resume(feed, s)), { long: fresh }))}
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
                {bottles ? (
                  <Tile id="bottle" label="Bottle" sub={lastBottleLabel} inline={!!lastBottleLabel} icon="bottle" color={TILE.bottle} onTap={tap(() => open({ kind: "feed", preset: { method: "bottle" } }))} />
                ) : (
                  <div aria-hidden className="col-span-2" />
                )}
                <div aria-hidden className="col-span-2" />
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
                    wide={!bottles}
                    done={cooling[s === "L" ? "check-col1" : "check-col2"]}
                    disabled={s === "L" ? cooling.col1 : cooling.col2}
                    onTap={tap(() => tapSide(s))}
                    onHold={hold(() => holdFeed(s))}
                  />
                ))}
                {bottles && (
                  <Tile
                    id="bottle"
                    label="Bottle"
                    sub={lastBottleLabel}
                    inline={!!lastBottleLabel}
                    icon="bottle"
                    color={TILE.bottle}
                    onTap={tap(() => open({ kind: "feed", preset: { method: "bottle" } }))}
                    onHold={hold(() => open({ kind: "feed", preset: { method: "bottle", started_at: earlierAt() } }))}
                  />
                )}
              </>
            )}
            <Tile id="more" label="More" icon="plus" onTap={tap(() => setMoreOpen(true))} />

            {/* Row 2: diapers and sleep. */}
            <Tile
              id="pee"
              label="Pee"
              marks={[{ icon: "droplet", color: TILE.pee }]}
              done={done.pee}
              onTap={tap(() => void logDiaper("pee", true, false))}
              onHold={hold(() => open({ kind: "diaper", preset: { pee: true, poop: false, started_at: earlierAt() } }))}
            />
            <Tile
              id="poop"
              label="Poop"
              marks={[{ icon: "poop", color: TILE.poop }]}
              done={done.poop}
              onTap={tap(() => void logDiaper("poop", false, true))}
              onHold={hold(() => open({ kind: "diaper", preset: { pee: false, poop: true, started_at: earlierAt() } }))}
            />
            <Tile
              id="both"
              label="Both"
              marks={[
                { icon: "droplet", color: TILE.pee },
                { icon: "poop", color: TILE.poop },
              ]}
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
 * icon or diaper marks) so the eye finds it, a label, and an optional live
 * subline. `strong` fills it with its color (the action you most likely
 * want now); `accent` fills it with the app's primary color (Done). Two
 * layouts: mark and label on one line over the subline (side letters, and
 * any tile given `inline` because it has a subline), or the mark over the
 * label.
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
  marks,
  strong,
  accent,
  ink,
  disabled,
  aria,
  inline: inlineProp,
  bigLetter,
  stack,
  wide,
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
  /** A side letter on its color; "B" (going back and forth) is the two side colors with "LR". */
  letter?: StretchSide;
  icon?: IconName;
  /** Diaper marks (the drop, the pile, or both), drawn like the Timeline's and the Since tiles'. */
  marks?: { icon: IconName; color: string }[];
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
  /** Icon and label on one line, over the subline (Done and Bottle when they have one), so every tile with a subline fits the same height. */
  inline?: boolean;
  /** A bigger side letter that never hides (the paused sides, whose columns follow the feed rather than Left/Right). */
  bigLetter?: boolean;
  /** The mark over the label even with a letter (a long label like "Back & forth" needs the tile's width). */
  stack?: boolean;
  /** Three of the grid's eight columns instead of two (Left and Right with Bottles off). */
  wide?: boolean;
}) {
  const press = usePress(onTap, onHold);
  // At night a filled tile glows softly instead of blazing, in the amber like
  // every other kind color (a violet "Woke up" or a rust "Switch to Left" would
  // be the only cool or red patch on the 3am screen).
  const night = useNightActive();
  const filled = strong || accent;
  // Icon and label share a line for a side letter or when asked (a tile with a subline); Done, Pause, More and "Woke up" stack.
  const inline = (!!letter && !stack) || !!inlineProp;
  const fill = strong && color ? (night ? "rgb(224 169 59 / 0.25)" : color) : undefined;
  return (
    <button
      type="button"
      data-tile={id}
      disabled={disabled}
      aria-label={`${aria ?? label}${next ? " (next side)" : ""}${onHold ? ". Hold to log an earlier one" : ""}`}
      {...press}
      className={cx(
        "relative flex min-h-[64px] flex-col items-center justify-center rounded-2xl border px-1 text-center transition select-none active:scale-[0.96] disabled:opacity-50 disabled:active:scale-100",
        stack ? "py-1" : "py-1.5",
        wide ? "col-span-3" : "col-span-2",
        accent
          ? "border-transparent bg-mp-accent text-mp-on-accent"
          : strong
            ? "border-transparent"
            : next
              ? "border-mp-accent-fg/70 bg-mp-surface text-mp-ink"
              : // By day a white tile on the cream needs no outline, just a soft lift; dark and night keep a hairline (--mp-edge).
                "border-(--mp-edge) bg-mp-surface text-mp-ink shadow-[0_1px_2px_rgb(28_38_25/0.06)]"
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
          // A stacked tile with a subline ("Back & forth" / "Track sides") sits tighter so it keeps the row's 64px.
          <motion.span key="label" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className={cx("flex flex-col items-center", stack ? "gap-0.5" : "gap-1")}>
            <span className="flex items-center gap-1.5">
              {letter === "B" && <BothMark />}
              {letter && letter !== "B" && (
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
              {marks && (
                // h-5, as tall as Sleep's moon, so Pee, Poop and Both sit on Sleep's baseline.
                <span aria-hidden className="flex h-5 items-center gap-0.5">
                  {marks.map((m) => (
                    <Icon key={m.icon} name={m.icon} size={marks.length > 1 ? 17 : 20} className="mp-kind-ink" style={{ color: m.color }} />
                  ))}
                </span>
              )}
              {inline && <span className="text-[15px] leading-tight font-semibold">{label}</span>}
            </span>
            {!inline && (
              // "Back & forth" fits a 76px tile at 14px only just: a notch smaller under 360px.
              <span className={cx("leading-tight font-semibold whitespace-nowrap", filled ? "text-[15px]" : "text-[14px]", stack && "tracking-[-0.01em] max-[359px]:text-[13px]")}>
                {label}
              </span>
            )}
            {sub && (
              // 11px needs ink-2 (ink-3 is 3:1 at night); on a filled tile it's full strength (85% was 4.39:1 on "to Left").
              <span
                className={cx(
                  "text-[11px] leading-tight tabular-nums",
                  filled ? "opacity-100" : next ? "font-semibold text-mp-accent-fg" : "text-mp-ink-2"
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

/**
 * Going back and forth: the two side colors side by side with "LR", the
 * tile's mark where a side letter would be (an amber ring at night, as the
 * side letters are).
 */
function BothMark() {
  return (
    <span aria-hidden className="mp-side-mark relative inline-flex h-4 shrink-0 items-center overflow-hidden rounded-full px-[3px] text-[10px] leading-none font-bold tracking-[-0.02em]">
      <span className="absolute inset-y-0 left-0 w-1/2 [.maple-night_&]:hidden" style={{ backgroundColor: SIDE_COLOR.L }} />
      <span className="absolute inset-y-0 right-0 w-1/2 [.maple-night_&]:hidden" style={{ backgroundColor: SIDE_COLOR.R }} />
      {/* Each letter in its half's ink (SIDE_INK: white on rust, dark on honey). */}
      <span className="relative text-white [.maple-night_&]:text-[#e8a23f]">L</span>
      <span className="relative ml-[3px] text-[#2A1A08] [.maple-night_&]:text-[#e8a23f]">R</span>
    </span>
  );
}
