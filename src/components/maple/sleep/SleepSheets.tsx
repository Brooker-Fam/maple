"use client";

import { useCallback, useEffect, useState } from "react";
import { sleepyLine, transferSteps } from "@/lib/maple/guidelines/sleep";
import { nextHandoff } from "@/lib/maple/sleep/engine";
import { TRY_OUTCOMES, TRY_TAGS, type BassinetTry, type HoldingShift, type TryOutcome, type TryTag } from "@/lib/maple/sleep/types";
import { OUTCOME_LABEL, sleepyChoices, TAG_LABEL } from "@/lib/maple/sleep/words";
import { DEFAULT_TZ, formatDuration, formatTime, formatTimeNear } from "@/lib/maple/time";
import type { Member } from "@/lib/maple/types";
import { useVoice } from "../familyWords";
import { Icon } from "../icons";
import { RecordedTimeField } from "../TimeField";
import { ContextNote, Label, NoteField, SheetFooter } from "../sheets/parts";
import { Button, Chip, cx, Sheet, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { OutcomeGrid } from "./SleepCards";
import SleepPlanSheet from "./SleepPlanSheet";
import { useSleep, type SleepApi, type SleepSheet } from "./useSleep";

const MIN = 60_000;

/** People who can hold her or lay her down: everyone in the family but photos-only guests. */
function usePeople(): Member[] {
  const { state } = useMaple();
  return (state?.members ?? []).filter((m) => m.role !== "photos");
}

/** Who's next by default: the person named for it, else the other parent (an owner or member who isn't holding her). */
function partnerOf(sh: HoldingShift | null, people: Member[], me: string): Member | null {
  if (sh?.next_holder) return people.find((p) => p.email === sh.next_holder) ?? null;
  const holder = sh?.holder ?? me;
  return people.find((p) => p.email !== holder && (p.role === "owner" || p.role === "member") && p.email !== "admin") ?? null;
}

function TagChips({ value, onChange }: { value: TryTag[]; onChange: (v: TryTag[]) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {TRY_TAGS.map((t) => (
        <Chip key={t} selected={value.includes(t)} onClick={() => onChange(value.includes(t) ? value.filter((x) => x !== t) : [...value, t])}>
          {TAG_LABEL[t]}
        </Chip>
      ))}
    </div>
  );
}

// ── How did it go? ───────────────────────────────────────────────────────

/** The running try's end: tags, a note and an earlier end are optional; one tap on an outcome saves. */
export function OutcomeSheet({ t, defaultAt, open = true, onClose }: { t: BassinetTry; defaultAt?: string; open?: boolean; onClose: () => void }) {
  const { state } = useMaple();
  const s = useSleep();
  const v = useVoice();
  const now = useNow(30_000);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const sleep = t.sleep_entry_id ? state?.entries.find((e) => e.id === t.sleep_entry_id) : undefined;
  const wokeAt = defaultAt ?? (sleep && !sleep.active && sleep.ended_at ? sleep.ended_at : undefined);
  const [tags, setTags] = useState<TryTag[]>(t.tags);
  const [note, setNote] = useState(t.note ?? "");
  const [ago, setAgo] = useState(0);
  const end = wokeAt ? new Date(wokeAt) : new Date(now.getTime() - ago * MIN);
  const choices = [0, 2, 5, 10].filter((n) => now.getTime() - n * MIN > Date.parse(t.started_at));
  const pick = async (o: TryOutcome) => {
    const done = await s.finishTry(t, o, { at: wokeAt || ago ? end : undefined, tags, note: note.trim() || null });
    if (done) onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="How did it go?" subtitle={`In the bassinet since ${formatTime(t.started_at, tz)} · ${formatDuration((end.getTime() - Date.parse(t.started_at)) / 1000)}${s.nth(t) ? ` · ${s.nth(t)}` : ""}`}>
      <div className="space-y-5">
        {wokeAt ? (
          <p className={cx(tone.muted, "text-[15px]")}>
            {v.They} woke at {formatTime(wokeAt, tz)}. The try ends then.
          </p>
        ) : (
          <div>
            <Label>Ended</Label>
            <div className="flex flex-wrap gap-2">
              {choices.map((n) => (
                <Chip key={n} selected={ago === n} onClick={() => setAgo(n)}>
                  {n === 0 ? "Now" : `${n} min ago · ${formatTimeNear(now.getTime() - n * MIN, now, tz)}`}
                </Chip>
              ))}
            </div>
          </div>
        )}
        <div>
          <Label optional>Tags</Label>
          <TagChips value={tags} onChange={setTags} />
        </div>
        <NoteField value={note} onChange={setNote} placeholder={`About ${v.name}'s sleep, like "stirred at 2:30"`} />
        <OutcomeGrid disabled={s.busy} onPick={(o) => void pick(o)} />
      </div>
    </Sheet>
  );
}

// ── I'm getting sleepy ───────────────────────────────────────────────────

/**
 * Exactly two choices, both safe: lay her on her back in the bassinet now
 * (which ends this turn and starts a try, then shows the transfer steps), or
 * wake the partner and hand her over now. Never "keep holding her".
 */
export function SleepySheet({ open = true, onClose }: { open?: boolean; onClose: () => void }) {
  const { state, memberName } = useMaple();
  const s = useSleep();
  const v = useVoice();
  const people = usePeople();
  const me = state?.me.email ?? "";
  const partner = partnerOf(s.shift, people, me);
  const [step, setStep] = useState<"choose" | "steps" | "who">("choose");
  const choices = sleepyChoices(v, partner ? memberName(partner.email) : null);

  const bassinet = async () => {
    const t = await s.startTry();
    if (t) setStep("steps");
  };
  const wake = async (to: string) => {
    if (!s.shift) {
      await s.startShift({ holder: to, handoffAt: null, nextHolder: me });
      onClose();
      return;
    }
    const done = await s.handOff(s.shift, { to, wake: true });
    if (done) onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title={step === "steps" ? "Into the bassinet" : "Getting sleepy?"}>
      {step === "choose" && (
        <div className="space-y-3">
          {choices.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={s.busy}
              onClick={() => void (c.id === "bassinet" ? bassinet() : partner ? wake(partner.email) : setStep("who"))}
              className="mp-control flex min-h-[72px] w-full items-center gap-3 rounded-2xl bg-mp-accent px-4 text-left text-mp-on-accent transition active:scale-[0.99] disabled:opacity-40"
            >
              <Icon name={c.id === "bassinet" ? "bassinet" : "bell"} size={24} />
              <span className="min-w-0 flex-1">
                <span className="block text-[17px] font-semibold">{c.label}</span>
                <span className="block text-[13px] opacity-90">{c.hint}</span>
              </span>
            </button>
          ))}
          <ContextNote icon="moon">{sleepyLine(v)}</ContextNote>
        </div>
      )}
      {step === "who" && (
        <div className="space-y-3">
          <p className={cx(tone.muted, "text-[15px]")}>Who&apos;s taking over?</p>
          <div className="flex flex-wrap gap-2">
            {people
              .filter((p) => p.email !== (s.shift?.holder ?? me))
              .map((p) => (
                <Chip key={p.email} onClick={() => void wake(p.email)}>
                  {memberName(p.email)}
                </Chip>
              ))}
          </div>
          <ContextNote icon="moon">{sleepyLine(v)}</ContextNote>
        </div>
      )}
      {step === "steps" && (
        <div className="space-y-4">
          <ol className="list-decimal space-y-2 pl-5 text-[15px] text-mp-ink">
            {transferSteps(v).map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ol>
          <Button size="lg" className="w-full" onClick={onClose}>
            Done
          </Button>
        </div>
      )}
    </Sheet>
  );
}

