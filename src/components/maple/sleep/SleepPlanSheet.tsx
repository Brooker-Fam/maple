"use client";

import { useEffect, useRef, useState } from "react";
import { DISCLAIMER } from "@/lib/maple/guidelines";
import { numberTries, progressLines, sleepGuidance, snoozeUntil, tryWhenLabel, type SleepProgress } from "@/lib/maple/sleep/engine";
import { PLAN_GOAL_MAX, PLAN_STAGES, TRIES_PER_DAY_MAX, TRY_ANCHORS, type PlanPatch, type PlanStage, type SleepPlan, type TrySlot } from "@/lib/maple/sleep/types";
import { defaultGoal, downWords, firstTryWords, OUTCOME_LABEL, SLEEP_PLACE_LABEL, slotLabel, STAGE_INFO, TAG_LABEL, TIME_OF_DAY } from "@/lib/maple/sleep/words";
import { formatDuration, formatTime } from "@/lib/maple/time";
import { SLEEP_PLACES, type SleepPlace } from "@/lib/maple/types";
import { useCareNav } from "../care/CareNav";
import { useVoice } from "../familyWords";
import { Icon } from "../icons";
import { ContextNote, Label } from "../sheets/parts";
import { Button, Chip, cx, Segmented, Sheet, Stepper, tone } from "../ui";
import { useMaple } from "../useMaple";
import { GoalsPart } from "./SleepGoals";
import { useSleep, useSleepContext, type PlanTab } from "./useSleep";

/**
 * The sleep plan in one sheet: the plan (her age by her birth date, the
 * stage, the tries a day and when, a stage the recent tries could support,
 * which only the family can take), the family's sleep goals (SleepGoals.tsx:
 * targets counted from the log, weekly steps, the night roster and the
 * adults' check-ins), guidance for her age, stage and recent tries (word for
 * word from guidelines/sleep.ts, each with its source), and progress over
 * the last 7 days, with sample sizes, no scores or streaks.
 */

type Tab = PlanTab;

