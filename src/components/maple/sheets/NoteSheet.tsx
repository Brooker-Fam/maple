"use client";

import { useState } from "react";
import { NOTE_TAG_LABELS, describeEntry } from "@/lib/maple/describe";
import { NOTE_TAGS, type NoteData, type NoteTag } from "@/lib/maple/types";
import { useCareNav } from "../care/CareNav";
import { useCare } from "../care/useCare";
import { Icon } from "../icons";
import { Chip, Segmented, Sheet, TextArea, WhenField, cx, tone } from "../ui";
import type { SheetProps } from "./index";
import { Label, LoggedBy, SheetFooter, pbool, presetStart, pstr, useOpenCount, useSheetBase, withNulls } from "./parts";

/**
 * Everyday notes (spit-up, hiccups, fussy spells, nail trims, cord care) and
 * questions for the doctor. A question is a note with for_doctor: it shows on
 * the visit checklist ("For the doctor") until someone marks it asked and
 * jots the answer. A question that's for her mom's OB belongs on her page:
 * "For her OB? Add it to her questions" takes the words there.
 */

type Amount = NonNullable<NoteData["amount"]>;
const AMOUNT_LABEL: Record<Amount, string> = { little: "A little", some: "Some", lots: "A lot" };

export default function NoteSheet(props: SheetProps) {
  const n = useOpenCount(props.open);
  return <NoteForm key={n} {...props} />;
}

