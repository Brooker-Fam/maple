"use client";

import { useRef, useState } from "react";
import { scoreScreen } from "@/lib/maple/care";
import {
  DIFFICULTY,
  DIFFICULTY_Q,
  FREQ,
  FULL_INTRO,
  GAD7_ITEMS,
  GAD7_STEM,
  PHQ9_ITEMS,
  PHQ9_STEM,
  RESULTS_SUB,
} from "@/lib/maple/guidelines";
import { DEFAULT_TZ } from "@/lib/maple/time";
import type { MoodDataByKind, MoodEntry } from "@/lib/maple/types";
import { useOpenCount } from "../sheets/parts";
import { Button, Sheet, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { ScreenResults, resultsTitle, screenCopyText, useCopyForOb } from "./CheckInResults";
import CrisisSheet, { OnTop } from "./CrisisSheet";
import { Problem, errorText } from "./parts";
import { type UseCare, useCare } from "./useCare";

/**
 * The fuller check-in (§6.2): the PHQ-9, then the GAD-7, word for word from
 * the developers' forms (guidelines.ts), one question a screen with the four
 * answers as big buttons in the lower half, then the difficulty question
 * (only if any answer was above "Not at all") and the results. Hers only,
 * and never run by an assistant.
 *
 * Question 9 above "Not at all" opens the locked crisis sheet at once, over
 * the question: "Continue the check-in", "Stop here" (saves what she's
 * answered as unfinished) or "Back" (to question 9). Once that answer has
 * been given it's remembered (item9_ever) even if she changes it, so the
 * results still start with the crisis card. That answer is saved right
 * away (so today's help strip holds even if the app closes) and the same row
 * is updated after; otherwise it saves once, at the end. Leaving early keeps
 * nothing, unless question 9 was already saved: then what she answered stays,
 * as "Stop here" would keep it.
 */

type Answer = 0 | 1 | 2 | 3;
type Screen = MoodDataByKind["screen"];
type Step = { kind: "intro" } | { kind: "q"; i: number } | { kind: "difficulty" } | { kind: "results"; data: Screen; at: string };
type Answers = { phq9: Answer[]; gad7: Answer[]; difficulty: Answer | null };

const PHQ = PHQ9_ITEMS.length;
const TOTAL = PHQ + GAD7_ITEMS.length;
const ITEM9 = PHQ - 1;
/** After an answer moves her on, a second tap this soon is the same tap landing on the next question. */
const NEXT_HOLD_MS = 400;

export type FullCheckInProps = { open: boolean; onClose: () => void };

export default function FullCheckInSheet({ open, onClose }: FullCheckInProps) {
  const care = useCare();
  // A fresh check-in each time it opens.
  const n = useOpenCount(open);
  if (!care?.mood || !care.access.mood) return null;
  return <Flow key={n} open={open} onClose={onClose} care={care} />;
}

function Flow({ open, onClose, care }: FullCheckInProps & { care: UseCare }) {
  const { state, now } = useMaple();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const copyForOb = useCopyForOb();
  const [step, setStep] = useState<Step>({ kind: "intro" });
  const [phq9, setPhq9] = useState<Answer[]>([]);
  const [gad7, setGad7] = useState<Answer[]>([]);
  const [difficulty, setDifficulty] = useState<Answer | null>(null);
  const [item9Ever, setItem9Ever] = useState(false);
  const [crisis, setCrisis] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const holdUntil = useRef(0);
  // This check-in's row once question 9 (or the end) has saved it: later saves update it rather than add another.
  const row = useRef<Promise<MoodEntry | null> | null>(null);

  const persist = (a: Answers, item9: boolean): Promise<MoodEntry | null> => {
    const prev = row.current;
    const run = (async () => {
      const first = prev ? await prev.catch(() => null) : null;
      return care.act.saveScreen({ ...a, item9_ever: item9 }, first ? { id: first.id } : undefined);
    })();
    row.current = run;
    return run;
  };

  const save = async (a: Answers) => {
    setBusy(true);
    setProblem(null);
    try {
      await persist(a, item9Ever);
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = (a: Answers) => {
    setStep({ kind: "results", data: scoreScreen({ ...a, item9_ever: item9Ever }), at: now().toISOString() });
    void save(a);
  };

  const close = () => {
    // Question 9 is already saved: keep what she's answered since, as "Stop here" would.
    if (step.kind !== "results" && row.current) void persist({ phq9, gad7, difficulty }, true).catch(() => {});
    setCrisis(false);
    onClose();
  };

  const answer = (v: Answer) => {
    if (Date.now() < holdUntil.current) return;
    if (step.kind === "difficulty") {
      setDifficulty(v);
      finish({ phq9, gad7, difficulty: v });
      return;
    }
    if (step.kind !== "q") return;
    const i = step.i;
    holdUntil.current = Date.now() + NEXT_HOLD_MS;
    if (i < PHQ) {
      const next = [...phq9];
      next[i] = v;
      setPhq9(next);
      if (i === ITEM9 && v > 0) {
        // At once, over the question; set for good, even if she goes Back and changes it. Saved now, so today's strip holds.
        setItem9Ever(true);
        setCrisis(true);
        void persist({ phq9: next, gad7: [], difficulty: null }, true).catch(() => {});
        return;
      }
      setStep({ kind: "q", i: i + 1 });
      return;
    }
    const next = [...gad7];
    next[i - PHQ] = v;
    setGad7(next);
    if (i + 1 < TOTAL) {
      setStep({ kind: "q", i: i + 1 });
      return;
    }
    // The difficulty question only if anything was checked off (it's unscored).
    if ([...phq9, ...next].some((x) => x > 0)) setStep({ kind: "difficulty" });
    else finish({ phq9, gad7: next, difficulty: null });
  };

  const back = () => {
    if (step.kind === "difficulty") setStep({ kind: "q", i: TOTAL - 1 });
    else if (step.kind === "q") setStep(step.i === 0 ? { kind: "intro" } : { kind: "q", i: step.i - 1 });
  };

  const asking = step.kind === "q" || step.kind === "difficulty";
  const title = step.kind === "results" ? resultsTitle(step.at, tz) : FULL_INTRO.title;
  const subtitle = step.kind === "q" ? `Question ${step.i + 1} of ${TOTAL}` : step.kind === "results" ? RESULTS_SUB : undefined;

  let footer = null;
  if (step.kind === "intro") {
    footer = (
      <div className="flex gap-3">
        <Button variant="soft" size="lg" className="flex-1" onClick={close}>
          Not now
        </Button>
        <Button size="lg" className="flex-1" onClick={() => setStep({ kind: "q", i: 0 })}>
          Start
        </Button>
      </div>
    );
  } else if (step.kind === "results") {
    const { data, at } = step;
    footer = (
      <div className="flex gap-3">
        {/* Wider than Done, so it stays on one line at 375 px. */}
        <Button variant="soft" size="lg" className="flex-[1.4]" onClick={() => void copyForOb(screenCopyText(data, at, tz))}>
          Copy for my OB
        </Button>
        <Button size="lg" className="flex-1" onClick={close}>
          Done
        </Button>
      </div>
    );
  }

  return (
    <>
      <Sheet
        open={open}
        onClose={close}
        title={title}
        subtitle={subtitle}
        footer={footer}
        actions={
          asking ? (
            <Button variant="ghost" size="sm" onClick={back}>
              Back
            </Button>
          ) : undefined
        }
      >
        {step.kind === "intro" && (
          <div className="space-y-4 pb-2">
            <p className={cx(tone.body, "text-[17px] leading-relaxed")}>{FULL_INTRO.body}</p>
            <p className={cx(tone.faint, "text-[12px] leading-snug")}>{FULL_INTRO.credit}</p>
          </div>
        )}
        {step.kind === "q" && (
          <Question
            key={step.i}
            stem={step.i < PHQ ? PHQ9_STEM : GAD7_STEM}
            item={step.i < PHQ ? PHQ9_ITEMS[step.i] : GAD7_ITEMS[step.i - PHQ]}
            options={FREQ}
            value={step.i < PHQ ? phq9[step.i] : gad7[step.i - PHQ]}
            onAnswer={answer}
          />
        )}
        {step.kind === "difficulty" && <Question key="difficulty" item={DIFFICULTY_Q} options={DIFFICULTY} value={difficulty ?? undefined} onAnswer={answer} />}
        {step.kind === "results" && (
          <>
            {problem && (
              <div className={cx(tone.inset, "flex items-center gap-3 px-4 py-3")}>
                <Problem className="mt-0 flex-1">{problem}</Problem>
                <Button variant="soft" size="sm" disabled={busy} onClick={() => void save({ phq9, gad7, difficulty })}>
                  Try again
                </Button>
              </div>
            )}
            <ScreenResults data={step.data} />
          </>
        )}
      </Sheet>
      <OnTop>
        <CrisisSheet
          open={open && crisis}
          onClose={() => setCrisis(false)}
          audience="her"
          from="screen"
          onContinue={() => {
            setCrisis(false);
            setStep({ kind: "q", i: ITEM9 + 1 });
          }}
          onStop={() => {
            setCrisis(false);
            finish({ phq9, gad7, difficulty });
          }}
          onBack={() => setCrisis(false)}
        />
      </OnTop>
    </>
  );
}

/** One question: the stem small, the item large, the answers full width at the bottom (one-handed). */
function Question({
  stem,
  item,
  options,
  value,
  onAnswer,
}: {
  stem?: string;
  item: string;
  options: readonly string[];
  value: Answer | undefined;
  onAnswer: (v: Answer) => void;
}) {
  return (
    <div className="flex min-h-[58dvh] flex-col pb-2">
      {stem && <p className={cx(tone.muted, "text-[14px] leading-snug")}>{stem}</p>}
      <p className={cx(tone.heading, "text-[21px] leading-snug", stem && "mt-3")}>{item}</p>
      <div role="radiogroup" aria-label={item} className="mt-auto space-y-2.5 pt-6">
        {options.map((label, v) => (
          <button
            key={label}
            type="button"
            role="radio"
            aria-checked={value === v}
            onClick={() => onAnswer(v as Answer)}
            className={cx(
              "flex min-h-[56px] w-full items-center rounded-[14px] px-4 text-left text-[17px] font-semibold transition active:scale-[0.98]",
              value === v ? "bg-mp-accent text-mp-on-accent" : "bg-mp-sunken text-mp-ink active:bg-mp-ink/10"
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
