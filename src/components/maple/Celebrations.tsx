"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import type { Celebration } from "@/lib/maple/insights";
import { MAPLE_LEAF_PATH } from "./Hero";
import { useNightActive } from "./nightLook";
import { useSheets } from "./sheets";
import { cx, tone } from "./ui";
import { useMaple } from "./useMaple";

/**
 * Milestones ("One whole week of Maple", "Diaper #100") once each, per person.
 * A milestone reached at 3am waits for the morning: celebrations only show by
 * day, with a short fall of maple leaves (a still card under reduced motion or
 * the night look). "Keep as a moment" turns it into a keepsake.
 */

const LEAF_COLORS = ["#B5452B", "#D9772B", "#E0A93B", "#C49A3C"];
const seenKey = (me: string) => `maple-celebrated:${me}`;

/** The milestone id a kept moment carries (see milestones.ts): "monthly-2" stays, otherwise the celebration id. */
const milestoneId = (c: Celebration) => (c.milestone && /^[a-z0-9-]+$/.test(c.milestone) ? c.milestone : c.id);

function readSeen(me: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(seenKey(me)) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Deterministic scatter so the leaves don't reshuffle on re-render.
const rand = (i: number, salt: number) => {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

function LeafFall({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onDone, 3200);
    return () => window.clearTimeout(t);
  }, [onDone]);
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[95] overflow-hidden [.maple-night_&]:hidden">
      {Array.from({ length: 18 }, (_, i) => {
        const left = rand(i, 1) * 100;
        const drift = (rand(i, 2) - 0.5) * 120;
        const size = 14 + rand(i, 3) * 14;
        const spin = (rand(i, 4) - 0.5) * 540;
        return (
          <motion.svg
            key={i}
            viewBox="-11 -11 22 22"
            width={size}
            height={size}
            className="absolute -top-8"
            style={{ left: `${left}%` }}
            initial={{ y: -40, x: 0, rotate: 0, opacity: 0 }}
            animate={{ y: "105vh", x: drift, rotate: spin, opacity: [0, 1, 1, 0.8] }}
            transition={{ duration: 2.5, delay: rand(i, 5) * 0.6, ease: "easeIn" }}
          >
            <path d={MAPLE_LEAF_PATH} fill={LEAF_COLORS[i % LEAF_COLORS.length]} />
          </motion.svg>
        );
      })}
    </div>
  );
}

export default function Celebrations() {
  const { state, summary, isNight, readOnly } = useMaple();
  const { open } = useSheets();
  const reduce = useReducedMotion();
  const nightLook = useNightActive();
  const me = state?.me.email ?? "";
  const [seen, setSeen] = useState<string[] | null>(null);
  const [falling, setFalling] = useState<string | null>(null);
  const [played, setPlayed] = useState<string[]>([]);
  const endFall = useCallback(() => setFalling(null), []);

  useEffect(() => {
    if (me) setSeen(readSeen(me));
  }, [me]);

  // Already kept as a moment (by anyone, or by the birth form's "Hello, world")? Nothing to celebrate twice.
  const kept = new Set(state?.entries.flatMap((e) => (e.kind === "moment" && e.data.milestone ? [e.data.milestone] : [])) ?? []);
  // Never celebrate on top of an urgent alert.
  const urgent = summary?.alerts.some((a) => a.tier === "emergency" || a.tier === "now");
  const current: Celebration | null =
    seen && summary && !urgent && !isNight() && !nightLook ? summary.celebrations.find((c) => !seen.includes(c.id) && !kept.has(milestoneId(c))) ?? null : null;

  // One leaf-fall per celebration per visit.
  useEffect(() => {
    if (!current || reduce || played.includes(current.id)) return;
    setPlayed((p) => [...p, current.id]);
    setFalling(current.id);
  }, [current, played, reduce]);

  const markSeen = (id: string) => {
    const next = [...new Set([...(seen ?? []), ...readSeen(me), id])].slice(-200);
    setSeen(next);
    try {
      localStorage.setItem(seenKey(me), JSON.stringify(next));
    } catch {
      // storage blocked: it'll show again next visit
    }
  };

  return (
    <>
      <AnimatePresence>
        {current && (
          <motion.section
            key={current.id}
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, height: 0, marginTop: 0, paddingTop: 0, paddingBottom: 0 }}
            aria-live="polite"
            className={cx(
              tone.card,
              "relative overflow-hidden border-[#C49A3C]/35 bg-gradient-to-br from-[#FFF6E5] to-[#FBE9DA] p-4 dark:from-[#2A2214] dark:to-[#2A1A14]"
            )}
          >
            <svg aria-hidden viewBox="-11 -11 22 22" className="pointer-events-none absolute -top-3 -right-3 h-20 w-20 rotate-12 opacity-15">
              <path d={MAPLE_LEAF_PATH} fill="#B5452B" />
            </svg>
            <div className="relative flex items-start gap-3">
              <span aria-hidden className="text-3xl leading-none">
                {current.emoji}
              </span>
              <div className="min-w-0 flex-1">
                <p className={cx(tone.label, "text-[#B5452B] dark:text-[#E0A93B]")}>A little celebration</p>
                <h2 className={cx(tone.heading, "mt-0.5 text-[22px] leading-tight")}>{current.title}</h2>
              </div>
              <button
                type="button"
                onClick={() => markSeen(current.id)}
                aria-label="Dismiss"
                className={cx(tone.muted, "-mt-1 -mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-lg hover:bg-[#1D4420]/5")}
              >
                ✕
              </button>
            </div>
            {!readOnly && (
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    markSeen(current.id);
                    open({ kind: "moment", preset: { title: current.title, milestone: milestoneId(current) } });
                  }}
                  className="min-h-[44px] rounded-full bg-[#B5452B] px-4 text-[15px] font-semibold text-white active:scale-[0.97] dark:bg-[#E0A93B] dark:text-[#2A1A0A]"
                >
                  📷 Keep as a moment
                </button>
              </div>
            )}
          </motion.section>
        )}
      </AnimatePresence>
      {falling && <LeafFall key={falling} onDone={endFall} />}
    </>
  );
}
