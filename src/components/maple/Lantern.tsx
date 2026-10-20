"use client";

import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tick } from "@/components/atlas/haptics";
import { other } from "@/lib/maple/feed";
import { DEFAULT_TZ, formatClock, formatTime } from "@/lib/maple/time";
import type { Entry, Side } from "@/lib/maple/types";
import { SIDE_NAME, timerNumbers, useTimerActions } from "./TimerCard";
import { useMaple, useNow } from "./useMaple";

/**
 * Lantern: a full-screen, nearly black timer for feeds in the dark. A web app
 * can't put a live timer on the lock screen, so this keeps the screen awake
 * but dim instead. Its two buttons need a half-second hold, so a flailing
 * baby hand or a cheek can't end the feed by accident.
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

  const isFeed = live.kind === "feed";
  // Viewers only watch; a just-started timer (temporary id) can't take actions yet.
  const locked = readOnly || live.id < 0;
  const target: Side = n.side ? other(n.side) : "L";
  const subtitle = isFeed
    ? `${n.paused ? "Paused" : `${SIDE_NAME[n.side ?? "L"]} side`} · since ${formatTime(live.started_at, tz)}`
    : `Asleep · since ${formatTime(live.started_at, tz)}`;

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
        <p className="text-xs tracking-[0.2em] uppercase opacity-40">Lantern · swipe down to close</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close lantern"
          className="flex h-12 w-12 items-center justify-center rounded-full text-2xl opacity-50 active:opacity-80"
        >
          ✕
        </button>
      </div>

      <div
        className="flex flex-1 flex-col items-center justify-center px-6 text-center"
        onClick={() => showHint(isFeed && !n.paused ? "Hold to switch, or hold Done" : "Hold a button to use it")}
      >
        <p
          className="font-[family-name:var(--font-display)] text-[72px] leading-none font-semibold lining-nums tabular-nums"
          style={{ opacity: n.paused ? 0.35 : dim ? 0.55 : 0.6 }}
          aria-live="off"
        >
          {formatClock(n.elapsed)}
        </p>
        <p className="mt-3 text-lg opacity-50">{subtitle}</p>
        {isFeed && (
          <p className="mt-1 text-sm tabular-nums opacity-35">
            L {formatClock(n.left)} · R {formatClock(n.right)}
          </p>
        )}
        <p className="mt-6 h-5 text-sm opacity-60" aria-live="polite">
          {hint ?? ""}
        </p>
      </div>

      <div className="flex h-[40dvh] gap-3 px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
        {locked && <p className="m-auto text-sm opacity-50">{readOnly ? "Viewing only" : "Starting…"}</p>}
        {!locked && isFeed && !n.paused && (
          <HoldButton label={`Switch to ${SIDE_NAME[target]}`} onHint={() => showHint("Hold to switch")} onConfirm={() => void actions.switchSide(live, target)} />
        )}
        {!locked && isFeed && n.paused && (
          <HoldButton label={`Resume ${SIDE_NAME[n.side ?? "L"]}`} onHint={() => showHint("Hold to resume")} onConfirm={() => void actions.resume(live, n.side ?? "L")} />
        )}
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
function HoldButton({ label, onConfirm, onHint }: { label: string; onConfirm: () => void; onHint: () => void }) {
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
      aria-label={`${label} (press and hold)`}
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
