"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { sleepAge } from "@/lib/maple/sleep/engine";
import {
  againstAim,
  goalAdults,
  goalCautions,
  goalSpan,
  goalStartKey,
  lastNightKey,
  nextStepNow,
  rosterHintBody,
  type CoachNotes,
  type GoalProgress,
  type GoalSpan,
  type GoalWeek,
  type NightsWeek,
  type StretchWeek,
  type WeekCoverage,
  type WindowWeek,
} from "@/lib/maple/sleep/goals";
import { GOAL_NOTE_MAX, GOALS_OPEN_MAX, type BassinetNightsTarget, type BassinetStretchTarget, type GoalStep, type ProtectedWindowTarget, type SleepGoal } from "@/lib/maple/sleep/types";
import { dateWords, GOAL_STATUS_LABEL, minutesWords, nightsLabel, PROTECTED_LABEL, TARGET_KIND_LABEL, targetWords, windowTimes } from "@/lib/maple/sleep/words";
import { dayKey, DEFAULT_TZ, formatDuration } from "@/lib/maple/time";
import { AskChatButton } from "../chat/AskChat";
import { useVoice } from "../familyWords";
import { Icon } from "../icons";
import { Label } from "../sheets/parts";
import { Button, cx, TextArea, tone } from "../ui";
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
 * check-in, and nothing that writes.
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
  // Active first, then paused; each newest first, as the state has them.
  const open = [...s.goals.filter((g) => g.status === "active"), ...s.goals.filter((g) => g.status === "paused")];
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
  const cautions = goal.status === "active" ? goalCautions(goal, { v, name: memberName, ageDays: state?.baby.born_at ? (age?.days ?? null) : null }).filter((c) => c.kind !== "feeding") : [];
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

/** "This week", "Last week", "Week 2". */
function weekLabel(w: GoalWeek, p: GoalProgress): string {
  if (w.current) return "This week";
  if (p.weekNow && w.n === p.weekNow - 1) return "Last week";
  return `Week ${w.n}`;
}

/** The newest week in full, then up to three earlier ones compact, the rest a tap away. Every line says what it's out of. */
function Weeks<T extends { week: number }>({ p, rows, line }: { p: GoalProgress; rows: readonly T[]; line: (x: T, w: GoalWeek) => string }) {
  const weeks = [...p.weeks].reverse().filter((w) => rows.some((x) => x.week === w.n));
  const [latest, ...earlier] = weeks;
  if (!latest) return null;
  const row = (w: GoalWeek) => rows.find((x) => x.week === w.n)!;
  const item = (w: GoalWeek) => (
    <li key={w.n}>
      {weekLabel(w, p)}: {line(row(w), w)}
    </li>
  );
  return (
    <div className="space-y-1">
      <p className="text-[15px] leading-snug text-mp-ink tabular-nums">
        <span className="font-semibold">{weekLabel(latest, p)}:</span> {line(row(latest), latest)}
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
const nightsLine = (t: BassinetNightsTarget) => (x: NightsWeek, w: GoalWeek) => {
  if (!x.nights) return "counting starts with the goal's first night";
  const counted = `${againstAim(x.counted, t.per_week)}${x.fromCheckins ? ` (${x.fromCheckins} from check-ins)` : ""}`;
  if (x.unknown) return `${counted} · ${x.counted} of ${x.known} logged ${x.known === 1 ? "night" : "nights"} · ${x.unknown} not logged`;
  return `${counted} · tried on ${x.tried} of ${plural(x.nights, "night")}${w.current ? " so far" : ""}`;
};

const stretchLine = (t: BassinetStretchTarget) => (x: StretchWeek, w: GoalWeek) =>
  x.stretches
    ? `longest ${formatDuration(x.longestSec ?? 0)} · ${x.atLeast} of ${plural(x.stretches, "stretch", "stretches")} ${minutesWords(t.minutes)} or more`
    : `no bassinet stretches logged${w.current ? " yet" : ""}`;

/** "yes on 4 of the 5 nights aimed for · checked in 5 of 7 roster nights so far (not this time 1)": never "held", which is a holding turn's word. */
const windowLine = (t: ProtectedWindowTarget) => (x: WindowWeek, w: GoalWeek): string => {
  const other = [x.partly ? `partly ${x.partly}` : "", x.no ? `not this time ${x.no}` : ""].filter(Boolean).join(", ");
  const soFar = w.current ? " so far" : "";
  if (!x.checkedIn) return `no check-ins${w.current ? " yet" : ""} · ${plural(x.planned, "night")} on the roster${soFar}`;
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
    counts = tp.weeks ? <Weeks p={p} rows={tp.weeks} line={windowLine(tp.target)} /> : <p className={cx(tone.muted, "text-[13px]")}>Counted from each adult&apos;s own morning check-ins.</p>;
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
