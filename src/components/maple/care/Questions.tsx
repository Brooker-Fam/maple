"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { loggedBy } from "@/lib/maple/care";
import { DEFAULT_TZ, dayKey, formatDayLabel } from "@/lib/maple/time";
import { Icon } from "../icons";
import { Button, SectionTitle, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { GROUP, Problem, errorText } from "./parts";
import { type UseCare, useCare } from "./useCare";
import { useCareDraftGuard } from "./useCareDraftGuard";
import { useQuestionAnswer, type CareQuestion } from "./useQuestionAnswer";

let pending: { text?: string } | null = null;
const subs = new Set<() => void>();
export function requestQuestion(text?: string) {
  pending = { text: text?.trim() || undefined };
  for (const cb of subs) cb();
}

type DraftChanged = (id: string, dirty: boolean) => void;
type DraftCallbacks = { onDirtyChange: DraftChanged; onSavingChange: DraftChanged };

export function QuestionsSection() {
  const care = useCare();
  if (!care) return null;
  return <Questions care={care} />;
}

function Questions({ care }: { care: UseCare }) {
  const [drafts, setDrafts] = useState<Record<string, boolean>>({});
  const onDirtyChange = useCallback<DraftChanged>((id, dirty) => {
    setDrafts((current) => current[id] === dirty ? current : { ...current, [id]: dirty });
  }, []);
  const saving = useRef(new Set<string>());
  const onSavingChange = useCallback<DraftChanged>((id, pending) => {
    if (pending) saving.current.add(id);
    else saving.current.delete(id);
  }, []);
  const isSaving = useCallback(() => saving.current.size > 0, []);
  useCareDraftGuard(Object.values(drafts).some(Boolean), isSaving);
  const all = care.state.entries.filter((entry): entry is CareQuestion => entry.kind === "question");
  const open = all.filter((question) => !question.data.done).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const asked = all.filter((question) => question.data.done).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  if (!care.access.write && !all.length) return null;
  return <section className="scroll-mt-4">
    <SectionTitle>{care.self ? "Questions for your OB" : "Questions for her OB"}</SectionTitle>
    <div className={GROUP}>
      {[...open, ...asked].map((question) => <QuestionRow key={question.id} q={question} care={care} onDirtyChange={onDirtyChange} onSavingChange={onSavingChange} />)}
      {care.access.write && <NewQuestion care={care} onDirtyChange={onDirtyChange} onSavingChange={onSavingChange} />}
    </div>
  </section>;
}

function useRequestedQuestion(field: RefObject<HTMLInputElement | null>, setText: Dispatch<SetStateAction<string>>) {
  useEffect(() => {
    let timer: number | undefined;
    const take = () => {
      const request = pending;
      if (!request) return;
      pending = null;
      if (request.text) setText((text) => text.trim() ? text : request.text!);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        field.current?.scrollIntoView({ block: "center", behavior: "smooth" });
        field.current?.focus({ preventScroll: true });
      }, 250);
    };
    take();
    subs.add(take);
    return () => { subs.delete(take); window.clearTimeout(timer); };
  }, [field, setText]);
}

function NewQuestion({ care, onDirtyChange, onSavingChange }: { care: UseCare } & DraftCallbacks) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  useRequestedQuestion(field, setText);
  useEffect(() => {
    onDirtyChange("new", !!text.trim() || busy);
    return () => onDirtyChange("new", false);
  }, [text, busy, onDirtyChange]);
  const add = async () => {
    if (!text.trim() || busy) return;
    onSavingChange("new", true);
    setBusy(true);
    setProblem(null);
    try {
      await care.act.addQuestion(text.trim(), false);
      setText("");
    } catch (error) { setProblem(errorText(error)); }
    finally { onSavingChange("new", false); setBusy(false); }
  };
  const label = care.self ? "A question for your OB" : "A question for her OB";
  return <div className="px-4 py-3">
    <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void add(); }}>
      <input ref={field} id="her-ob-question" value={text} disabled={busy} onChange={(event) => setText(event.target.value)} maxLength={2000} placeholder={label} aria-label={label} className={cx(tone.input, "min-w-0 flex-1 py-2.5")} />
      <Button type="submit" size="sm" disabled={!text.trim() || busy}>{busy ? "Adding…" : "Add"}</Button>
    </form>
    <Problem>{problem}</Problem>
  </div>;
}

