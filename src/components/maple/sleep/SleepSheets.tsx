"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { sleepyLine, transferSteps } from "@/lib/maple/guidelines/sleep";
import { askState, nextHandoff } from "@/lib/maple/sleep/engine";
import { catchUpLines } from "@/lib/maple/sleep/catchup";
import { handoffAroundRoster, windowAt, windowRange, type HandoffWhy } from "@/lib/maple/sleep/handoff";
import { TRY_NOTE_MAX, TRY_OUTCOMES, TRY_TAGS, type BassinetTry, type HoldingShift, type TryOutcome, type TryTag } from "@/lib/maple/sleep/types";
import { OUTCOME_LABEL, SLEEP_PLACE_LABEL, sleepyChoices, TAG_LABEL } from "@/lib/maple/sleep/words";
import { DEFAULT_TZ, formatDuration, formatTime, formatTimeNear } from "@/lib/maple/time";
import type { Entry, SleepPlace } from "@/lib/maple/types";
import { useVoice } from "../familyWords";
import { Icon } from "../icons";
import { RecordedTimeField } from "../TimeField";
import { ContextNote, Label, MoreDetails, SheetFooter } from "../sheets/parts";
import { Button, Chip, cx, Sheet, TextArea, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { GoalFormSheet } from "./GoalForm";
import { OutcomeGrid } from "./SleepCards";
import { CheckinSheet } from "./SleepCheckin";
import SleepPlanSheet from "./SleepPlanSheet";
import { partnerOf, usePeople, useSleep, type SleepApi, type SleepSheet } from "./useSleep";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A row of chips with its label, as one named group (so a screen reader hears "Tags, group", not just "Swaddled, toggle button"). */
function ChipGroup({ label, optional, children }: { label: string; optional?: boolean; children: ReactNode }) {
  return (
    <div>
      <Label optional={optional}>{label}</Label>
      <div role="group" aria-label={label} className="flex flex-wrap gap-2">
        {children}
      </div>
    </div>
  );
}

function TagChips({ value, onChange }: { value: TryTag[]; onChange: (v: TryTag[]) => void }) {
  return (
    <ChipGroup label="Tags" optional>
      {TRY_TAGS.map((t) => (
        <Chip key={t} selected={value.includes(t)} onClick={() => onChange(value.includes(t) ? value.filter((x) => x !== t) : [...value, t])}>
          {TAG_LABEL[t]}
        </Chip>
      ))}
    </ChipGroup>
  );
}

/** A try's note: labelled for a screen reader, 200 characters (the store's limit). */
function TryNote({ value, onChange, placeholder, readOnly = false }: { value: string; onChange: (v: string) => void; placeholder: string; readOnly?: boolean }) {
  return (
    <div>
      <Label optional={!readOnly}>Note</Label>
      {readOnly ? (
        <p className="text-[15px] leading-relaxed break-words whitespace-pre-wrap text-mp-ink-2">{value || "No note"}</p>
      ) : (
        <TextArea ariaLabel="Note" maxLength={TRY_NOTE_MAX} value={value} onChange={onChange} placeholder={placeholder} />
      )}
    </div>
  );
}

// ── How did it go? ───────────────────────────────────────────────────────

/**
 * The running try's end: the four outcomes first (one tap saves), and when
 * it ended, tags and a note under Add details, so a small screen opens on
 * the answer, not the extras.
 */
export function OutcomeSheet({ t, defaultAt, details = false, open = true, onClose }: { t: BassinetTry; defaultAt?: string; details?: boolean; open?: boolean; onClose: () => void }) {
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
  // What Add details holds, when it differs from the try as it is: "ended 2:05 AM · swaddled · a note".
  const summary = [
    !wokeAt && ago ? `ended ${formatTimeNear(end, now, tz)}` : null,
    tags.join() !== t.tags.join() && tags.length ? tags.map((x) => TAG_LABEL[x].toLowerCase()).join(", ") : null,
    (note.trim() || null) !== t.note && note.trim() ? "a note" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Sheet open={open} onClose={onClose} title="How did it go?" subtitle={`In the bassinet since ${formatTime(t.started_at, tz)} · ${formatDuration((end.getTime() - Date.parse(t.started_at)) / 1000)}${s.nth(t) ? ` · ${s.nth(t)}` : ""}`}>
      <div className="space-y-4">
        {wokeAt && (
          <p className={cx(tone.muted, "text-[15px]")}>
            {v.They} woke at {formatTime(wokeAt, tz)}. The try ends then.
          </p>
        )}
        <OutcomeGrid disabled={s.busy} onPick={(o) => void pick(o)} />
        <MoreDetails label="Add details" defaultOpen={details} summary={summary || (wokeAt ? "tags or a note" : "when it ended, tags or a note")}>
          {!wokeAt && (
            <ChipGroup label="Ended">
              {choices.map((n) => (
                <Chip key={n} selected={ago === n} onClick={() => setAgo(n)}>
                  {n === 0 ? "Now" : `${n} min ago · ${formatTimeNear(now.getTime() - n * MIN, now, tz)}`}
                </Chip>
              ))}
            </ChipGroup>
          )}
          <TagChips value={tags} onChange={setTags} />
          <TryNote value={note} onChange={setNote} placeholder={`About ${v.name}'s sleep, like "stirred at 2:30"`} />
          <p className={cx(tone.faint, "text-[13px]")}>Then tap how it went, above.</p>
        </MoreDetails>
      </div>
    </Sheet>
  );
}

// ── I'm getting sleepy ───────────────────────────────────────────────────

/**
 * For the person holding her, and only them. Exactly two choices, both
 * safe: lay her on her back in the bassinet now (which ends the turn and
 * starts a try, then shows the transfer steps), or wake the partner.
 * Waking them is only an ask: the sheet stays on "Waking Alex…" with the
 * bassinet still the big button, and nothing changes hands until Alex has
 * her (their "I've got her", or "Alex has her" here). Ten minutes on with
 * nobody taking over, it offers the two safe choices again. Never "keep
 * holding her".
 */
export function SleepySheet({ open = true, onClose }: { open?: boolean; onClose: () => void }) {
  const { state, memberName } = useMaple();
  const s = useSleep();
  const v = useVoice();
  const now = useNow(15_000);
  const people = usePeople();
  const me = state?.me.email ?? "";
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  // The turn this sheet opened on: once it's handed over, the sheet says so instead of offering anything.
  const [opened] = useState(() => (s.shift && s.shift.holder === me ? s.shift.id : null));
  const turn = opened != null ? (s.data.shifts.find((x) => x.id === opened) ?? null) : null;
  const mine = s.shift && s.shift.holder === me ? s.shift : null;
  const ask = mine ? askState(mine, now) : null;
  const partner = partnerOf(mine, people, me);
  const [step, setStep] = useState<"choose" | "steps" | "who">("choose");
  const taken = !mine && !!turn?.ended_at && turn.ended_how === "handoff" && !!s.shift;
  const asked = ask?.asked ? memberName(ask.to!) : null;
  const waking = step === "choose" && !!ask?.asked && !ask.stale;
  const stale = step === "choose" && !!ask?.asked && ask.stale;
  const choices = sleepyChoices(v, partner ? memberName(partner.email) : null);

  const bassinet = async () => {
    const t = await s.startTry();
    if (t) setStep("steps");
  };
  const wake = async (to: string) => {
    if (await s.askHandoff(mine, to)) setStep("choose");
  };
  const hasHer = async () => {
    if (!mine || !ask?.to) return;
    if (await s.handOff(mine, { to: ask.to })) onClose();
  };

  const big = (id: "bassinet" | "partner", label: string, hint: string, onClick: () => void) => (
    <button
      key={id}
      type="button"
      disabled={s.busy}
      onClick={onClick}
      className="mp-control flex min-h-[72px] w-full items-center gap-3 rounded-2xl bg-mp-accent px-4 text-left text-mp-on-accent transition active:scale-[0.99] disabled:opacity-40"
    >
      <Icon name={id === "bassinet" ? "bassinet" : "bell"} size={24} />
      <span className="min-w-0 flex-1">
        <span className="block text-[17px] font-semibold">{label}</span>
        <span className="block text-[13px] opacity-90">{hint}</span>
      </span>
    </button>
  );
  const title = step === "steps" ? "Into the bassinet" : taken ? "Taken over" : waking ? `Waking ${asked}…` : "Getting sleepy?";

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {step === "steps" ? (
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
      ) : taken ? (
        <div className="space-y-4">
          <p role="status" className={cx(tone.body, "text-[17px] font-semibold")}>
            {memberName(s.shift!.holder)} has {v.them} now, since {formatTime(s.shift!.started_at, tz)}.
          </p>
          <Button size="lg" className="w-full" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : !mine ? (
        <div className="space-y-4">
          <p role="status" className={cx(tone.muted, "text-[15px]")}>
            {s.shift ? `${memberName(s.shift.holder)} is holding ${v.them} now.` : `Nobody is recorded holding ${v.them} now.`}
          </p>
          <Button size="lg" className="w-full" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : waking ? (
        <div className="space-y-3">
          <p role="status" className={cx(tone.body, "text-[15px] leading-relaxed")}>
            {asked}&apos;s phone only sounds if handoff reminders are on. Go wake {asked}.
          </p>
          {big("bassinet", choices[0].label, choices[0].hint, () => void bassinet())}
          <Button variant="soft" size="lg" className="w-full" disabled={s.busy} onClick={() => void hasHer()}>
            {asked} has {v.them}
          </Button>
          <ContextNote icon="moon">{sleepyLine(v)}</ContextNote>
        </div>
      ) : step === "who" ? (
        <div className="space-y-3">
          <p className={cx(tone.muted, "text-[15px]")} id="sleepy-who">
            Who should take over?
          </p>
          <div role="group" aria-labelledby="sleepy-who" className="flex flex-wrap gap-2">
            {people
              .filter((p) => p.email !== me && p.email !== mine.holder)
              .map((p) => (
                <Chip key={p.email} onClick={() => void wake(p.email)}>
                  {memberName(p.email)}
                </Chip>
              ))}
          </div>
          <ContextNote icon="moon">{sleepyLine(v)}</ContextNote>
        </div>
      ) : (
        <div className="space-y-3">
          {stale && (
            <p role="status" className={cx(tone.body, "text-[15px] leading-relaxed")}>
              Nobody has taken over yet ({ask!.minutes} min since you asked {asked}).
            </p>
          )}
          {choices.map((c) =>
            big(
              c.id,
              c.id === "partner" && stale && ask?.to === partner?.email ? `${c.label} again` : c.label,
              c.hint,
              () => void (c.id === "bassinet" ? bassinet() : partner ? wake(partner.email) : setStep("who"))
            )
          )}
          <ContextNote icon="moon">{sleepyLine(v)}</ContextNote>
        </div>
      )}
    </Sheet>
  );
}

// ── Holding: start, or hand off ──────────────────────────────────────────

const PLAN_MINUTES = [60, 90, 120, 180] as const;
const planWords = (m: number) => (m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`);

/**
 * Start a holding turn (who, the planned handoff, who's next, and whether
 * she's asleep in arms), or record a handoff: someone has her now. From the
 * holder's phone that's "Alex has her"; from anyone else's it's taking over
 * ("I've got her"), which shows the catch-up.
 */
export function HoldingSheet({ mode, to, open = true, onClose }: { mode: "start" | "handoff"; to?: string; open?: boolean; onClose: () => void }) {
  const { state, memberName, now } = useMaple();
  const s = useSleep();
  const v = useVoice();
  const people = usePeople();
  const me = state?.me.email ?? "";
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const sh = s.shift;
  const handing = mode === "handoff" && !!sh;
  // Taking over from someone else's phone: me; handing over from the holder's: the partner.
  const firstWho = handing
    ? (to && to !== sh!.holder ? to : sh!.holder !== me && people.some((p) => p.email === me) ? me : (partnerOf(sh, people, me)?.email ?? people.find((p) => p.email !== sh!.holder)?.email ?? ""))
    : me;
  const [who, setWho] = useState(firstWho);
  const defaultPlan = handing ? Math.round(nextHandoff(sh!, 0) / MIN) : 120;
  const [next, setNext] = useState<string | null>(handing ? sh!.holder : (partnerOf(null, people, me)?.email ?? null));
  // The handoff goes to whoever's next: never planned inside their protected window on the roster (handoff.ts), as the server plans it.
  const nextFor = handing ? sh!.holder : next;
  const t0 = now().getTime();
  const around = handoffAroundRoster({ at: t0 + defaultPlan * MIN, from: t0, nextHolder: nextFor, goals: s.goals, tz });
  const windowEnd = around.why && around.at != null ? Math.round((around.at - t0) / MIN) : null;
  const [plan, setPlan] = useState<number | null>(() => (around.why ? windowEnd : (PLAN_MINUTES as readonly number[]).includes(defaultPlan) ? defaultPlan : 120));
  const sleeping = (state?.entries ?? []).find((e) => e.kind === "sleep" && e.active) ?? null;
  const [asleep, setAsleep] = useState(false);
  const at = new Date(now().getTime() + (plan ?? 0) * MIN);
  // A time picked inside the next person's protected window is theirs to pick; the sheet says so.
  const inWindow = plan != null && nextFor ? windowAt(s.goals, nextFor, at.getTime(), tz) : null;
  const nextName = nextFor ? (nextFor === me ? "your" : `${memberName(nextFor)}'s`) : "";

  const go = async () => {
    const handoffAt = plan ? at : null;
    const done = handing ? await s.handOff(sh!, { to: who, handoffAt }) : await s.startShift({ holder: who, handoffAt, nextHolder: next, asleep: asleep && !sleeping });
    // Taking over opens the catch-up in this sheet's place; anything else just closes.
    if (done && !(handing && who === me)) onClose();
  };
  const name = (email: string) => (email === me ? "Me" : memberName(email));
  // The handoff is recorded as what it is: someone has her now.
  const label = handing ? (who === me ? `I've got ${v.them}` : who ? `${memberName(who)} has ${v.them}` : "…") : "Start";

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={handing ? (sh!.holder === me ? "Hand off" : "Take over") : `Holding ${v.name}`}
      subtitle={handing ? `${sh!.holder === me ? "You've" : `${memberName(sh!.holder)} has`} held ${v.them} since ${formatTime(sh!.started_at, tz)}` : `Someone staying awake while holding ${v.them}`}
      footer={<SheetFooter onClose={onClose} onPrimary={() => void go()} label={label} disabled={!who || s.busy} busy={s.busy} />}
    >
      <div className="space-y-5">
        <ChipGroup label={handing ? "Who has her now" : "Who's holding"}>
          {people
            .filter((p) => !handing || p.email !== sh!.holder)
            .map((p) => (
              <Chip
                key={p.email}
                selected={who === p.email}
                onClick={() => {
                  setWho(p.email);
                  // Who's next is never the person holding her.
                  if (!handing && next === p.email) setNext(people.find((x) => x.email !== p.email && (x.role === "owner" || x.role === "member") && x.email !== "admin")?.email ?? null);
                }}
              >
                {name(p.email)}
              </Chip>
            ))}
        </ChipGroup>
        <ChipGroup label={handing ? "Next planned handoff" : "Planned handoff"}>
          {/* The default would wake the next person inside their protected sleep: its end comes first. */}
          {windowEnd != null && !(PLAN_MINUTES as readonly number[]).includes(windowEnd) && (
            <Chip selected={plan === windowEnd} onClick={() => setPlan(windowEnd)}>
              {`${formatTime(t0 + windowEnd * MIN, tz)} · after ${nextName} protected sleep`}
            </Chip>
          )}
          {/* A window's end picked before who's next changed stays shown while it's the choice. */}
          {plan != null && plan !== windowEnd && !(PLAN_MINUTES as readonly number[]).includes(plan) && (
            <Chip selected onClick={() => setPlan(plan)}>
              {formatTime(t0 + plan * MIN, tz)}
            </Chip>
          )}
          {PLAN_MINUTES.map((m) => (
            <Chip key={m} selected={plan === m} onClick={() => setPlan(m)}>
              {`In ${planWords(m)} · ${formatTime(now().getTime() + m * MIN, tz)}`}
            </Chip>
          ))}
          <Chip selected={plan === null} onClick={() => setPlan(null)}>
            No plan
          </Chip>
        </ChipGroup>
        {inWindow && (
          <p role="note" data-handoff-window className={cx(tone.muted, "-mt-3 text-[13px] leading-snug")}>
            {formatTime(at, tz)} is inside {nextName} protected sleep ({windowRange({ starts_at: new Date(inWindow.start).toISOString(), ends_at: new Date(inWindow.end).toISOString() }, tz)}) on the roster.
          </p>
        )}
        {!handing && (
          <ChipGroup label="Who's next" optional>
            {people
              .filter((p) => p.email !== who)
              .map((p) => (
                <Chip key={p.email} selected={next === p.email} onClick={() => setNext(next === p.email ? null : p.email)}>
                  {name(p.email)}
                </Chip>
              ))}
          </ChipGroup>
        )}
        {!handing &&
          (sleeping ? (
            <p className={cx(tone.muted, "text-[14px]")}>
              Asleep since {formatTime(sleeping.started_at, tz)}
              {(sleeping.data as { place?: SleepPlace }).place ? ` (${SLEEP_PLACE_LABEL[(sleeping.data as { place: SleepPlace }).place].toLowerCase()})` : ""}. That sleep carries on through this turn.
            </p>
          ) : (
            <ChipGroup label="Already asleep?" optional>
              <Chip selected={asleep} onClick={() => setAsleep(!asleep)}>
                Asleep in arms
              </Chip>
            </ChipGroup>
          ))}
        {!handing && asleep && !sleeping && (
          <p className={cx(tone.muted, "-mt-2 text-[13px] leading-snug")}>
            Logs {v.their} sleep in arms from now. It carries on through handoffs; laying {v.them} in the bassinet puts the try on it, and ending the turn with {v.them} awake stops it.
          </p>
        )}
        <ContextNote>
          Every phone shows who&apos;s holding {v.them}. At the planned time, the holder&apos;s and the next person&apos;s phones hear it if their handoff reminders are on (Notifications), though a notice can be late. If you start to feel sleepy before then, lay {v.them} in the bassinet or wake someone.
        </ContextNote>
      </div>
    </Sheet>
  );
}

// ── the catch-up, for whoever just took over ─────────────────────────────

/**
 * "I've got her": what the person taking over needs at 3 AM, from the log:
 * the last feed and the next side, the last diaper, and what's running, with
 * the next planned handoff. Undo puts the turn back with the person who had her.
 */
export function CatchUpSheet({ started, ended, why = null, open = true, onClose }: { started: HoldingShift; ended: HoldingShift | null; why?: HandoffWhy | null; open?: boolean; onClose: () => void }) {
  const { state, summary, memberName } = useMaple();
  const s = useSleep();
  const v = useVoice();
  const now = useNow(30_000);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const lines = catchUpLines({ summary, now, tz, v, me: state?.me.email ?? "", memberName, next: started.handoff_at, nextHolder: started.next_holder, why });
  const undo = async () => {
    if (ended && (await s.undoTakeOver(started, ended))) onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`You have ${v.name}`}
      subtitle={ended ? `Taken over from ${memberName(ended.holder)} at ${formatTime(started.started_at, tz)}` : `Since ${formatTime(started.started_at, tz)}`}
      footer={
        <div className="flex items-center gap-3">
          {ended && (
            <Button variant="ghost" size="lg" disabled={s.busy} onClick={() => void undo()}>
              Undo
            </Button>
          )}
          <Button size="lg" className="flex-1" onClick={onClose}>
            Done
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className={cx(tone.label)}>Catch-up</p>
        <ul aria-label="Catch-up" className={cx(tone.card, tone.divide, "overflow-hidden")}>
          {lines.map((l) => (
            <li key={l.label} className="flex min-h-[52px] items-start gap-3 px-4 py-2.5">
              <span className="w-20 shrink-0 pt-px text-[13px] font-medium text-mp-ink-2">{l.label}</span>
              <span className="min-w-0 flex-1 text-[15px] leading-snug text-mp-ink">{l.text}</span>
            </li>
          ))}
        </ul>
        <ContextNote icon="moon">{sleepyLine(v)}</ContextNote>
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
          <ChipGroup label="How it went">
            {TRY_OUTCOMES.map((o) => (
              <Chip key={o} selected={outcome === o} onClick={() => setOutcome(o)}>
                {OUTCOME_LABEL[o]}
              </Chip>
            ))}
          </ChipGroup>
        )}
        <TagChips value={tags} onChange={setTags} />
        <ChipGroup label="Laid down by">
          {people.map((p) => (
            <Chip key={p.email} selected={by === p.email} onClick={() => setBy(p.email)}>
              {memberName(p.email)}
            </Chip>
          ))}
        </ChipGroup>
        <TryNote value={note} onChange={setNote} placeholder={`About ${v.name}'s sleep`} readOnly={readOnly} />
        {t.sleep_entry_id && <ContextNote>This try sits on {v.their} sleep in the log, so that sleep is counted once. Moving the laid-down time moves that sleep&apos;s start too when they matched.</ContextNote>}
      </fieldset>
    </Sheet>
  );
}

