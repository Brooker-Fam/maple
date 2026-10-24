"use client";

import { useState } from "react";
import { dayKey, daysBetween } from "@/lib/maple/time";
import BirthSheet from "./BirthSheet";
import { MapleLeaf, Sapling } from "./art";
import { Button, cx, tone } from "./ui";
import { useMaple, useNow } from "./useMaple";

/**
 * Today's hero before she's born: "Waiting for Maple", a sapling, and the
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
    <div>
      <section aria-label={`Waiting for ${name}`} className={cx(tone.card, "px-5 pt-4 pb-5 text-center")}>
        <div className="mx-auto w-fit">
          <Sapling size={148} sway={false} />
        </div>
        <h1 className={cx(tone.display, "mt-1 text-[clamp(28px,8.4vw,34px)] leading-[1.05]")}>Waiting for {name}</h1>
        <p className="mt-2 text-[17px] font-semibold text-mp-maple">{countdown(dayKey(now, baby.timezone), baby.due_date)}</p>
        <p className="mx-auto mt-1.5 max-w-xs text-[15px] leading-relaxed text-mp-ink-2">
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
            <Button size="lg" className="mt-5 w-full" onClick={() => setOpen(true)}>
              She&apos;s here!
            </Button>
            <p className="mt-2 text-xs text-mp-ink-3">Just the time for now. Weight and length can wait.</p>
          </>
        )}
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
      <div role="status" className={cx(tone.card, "flex items-center gap-3 px-4 py-3", className)}>
        <MapleLeaf size={24} veins={false} className="shrink-0" />
        <p className="flex-1 text-sm leading-snug text-mp-ink">Add her birth time so Day 1 and her age are right</p>
        <Button size="sm" onClick={() => setOpen(true)}>
          Add now
        </Button>
      </div>
      <BirthSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
