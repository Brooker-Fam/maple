"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { forMom, parseUnits } from "@/lib/maple/care";
import { ACETAMINOPHEN_NAMES, MOM_MED_NOTE, OPIOID_NAMES, OPIOID_NOTE, ZURANOLONE_NAMES } from "@/lib/maple/guidelines";
import { DEFAULT_TZ, addDays, dayKey } from "@/lib/maple/time";
import type { CarePlan, LimitUnit, MedReason, MedSchedule, PlanInput } from "@/lib/maple/types";
import { Icon } from "../icons";
import { Label, MoreDetails, SheetFooter, useOpenCount } from "../sheets/parts";
import { Button, Chip, Sheet, cx, tone } from "../ui";
import { ApiError, useMaple } from "../useMaple";
import { ConfirmSheet, LIMIT_UNITS, NoteCard, Problem, Switch, UNIT_LABEL, errorText } from "./parts";
import type { UseCare } from "./useCare";

/**
 * "Add a medicine" / "Edit {name}" (§5.1): five rows, the rest folded under
 * "More details". Every number is typed from her label, discharge papers or
 * clinician: fields start blank, no placeholder or hint holds a digit, and no
 * unit is preselected. The limit is kept in the label's own unit, so the
 * 24-hour count adds up what each dose counts, not taps.
 */
export type MedPlanSheetProps = {
  open: boolean;
  onClose: () => void;
  care: UseCare;
  /** Edit this plan; none adds one. */
  plan?: CarePlan;
  /** After Delete: the plan is gone, so whatever showed it should close too. */
  onDeleted?: () => void;
};

type How = MedSchedule["type"];
type Until = "stop" | "date" | "days";

const HOW: { value: How; label: string }[] = [
  { value: "as_needed", label: "As needed" },
  { value: "every", label: "Every few hours" },
  { value: "daily", label: "Each day" },
  { value: "times", label: "At set times" },
];
const UNTIL: { value: Until; label: string }[] = [
  { value: "stop", label: "Until told to stop" },
  { value: "date", label: "An end date" },
  { value: "days", label: "For a number of days" },
];
const REASONS: { value: MedReason; label: string }[] = [
  { value: "pain", label: "Pain" },
  { value: "constipation", label: "Constipation" },
  { value: "bp", label: "Blood pressure" },
  { value: "iron", label: "Iron" },
  { value: "infection", label: "Infection" },
  { value: "mood", label: "Mood" },
  { value: "vitamin", label: "Vitamin" },
  { value: "other", label: "Other" },
];

// §11.3 validation copy (validation messages may hold digits; placeholders and hints never do).
const PROBLEM = {
  name: "Add the medicine's name.",
  hours: "Enter hours between ¼ and 72.",
  limit: "Enter the number from the label: a whole number for tablets, caplets, capsules or doses.",
  unit: "Choose what the label counts: tablets, caplets, capsules, doses or mL.",
  each: "That's more each time than the 24-hour limit. Check both against the label.",
  every: "How many hours between doses? Copy it from the label.",
  perDay: "How many times a day? Copy it from the label.",
  perDayRange: "Enter a whole number of times a day, up to 8.",
  times: "Add at least one time.",
  end: "The end date is before the start.",
  endMissing: "Choose the end date.",
  days: "How many days? Copy it from the label.",
} as const;

type Form = {
  name: string;
  dose: string;
  how: How;
  gapH: string;
  everyH: string;
  perDay: string;
  times: string[];
  limit: string;
  unit: LimitUnit | null;
  each: string;
  until: Until;
  end: string;
  days: string;
  label: string;
  also: string;
  reason: MedReason | null;
  /** null: not touched yet, so it follows the name (create only). */
  apap: boolean | null;
  start: string;
  instructions: string;
  showToday: boolean | null;
  priv: boolean | null;
};

const hoursText = (min: number | null | undefined) => (min == null ? "" : String(Math.round((min / 60) * 100) / 100));
const parseNum = (t: string) => (t.trim() === "" ? null : Number(t.trim().replace(",", ".")));

function fromPlan(p: CarePlan | undefined, today: string): Form {
  const s = p?.schedule;
  return {
    name: p?.name ?? "",
    dose: p?.dose_text ?? "",
    how: s?.type ?? "as_needed",
    gapH: s?.type === "as_needed" ? hoursText(s.min_gap_min) : "",
    everyH: s?.type === "every" ? hoursText(s.every_min) : "",
    perDay: s?.type === "daily" ? String(s.per_day) : "",
    times: s?.type === "times" ? [...s.times] : [],
    limit: p?.max_24h != null ? String(p.max_24h) : "",
    unit: p?.limit_unit ?? null,
    each: p?.units_per_dose ?? "",
    until: p?.course_end ? "date" : "stop",
    end: p?.course_end ?? "",
    days: "",
    label: p?.label_text ?? "",
    also: p?.also_called ?? "",
    reason: p?.reason ?? null,
    apap: p ? p.contains_apap : null,
    start: p?.course_start ?? today,
    instructions: p?.instructions ?? "",
    showToday: p ? p.show_on_today : null,
    priv: p ? p.private : null,
  };
}

