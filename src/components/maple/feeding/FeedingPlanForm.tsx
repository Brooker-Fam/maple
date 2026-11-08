"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AT_BREAST_WORDS, PLAN_LIMITS, type AtBreastVia, type PlanBottleVia, type PlanMilk, type Range } from "@/lib/maple/feeding-plan";
import { useBabyWords } from "../familyWords";
import { Icon, type IconName } from "../icons";
import { GROUP, Toggle } from "../settings/parts";
import { Label } from "../sheets/parts";
import { Chip, cx, NumberProblem, parseTypedNumber, RepeatButton, Segmented, TextArea, tone, useTypedNumber } from "../ui";
import {
  addFeed,
  amountMax,
  feedLabel,
  feedSummary,
  isEmptyRange,
  move,
  newStep,
  rangeOut,
  setNightFeed,
  shownAmount,
  stepTitle,
  takeOutFeed,
  typedAmount,
  wakeText,
  type BottleDraft,
  type FeedDraft,
  type NurseDraft,
  type PlanDraft,
  type RangeDraft,
  type StepDraft,
  type StepKind,
} from "./planDraft";

/**
 * The feeding plan's form (FeedingPlanSheet's edit mode), drawn from a draft
 * (planDraft.ts): who it's from and the check-in, the unit its amounts are
 * written in, the target per feed, how often by day, each feed's steps, the
 * day's turns, the night and notes. Every field has its name for a screen
 * reader; a number typed wrong says so by its field and holds Save; a
 * refusal from the plan's check marks the feed and step it's about.
 */

type Change = (fn: (d: PlanDraft) => PlanDraft) => void;
type Watch = (key: string) => (invalid: boolean) => void;
export type PlanMark = { feed: string; step: string | null; message: string };

const MAX_MINUTES = PLAN_LIMITS.stepMinutes[1];
const MAX_HOURS = PLAN_LIMITS.everyMinutes[1] / 60;

const MILKS: { value: PlanMilk; label: string }[] = [
  { value: "breastmilk", label: "Breast milk" },
  { value: "formula", label: "Formula" },
  { value: "either", label: "Either" },
  { value: "breastmilk_first", label: "Pumped milk, then formula" },
];
const VIAS: { value: PlanBottleVia; label: string }[] = [
  { value: "bottle", label: "Bottle" },
  { value: "paced", label: "Paced bottle" },
];
const AT_BREAST: ("none" | AtBreastVia)[] = ["none", "syringe", "sns"];
const ADD: { kind: StepKind; label: string; icon: IconName }[] = [
  { kind: "nurse", label: "Nurse", icon: "baby" },
  { kind: "pump", label: "Pump", icon: "milk" },
  { kind: "bottle", label: "Bottle or top-up", icon: "bottle" },
  { kind: "note", label: "Note", icon: "sticky-note" },
];

/** A wake switch's hint: when, in hours, once the time between feeds says ("Wake her if she's still asleep at 3.5 hours from the start of the last feed."). */
const wakeHint = (every: Range | undefined, w: { him: string; hes: string }) => {
  const words = every ? wakeText(every, w, { from: true }) : `wake ${w.him} if ${w.hes} still asleep when the time's up`;
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
};

/** A compact number box (a range's end): 44px tall, 16px type so iOS doesn't zoom. */
const BOX =
  "h-11 w-[4.75rem] min-w-0 rounded-xl border border-mp-line bg-mp-surface px-2 text-center text-base font-semibold text-mp-ink tabular-nums outline-none transition focus:border-mp-focus focus:ring-2 focus:ring-mp-focus/25";
const BAD = "border-mp-danger! ring-2! ring-mp-danger/25!";

