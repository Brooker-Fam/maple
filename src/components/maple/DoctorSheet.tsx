"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { dayKey, formatDayLabel } from "@/lib/maple/time";
import type { Entry, EntryOf } from "@/lib/maple/types";
import { usePhones } from "./AlertCard";
import { useAppNav } from "./AppNav";
import { telHref } from "./care/CareTeam";
import { GROUP, NavRow } from "./care/parts";
import { Icon } from "./icons";
import { VisitSummary } from "./PatternsTab";
import { Button, SectionTitle, Sheet, TextArea, cx, tone } from "./ui";
import { useMaple, useNow } from "./useMaple";

/**
 * "For the doctor": everything for Maple's checkup in one place. Questions to
 * ask (add, tick off with what the doctor said, Asked), the visit summary to
 * copy or the CSV, her pediatrician's and the after-hours numbers, and a way
 * to the growth chart. Opened from More → For the doctor (with the add field
 * focused) and from the top of History → Patterns. Maple's note sheet keeps
 * its "Make it a question for the doctor", and the MCP its doctor-question
 * tools; both land on this list.
 */

type Question = EntryOf<"note">;

const isQuestion = (e: Entry): e is Question => e.kind === "note" && !!e.data.for_doctor;

/** Quiet destructive text action at the end of a row (Delete). */
const DANGER_TEXT =
  "-mr-2 min-h-[44px] shrink-0 rounded-[10px] px-2 text-[15px] font-medium text-mp-danger transition hover:bg-mp-danger/10 active:scale-[0.97] disabled:opacity-40";

export default function DoctorSheet({ open, onClose, ask }: { open: boolean; onClose: () => void; ask?: number }) {
  const { state } = useMaple();
  const now = useNow(60_000);
  const app = useAppNav();
  const phones = usePhones();
  if (!state) return null;
  const tz = state.baby.timezone;
  const todayKey = dayKey(now, tz);
  const baby = (state.baby.nickname || state.baby.name).split(" ")[0];

  const then = (fn: () => void) => {
    onClose();
    window.setTimeout(fn, 120);
  };
  const toGrowth = () =>
    then(() => {
      app.go("patterns");
      // After History has drawn Patterns (the growth chart is near the end).
      window.setTimeout(() => document.getElementById("maple-growth-chart")?.scrollIntoView({ block: "start" }), 400);
    });

  const numbers = [
    phones.pediatrician && { label: "Pediatrician", phone: phones.pediatrician },
    phones.afterHours && { label: "After hours", phone: phones.afterHours },
  ].filter((n): n is { label: string; phone: string } => !!n);

  return (
    <Sheet open={open} onClose={onClose} title="For the doctor" subtitle={`${baby}'s checkups`}>
      <DoctorQuestions open={open} focus={!!ask && open} />

      <VisitSummary state={state} todayKey={todayKey} tz={tz} now={now} />

      <section>
        <SectionTitle>Her doctor</SectionTitle>
        <div className={GROUP}>
          {numbers.map((n) => (
            <a key={n.label} href={telHref(n.phone)} className={cx(tone.row, "min-h-[52px] py-2.5")}>
              <Icon name="phone" size={20} className="shrink-0 text-mp-accent-fg" />
              <span className="min-w-0 flex-1">
                <span className={cx(tone.body, "block text-[15px] leading-snug")}>{n.label}</span>
                <span className={cx(tone.muted, "block text-[13px] tabular-nums")}>{n.phone}</span>
              </span>
              <span className="shrink-0 text-[15px] font-medium text-mp-accent-fg">Call</span>
            </a>
          ))}
          {!numbers.length && (
            <NavRow icon="phone" label="Add her doctor's numbers" note="In Family → Her doctor, for one-tap calling" onClick={() => then(() => app.go("family"))} />
          )}
          <NavRow icon="ruler" label="Growth chart" note="Weights and lengths on the WHO curves" onClick={toGrowth} />
        </div>
      </section>
    </Sheet>
  );
}

