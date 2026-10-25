"use client";

import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tick } from "@/components/atlas/haptics";
import { isTracked, minutesText, other, staleFeed } from "@/lib/maple/feed";
import { DEFAULT_TZ, formatClock, formatTime, formatTimeNear } from "@/lib/maple/time";
import type { Entry, FeedData, Side } from "@/lib/maple/types";
import { careTime, planTitle } from "@/lib/maple/care";
import { errorText } from "./care/parts";
import { useCare } from "./care/useCare";
import { fixPreset, SIDE_NAME, timerNumbers, useStillGoing } from "./FeedParts";
import { Icon, type IconName } from "./icons";
import { useSheets } from "./sheets";
import { cx } from "./ui";
import { useHoldTimerToasts, useMaple, useNow } from "./useMaple";
import { useTimerActions } from "./useTimerActions";

/**
 * Lantern: a full-screen, nearly black timer for feeds in the dark. A web app
 * can't put a live timer on the lock screen, so this keeps the screen awake
 * but dim instead. It covers the dock, so it carries the dock's buttons in
 * the dock's column order (Switch, Pause, Done while she nurses; the other
 * side, the side she came off, Done during a break), each needing a
 * half-second hold so a flailing baby hand or a cheek can't end the feed by
 * accident (a quiet line over them says so). A side left running past the
 * card's "Still nursing?" check says so here too, and Done then closes the
 * Lantern and asks when she finished, as the dock's does. Timer toasts wait
 * while it's open and show when it closes (if still true).
 *
 * Going back and forth: from the feed's second Switch a hold row over the
 * buttons offers it ("Going back and forth? Hold to stop tracking sides").
 * While she's going both, the heading is "Both sides" with an LR ring and
 * only two big buttons stay, Pause and Done (on a break, "Back on" and "Done ·
 * ends 8:10"): fewer, bigger targets at 3am. Tracking sides again is the
 * dock's, with the Lantern closed.
 */

const HOLD_MS = 500;
const AMBER = "#E0A93B";