function NoteForm({ open, onClose, entry, preset }: SheetProps) {
  const { tz, log, update, remove, now, clock } = useSheetBase();
  const e = entry?.kind === "note" ? entry : undefined;
  const care = useCare();
  const careNav = useCareNav();
  const d: Partial<NoteData> = e?.data ?? {};

  const [doctor, setDoctor] = useState(() => d.for_doctor ?? pbool(preset, "for_doctor") ?? false);
  const [tag, setTag] = useState<NoteTag | undefined>(() => d.tag ?? (NOTE_TAGS.includes(pstr(preset, "tag") as NoteTag) ? (pstr(preset, "tag") as NoteTag) : undefined));
  const [amount, setAmount] = useState<Amount | undefined>(d.amount);
  const [text, setText] = useState(e?.note ?? pstr(preset, "note") ?? "");
  const [done, setDone] = useState(d.done ?? false);
  const [answer, setAnswer] = useState(d.answer ?? "");
  const [when, setWhen] = useState<Date | null>(() => (e ? new Date(e.started_at) : presetStart(preset)));
  const [busy, setBusy] = useState(false);

  const words = text.trim();
  const canSave = doctor ? !!words : !!(tag || words);

  const save = async () => {
    if (!canSave) return;
    const data = doctor
      ? { for_doctor: true, done: e ? done : undefined, answer: e ? answer.trim() || undefined : undefined, tag: undefined, amount: undefined }
      : { tag, amount: tag === "spitup" ? amount : undefined, for_doctor: undefined, done: undefined, answer: undefined };
    const label = tag ? NOTE_TAG_LABELS[tag].label : "Note";
    if (e) {
      setBusy(true);
      const res = await update(
        e.id,
        {
          data: withNulls(data, ["tag", "amount", "for_doctor", "done", "answer"]),
          started_at: !doctor && when && when.getTime() !== Date.parse(e.started_at) ? when.toISOString() : undefined,
          note: words || null,
        },
        { toast: doctor ? (done ? "Marked as asked" : "Question updated") : `${label} updated` }
      );
      setBusy(false);
      if (res) onClose();
      return;
    }
    onClose();
    const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
    void log(
      { kind: "note", started_at: doctor ? undefined : when?.toISOString(), data: clean, note: words || null },
      doctor
        ? { toast: "Saved for her next visit" }
        : { toast: `${label} · ${clock(when ?? now())}` }
    );
  };

  const del = () => {
    if (!e) return;
    onClose();
    void remove(e.id, { toast: `${describeEntry(e).title} deleted` });
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={e ? describeEntry(e).title : doctor ? "Question for the doctor" : "Note"}
      footer={
        <SheetFooter
          onClose={onClose}
          onDelete={e ? del : undefined}
          onPrimary={() => void save()}
          label={e ? "Save" : doctor ? "Add question" : "Log it"}
          busy={busy}
          disabled={!canSave || (!!e && e.id < 0)}
          hint={!canSave ? (doctor ? "Type the question." : "Pick one or type a note.") : undefined}
        />
      }
    >
      {e && <LoggedBy entry={e} />}

      {doctor ? (
        <>
          <div>
            <Label>Question</Label>
            <TextArea value={text} onChange={setText} rows={3} placeholder="Ask about the rash on her cheek…" />
            {!e && <p className={cx(tone.muted, "mt-1.5 text-xs")}>It goes on the list for her next checkup. Anyone can add to it.</p>}
          </div>
          {!e && care?.access.write && (
            <button
              type="button"
              onClick={() => {
                // Close first; her tab opens at her questions with the words typed in (nothing is saved here).
                onClose();
                window.setTimeout(() => careNav.openQuestion(words), 120);
              }}
              className={cx(tone.card, tone.row, "min-h-[52px] py-2.5")}
            >
              <Icon name="message-square" size={20} className="shrink-0 text-mp-ink-2" />
              <span className={cx(tone.body, "min-w-0 flex-1 text-[15px]")}>
                {care.self ? "For your OB?" : "For her OB?"}{" "}
                <span className="font-medium text-mp-accent-fg">{care.self ? "Add it to your questions" : "Add it to her questions"}</span>
              </span>
              <Icon name="chevron-right" size={18} className="shrink-0 text-mp-ink-3" />
            </button>
          )}
          {e && (
            <>
              <div>
                <Label>Asked?</Label>
                <Segmented<"open" | "done">
                  value={done ? "done" : "open"}
                  onChange={(v) => setDone(v === "done")}
                  options={[
                    { value: "open", label: "Not yet" },
                    { value: "done", label: "Asked" },
                  ]}
                />
              </div>
              <div>
                <Label optional>Answer</Label>
                <TextArea value={answer} onChange={setAnswer} rows={3} placeholder="What the doctor said…" />
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <div>
            <Label>What</Label>
            <div className="flex flex-wrap gap-2">
              {/* Labels only: the app keeps lib's tag emoji out of its chrome. */}
              {NOTE_TAGS.map((t) => (
                <Chip key={t} selected={tag === t} onClick={() => setTag(tag === t ? undefined : t)}>
                  {NOTE_TAG_LABELS[t].label}
                </Chip>
              ))}
            </div>
          </div>
          {tag === "spitup" && (
            <div>
              <Label optional>How much</Label>
              <Segmented<Amount>
                value={amount ?? ("" as Amount)}
                onChange={(v) => setAmount(amount === v ? undefined : v)}
                options={(Object.keys(AMOUNT_LABEL) as Amount[]).map((a) => ({ value: a, label: AMOUNT_LABEL[a] }))}
              />
            </div>
          )}
          <div>
            <Label optional={!!tag}>Note</Label>
            <TextArea value={text} onChange={setText} rows={3} placeholder="What happened?" />
          </div>
          <WhenField value={when} onChange={setWhen} tz={tz} />
          {!e && (
            <button
              type="button"
              onClick={() => setDoctor(true)}
              className={cx(tone.card, tone.row, "min-h-[52px] py-2.5")}
            >
              <Icon name="stethoscope" size={20} className="shrink-0 text-mp-ink-2" />
              <span className={cx(tone.body, "flex-1 text-[15px] font-medium")}>Make it a question for the doctor</span>
              <Icon name="chevron-right" size={18} className="shrink-0 text-mp-ink-3" />
            </button>
          )}
        </>
      )}
    </Sheet>
  );
}
