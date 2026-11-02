"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { sleepAge } from "@/lib/maple/sleep/engine";
import { SleepInputError } from "@/lib/maple/sleep/errors";
import {
  againstAim,
  BACK_TO_WORK_AFTER_DAYS,
  backToWorkGoal,
  backToWorkQuestions,
  cleanGoalInput,
  goalAdults,
  goalCautions,
  goalsByUrgency,
  goalSpan,
  goalStartKey,
  goalWeekLabel,
  lastNightKey,
  nextStepNow,
  noCheckinWords,
  observationWords,
  QUICK_FEEDING,
  QUICK_NIGHT,
  QUICK_OFF_DUTY,
  QUICK_SLEEPS,
  rosterHintBody,
  weekOngoing,
  type CoachNotes,
  type GoalFields,
  type GoalProgress,
  type GoalSpan,
  type GoalWeek,
  type NightsWeek,
  type QuickFeeding,
  type QuickOffDuty,
  type QuickSleeps,
  type StretchWeek,
  type WeekCoverage,
  type WindowWeek,
} from "@/lib/maple/sleep/goals";
import { GOAL_AHEAD_DAYS, GOAL_NOTE_MAX, GOALS_OPEN_MAX, type BassinetNightsTarget, type BassinetStretchTarget, type GoalInput, type GoalStep, type ProtectedWindowTarget, type SleepGoal } from "@/lib/maple/sleep/types";
import { coversHint, dateWords, GOAL_STATUS_LABEL, minutesWords, nightsLabel, PROTECTED_LABEL, shortClock, TARGET_KIND_LABEL, targetWords, windowTimes } from "@/lib/maple/sleep/words";
import { addDays, dayKey, DEFAULT_TZ, formatDuration, isDayKey } from "@/lib/maple/time";
import { AskChatButton } from "../chat/AskChat";
import { useVoice } from "../familyWords";
import { Icon } from "../icons";
import { Label } from "../sheets/parts";
import { Button, Chip, cx, TextArea, tone } from "../ui";
import { useMaple } from "../useMaple";
import { useSleep } from "./useSleep";

/**
 * The plan sheet's Goals: each open sleep goal with its target date and
 * days left, every target as counts with what they're out of (this week,
 * then the earlier weeks), the weekly steps as a checklist, the night
 * roster with hints from the log, and, for owners and members only, each
 * adult's check-ins. Counts come from GET /api/maple/sleep?view=goals
 * (goals.ts goalProgress on the server, over the whole goal); everything
 * else reads the shared state, so a step or a check-in shows at once.
 *
 * Neutral words throughout: a count and its sample, never a score, a
 * streak, a grade or a "best"; a hard night is just counted. View-only
 * guests see the goals, steps, roster and the baby's numbers, never a
 * check-in, and nothing that writes. With no goal yet, a family with two
 * adults can plan for going back to work in five questions (QuickSetup).
 */

type GoalView = { goal: SleepGoal; progress: GoalProgress; coach: CoachNotes; lines: string[] };

/** The chat's sleep tools load on words like "sleep goal" (chat/tool-groups.ts), so both seeded messages say it. */
const SET_PROMPT = "Help us set a sleep goal: what we're working toward, a few small weekly steps, and who sleeps when.";
const reviewPrompt = (g: SleepGoal) => `Let's review our sleep goal: ${g.title}`;
const askPrompt = (g: SleepGoal) => `How is our sleep goal going: ${g.title}?`;

const isOpen = (g: SleepGoal) => g.status === "active" || g.status === "paused";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const answers = (c: { yes: number; partly: number; no: number }) =>
  (["yes", "partly", "no"] as const)
    .filter((a) => c[a])
    .map((a) => `${PROTECTED_LABEL[a].toLowerCase()} ${c[a]}`)
    .join(", ");