// ── Holding: start, or hand off ──────────────────────────────────────────

const PLAN_MINUTES = [60, 90, 120, 180] as const;
const planWords = (m: number) => (m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`);

export function HoldingSheet({ mode, open = true, onClose }: { mode: "start" | "handoff"; open?: boolean; onClose: () => void }) {
  const { state, memberName, now } = useMaple();
  const s = useSleep();
  const v = useVoice();
  const people = usePeople();
  const me = state?.me.email ?? "";
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const sh = s.shift;
  const handing = mode === "handoff" && !!sh;
  const firstWho = handing ? (partnerOf(sh, people, me)?.email ?? people.find((p) => p.email !== sh!.holder)?.email ?? "") : me;
  const [who, setWho] = useState(firstWho);
  const defaultPlan = handing ? Math.round(nextHandoff(sh!, 0) / MIN) : 120;
  const [plan, setPlan] = useState<number | null>((PLAN_MINUTES as readonly number[]).includes(defaultPlan) ? defaultPlan : 120);
  const [next, setNext] = useState<string | null>(handing ? sh!.holder : partnerOf(null, people, me)?.email ?? null);
  const at = new Date(now().getTime() + (plan ?? 0) * MIN);

  const go = async () => {
    const handoffAt = plan ? at : null;
    const done = handing ? await s.handOff(sh!, { to: who, handoffAt }) : await s.startShift({ holder: who, handoffAt, nextHolder: next });
    if (done) onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={handing ? "Hand off" : `Holding ${v.name}`}
      subtitle={handing ? `${memberName(sh!.holder)} has held ${v.them} since ${formatTime(sh!.started_at, tz)}` : `Someone staying awake while holding ${v.them}`}
      footer={<SheetFooter onClose={onClose} onPrimary={() => void go()} label={handing ? `Hand off to ${who ? memberName(who) : "…"}` : "Start"} disabled={!who || s.busy} busy={s.busy} />}
    >
      <div className="space-y-5">
        <div>
          <Label>{handing ? "Who's taking over" : "Who's holding"}</Label>
          <div className="flex flex-wrap gap-2">
            {people
              .filter((p) => !handing || p.email !== sh!.holder)
              .map((p) => (
                <Chip key={p.email} selected={who === p.email} onClick={() => setWho(p.email)}>
                  {p.email === me ? "Me" : memberName(p.email)}
                </Chip>
              ))}
          </div>
        </div>
        <div>
          <Label>{handing ? "Next planned handoff" : "Planned handoff"}</Label>
          <div className="flex flex-wrap gap-2">
            {PLAN_MINUTES.map((m) => (
              <Chip key={m} selected={plan === m} onClick={() => setPlan(m)}>
                {`In ${planWords(m)} · ${formatTime(now().getTime() + m * MIN, tz)}`}
              </Chip>
            ))}
            <Chip selected={plan === null} onClick={() => setPlan(null)}>
              No plan
            </Chip>
          </div>
        </div>
        {!handing && (
          <div>
            <Label optional>Who&apos;s next</Label>
            <div className="flex flex-wrap gap-2">
              {people
                .filter((p) => p.email !== who)
                .map((p) => (
                  <Chip key={p.email} selected={next === p.email} onClick={() => setNext(next === p.email ? null : p.email)}>
                    {p.email === me ? "Me" : memberName(p.email)}
                  </Chip>
                ))}
            </div>
          </div>
        )}
        <ContextNote>
          Every phone shows who&apos;s holding {v.them}, and phones with handoff reminders on (Notifications) hear at the planned time, though a notice can be late. If you start to feel sleepy before then, lay {v.them} in the bassinet or wake someone.
        </ContextNote>
      </div>
    </Sheet>
  );
}

// ── Edit a try ───────────────────────────────────────────────────────────

export function TrySheet({ t, open = true, onClose }: { t: BassinetTry; open?: boolean; onClose: () => void }) {
  const { state, memberName, readOnly } = useMaple();
  const s = useSleep();
  const v = useVoice();
  const people = usePeople();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const [start, setStart] = useState(new Date(t.started_at));
  const [end, setEnd] = useState<Date | null>(t.ended_at ? new Date(t.ended_at) : null);
  const [outcome, setOutcome] = useState<TryOutcome | null>(t.outcome);
  const [tags, setTags] = useState<TryTag[]>(t.tags);
  const [note, setNote] = useState(t.note ?? "");
  const [by, setBy] = useState<string | null>(t.put_down_by);
  // Booleans and stable setters: the time fields report on every render, so a fresh object here would loop.
  const [badStart, setBadStart] = useState(false);
  const [badEnd, setBadEnd] = useState(false);
  const changed =
    start.getTime() !== Date.parse(t.started_at) ||
    (end?.getTime() ?? null) !== (t.ended_at ? Date.parse(t.ended_at) : null) ||
    outcome !== t.outcome ||
    tags.join() !== t.tags.join() ||
    (note.trim() || null) !== t.note ||
    by !== t.put_down_by;
  const bad = badStart || badEnd || (!!end && end.getTime() < start.getTime());

  const save = async () => {
    const patch: Parameters<typeof s.fixTry>[1] = {};
    if (start.getTime() !== Date.parse(t.started_at)) patch.started_at = start.toISOString();
    if (end && t.ended_at && end.getTime() !== Date.parse(t.ended_at)) patch.ended_at = end.toISOString();
    if (outcome && outcome !== t.outcome && t.ended_at) patch.outcome = outcome;
    if (tags.join() !== t.tags.join()) patch.tags = tags;
    if ((note.trim() || null) !== t.note) patch.note = note.trim() || null;
    if (by !== t.put_down_by) patch.put_down_by = by;
    if (await s.fixTry(t, patch)) onClose();
  };
  const del = async () => {
    if (await s.deleteTry(t)) onClose();
  };

  return (
    <Sheet
      open={open}
      dirty={changed}
      onClose={onClose}
      title="Bassinet try"
      subtitle={s.nth(t) || undefined}
      footer={<SheetFooter onClose={onClose} onDelete={readOnly ? undefined : () => void del()} onPrimary={() => void save()} label="Save" disabled={!changed || bad} busy={s.busy} />}
    >
      <fieldset disabled={readOnly || s.busy} className="min-w-0 space-y-5">
        <RecordedTimeField label="Laid down" value={start} onChange={setStart} tz={tz} max={end ?? undefined} onInvalidChange={setBadStart} />
        {end && <RecordedTimeField label="Ended" value={end} onChange={setEnd} tz={tz} min={start} onInvalidChange={setBadEnd} />}
        {t.ended_at && (
          <div>
            <Label>How it went</Label>
            <div className="flex flex-wrap gap-2">
              {TRY_OUTCOMES.map((o) => (
                <Chip key={o} selected={outcome === o} onClick={() => setOutcome(o)}>
                  {OUTCOME_LABEL[o]}
                </Chip>
              ))}
            </div>
          </div>
        )}
        <div>
          <Label optional>Tags</Label>
          <TagChips value={tags} onChange={setTags} />
        </div>
        <div>
          <Label>Laid down by</Label>
          <div className="flex flex-wrap gap-2">
            {people.map((p) => (
              <Chip key={p.email} selected={by === p.email} onClick={() => setBy(p.email)}>
                {memberName(p.email)}
              </Chip>
            ))}
          </div>
        </div>
        <NoteField value={note} onChange={setNote} placeholder={`About ${v.name}'s sleep`} readOnly={readOnly} />
        {t.sleep_entry_id && <ContextNote>This try sits on {v.their} sleep in the log, so that sleep is counted once. Moving the laid-down time moves that sleep&apos;s start too when they matched.</ContextNote>}
      </fieldset>
    </Sheet>
  );
}

