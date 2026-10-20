"use client";

import { useState } from "react";
import { dayKey, daysBetween } from "@/lib/maple/time";
import BirthSheet from "./BirthSheet";
import { Fireflies, MapleLeaf, Sapling } from "./art";
import { Button, cx, tone } from "./ui";
import { useMaple, useNow } from "./useMaple";

/**
 * Today's hero before she's born: "Waiting for Maple 🍁", a sapling, and the
 * big "She's here!" button. Counts down to the due date, then just says
 * "Any day now" (never days past due: that's an anxious number for the
 * person carrying her). Logging is never gated on this; if entries already
 * exist, the hero asks for her birth time so Day 1 and her age come out right.
 */

function countdown(todayKey: string, due: string | null): string {
  if (!due) return "Any day now";
  const days = daysBetween(todayKey, due);
  if (days > 1) return `Due in ${days} days`;
  if (days === 1) return "Due tomorrow";
  return "Any day now";
}

export default function Waiting() {
  const { state, readOnly } = useMaple();
  const now = useNow(60_000);
  const [open, setOpen] = useState(false);
  if (!state) return null;

  const baby = state.baby;
  const name = baby.nickname || baby.name.split(" ")[0] || "Maple";
  const logging = state.entries.length > 0;
  const before = baby.due_date ? daysBetween(dayKey(now, baby.timezone), baby.due_date) > 0 : false;

  return (
    <div className="pt-[calc(env(safe-area-inset-top)+0.75rem)]">
      <section
        aria-label={`Waiting for ${name}`}
        className="relative overflow-hidden rounded-[32px] border border-[#C49A3C]/20 bg-gradient-to-b from-[#FFF4E2] via-[#FDF8F0] to-[#F4E8D6] px-5 pt-6 pb-5 text-center shadow-[0_2px_24px_rgba(196,154,60,0.12)] dark:border-[#C49A3C]/15 dark:from-[#18321D] dark:via-[#12261A] dark:to-[#0E1E12] dark:shadow-none"
      >
        <Fireflies count={6} />
        <div className="relative">
          <div className="mx-auto w-fit">
            <Sapling size={168} />
          </div>
          <h2 className={cx(tone.heading, "mt-1 text-[clamp(26px,8.4vw,34px)] leading-tight")}>
            Waiting for {name} <span aria-hidden>🍁</span>
          </h2>
          <p className="mt-1 font-[family-name:var(--font-display)] text-2xl font-semibold text-[#9A6B12] dark:text-[#E0C27A]">
            {countdown(dayKey(now, baby.timezone), baby.due_date)}
          </p>
          <p className={cx(tone.muted, "mx-auto mt-2 max-w-xs text-[15px] leading-relaxed")}>
            {readOnly
              ? "We'll share the news here the moment she arrives."
              : logging
                ? "Add her birth time so Day 1 and her age are right."
                : before
                  ? "Growing strong. The forest is getting ready."
                  : "The forest is holding its breath."}
          </p>
          {!readOnly && (
            <>
              <Button
                variant="gold"
                size="lg"
                className="mt-5 w-full text-lg shadow-[0_6px_20px_rgba(196,154,60,0.35)]"
                onClick={() => setOpen(true)}
              >
                She&apos;s here! <span aria-hidden>🍁</span>
              </Button>
              <p className={cx(tone.muted, "mt-2 text-xs")}>Just the time for now. Weight and length can wait.</p>
            </>
          )}
        </div>
      </section>
      {!readOnly && <BirthSheet open={open} onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * A slim prompt for when logging has started but born_at is still empty.
 * Renders nothing otherwise, so it's safe to drop anywhere on Today. (Waiting
 * already says the same thing in its hero; use this where Waiting isn't shown.)
 */
export function BirthBanner({ className }: { className?: string }) {
  const { state, readOnly } = useMaple();
  const [open, setOpen] = useState(false);
  if (!state || state.baby.born_at || readOnly || !state.entries.length) return null;
  return (
    <>
      <div
        role="status"
        className={cx(
          "flex items-center gap-3 rounded-2xl border border-[#C49A3C]/30 bg-[#C49A3C]/10 px-4 py-3 dark:border-[#C49A3C]/25 dark:bg-[#C49A3C]/10",
          className
        )}
      >
        <MapleLeaf size={28} veins={false} className="shrink-0" />
        <p className={cx(tone.body, "flex-1 text-sm leading-snug")}>Add her birth time so Day 1 and her age are right</p>
        <Button variant="gold" size="sm" onClick={() => setOpen(true)}>
          Add now
        </Button>
      </div>
      <BirthSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
