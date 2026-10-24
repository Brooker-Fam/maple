"use client";

import { useState } from "react";
import { type PlanView, unreviewed as needsReview } from "@/lib/maple/care";
import { Icon } from "../icons";
import { Button, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { useCareNav } from "./CareNav";
import OverLimitList from "./OverLimitList";
import { NoteCard, errorText, isOverLimit } from "./parts";
import type { UseCare } from "./useCare";

/**
 * One medicine on her screen (§11.2): the name, "As prescribed: …", her
 * schedule as she typed it, then the card sentence and meta lines in neutral
 * ink (never red, whatever the state), "Took it" and "Skipped", and the
 * notes. Tapping the top opens the plan detail; there's no hold gesture.
 *
 * "Took it" follows the one-tap contract (§5.2): it saves at once only when
 * the engine says so; otherwise the Dose sheet opens with the reason on top.
 */
export default function PlanCard({ view, care, onOpen, finished }: { view: PlanView; care: UseCare; onOpen: (planId: number) => void; finished?: boolean }) {
  const { now, toast } = useMaple();
  const nav = useCareNav();
  const [busy, setBusy] = useState<"took" | "skip" | "review" | null>(null);
  const { plan, status } = view;
  const write = care.access.write && !finished;
  const skippable = plan.schedule.type !== "as_needed";
  const unreviewed = needsReview(plan);

  const run = async (what: "took" | "skip" | "review", fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      toast(errorText(e), { tone: "error" });
    } finally {
      setBusy(null);
    }
  };
  const took = () =>
    run("took", async () => {
      const r = await care.act.tookIt(plan.id);
      if (r !== "saved") nav.openDose(plan.id, r.ask);
    });
  const skip = () =>
    run("skip", async () => {
      await care.act.logDose({ planId: plan.id, at: now().toISOString(), skipped: true });
    });

  return (
    <div className={cx(tone.card, "overflow-hidden")}>
      <button type="button" onClick={() => onOpen(plan.id)} className="block w-full px-4 pt-3.5 pb-3 text-left transition active:bg-mp-ink/[0.04]">
        <span className="flex items-start gap-2">
          <span className="min-w-0 flex-1">
            <span className={cx(tone.heading, "flex items-center gap-1.5 text-[17px] leading-snug")}>
              <span className="min-w-0 break-words">{plan.name}</span>
              {plan.private && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-mp-sunken px-2 py-0.5 text-[12px] font-medium text-mp-ink-2">
                  <Icon name="lock" size={12} strokeWidth={2} />
                  Only me
                </span>
              )}
            </span>
            {plan.dose_text && <span className={cx(tone.muted, "mt-0.5 block text-[14px] leading-snug")}>As prescribed: {plan.dose_text}</span>}
            <span className={cx(tone.faint, "mt-0.5 block text-[13px] leading-snug")}>{view.summary}</span>
            {plan.label_text && <span className={cx(tone.faint, "block text-[13px] leading-snug")}>Label: &ldquo;{plan.label_text}&rdquo;</span>}
          </span>
          <Icon name="chevron-right" size={18} className="mt-1 shrink-0 text-mp-ink-3" />
        </span>
        <span className="mt-2 block text-[15px] leading-snug text-mp-ink-2 tabular-nums">{view.sentence}</span>
        {view.meta.map((m) => (
          <span key={m} className="mt-0.5 block text-[13px] leading-snug text-mp-ink-2 tabular-nums">
            {m}
          </span>
        ))}
      </button>

      {unreviewed && (
        <div className="mx-4 mb-3 flex items-center gap-3 rounded-xl bg-mp-sunken px-3.5 py-2">
          <Icon name="circle-alert" size={18} className="shrink-0 text-mp-ink-2" />
          <span className={cx(tone.body, "min-w-0 flex-1 text-[14px] leading-snug")}>Check this against the label</span>
          {care.access.write && (
            <Button variant="ghost" size="sm" className="-mr-2 shrink-0" disabled={!!busy} onClick={() => run("review", () => care.act.reviewPlan(plan.id))}>
              Matches the label
            </Button>
          )}
        </div>
      )}

      {write && (
        <div className="flex items-center justify-end gap-2 px-4 pb-3.5">
          {skippable && (
            <Button variant="soft" size="sm" disabled={!!busy} onClick={skip}>
              Skipped
            </Button>
          )}
          <Button size="sm" className="min-w-[96px]" disabled={!!busy} onClick={took}>
            Took it
          </Button>
        </div>
      )}

      {view.notes.length > 0 && (
        <div className="space-y-3 px-4 pb-4">
          {view.notes.map((n) => (
            <div key={n.key}>
              <NoteCard note={n} care={care} />
              {isOverLimit(n) && <OverLimitList doses={status.window} plan={plan} care={care} className="mt-2" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