// ── Log an earlier try ───────────────────────────────────────────────────

/** A try nobody tapped Put down for: when she was laid down, when it ended, how it went. */
export function LogTrySheet({ open = true, onClose }: { open?: boolean; onClose: () => void }) {
  const { state, memberName, now } = useMaple();
  const s = useSleep();
  const v = useVoice();
  const people = usePeople();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const me = state?.me.email ?? "";
  const [end, setEnd] = useState(() => new Date(Math.floor(now().getTime() / MIN) * MIN));
  const [start, setStart] = useState(() => new Date(end.getTime() - 45 * MIN));
  const [outcome, setOutcome] = useState<TryOutcome | null>(null);
  const [tags, setTags] = useState<TryTag[]>([]);
  const [note, setNote] = useState("");
  const [by, setBy] = useState<string | null>(people.some((p) => p.email === me) ? me : null);
  // Booleans and stable setters: the time fields report on every render, so a fresh object or callback here would loop.
  const [badStart, setBadStart] = useState(false);
  const [badEnd, setBadEnd] = useState(false);
  const [twin, setTwin] = useState<BassinetTry | null>(null);
  const moveStart = useCallback((d: Date) => {
    setStart(d);
    setTwin(null);
  }, []);
  const moveEnd = useCallback((d: Date) => {
    setEnd(d);
    setTwin(null);
  }, []);
  const bad = badStart || badEnd || end.getTime() <= start.getTime() || end.getTime() > now().getTime() + MIN;
  const save = async (allowDuplicate = false) => {
    if (!outcome) return;
    const r = await s.logTry({ start, end, outcome, tags, note: note.trim() || null, putDownBy: by, allowDuplicate });
    if (!r) return;
    if ("duplicate" in r) return setTwin(r.duplicate);
    onClose();
  };
  return (
    <Sheet
      open={open}
      dirty={!!outcome || !!note.trim()}
      onClose={onClose}
      title="Log an earlier try"
      subtitle="A bassinet try nobody started on the app"
      footer={<SheetFooter onClose={onClose} onPrimary={() => void save(!!twin)} label={twin ? "Save anyway" : "Save"} disabled={!outcome || bad || s.busy} busy={s.busy} />}
    >
      <fieldset disabled={s.busy} className="min-w-0 space-y-5">
        <RecordedTimeField label="Laid down" value={start} onChange={moveStart} tz={tz} max={end} onInvalidChange={setBadStart} />
        <RecordedTimeField label="Ended" value={end} onChange={moveEnd} tz={tz} min={start} onInvalidChange={setBadEnd} />
        <div>
          <Label>How it went</Label>
          <div className="flex flex-wrap gap-2">
            {TRY_OUTCOMES.map((o) => (
              <Chip key={o} selected={outcome === o} onClick={() => (setOutcome(o), setTwin(null))}>
                {OUTCOME_LABEL[o]}
              </Chip>
            ))}
          </div>
        </div>
        <div>
          <Label optional>Tags</Label>
          <TagChips value={tags} onChange={setTags} />
        </div>
        <div>
          <Label>Laid down by</Label>
          <div className="flex flex-wrap gap-2">
            {people.map((p) => (
              <Chip key={p.email} selected={by === p.email} onClick={() => setBy(p.email)}>
                {p.email === me ? "Me" : memberName(p.email)}
              </Chip>
            ))}
          </div>
        </div>
        <NoteField value={note} onChange={setNote} placeholder={`About ${v.name}'s sleep`} />
        {twin && (
          <p role="alert" className={cx(tone.inset, "px-4 py-3 text-[15px] text-mp-ink")}>
            A try from {formatTime(twin.started_at, tz)}
            {twin.outcome ? ` (${OUTCOME_LABEL[twin.outcome].toLowerCase()})` : ""} is already logged. If this is a different one, save it anyway; nothing was saved yet.
          </p>
        )}
        <ContextNote>It sits on {v.their} sleep in the log at that time, or adds that sleep, so nothing is counted twice.</ContextNote>
      </fieldset>
    </Sheet>
  );
}