export function PlanForm({ draft, change, watch, invalid, mark, onRemoved }: {
  draft: PlanDraft;
  change: Change;
  watch: Watch;
  /** A number somewhere reads wrong: nothing folds away until it's fixed (a folded field would lose the typo unseen). */
  invalid: boolean;
  /** A refusal's feed and step, marked with its words. */
  mark: PlanMark | null;
  /** A feed or step taken out: say so, with a way to put it back. */
  onRemoved: (what: string, undo: () => void) => void;
}) {
  const w = useBabyWords();
  const unit = draft.unit;
  const set = (patch: Partial<PlanDraft>) => change((d) => ({ ...d, ...patch }));
  const hasTarget = !isEmptyRange(draft.target);

  const dropFeed = (f: FeedDraft, i: number) => {
    const { putBack } = takeOutFeed(draft, f.key);
    change((d) => takeOutFeed(d, f.key).next);
    onRemoved(f.name.trim() ? `Took out “${f.name.trim()}”` : `Took out feed ${i + 1}`, () => change(putBack));
  };

  return (
    <div className="min-w-0 space-y-6">
      <div className={cx(tone.card, "space-y-4 px-4 py-4")}>
        <div>
          <Label optional>Who it&apos;s from</Label>
          <input className={tone.input} aria-label="Who it's from" value={draft.from} maxLength={PLAN_LIMITS.from} placeholder="Like “Feeding clinic”" onChange={(e) => set({ from: e.target.value })} />
        </div>
        <div>
          <Label optional>Next check-in</Label>
          <div className="flex items-center gap-1">
            <input type="date" aria-label="Next check-in" value={draft.check_in} onChange={(e) => set({ check_in: e.target.value })} className={cx(tone.input, "min-w-0 flex-1")} />
            {draft.check_in && <IconButton icon="x" label="Clear the check-in date" onClick={() => set({ check_in: "" })} />}
          </div>
        </div>
        <div>
          <Label>Amounts in</Label>
          <Segmented<PlanDraft["unit"]>
            aria-label="Amounts in"
            value={unit}
            onChange={(u) => set({ unit: u })}
            options={[
              { value: "ml", label: "ml" },
              { value: "oz", label: "oz" },
            ]}
          />
          <p className={cx(tone.muted, "mt-1.5 text-[13px] leading-snug")}>As your plan writes them. Switching shows the same amounts in the other unit.</p>
        </div>
      </div>

      <FormSection title="Target per feed">
        <div className={cx(tone.card, "space-y-2 px-4 py-4")}>
          <AmountRange aria="target per feed" value={draft.target} unit={unit} onChange={(target) => set({ target })} watch={watch} wkey="target" />
          <p className={cx(tone.muted, "text-[13px] leading-snug")}>Only if your care team gave you one. Maple shows it next to bottles, and a bottle step can go up to it. It&apos;s the same target as in Settings.</p>
        </div>
      </FormSection>

      <FormSection title="By day">
        <div className={GROUP}>
          <div className="space-y-2 px-4 py-4">
            <HoursRange title="Time between feeds, in hours" aria="hours between feeds by day" value={draft.every} onChange={(every) => set({ every })} watch={watch} wkey="every" />
            <p className={cx(tone.muted, "text-[13px] leading-snug")}>From the start of one feed to the next. Leave empty if the plan doesn&apos;t say.</p>
          </div>
          <Toggle label="Wake to feed" hint={wakeHint(rangeOut(draft.every), w)} checked={draft.wake} onChange={(wake) => set({ wake })} />
        </div>
      </FormSection>

      <FormSection title="Feeds" count={`${draft.feeds.length} of ${PLAN_LIMITS.feeds}`}>
        {draft.feeds.map((f, i) => (
          <FeedEditor key={f.key} feed={f} index={i} draft={draft} change={change} watch={watch} canFold={!invalid} mark={mark?.feed === f.key ? mark : null} hasTarget={hasTarget} onRemove={() => dropFeed(f, i)} onRemoved={onRemoved} />
        ))}
        {draft.feeds.length < PLAN_LIMITS.feeds ? (
          <Chip onClick={() => change((d) => addFeed(d))}>
            <Icon name="plus" size={16} /> Add a feed
          </Chip>
        ) : (
          <p className={cx(tone.muted, "px-1 text-[13px]")}>A plan has {PLAN_LIMITS.feeds} feeds at most.</p>
        )}
      </FormSection>

      {draft.feeds.length > 1 && <TurnsEditor draft={draft} change={change} />}

      <NightEditor draft={draft} change={change} watch={watch} />

      <FormSection title="Notes">
        <TextArea ariaLabel="Notes" rows={3} maxLength={PLAN_LIMITS.notes} value={draft.notes} onChange={(notes) => set({ notes })} placeholder="Anything else the plan says" />
      </FormSection>
    </div>
  );
}

