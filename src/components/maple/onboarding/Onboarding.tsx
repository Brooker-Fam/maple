"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import { STEPS, type OnboardingView, type StepId } from "@/lib/maple/onboarding/steps";
import { Button, Segmented, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { finishSetup } from "./actions";
import { answerLine, savedLine } from "./describe";
import { InviteLinks } from "./MoreSteps";
import { SetupPage } from "./SetupPage";
import { SavedAnswers, StepCard, Summary } from "./StepCard";
import { useOnboarding } from "./useOnboarding";
import { useAnswerMode } from "./useAnswerMode";
import { AnswerDraftContext } from "./StepShell";

const OnboardingChat = lazy(() => import("./OnboardingChat"));

/**
 * A new family's setup, as the Chat page in place of the app until "Start
 * logging": the chat for answers in their own words, then the next
 * question's card (the scripted spine, which works with the chat off) or the
 * summary, newest at the bottom like any chat. "Just the questions", or the
 * chat being unavailable, leaves the same page with the card alone. Someone
 * who left comes back at the server's next question. Anyone but the owner
 * who started it waits for them.
 */
export default function Onboarding({ initial, onDone }: { initial: OnboardingView; onDone: (notifications: boolean) => void }) {
  const ob = useOnboarding(initial);
  const { online } = useMaple();
  const [acknowledgment, setAcknowledgment] = useState<string | null>(null);
  const { mode, chooseMode, fallbackToForm } = useAnswerMode(initial.familyId);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<StepId | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [careConsent, setCareConsent] = useState(false);
  const view = ob.view;
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  if (!view.owner) return <Waiting ob={ob} onDone={() => onDone(false)} />;

  const answered = STEPS.filter((s) => view.done[s]).length;
  const step = editing ?? (reviewing ? null : view.next);
  const discard = () => !dirty || window.confirm("Discard your unsaved answer? Your saved answers will stay.");
  const edit = (s: StepId) => {
    if (s === step || !discard()) return;
    setDirty(false);
    ob.clearProblem();
    setCareConsent(false);
    setEditing(s);
  };
  const wrapped = {
    ...ob,
    answer: async (s: StepId, value: unknown) => {
      const saved = await ob.answer(s, value);
      if (saved) {
        if (s === step) setDirty(false);
        setAcknowledgment(`Saved: ${answerLine(s, value)}.`);
      }
      if (saved && editing === s) setEditing(null);
      if (saved && s === "care") setCareConsent(false);
      return saved;
    },
    skip: async (s: StepId) => {
      if (s === step && !discard()) return false;
      const saved = await ob.skip(s);
      if (saved) {
        if (s === step) setDirty(false);
        setAcknowledgment("Skipped for now. You can come back to it.");
      }
      if (saved && editing === s) setEditing(null);
      return saved;
    },
  };
  const review = () => {
    if (!discard()) return;
    setDirty(false);
    setEditing(null);
    setReviewing(true);
  };
  const back = () => {
    if (!discard()) return;
    setDirty(false);
    setEditing(null);
  };
  const start = () => finishSetup(ob.finish, onDone, view.values.notifications === true);
  const chatOn = mode === "chat" && online && view.done.welcome === "answered";

  const header = (
    <>
      <h1 className={cx(tone.display, "flex min-h-[44px] items-center text-[34px] leading-[1.05]")}>Chat</h1>
      <div className="flex items-center gap-3">
        <p className={cx(tone.muted, "shrink-0 text-[14px]")}>Set up your log</p>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-mp-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={STEPS.length} aria-valuenow={answered} aria-label="Setup progress">
          <div className="h-full rounded-full bg-mp-accent transition-all" style={{ width: `${Math.round((answered / STEPS.length) * 100)}%` }} />
        </div>
      </div>
      {view.done.welcome === "answered" && (
        <Segmented
          aria-label="How to answer"
          value={mode}
          onChange={(m) => {
            setNote(null);
            chooseMode(m);
          }}
          options={[
            { value: "chat", label: "Questions and chat" },
            { value: "form", label: "Just the questions" },
          ]}
        />
      )}
      {note && <p className={cx(tone.inset, "px-3.5 py-3 text-[14px] leading-snug text-mp-ink")}>{note}</p>}
    </>
  );

  return (
    <AnswerDraftContext.Provider value={setDirty}>
      <SetupPage header={header}>
        {chatOn && (
          <Suspense fallback={null}>
            <OnboardingChat
              ob={wrapped}
              onCare={() => {
                if (!discard()) return;
                setDirty(false);
                setCareConsent(true);
                setEditing("care");
              }}
              onReview={review}
              onDecline={() => chooseMode("form")}
              onFallback={(why) => {
                fallbackToForm();
                setNote(why || null);
              }}
            />
          </Suspense>
        )}

        <InviteLinks links={ob.links} />

        {step && STEPS.some((s) => s !== "welcome" && savedLine(view, s)) && <SavedAnswers view={view} onEdit={edit} />}
        {step && (acknowledgment || answered > 1) && <p role="status" className={cx(tone.muted, "px-1 text-[14px] leading-snug")}>{acknowledgment ?? "Your confirmed answers are saved. Pick up here."}</p>}

        {step ? (
          <>
            <StepCard key={`${step}-${careConsent}`} step={step} ob={wrapped} careConsent={step === "care" && careConsent} />
            {editing && (
              <Button variant="ghost" size="sm" className="self-start" onClick={back}>
                Back
              </Button>
            )}
            {!editing && view.canFinish && (
              <Button variant="ghost" size="sm" className="self-start" onClick={review}>
                Review and start logging
              </Button>
            )}
          </>
        ) : (
          <Summary view={view} ob={ob} onEdit={edit} onStart={() => void start()} />
        )}
      </SetupPage>
    </AnswerDraftContext.Provider>
  );
}

function Waiting({ ob, onDone }: { ob: ReturnType<typeof useOnboarding>; onDone: () => void }) {
  const [checking, setChecking] = useState(false);
  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-lg flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className={cx(tone.display, "text-[26px]")}>Almost ready</h1>
      <p className={cx(tone.muted, "text-[16px] leading-relaxed")}>The person who started this log is still setting it up. Check again when they&apos;re done.</p>
      {ob.problem && <p role="alert" className={cx(tone.body, "text-[15px] leading-relaxed text-mp-danger")}>{ob.problem}</p>}
      <Button
        variant="soft"
        disabled={checking}
        onClick={async () => {
          setChecking(true);
          const needed = await ob.reload();
          setChecking(false);
          if (!needed) onDone();
        }}
      >
        {checking ? "Checking…" : "Check again"}
      </Button>
    </div>
  );
}
