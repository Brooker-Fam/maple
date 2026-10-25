"use client";

import { useState } from "react";
import { loggedBy } from "@/lib/maple/care";
import { DEFAULT_TZ, dayKey, formatDayLabel } from "@/lib/maple/time";
import type { CareEntry } from "@/lib/maple/types";
import { Icon } from "../icons";
import { Button, SectionTitle, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { GROUP, Problem, errorText } from "./parts";
import { type UseCare, useCare } from "./useCare";

/**
 * "Questions for your OB" / "Questions for her OB" (§7.2): add, Asked, What
 * they said. Open ones first, then the ones asked lately. Deleting one is
 * soft, with Undo.
 */

type Question = Extract<CareEntry, { kind: "question" }>;

export function QuestionsSection() {
  const care = useCare();
  if (!care) return null;
  return <Questions care={care} />;
}

function Questions({ care }: { care: UseCare }) {
  const her = care.self;
  const write = care.access.write;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const all = care.state.entries.filter((e): e is Question => e.kind === "question");
  const open = all.filter((q) => !q.data.done).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const asked = all.filter((q) => q.data.done).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));

  const add = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await care.act.addQuestion(t, false);
      setText("");
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!write && !all.length) return null;
  return (
    <section>
      <SectionTitle>{her ? "Questions for your OB" : "Questions for her OB"}</SectionTitle>
      <div className={GROUP}>
        {open.map((q) => (
          <QuestionRow key={q.id} q={q} care={care} />
        ))}
        {asked.map((q) => (
          <QuestionRow key={q.id} q={q} care={care} />
        ))}
        {write && (
          <div className="px-4 py-3">
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={2000}
                placeholder={her ? "A question for your OB" : "A question for her OB"}
                aria-label={her ? "A question for your OB" : "A question for her OB"}
                className={cx(tone.input, "min-w-0 flex-1 py-2.5")}
              />
              <Button type="submit" size="sm" disabled={!text.trim() || busy}>
                Add
              </Button>
            </form>
            <Problem>{problem}</Problem>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * One question: its "Asked" check, the text, when and who; once asked, "What
 * they said" (saved when the field is left). Every change sends the version
 * it was made on, so someone else's newer edit wins and says so.
 */
function QuestionRow({ q, care }: { q: Question; care: UseCare }) {
  const { state, now, toast } = useMaple();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const write = care.access.write && q.id > 0;
  const done = !!q.data.done;
  const [answer, setAnswer] = useState(q.data.answer ?? "");
  // Someone else's answer arriving replaces this one unless it's being typed (React's "adjust state while rendering").
  const [seen, setSeen] = useState(q.data.answer ?? "");
  const [typing, setTyping] = useState(false);
  if (!typing && (q.data.answer ?? "") !== seen) {
    setSeen(q.data.answer ?? "");
    setAnswer(q.data.answer ?? "");
  }
  const patch = (data: Record<string, unknown>) =>
    void care.act.editEntry(q.id, { data }, q.updated_at, { quiet: true }).catch((e) => toast(errorText(e), { tone: "error" }));

  const who = loggedBy(q.created_by, { members: state?.members ?? [], me: state?.me.email });
  const day = formatDayLabel(dayKey(new Date(q.at), tz), dayKey(now(), tz));

  return (
    <div className="flex gap-1 py-2 pr-1.5 pl-1.5">
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={`Asked: ${q.note ?? ""}`}
        disabled={!write}
        onClick={() => patch({ done: !done })}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full disabled:opacity-60"
      >
        <span
          className={cx(
            "flex h-6 w-6 items-center justify-center rounded-full border-2",
            done ? "border-mp-accent bg-mp-accent text-mp-on-accent" : "border-mp-ink-3/60 text-transparent"
          )}
        >
          <Icon name="check" size={14} strokeWidth={3} />
        </span>
      </button>
      <div className="min-w-0 flex-1 py-1.5">
        <p className={cx("text-[15px] leading-snug break-words", done ? "text-mp-ink-2" : "text-mp-ink")}>{q.note}</p>
        <p className={cx(tone.muted, "mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[13px]")}>
          {done ? "Asked" : day}
          <span aria-hidden>·</span>
          {who}
          {q.pending && (
            <>
              <span aria-hidden>·</span>
              on this phone, not synced
            </>
          )}
        </p>
        {done && (
          <label className="mt-2 block">
            <span className={cx(tone.label, "mb-1 block")}>What they said</span>
            {write ? (
              <textarea
                value={answer}
                rows={2}
                maxLength={2000}
                onFocus={() => setTyping(true)}
                onChange={(e) => setAnswer(e.target.value)}
                onBlur={() => {
                  setTyping(false);
                  if (answer.trim() !== (q.data.answer ?? "").trim()) patch({ answer: answer.trim() || null });
                }}
                className={cx(tone.input, "resize-none py-2.5 text-[15px]")}
              />
            ) : (
              <span className={cx(tone.body, "block text-[15px] leading-snug")}>{q.data.answer || "Nothing noted yet."}</span>
            )}
          </label>
        )}
      </div>
      {write && (
        <button
          type="button"
          aria-label={`Delete the question: ${q.note ?? ""}`}
          onClick={() => void care.act.deleteEntry(q.id).catch(() => {})}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-mp-ink-3 active:bg-mp-ink/5"
        >
          <Icon name="trash-2" size={18} />
        </button>
      )}
    </div>
  );
}

export default QuestionsSection;
