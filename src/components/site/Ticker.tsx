"use client";

import { useEffect, useState } from "react";

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** A sample timer that counts up from `from` seconds; it holds still for anyone who asked for reduced motion. */
export default function Ticker({ from, className }: { from: number; className?: string }) {
  const [seconds, setSeconds] = useState(from);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const started = Date.now();
    const t = setInterval(() => setSeconds(from + Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [from]);
  return (
    <span className={className} aria-hidden>
      {clock(seconds)}
    </span>
  );
}