export default function SleepPlanSheet({ tab: initial = "plan", open = true, onClose }: { tab?: Tab; open?: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>(initial);
  const s = useSleep();
  return (
    <Sheet open={open} onClose={onClose} title="Sleep plan">
      <div className="space-y-5">
        {/* Four tabs on one row at 320px: a little less padding in each. */}
        <Segmented<Tab>
          aria-label="Sleep plan"
          className="[&>button]:px-2"
          value={tab}
          onChange={setTab}
          options={[
            { value: "plan", label: "Plan" },
            { value: "goals", label: "Goals" },
            { value: "guidance", label: "Guidance" },
            { value: "progress", label: "Progress" },
          ]}
        />
        {tab === "plan" && <PlanPart />}
        {tab === "goals" && <GoalsPart />}
        {tab === "guidance" && <GuidancePart />}
        {tab === "progress" && (s.plan || s.data.tries.length ? <ProgressPart /> : <p className={cx(tone.muted, "text-[15px]")}>Progress shows here once there are bassinet tries.</p>)}
      </div>
    </Sheet>
  );
}

// ── the plan ─────────────────────────────────────────────────────────────

function PlanPart() {
  const s = useSleep();
  const v = useVoice();
  const { age, tz, now: clock } = useSleepContext();
  const { memberName } = useMaple();
  const plan = s.plan;

  if (!plan) {
    return (
      <div className="space-y-4">
        {age && <p className={cx(tone.muted, "text-[15px]")}>{v.Name} is {age.label} old.</p>}
        <div className={cx(tone.inset, "space-y-2 px-4 py-3.5")}>
          <p className={cx(tone.heading, "text-[16px]")}>A gentle plan for the bassinet</p>
          <p className={cx(tone.body, "text-[15px] leading-relaxed")}>
            Start with {STAGE_INFO[1].goal.charAt(0).toLowerCase() + STAGE_INFO[1].goal.slice(1)}. Holding {v.them} the rest of the time is fine while you&apos;re awake. You choose when to move to the next stage; Maple only says when recent tries could support it.
          </p>
        </div>
        {s.canWrite ? (
          <Button size="lg" className="w-full" disabled={s.busy} onClick={() => void s.createPlan()}>
            Set up the plan
          </Button>
        ) : (
          <p className={cx(tone.faint, "text-[13px]")}>No sleep plan yet.</p>
        )}
      </div>
    );
  }

  const nums = numberTries(s.data.tries, tz);
  return (
    <div className="space-y-5">
      {age && <p className={cx(tone.muted, "text-[15px]")}>{v.Name} is {age.label} old, by {v.their} birth date.</p>}
      <div className={cx(tone.inset, "space-y-1 px-4 py-3.5")}>
        <p className={cx(tone.label)}>Stage {plan.stage} of {PLAN_STAGES.length}</p>
        <p className={cx(tone.heading, "text-[17px]")}>{STAGE_INFO[plan.stage].title}</p>
        <p className={cx(tone.body, "text-[15px] leading-relaxed")}>{STAGE_INFO[plan.stage].goal}.</p>
        {s.today && (
          <p className={cx(tone.muted, "pt-1 text-[14px]")}>
            {s.today.done} of {s.today.planned} {s.today.label}
            {s.today.next ? ` · next: ${slotLabel(s.today.next).replace(/^The /, "the ")}${s.today.fallback ? " (the backup, since no night try was logged)" : ""}` : ""}
          </p>
        )}
        <p className={cx(tone.faint, "text-[13px]")}>Goal: {plan.goal ?? defaultGoal(v)}</p>
      </div>

      {/* Set up, no try yet: what to do at the first one (tonight, or the morning nap when it's the backup). */}
      {s.canWrite && !s.data.tries.length && (
        <div className={cx(tone.card, "space-y-1 px-4 py-3")} data-first-try>
          <p className={cx(tone.heading, "text-[15px]")}>{s.today?.label === "tonight" ? "What to do tonight" : "What to do next"}</p>
          <p className={cx(tone.body, "text-[15px] leading-relaxed")}>{firstTryWords(v, s.today?.next ?? null)}</p>
        </div>
      )}

      {s.suggestion && !s.suggestion.snoozed && s.canWrite && <Suggestion plan={plan} />}

      {/* Not keyed by revision: a poll or a 409 bringing another phone's change rebases the draft instead of closing it. */}
      {s.canWrite && <PlanEditor plan={plan} />}

      {s.canWrite && !s.shift && (
        <Button variant="soft" className="w-full" onClick={() => s.openSheet({ kind: "holding", mode: "start" })}>
          <Icon name="hold" size={18} /> Start holding {v.them} (awake)
        </Button>
      )}

      <section>
        <h3 className={cx(tone.label, "mb-1.5 px-1")}>Recent tries</h3>
        {s.data.tries.length ? (
          <div className={cx(tone.card, tone.divide, "overflow-hidden")}>
            {s.data.tries.slice(0, 12).map((t) => {
              const n = nums.get(t.id);
              return (
                <button key={t.id} type="button" onClick={() => s.openSheet({ kind: "try", tryId: t.id })} className={cx(tone.row, "min-h-[56px] py-2")}>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] text-mp-ink">
                      {t.outcome ? OUTCOME_LABEL[t.outcome] : "In the bassinet now"}
                      {t.ended_at ? ` · ${downWords((Date.parse(t.ended_at) - Date.parse(t.started_at)) / 60_000)}` : ""}
                    </span>
                    <span className={cx(tone.muted, "block text-[13px]")}>
                      {n ? `${tryWhenLabel(t.started_at, clock, tz).replace(/^./, (c) => c.toUpperCase())} · try ${n.n}${n.retry ? ", a retry" : ""} · ` : ""}
                      {formatTime(t.started_at, tz)}
                      {t.put_down_by ? ` · ${memberName(t.put_down_by)}` : ""}
                      {t.tags.length ? ` · ${t.tags.map((x) => TAG_LABEL[x].toLowerCase()).join(", ")}` : ""}
                    </span>
                  </span>
                  <Icon name="chevron-right" size={18} className="shrink-0 text-mp-ink-3" />
                </button>
              );
            })}
          </div>
        ) : (
          <p className={cx(tone.faint, "px-1 text-[13px]")}>No tries yet. One a day is plenty.</p>
        )}
      </section>
    </div>
  );
}