// ── a feed ─────────────────────────────────────────────────────────────────

function FeedEditor({ feed, index, draft, change, watch, canFold, mark, hasTarget, onRemove, onRemoved }: {
  feed: FeedDraft;
  index: number;
  draft: PlanDraft;
  change: Change;
  watch: Watch;
  canFold: boolean;
  mark: PlanMark | null;
  hasTarget: boolean;
  onRemove: () => void;
  onRemoved: (what: string, undo: () => void) => void;
}) {
  const label = feedLabel(draft, feed.key);
  const setFeed = (fn: (f: FeedDraft) => FeedDraft) => change((d) => ({ ...d, feeds: d.feeds.map((f) => (f.key === feed.key ? fn(f) : f)) }));
  const setSteps = (fn: (s: StepDraft[]) => StepDraft[]) => setFeed((f) => ({ ...f, steps: fn(f.steps) }));
  const full = feed.steps.length >= PLAN_LIMITS.steps;
  const nurses = feed.steps.some((s) => s.do === "nurse");
  const feedProblem = mark && !mark.step ? mark.message : null;
  // A saved feed starts folded to its steps in words, so changing one number isn't a long scroll; a new one starts open,
  // and one a refusal is about opens (and stays open while it's fixed).
  const [open, setOpen] = useState(!feed.id);
  if (mark && !open) setOpen(true);

  const dropStep = (s: StepDraft, i: number) => {
    setSteps((list) => list.filter((x) => x.key !== s.key));
    onRemoved(`Took out step ${i + 1} of ${label}`, () =>
      setSteps((list) => (list.some((x) => x.key === s.key) ? list : [...list.slice(0, i), s, ...list.slice(i)]))
    );
  };

  if (!open) {
    return (
      <div role="group" aria-label={`Feed ${index + 1}`} data-plan-feed={feed.key} className={cx(tone.card, "overflow-hidden")}>
        <button type="button" aria-expanded={false} onClick={() => setOpen(true)} className={cx(tone.row, "min-h-[64px] items-start py-3")}>
          <span className="min-w-0 flex-1">
            <span className="block text-[16px] leading-snug font-semibold text-mp-ink [overflow-wrap:anywhere]">{label}</span>
            <span className={cx(tone.muted, "mt-0.5 block text-[14px] leading-snug [overflow-wrap:anywhere]")}>{feedSummary(feed, draft.unit, rangeOut(draft.target) ?? null)}</span>
          </span>
          <span className="mt-0.5 flex shrink-0 items-center gap-0.5 text-[14px] font-medium text-mp-accent-fg">
            Change
            <Icon name="chevron-down" size={16} />
          </span>
        </button>
      </div>
    );
  }

  return (
    <div role="group" aria-label={`Feed ${index + 1}`} data-plan-feed={feed.key} className={cx(tone.card, "space-y-3 px-4 py-3.5", feedProblem && "ring-2 ring-mp-danger/40")}>
      <div className="flex min-h-[44px] items-center gap-1">
        <p className={cx(tone.label, "flex-1")}>Feed {index + 1}</p>
        {draft.feeds.length > 1 && <IconButton icon="trash-2" label={`Take out ${label}`} onClick={onRemove} />}
        <IconButton icon="chevron-up" label={`Fold ${label} to one line`} disabled={!canFold || !!mark} onClick={() => setOpen(false)} />
      </div>
      <div className="-mt-2">
        <input
          className={cx(tone.input, feedProblem && /name/.test(feedProblem) && BAD)}
          aria-label={`Feed ${index + 1} name`}
          value={feed.name}
          maxLength={PLAN_LIMITS.name}
          placeholder="Its name, like “Nurse, then top up”"
          onChange={(e) => setFeed((f) => ({ ...f, name: e.target.value }))}
        />
        {feedProblem && <div className="mt-1.5"><Problem>{feedProblem}</Problem></div>}
      </div>
      {feed.steps.length > 0 ? (
        <ol className="space-y-2.5" aria-label={`${label}: steps`}>
          {feed.steps.map((s, i) => (
            <StepEditor
              key={s.key}
              step={s}
              index={i}
              count={feed.steps.length}
              feedName={label}
              afterNurse={feed.steps.slice(0, i).some((x) => x.do === "nurse")}
              unit={draft.unit}
              hasTarget={hasTarget}
              watch={watch}
              problem={mark?.step === s.key ? mark.message : null}
              onChange={(next) => setSteps((list) => list.map((x) => (x.key === s.key ? next : x)))}
              onMove={(by) => setSteps((list) => move(list, i, by))}
              onRemove={() => dropStep(s, i)}
            />
          ))}
        </ol>
      ) : (
        <p className={cx(tone.muted, "text-[14px] leading-snug")}>Add its steps in the order the plan gives them.</p>
      )}
      {full ? (
        <p className={cx(tone.muted, "text-[13px]")}>A feed has {PLAN_LIMITS.steps} steps at most.</p>
      ) : (
        <div>
          <p className={cx(tone.label, "mb-1.5")}>Add a step</p>
          <div role="group" aria-label={`Add a step to ${label}`} className="flex flex-wrap gap-2">
            {ADD.map((a) => (
              <Chip key={a.kind} disabled={a.kind === "nurse" && nurses} onClick={() => setSteps((list) => [...list, newStep(a.kind)])} aria-label={`Add a step: ${a.label}`}>
                <Icon name={a.icon} size={16} /> {a.label}
              </Chip>
            ))}
          </div>
          {nurses && <p className={cx(tone.muted, "mt-1.5 text-[13px] leading-snug")}>One nursing step a feed: both sides go in it.</p>}
        </div>
      )}
    </div>
  );
}