// ── Log an earlier try ───────────────────────────────────────────────────

/**
 * A try nobody tapped Put down for, usually last night's, logged the morning
 * after: one tap on a sleep already in the log fills both times; a clock
 * still ahead today reads as last night's; a likely twin asks in the footer
 * (Same one, close / Save anyway) before anything is saved.
 */
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
  // Last night's sleeps in the log (the last 18 hours, at least 5 minutes) that no try sits on yet, newest first.
  const t0 = now().getTime();
  const onTry = new Set(s.data.tries.map((t) => t.sleep_entry_id).filter((x): x is number => x != null));
  const logged = (state?.entries ?? [])
    .filter((e) => e.kind === "sleep" && !e.active && !!e.ended_at && !onTry.has(e.id) && t0 - Date.parse(e.started_at) <= 18 * HOUR && Date.parse(e.ended_at) - Date.parse(e.started_at) >= 5 * MIN)
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
    .slice(0, 4);
  // A chip's times fold the two time fields into one line, so How it went is in view (Change times opens them again).
  const [filled, setFilled] = useState(false);
  const fill = (e: Entry) => {
    setStart(new Date(e.started_at));
    setEnd(new Date(e.ended_at!));
    setTwin(null);
    setBadStart(false);
    setBadEnd(false);
    setFilled(true);
  };
  const bad = badStart || badEnd || end.getTime() <= start.getTime() || end.getTime() > t0 + MIN;
  const save = async (allowDuplicate = false) => {
    if (!outcome) return;
    const r = await s.logTry({ start, end, outcome, tags, note: note.trim() || null, putDownBy: by, allowDuplicate });
    if (!r) return;
    if ("duplicate" in r) return setTwin(r.duplicate);
    onClose();
  };
  const twinWords = twin ? `A try from ${formatTime(twin.started_at, tz)}${twin.outcome ? ` (${OUTCOME_LABEL[twin.outcome].toLowerCase()})` : ""} is already logged. Is this the same one? Nothing is saved yet.` : "";
  return (
    <Sheet
      open={open}
      dirty={!!outcome || !!note.trim()}
      onClose={onClose}
      title="Log an earlier try"
      subtitle="A bassinet try nobody started on the app"
      footer={
        twin ? (
          // The question sits by the buttons it's about, so a second tap on Save can't save a twin unseen.
          <div>
            <p role="alert" className="mb-2.5 text-center text-[14px] leading-snug text-mp-ink">
              {twinWords}
            </p>
            <div className="flex gap-3">
              <Button variant="soft" size="lg" className="flex-1" onClick={onClose}>
                Same one, close
              </Button>
              <Button size="lg" className="flex-1" disabled={s.busy} onClick={() => void save(true)}>
                Save anyway
              </Button>
            </div>
          </div>
        ) : (
          <SheetFooter onClose={onClose} onPrimary={() => void save()} label="Save" disabled={!outcome || bad || s.busy} busy={s.busy} hint={!outcome ? "Choose how it went to save." : undefined} />
        )
      }
    >
      <fieldset disabled={s.busy} className="min-w-0 space-y-5">
        {logged.length > 0 && (
          <div>
            <ChipGroup label="From the log">
              {logged.map((e) => {
                const on = Math.abs(start.getTime() - Date.parse(e.started_at)) < MIN && Math.abs(end.getTime() - Date.parse(e.ended_at!)) < MIN;
                const place = (e.data as { place?: SleepPlace }).place;
                return (
                  <Chip key={e.id} selected={on} onClick={() => fill(e)} aria-label={`Sleep ${formatTime(e.started_at, tz)} to ${formatTime(e.ended_at!, tz)}${place ? `, ${SLEEP_PLACE_LABEL[place].toLowerCase()}` : ""}: use these times`}>
                    {formatTime(e.started_at, tz)}–{formatTime(e.ended_at!, tz)}
                  </Chip>
                );
              })}
            </ChipGroup>
            <p className={cx(tone.faint, "mt-1.5 text-[13px]")}>One tap fills both times from a sleep already logged.</p>
          </div>
        )}
        {filled ? (
          <div className={cx(tone.inset, "flex items-center gap-2 py-1 pr-1 pl-3")} data-try-times>
            <p className="min-w-0 flex-1 text-[15px] leading-snug text-mp-ink">
              Laid down {formatTimeNear(start, end, tz)}, ended {formatTime(end, tz)}
            </p>
            <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setFilled(false)}>
              Change times
            </Button>
          </div>
        ) : (
          <>
            <RecordedTimeField label="Laid down" value={start} onChange={moveStart} tz={tz} max={end} onInvalidChange={setBadStart} lastNight />
            <RecordedTimeField label="Ended" value={end} onChange={moveEnd} tz={tz} min={start} onInvalidChange={setBadEnd} lastNight />
          </>
        )}
        <ChipGroup label="How it went">
          {TRY_OUTCOMES.map((o) => (
            <Chip key={o} selected={outcome === o} onClick={() => (setOutcome(o), setTwin(null))}>
              {OUTCOME_LABEL[o]}
            </Chip>
          ))}
        </ChipGroup>
        <TagChips value={tags} onChange={setTags} />
        <ChipGroup label="Laid down by">
          {people.map((p) => (
            <Chip key={p.email} selected={by === p.email} onClick={() => setBy(p.email)}>
              {p.email === me ? "Me" : memberName(p.email)}
            </Chip>
          ))}
        </ChipGroup>
        <TryNote value={note} onChange={setNote} placeholder={`About ${v.name}'s sleep`} />
        <ContextNote>It sits on {v.their} sleep in the log at that time, or adds that sleep, so nothing is counted twice.</ContextNote>
      </fieldset>
    </Sheet>
  );
}

