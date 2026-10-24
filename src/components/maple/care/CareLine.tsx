"use client";

import { useState } from "react";
import { KindBadge } from "../icons";
import { CARE_COLOR } from "../palette";
import { cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { useCareNav } from "./CareNav";
import { TookItButton, errorText } from "./parts";
import { useCare } from "./useCare";

/**
 * Mom's glanceable lines (§11.1), only for readers with a Show on Today plan
 * they can see, never an Only me one: the Today row inside StatusCard (badge,
 * the first plan's compact line, "+{n} more", "Took it") and the Lantern's
 * one dim, read-only line.
 */

/**
 * The Today row: at most 48px, so it stays above the dock on a small phone
 * with a feed running. The line is neutral ink in every state (it's a fact,
 * never an alert). Tapping it opens the picker, or the Dose sheet when this
 * is the only plan on Today; "Took it" saves at once only when nothing needs
 * asking (§5.2), else it opens the Dose sheet with the reason on top.
 */
export function CareTodayRow() {
  const care = useCare();
  const nav = useCareNav();
  const { toast } = useMaple();
  const [busy, setBusy] = useState(false);
  const line = care?.todayLine;
  if (!care || !line) return null;
  const { view, more } = line;
  const id = view.plan.id;

  const took = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await care.act.tookIt(id);
      if (r !== "saved") nav.openDose(id, r.ask);
    } catch (e) {
      toast(errorText(e), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-[48px] items-center gap-1 pr-4">
      <button
        type="button"
        onClick={() => (more ? nav.openPicker() : nav.openDose(id))}
        aria-label={`${care.self ? "Your" : `${care.name}'s`} medicine: ${view.line}${more ? `, and ${more} more` : ""}. Open ${more ? "the list" : "it"}.`}
        className={cx(tone.row, "min-h-[48px] min-w-0 flex-1 py-1.5 pr-1")}
      >
        <KindBadge icon="pill" color={CARE_COLOR} size={24} />
        {/* Two short lines fit the same 48px: on one, a phone shows only the name and the status is cut off. */}
        <span className="line-clamp-2 min-w-0 flex-1 text-[15px] leading-[18px] text-mp-ink-2 tabular-nums">{view.line}</span>
        {/* "+1" (the aria-label says "and 1 more"): "+1 more" would take the status's room. */}
        {more > 0 && <span className={cx(tone.faint, "shrink-0 text-[13px] tabular-nums")}>+{more}</span>}
      </button>
      {care.access.write && <TookItButton busy={busy} onClick={() => void took()} />}
    </div>
  );
}

/** The Lantern's line: the same compact line, dim amber like its "swipe down to close", no buttons, never Only me. */
export function CareLanternLine() {
  const care = useCare();
  const line = care?.lanternLine;
  if (!line) return null;
  return <p className="truncate text-[13px] tabular-nums opacity-50">{line}</p>;
}
