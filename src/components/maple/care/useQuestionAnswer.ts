"use client";

import { useRef, useState } from "react";
import type { CareEntry } from "@/lib/maple/types";
import { ApiError, useMaple } from "../useMaple";
import { errorText } from "./parts";
import type { UseCare } from "./useCare";

export type CareQuestion = Extract<CareEntry, { kind: "question" }>;

export function useQuestionAnswer(question: CareQuestion, care: UseCare, onSavingChange: (saving: boolean) => void) {
  const { refresh } = useMaple();
  const [incoming, setIncoming] = useState(question.updated_at);
  const [base, setBase] = useState(question);
  const [remote, setRemote] = useState(question);
  const [answer, setAnswer] = useState(question.data.answer ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const pending = useRef(false);
  const dirty = answer.trim() !== (base.data.answer ?? "").trim();
  if (question.updated_at !== incoming && !saving) {
    setIncoming(question.updated_at);
    setRemote(question);
    if (!dirty && !problem) {
      setBase(question);
      setAnswer(question.data.answer ?? "");
    }
  }
  const changed = dirty && remote.updated_at !== base.updated_at;
  const change = (value: string) => { setAnswer(value); setSaved(false); };
  const discard = () => {
    setBase(remote);
    setAnswer(remote.data.answer ?? "");
    setProblem(null);
    setSaved(false);
  };
  const save = async (replace = false) => {
    if (pending.current || !dirty || !care.access.write || (changed && !replace)) return;
    const expected = replace ? remote : base;
    const value = answer.trim();
    pending.current = true;
    onSavingChange(true);
    setSaving(true);
    setProblem(null);
    try {
      await care.act.editEntry(question.id, { data: { answer: value || null } }, expected.updated_at, { quiet: true });
      setBase({ ...expected, data: { ...expected.data, answer: value || null } });
      setAnswer(value);
      setSaved(true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const entry = (error.body as { entry?: CareEntry } | null)?.entry;
        if (entry?.kind === "question" && entry.id === question.id) setRemote(entry);
        void refresh();
      }
      setProblem(errorText(error));
    } finally {
      pending.current = false;
      onSavingChange(false);
      setSaving(false);
    }
  };
  return { answer, change, dirty, changed, remote, problem, saving, saved, save, discard };
}