export default function Lantern({ entry, onClose, dim }: { entry: Entry; onClose: () => void; dim?: boolean }) {
  const { state, readOnly, now: serverNow, toasts } = useMaple();
  const now = useNow(1000);
  const actions = useTimerActions();
  const { open } = useSheets();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  // Follow the live entry (switches from the other phone show up here too).
  const live = state?.entries.find((e) => e.id === entry.id) ?? entry;
  const n = timerNumbers(live, now);
  // On a break over an hour (staleFeed, the Siri/Claude rule the dock uses too): her side starts a new feed.
  const stale = live.kind === "feed" && n.paused && staleFeed(live as Entry & { data: FeedData }, now);
  // The card's "Still nursing?" (a long side, not snoozed): Done asks when instead of ending the feed now.
  const still = useStillGoing(live, n, now);
  const askWhen = still.forgotten && still.check === "side";
  // The line over the buttons: what a tap would need, what a hold did, or why it didn't (with Undo after her dose).
  const [hint, setHint] = useState<{ text: string; undo?: () => void } | null>(null);
  const hintTimer = useRef<number | null>(null);
  const swipe = useRef<{ y: number; t: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  // The parent re-renders every second; keep the latest onClose without re-running effects.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => setMounted(true), []);

  // Open: no timer toast behind it; taps in here keep theirs for when it closes.
  useHoldTimerToasts(true);

  // Gone (stopped or discarded elsewhere)? Close.
  useEffect(() => {
    if (!live.active) closeRef.current();
  }, [live.active]);

  // Keep the screen awake while the lantern is open (same pattern as /calendar/display).
  useEffect(() => {
    type WakeLockSentinel = { release: () => Promise<void> };
    type NavigatorWithWakeLock = Navigator & { wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> } };
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const nav = navigator as NavigatorWithWakeLock;
    const request = async () => {
      if (!nav.wakeLock) return;
      try {
        sentinel = await nav.wakeLock.request("screen");
      } catch {
        // Not supported or denied (e.g. page not visible). Fail quiet.
      }
    };
    void request();
    const onVisible = () => {
      if (document.visibilityState === "visible" && !cancelled) void request();
    };
    document.addEventListener("visibilitychange", onVisible);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      if (sentinel) void sentinel.release().catch(() => {});
    };
  }, []);

  useEffect(
    () => () => {
      if (hintTimer.current) window.clearTimeout(hintTimer.current);
    },
    []
  );

  const showHint = (text: string, ms = 1800, undo?: () => void) => {
    setHint({ text, undo });
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), ms);
  };

  /**
   * A hold that didn't happen says why here: its toast ("Brittany already put her back on the Left at 7:08")
   * draws under the lantern, so the newest failure toast since it opened becomes the hint.
   */
  const seenToasts = useRef<Set<number> | null>(null);
  const failHintAt = useRef(0);
  useEffect(() => {
    if (!seenToasts.current) {
      seenToasts.current = new Set(toasts.map((t) => t.id));
      return;
    }
    const seen = seenToasts.current;
    const fresh = toasts.filter((t) => !seen.has(t.id));
    for (const t of fresh) seen.add(t.id);
    const fail = fresh.filter((t) => t.group !== "timer" && t.tone !== "ok").at(-1);
    if (!fail) return;
    failHintAt.current = Date.now();
    // Her dose saved with a note to read (it carries who to call): the note, with the toast's Undo, a while longer.
    const dose = fail.icon === "pill" && !!fail.undo;
    setHint({ text: fail.text, undo: dose ? fail.undo : undefined });
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), dose ? 12000 : 6000);
  }, [toasts]);

  const isFeed = live.kind === "feed" && n.parts.length > 0;
  // Viewers only watch; a just-started timer (temporary id) can't take actions yet.
  const locked = readOnly || live.id < 0;
  // Going back and forth (the part she's on, or came off): two big buttons. An hour off it, the sides start a new feed as usual.
  const both = isFeed && n.both && !stale;
  // The side she's on, or (after back and forth) the last one tracked: what Switch and the paused sides count from.
  const side: Side = isTracked(n.side) ? n.side : n.tracked ?? "L";
  const target: Side = other(side);
  // From the feed's second Switch, while she's on a side: going back and forth is one hold away.
  const offerBoth = isFeed && !n.paused && !n.both && n.switches >= 2;
  const short = (t: string) => formatTimeNear(t, t, tz);
  /** After a hold, say what happened once the server has it (its toast waits until the lantern closes). */
  const confirmed = (ok: boolean, text: string) => {
    if (ok) return showHint(`${text} · ${short(serverNow().toISOString())}`, 3000);
    // Its failure toast already said why (above); only without one is there nothing better to say.
    if (Date.now() - failHintAt.current > 1500) showHint("That didn't save. Close the lantern to see why.", 3000);
  };
  /** Pause says what it closed, as the dock's toast does: "Paused · Left 14 min". */
  const paused = (e: Entry | null) => {
    if (!e) return confirmed(false, "");
    const last = timerNumbers(e, serverNow()).parts.filter((p) => p.kind === "side").at(-1);
    showHint(last?.kind === "side" ? `Paused · ${last.side === "B" ? "back and forth" : SIDE_NAME[last.side]} ${minutesText(last.min)}` : "Paused", 3000);
  };
  // The big clock is the part she's on now: this side, or the break (dimmed). The side is named first, above it
  // (it's the 3am question); when it started goes under it.
  const heading = !isFeed ? "Asleep" : n.paused ? "On a break" : n.both ? "Both sides" : `${SIDE_NAME[side]} side`;
  const detail = !isFeed
    ? `Since ${formatTime(live.started_at, tz)}`
    : // The feed's start only when it's another time (on a one-side feed it's this side's start).
      `Since ${short(n.current.since)}${short(live.started_at) === short(n.current.since) ? "" : ` · started ${short(live.started_at)}`}`;

  if (!mounted) return null;
  return createPortal(
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Lantern timer"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[120] flex touch-none flex-col bg-black select-none"
      style={{ color: AMBER }}
      onPointerDown={(e) => {
        swipe.current = { y: e.clientY, t: Date.now() };
      }}
      onPointerUp={(e) => {
        const s = swipe.current;
        swipe.current = null;
        if (s && e.clientY - s.y > 110 && Date.now() - s.t < 900) onClose();
      }}
    >
      <div className="flex items-center justify-between px-4 pt-[max(12px,env(safe-area-inset-top))]">
        <p className="text-[13px] opacity-50">Lantern · swipe down to close</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close lantern"
          className="-mr-2 flex h-12 w-12 items-center justify-center rounded-full opacity-50 active:opacity-80"
        >
          <Icon name="x" size={26} />
        </button>
      </div>
      {/* Her mom's medicine: a hold-to-log row when one tap would just save it, else read-only, as dim as the line above. */}
      <div className="-mt-1.5 px-4">
        <CareLanternRow onHint={showHint} />
      </div>

      <div
        className="flex flex-1 flex-col items-center justify-center px-6 text-center"
        onClick={() => showHint(both ? (n.paused ? "Hold Back on or Done" : "Hold Pause or Done") : isFeed && !n.paused ? "Hold Switch, Pause or Done" : "Hold a button to use it")}
      >
        <p className="mb-3 flex items-center gap-2.5 text-2xl font-semibold" style={{ opacity: n.paused ? 0.55 : 0.75 }}>
          {/* The side's letter in a ring, as the card and dock show it at night. */}
          {isFeed && !n.paused && (
            <span
              aria-hidden
              className={cx("inline-flex h-9 w-9 items-center justify-center rounded-full font-bold", n.both ? "text-[13px] tracking-[-0.02em]" : "text-[17px]")}
              style={{ boxShadow: "inset 0 0 0 2px rgba(224,169,59,.5)" }}
            >
              {n.both ? "LR" : side}
            </span>
          )}
          {heading}
        </p>
        <p
          className="text-[80px] leading-none font-semibold tracking-[-0.03em] tabular-nums"
          style={{ opacity: n.paused ? 0.5 : dim ? 0.7 : 0.75 }}
          aria-live="off"
        >
          {formatClock(isFeed ? n.current.sec : n.elapsed)}
        </p>
        <p className="mt-3 text-[17px] whitespace-nowrap tabular-nums opacity-65">{detail}</p>
        {/* Total only with more than one side (on one side it's the big clock, said twice); on a break, what she had so far. */}
        {isFeed && !n.paused && n.parts.filter((p) => p.kind === "side").length > 1 && <p className="mt-1 text-base tabular-nums opacity-60">Total nursing {minutesText(n.totalMin)}</p>}
        {isFeed && n.paused && (
          <p className="mt-1 text-base tabular-nums opacity-60">
            {stale ? "Over an hour: her side starts a new feed" : n.current.sec >= 20 * 60 ? `Still on a break? Nursed ${minutesText(n.totalMin)} so far` : `Nursed ${minutesText(n.totalMin)} so far`}
          </p>
        )}
        <p className="mt-6 h-5 text-sm opacity-60" aria-live="polite">
          {hint?.text ?? ""}
          {hint?.undo && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                const undo = hint.undo;
                setHint(null);
                undo?.();
              }}
              className="-my-3 ml-1 inline-flex min-h-[44px] items-center px-2 font-semibold underline underline-offset-2"
            >
              Undo
            </button>
          )}
        </p>
      </div>

      {!locked && (
        <div className="px-4 pb-3 text-center">
          {askWhen && (
            <p className="mb-1 text-lg font-semibold tabular-nums opacity-60">
              Still nursing? {n.both ? "Back and forth" : SIDE_NAME[side]} {minutesText(n.current.min)}
            </p>
          )}
          {offerBoth && (
            <BothHoldRow
              onHint={() => showHint("Hold to stop tracking sides")}
              onConfirm={() => void actions.backAndForth(live).then((r) => confirmed(!!r, "Both sides from now"))}
            />
          )}
          <p className="text-[13px] opacity-50">{both ? (n.paused ? "Hold Back on or Done" : "Hold Pause or Done") : "Hold a button to use it"}</p>
        </div>
      )}
      <div className="flex h-[40dvh] gap-3 px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
        {locked && <p className="m-auto text-sm opacity-50">{readOnly ? "Viewing only" : "Starting…"}</p>}
        {/* Nursing: Switch and Pause where the dock has them, so a mid-feed diaper is a break, not the end of the feed. */}
        {/* Going back and forth: Pause and Done only (two bigger targets); on a break, Back on where Pause was. */}
        {!locked && both && !n.paused && <HoldButton label="Pause" icon="pause" aria="Pause the feed" onHint={() => showHint("Hold to pause")} onConfirm={() => void actions.pause(live).then(paused)} />}
        {!locked && both && n.paused && (
          <HoldButton
            label="Back on"
            sub="back and forth"
            icon="arrow-left-right"
            aria="Back on, going back and forth"
            onHint={() => showHint("Hold to go back on")}
            onConfirm={() => void actions.resume(live, "B").then((r) => confirmed(!!r, "Back on, back and forth"))}
          />
        )}
        {!locked && isFeed && !both && !n.paused && (
          <>
            <HoldButton
              label="Switch"
              sub={`to ${SIDE_NAME[target]}`}
              mark={target}
              aria={`Switch to ${SIDE_NAME[target]}`}
              onHint={() => showHint("Hold to switch")}
              onConfirm={() => void actions.switchSide(live, target).then((r) => confirmed(!!r, `Switched to ${SIDE_NAME[target]}`))}
            />
            <HoldButton label="Pause" icon="pause" aria="Pause the feed" onHint={() => showHint("Hold to pause")} onConfirm={() => void actions.pause(live).then(paused)} />
          </>
        )}
        {/* Paused: the other side where Switch was, the side she came off where Pause was (the dock's order). */}
        {!locked &&
          isFeed &&
          !both &&
          n.paused &&
          [target, side].map((s, i) => (
            <HoldButton
              key={i}
              label={SIDE_NAME[s]}
              // On a break over an hour (the dock's rule): a hold starts a new feed, ending this one at its pause.
              sub={stale ? "New feed" : i === 0 ? "Next side" : "Resume"}
              mark={s}
              aria={stale ? `Start a new feed on ${SIDE_NAME[s]} (this one ends at its pause)` : `Resume on ${SIDE_NAME[s]}${i === 0 ? " (next side)" : ""}`}
              onHint={() => showHint(stale ? "Hold to start a new feed" : `Hold to ${i === 0 ? "go on" : "go back on"} the ${SIDE_NAME[s]}`)}
              onConfirm={() =>
                void (stale
                  ? actions.freshFeed(live, s).then((r) => confirmed(!!r, `New feed on the ${SIDE_NAME[s]}`))
                  : actions.resume(live, s).then((r) => confirmed(!!r, `${i === 0 ? "On" : "Back on"} the ${SIDE_NAME[s]}`)))
              }
            />
          ))}
        {!locked && (
          <HoldButton
            label={live.kind === "sleep" ? "Woke up" : "Done"}
            icon={isFeed ? "check" : undefined}
            // Done during a break ends the feed at the pause, as the dock's tile says; past "Still nursing?" it asks when.
            sub={isFeed && n.paused ? `ends ${short(n.current.since)}` : askWhen ? "when?" : undefined}
            aria={isFeed && n.paused ? `Done: end the feed at ${formatTime(n.current.since, tz)}, when you paused` : askWhen ? "Done: choose when the feed ended" : undefined}
            onHint={() => showHint(live.kind === "sleep" ? "Hold to stop sleep" : askWhen ? "Hold, then pick when she finished" : "Hold to finish")}
            onConfirm={() => {
              if (askWhen) {
                onClose();
                return open({ kind: "feed", entry: live, preset: fixPreset("current", "done") });
              }
              void actions.stop(live);
              onClose();
            }}
          />
        )}
      </div>
    </motion.div>,
    document.body
  );
}

