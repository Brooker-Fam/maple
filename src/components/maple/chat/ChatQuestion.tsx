"use client";

import { useEffect, useId, useRef, useState } from "react";
import { chatDisplayText } from "@/lib/maple/chat/display";
import { questionInput } from "@/lib/maple/chat/questions";
import { CHAT_MAX_CHARS, type ChatQuestionAnswer, type ChatQuestionOutput } from "@/lib/maple/chat/types";
import { Button, cx, tone } from "../ui";

export type AnswerQuestion = (toolCallId: string, answer: ChatQuestionAnswer) => Promise<boolean>;

/** A question is a conversation turn, separate from approval to delete an entry. */
export default function ChatQuestion({ input, output, toolState, active, busy, onAnswer }: {
  input: unknown;
  output?: unknown;
  toolState: string;
  active: boolean;
  busy: boolean;
  onAnswer: (answer: ChatQuestionAnswer) => Promise<boolean>;
}) {
  const heading = useId();
  const answerLabel = useId();
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const inflight = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (custom) field.current?.focus(); }, [custom]);
  const question = questionInput(input);
  if (!question || toolState === "output-error") return (
    <section className={cx(tone.card, "space-y-2 p-3.5")} aria-label="Question unavailable">
      {question && <p className={cx(tone.body, "text-[16px]")}>{chatDisplayText(question.question)}</p>}
      <p role="status" className={cx(tone.muted, "text-[14px] leading-snug")}>This question couldn&apos;t be shown. You can type your reply in the message box.</p>
    </section>
  );

  const result = output && typeof output === "object" ? output as Partial<ChatQuestionOutput> : null;
  const submittedAnswer = output && typeof output === "object" ? output as Partial<ChatQuestionAnswer> : null;
  const choice = typeof submittedAnswer?.choiceId === "string" ? question.options.find((option) => option.id === submittedAnswer.choiceId) : undefined;
  const canonicalAnswer = result?.status === "answered" && typeof result.answer === "string" ? result.answer : null;
  const canonicalChoice = result?.status === "answered" && typeof result.choiceId === "string";
  // The SDK keeps the submitted answer locally; the server stores its canonical
  // form. Both show what the person chose, without claiming a log change.
  const answerText = canonicalAnswer !== null ? (canonicalChoice ? chatDisplayText(canonicalAnswer) : canonicalAnswer)
    : choice ? chatDisplayText(choice.label)
      : typeof submittedAnswer?.text === "string" ? submittedAnswer.text : null;
  const answered = answerText !== null;
  const superseded = result?.status === "superseded" || (!active && !answered);
  const submitted = toolState === "output-available" && !answered && !superseded;
  const pending = sending || submitted;
  const canAnswer = active && !busy && !pending && toolState === "input-available";
  const send = async (answer: ChatQuestionAnswer) => {
    if (!canAnswer || inflight.current) return;
    inflight.current = true;
    setSending(true);
    setFailed(false);
    try {
      if (await onAnswer(answer)) return;
    } catch {
      // The hook owns recovery. Keep this card ready when it rejects locally.
    }
    inflight.current = false;
    setSending(false);
    setFailed(true);
  };

  return (
    <section aria-labelledby={heading} aria-busy={pending} className={cx(tone.card, "space-y-3 p-3.5")}>
      <h3 id={heading} className={cx(tone.body, "text-[16px] font-medium leading-snug wrap-anywhere")}>{chatDisplayText(question.question)}</h3>
      {answered ? (
        <p className={cx(tone.muted, "rounded-xl bg-mp-sunken px-3 py-2.5 text-[15px] leading-snug whitespace-pre-wrap wrap-anywhere")}>
          <span className="mb-1 block text-[12px] font-medium text-mp-ink-3">Your answer</span>
          {answerText}
        </p>
      ) : superseded ? (
        <p className={cx(tone.faint, "text-[13px] leading-snug")}>Continued in chat.</p>
      ) : (
        <>
          {canAnswer && <p className={cx(tone.muted, "text-[13px]")}>Choose an answer or type your own.</p>}
          <div className="flex flex-wrap gap-2" role="group" aria-label="Choose an answer">
            {question.options.map((option) => (
              <Button key={option.id} variant="soft" disabled={!canAnswer} onClick={() => void send({ choiceId: option.id })} className="max-w-full whitespace-normal text-left wrap-anywhere">
                {chatDisplayText(option.label)}
              </Button>
            ))}
          </div>
          {custom ? (
            <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) void send({ text: draft.trim() }); }}>
              <label htmlFor={answerLabel} className={cx(tone.muted, "block text-[13px] font-medium")}>Your answer</label>
              <textarea ref={field} id={answerLabel} value={draft} rows={2} maxLength={CHAT_MAX_CHARS} disabled={!canAnswer} onChange={(event) => setDraft(event.target.value)} className={cx(tone.input, "min-h-[80px] resize-y text-[16px] disabled:opacity-60")} />
              <Button type="submit" size="sm" disabled={!canAnswer || !draft.trim()}>Send answer</Button>
            </form>
          ) : (
            <Button size="sm" variant="ghost" disabled={!canAnswer} onClick={() => setCustom(true)}>Type an answer</Button>
          )}
          {pending && <p role="status" className={cx(tone.muted, "text-[13px]")}>Sending your answer…</p>}
          {failed && <p role="alert" className="text-[13px] leading-snug text-mp-danger">Couldn&apos;t send your answer. Try again.</p>}
        </>
      )}
    </section>
  );
}
