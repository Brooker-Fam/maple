"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { STEPS, type OnboardingView, type StepId } from "@/lib/maple/onboarding/steps";
import { Button, Segmented, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { InviteLinks } from "./MoreSteps";
import { StepCard, Summary } from "./StepCard";
import { useOnboarding } from "./useOnboarding";

const OnboardingChat = dynamic(() => import("./OnboardingChat"), { ssr: false });

/**
 * A new family's setup, in place of the app until "Start logging": the next
 * question's card (the scripted spine, which works with the chat off), the
 * chat under it for answers in their own words, and the summary. Someone who
 * left comes back at the server's next question. Anyone but the owner who
 * started it waits for them.
 */
export default function Onboarding({ initial, onDone }: { initial: OnboardingView; onDone: () => void }) {
  const ob = useOnboarding(initial);
  const { online } = useMaple();
  const [mode, setMode] = useState<"chat" | "form">("chat");
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<StepId | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [careConsent, setCareConsent] = useState(false);
  const view = ob.view;

  if (!view.owner) return <Waiting ob={ob} onDone={onDone} />;

  const answered = STEPS.filter((s) => view.done[s]).length;
  const step = editing ?? (reviewing ? null : view.next);
  const edit = (s: StepId) => {
    ob.clearProblem();
    setCareConsent(false);
    setEditing(s);
  };
  const wrapped = {
    ...ob,
    answer: async (s: StepId, value: unknown) => {
      const saved = await ob.answer(s, value);
      if (saved && editing === s) setEditing(null);
      if (saved && s === "care") setCareConsent(false);
      return saved;
    },
    skip: async (s: StepId) => {
      const saved = await ob.skip(s);
      if (saved && editing === s) setEditing(null);
      return saved;
    },
  };
  const start = async () => {
    if (await ob.finish()) onDone();
  };
  const chatOn = mode === "chat" && online && view.done.welcome === "answered";

  return (
    <div className="mx-auto min-h-[100dvh] w-full max-w-lg space-y-4 px-4 pt-[calc(env(safe-area-inset-top)+20px)] pb-[calc(env(safe-area-inset-bottom)+32px)]">
      <header className="space-y-3">
        <h1 className={cx(tone.display, "text-[28px] leading-tight")}>Set up your log</h1>
        <div className="h-1.5 overflow-hidden rounded-full bg-mp-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={STEPS.length} aria-valuenow={answered} aria-label="Setup progress">
          <div className="h-full rounded-full bg-mp-accent transition-all" style={{ width: `${Math.round((answered / STEPS.length) * 100)}%` }} />
        </div>
        {view.done.welcome === "answered" && (
          <Segmented
            aria-label="How to answer"
            value={mode}
            onChange={(m) => {
              setNote(null);
              setMode(m);
            }}
            options={[
              { value: "chat", label: "Questions and chat" },
              { value: "form", label: "Just the questions" },
            ]}
          />
        )}
        {note && <p className={cx(tone.inset, "px-3.5 py-3 text-[14px] leading-snug text-mp-ink")}>{note}</p>}
      </header>

      <InviteLinks links={ob.links} />

      {step ? (
        <>
          <StepCard key={`${step}-${careConsent}`} step={step} ob={wrapped} careConsent={step === "care" && careConsent} />
          {editing && (
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
              Back
            </Button>
          )}
          {!editing && view.canFinish && (
            <Button variant="ghost" size="sm" onClick={() => setReviewing(true)}>
              Review and start logging
            </Button>
          )}
        </>
      ) : (
        <Summary view={view} ob={ob} onEdit={edit} onStart={() => void start()} />
      )}

      {chatOn && (
        <OnboardingChat
          ob={wrapped}
          onCare={() => {
            setCareConsent(true);
            setEditing("care");
          }}
          onReview={() => {
            setEditing(null);
            setReviewing(true);
          }}
          onFallback={(why) => {
            setMode("form");
            setNote(why || null);
          }}
        />
      )}
    </div>
  );
}

function Waiting({ ob, onDone }: { ob: ReturnType<typeof useOnboarding>; onDone: () => void }) {
  const [checking, setChecking] = useState(false);
  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-lg flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className={cx(tone.display, "text-[26px]")}>Almost ready</h1>
      <p className={cx(tone.muted, "text-[16px] leading-relaxed")}>The person who started this log is still setting it up. It opens here as soon as they&apos;re done.</p>
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