/**
 * Her mom's line in the Lantern (the one rule's medicine, as on Today's
 * strip). When her Took it would just save ("save" by the one-tap: nothing
 * to ask), it's a hold-to-log row behind the same half-second hold as the
 * feed buttons, and what happened shows in the Lantern's own hint line,
 * since toasts draw under it: "Ibuprofen logged 2:58 AM · Undo". Otherwise
 * (a dose someone logged in the last 30 minutes, a once-a-day one already
 * logged, or one just logged here) it's the dim read-only line. Two lines
 * at most, so the time isn't the part cut off.
 */
function CareLanternRow({ onHint }: { onHint: (text: string, ms?: number, undo?: () => void) => void }) {
  const care = useCare();
  const { state, now } = useMaple();
  const careRef = useRef(care);
  useEffect(() => {
    careRef.current = care;
  });
  const line = care?.todayLine;
  const view = line?.view;
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const title = view ? planTitle(view.plan) : "";
  const canHold = !!care && !!view && care.access.write && !line?.held && view.oneTap === "save";

  const confirm = () => {
    const c = careRef.current;
    if (!c || !view) return;
    const planId = view.plan.id;
    void c.act
      .tookIt(planId)
      .then((r) => {
        if (r === "ignored") return;
        if (r === "saved") {
          const h = careRef.current?.held(planId);
          const at = h?.at ?? now().toISOString();
          return onHint(`${title} logged ${careTime(at, now(), tz)}`, 10_000, () => {
            // The hold's dose as it stands when Undo is tapped (its id is the saved one by then).
            const id = careRef.current?.held(planId)?.entryId;
            if (id == null) return;
            void careRef.current?.act
              .deleteEntry(id)
              .then(() => onHint("Removed", 3000))
              .catch(() => onHint("That didn't change. Close the lantern to see why.", 4000));
          });
        }
        onHint(r.ask.at ? `Already logged at ${careTime(r.ask.at, now(), tz)}. Nothing saved.` : "Nothing saved. Check her page after the feed.", 6000);
      })
      .catch((e) => onHint(errorText(e), 6000));
  };
  const who = care && !care.self ? `${care.name} · ` : "";
  const { progress, handlers } = useHold(confirm, () => onHint(`Hold to log ${care?.self ? "your" : `${care?.name}'s`} ${title}`));

  if (!care || !line || !view) return null;
  if (!canHold) return <p className="line-clamp-2 text-[13px] tabular-nums opacity-50">{care.lanternLine}</p>;
  return (
    <button
      type="button"
      aria-label={`Log ${care.self ? "your" : `${care.name}'s`} ${title}: ${view.glance.text} (press and hold)`}
      {...handlers}
      className="-mx-1 flex min-h-[44px] w-[calc(100%+0.5rem)] items-center gap-3 rounded-2xl px-1 text-left"
      style={{ WebkitTouchCallout: "none" }}
    >
      <span className="line-clamp-2 min-w-0 flex-1 text-[15px] leading-snug tabular-nums opacity-70">
        {who}
        {title} <span className="whitespace-nowrap">{view.glance.ready ? "OK now" : `· ${view.glance.text}`}</span>
      </span>
      {/* The hold fills the pill from the left, as the big buttons' rings fill. */}
      <span
        aria-hidden
        className="relative shrink-0 overflow-hidden rounded-full border px-3 py-1.5 text-[13px] font-semibold whitespace-nowrap"
        style={{ borderColor: "rgba(224,169,59,0.3)", color: "rgba(224,169,59,0.85)" }}
      >
        <span className="absolute inset-y-0 left-0" style={{ width: `${progress * 100}%`, backgroundColor: "rgba(224,169,59,0.22)" }} />
        <span className="relative">Hold to log</span>
      </span>
    </button>
  );
}

/**
 * "Going back and forth? Hold to stop tracking sides": from the feed's
 * second Switch, a row over the big buttons behind the same half-second hold
 * as her medicine row, its pill filling as it's held.
 */
function BothHoldRow({ onConfirm, onHint }: { onConfirm: () => void; onHint: () => void }) {
  const { progress, handlers } = useHold(onConfirm, onHint);
  return (
    <button
      type="button"
      aria-label="Going back and forth? Stop tracking sides (press and hold)"
      {...handlers}
      className="mb-2 flex min-h-[52px] w-full items-center gap-3 rounded-2xl border px-3 py-1.5 text-left"
      style={{ borderColor: "rgba(224,169,59,0.18)", WebkitTouchCallout: "none" }}
    >
      <Icon name="arrow-left-right" size={20} className="shrink-0 opacity-60" />
      <span className="min-w-0 flex-1 leading-snug">
        <span className="block text-[15px] opacity-75">Going back and forth?</span>
        <span className="block text-[13px] opacity-55">Hold to stop tracking sides</span>
      </span>
      {/* The hold fills the pill from the left, as the big buttons' rings fill. */}
      <span
        aria-hidden
        className="relative shrink-0 overflow-hidden rounded-full border px-3.5 py-1.5 text-[13px] font-semibold whitespace-nowrap"
        style={{ borderColor: "rgba(224,169,59,0.3)", color: "rgba(224,169,59,0.85)" }}
      >
        <span className="absolute inset-y-0 left-0" style={{ width: `${progress * 100}%`, backgroundColor: "rgba(224,169,59,0.22)" }} />
        <span className="relative">Hold</span>
      </span>
    </button>
  );
}

/**
 * The Lantern's half-second press-and-hold: `progress` runs 0 → 1 while the
 * finger is down, and `onConfirm` fires when it fills; a shorter press is a
 * tap, which only says how (`onHint`). Spread `handlers` on the button.
 */
function useHold(onConfirm: () => void, onHint: () => void) {
  const [progress, setProgress] = useState(0);
  const raf = useRef<number | null>(null);
  const start = useRef<number | null>(null);
  const fired = useRef(false);

  // Times come from the events and animation frames themselves (both on the performance clock).
  const cancel = (tap: boolean, at?: number) => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    // A release with no press here says nothing: after Pause or Resume the next button can appear under the finger still down.
    const pressed = start.current != null;
    const held = pressed && at != null ? at - start.current! : 0;
    start.current = null;
    if (tap && pressed && !fired.current && held < HOLD_MS) onHint();
    setProgress(0);
  };

  const loop = (frame: number) => {
    if (start.current == null) return;
    const p = Math.min(1, Math.max(0, frame - start.current) / HOLD_MS);
    setProgress(p);
    if (p >= 1) {
      fired.current = true;
      tick(20);
      start.current = null;
      onConfirm();
      return;
    }
    raf.current = requestAnimationFrame(loop);
  };

  useEffect(() => () => {
    if (raf.current) cancelAnimationFrame(raf.current);
  }, []);

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation();
      fired.current = false;
      start.current = e.timeStamp;
      raf.current = requestAnimationFrame(loop);
    },
    onPointerUp: (e: React.PointerEvent) => {
      e.stopPropagation();
      cancel(true, e.timeStamp);
    },
    onPointerLeave: () => cancel(false),
    onPointerCancel: () => cancel(false),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    onKeyDown: (e: React.KeyboardEvent) => {
      // Keyboard users can't "hold": Enter confirms directly.
      if (e.key === "Enter") onConfirm();
    },
  };
  return { progress, handlers };
}

