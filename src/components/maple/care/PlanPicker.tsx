"use client";

import { useState } from "react";
import { planTitle } from "@/lib/maple/care";
import { KindBadge } from "../icons";
import { CARE_COLOR } from "../palette";
import { EmptyState, Sheet, cx, tone } from "../ui";
import { useCareNav } from "./CareNav";
import MedPlanSheet from "./MedPlanSheet";
import { Footnote, GROUP, GlanceMark, NavRow, PlanName, TookIt } from "./parts";
import { useCare } from "./useCare";

/**
 * "{Name}'s medicine" / "My medicine" (§11.3): every active plan, in a fixed
 * order (care.rows: her list's order, never re-sorted by status, so a save
 * can't move another medicine under the thumb), each with its glance and a
 * trailing Took it; a row opens its Dose sheet. Then "Something else", "Add
 * a medicine", the photo hint, and a full row to her page.
 *
 * The picker is a launcher, so it closes on the way to anything else: a
 * saved "Took it" leaves its toast on the screen underneath (and the strip
 * holds that medicine with "Logged 6:56 AM"), and an ask opens the Dose
 * sheet with the reason on top.
 */
export type PlanPickerProps = { open: boolean; onClose: () => void };

export default function PlanPicker({ open, onClose }: PlanPickerProps) {
  const care = useCare();
  const nav = useCareNav();
  const [adding, setAdding] = useState(false);
  if (!care) return null;

  // Let this sheet start closing before the next one opens (as More does).
  const then = (fn: () => void) => {
    onClose();
    window.setTimeout(fn, 120);
  };

  return (
    <>
      <Sheet open={open && !adding} onClose={onClose} title={care.self ? "My medicine" : `${care.name}'s medicine`}>
        {care.rows.length ? (
          <div className={GROUP}>
            {care.rows.map((v) => (
              <div key={v.plan.id} className="flex items-center gap-1 pr-3">
                <button
                  type="button"
                  onClick={() => then(() => nav.openDose(v.plan.id))}
                  aria-label={`${planTitle(v.plan)}: ${v.glance.text}. Open it.`}
                  className={cx(tone.row, "min-h-[56px] min-w-0 flex-1 py-2.5 pr-1")}
                >
                  <KindBadge icon="pill" color={CARE_COLOR} size={28} />
                  <span className="min-w-0 flex-1 leading-snug tabular-nums">
                    <PlanName plan={v.plan} className="text-[15px] text-mp-ink" />
                    {/* Two lines if it needs them: the time after "OK after" is never the part cut off. */}
                    <span className="mt-0.5 flex min-w-0 items-start gap-1 text-[13px] text-mp-ink-2">
                      <GlanceMark ready={v.glance.ready} size={13} className="mt-[3px]" />
                      <span className="line-clamp-2">{v.glance.text}</span>
                    </span>
                  </span>
                </button>
                <TookIt view={v} care={care} fixed onSaved={onClose} onAsk={(ask) => then(() => nav.openDose(v.plan.id, ask))} />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon="pill" title="No medicines yet">
            Add each one from the label or discharge papers. Maple&apos;s Log keeps time against that schedule; it never suggests a dose.
          </EmptyState>
        )}
        {care.access.write && (
          <div>
            <div className={GROUP}>
              <NavRow icon="plus" accent label="Something else" note="A one-time medicine" onClick={() => then(() => nav.openOneOff())} />
              <NavRow icon="pill" accent label="Add a medicine" onClick={() => setAdding(true)} chevron={false} />
            </div>
            <Footnote>Or photograph the discharge sheet and ask Claude to add them.</Footnote>
          </div>
        )}
        {/* Her page: a full row, not a faint link (the main way to her reminders, temperature and OB questions). */}
        <div className={GROUP}>
          <NavRow
            icon="heart"
            iconColor={CARE_COLOR}
            label={care.self ? "Your page" : `${care.name}'s page`}
            note={`Reminders, temperature and questions for ${care.self ? "your" : "her"} OB`}
            onClick={() => then(() => nav.openCare())}
          />
        </div>
      </Sheet>
      <MedPlanSheet open={open && adding} onClose={() => setAdding(false)} care={care} />
    </>
  );
}
