"use client";

import { feedingPlanOf, planLines } from "@/lib/maple/feeding-plan";
import { feedTargetOf } from "@/lib/maple/units";
import { Sheet } from "../Sheet";
import { cx, tone } from "../ui";
import { useMaple } from "../useMaple";

/**
 * The feeding plan's sheet: the plan as saved (settings.feeding_plan), and
 * the form that adds or changes it. Opened with useFeedingPlanNav().openPlan()
 * from Today's Next feed card and from Settings. (A first version: the plan in
 * words, read-only.)
 */
export default function FeedingPlanSheet({ open, onClose }: { open: boolean; edit?: boolean; onClose: () => void }) {
  const { state } = useMaple();
  const plan = feedingPlanOf(state?.baby.settings);
  const target = feedTargetOf(state?.baby.settings);
  return (
    <Sheet open={open} onClose={onClose} title="Feeding plan">
      {plan ? (
        <ul className="space-y-2">
          {planLines(plan, target).map((line, i) => (
            <li key={i} className={cx(tone.body, "text-[15px] leading-snug")}>
              {line}
            </li>
          ))}
        </ul>
      ) : (
        <p className={cx(tone.muted, "text-[15px]")}>No feeding plan yet.</p>
      )}
    </Sheet>
  );
}