/** A big button that only fires after a 500ms press-and-hold, with a ring that fills (around a side letter or an icon, when given). */
function HoldButton({
  label,
  sub,
  aria,
  mark,
  icon,
  onConfirm,
  onHint,
}: {
  label: string;
  sub?: string;
  aria?: string;
  /** The side letter inside the ring (the sides' order follows the feed, so the letter says which is which). */
  mark?: Side;
  icon?: IconName;
  onConfirm: () => void;
  onHint: () => void;
}) {
  const { progress, handlers } = useHold(onConfirm, onHint);
  const C = 2 * Math.PI * 26;
  return (
    <button
      type="button"
      aria-label={`${aria ?? label} (press and hold)`}
      {...handlers}
      className="relative flex flex-1 flex-col items-center justify-center gap-3 rounded-[28px] border text-xl font-semibold"
      style={{ borderColor: "rgba(224,169,59,0.18)", backgroundColor: "rgba(224,169,59,0.05)", color: "rgba(224,169,59,0.8)", WebkitTouchCallout: "none" }}
    >
      <span className="relative flex h-16 w-16 items-center justify-center">
      <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden className="absolute inset-0">
        <circle cx="32" cy="32" r="26" fill="none" stroke="rgba(224,169,59,0.15)" strokeWidth="4" />
        <circle
          cx="32"
          cy="32"
          r="26"
          fill="none"
          stroke={AMBER}
          strokeOpacity={0.8}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - progress)}
          transform="rotate(-90 32 32)"
        />
      </svg>
        {mark && (
          <span aria-hidden className="text-[26px] leading-none font-bold">
            {mark}
          </span>
        )}
        {icon && !mark && <Icon name={icon} size={24} />}
      </span>
      <span className="flex flex-col items-center gap-1">
        {label}
        {sub && <span className="text-sm font-medium tabular-nums opacity-70">{sub}</span>}
      </span>
    </button>
  );
}
