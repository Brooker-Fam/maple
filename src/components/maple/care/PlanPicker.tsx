"use client";

import { useState } from "react";
import { Icon, KindBadge } from "../icons";
import { CARE_COLOR } from "../palette";
import { EmptyState, Sheet, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { useCareNav } from "./CareNav";
import MedPlanSheet from "./MedPlanSheet";
import { GROUP, NavRow, TookItButton, errorText } from "./parts";
import { useCare } from "./useCare";

/**
 * "{Name}'s medicine" / "My medicine" (§11.3): each active plan's compact line
 * with a trailing "Took it"; a row opens its Dose sheet. Then "Something
 * else" and "Add a medicine".
 *
 * The picker is a launcher, so it closes on the way to anything else: a
 * saved "Took it" leaves its toast on the screen underneath, and an ask
 * opens the Dose sheet with the reason on top.
 */
export type PlanPickerProps = { open: boolean; onClose: () => void };

export default function PlanPicker({ open, onClose }: PlanPickerProps) {
  const care = useCare();
  const nav = useCareNav();
  const { toast } = useMaple();
  const [busy, setBusy] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  if (!care) return null;

  // Let this sheet start closing before the next one opens (as More does).
  const then = (fn: () => void) => {
    onClose();
    window.setTimeout(fn, 120);
  };
  const took = async (planId: number) => {
    if (busy) return;
    setBusy(planId);
    try {
      const r = await care.act.tookIt(planId);
      if (r === "saved") onClose();
      else then(() => nav.openDose(planId, r.ask));
    } catch (e) {
      toast(errorText(e), { tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Sheet open={open && !adding} onClose={onClose} title={care.self ? "My medicine" : `${care.name}'s medicine`}>
        {care.plans.length ? (
          <div className={GROUP}>
            {care.plans.map((v) => (
              <div key={v.plan.id} className="flex items-center gap-1 pr-3">
                <button
                  type="button"
                  onClick={() => then(() => nav.openDose(v.plan.id))}
                  className={cx(tone.row, "min-h-[56px] min-w-0 flex-1 py-2.5 pr-1")}
                >
                  <KindBadge icon="pill" color={CARE_COLOR} size={28} />
                  <span className="min-w-0 flex-1 text-[15px] leading-snug text-mp-ink-2 tabular-nums">{v.line}</span>
                </button>
                {care.access.write && <TookItButton busy={busy === v.plan.id} onClick={() => void took(v.plan.id)} />}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon="pill" title="No medicines yet">
            Add each one from the label or discharge papers. Maple&apos;s Log keeps time against that schedule; it never suggests a dose.
          </EmptyState>
        )}
        {care.access.write && (
          <div className={GROUP}>
            <NavRow icon="plus" accent label="Something else" note="A one-time medicine" onClick={() => then(() => nav.openOneOff())} />
            <NavRow icon="pill" accent label="Add a medicine" onClick={() => setAdding(true)} chevron={false} />
          </div>
        )}
        <button type="button" onClick={() => then(() => nav.openCare())} className={cx(tone.faint, "mx-auto flex min-h-[44px] items-center gap-1 text-[13px]")}>
          {care.self ? "Your medicines and recovery" : `${care.name}'s medicines and recovery`}
          <Icon name="chevron-right" size={14} />
        </button>
      </Sheet>
      <MedPlanSheet open={open && adding} onClose={() => setAdding(false)} care={care} />
    </>
  );
}