/** Each open goal's progress from the server, read again whenever a goal, a check-in, a try or the state moves on. */
function useGoalsView(wanted: boolean): { views: GoalView[] | null; failed: boolean } {
  const { api, state } = useMaple();
  const s = useSleep();
  const key = useMemo(
    () =>
      [state?.rev ?? "", ...s.goals.map((g) => `g${g.id}:${g.revision}`), ...(s.checkins ?? []).map((c) => `c${c.id}:${c.updated_at}`), ...s.data.tries.map((t) => `t${t.id}:${t.updated_at}`)].join("|"),
    [s.checkins, s.data.tries, s.goals, state?.rev]
  );
  const [views, setViews] = useState<GoalView[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    api<{ goals?: GoalView[] }>("/api/maple/sleep?view=goals")
      .then((r) => {
        if (!live) return;
        setViews(r.goals ?? []);
        setFailed(false);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [api, key, wanted]);
  return { views, failed };
}

export function GoalsPart() {
  const s = useSleep();
  const { state, now } = useMaple();
  // Most urgent first: active, then paused; the nearest target date, then a review due, then the newest (as the coach reads them).
  const open = goalsByUrgency(s.goals.filter(isOpen), now(), state?.baby.timezone ?? DEFAULT_TZ);
  const closed = s.goals.filter((g) => !isOpen(g));
  const { views, failed } = useGoalsView(open.length > 0);
  return (
    <div className="space-y-5">
      {open.length === 0 ? (
        <NoGoals />
      ) : (
        open.map((g) => <GoalCard key={g.id} goal={g} view={views?.find((x) => x.goal.id === g.id) ?? null} failed={failed && !views} />)
      )}
      {open.length > 0 && s.canWrite && open.length < GOALS_OPEN_MAX && (
        <div className="flex flex-wrap items-center gap-x-1">
          <AskChatButton prompt={SET_PROMPT} label="Sleep goal" onOpened={s.closeSheet}>
            Set another with Maple
          </AskChatButton>
          <Button variant="ghost" size="sm" onClick={() => s.openSheet({ kind: "goal" })}>
            <Icon name="plus" size={16} /> Set one yourself
          </Button>
        </div>
      )}
      {closed.length > 0 && <ClosedGoals goals={closed} />}
      <p className={cx(tone.faint, "px-1 text-[12px] leading-relaxed")}>Every night is different. These are counts of what was logged, so a night nobody logged isn&apos;t in them.</p>
    </div>
  );
}

function NoGoals() {
  const s = useSleep();
  const v = useVoice();
  const people = useQuickPeople();
  const [quick, setQuick] = useState(false);
  return (
    <div className="space-y-3">
      <div className={cx(tone.inset, "space-y-2 px-4 py-3.5")}>
        <p className={cx(tone.heading, "text-[16px]")}>Sleep goals</p>
        <p className={cx(tone.body, "text-[15px] leading-relaxed")}>
          Something to work toward together, like {v.name} sleeping longer in the bassinet, or a protected stretch of sleep for each of you, with small steps each week. Maple counts what you log against it.
        </p>
        {s.canWrite && (
          <div className="-ml-3">
            <AskChatButton prompt={SET_PROMPT} label="Sleep goal" onOpened={s.closeSheet}>
              Set a goal with Maple
            </AskChatButton>
          </div>
        )}
      </div>
      {/* Two adults who log: the night splits between them, so the quick setup has someone for each half. */}
      {s.canWrite && people.length >= 2 &&
        (quick ? (
          <QuickSetup onClose={() => setQuick(false)} />
        ) : (
          <div className={cx(tone.inset, "space-y-2 px-4 py-3.5")}>
            <p className={cx(tone.heading, "text-[16px]")}>Going back to work?</p>
            <p className={cx(tone.body, "text-[15px] leading-relaxed")}>Five quick questions, then one plan to read over: a protected stretch of sleep for each of you, who&apos;s on for each half of the night, and three steps timed from the day back.</p>
            <Button variant="soft" className="w-full" onClick={() => setQuick(true)}>
              Plan for going back to work
            </Button>
          </div>
        ))}
      {s.canWrite ? (
        <Button variant="soft" className="w-full" onClick={() => s.openSheet({ kind: "goal" })}>
          <Icon name="plus" size={18} /> Set one yourself
        </Button>
      ) : (
        <p className={cx(tone.faint, "px-1 text-[13px]")}>No sleep goals yet.</p>
      )}
    </div>
  );
}

// ── the "Back to work" quick setup: five questions, one goal to read back ──

type QuickAnswers = {
  returning: string | null;
  return_date: string;
  feeding: QuickFeeding | null;
  nursing: string | null;
  sleeps: QuickSleeps | null;
  first_half: string | null;
  second_half: string | null;
  off_duty: QuickOffDuty | null;
  target_date: string;
};

const FEEDING_LABEL: Record<QuickFeeding, string> = { nursing: "Nursing", bottles: "Bottles", both: "Both" };
const SLEEPS_LABEL: Record<QuickSleeps, string> = { bassinet: "Bassinet", crib: "Crib", arms: "In arms", bed: "Our bed", mixed: "A mix" };
const OFF_DUTY_LABEL: Record<QuickOffDuty, string> = { other_room: "Another room", same_room: "The same room" };

/** The adults who can each take half a night (owners and members, never the shared admin login), the signed-in one first. */
function useQuickPeople() {
  const { state } = useMaple();
  const s = useSleep();
  return useMemo(() => {
    const list = (state?.members ?? []).filter((m) => (m.role === "owner" || m.role === "member") && m.email !== "admin");
    return [...list.filter((m) => m.email === s.me), ...list.filter((m) => m.email !== s.me)];
  }, [s.me, state?.members]);
}

function Choices<T extends string>({ label, options, value, onPick }: { label: string; options: { value: T; label: string }[]; value: T | null; onPick: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <Chip key={o.value} raised selected={value === o.value} onClick={() => onPick(o.value)}>
          {o.label}
        </Chip>
      ))}
    </div>
  );
}

/**
 * Five questions, one at a time, as Postpartum Support International's plan
 * asks them: who goes back to work and when; nursing, bottles or both (and
 * who nurses); where the baby sleeps now; who's on duty for each half of the
 * night and where the adult who's off sleeps; the target date. Then one
 * read-back (goals.ts backToWorkGoal): a goal, a night roster with each
 * window's feeds covered, and three steps timed from the day back, saved on
 * Save the goal with no logs needed first. Nothing is kept until then.
 */