/** The stage the recent tries could support: the family's to take or leave ("Not now" hides it for 3 days). */
function Suggestion({ plan }: { plan: SleepPlan }) {
  const s = useSleep();
  const { tz, now: clock } = useSleepContext();
  const g = s.suggestion!;
  const snooze = () => void s.updatePlan({ snoozed_until: snoozeUntil(clock, tz) });
  return (
    <div className={cx(tone.card, "space-y-3 px-4 py-3.5")} role="status">
      <p className={cx(tone.body, "text-[15px] leading-relaxed")}>
        Recent tries could support stage {g.to}, {STAGE_INFO[g.to].title.toLowerCase()}: {g.stayed} of the last {g.recent} stayed asleep 30 minutes or more, over {g.days} days. It&apos;s your call, and there&apos;s no rush.
      </p>
      <div className="flex gap-2">
        <Button className="flex-1" disabled={s.busy} onClick={() => void s.updatePlan({ stage: g.to })}>
          Move to stage {g.to}
        </Button>
        <Button variant="soft" className="flex-1" disabled={s.busy} onClick={snooze}>
          Not now
        </Button>
      </div>
      <p className={cx(tone.faint, "text-[12px]")}>Stage {plan.stage} stays until you change it.</p>
    </div>
  );
}

type PlanDraft = { stage: PlanStage; tries: number; times: TrySlot[]; backup: TrySlot | null; where: SleepPlace | null; goal: string };
const PLAN_FIELDS = ["stage", "tries", "times", "backup", "where", "goal"] as const;
type PlanField = (typeof PLAN_FIELDS)[number];

const planDraft = (p: SleepPlan): PlanDraft => ({ stage: p.stage, tries: p.tries_per_day, times: p.try_times, backup: p.fallback, where: p.sleeps_now, goal: p.goal ?? "" });
const sameField = (a: PlanDraft, b: PlanDraft, k: PlanField) => (k === "times" ? a.times.join() === b.times.join() : k === "goal" ? a.goal.trim() === b.goal.trim() : a[k] === b[k]);

/**
 * The plan as it is now, with this person's changes (against the plan they
 * started from) kept on top: another phone's change, from a poll or a 409,
 * never closes the editor or loses what they set.
 */
function rebasePlan(draft: PlanDraft, was: PlanDraft, cur: PlanDraft): PlanDraft {
  const out = { ...cur };
  for (const k of PLAN_FIELDS) if (!sameField(draft, was, k)) (out as Record<PlanField, unknown>)[k] = draft[k];
  return out;
}

