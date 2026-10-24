"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import type { Celebration } from "@/lib/maple/insights";
import { DEFAULT_TZ, dayKey } from "@/lib/maple/time";
import { MAPLE_LEAF_PATH } from "./Hero";
import { Icon } from "./icons";
import { LeafMark, ageShort, keptDate } from "./keepsake";
import { useNightActive } from "./nightLook";
import { useSheets } from "./sheets";
import { Button, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

/**
 * Milestones ("One whole week of Maple", "100 diapers") once each, per person.
 * A milestone reached at 3am waits for the morning: celebrations only show by
 * day, with a few maple leaves drifting down inside the card (a still card
 * under reduced motion or the night look). The card is the fact, plainly: the
 * leaf (kept), the title, the day it happened and, when whoever logged it
 * wrote something, their words. "Keep as a moment" turns it into a keepsake.
 */

const LEAF_COLORS = ["#B5452B", "#D9772B", "#E0A93B", "#C49A3C"];
const seenKey = (me: string) => `maple-celebrated:${me}`;

/** The milestone id a kept moment carries (see milestones.ts): "monthly-2" stays, otherwise the celebration id. */
const milestoneId = (c: Celebration) => (c.milestone && /^[a-z0-9-]+$/.test(c.milestone) ? c.milestone : c.id);

/** Her age is the title of these ("One whole week of Maple", "2 months old today"): their date line skips it. */
const AGE_TITLED = /^(born|week-\d+|month-\d+|day-100)$/;

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

/** A handful of leaves falling once through the card (clipped to it), then gone. */
function CardLeaves({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onDone, 3000);
    return () => window.clearTimeout(t);
  }, [onDone]);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {Array.from({ length: 8 }, (_, i) => {
        const size = 12 + rand(i, 3) * 8;
        return (
          <motion.svg
            key={i}
            viewBox="-11 -11 22 22"
            width={size}
            height={size}
            className="absolute -top-5"
            style={{ left: `${6 + rand(i, 1) * 88}%` }}
            initial={{ y: 0, x: 0, rotate: 0, opacity: 0 }}
            animate={{ y: 230, x: (rand(i, 2) - 0.5) * 50, rotate: (rand(i, 4) - 0.5) * 360, opacity: [0, 0.85, 0.85, 0] }}
            transition={{ duration: 2.2, delay: rand(i, 5) * 0.5, ease: "easeIn" }}
          >
            <path d={MAPLE_LEAF_PATH} fill={LEAF_COLORS[i % LEAF_COLORS.length]} />
          </motion.svg>
        );
      })}
    </div>
  );
}

export default function Celebrations() {
  const { state, summary, isNight, readOnly, memberName, now } = useMaple();
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

  // "Day 4 · Fri, Oct 23", and the words whoever logged it wrote on that entry ("Lifted her head for a second!").
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const bornAt = state?.baby.born_at ?? null;
  const dated = current
    ? [!AGE_TITLED.test(current.id) && ageShort(bornAt, current.reachedAt, tz), keptDate(dayKey(new Date(current.reachedAt), tz), dayKey(now(), tz))]
        .filter(Boolean)
        .join(" · ")
    : "";
  const source = current?.entryId != null ? state?.entries.find((e) => e.id === current.entryId) : undefined;
  const said = source?.note?.trim() ? { note: source.note.trim(), created_by: source.created_by } : null;

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
    <AnimatePresence>
      {current && (
        <motion.section
          key={current.id}
          initial={{ opacity: 0, y: 10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, height: 0, marginTop: 0, paddingTop: 0, paddingBottom: 0 }}
          aria-live="polite"
          className={cx(tone.card, "relative overflow-hidden p-4")}
        >
          {falling === current.id && <CardLeaves key={falling} onDone={endFall} />}
          <div className="relative flex items-start gap-3">
            <LeafMark size={26} className="mt-px" />
            <div className="min-w-0 flex-1">
              <h2 className={cx(tone.heading, "text-[17px] leading-snug")}>{current.title}</h2>
              <p className="mt-0.5 text-[13px] text-mp-ink-2 tabular-nums">{dated}</p>
              {said && (
                <>
                  <p className={cx(tone.display, "mt-2 line-clamp-4 text-[20px] leading-snug italic")}>“{said.note}”</p>
                  <p className="mt-0.5 text-[12px] text-mp-ink-2">{memberName(said.created_by)}</p>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => markSeen(current.id)}
              aria-label="Dismiss"
              className="-mt-2 -mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-mp-ink-3 active:bg-mp-ink/5"
            >
              <Icon name="x" size={20} />
            </button>
          </div>
          {/* Her first poop is worth a cheer, not a keepsake. */}
          {!readOnly && current.id !== "first-poop" && (
            <div className="relative mt-3 pl-[38px]">
              <Button
                variant="soft"
                onClick={() => {
                  markSeen(current.id);
                  open({ kind: "moment", preset: { title: current.title, milestone: milestoneId(current), ...(said ? { note: said.note } : {}) } });
                }}
              >
                <Icon name="camera" size={18} />
                Keep as a moment
              </Button>
            </div>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
}