// ── a step ─────────────────────────────────────────────────────────────────

function StepEditor({ step, index, count, feedName, afterNurse, unit, hasTarget, watch, problem, onChange, onMove, onRemove }: {
  step: StepDraft;
  index: number;
  count: number;
  feedName: string;
  afterNurse: boolean;
  unit: PlanDraft["unit"];
  hasTarget: boolean;
  watch: Watch;
  problem: string | null;
  onChange: (s: StepDraft) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const title = stepTitle(step, afterNurse);
  const n = index + 1;
  const name = `${feedName}, step ${n}`;
  return (
    <li role="group" aria-label={`${name}: ${title}`} data-plan-step={step.key} className={cx(tone.inset, "min-w-0 space-y-3 px-3.5 pt-1.5 pb-3", problem && "ring-2 ring-mp-danger/40")}>
      <div className="flex items-center gap-1">
        <span aria-hidden className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-mp-raised text-[12px] font-semibold text-mp-ink-2 tabular-nums">
          {n}
        </span>
        <p className={cx(tone.heading, "ml-1.5 min-w-0 flex-1 text-[15px]")}>{title}</p>
        <IconButton icon="chevron-up" label={`Move step ${n} up`} disabled={index === 0} onClick={() => onMove(-1)} />
        <IconButton icon="chevron-down" label={`Move step ${n} down`} disabled={index === count - 1} onClick={() => onMove(1)} />
        <IconButton icon="x" label={`Take out step ${n}`} onClick={onRemove} />
      </div>
      {step.do === "nurse" && <NurseFields step={step} name={name} unit={unit} watch={watch} onChange={onChange} />}
      {step.do === "pump" && (
        <NumberRange label="Minutes" word="min" aria={`${name}, pump minutes`} value={step.minutes} max={MAX_MINUTES} onChange={(minutes) => onChange({ ...step, minutes })} watch={watch} wkey={`${step.key}:min`} />
      )}
      {step.do === "bottle" && <BottleFields step={step} name={name} unit={unit} hasTarget={hasTarget} watch={watch} onChange={onChange} />}
      {step.do === "note" && <TextArea ariaLabel={`${name}, note`} value={step.text} maxLength={PLAN_LIMITS.note} placeholder="Like “Burp halfway”" onChange={(text) => onChange({ ...step, text })} />}
      <Problem>{problem}</Problem>
    </li>
  );
}

function NurseFields({ step, name, unit, watch, onChange }: { step: NurseDraft; name: string; unit: PlanDraft["unit"]; watch: Watch; onChange: (s: NurseDraft) => void }) {
  const via = step.atBreast;
  return (
    <>
      <NumberRange label={step.each_side ? "Minutes on each side" : "Minutes"} word="min" aria={`${name}, nursing minutes`} value={step.minutes} max={MAX_MINUTES} onChange={(minutes) => onChange({ ...step, minutes })} watch={watch} wkey={`${step.key}:min`} />
      <div role="group" aria-label={`${name}: how`} className="flex flex-wrap gap-2">
        <Chip raised selected={step.each_side} onClick={() => onChange({ ...step, each_side: !step.each_side })}>
          Each side
        </Chip>
        <Chip raised selected={step.shield} onClick={() => onChange({ ...step, shield: !step.shield })}>
          Nipple shield
        </Chip>
      </div>
      <div>
        <Label>Milk at the breast</Label>
        <div role="group" aria-label={`${name}: milk at the breast`} className="flex flex-wrap gap-2">
          {AT_BREAST.map((v) => (
            <Chip key={v} raised selected={via === v} onClick={() => onChange({ ...step, atBreast: v })}>
              {v === "none" ? "None" : AT_BREAST_WORDS[v].name}
            </Chip>
          ))}
        </div>
      </div>
      {via !== "none" && (
        <>
          <AmountRange label={`How much ${AT_BREAST_WORDS[via].inThe}`} aria={`${name}, milk ${AT_BREAST_WORDS[via].inThe}`} value={step.atBreastMl} unit={unit} onChange={(atBreastMl) => onChange({ ...step, atBreastMl })} watch={watch} wkey={`${step.key}:ml`} />
          <MilkChoice name={name} value={step.atBreastMilk} options={MILKS.slice(0, 3)} onChange={(atBreastMilk) => onChange({ ...step, atBreastMilk })} />
        </>
      )}
    </>
  );
}

function BottleFields({ step, name, unit, hasTarget, watch, onChange }: { step: BottleDraft; name: string; unit: PlanDraft["unit"]; hasTarget: boolean; watch: Watch; onChange: (s: BottleDraft) => void }) {
  return (
    <>
      <div>
        <Label>How much</Label>
        <div role="group" aria-label={`${name}: how much`} className="flex flex-wrap gap-2">
          <Chip raised selected={step.amount === "ml"} onClick={() => onChange({ ...step, amount: "ml" })}>
            An amount
          </Chip>
          <Chip raised selected={step.amount === "target"} onClick={() => onChange({ ...step, amount: "target" })}>
            Up to the target
          </Chip>
        </div>
      </div>
      {step.amount === "ml" ? (
        <AmountRange aria={`${name}, amount`} value={step.ml} unit={unit} onChange={(ml) => onChange({ ...step, ml })} watch={watch} wkey={`${step.key}:ml`} />
      ) : (
        !hasTarget && <p className={cx(tone.muted, "text-[13px] leading-snug")}>Set the target per feed above, so it says how much.</p>
      )}
      <MilkChoice name={name} value={step.milk} options={MILKS} onChange={(milk) => onChange({ ...step, milk })} />
      <div>
        <Label optional>How it&apos;s given</Label>
        <div role="group" aria-label={`${name}: how it's given`} className="flex flex-wrap gap-2">
          {VIAS.map((o) => (
            <Chip key={o.value} raised selected={step.via === o.value} onClick={() => onChange({ ...step, via: step.via === o.value ? null : o.value })}>
              {o.label}
            </Chip>
          ))}
        </div>
      </div>
    </>
  );
}

function MilkChoice({ name, value, options, onChange }: { name: string; value: PlanMilk | null; options: typeof MILKS; onChange: (m: PlanMilk | null) => void }) {
  return (
    <div>
      <Label optional>Milk</Label>
      <div role="group" aria-label={`${name}: milk`} className="flex flex-wrap gap-2">
        {options.map((o) => (
          <Chip key={o.value} raised selected={value === o.value} onClick={() => onChange(value === o.value ? null : o.value)}>
            {o.label}
          </Chip>
        ))}
      </div>
    </div>
  );
}

// ── the day's turns and the night ──────────────────────────────────────────

function TurnsEditor({ draft, change }: { draft: PlanDraft; change: Change }) {
  const addable = draft.feeds.filter((f) => !draft.order.includes(f.key) && f.key !== draft.night.feed);
  const setOrder = (order: string[]) => change((d) => ({ ...d, order }));
  return (
    <FormSection title="Taking turns by day">
      <p className={cx(tone.muted, "-mt-1 px-1 text-[13px] leading-snug")}>
        {draft.order.length > 1 ? "By day the feeds go in this order, then start again." : "By day every feed is this one."}
      </p>
      <ol aria-label="Taking turns by day" className={cx(tone.card, tone.divide, "overflow-hidden")}>
        {draft.order.map((k, i) => (
          <li key={k} className="flex min-h-[52px] items-center gap-1 py-1 pr-1.5 pl-4">
            <span className="w-5 shrink-0 text-[15px] font-semibold text-mp-ink-2 tabular-nums">{i + 1}</span>
            <span className="min-w-0 flex-1 text-[15px] text-mp-ink [overflow-wrap:anywhere]">{feedLabel(draft, k)}</span>
            <IconButton icon="chevron-up" label={`Move ${feedLabel(draft, k)} earlier`} disabled={i === 0} onClick={() => setOrder(move(draft.order, i, -1))} />
            <IconButton icon="chevron-down" label={`Move ${feedLabel(draft, k)} later`} disabled={i === draft.order.length - 1} onClick={() => setOrder(move(draft.order, i, 1))} />
            <IconButton icon="x" label={`Take ${feedLabel(draft, k)} out of the turns`} disabled={draft.order.length === 1} onClick={() => setOrder(draft.order.filter((x) => x !== k))} />
          </li>
        ))}
      </ol>
      {addable.length > 0 && (
        <div>
          <p className={cx(tone.label, "mb-1.5 px-1")}>Add to the turns</p>
          <div className="flex flex-wrap gap-2">
            {addable.map((f) => (
              <Chip key={f.key} onClick={() => setOrder([...draft.order, f.key])} aria-label={`Add ${feedLabel(draft, f.key)} to the turns`}>
                <Icon name="plus" size={16} /> {feedLabel(draft, f.key)}
              </Chip>
            ))}
          </div>
        </div>
      )}
    </FormSection>
  );
}

function NightEditor({ draft, change, watch }: { draft: PlanDraft; change: Change; watch: Watch }) {
  const w = useBabyWords();
  const n = draft.night;
  const setNight = (patch: Partial<PlanDraft["night"]>) => change((d) => ({ ...d, night: { ...d.night, ...patch } }));
  return (
    <FormSection title="At night">
      <div className={GROUP}>
        <Toggle label="Different at night" hint="Its own hours, time between feeds, waking or feed." checked={n.on} onChange={(on) => setNight({ on })} />
        {n.on && (
          <>
            <div className="space-y-4 px-4 py-4">
              <div className="flex flex-wrap gap-3">
                <label className="min-w-[8.5rem] flex-1">
                  <span className={cx(tone.label, "mb-1.5 block")}>Night starts</span>
                  <input type="time" aria-label="Night starts" value={n.from} onChange={(e) => setNight({ from: e.target.value })} className={cx(tone.input, "min-w-0 tabular-nums")} />
                </label>
                <label className="min-w-[8.5rem] flex-1">
                  <span className={cx(tone.label, "mb-1.5 block")}>Night ends</span>
                  <input type="time" aria-label="Night ends" value={n.to} onChange={(e) => setNight({ to: e.target.value })} className={cx(tone.input, "min-w-0 tabular-nums")} />
                </label>
              </div>
              <div className="space-y-2">
                <HoursRange title="Time between feeds at night, in hours" aria="hours between feeds at night" value={n.every} onChange={(every) => setNight({ every })} watch={watch} wkey="night-every" />
                <p className={cx(tone.muted, "text-[13px] leading-snug")}>Leave empty to keep the day&apos;s.</p>
              </div>
            </div>
            <Toggle label="Wake to feed at night" hint={wakeHint(rangeOut(n.every) ?? rangeOut(draft.every), w)} checked={n.wake} onChange={(wake) => setNight({ wake })} />
            {draft.feeds.length > 1 && (
              <div className="px-4 py-4">
                <Label>The night&apos;s feed</Label>
                <div role="group" aria-label="The night's feed" className="flex flex-wrap gap-2">
                  <Chip selected={!n.feed} onClick={() => change((d) => setNightFeed(d, null))}>
                    Same turns as by day
                  </Chip>
                  {draft.feeds.map((f) => (
                    <Chip key={f.key} selected={n.feed === f.key} onClick={() => change((d) => setNightFeed(d, f.key))}>
                      {feedLabel(draft, f.key)}
                    </Chip>
                  ))}
                </div>
                {n.feed && <p className={cx(tone.muted, "mt-1.5 text-[13px] leading-snug")}>Every feed at night is this one. It doesn&apos;t take a turn by day.</p>}
              </div>
            )}
          </>
        )}
      </div>
    </FormSection>
  );
}

// ── fields ─────────────────────────────────────────────────────────────────

function FormSection({ title, count, children }: { title: string; count?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-2.5">
      <h3 className={cx(tone.heading, "flex items-baseline justify-between gap-2 px-1 text-[16px]")}>
        {title}
        {count && <span className={cx(tone.faint, "text-[12px] font-normal tabular-nums")}>{count}</span>}
      </h3>
      {children}
    </section>
  );
}

function IconButton({ icon, label, onClick, disabled }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="mp-control flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-mp-ink-2 transition active:bg-mp-ink/5 disabled:opacity-30"
    >
      <Icon name={icon} size={18} />
    </button>
  );
}