function PlanEditor({ plan }: { plan: SleepPlan }) {
  const s = useSleep();
  const v = useVoice();
  const { memberName } = useMaple();
  const [open, setOpen] = useState(false);
  // The plan this draft was made from, and the draft.
  const [base, setBase] = useState(plan);
  const [draft, setDraft] = useState<PlanDraft>(() => planDraft(plan));
  // Another phone's change while this was open: which fields it moved, and whether a Save was turned away (409).
  const [elsewhere, setElsewhere] = useState<{ fields: PlanField[]; refused: boolean } | null>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  if (plan.revision !== base.revision) {
    // A newer plan (a poll, or a 409's answer): rebase onto it, keeping this person's changes.
    const was = planDraft(base);
    const cur = planDraft(plan);
    setDraft((d) => rebasePlan(d, was, cur));
    setBase(plan);
    if (open) setElsewhere((e) => ({ fields: PLAN_FIELDS.filter((k) => !sameField(was, cur, k)), refused: e?.refused ?? false }));
  }
  useEffect(() => {
    if (elsewhere) alert.current?.scrollIntoView({ block: "center" });
  }, [elsewhere]);
  const set = (change: Partial<PlanDraft>) => setDraft((d) => ({ ...d, ...change }));
  const { stage, tries, times, backup, where, goal } = draft;
  const patch: PlanPatch = {};
  if (stage !== base.stage) patch.stage = stage;
  if (tries !== base.tries_per_day) patch.tries_per_day = tries;
  if (times.join() !== base.try_times.join()) patch.try_times = times;
  if (backup !== base.fallback) patch.fallback = backup;
  if (where !== base.sleeps_now) patch.sleeps_now = where;
  if ((goal.trim() || null) !== base.goal) patch.goal = goal.trim() || null;
  const dirty = Object.keys(patch).length > 0;
  const who = memberName(base.updated_by);
  const mark = (k: PlanField) => (elsewhere?.fields.includes(k) ? <p className="mt-1.5 text-[13px] font-semibold text-mp-accent-fg">{who} changed this on another phone</p> : null);
  const close = () => {
    setOpen(false);
    setElsewhere(null);
    setDraft(planDraft(base));
  };
  const save = async () => {
    const r = await s.savePlan(base, patch);
    if (!r) return;
    if ("saved" in r) {
      setOpen(false);
      setElsewhere(null);
      return;
    }
    // Turned away: the newer plan is applied already (and rebased onto above); say so, and wait for another Save.
    setElsewhere((e) => ({ fields: e?.fields ?? [], refused: true }));
  };

  if (!open) {
    return (
      <Button variant="ghost" className="w-full" onClick={() => setOpen(true)}>
        <Icon name="pencil" size={16} /> Change the plan
      </Button>
    );
  }
  return (
    <div className={cx(tone.card, "space-y-5 px-4 py-4")}>
      {elsewhere && (
        <p ref={alert} role="alert" className={cx(tone.inset, "px-4 py-3 text-[15px] leading-relaxed text-mp-ink")}>
          {who} changed the plan on another phone just now{elsewhere.refused ? ", so nothing was saved yet" : ""}. This shows their version, with your changes kept on top. Look it over, then save again.
        </p>
      )}
      <div>
        <Label>Stage</Label>
        <div role="group" aria-label="Stage" className="flex flex-wrap gap-2">
          {PLAN_STAGES.map((n) => (
            <Chip key={n} selected={stage === n} onClick={() => set({ stage: n })}>
              {n} · {STAGE_INFO[n].title}
            </Chip>
          ))}
        </div>
        {mark("stage")}
        {stage !== base.stage && <p className={cx(tone.muted, "mt-2 text-[13px]")}>Saving moves the plan to stage {stage} ({STAGE_INFO[stage].goal.toLowerCase()}), with its usual tries and times unless you change them below.</p>}
      </div>
      <div>
        <Label>Tries a day</Label>
        <Stepper ariaLabel="tries a day" value={tries} onChange={(n) => set({ tries: Math.max(1, Math.min(TRIES_PER_DAY_MAX, Math.round(n ?? 1))) })} min={1} max={TRIES_PER_DAY_MAX} />
        {mark("tries")}
      </div>
      <div>
        <Label>Try times</Label>
        <div role="group" aria-label="Try times" className="flex flex-wrap gap-2">
          {TRY_ANCHORS.map((a) => (
            <Chip key={a} selected={times.includes(a)} onClick={() => set({ times: times.includes(a) ? (times.length > 1 ? times.filter((x) => x !== a) : times) : [...times, a] })}>
              {slotLabel(a)}
            </Chip>
          ))}
        </div>
        {mark("times")}
      </div>
      <div>
        <Label optional>Backup</Label>
        <div role="group" aria-label="Backup" className="flex flex-wrap gap-2">
          {TRY_ANCHORS.map((a) => (
            <Chip key={a} selected={backup === a} onClick={() => set({ backup: backup === a ? null : a })}>
              {slotLabel(a)}
            </Chip>
          ))}
        </div>
        {mark("backup")}
      </div>
      <div>
        <Label>Where {v.they} mostly {v.verb("sleeps")} now</Label>
        <div role="group" aria-label={`Where ${v.they} mostly ${v.verb("sleeps")} now`} className="flex flex-wrap gap-2">
          {SLEEP_PLACES.map((p) => (
            <Chip key={p} selected={where === p} onClick={() => set({ where: where === p ? null : p })}>
              {SLEEP_PLACE_LABEL[p]}
            </Chip>
          ))}
        </div>
        {mark("where")}
      </div>
      <div>
        <Label optional>Your goal</Label>
        <input className={tone.input} aria-label="Your goal" value={goal} maxLength={PLAN_GOAL_MAX} placeholder={defaultGoal(v)} onChange={(e) => set({ goal: e.target.value })} />
        {mark("goal")}
      </div>
      <div className="flex gap-2">
        <Button variant="soft" className="flex-1" onClick={close}>
          Cancel
        </Button>
        <Button className="flex-1" disabled={!dirty || s.busy} onClick={() => void save()}>
          Save the plan
        </Button>
      </div>
    </div>
  );
}