function QuestionRow({ q, care, onDirtyChange, onSavingChange }: { q: CareQuestion; care: UseCare } & DraftCallbacks) {
  const { state, now, refresh } = useMaple();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const write = care.access.write && q.id > 0;
  const done = !!q.data.done;
  const reportSaving = useCallback((saving: boolean) => onSavingChange(String(q.id), saving), [q.id, onSavingChange]);
  const draft = useQuestionAnswer(q, care, reportSaving);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    onDirtyChange(String(q.id), draft.dirty || draft.saving || busy);
    return () => onDirtyChange(String(q.id), false);
  }, [q.id, draft.dirty, draft.saving, busy, onDirtyChange]);
  const toggle = async () => {
    if (busy || draft.dirty || draft.saving) return;
    reportSaving(true);
    setBusy(true);
    setProblem(null);
    try { await care.act.editEntry(q.id, { data: { done: !done } }, q.updated_at, { quiet: true }); }
    catch (error) { setProblem(errorText(error)); void refresh(); }
    finally { reportSaving(false); setBusy(false); }
  };
  const who = loggedBy(q.created_by, { members: state?.members ?? [], me: state?.me.email });
  const day = formatDayLabel(dayKey(new Date(q.at), tz), dayKey(now(), tz));
  const disabled = !write || busy || draft.saving || draft.dirty;
  return <div className="flex gap-1 py-2 pr-1.5 pl-1.5">
    <button type="button" role="checkbox" aria-checked={done} aria-label={`Asked: ${q.note ?? ""}`} disabled={disabled} onClick={() => void toggle()} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full disabled:opacity-60">
      <span className={cx("flex h-6 w-6 items-center justify-center rounded-full border-2", done ? "border-mp-accent bg-mp-accent text-mp-on-accent" : "border-mp-ink-3/60 text-transparent")}><Icon name="check" size={14} strokeWidth={3} /></span>
    </button>
    <div className="min-w-0 flex-1 py-1.5">
      <p className={cx("text-[15px] leading-snug break-words", done ? "text-mp-ink-2" : "text-mp-ink")}>{q.note}</p>
      <p className={cx(tone.muted, "mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[13px]")}>{done ? "Asked" : day}<span aria-hidden>·</span>{who}{q.pending && <><span aria-hidden>·</span>on this phone, not synced</>}</p>
      {(done || draft.dirty) && (write ? <AnswerEditor draft={draft} /> : <div className="mt-2"><p className={tone.label}>What they said</p><p className={cx(tone.body, "mt-1 text-[15px]")}>{q.data.answer || "Nothing noted yet."}</p></div>)}
      <Problem>{problem}</Problem>
    </div>
    {write && <button type="button" aria-label={`Delete the question: ${q.note ?? ""}`} disabled={disabled} onClick={() => void care.act.deleteEntry(q.id).catch(() => {})} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-mp-ink-3 active:bg-mp-ink/5 disabled:opacity-40"><Icon name="trash-2" size={18} /></button>}
  </div>;
}

function AnswerEditor({ draft }: { draft: ReturnType<typeof useQuestionAnswer> }) {
  return <div className="mt-2 space-y-2">
    <label className="block">
      <span className={cx(tone.label, "mb-1 block")}>What they said</span>
      <textarea value={draft.answer} disabled={draft.saving} rows={2} maxLength={2000} aria-label="What they said" onChange={(event) => draft.change(event.target.value)} onBlur={(event) => {
        if (!(event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest("[data-question-action]"))) void draft.save();
      }} className={cx(tone.input, "resize-none py-2.5 text-[15px]")} />
    </label>
    {draft.changed && <div role="status" className={cx(tone.inset, "space-y-2 p-3 text-[14px]")}>
      <p>The saved answer changed while you were editing. Your answer hasn&apos;t been saved.</p>
      <p className={tone.label}>Saved answer</p>
      <p className="whitespace-pre-wrap break-words">{draft.remote.data.answer || "Nothing noted yet."}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="soft" size="sm" data-question-action disabled={draft.saving} onClick={draft.discard}>Use saved answer</Button>
        <Button variant="soft" size="sm" data-question-action disabled={draft.saving} onClick={() => void draft.save(true)}>Save my answer instead</Button>
      </div>
    </div>}
    <Problem>{draft.problem}</Problem>
    {draft.saving ? <p role="status" className={cx(tone.muted, "text-[13px]")}>Saving answer…</p> : draft.saved && <p role="status" className={cx(tone.muted, "text-[13px]")}>Answer saved</p>}
    {draft.dirty && !draft.changed && <div className="flex flex-wrap gap-2">
      <Button variant="soft" size="sm" data-question-action disabled={draft.saving} onClick={() => void draft.save()}>{draft.problem ? "Retry answer" : "Save answer"}</Button>
      <Button variant="ghost" size="sm" data-question-action disabled={draft.saving} onClick={draft.discard}>Discard answer changes</Button>
    </div>}
  </div>;
}

export default QuestionsSection;
