"use client";

import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tick } from "@/components/atlas/haptics";
import { minutesText, other, staleFeed } from "@/lib/maple/feed";
import { DEFAULT_TZ, formatClock, formatTime, formatTimeNear } from "@/lib/maple/time";
import type { Entry, FeedData, Side } from "@/lib/maple/types";
import { fixPreset, SIDE_NAME, timerNumbers, useStillGoing } from "./FeedParts";
import { Icon, type IconName } from "./icons";
import { useSheets } from "./sheets";
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
  const [hint, setHint] = useState<string | null>(null);
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

  const showHint = (text: string, ms = 1800) => {
    setHint(text);
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
    setHint(fail.text);
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), 6000);
  }, [toasts]);

  const isFeed = live.kind === "feed" && n.parts.length > 0;
  // Viewers only watch; a just-started timer (temporary id) can't take actions yet.
  const locked = readOnly || live.id < 0;
  const side: Side = n.side ?? "L";
  const target: Side = other(side);
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
    showHint(last?.kind === "side" ? `Paused · ${SIDE_NAME[last.side]} ${minutesText(last.min)}` : "Paused", 3000);
  };
  // The big clock is the part she's on now: this side, or the break (dimmed). The side is named first, above it
  // (it's the 3am question); when it started goes under it.
  const heading = !isFeed ? "Asleep" : n.paused ? "On a break" : `${SIDE_NAME[side]} side`;
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

      <div
        className="flex flex-1 flex-col items-center justify-center px-6 text-center"
        onClick={() => showHint(isFeed && !n.paused ? "Hold Switch, Pause or Done" : "Hold a button to use it")}
      >
        <p className="mb-3 flex items-center gap-2.5 text-2xl font-semibold" style={{ opacity: n.paused ? 0.55 : 0.75 }}>
          {/* The side's letter in a ring, as the card and dock show it at night. */}
          {isFeed && !n.paused && (
            <span
              aria-hidden
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[17px] font-bold"
              style={{ boxShadow: "inset 0 0 0 2px rgba(224,169,59,.5)" }}
            >
              {side}
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
          {hint ?? ""}
        </p>
      </div>

      {!locked && (
        <div className="px-4 pb-3 text-center">
          {askWhen && (
            <p className="mb-1 text-lg font-semibold tabular-nums opacity-60">
              Still nursing? {SIDE_NAME[side]} {minutesText(n.current.min)}
            </p>
          )}
          <p className="text-[13px] opacity-50">Hold a button to use it</p>
        </div>
      )}
      <div className="flex h-[40dvh] gap-3 px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
        {locked && <p className="m-auto text-sm opacity-50">{readOnly ? "Viewing only" : "Starting…"}</p>}
        {/* Nursing: Switch and Pause where the dock has them, so a mid-feed diaper is a break, not the end of the feed. */}
        {!locked && isFeed && !n.paused && (
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

  const C = 2 * Math.PI * 26;
  return (
    <button
      type="button"
      aria-label={`${aria ?? label} (press and hold)`}
      onPointerDown={(e) => {
        e.stopPropagation();
        fired.current = false;
        start.current = e.timeStamp;
        raf.current = requestAnimationFrame(loop);
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        cancel(true, e.timeStamp);
      }}
      onPointerLeave={() => cancel(false)}
      onPointerCancel={() => cancel(false)}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        // Keyboard users can't "hold": Enter confirms directly.
        if (e.key === "Enter") onConfirm();
      }}
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