// ── guidance ─────────────────────────────────────────────────────────────

function GuidancePart() {
  const s = useSleep();
  const v = useVoice();
  const nav = useCareNav();
  const { age, signals } = useSleepContext();
  const g = sleepGuidance(v, { days: age?.days ?? null, stage: s.plan?.stage ?? null, signals });
  if (!age) return <p className={cx(tone.muted, "text-[15px]")}>Sleep guidance starts once {v.name}&apos;s birth is recorded.</p>;
  const item = (x: (typeof g.now)[number]) => (
    <article key={x.id} className="space-y-1.5">
      <h4 className={cx(tone.heading, "text-[15px]")}>{x.title}</h4>
      <p className={cx(tone.body, "text-[15px] leading-relaxed")}>{x.body}</p>
      {x.steps && (
        <ol className="list-decimal space-y-1 pl-5 text-[15px] leading-relaxed text-mp-ink">
          {x.steps.map((st) => (
            <li key={st}>{st}</li>
          ))}
        </ol>
      )}
      <p className="-my-2 flex flex-wrap gap-x-3 text-[12px]">
        {x.sources.map((src) => (
          // A 44px target, though the words are small.
          <a key={src.url} href={src.url} target="_blank" rel="noreferrer" className="inline-flex min-h-[44px] items-center text-mp-accent-fg underline-offset-2 hover:underline">
            {src.label}
          </a>
        ))}
      </p>
    </article>
  );
  return (
    <div className="space-y-6">
      {g.now.length > 0 && (
        <section className={cx(tone.card, "space-y-4 px-4 py-4")} aria-labelledby="sleep-now">
          <h3 id="sleep-now" className={cx(tone.label)}>For right now</h3>
          {g.now.map(item)}
        </section>
      )}
      {g.sections.map((sec) => (
        <section key={sec.section} className="space-y-3" aria-labelledby={`sleep-${sec.section}`}>
          <h3 id={`sleep-${sec.section}`} className={cx(tone.heading, "px-1 text-[17px]")}>{sec.title}</h3>
          <div className={cx(tone.card, "space-y-4 px-4 py-4")}>
            {sec.items.map(item)}
            {sec.section === "emergency" && (
              <div className="flex gap-2 pt-1">
                <a href="tel:911" className="mp-control inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl bg-mp-danger/10 px-4 text-[15px] font-semibold text-mp-danger">
                  <Icon name="phone" size={18} /> Call 911
                </a>
                <Button variant="soft" className="flex-1" onClick={nav.openHelp}>
                  Doctor numbers
                </Button>
              </div>
            )}
          </div>
        </section>
      ))}
      <p className={cx(tone.faint, "px-1 text-center text-xs leading-relaxed")}>{DISCLAIMER}</p>
    </div>
  );
}

// ── progress ─────────────────────────────────────────────────────────────