/** A row that opens and closes the content under it. */
function Disclosure({ label, summary, open, onToggle, children }: { label: string; summary?: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div>
      <button type="button" onClick={onToggle} aria-expanded={open} className={cx(tone.row, "min-h-[52px]")}>
        <span className={cx(tone.body, "shrink-0 text-[15px] font-medium")}>{label}</span>
        <span className={cx(tone.muted, "min-w-0 flex-1 truncate text-right text-sm")}>{summary}</span>
        <Icon name="chevron-down" size={18} className={cx("shrink-0 text-mp-ink-3 transition", open && "rotate-180")} />
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

/** Questions for the next checkup (moved here from Family): add, tick off with the answer, put back, delete. */
function DoctorQuestions({ open: sheetOpen, focus }: { open: boolean; focus: boolean }) {
  const { state, api, log, update, remove, readOnly, memberName, now } = useMaple();
  const tz = state!.baby.timezone;
  const rev = state!.rev;
  const [fetched, setFetched] = useState<Question[]>([]);
  const [text, setText] = useState("");
  const [showDone, setShowDone] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  // Questions can be weeks old, older than the app's 72-hour window, so load them all while the sheet is open;
  // reload whenever the log changes.
  useEffect(() => {
    if (!sheetOpen) return;
    let live = true;
    api<{ entries: Entry[] }>("/api/maple/entries?kind=note&limit=500")
      .then((r) => live && setFetched(r.entries.filter(isQuestion)))
      .catch(() => {
        // keep what we have
      });
    return () => {
      live = false;
    };
  }, [api, rev, sheetOpen]);

  // More → For the doctor: straight to the add field.
  useEffect(() => {
    if (!focus) return;
    const t = window.setTimeout(() => field.current?.focus({ preventScroll: true }), 350);
    return () => window.clearTimeout(t);
  }, [focus]);

  // Fresh local saves (incl. not-yet-synced ones) win over the last fetch.
  const all = useMemo(() => {
    const byId = new Map<number, Question>();
    for (const q of fetched) byId.set(q.id, q);
    for (const e of state!.entries) if (isQuestion(e)) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  }, [fetched, state]);
  const open = all.filter((q) => !q.data.done);
  const done = all.filter((q) => q.data.done);

  const add = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    await log({ kind: "note", data: { for_doctor: true }, note: t }, { toast: "Added to the list for the doctor" });
  };

  const patchLocal = (saved: Entry | null) => {
    if (saved && isQuestion(saved)) setFetched((list) => list.map((q) => (q.id === saved.id ? saved : q)));
  };

  return (
    <section>
      <SectionTitle>Questions to ask</SectionTitle>
      <div className={GROUP}>
        {!readOnly && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
            className="flex items-center gap-1 py-1.5 pr-2 pl-1.5"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center text-mp-accent-fg" aria-hidden>
              <Icon name="plus" size={20} strokeWidth={2} />
            </span>
            <input
              ref={field}
              className="min-h-[44px] min-w-0 flex-1 bg-transparent text-base text-mp-ink outline-none placeholder:text-mp-ink-3"
              value={text}
              maxLength={300}
              placeholder="Is her cheek rash okay?"
              aria-label="New question for the doctor"
              onChange={(e) => setText(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={!text.trim()}>
              Add
            </Button>
          </form>
        )}

        {open.length === 0 ? (
          <p className={cx(tone.muted, "px-4 py-4 text-center text-sm")}>{done.length ? "All asked." : "No questions yet."}</p>
        ) : (
          <ul className={tone.divide}>
            {open.map((q) => (
              <QuestionRow
                key={q.id}
                q={q}
                readOnly={readOnly}
                by={`${memberName(q.created_by)} · ${formatDayLabel(dayKey(new Date(q.started_at), tz), dayKey(now(), tz))}`}
                onDone={async (answer) => patchLocal(await update(q.id, { data: { done: true, ...(answer ? { answer } : {}) } }, { toast: "Ticked off" }))}
                onRemove={() => void remove(q.id)}
              />
            ))}
          </ul>
        )}

        {done.length > 0 && (
          <Disclosure label="Asked" summary={done.length} open={showDone} onToggle={() => setShowDone((v) => !v)}>
            <ul className="-ml-2.5 space-y-1">
              {done.map((q) => (
                <li key={q.id} className="flex items-start gap-1">
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={async () => patchLocal(await update(q.id, { data: { done: false } }, { toast: "Back on the list" }))}
                    aria-label="Put back on the list"
                    className="flex h-11 w-11 shrink-0 items-center justify-center"
                  >
                    <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-mp-accent text-mp-on-accent">
                      <Icon name="check" size={14} strokeWidth={2.75} />
                    </span>
                  </button>
                  <div className="min-w-0 flex-1 py-2.5">
                    <p className={cx(tone.muted, "text-[15px] leading-snug line-through decoration-mp-ink-3/60")}>{q.note}</p>
                    {q.data.answer && (
                      <p className={cx(tone.body, "mt-1 flex gap-1.5 text-sm leading-snug")}>
                        <Icon name="stethoscope" size={15} className="mt-[2px] shrink-0 text-mp-ink-3" label="Doctor's answer" />
                        <span>{q.data.answer}</span>
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </div>
      <p className={cx(tone.faint, "mt-2 px-1 text-[13px] leading-snug")}>
        {readOnly ? "What the family plans to ask at her next checkup." : "Jot them down as they come up; tick them off at her checkup."}
      </p>
    </section>
  );
}

function QuestionRow({
  q,
  by,
  readOnly,
  onDone,
  onRemove,
}: {
  q: Question;
  by: string;
  readOnly: boolean;
  onDone: (answer: string) => Promise<void>;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  return (
    <li>
      <div className="flex items-start gap-1 pr-4 pl-1.5">
        <button
          type="button"
          disabled={readOnly}
          onClick={() => setOpen((v) => !v)}
          aria-label="Tick off"
          aria-expanded={open}
          className="flex h-11 w-11 shrink-0 items-center justify-center"
        >
          <span className={cx("h-[22px] w-[22px] rounded-full border-[1.5px] transition", open ? "border-mp-accent-fg bg-mp-accent/10" : "border-mp-ink-3")} />
        </button>
        <div className="min-w-0 flex-1 py-2.5">
          <p className={cx(tone.body, "text-[15px] leading-snug")}>{q.note || "(no text)"}</p>
          <p className={cx(tone.faint, "mt-0.5 text-xs")}>{by}</p>
        </div>
      </div>
      {open && (
        <div className="mr-4 mb-3 ml-[54px] space-y-2">
          <TextArea value={answer} onChange={setAnswer} placeholder="What did the doctor say? (optional)" />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void onDone(answer.trim())}>
              <Icon name="check" size={16} strokeWidth={2.25} />
              Asked
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Not yet
            </Button>
            <button type="button" onClick={onRemove} className={cx(DANGER_TEXT, "ml-auto text-sm")}>
              Delete
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
