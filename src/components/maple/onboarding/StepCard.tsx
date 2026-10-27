"use client";

import { STEPS, STEP_TITLES, type OnboardingView, type StepId } from "@/lib/maple/onboarding/steps";
import { Button, cx, tone } from "../ui";
import { BabyNameStep, BirthStep, FeedingStep, PediatricianStep, SexStep, TimezoneStep, WelcomeStep, YouStep } from "./BasicSteps";
import { savedLine } from "./describe";
import { CareStep, InvitesStep, NotificationsStep } from "./MoreSteps";
import type { Onboarding } from "./useOnboarding";

/** The card for one question; `key` it by step so a new question starts from its own saved values. */
export function StepCard({ step, ob, careConsent }: { step: StepId; ob: Onboarding; careConsent?: boolean }) {
  const props = { ob, view: ob.view };
  switch (step) {
    case "welcome":
      return <WelcomeStep {...props} />;
    case "you":
      return <YouStep {...props} />;
    case "timezone":
      return <TimezoneStep {...props} />;
    case "baby_name":
      return <BabyNameStep {...props} />;
    case "birth":
      return <BirthStep {...props} />;
    case "sex":
      return <SexStep {...props} />;
    case "feeding":
      return <FeedingStep {...props} />;
    case "invites":
      return <InvitesStep {...props} />;
    case "care":
      return <CareStep {...props} consent={careConsent} />;
    case "pediatrician":
      return <PediatricianStep {...props} />;
    case "notifications":
      return <NotificationsStep {...props} />;
  }
}

export function Summary({ view, ob, onEdit, onStart }: { view: OnboardingView; ob: Onboarding; onEdit: (step: StepId) => void; onStart: () => void }) {
  const rows = STEPS.filter((s) => s !== "welcome");
  return (
    <section aria-labelledby="onb-summary" className={cx(tone.card, "space-y-3 p-4")}>
      <h2 id="onb-summary" className={cx(tone.heading, "text-[18px]")}>
        Check it over
      </h2>
      <div className={cx(tone.inset, tone.divide, "overflow-hidden")}>
        {rows.map((s) => {
          const line = savedLine(view, s);
          const needed = view.missing.includes(s);
          return (
            <div key={s} className="flex min-h-[52px] items-center gap-3 px-3.5 py-2">
              <div className="min-w-0 flex-1">
                <p className={cx(tone.label)}>{STEP_TITLES[s]}</p>
                <p className={cx(needed ? "text-mp-danger" : tone.body, "text-[15px] leading-snug wrap-anywhere")}>{line ?? (needed ? "Needed" : "Not answered")}</p>
              </div>
              <button type="button" onClick={() => onEdit(s)} className="min-h-[44px] rounded-xl px-2.5 text-[15px] font-semibold text-mp-accent-fg">
                {line ? "Edit" : "Answer"}
              </button>
            </div>
          );
        })}
      </div>
      {ob.problem && (
        <p role="alert" className="text-[14px] leading-snug text-mp-danger">
          {ob.problem}
        </p>
      )}
      <Button className="w-full" size="lg" disabled={!view.canFinish || ob.busy} onClick={onStart}>
        {ob.busy ? "Starting…" : "Start logging"}
      </Button>
      {!view.canFinish && <p className={cx(tone.muted, "text-center text-[13px]")}>Answer what&apos;s marked Needed first.</p>}
    </section>
  );
}

export function SavedAnswers({ view, onEdit }: { view: OnboardingView; onEdit: (step: StepId) => void }) {
  const rows = STEPS.filter((s) => s !== "welcome" && savedLine(view, s));
  return (
    <details className={cx(tone.inset, "px-3.5 py-2.5")}>
      <summary className={cx(tone.body, "cursor-pointer text-[14px] font-medium")}>Your saved answers</summary>
      <div className="mt-2 space-y-1">
        {rows.map((s) => (
          <div key={s} className="flex items-center gap-3">
            <p className={cx(tone.muted, "min-w-0 flex-1 text-[14px] leading-snug")}><span className="font-medium">{STEP_TITLES[s]}:</span> {savedLine(view, s)}</p>
            <button type="button" onClick={() => onEdit(s)} aria-label={`Edit ${STEP_TITLES[s].toLowerCase()}`} className="min-h-[44px] px-2 text-[14px] font-semibold text-mp-accent-fg">Edit</button>
          </div>
        ))}
      </div>
    </details>
  );
}