function ProgressPart() {
  const { api, state } = useMaple();
  const { tz, now: clock } = useSleepContext();
  const [p, setP] = useState<SleepProgress | null>(null);
  const [failed, setFailed] = useState(false);
  const rev = state?.rev;
  useEffect(() => {
    let live = true;
    api<{ progress: SleepProgress }>("/api/maple/sleep?view=progress&days=7")
      .then((r) => live && (setP(r.progress), setFailed(false)))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [api, rev]);
  if (failed && !p) return <p className={cx(tone.muted, "text-[15px]")}>Couldn&apos;t load progress. It&apos;ll try again on the next refresh.</p>;
  if (!p) return <p className={cx(tone.faint, "text-[15px]")}>Loading…</p>;
  const lines = progressLines(p, tz, clock);
  const maxSec = Math.max(1, ...p.places.map((x) => x.sec));
  return (
    <div className="space-y-5">
      <p className={cx(tone.label, "px-1")}>Last {p.days} days</p>
      <div className={cx(tone.card, tone.divide, "overflow-hidden")}>
        <Row label="Tries" value={p.tries ? `${p.tries} on ${p.tryDays} ${p.tryDays === 1 ? "day" : "days"}` : "None yet"} />
        <Row label="Stayed asleep" value={p.finished ? `${p.stayedAsleep.n} of ${p.finished}` : "No finished tries yet"} />
        <Row label="Longest in the bassinet" value={p.longestBassinet ? `${formatDuration(p.longestBassinet.sec)} · ${tryWhenLabel(p.longestBassinet.start, clock, tz)}` : "None yet"} />
        {p.medianMinutesDown != null && <Row label="Typical time down" value={`${downWords(p.medianMinutesDown)} (the middle try)`} />}
      </div>
      {p.places.length > 0 && (
        <section className="space-y-2">
          <h3 className={cx(tone.label, "px-1")}>Logged sleep by place</h3>
          <div className={cx(tone.card, "space-y-2.5 px-4 py-3.5")}>
            {p.places.map((x) => (
              <div key={x.place}>
                <div className="flex justify-between text-[14px]">
                  <span className="text-mp-ink">{x.label}</span>
                  <span className="text-mp-ink-2 tabular-nums">
                    {formatDuration(x.sec)} · {x.sleeps} {x.sleeps === 1 ? "sleep" : "sleeps"}
                  </span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-mp-sunken">
                  <div className="mp-kind-fill h-2 rounded-full" style={{ width: `${Math.max(3, (x.sec / maxSec) * 100)}%`, backgroundColor: "var(--mp-ink-3)" }} />
                </div>
              </div>
            ))}
            <p className={cx(tone.faint, "text-[12px]")}>Only logged sleep counts, so a missed log makes a day look short.</p>
          </div>
        </section>
      )}
      {p.tries > 0 && (
        <section className="space-y-2">
          <h3 className={cx(tone.label, "px-1")}>How tries ended, by time of day</h3>
          <div className={cx(tone.card, "overflow-x-auto px-2 py-2")}>
            <table className="w-full text-[13px] tabular-nums">
              <thead>
                <tr className="text-left text-mp-ink-2">
                  <th className="px-2 py-1.5 font-medium">When</th>
                  <th className="px-2 py-1.5 font-medium">Tries</th>
                  <th className="px-2 py-1.5 font-medium">Stayed</th>
                  <th className="px-2 py-1.5 font-medium">Calm</th>
                  <th className="px-2 py-1.5 font-medium">Crying</th>
                  <th className="px-2 py-1.5 font-medium">Picked up</th>
                </tr>
              </thead>
              <tbody>
                {p.byTimeOfDay.map((b) => (
                  <tr key={b.part} className="border-t border-mp-line text-mp-ink">
                    <th scope="row" className="px-2 py-1.5 text-left font-medium">
                      {b.label}
                      <span className="block text-[11px] font-normal text-mp-ink-3">{TIME_OF_DAY.find((x) => x.id === b.part)?.range}</span>
                    </th>
                    <td className="px-2 py-1.5">{b.tries}</td>
                    <td className="px-2 py-1.5">{b.outcomes.stayed_asleep}</td>
                    <td className="px-2 py-1.5">{b.outcomes.woke_calm}</td>
                    <td className="px-2 py-1.5">{b.outcomes.woke_crying}</td>
                    <td className="px-2 py-1.5">{b.outcomes.picked_up}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <ContextNote>{p.observations.length ? p.observations.join(" ") : lines[lines.length - 1]}</ContextNote>
      <p className={cx(tone.faint, "px-1 text-[12px] leading-relaxed")}>Every night is different. These are counts of what was logged, not a score.</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-[48px] items-center justify-between gap-3 px-4 py-2">
      <span className="text-[15px] text-mp-ink">{label}</span>
      <span className="text-right text-[15px] text-mp-ink-2 tabular-nums">{value}</span>
    </div>
  );
}