// ── the host ─────────────────────────────────────────────────────────────

/**
 * The open sleep sheet, mounted by SleepProvider (MapleApp). The last one
 * stays mounted while it slides away; each sheet reads its try or shift
 * fresh from the shared state, and one whose try or shift another phone
 * already closed or deleted closes with a word.
 */
export function SleepSheetHost({ api }: { api: SleepApi }) {
  const { toast } = useMaple();
  const [last, setLast] = useState<SleepSheet | null>(api.sheet);
  if (api.sheet && api.sheet !== last) setLast(api.sheet);
  const shown = api.sheet ?? last;
  const open = !!api.sheet;
  const find = (id: number) => api.data.tries.find((t) => t.id === id) ?? null;
  const t = shown && (shown.kind === "outcome" || shown.kind === "try") ? find(shown.tryId) : null;
  // Gone while open: finished on another phone (How did it go?), deleted, or the shift handed over elsewhere.
  const gone =
    !!shown &&
    ((shown.kind === "outcome" && (!t || !!t.ended_at)) ||
      (shown.kind === "try" && !t) ||
      (shown.kind === "holding" && shown.mode === "handoff" && !api.shift));
  const closeSheet = api.closeSheet;
  // This phone's own Save, outcome or Delete closes its sheet itself: only a change from elsewhere says so.
  const quiet = !!shown && "tryId" in shown && api.endedHere(shown.tryId);
  useEffect(() => {
    if (!open || !gone) return;
    closeSheet();
    if (quiet) return;
    toast(shown?.kind === "holding" ? "That shift already ended." : t?.ended_at ? `That try already ended: ${OUTCOME_LABEL[t.outcome!].toLowerCase()}.` : "That try isn't in the log anymore.", { tone: "info" });
  }, [open, gone, quiet, closeSheet, shown?.kind, t?.ended_at, t?.outcome, toast]);
  if (!shown || (gone && open)) return null;
  const key = (x: string) => `${x}-${shown.kind}-${"tryId" in shown ? shown.tryId : ""}`;
  switch (shown.kind) {
    case "plan":
      return <SleepPlanSheet key={key("plan")} tab={shown.tab} open={open} onClose={closeSheet} />;
    case "outcome":
      return t ? <OutcomeSheet key={key("o")} t={t} defaultAt={shown.at} open={open} onClose={closeSheet} /> : null;
    case "try":
      return t ? <TrySheet key={key("t")} t={t} open={open} onClose={closeSheet} /> : null;
    case "sleepy":
      return <SleepySheet key={key("s")} open={open} onClose={closeSheet} />;
    case "holding":
      return <HoldingSheet key={key(`h-${shown.mode}`)} mode={shown.mode} open={open} onClose={closeSheet} />;
    case "log":
      return <LogTrySheet key={key("l")} open={open} onClose={closeSheet} />;
  }
}
