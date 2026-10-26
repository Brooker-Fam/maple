"use client";

import { useEffect, useState } from "react";

// One start for every sample clock on the page, so a timer and the total beside it move together.
let started: number | null = null;

const FORMAT = {
  timer: (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`,
  minutes: (s: number) => `${Math.floor(s / 60)} min`,
  clock: (s: number) => `${Math.floor(s / 3600) % 12 || 12}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}`,
};

/** A sample reading that counts up from `from` seconds (a timer, a total, or a time of day); it holds still for anyone who asked for reduced motion. */
export default function Ticker({ from, format = "timer", className }: { from: number; format?: keyof typeof FORMAT; className?: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t0 = (started ??= Date.now());
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className={className} aria-hidden>
      {FORMAT[format](from + elapsed)}
    </span>
  );
}
