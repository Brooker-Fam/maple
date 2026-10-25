"use client";

import { useState } from "react";
import { notYet, planAlso, type PlanView } from "@/lib/maple/care";
import { Icon } from "../icons";
import { Button, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { useCareNav } from "./CareNav";
import OverLimitList from "./OverLimitList";
import { LoggedSlot, NoteCard, errorText, isOverLimit, tookItLabel } from "./parts";
import type { UseCare } from "./useCare";

/**
 * One medicine on her screen (§11.2): the name, "As prescribed: …", her
 * schedule as she typed it, then the card sentence and meta lines in neutral
 * ink (never red, whatever the state), "Took it" and "Skipped", and the
 * notes. Tapping the top opens the plan detail; there's no hold gesture.
 *
 * "Took it" follows the one-tap contract (§5.2): it saves at once, like
 * Maple's buttons, unless it's probably a dose someone already logged (or a
 * once-a-day one already logged today); then the Dose sheet asks. It wears
 * its quiet look while it isn't OK yet, and after a save on this phone the
 * buttons give way to "Logged 6:56 AM" for a minute: the cards re-sort by
 * status, so a second tap must not land on the card that moved up (taps
 * inside the cooldown after any care save do nothing either).
 */
export default function PlanCard({ view, care, onOpen, finished }: { view: PlanView; care: UseCare; onOpen: (planId: number) => void; finished?: boolean }) {
  const { now, toast } = useMaple();
  const nav = useCareNav();
  const [busy, setBusy] = useState<"took" | "skip" | null>(null);
  const { plan, status } = view;
  const write = care.access.write && !finished;
  const skippable = plan.schedule.type !== "as_needed";

  const held = care.held(plan.id);
  const also = planAlso(plan);

  const run = async (what: "took" | "skip", fn: () => Promise<void>) => {
    if (busy || care.coolingDown()) return;
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
      if (r !== "saved" && r !== "ignored") nav.openDose(plan.id, r.ask);
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
              <span className="min-w-0 break-words">
                {plan.name}
                {also && <span className="font-normal text-mp-ink-3"> ({also})</span>}
              </span>
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

      {write &&
        (held ? (
          <div className="flex items-center justify-end px-4 pb-3.5">
            <LoggedSlot held={held} />
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2 px-4 pb-3.5">
            {skippable && (
              <Button variant="soft" size="sm" disabled={!!busy} onClick={skip}>
                Skipped
              </Button>
            )}
            <Button
              variant={notYet(status) ? "soft" : "primary"}
              size="sm"
              className="min-w-[96px]"
              disabled={!!busy}
              onClick={took}
              aria-label={tookItLabel(care, plan)}
            >
              Took it
            </Button>
          </div>
        ))}

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