function Problem({ children }: { children?: string | null }) {
  if (!children) return null;
  return (
    <p role="alert" data-plan-problem className="text-[13px] font-semibold text-mp-danger">
      {children}
    </p>
  );
}

/** One end of a range: typed, kept as typed until it reads as a number (a typo stays on screen, marked). */
function NumberBox({ value, max, ariaLabel, onChange, onInvalid }: { value: number | null; max: number; ariaLabel: string; onChange: (v: number | null) => void; onInvalid: (invalid: boolean) => void }) {
  const { text, setText, invalid } = useTypedNumber(value, max, onInvalid);
  return (
    <input
      inputMode="decimal"
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseTypedNumber(e.target.value, max).value);
      }}
      className={cx(BOX, invalid && BAD)}
    />
  );
}

/** From–to as typed, in its own unit ("12 to 18 min"); the second end is optional (one number). */
function NumberRange({ label, word, aria, value, max, onChange, watch, wkey, toShown = (n) => n, fromShown = (n) => n }: {
  label?: string;
  word: string;
  aria: string;
  value: RangeDraft;
  max: number;
  onChange: (r: RangeDraft) => void;
  watch: Watch;
  wkey: string;
  toShown?: (n: number | null) => number | null;
  fromShown?: (n: number | null) => number | null;
}) {
  const [bad, setBad] = useState({ min: false, max: false });
  const report = (end: "min" | "max") => (invalid: boolean) => {
    setBad((b) => (b[end] === invalid ? b : { ...b, [end]: invalid }));
    watch(`${wkey}:${end}`)(invalid);
  };
  return (
    <div role="group" aria-label={aria}>
      {label && <Label>{label}</Label>}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <NumberBox value={toShown(value.min)} max={max} ariaLabel={`${aria}, from`} onChange={(v) => onChange({ ...value, min: fromShown(v) })} onInvalid={report("min")} />
        <span className={cx(tone.muted, "text-[15px]")}>to</span>
        <NumberBox value={toShown(value.max)} max={max} ariaLabel={`${aria}, up to`} onChange={(v) => onChange({ ...value, max: fromShown(v) })} onInvalid={report("max")} />
        <span className={cx(tone.muted, "text-[15px]")}>{word}</span>
      </div>
      <NumberProblem show={bad.min || bad.max} />
    </div>
  );
}

