"use client";

import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tick } from "@/components/atlas/haptics";
import { other } from "@/lib/maple/feed";
import { DEFAULT_TZ, formatClock, formatTime, formatTimeNear } from "@/lib/maple/time";
import type { Entry, Side } from "@/lib/maple/types";
import { SIDE_NAME, timerNumbers } from "./FeedParts";
import { Icon } from "./icons";
import { useMaple, useNow } from "./useMaple";
import { useTimerActions } from "./useTimerActions";

/**
 * Lantern: a full-screen, nearly black timer for feeds in the dark. A web app
 * can't put a live timer on the lock screen, so this keeps the screen awake
 * but dim instead. It covers the dock, so it carries the dock's buttons in
 * the dock's column order, each needing a half-second hold so a flailing baby
 * hand or a cheek can't end the feed by accident. Timer toasts wait while it's
 * open and show when it closes (if still true).
 */

const HOLD_MS = 500;
const AMBER = "#E0A93B";

export default function Lantern({ entry, onClose, dim }: { entry: Entry; onClose: () => void; dim?: boolean }) {
  const { state, readOnly } = useMaple();
  const now = useNow(1000);
  const actions = useTimerActions();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  // Follow the live entry (switches from the other phone show up here too).
  const live = state?.entries.find((e) => e.id === entry.id) ?? entry;
  const n = timerNumbers(live, now);
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
  const hold = actions.holdToasts;
  useEffect(() => {
    hold(true);
    return () => hold(false);
  }, [hold]);

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

  const showHint = (text: string) => {
    setHint(text);
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), 1800);
  };

  const isFeed = live.kind === "feed" && n.parts.length > 0;
  // Viewers only watch; a just-started timer (temporary id) can't take actions yet.
  const locked = readOnly || live.id < 0;
  const side: Side = n.side ?? "L";
  const target: Side = other(side);
  const short = (t: string) => formatTimeNear(t, t, tz);
  // The big clock is the part she's on now: this side, or the break (dimmed).
  const subtitle = !isFeed
    ? `Asleep · since ${formatTime(live.started_at, tz)}`
    : n.paused
      ? `On a break · since ${short(n.current.since)}`
      : `${SIDE_NAME[side]} side · since ${short(n.current.since)} · feed started ${short(live.started_at)}`;

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
        <p className="text-[13px] opacity-40">Lantern · swipe down to close</p>
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
        onClick={() => showHint(isFeed && !n.paused ? "Hold to switch, or hold Done" : "Hold a button to use it")}
      >
        <p
          className="text-[80px] leading-none font-semibold tracking-[-0.03em] tabular-nums"
          style={{ opacity: n.paused ? 0.35 : dim ? 0.55 : 0.6 }}
          aria-live="off"
        >
          {formatClock(isFeed ? n.current.sec : n.elapsed)}
        </p>
        <p className="mt-3 text-lg opacity-50">{subtitle}</p>
        {isFeed && !n.paused && <p className="mt-1 text-sm tabular-nums opacity-35">Total nursing {formatClock(n.total)}</p>}
        <p className="mt-6 h-5 text-sm opacity-60" aria-live="polite">
          {hint ?? ""}
        </p>
      </div>

      <div className="flex h-[40dvh] gap-3 px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
        {locked && <p className="m-auto text-sm opacity-50">{readOnly ? "Viewing only" : "Starting…"}</p>}
        {!locked && isFeed && !n.paused && (
          <HoldButton label={`Switch to ${SIDE_NAME[target]}`} onHint={() => showHint("Hold to switch")} onConfirm={() => void actions.switchSide(live, target)} />
        )}
        {/* Paused: both sides, the other one first, as in the dock. */}
        {!locked &&
          isFeed &&
          n.paused &&
          [target, side].map((s) => (
            <HoldButton
              key={s}
              label={SIDE_NAME[s]}
              aria={`Resume on ${SIDE_NAME[s]}`}
              onHint={() => showHint(`Hold to go back on the ${SIDE_NAME[s]}`)}
              onConfirm={() => void actions.resume(live, s)}
            />
          ))}
        {!locked && (
          <HoldButton
            label={live.kind === "sleep" ? "Woke up" : "Done"}
            onHint={() => showHint(live.kind === "sleep" ? "Hold to stop sleep" : "Hold to finish")}
            onConfirm={() => {
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

/** A big button that only fires after a 500ms press-and-hold, with a ring that fills. */
function HoldButton({ label, aria, onConfirm, onHint }: { label: string; aria?: string; onConfirm: () => void; onHint: () => void }) {
  const [progress, setProgress] = useState(0);
  const raf = useRef<number | null>(null);
  const start = useRef<number | null>(null);
  const fired = useRef(false);

  // Times come from the events and animation frames themselves (both on the performance clock).
  const cancel = (tap: boolean, at?: number) => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    const held = start.current != null && at != null ? at - start.current : 0;
    start.current = null;
    if (tap && !fired.current && held < HOLD_MS) onHint();
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
      <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
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
      {label}
    </button>
  );
}
