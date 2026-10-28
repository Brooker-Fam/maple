"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";
import { skippable, type StepId } from "@/lib/maple/onboarding/steps";
import { Button, cx, tone } from "../ui";
import type { Onboarding } from "./useOnboarding";
import { useDraftChanged } from "../useDraftChanged";

export const AnswerDraftContext = createContext<(dirty: boolean) => void>(() => {});

const QUESTIONS: Record<StepId, string> = {
  welcome: "Before getting started",
  you: "What should the log call you?",
  timezone: "Which clock and units should the log use?",
  baby_name: "What is your baby's name?",
  birth: "Is your baby here or still on the way?",
  sex: "Which growth chart should the log use?",
  feeding: "How are you feeding your baby?",
  invites: "Who else will use the log?",
  care: "Would a recovery page help?",
  pediatrician: "Who is your baby's pediatrician?",
  notifications: "Would you like notifications on this phone?",
};

export const WHY: Record<StepId, string> = {
  welcome: "Maple is a tracker, not medical advice.",
  you: "So the log can say who logged what.",
  timezone: "So \"today\" and every time in the log match your home's clock.",
  baby_name: "You can change it any time in Settings → Baby details.",
  birth: "The baby's age decides which guidance applies. The time can be rough.",
  sex: "Only to pick the WHO growth chart. Skip it and the chart shows no percentiles.",
  feeding: "This only decides which buttons show. Nothing you log is ever hidden.",
  invites: "Each person gets a one-time link that works for 7 days. You send it yourself.",
  care: "Medicines, temperature and questions for the OB, kept apart from the baby's log.",
  pediatrician: "For the Help sheet and the call buttons beside warnings.",
  notifications: "Medicine reminders for the recovery page and an optional feeding timer on the lock screen. Nothing else notifies.",
};

export function StepShell({
  step,
  ob,
  children,
  onSave,
  canSave = true,
  saveLabel = "Save",
  hideSave,
  noSkip,
  draft,
}: {
  step: StepId;
  ob: Onboarding;
  children: ReactNode;
  onSave: () => void;
  canSave?: boolean;
  saveLabel?: string;
  hideSave?: boolean;
  noSkip?: boolean;
  draft?: unknown;
}) {
  const changed = useDraftChanged(draft);
  const register = useContext(AnswerDraftContext);
  useEffect(() => {
    register(changed);
    return () => register(false);
  }, [changed, register]);
  return (
    <section aria-labelledby={`onb-${step}`} className={cx(tone.card, "space-y-4 p-4")}>
      <div className="space-y-1">
        <h2 id={`onb-${step}`} className={cx(tone.heading, "text-[18px]")}>
          {QUESTIONS[step]}
        </h2>
        <p className={cx(tone.muted, "text-[14px] leading-snug")}>{WHY[step]}</p>
      </div>
      {children}
      {ob.problem && (
        <p role="alert" className="text-[14px] leading-snug text-mp-danger">
          {ob.problem}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!hideSave && (
          <Button onClick={onSave} disabled={!canSave || ob.busy} className="min-w-[120px]">
            {ob.busy ? "Saving…" : saveLabel}
          </Button>
        )}
        {skippable(step) && !noSkip && (
          <Button variant="ghost" onClick={() => void ob.skip(step)} disabled={ob.busy}>
            Skip for now
          </Button>
        )}
      </div>
    </section>
  );
}

export function TextInput({ label, value, onChange, placeholder, type = "text", autoComplete, max }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: "text" | "tel" | "date" | "time"; autoComplete?: string; max?: string }) {
  return (
    <label className="block space-y-1.5">
      <span className={tone.label}>{label}</span>
      <input
        type={type}
        value={value}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className={tone.input}
      />
    </label>
  );
}
