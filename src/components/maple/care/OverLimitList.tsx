"use client";

import { useState } from "react";
import type { CarePlan, DoseEntry } from "@/lib/maple/types";
import { cx, tone } from "../ui";
import { useDoseText } from "./parts";
import type { UseCare } from "./useCare";

/**
 * Under the over-limit card (§5.6, P8): the doses that make up the count,
 * "3:05 AM · 2 caplets · Matt", each with "This one's a mistake". A
 * duplicate entry is far likelier than a real extra dose, so fixing one is a
 * single tap: it soft-deletes that dose (Undo in the toast) and the count,
 * the card and this list recompute from the state.
 */
export default function OverLimitList({ doses, plan, care, className }: { doses: DoseEntry[]; plan: CarePlan; care: UseCare; className?: string }) {
  const text = useDoseText();
  const [busy, setBusy] = useState<number | null>(null);
  if (!doses.length) return null;
  return (
    <div className={cx(tone.inset, "px-4 py-2.5", className)}>
      <p className={cx(tone.label, "pt-0.5 pb-1")}>In the last 24 hours:</p>
      <ul className={tone.divide}>
        {doses.map((d) => (
          <li key={d.id} className="flex min-h-[48px] items-center gap-3 py-1">
            <span className={cx(tone.body, "min-w-0 flex-1 text-[14px] leading-snug tabular-nums")}>
              {text(d, plan)}
              {d.pending && <span className={tone.faint}> · on this phone, not synced</span>}
            </span>
            {care.access.write && d.id > 0 && (
              <button
                type="button"
                disabled={busy === d.id}
                onClick={async () => {
                  setBusy(d.id);
                  try {
                    await care.act.deleteEntry(d.id);
                  } finally {
                    setBusy(null);
                  }
                }}
                className="-mr-2 min-h-[44px] shrink-0 rounded-[10px] px-2 text-[14px] font-medium text-mp-accent-fg transition hover:bg-mp-ink/5 active:scale-[0.97] disabled:opacity-40"
              >
                This one&apos;s a mistake
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
