"use client";

import { useEffect, useRef } from "react";

export const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;

/**
 * Calls `callback` every `intervalMs` while the page is on screen, and at once
 * when it comes back after being away.
 *
 * Coming back is whichever of these the browser sends: visibilitychange,
 * pageshow (a page back from the back-forward cache), focus, or resume (a
 * frozen tab thawing). A phone doesn't always send the first one, so the beat
 * never stops while the page is hidden, it only skips (a hidden page's timers
 * are slowed or paused anyway), and a page back on screen with no event at all
 * is read at the next beat. Several signals for one return run it once.
 */
export function useVisiblePoll(
  callback: () => void,
  intervalMs: number = DEFAULT_POLL_INTERVAL_MS
) {
  const cbRef = useRef(callback);
  useEffect(() => {
    cbRef.current = callback;
  });

  useEffect(() => {
    const shown = () => document.visibilityState === "visible";
    // The owner reads once on mount; the beat and the returns take it from there.
    let last = Date.now();
    let away = false;
    let beat: ReturnType<typeof setInterval> | undefined;
    const run = () => {
      last = Date.now();
      away = false;
      cbRef.current();
    };
    const start = () => {
      clearInterval(beat);
      beat = setInterval(() => {
        if (shown()) run();
        else away = true;
      }, intervalMs);
    };
    const leave = () => {
      away = true;
    };
    const back = () => {
      if (!shown()) return leave();
      // Once per return, or when a beat is overdue (a page that froze without saying so).
      if (!away && Date.now() - last < intervalMs) return;
      run();
      start();
    };

    start();
    document.addEventListener("visibilitychange", back);
    window.addEventListener("pageshow", back);
    window.addEventListener("focus", back);
    document.addEventListener("resume", back);
    window.addEventListener("pagehide", leave);
    document.addEventListener("freeze", leave);
    return () => {
      clearInterval(beat);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("pageshow", back);
      window.removeEventListener("focus", back);
      document.removeEventListener("resume", back);
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("freeze", leave);
    };
  }, [intervalMs]);
}