// ── the host ─────────────────────────────────────────────────────────────

/**
 * The open sleep sheet, mounted by SleepProvider (MapleApp). The last one
 * stays mounted while it slides away; each sheet reads its try, shift or
 * goal fresh from the shared state, and one whose try or shift another
 * phone already closed or deleted closes with a word. A goal's form and a
 * check-in opened from the plan's Goals go back there when they close.
 */
export function SleepSheetHost({ api }: { api: SleepApi }) {
  const { toast } = useMaple();
  const [last, setLast] = useState<SleepSheet | null>(api.sheet);
  if (api.sheet && api.sheet !== last) setLast(api.sheet);
  const shown = api.sheet ?? last;
  const open = !!api.sheet;
  const find = (id: number) => api.data.tries.find((t) => t.id === id) ?? null;
  const t = shown && (shown.kind === "outcome" || shown.kind === "try") ? find(shown.tryId) : null;
  const goal = shown?.kind === "goal" && shown.goalId != null ? (api.goals.find((g) => g.id === shown.goalId) ?? null) : null;
  // Gone while open: finished on another phone (How did it go?), deleted, the shift handed over elsewhere, or a goal no longer there.
  const gone =
    !!shown &&
    ((shown.kind === "outcome" && (!t || !!t.ended_at)) ||
      (shown.kind === "try" && !t) ||
      (shown.kind === "holding" && shown.mode === "handoff" && !api.shift) ||
      (shown.kind === "goal" && shown.goalId != null && !goal));
  const closeSheet = api.closeSheet;
  const openSheet = api.openSheet;
  const toGoals = useCallback(() => openSheet({ kind: "plan", tab: "goals" }), [openSheet]);
  // This phone's own Save, outcome or Delete closes its sheet itself: only a change from elsewhere says so.
  const quiet = !!shown && "tryId" in shown && api.endedHere(shown.tryId);
  useEffect(() => {
    if (!open || !gone) return;
    closeSheet();
    if (quiet) return;
    toast(
      shown?.kind === "holding"
        ? "That shift already ended."
        : shown?.kind === "goal"
          ? "That sleep goal isn't there anymore."
          : t?.ended_at
            ? `That try already ended: ${OUTCOME_LABEL[t.outcome!].toLowerCase()}.`
            : "That try isn't in the log anymore.",
      { tone: "info" }
    );
  }, [open, gone, quiet, closeSheet, shown?.kind, t?.ended_at, t?.outcome, toast]);
  if (!shown || (gone && open)) return null;
  const key = (x: string) => `${x}-${shown.kind}-${"tryId" in shown ? shown.tryId : ""}`;
  switch (shown.kind) {
    case "plan":
      return <SleepPlanSheet key={key("plan")} tab={shown.tab} open={open} onClose={closeSheet} />;
    case "goal":
      return shown.goalId != null && !goal ? null : <GoalFormSheet key={key(`g${shown.goalId ?? "new"}`)} goal={goal} open={open} onClose={toGoals} />;
    case "checkin":
      return <CheckinSheet key={key(`c${shown.night ?? ""}`)} night={shown.night} open={open} onClose={shown.back === "goals" ? toGoals : closeSheet} />;
    case "outcome":
      return t ? <OutcomeSheet key={key("o")} t={t} defaultAt={shown.at} details={shown.details} open={open} onClose={closeSheet} /> : null;
    case "try":
      return t ? <TrySheet key={key("t")} t={t} open={open} onClose={closeSheet} /> : null;
    case "sleepy":
      return <SleepySheet key={key("s")} open={open} onClose={closeSheet} />;
    case "holding":
      return <HoldingSheet key={key(`h-${shown.mode}`)} mode={shown.mode} to={shown.to} open={open} onClose={closeSheet} />;
    case "log":
      return <LogTrySheet key={key("l")} open={open} onClose={closeSheet} />;
    case "catchup":
      return <CatchUpSheet key={key(`cu-${shown.started.id}`)} started={shown.started} ended={shown.ended} why={shown.why ?? null} open={open} onClose={closeSheet} />;
  }
}