/** An amount from–to in the plan's unit, kept in ml (so ml ↔ oz never changes it). */
function AmountRange({ label, aria, value, unit, onChange, watch, wkey }: { label?: string; aria: string; value: RangeDraft; unit: PlanDraft["unit"]; onChange: (r: RangeDraft) => void; watch: Watch; wkey: string }) {
  return (
    <NumberRange
      label={label}
      word={unit}
      aria={`${aria}, in ${unit}`}
      value={value}
      max={amountMax(unit)}
      toShown={(ml) => shownAmount(ml, unit)}
      fromShown={(n) => typedAmount(n, unit)}
      onChange={onChange}
      watch={watch}
      wkey={wkey}
    />
  );
}

/** Hours from–to in half-hour steps, kept in minutes; two steppers abreast where they fit, else one above the other. */
function HoursRange({ title, aria, value, onChange, watch, wkey }: { title: string; aria: string; value: RangeDraft; onChange: (r: RangeDraft) => void; watch: Watch; wkey: string }) {
  const hours = (m: number | null) => (m == null ? null : Math.round((m / 60) * 100) / 100);
  const minutes = (h: number | null) => (h == null ? null : Math.round(h * 600) / 10);
  return (
    <div role="group" aria-label={aria} className="@container/hours">
      <p className={cx(tone.label, "mb-2")}>{title}</p>
      <div className="grid grid-cols-1 gap-3 @min-[18rem]/hours:grid-cols-2">
        <HalfHours label="From" ariaLabel={`${aria}, from`} value={hours(value.min)} other={hours(value.max)} onChange={(h) => onChange({ ...value, min: minutes(h) })} onInvalid={watch(`${wkey}:min`)} />
        <HalfHours label="To" ariaLabel={`${aria}, to`} value={hours(value.max)} other={hours(value.min)} onChange={(h) => onChange({ ...value, max: minutes(h) })} onInvalid={watch(`${wkey}:max`)} />
      </div>
    </div>
  );
}

