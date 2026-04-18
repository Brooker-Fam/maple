"use client";

import { useEffect, useRef } from "react";

export const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;

export function useVisiblePoll(
  callback: () => void,
  intervalMs: number = DEFAULT_POLL_INTERVAL_MS
) {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    let timerId: ReturnType<typeof setInterval> | null = null;
    let wasHidden = false;

    const start = () => {
      if (timerId !== null) return;
      timerId = setInterval(() => cbRef.current(), intervalMs);
    };
    const stop = () => {
      if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        if (wasHidden) cbRef.current();
        wasHidden = false;
        start();
      } else {
        wasHidden = true;
        stop();
      }
    };

    if (document.visibilityState === "visible") {
      start();
    }

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [intervalMs]);
}