function QuickSetup({ onClose }: { onClose: () => void }) {
  const s = useSleep();
  const { state, memberName, now } = useMaple();
  const v = useVoice();
  const people = useQuickPeople();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const today = dayKey(now(), tz);
  const adults = useMemo(() => new Set(people.map((p) => p.email)), [people]);
  const label = (id: string) => (id === s.me ? "Me" : memberName(id));
  const [step, setStep] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [a, setA] = useState<QuickAnswers>({ returning: null, return_date: "", feeding: null, nursing: null, sleeps: null, first_half: null, second_half: null, off_duty: null, target_date: "" });
  const set = (patch: Partial<QuickAnswers>) => {
    setA((x) => ({ ...x, ...patch }));
    setProblem(null);
  };
  const other = (id: string | null) => people.find((p) => p.email !== id)?.email ?? null;
  const asked = [
    a.returning && isDayKey(a.return_date),
    a.feeding && (a.feeding === "bottles" || a.nursing),
    a.sleeps,
    a.first_half && a.second_half && a.first_half !== a.second_half && a.off_duty,
    isDayKey(a.target_date),
  ];
  const questions = backToWorkQuestions(v);
  const next = () => {
    // Defaults for what comes next: the one going back is on first, so they sleep the second half; two weeks after the day back.
    if (step === 0 && !a.first_half) set({ first_half: a.returning, second_half: other(a.returning) });
    if (step === 0 && !a.target_date && isDayKey(a.return_date)) set({ target_date: addDays(a.return_date, BACK_TO_WORK_AFTER_DAYS) });
    setStep((n) => n + 1);
  };
  let built: { goal: GoalInput; notes: string[] } | null = null;
  let fields: GoalFields | null = null;
  let error: string | null = null;
  if (step === 5) {
    try {
      built = backToWorkGoal(
        { returning: a.returning!, return_date: a.return_date, feeding: a.feeding!, nursing: a.nursing, sleeps: a.sleeps!, first_half: a.first_half!, second_half: a.second_half!, off_duty: a.off_duty!, target_date: a.target_date || null },
        { v, name: memberName, today, adults }
      );
      fields = cleanGoalInput(built.goal, { current: null, adults, name: memberName, today, seq: 0, v }, "create").fields;
    } catch (err) {
      if (!(err instanceof SleepInputError)) throw err;
      error = err.message;
    }
  }
  const age = state ? sleepAge(state.baby, now()) : null;
  const cautions = fields ? goalCautions(fields, { v, name: memberName, ageDays: state?.baby.born_at ? (age?.days ?? null) : null, adults: people.map((p) => memberName(p.email)) }) : [];
  const save = async () => {
    if (!built) return;
    const r = await s.createGoal(built.goal);
    if (!r) return;
    if ("saved" in r) return onClose();
    if ("problem" in r) setProblem(r.problem);
  };
  const half = (n: 1 | 2) => `${n === 1 ? "First" : "Second"} half, ${shortClock(n === 1 ? QUICK_NIGHT.from : QUICK_NIGHT.split)}–${shortClock(n === 1 ? QUICK_NIGHT.split : QUICK_NIGHT.to)}`;
  return (
    <section aria-label="Plan for going back to work" className={cx(tone.inset, "space-y-4 px-4 py-4")}>
      {step < 5 ? (
        <>
          <div className="space-y-1">
            <p className={cx(tone.faint, "text-[12px] font-medium tabular-nums")}>Question {step + 1} of 5</p>
            <p className={cx(tone.heading, "text-[16px] leading-snug")}>{questions[step]}</p>
          </div>
          {step === 0 && (
            <div className="space-y-3">
              <Choices label="Who goes back to work" options={people.map((p) => ({ value: p.email, label: label(p.email) }))} value={a.returning} onPick={(x) => set({ returning: x })} />
              <label className="block">
                <span className={cx(tone.label, "mb-1.5 block")}>The day back</span>
                <input type="date" aria-label="The day back at work" value={a.return_date} min={today} max={addDays(today, GOAL_AHEAD_DAYS)} onChange={(e) => set({ return_date: e.target.value })} className={tone.input} />
              </label>
            </div>
          )}
          {step === 1 && (
            <div className="space-y-3">
              <Choices label={`How ${v.name} is fed`} options={QUICK_FEEDING.map((x) => ({ value: x, label: FEEDING_LABEL[x] }))} value={a.feeding} onPick={(x) => set({ feeding: x, ...(x === "bottles" ? { nursing: null } : {}) })} />
              {a.feeding && a.feeding !== "bottles" && (
                <div>
                  <Label>Who nurses</Label>
                  <Choices label="Who nurses" options={people.map((p) => ({ value: p.email, label: label(p.email) }))} value={a.nursing} onPick={(x) => set({ nursing: x })} />
                </div>
              )}
            </div>
          )}
          {step === 2 && <Choices label={`Where ${v.name} sleeps now`} options={QUICK_SLEEPS.map((x) => ({ value: x, label: SLEEPS_LABEL[x] }))} value={a.sleeps} onPick={(x) => set({ sleeps: x })} />}
          {step === 3 && (
            <div className="space-y-3">
              {([1, 2] as const).map((n) => (
                <div key={n}>
                  <Label>{half(n)}</Label>
                  <Choices
                    label={`On duty for the ${n === 1 ? "first" : "second"} half`}
                    options={people.map((p) => ({ value: p.email, label: label(p.email) }))}
                    value={n === 1 ? a.first_half : a.second_half}
                    onPick={(x) => set(n === 1 ? { first_half: x, ...(a.second_half === x ? { second_half: other(x) } : {}) } : { second_half: x, ...(a.first_half === x ? { first_half: other(x) } : {}) })}
                  />
                </div>
              ))}
              <p className={cx(tone.muted, "text-[13px] leading-snug")}>Whoever&apos;s on duty for one half sleeps the other, as a protected window.</p>
              <div>
                <Label>Where the adult who&apos;s off sleeps</Label>
                <Choices label="Where the adult who's off sleeps" options={QUICK_OFF_DUTY.map((x) => ({ value: x, label: OFF_DUTY_LABEL[x] }))} value={a.off_duty} onPick={(x) => set({ off_duty: x })} />
              </div>
            </div>
          )}
          {step === 4 && (
            <label className="block">
              <span className={cx(tone.label, "mb-1.5 block")}>Target date</span>
              <input type="date" aria-label="Target date" value={a.target_date} min={today} max={addDays(today, GOAL_AHEAD_DAYS)} onChange={(e) => set({ target_date: e.target.value })} className={tone.input} />
              {isDayKey(a.target_date) && <span className={cx(tone.muted, "mt-1.5 block text-[13px]")}>{dateWords(a.target_date, today)}</span>}
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={!asked[step]} onClick={next}>
              {step === 4 ? "See the plan" : "Next"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => (step ? setStep((n) => n - 1) : onClose())}>
              {step ? "Back" : "Not now"}
            </Button>
          </div>
        </>
      ) : (
        <QuickReadBack built={built} fields={fields} error={error ?? problem} notes={built?.notes ?? []} cautions={cautions.map((c) => c.text)} onSave={() => void save()} onBack={() => setStep(4)} busy={s.busy} today={today} />
      )}
    </section>
  );
}

function QuickReadBack({ built, fields, error, notes, cautions, onSave, onBack, busy, today }: { built: { goal: GoalInput } | null; fields: GoalFields | null; error: string | null; notes: string[]; cautions: string[]; onSave: () => void; onBack: () => void; busy: boolean; today: string }) {
  const { memberName } = useMaple();
  const v = useVoice();
  return (
    <div className="space-y-4" aria-label="The plan, to read over">
      <div className="space-y-1">
        <p className={cx(tone.faint, "text-[12px] font-medium")}>Here&apos;s the plan. Nothing is saved until you save it.</p>
        {fields?.title && <p className={cx(tone.heading, "text-[17px] leading-snug break-words")}>{fields.title}</p>}
        {fields?.why && <p className={cx(tone.muted, "text-[14px] leading-snug")}>{fields.why}</p>}
        {fields?.target_date && <p className={cx(tone.body, "text-[14px]")}>Target date {dateWords(fields.target_date, today)}</p>}
      </div>
      {fields && (
        <>
          <Block title="Targets">
            <ul className="space-y-1 text-[15px] leading-snug text-mp-ink">
              {(fields.targets ?? []).map((t) => (
                <li key={t.id}>{capital(targetWords(t, memberName))}</li>
              ))}
            </ul>
          </Block>
          <Block title="Night roster">
            <ul className="space-y-2">
              {(fields.roster ?? []).map((w) => (
                <li key={w.id} className="space-y-0.5">
                  <p className="text-[15px] leading-snug text-mp-ink">
                    <span className="font-semibold">{memberName(w.member)}</span> <span className="whitespace-nowrap tabular-nums">{windowTimes(w)}</span>
                  </p>
                  <p className="text-[13px] text-mp-ink-2">
                    {capital(nightsLabel(w.nights))}
                    {w.covers ? ` · ${coversHint(w.covers, v)}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </Block>
          <Block title="Weekly steps">
            <ol className="space-y-1.5">
              {(fields.steps ?? []).map((st) => (
                <li key={st.id} className="text-[15px] leading-snug text-mp-ink">
                  {st.title}
                  {st.week_of && <span className="block text-[12px] text-mp-ink-2">Week of {dateWords(st.week_of, today)}</span>}
                </li>
              ))}
            </ol>
          </Block>
        </>
      )}
      {[...notes, ...cautions].map((n) => (
        <p key={n} role="note" className={cx(tone.muted, "flex gap-2 text-[13px] leading-relaxed")}>
          <Icon name="info" size={16} className="mt-[2px] shrink-0 text-mp-ink-3" />
          <span>{n}</span>
        </p>
      ))}
      {error && (
        <p role="alert" data-goal-problem className="text-[13px] font-semibold text-mp-danger">
          {error}
        </p>
      )}
      <p className={cx(tone.faint, "text-[12px] leading-relaxed")}>You can change any of it after saving, with Edit.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!built || !fields || busy} onClick={onSave}>
          Save the goal
        </Button>
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}


/** No break inside "Thu, Nov 26", "21 days left" or "week 2 of 5" on a narrow phone. */
const keep = (s: string) => s.replace(/ /g, "\u00a0");

/** "Target date Thu, Nov 26 · 21 days left · week 2 of 5", "No target date · week 2". */
function whenWords(p: GoalSpan): string {
  if (!p.endsOn) return `No target date${p.weekNow ? ` · ${keep(`week ${p.weekNow}`)}` : ""}`;
  const d = keep(dateWords(p.endsOn, p.today));
  const left = p.daysLeft ?? 0;
  const head = left > 0 ? `Target date ${d} · ${keep(`${plural(left, "day")} left`)}` : left === 0 ? `Target date today, ${d}` : `Target date ${d}, ${keep(`${plural(-left, "day")} ago`)}`;
  return `${head}${p.weekNow ? ` · ${keep(`week ${p.weekNow} of ${p.weeksTotal}`)}` : ""}`;
}

/** The week whose coverage the card shows: this week once one of its nights is over, else the one before. */
function shownCoverage(p: GoalProgress): { c: WeekCoverage; w: GoalWeek } | null {
  for (const w of [...p.weeks].reverse()) {
    const c = p.coverage.find((x) => x.week === w.n);
    if (c && c.over > 0) return { c, w };
  }
  return null;
}

/** "Logged this week: something on 5 of 7 nights (2 partly) · feeds on 4 · tries on 2 · check-ins on 4". */
function coverageLine(c: WeekCoverage, w: GoalWeek, p: GoalProgress): string {
  const some = c.logged + c.partly;
  return [
    // Never "partly" here: that's a check-in's answer.
    `Logged ${weekLabel(w, p).toLowerCase()}: something on ${some} of ${plural(c.over, "night")}${c.partly ? ` (${c.partly} with a gap of 4 hours or more)` : ""}`,
    `feeds on ${c.feedNights}`,
    `tries on ${c.tryNights}`,
    ...(c.checkinNights != null ? [`check-ins on ${c.checkinNights}`] : []),
  ].join(" · ");
}

function GoalCard({ goal, view, failed }: { goal: SleepGoal; view: GoalView | null; failed: boolean }) {
  const s = useSleep();
  const { state, now, memberName } = useMaple();
  const v = useVoice();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const span = goalSpan(goal, now(), tz);
  const p = view?.progress ?? null;
  const [closing, setClosing] = useState(false);
  const cov = p?.coverage ? shownCoverage(p) : null;
  // Fewer than half the nights logged: the counts are from those few, said first.
  const sparse = !!cov && (cov.c.logged + cov.c.partly) * 2 < cov.c.over;
  // What the targets and the roster need said with them: feeds first in the first 4 weeks, and a long window's feeds.
  const age = state ? sleepAge(state.baby, now()) : null;
  // The adults' names, as the server's rules read them ("while Theo is awake"), so the card says the same cautions.
  const adults = (state?.members ?? []).filter((m) => m.role === "owner" || m.role === "member").map((m) => memberName(m.email));
  const cautions = goal.status === "active" ? goalCautions(goal, { v, name: memberName, ageDays: state?.baby.born_at ? (age?.days ?? null) : null, adults }).filter((c) => c.kind !== "feeding") : [];
  return (
    <section aria-labelledby={`goal-${goal.id}`} className={cx(tone.card, "space-y-5 px-4 py-4")}>
      <header className="space-y-1">
        <div className="flex items-start justify-between gap-2">
          <h3 id={`goal-${goal.id}`} className={cx(tone.heading, "min-w-0 text-[18px] leading-snug break-words")}>
            {goal.title}
          </h3>
          {goal.status === "paused" && <span className="mt-0.5 shrink-0 rounded-full bg-mp-sunken px-2.5 py-0.5 text-[12px] font-medium text-mp-ink-2">{GOAL_STATUS_LABEL.paused}</span>}
        </div>
        {goal.why && <p className={cx(tone.muted, "text-[15px] leading-snug break-words")}>{goal.why}</p>}
        <p className={cx(tone.body, "text-[14px] tabular-nums")}>{whenWords(span)}</p>
      </header>

      {sparse && cov && (
        <p role="note" data-goal-coverage className={cx(tone.inset, "px-3.5 py-3 text-[14px] leading-snug text-mp-ink")}>
          Only {cov.c.logged + cov.c.partly} of the {plural(cov.c.over, "night")} {weekLabel(cov.w, p!).toLowerCase()} {cov.c.logged + cov.c.partly === 1 ? "has" : "have"} anything logged, so the counts below come from {cov.c.logged + cov.c.partly === 1 ? "that night" : "those"}. A night with nothing logged isn&apos;t counted either way.
        </p>
      )}
      {cautions.map((c) => (
        <p key={c.kind + c.text} role="note" className={cx(tone.muted, "flex gap-2 text-[13px] leading-relaxed")}>
          <Icon name="info" size={16} className="mt-[2px] shrink-0 text-mp-ink-3" />
          <span>{c.text}</span>
        </p>
      ))}

      <Block title="Targets">
        {goal.targets.length ? (
          <div className="space-y-4">
            {goal.targets.map((t) => (
              <TargetRow key={t.id} goal={goal} id={t.id} p={p} failed={failed} />
            ))}
          </div>
        ) : (
          <p className={cx(tone.muted, "text-[14px]")}>No targets yet.</p>
        )}
        {cov && !sparse && (
          <p data-goal-coverage className="pt-1 text-[13px] leading-snug text-mp-ink-2 tabular-nums">
            {coverageLine(cov.c, cov.w, p!)}
          </p>
        )}
      </Block>

      <Steps goal={goal} />
      <Roster goal={goal} p={p} />
      {s.seesCheckins && <Checkins goal={goal} p={p} />}

      <div className="-mx-1 flex flex-wrap items-center gap-x-1 border-t border-mp-line pt-2">
        {s.canWrite ? (
          <>
            <AskChatButton prompt={reviewPrompt(goal)} label="Sleep goal" onOpened={s.closeSheet}>
              Talk it through with Maple
            </AskChatButton>
            <Button variant="ghost" size="sm" onClick={() => s.openSheet({ kind: "goal", goalId: goal.id })}>
              <Icon name="pencil" size={16} /> Edit
            </Button>
            <Button variant="ghost" size="sm" aria-expanded={closing} onClick={() => setClosing((x) => !x)}>
              Close goal
            </Button>
          </>
        ) : (
          <AskChatButton prompt={askPrompt(goal)} label="Sleep goal" onOpened={s.closeSheet}>
            Ask Maple about it
          </AskChatButton>
        )}
      </div>
      {closing && s.canWrite && <CloseGoal goal={goal} onCancel={() => setClosing(false)} />}
    </section>
  );
}

function Block({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h4 className={cx(tone.label, "flex items-baseline justify-between gap-2")}>
        {title}
        {aside && <span className="font-normal text-mp-ink-3 tabular-nums">{aside}</span>}
      </h4>
      {children}
    </section>
  );
}

// ── targets ──────────────────────────────────────────────────────────────

/** "This week", "Last week", "Week 2", or on a review morning "Week 1 (ended last night)" (goals.ts goalWeekLabel). */
const weekLabel = (w: GoalWeek, p: GoalProgress): string => goalWeekLabel(w, p);

/** The newest week in full, then up to three earlier ones compact, the rest a tap away. Every line says what it's out of. */
function Weeks<T extends { week: number }>({ p, rows, line }: { p: GoalProgress; rows: readonly T[]; line: (x: T, w: GoalWeek, p: GoalProgress) => string }) {
  const weeks = [...p.weeks].reverse().filter((w) => rows.some((x) => x.week === w.n));
  const [latest, ...earlier] = weeks;
  if (!latest) return null;
  const row = (w: GoalWeek) => rows.find((x) => x.week === w.n)!;
  const item = (w: GoalWeek) => (
    <li key={w.n}>
      {weekLabel(w, p)}: {line(row(w), w, p)}
    </li>
  );
  return (
    <div className="space-y-1">
      <p className="text-[15px] leading-snug text-mp-ink tabular-nums">
        <span className="font-semibold">{weekLabel(latest, p)}:</span> {line(row(latest), latest, p)}
      </p>
      {earlier.length > 0 && <ul className="space-y-0.5 text-[13px] leading-snug text-mp-ink-2 tabular-nums">{earlier.slice(0, 3).map(item)}</ul>}
      {earlier.length > 3 && (
        <details className="text-[13px] text-mp-ink-2">
          <summary className="inline-flex min-h-[44px] cursor-pointer list-none items-center gap-1 font-medium text-mp-accent-fg [&::-webkit-details-marker]:hidden">
            {plural(earlier.length - 3, "earlier week")}
            <Icon name="chevron-down" size={15} />
          </summary>
          <ul className="space-y-0.5 leading-snug tabular-nums">{earlier.slice(3).map(item)}</ul>
        </details>
      )}
    </div>
  );
}

/**
 * "2 of the 4 nights aimed for · 2 of 2 logged nights · 5 not logged": the
 * aim, then what the count is out of, never a night nobody logged; with every
 * night logged, "· tried on 4 of 7 nights so far".
 */
const nightsLine = (t: BassinetNightsTarget) => (x: NightsWeek, w: GoalWeek, p: GoalProgress) => {
  if (!x.nights) return "counting starts with the goal's first night";
  const counted = `${againstAim(x.counted, t.per_week)}${x.fromCheckins ? ` (${x.fromCheckins} from check-ins)` : ""}`;
  // A night with only feeds logged says nothing about the bassinet: it's among the nights not logged, and said so.
  if (x.unknown) return `${counted} · ${x.counted} of ${x.known} logged ${x.known === 1 ? "night" : "nights"} · ${x.unknown} not logged${x.feedsOnly ? ` (${x.feedsOnly} with only feeds or other entries)` : ""}`;
  return `${counted} · tried on ${x.tried} of ${plural(x.nights, "night")}${weekOngoing(w, p) ? " so far" : ""}`;
};

const stretchLine = (t: BassinetStretchTarget) => (x: StretchWeek, w: GoalWeek, p: GoalProgress) =>
  x.stretches
    ? `longest ${formatDuration(x.longestSec ?? 0)} · ${x.atLeast} of ${plural(x.stretches, "stretch", "stretches")} ${minutesWords(t.minutes)} or more`
    : `no bassinet stretches logged${weekOngoing(w, p) ? " yet" : ""}`;

/** "yes on 4 of the 5 nights aimed for · checked in 5 of 7 roster nights so far (not this time 1)": never "held", which is a holding turn's word. */
const windowLine = (t: ProtectedWindowTarget, hasWindow: boolean) => (x: WindowWeek, w: GoalWeek, p: GoalProgress): string => {
  const other = [x.partly ? `partly ${x.partly}` : "", x.no ? `not this time ${x.no}` : ""].filter(Boolean).join(", ");
  const soFar = weekOngoing(w, p) ? " so far" : "";
  if (!x.checkedIn) return `no check-ins${weekOngoing(w, p) ? " yet" : ""} · ${noCheckinWords(x, { ongoing: weekOngoing(w, p), today: p.today, hasWindow: hasWindow })}`;
  const of = x.planned ? `checked in ${x.checkedIn} of ${plural(x.planned, "roster night")}${soFar}` : `checked in ${plural(x.checkedIn, "night")}${soFar}`;
  return `yes on ${againstAim(x.yes, t.per_week)} · ${of}${other ? ` (${other})` : ""}`;
};

function TargetRow({ goal, id, p, failed }: { goal: SleepGoal; id: string; p: GoalProgress | null; failed: boolean }) {
  const { memberName } = useMaple();
  const t = goal.targets.find((x) => x.id === id)!;
  const tp = p?.targets.find((x) => x.id === id && x.kind === t.kind) ?? null;
  let counts: ReactNode = null;
  if (t.kind === "custom") counts = <p className={cx(tone.muted, "text-[13px]")}>Not counted from the log.</p>;
  else if (!p) counts = <p className={cx(tone.faint, "text-[13px]")}>{failed ? "Couldn't load the counts. They'll try again on the next refresh." : "Counting…"}</p>;
  else if (tp?.kind === "bassinet_nights") counts = <Weeks p={p} rows={tp.weeks} line={nightsLine(tp.target)} />;
  else if (tp?.kind === "bassinet_stretch")
    counts = (
      <>
        <Weeks p={p} rows={tp.weeks} line={stretchLine(tp.target)} />
        {tp.longest && <p className={cx(tone.muted, "text-[13px]")}>Longest over these weeks: {formatDuration(tp.longest.sec)}</p>}
      </>
    );
  else if (tp?.kind === "protected_window")
    counts = tp.weeks ? <Weeks p={p} rows={tp.weeks} line={windowLine(tp.target, goal.roster.some((r) => r.member === tp.target.member))} /> : <p className={cx(tone.muted, "text-[13px]")}>Counted from each adult&apos;s own morning check-ins.</p>;
  return (
    <div className="space-y-1" role="group" aria-label={TARGET_KIND_LABEL[t.kind]}>
      <p className="text-[12px] font-medium tracking-[0.01em] text-mp-ink-3">{TARGET_KIND_LABEL[t.kind]}</p>
      <p className="text-[15px] leading-snug font-medium text-mp-ink break-words">{capital(targetWords(t, memberName))}</p>
      {counts}
    </div>
  );
}

// ── steps ────────────────────────────────────────────────────────────────

function Steps({ goal }: { goal: SleepGoal }) {
  const s = useSleep();
  const { memberName, state, now } = useMaple();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const today = dayKey(now(), tz);
  const done = goal.steps.filter((x) => x.done_at).length;
  // This week's step first (the goal's week today is in), then one still open from earlier.
  const next = nextStepNow(goal.steps, goalSpan(goal, now(), tz));
  const sub = (st: GoalStep) =>
    [st.week_of ? `Week of ${dateWords(st.week_of, today)}` : "", st.done_at && st.done_by ? `Done by ${st.done_by === s.me ? "you" : memberName(st.done_by)}` : "", !st.done_at && next?.id === st.id ? "Next" : ""]
      .filter(Boolean)
      .join(" · ");
  return (
    <Block title="Weekly steps" aside={goal.steps.length ? `${done} of ${goal.steps.length} done` : undefined}>
      {goal.steps.length ? (
        <ul className={cx(tone.inset, "divide-y divide-mp-line overflow-hidden")}>
          {goal.steps.map((st) => {
            const on = !!st.done_at;
            const mark = (
              <span className={cx("flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2", on ? "border-mp-accent bg-mp-accent text-mp-on-accent" : "border-mp-ink-3")} aria-hidden>
                {on && <Icon name="check" size={14} strokeWidth={3} />}
              </span>
            );
            const words = (
              <span className="min-w-0 flex-1">
                <span className={cx("block text-[15px] leading-snug break-words", on ? "text-mp-ink-2" : "text-mp-ink")}>{st.title}</span>
                {sub(st) && <span className="block text-[12px] text-mp-ink-2">{sub(st)}</span>}
              </span>
            );
            return (
              <li key={st.id}>
                {s.canWrite ? (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    disabled={s.busy}
                    onClick={() => void s.toggleStep(goal, st, !on)}
                    className="flex min-h-[52px] w-full items-center gap-3 px-3.5 py-2 text-left transition active:bg-mp-ink/[0.04] disabled:opacity-60"
                  >
                    {mark}
                    {words}
                  </button>
                ) : (
                  <div className="flex min-h-[52px] items-center gap-3 px-3.5 py-2">
                    {mark}
                    {words}
                    <span className="sr-only">{on ? "Done" : "Not done yet"}</span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={cx(tone.muted, "text-[14px]")}>No weekly steps yet.</p>
      )}
    </Block>
  );
}

// ── the roster ───────────────────────────────────────────────────────────

function Roster({ goal, p }: { goal: SleepGoal; p: GoalProgress | null }) {
  const { memberName, state } = useMaple();
  const v = useVoice();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  return (
    <Block title="Night roster">
      {goal.roster.length ? (
        <ul className="space-y-3">
          {goal.roster.map((w) => {
            const h = p?.roster.find((x) => x.windowId === w.id && x.nights > 0);
            return (
              <li key={w.id} className="space-y-0.5">
                <p className="text-[15px] leading-snug text-mp-ink">
                  <span className="font-semibold">{memberName(w.member)}</span> <span className="whitespace-nowrap tabular-nums">{windowTimes(w)}</span>
                </p>
                <p className="text-[13px] text-mp-ink-2">{capital(nightsLabel(w.nights))}</p>
                {w.covers && <p className="text-[13px] leading-snug text-mp-ink-2">{coversHint(w.covers, v)}</p>}
                {h && (
                  <p className="flex gap-1.5 pt-0.5 text-[13px] leading-snug text-mp-ink-2">
                    <Icon name="info" size={15} className="mt-[2px] shrink-0 text-mp-ink-3" />
                    {/* A hint from the log inside the window (the last week it was on): never a verdict about anyone, and a night with nothing logged is said as that. */}
                    <span>{`Hint from the log, the last ${plural(h.nights, "night")} it was on: ${rosterHintBody(h, memberName, v, tz)}.`}</span>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={cx(tone.muted, "text-[14px]")}>No protected windows on the roster.</p>
      )}
    </Block>
  );
}

// ── check-ins (owners and members only) ──────────────────────────────────

function Checkins({ goal, p }: { goal: SleepGoal; p: GoalProgress | null }) {
  const s = useSleep();
  const { memberName, state, now } = useMaple();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const t = now();
  const night = lastNightKey(t, tz);
  // A goal set this morning never asks about the night before it.
  const owed = goalStartKey(goal, tz) <= night;
  const people = [...new Set([...goalAdults(goal), ...(p?.checkins ?? []).map((c) => c.member)])];
  if (!people.length || !s.checkins) return null;
  const since = p?.weeks[0]?.from ?? null;
  return (
    <Block title="Check-ins" aside={since ? `since ${dateWords(since, dayKey(t, tz))}` : undefined}>
      <ul className={cx(tone.inset, "divide-y divide-mp-line overflow-hidden")}>
        {people.map((m) => {
          const c = p?.checkins?.find((x) => x.member === m) ?? null;
          const last = s.checkins?.find((x) => x.member === m && x.night === night) ?? null;
          const counts = c ? (c.nights ? `${plural(c.nights, "night")}: ${answers(c)}` : "no check-ins yet") : null;
          const lastWords = last ? `last night: ${PROTECTED_LABEL[last.protected].toLowerCase()}` : owed ? "last night: not yet" : null;
          return (
            <li key={m} className="flex min-h-[52px] items-center justify-between gap-3 px-3.5 py-2">
              <div className="min-w-0">
                <p className="text-[15px] leading-snug text-mp-ink">{m === s.me ? `${memberName(m)} (you)` : memberName(m)}</p>
                <p className="text-[12px] leading-snug text-mp-ink-2">{[counts, lastWords].filter(Boolean).join(" · ")}</p>
              </div>
              {m === s.me && s.canWrite && (last || owed) && (
                <Button variant={last ? "ghost" : "primary"} size="sm" className="shrink-0" onClick={() => s.openSheet({ kind: "checkin", back: "goals" })}>
                  {last ? "Change" : "Check in"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {/* Only with 5 or more nights on each side (goals.ts CHECKIN_PATTERN_NIGHTS): counts, never a verdict. */}
      {(p?.observations ?? []).map((o) => (
        <p key={`${o.member}-${o.factor}`} className="flex gap-1.5 pt-1 text-[13px] leading-snug text-mp-ink-2">
          <Icon name="info" size={15} className="mt-[2px] shrink-0 text-mp-ink-3" />
          <span>{observationWords(o, memberName)}</span>
        </p>
      ))}
    </Block>
  );
}

// ── closing a goal ───────────────────────────────────────────────────────

function CloseGoal({ goal, onCancel }: { goal: SleepGoal; onCancel: () => void }) {
  const s = useSleep();
  const [note, setNote] = useState("");
  const close = async (status: "met" | "dropped") => {
    if (await s.closeGoal(goal, status, note.trim() || null)) onCancel();
  };
  return (
    <div role="group" aria-label="Close this goal" className={cx(tone.inset, "space-y-3 px-3.5 py-3")}>
      <p className={cx(tone.heading, "text-[15px]")}>Close this goal?</p>
      <p className={cx(tone.muted, "text-[13px] leading-snug")}>It moves to Closed recently, where it stays for 60 days.</p>
      <div>
        <Label optional>A note for later</Label>
        <TextArea ariaLabel="A note for later" maxLength={GOAL_NOTE_MAX} value={note} onChange={setNote} placeholder="Like what helped" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button disabled={s.busy} onClick={() => void close("met")}>
          We met it
        </Button>
        <Button variant="soft" disabled={s.busy} onClick={() => void close("dropped")}>
          Set it aside
        </Button>
      </div>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Keep it open
      </Button>
    </div>
  );
}

function ClosedGoals({ goals }: { goals: SleepGoal[] }) {
  const s = useSleep();
  const { state, now } = useMaple();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const today = dayKey(now(), tz);
  // Its revision as the state has it: another phone's change since is a 409, and the toast says so.
  const reopen = (g: SleepGoal) => void s.updateGoal(g, { status: "active" }, { saved: `Open again: ${g.title}` });
  return (
    <section aria-labelledby="goals-closed" className="space-y-2">
      <h3 id="goals-closed" className={cx(tone.label, "px-1")}>
        Closed recently
      </h3>
      <ul className={cx(tone.card, tone.divide, "overflow-hidden")}>
        {goals.map((g) => (
          <li key={g.id} className="flex min-h-[52px] items-center justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0">
              <p className="text-[15px] leading-snug text-mp-ink break-words">{g.title}</p>
              <p className="text-[13px] leading-snug text-mp-ink-2 break-words">
                {GOAL_STATUS_LABEL[g.status]}
                {g.closed_at ? ` on ${dateWords(dayKey(Date.parse(g.closed_at), tz), today)}` : ""}
                {g.review_note ? ` · ${g.review_note}` : ""}
              </p>
            </div>
            {s.canWrite && (
              <Button variant="ghost" size="sm" className="shrink-0" disabled={s.busy} onClick={() => reopen(g)}>
                Open again
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