const HOUR_BTN = "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-mp-sunken text-mp-ink";

/**
 * Hours, half an hour a tap (hold to keep going), or typed. An empty one's
 * first tap goes on from the range's other end ("From 2.5", then + on To
 * gives 3), never from a number nobody gave.
 */
function HalfHours({ label, ariaLabel, value, other, onChange, onInvalid }: { label: string; ariaLabel: string; value: number | null; other: number | null; onChange: (h: number | null) => void; onInvalid: (invalid: boolean) => void }) {
  const { text, setText, invalid } = useTypedNumber(value, MAX_HOURS, onInvalid);
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);
  const bump = (by: number) => {
    const next = Math.min(MAX_HOURS, Math.max(0.5, Math.round(((latest.current ?? other ?? 0) + by) * 100) / 100));
    latest.current = next;
    onChange(next);
  };
  const from = value ?? other;
  return (
    <div className="min-w-0">
      <span className={cx(tone.label, "mb-1.5 block")}>{label}</span>
      <div className="flex items-center gap-1">
        <RepeatButton ariaLabel={`Half an hour less, ${ariaLabel}`} onStep={() => bump(-0.5)} disabled={from == null || from <= 0.5} className={HOUR_BTN}>
          <Icon name="minus" size={20} />
        </RepeatButton>
        <input
          inputMode="decimal"
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onChange(parseTypedNumber(e.target.value, MAX_HOURS).value);
          }}
          className={cx(
            "h-12 w-full min-w-0 flex-1 rounded-xl border bg-mp-surface px-1 text-center text-lg font-semibold text-mp-ink tabular-nums outline-none transition focus:ring-2",
            invalid ? "border-mp-danger ring-2 ring-mp-danger/25 focus:ring-mp-danger/25" : "border-mp-line focus:border-mp-focus focus:ring-mp-focus/25"
          )}
        />
        <RepeatButton ariaLabel={`Half an hour more, ${ariaLabel}`} onStep={() => bump(0.5)} disabled={(value ?? 0) >= MAX_HOURS} className={HOUR_BTN}>
          <Icon name="plus" size={20} />
        </RepeatButton>
      </div>
      <NumberProblem show={invalid} />
    </div>
  );
}