export default function MedPlanSheet(props: MedPlanSheetProps) {
  const n = useOpenCount(props.open);
  return <PlanForm key={`${n}-${props.plan?.id ?? "new"}`} {...props} />;
}

function PlanForm({ open, onClose, care, plan, onDeleted }: MedPlanSheetProps) {
  const { state, now, memberName, refresh } = useMaple();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const today = dayKey(now(), tz);
  const [base, setBase] = useState<CarePlan | undefined>(plan);
  const [f, setF] = useState<Form>(() => fromPlan(plan, today));
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const conflictRef = useRef<HTMLParagraphElement>(null);
  // The "changed a moment ago" line sits at the top: bring it into view from wherever Save was tapped.
  useEffect(() => {
    if (conflict) conflictRef.current?.scrollIntoView({ block: "nearest" });
  }, [conflict]);

  // Someone else changed this plan first: once the state has their version, the form shows it.
  const latest = base ? care.state.plans.find((p) => p.id === base.id) : undefined;
  useEffect(() => {
    if (!conflict || !latest || !base || latest.updated_at === base.updated_at) return;
    setBase(latest);
    setF(fromPlan(latest, today));
  }, [conflict, latest, base, today]);

  // Her own past plan names, for autocomplete (names only; never a drug list).
  const pastNames = [...new Set(care.state.plans.map((p) => p.name))];

  const onlyMe = care.access.private && (f.priv ?? (!base && (f.reason === "mood" || ZURANOLONE_NAMES.test(f.name))));
  const apap = f.apap ?? (!base && ACETAMINOPHEN_NAMES.test(`${f.name} ${f.also}`));
  const showToday = f.showToday ?? ((f.how === "as_needed" || f.how === "every") && !onlyMe);
  const eachShown = !!f.unit && f.unit !== "doses";
  // §5.7: an opioid name gets its note here as well as on the card, so it's read once at save (a name hint, never a gate).
  const opioid = [f.name, ...f.also.split(",")].some((n) => n.trim() && OPIOID_NAMES.test(n));

  // ── Validation (§11.3) ──
  const errs: Partial<Record<"name" | "gap" | "every" | "perDay" | "times" | "limit" | "unit" | "each" | "end" | "days", string>> = {};
  if (!f.name.trim()) errs.name = PROBLEM.name;
  const hours = (t: string) => {
    const h = parseNum(t);
    return h != null && Number.isFinite(h) && h >= 0.25 && h <= 72 ? h : null;
  };
  if (f.how === "as_needed" && f.gapH.trim() && hours(f.gapH) == null) errs.gap = PROBLEM.hours;
  if (f.how === "every") errs.every = !f.everyH.trim() ? PROBLEM.every : hours(f.everyH) == null ? PROBLEM.hours : undefined;
  const perDay = parseNum(f.perDay);
  if (f.how === "daily") errs.perDay = !f.perDay.trim() ? PROBLEM.perDay : perDay == null || !Number.isInteger(perDay) || perDay < 1 || perDay > 8 ? PROBLEM.perDayRange : undefined;
  const times = [...new Set(f.times.filter((t) => /^\d{2}:\d{2}$/.test(t)))].sort();
  if (f.how === "times" && !times.length) errs.times = PROBLEM.times;
  const limit = parseNum(f.limit);
  if (f.limit.trim()) {
    if (!f.unit) errs.unit = PROBLEM.unit;
    const ok =
      limit != null &&
      Number.isFinite(limit) &&
      (f.unit === "mL" ? limit >= 0.5 && limit <= 1000 : Number.isInteger(limit) && limit >= 1 && limit <= 48);
    if (!ok) errs.limit = PROBLEM.limit;
    const fixed = eachShown ? parseUnits(f.each).fixed : undefined;
    if (ok && fixed != null && limit != null && fixed > limit) errs.each = PROBLEM.each;
  }
  if (f.until === "date") errs.end = !f.end ? PROBLEM.endMissing : f.end < f.start ? PROBLEM.end : undefined;
  const days = parseNum(f.days);
  if (f.until === "days" && (days == null || !Number.isInteger(days) || days < 1 || days > 365)) errs.days = PROBLEM.days;
  const firstProblem = Object.values(errs).find(Boolean);
  const shown = (k: keyof typeof errs) => (tried ? errs[k] : undefined);

  const schedule = (): MedSchedule => {
    if (f.how === "every") return { type: "every", every_min: Math.round((hours(f.everyH) ?? 0) * 60) };
    if (f.how === "daily") return { type: "daily", per_day: perDay ?? 1 };
    if (f.how === "times") return { type: "times", times };
    const g = hours(f.gapH);
    return { type: "as_needed", min_gap_min: g == null ? null : Math.round(g * 60) };
  };

  const save = async () => {
    setTried(true);
    if (firstProblem || busy) return;
    setBusy(true);
    setProblem(null);
    const hasLimit = !!f.limit.trim() && limit != null;
    const end = f.until === "date" ? f.end : f.until === "days" && days ? addDays(f.start, days - 1) : null;
    const input: PlanInput = {
      ...(base ? { id: base.id } : {}),
      name: f.name.trim(),
      dose_text: f.dose.trim() || null,
      schedule: schedule(),
      max_24h: hasLimit ? limit : null,
      limit_unit: hasLimit ? f.unit : null,
      units_per_dose: hasLimit && eachShown && f.each.trim() ? f.each.trim() : null,
      label_text: f.label.trim() || null,
      also_called: f.also.trim() || null,
      reason: f.reason,
      contains_apap: apap,
      course_start: f.start || today,
      course_end: end,
      instructions: f.instructions.trim() || null,
      show_on_today: showToday,
      ...(care.access.private ? { private: onlyMe } : {}),
    };
    try {
      await care.act.savePlan(input, base?.updated_at);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && base) {
        // "Matt changed this plan a moment ago. Here's the latest." (the server's words), and the form shows theirs.
        const body = e.body as { plan?: CarePlan; updated_by?: string | null } | null;
        const by = body?.plan?.updated_by ?? body?.updated_by ?? latest?.updated_by ?? null;
        setConflict(/changed/.test(e.message) ? e.message : `${by ? memberName(by) : "Someone"} changed this plan a moment ago. Here's the latest.`);
        if (body?.plan) {
          setBase(body.plan);
          setF(fromPlan(body.plan, today));
        } else void refresh();
      } else setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // Closes first, so "Deleted {name}" and its Undo land on the screen underneath (useCare says it, and any refusal).
  const del = () => {
    if (!base) return;
    setConfirmDelete(false);
    onClose();
    onDeleted?.();
    void care.act.deletePlan(base.id).catch(() => {});
  };

  const unitWord = f.unit;

  return (
    <>
      <Sheet
        open={open && !confirmDelete}
        onClose={onClose}
        title={base ? `Edit ${base.name}` : "Add a medicine"}
        footer={
          <div>
            <Problem className="mt-0 mb-2 text-center">{problem}</Problem>
            <SheetFooter
              onClose={onClose}
              onDelete={base ? () => setConfirmDelete(true) : undefined}
              onPrimary={() => void save()}
              label="Save"
              busy={busy}
              hint={tried && firstProblem ? firstProblem : undefined}
            />
          </div>
        }
      >
        {conflict && (
          <p ref={conflictRef} role="status" className={cx(tone.inset, tone.body, "flex gap-2.5 px-3.5 py-3 text-sm leading-relaxed")}>
            <Icon name="refresh-cw" size={18} className="mt-px shrink-0 text-mp-ink-2" />
            <span>{conflict}</span>
          </p>
        )}
        <p className={cx(tone.muted, "text-[13px] leading-relaxed")}>{MOM_MED_NOTE}</p>

        <FieldBlock label="Name" hint="As on the label." problem={shown("name")}>
          <input
            value={f.name}
            maxLength={80}
            list="care-plan-names"
            autoComplete="off"
            aria-label="Name"
            onChange={(e) => set("name", e.target.value)}
            className={cx(tone.input, shown("name") && BAD)}
          />
          <datalist id="care-plan-names">
            {pastNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </FieldBlock>

        <FieldBlock label="Dose as prescribed" optional hint="Copy it from the label: the strength and how many.">
          <input value={f.dose} maxLength={80} aria-label="Dose as prescribed" onChange={(e) => set("dose", e.target.value)} className={tone.input} />
        </FieldBlock>

        <div>
          <Label>How often</Label>
          <Choice options={HOW} value={f.how} onChange={(v) => set("how", v)} cols={2} label="How often" />
          <div className="mt-3">
            {f.how === "as_needed" && (
              <FieldBlock hint="The smallest number on the label. Leave it blank if it doesn't say." problem={shown("gap")}>
                <Inline before="No sooner than every" after="hours">
                  <NumIn value={f.gapH} onChange={(v) => set("gapH", v)} label="No sooner than every how many hours" bad={!!shown("gap")} />
                </Inline>
              </FieldBlock>
            )}
            {f.how === "every" && (
              <FieldBlock hint="As on the label." problem={shown("every")}>
                <Inline before="Every" after="hours">
                  <NumIn value={f.everyH} onChange={(v) => set("everyH", v)} label="Every how many hours" bad={!!shown("every")} />
                </Inline>
              </FieldBlock>
            )}
            {f.how === "daily" && (
              <FieldBlock problem={shown("perDay")}>
                <Inline after="times a day">
                  <NumIn value={f.perDay} onChange={(v) => set("perDay", v)} label="How many times a day" whole bad={!!shown("perDay")} />
                </Inline>
              </FieldBlock>
            )}
            {f.how === "times" && (
              <FieldBlock problem={shown("times")}>
                <div className="space-y-2">
                  {f.times.map((t, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        type="time"
                        value={t}
                        aria-label={`Time ${i + 1}`}
                        onChange={(e) => set("times", f.times.map((x, j) => (j === i ? e.target.value : x)))}
                        className={cx(tone.input, "w-40! tabular-nums")}
                      />
                      <button
                        type="button"
                        aria-label="Remove this time"
                        onClick={() => set("times", f.times.filter((_, j) => j !== i))}
                        className="flex h-11 w-11 items-center justify-center rounded-full text-mp-ink-3 active:bg-mp-ink/5"
                      >
                        <Icon name="x" size={18} />
                      </button>
                    </div>
                  ))}
                  {f.times.length < 8 && (
                    <Button variant="soft" size="sm" onClick={() => set("times", [...f.times, ""])}>
                      <Icon name="plus" size={16} />
                      Add a time
                    </Button>
                  )}
                </div>
              </FieldBlock>
            )}
          </div>
        </div>

        <FieldBlock
          hint="As your label says, in the same unit it uses (tablets, caplets or doses). Leave it blank if it doesn't say."
          problem={shown("limit") ?? shown("unit")}
        >
          <Inline before="No more than" after={unitWord ? `${unitWord} in 24 hours` : "in 24 hours"}>
            <NumIn value={f.limit} onChange={(v) => set("limit", v)} label="No more than how many in 24 hours" decimals={f.unit === "mL"} bad={!!shown("limit")} />
          </Inline>
          <div className="mt-2.5 flex flex-wrap gap-2" role="radiogroup" aria-label="What the label counts">
            {LIMIT_UNITS.map((u) => (
              <Chip key={u} selected={f.unit === u} onClick={() => set("unit", f.unit === u ? null : u)}>
                {UNIT_LABEL[u]}
              </Chip>
            ))}
          </div>
        </FieldBlock>

        {eachShown && (
          <FieldBlock
            label="How many each time"
            optional
            hint="If the label gives a choice, type it the way the label says. Leave it blank to be asked each time."
            problem={shown("each")}
          >
            <input value={f.each} maxLength={20} aria-label="How many each time" onChange={(e) => set("each", e.target.value)} className={cx(tone.input, "w-40!", shown("each") && BAD)} />
          </FieldBlock>
        )}

        <div>
          <Label>Until</Label>
          <Choice options={UNTIL} value={f.until} onChange={(v) => set("until", v)} cols={3} label="Until" />
          {f.until === "date" && (
            <FieldBlock className="mt-3" problem={shown("end")}>
              <input type="date" value={f.end} min={f.start} aria-label="End date" onChange={(e) => set("end", e.target.value)} className={cx(tone.input, "w-48!", shown("end") && BAD)} />
            </FieldBlock>
          )}
          {f.until === "days" && (
            <FieldBlock className="mt-3" problem={shown("days")}>
              <Inline before="For" after="days">
                <NumIn value={f.days} onChange={(v) => set("days", v)} label="For how many days" whole bad={!!shown("days")} />
              </Inline>
            </FieldBlock>
          )}
        </div>

        {opioid && <NoteCard note={forMom(OPIOID_NOTE, care.name, care.self)} care={care} />}

        <MoreDetails summary={[f.reason && REASONS.find((r) => r.value === f.reason)?.label, onlyMe && "Only me"].filter(Boolean).join(" · ")}>
          <FieldBlock label="The label's words" optional hint="Copy how the label says it, so it's here to check.">
            <input value={f.label} maxLength={120} aria-label="The label's words" onChange={(e) => set("label", e.target.value)} className={tone.input} />
          </FieldBlock>
          <FieldBlock label="Also called" optional hint="Other names you'll say, like the brand on the box.">
            <input value={f.also} maxLength={80} aria-label="Also called" onChange={(e) => set("also", e.target.value)} className={tone.input} />
          </FieldBlock>
          <div>
            <Label optional>For</Label>
            <div className="flex flex-wrap gap-2">
              {REASONS.map((r) => (
                <Chip key={r.value} selected={f.reason === r.value} onClick={() => set("reason", f.reason === r.value ? null : r.value)}>
                  {r.label}
                </Chip>
              ))}
            </div>
          </div>
          <ToggleRow
            label="Contains acetaminophen"
            note="Check Active ingredients on the Drug Facts label; labels may say APAP. Ticked when the name often contains it; untick it if this one doesn't."
            checked={apap}
            onChange={(v) => set("apap", v)}
          />
          <FieldBlock label="Start" optional>
            <input type="date" value={f.start} aria-label="Start" onChange={(e) => set("start", e.target.value)} className={cx(tone.input, "w-48!")} />
          </FieldBlock>
          <FieldBlock label="Instructions" optional hint="Anything else the label says, like taking it with food.">
            <input value={f.instructions} maxLength={120} aria-label="Instructions" onChange={(e) => set("instructions", e.target.value)} className={tone.input} />
          </FieldBlock>
          {/* An Only me plan never shows on Today, so the switch would do nothing. */}
          {!onlyMe && <ToggleRow label="Show on Today" checked={showToday} onChange={(v) => set("showToday", v)} />}
          {care.access.private && (
            <ToggleRow
              label="Only me"
              note="Hidden from everyone else, their assistants and the admin login, and kept off Today."
              checked={onlyMe}
              onChange={(v) => set("priv", v)}
            />
          )}
        </MoreDetails>
      </Sheet>
      <ConfirmSheet
        open={open && confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${base?.name ?? "this medicine"}?`}
        body="It leaves the list. Doses already logged stay in the history."
        confirm="Delete"
        danger
        busy={busy}
        onConfirm={del}
      />
    </>
  );
}

const BAD = "border-mp-danger! ring-2! ring-mp-danger/25!";

function FieldBlock({
  label,
  optional,
  hint,
  problem,
  className,
  children,
}: {
  label?: string;
  optional?: boolean;
  hint?: string;
  problem?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      {label && <Label optional={optional}>{label}</Label>}
      {children}
      {problem ? <Problem>{problem}</Problem> : hint ? <p className={cx(tone.muted, "mt-1.5 text-xs leading-snug")}>{hint}</p> : null}
    </div>
  );
}

/** "No sooner than every [ ] hours": the number sits in her own sentence. */
function Inline({ before, after, children }: { before?: string; after?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[15px] text-mp-ink">
      {before && <span>{before}</span>}
      {children}
      {after && <span>{after}</span>}
    </div>
  );
}

/** A blank number box (never prefilled, no placeholder): whole numbers, or decimals for hours and mL. */
function NumIn({ value, onChange, label, whole, decimals = true, bad }: { value: string; onChange: (v: string) => void; label: string; whole?: boolean; decimals?: boolean; bad?: boolean }) {
  const dec = decimals && !whole;
  return (
    <input
      inputMode={dec ? "decimal" : "numeric"}
      aria-label={label}
      aria-invalid={bad || undefined}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(dec ? /[^\d.,]/g : /\D/g, "").slice(0, 7))}
      className={cx(tone.input, "w-[5.5rem]! text-center text-lg font-semibold tabular-nums", bad && BAD)}
    />
  );
}

/** A segmented choice that wraps onto a grid when its labels are long ("Every few hours", "Until told to stop"). */
function Choice<T extends string>({ options, value, onChange, cols, label }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; cols: 2 | 3; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cx("grid gap-[2px] rounded-xl bg-mp-sunken p-[2px]", cols === 2 ? "grid-cols-2" : "grid-cols-3")}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "min-h-[44px] rounded-[10px] px-2 py-1.5 text-sm leading-tight transition",
            value === o.value ? "bg-mp-raised font-semibold text-mp-ink shadow-[0_1px_3px_rgba(0,0,0,0.12)]" : "font-medium text-mp-ink-2"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ToggleRow({ label, note, checked, onChange }: { label: string; note?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className={cx(tone.body, "text-[15px]")}>{label}</div>
        {note && <p className={cx(tone.muted, "mt-0.5 text-xs leading-snug")}>{note}</p>}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}
