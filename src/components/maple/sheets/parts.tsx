"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { TapFeedData } from "@/lib/maple/feed";
import { MOM_HELP, MOM_TIER_LABEL, TIER_LABEL, overDailyMax, type AlertTier, type Assessment } from "@/lib/maple/guidelines";
import { babyAge, DEFAULT_TZ, dayKey, formatDayLabel, formatTime } from "@/lib/maple/time";
import type { Entry, EntryKind, Source, StretchSide } from "@/lib/maple/types";
import { fixPreset } from "../FeedParts";
import { Icon, type IconName } from "../icons";
import { SIDE_COLOR } from "../palette";
import { Avatar, Button, NumberProblem, RepeatButton, TextArea, cx, parseTypedNumber, tone, useTypedNumber } from "../ui";
import { useMaple } from "../useMaple";
import { useSheets } from "./index";

/**
 * Shared pieces for the log/edit sheets: a fresh form each time a sheet
 * opens, the "Logged by …" line, the sticky footer, the "More details"
 * disclosure, calm guidance cards, and small steppers that fit two abreast.
 */

/**
 * Counts how many times the sheet has opened. The sheet router keeps one
 * instance mounted per kind (so it can animate out), so sheets key their form
 * on this to start fresh each time instead of showing last time's values.
 */
export function useOpenCount(open: boolean): number {
  const [s, setS] = useState({ open, n: open ? 1 : 0 });
  if (s.open !== open) setS({ open, n: open ? s.n + 1 : s.n });
  return s.n;
}

/** Everything most sheets need from the app state. */
export function useSheetBase() {
  const m = useMaple();
  const tz = m.state?.baby.timezone ?? DEFAULT_TZ;
  const bornAt = m.state?.baby.born_at ?? null;
  const n = m.now();
  const age = bornAt ? babyAge(bornAt, n, tz) : null;
  return {
    ...m,
    tz,
    bornAt,
    age,
    /** Completed days of life (0 before she's born). */
    ageDays: age?.days ?? 0,
    /** Completed months (0 before she's born, so newborn rules apply). */
    ageMonths: age?.months ?? 0,
    /** "3:12 AM" in the baby's timezone. */
    clock: (d: Date | string | number) => formatTime(d, tz),
  };
}

/** A preset value of the right type, or undefined. */
export const pstr = (p: Record<string, unknown> | undefined, k: string) => (typeof p?.[k] === "string" ? (p[k] as string) : undefined);
export const pnum = (p: Record<string, unknown> | undefined, k: string) =>
  typeof p?.[k] === "number" && Number.isFinite(p[k]) ? (p[k] as number) : undefined;
export const pbool = (p: Record<string, unknown> | undefined, k: string) => (typeof p?.[k] === "boolean" ? (p[k] as boolean) : undefined);

/** preset.started_at ("log an earlier one"), if it's a real time. */
export function presetStart(p: Record<string, unknown> | undefined): Date | null {
  const s = pstr(p, "started_at");
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? new Date(t) : null;
}

const VIA: Partial<Record<Source, string>> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  mcp: "an AI assistant",
  shortcut: "Siri",
};

/** A Done can land after the end it records (at the pause, or a time given), but a change this long after the end is an edit. */
const EDIT_AFTER_END_MS = 30 * 60_000;
/** A running timer's own taps write the row within moments of their tap time (the server's and the database's clocks). */
const TAP_SLACK_MS = 60_000;

/**
 * "changed by Brittany" or "edited", only for a real change, else null.
 * updated_by is the last writer and every timer tap writes it, so the
 * starter's own name there is usually just their Switch, Pause or Done.
 *   - Someone else: always named ("changed by Brittany").
 *   - Logged after the fact (typed minutes, a sleep logged once it ended, a
 *     moment like a diaper): any write since is an edit.
 *   - A timer, running: written well after its last tap (or its start), so a
 *     fix or a note, not a tap.
 *   - A timer, finished: written well after it ended (a fix or a note later
 *     on), not the Done itself.
 */
function editedText(entry: Entry, name: (id: string) => string): string | null {
  if (!entry.updated_by) return null;
  const updated = Date.parse(entry.updated_at);
  const created = Date.parse(entry.created_at);
  const ended = entry.ended_at ? Date.parse(entry.ended_at) : null;
  const tap = entry.kind === "feed" ? Date.parse((entry.data as TapFeedData).last_tap?.at ?? "") : NaN;
  // When Done was tapped (store.ts stopTimer): a Done that set an earlier end ("She finished 20 min ago") isn't an edit.
  const stop = Date.parse((entry.data as { stopped_at?: string }).stopped_at ?? "");
  const tapped = Math.max(created, Number.isFinite(tap) ? tap : 0, Number.isFinite(stop) ? stop : 0);
  if (entry.updated_by !== entry.created_by) {
    // Someone else's last write was a tap, not a fix: their Done says so; a switch or pause needs no word.
    if (Number.isFinite(stop) && Math.abs(updated - stop) <= TAP_SLACK_MS) return `ended by ${name(entry.updated_by)}`;
    if (Number.isFinite(tap) && Math.abs(updated - tap) <= TAP_SLACK_MS) return null;
    return `changed by ${name(entry.updated_by)}`;
  }
  if (entry.active) return updated - tapped > TAP_SLACK_MS ? "edited" : null;
  // It ran as a timer: a timed feed (its sides), or anything created before it ended. Logged afterwards (or with no
  // end at all), every write since was an edit.
  const timer = (entry.kind === "feed" && !!entry.data.segments?.length) || (ended !== null && created < ended - 5_000);
  if (!timer || ended === null) return "edited";
  // With the Done's own time (stopped_at), any write a minute past it is a fix; older rows only know when it ended.
  if (Number.isFinite(stop)) return updated - tapped > TAP_SLACK_MS ? "edited" : null;
  return updated - Math.max(ended, tapped) > EDIT_AFTER_END_MS ? "edited" : null;
}

/**
 * "[avatar] Logged by Matt via Claude · 3:12 AM · changed by Brittany", under the sheet title.
 * `noTime` (a timed feed): the day but no tap time, since right above its start and end rows it reads as one of them.
 */
export function LoggedBy({ entry, noTime }: { entry: Entry; noTime?: boolean }) {
  const { member, memberName, now, tz } = useSheetBase();
  const who = member(entry.created_by);
  const name = who?.display_name ?? memberName(entry.created_by);
  const via = VIA[entry.source];
  const created = new Date(entry.created_at);
  const day = formatDayLabel(dayKey(created, tz), dayKey(now(), tz));
  const when = `${day === "Today" ? "" : `${day} `}${formatTime(created, tz)}`;
  const editor = editedText(entry, memberName);
  return (
    <p className={cx(tone.muted, "flex items-start gap-2 text-[13px] leading-snug")}>
      {/* Their own emoji (or initial), the same mark the lists use. */}
      {who && <Avatar member={who} size={18} />}
      <span>
        Logged by {name}
        {via ? ` via ${via}` : ""}
        {noTime ? (day === "Today" ? "" : ` · ${day}`) : ` · ${when}`}
        {editor ? ` · ${editor}` : ""}
        {entry.id < 0 && " · waiting to sync"}
      </span>
    </p>
  );
}

/**
 * The sticky footer: [Delete] (quiet danger text, editing only) on the left
 * and the primary action on the right. Viewers just get Close.
 */
export function SheetFooter({
  onDelete,
  onPrimary,
  label,
  disabled,
  busy,
  hint,
  onClose,
}: {
  onDelete?: () => void;
  onPrimary: () => void;
  label: string;
  disabled?: boolean;
  busy?: boolean;
  /** One short line above the buttons (e.g. why Save is disabled). */
  hint?: ReactNode;
  onClose: () => void;
}) {
  const { readOnly } = useMaple();
  if (readOnly) {
    return (
      <div className="flex items-center gap-3">
        <p className={cx(tone.muted, "flex flex-1 items-center gap-2 text-sm")}>
          <Icon name="lock" size={16} className="shrink-0 text-mp-ink-3" />
          View only. Ask Matt or Brittany to change this.
        </p>
        <Button variant="soft" size="lg" onClick={onClose}>
          Close
        </Button>
      </div>
    );
  }
  return (
    <div>
      {hint && <p className={cx(tone.muted, "mb-2 text-center text-xs")}>{hint}</p>}
      <div className="flex items-center gap-3">
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="-ml-2 min-h-[52px] rounded-[14px] px-3 text-base font-semibold text-mp-danger transition hover:bg-mp-danger/10 active:scale-[0.97]"
          >
            Delete
          </button>
        )}
        <Button size="lg" className="flex-1" onClick={onPrimary} disabled={disabled || busy}>
          {busy ? "Saving…" : label}
        </Button>
      </div>
    </div>
  );
}

/**
 * Closed by default: the fields most people skip at 3am. A settings-style
 * row (label, what's set, chevron) on a card, so the chips and steppers
 * inside keep their contrast.
 */
export function MoreDetails({ summary, children, label = "More details" }: { summary?: string; children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();
  return (
    <div className={cx(tone.card, "overflow-hidden")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-[52px] w-full items-center gap-3 px-4 text-left"
      >
        <span className={cx(tone.body, "shrink-0 text-[15px] font-medium")}>{label}</span>
        <span className={cx(tone.muted, "min-w-0 flex-1 truncate text-right text-sm")}>{summary}</span>
        <Icon name="chevron-down" size={18} className={cx("shrink-0 text-mp-ink-3 transition", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-4 border-t border-mp-line px-4 pt-3.5 pb-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function NoteField({ value, onChange, placeholder = "Anything to remember?" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <span className={cx(tone.label, "mb-1.5 block")}>Note</span>
      <TextArea value={value} onChange={onChange} placeholder={placeholder} />
    </div>
  );
}

/** Muted context (typical ranges, how-tos). Never a target. */
export function ContextNote({
  icon = "info",
  children,
  className,
}: {
  icon?: IconName;
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={cx(tone.muted, "flex gap-2 text-[13px] leading-relaxed", className)}>
      <Icon name={icon} size={16} className="mt-[2px] shrink-0 text-mp-ink-3" />
      <span>{children}</span>
    </p>
  );
}

/** Label with a plain optional marker. */
export function Label({ children, optional, className }: { children: ReactNode; optional?: boolean; className?: string }) {
  return (
    <span className={cx(tone.label, "block", className ?? "mb-1.5")}>
      {children}
      {optional && <span className="ml-1 font-normal text-mp-ink-3">(optional)</span>}
    </span>
  );
}

/**
 * "● Left" / "● Right" for a field label: the side's dot, as on the dock.
 * Both sides ("B", back and forth) get a dot of both side colors and "Back
 * and forth" (or `bothLabel`), never Right's.
 */
export function SideLabel({ side, bothLabel = "Back and forth" }: { side: StretchSide; bothLabel?: string }) {
  if (side === "B") {
    return (
      <span className="inline-flex items-center gap-1.5">
        {/* Two halves, each a kind fill, so the night look folds them into the amber like any side dot. */}
        <span aria-hidden className="inline-flex h-2 w-2 overflow-hidden rounded-full">
          <span className="mp-kind-fill h-2 w-1" style={{ backgroundColor: SIDE_COLOR.L }} />
          <span className="mp-kind-fill h-2 w-1" style={{ backgroundColor: SIDE_COLOR.R }} />
        </span>
        {bothLabel}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="mp-kind-fill h-2 w-2 rounded-full" style={{ backgroundColor: SIDE_COLOR[side] }} />
      {side === "L" ? "Left" : "Right"}
    </span>
  );
}

/**
 * Alert tiers are information, so they keep their own colors in every look,
 * night included (the night amber would make them all the same): a left
 * rule and a soft tint, with the tier in its color above the guidance.
 * Emergency is solid red with white type, by day and at 3am alike.
 */
const TIER_STYLE: Record<AlertTier, { card: string; label: string; icon: IconName }> = {
  emergency: {
    card: "border-[#7A1A13] bg-[#A3241B] [.maple-night_&]:border-[#5A120D] [.maple-night_&]:bg-[#8A1D15]",
    label: "text-white/90",
    icon: "siren",
  },
  now: {
    card: "border-[#B5452B] bg-[#B5452B]/[0.09] [.maple-night_&]:border-[#D4492F] [.maple-night_&]:bg-[#D4492F]/[0.14]",
    label: "text-[#A3361F] dark:text-[#F29A85] [.maple-night_&]:text-[#EE6B4F]",
    icon: "phone",
  },
  today: {
    card: "border-[#D9772B] bg-[#D9772B]/[0.10] [.maple-night_&]:border-[#E0812E] [.maple-night_&]:bg-[#E0812E]/[0.12]",
    label: "text-[#97500F] dark:text-[#F2B077] [.maple-night_&]:text-[#E98D3E]",
    icon: "phone",
  },
  mention: {
    card: "border-[#5C7A4A] bg-[#5C7A4A]/[0.10] [.maple-night_&]:border-[#6E9455] [.maple-night_&]:bg-[#6E9455]/[0.12]",
    label: "text-[#3F5A30] dark:text-[#B3CB98] [.maple-night_&]:text-[#8DB274]",
    icon: "stethoscope",
  },
  nudge: {
    card: "border-[#C49A3C] bg-[#C49A3C]/[0.12] [.maple-night_&]:border-[#A88A45] [.maple-night_&]:bg-[#A88A45]/[0.10]",
    label: "text-[#765811] dark:text-[#E3C27A] [.maple-night_&]:text-[#CFAE62]",
    icon: "lightbulb",
  },
};

/** overDailyMax's own label: its card calls Poison Help, not her OB. */
const POISON_LABEL = overDailyMax("", "", "").label;
const POISON_HELP = MOM_HELP.medicine.find((l) => l.name === "Poison Help");

const phone = (v: unknown) => (typeof v === "string" && v.replace(/\D/g, "").length >= 3 ? v.trim() : null);

/**
 * Calm card for guidance from guidelines.ts: who to call, plainly, with
 * tap-to-call for urgent tiers. `audience="mom"` is for her own cards: the
 * label says her OB (a.label ?? MOM_TIER_LABEL) and the buttons are her OB
 * and after-hours line from her care settings, never Maple's pediatrician.
 */
export function AssessmentCard({
  a,
  className,
  audience = "baby",
  calls = true,
  more,
}: {
  a: Assessment;
  className?: string;
  audience?: "baby" | "mom";
  /** False where the sheet around it already has the call buttons. */
  calls?: boolean;
  /** Lines the card's own words name, after the OB's (the maternal hotline on her check-in cards). */
  more?: { label: string; href: string; icon?: IconName }[];
}) {
  const { state } = useMaple();
  const mom = audience === "mom";
  const settings = state?.baby.settings ?? {};
  // Her numbers are in her care settings, which only readers of her area get.
  const team = state?.care?.settings.care_team;
  const ob = mom ? phone(team?.ob) : null;
  const ped = mom ? null : phone(settings.pediatrician_phone);
  const after = mom ? phone(team?.after_hours) : phone(settings.after_hours_phone);
  const poison = mom && a.label === POISON_LABEL ? POISON_HELP : undefined;
  const urgent = a.tier === "emergency" || a.tier === "now" || a.tier === "today";
  const solid = a.tier === "emergency";
  const style = TIER_STYLE[a.tier];
  const link = cx(
    "inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-3.5 text-sm font-semibold transition active:scale-[0.97]",
    solid ? "bg-white text-[#8E1B12] [.maple-night_&]:bg-white/90" : "bg-mp-accent text-mp-on-accent"
  );
  const call = (n: string) => `tel:${n.replace(/[^\d+]/g, "")}`;
  return (
    <div role="status" className={cx("rounded-xl border-l-[3px] px-4 py-3", style.card, className)}>
      <p className={cx("flex items-center gap-1.5 text-[13px] font-semibold", style.label)}>
        <Icon name={style.icon} size={15} strokeWidth={2} className="shrink-0" />
        {a.label ?? (mom ? MOM_TIER_LABEL : TIER_LABEL)[a.tier]}
      </p>
      <p className={cx("mt-1 text-[15px] leading-snug font-semibold", solid ? "text-white" : "text-mp-ink")}>{a.title}</p>
      <p className={cx("mt-1 text-sm leading-relaxed", solid ? "text-white/90" : "text-mp-ink")}>{a.body}</p>
      {urgent && calls && (
        <div className="mt-3 flex flex-wrap gap-2">
          {a.tier === "emergency" && (
            <a href="tel:911" className={link}>
              <Icon name="phone" size={16} />
              Call 911
            </a>
          )}
          {poison?.tel && (
            <a href={`tel:${poison.tel}`} className={link}>
              <Icon name="phone" size={16} />
              Call Poison Help
            </a>
          )}
          {ob && (
            <a href={call(ob)} className={link}>
              <Icon name="phone" size={16} />
              OB or midwife
            </a>
          )}
          {ped && (
            <a href={call(ped)} className={link}>
              <Icon name="phone" size={16} />
              Pediatrician
            </a>
          )}
          {after && (
            <a href={call(after)} className={link}>
              <Icon name="phone" size={16} />
              After-hours line
            </a>
          )}
          {more?.map((m) => (
            <a key={m.href} href={m.href} className={link}>
              <Icon name={m.icon ?? "phone"} size={16} />
              {m.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

const RUNNING_LABEL: Partial<Record<EntryKind, string>> = {
  feed: "This feed is still going",
  sleep: "She's still asleep",
  tummy: "Tummy time is still going",
  pump: "Still pumping",
};

/** Where the running timer's buttons are (the dock has the feed and sleep ones). */
const RUNNING_WHERE: Partial<Record<EntryKind, string>> = {
  feed: "Switch, pause and Done are in the dock on Today.",
  sleep: "Woke up is in the dock on Today.",
  tummy: "Done is on its card on Today.",
  pump: "Done is on its card on Today.",
};

/**
 * Editing a running timer (opened from Recent): the dock runs it and Fix
 * times fixes its times; only the note is editable here. The timer is the
 * running one of this kind (only one of each runs).
 */
export function RunningNote({ kind, entry }: { kind: EntryKind; entry?: Entry }) {
  const { state, readOnly } = useMaple();
  const { open } = useSheets();
  const running = entry?.active ? entry : state?.entries.find((e) => e.active && e.kind === kind);
  return (
    <div className={cx(tone.inset, "px-4 py-3")}>
      <div className="flex gap-3">
        <Icon name="timer" size={20} className="mt-0.5 shrink-0 text-mp-ink-2" />
        <p className={cx(tone.body, "text-sm leading-relaxed")}>
          <span className="font-semibold">{RUNNING_LABEL[kind] ?? "This timer is running"}.</span> {RUNNING_WHERE[kind] ?? "It's on Today."} You can add
          a note here.
        </p>
      </div>
      {!readOnly && running && running.id > 0 && (
        <Button variant="soft" onClick={() => open({ kind: running.kind, entry: running, preset: fixPreset("current") })} className="mt-3 w-full">
          <Icon name="pencil" size={16} />
          Fix times
        </Button>
      )}
    </div>
  );
}

/**
 * A compact stepper that fits two side by side (lb + oz, Left + Right).
 * Holding − or + keeps stepping. Empty input = null; unreadable text = null
 * plus "Check this number" (never the last good value).
 */
export function MiniStepper({
  label,
  value,
  onChange,
  step = 1,
  min = 0,
  max = 9999,
  decimals = 0,
  unit,
  ariaLabel,
  onInvalid,
}: {
  label: ReactNode;
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
  min?: number;
  max?: number;
  decimals?: number;
  /** Small unit after the number ("min", "oz"). */
  unit?: string;
  ariaLabel: string;
  /** Called with true while the text isn't a usable number (so the sheet can hold Save). */
  onInvalid?: (invalid: boolean) => void;
}) {
  const { text, setText, invalid } = useTypedNumber(value, max, onInvalid);
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);
  const round = (n: number) => Math.round(n * 10 ** decimals) / 10 ** decimals;
  const bump = (d: number) => {
    const next = Math.min(max, Math.max(min, round((latest.current ?? 0) + d)));
    latest.current = next;
    onChange(next);
  };
  // The same round wells as ui.tsx's Stepper, a size down so two fit abreast.
  const btn = "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-mp-sunken text-mp-ink";
  return (
    <div className="min-w-0">
      <span className={cx(tone.label, "mb-1.5 block")}>{label}</span>
      <div className="flex items-center gap-1">
        <RepeatButton ariaLabel={`Less ${ariaLabel}`} onStep={() => bump(-step)} disabled={(value ?? 0) <= min} className={btn}>
          <Icon name="minus" size={20} />
        </RepeatButton>
        <span className="relative min-w-0 flex-1">
          <input
            inputMode="decimal"
            aria-label={ariaLabel}
            aria-invalid={invalid || undefined}
            value={text}
            onChange={(e) => {
              const t = e.target.value.replace(/[^\d.]/g, "");
              setText(t);
              onChange(parseTypedNumber(t, max).value);
            }}
            className={cx(
              "w-full rounded-xl border bg-mp-surface py-3 text-center text-lg font-semibold text-mp-ink tabular-nums outline-none transition focus:ring-2",
              invalid ? "border-mp-danger ring-2 ring-mp-danger/25 focus:ring-mp-danger/25" : "border-mp-line focus:border-mp-focus focus:ring-mp-focus/25",
              // Two abreast leave ~70px for the number, so "0.25" plus "oz" must fit.
              unit ? "pr-6 pl-1" : "px-1"
            )}
          />
          {unit && <span className={cx(tone.muted, "pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs")}>{unit}</span>}
        </span>
        <RepeatButton ariaLabel={`More ${ariaLabel}`} onStep={() => bump(step)} disabled={(value ?? 0) >= max} className={btn}>
          <Icon name="plus" size={20} />
        </RepeatButton>
      </div>
      <NumberProblem show={invalid} />
    </div>
  );
}

/**
 * Number fields holding a typo hold Save until they're fixed:
 *   const checks = useNumberChecks();  <MiniStepper onInvalid={checks.watch("left")} … />
 */
export function useNumberChecks() {
  const [bad, setBad] = useState<Record<string, boolean>>({});
  const watch = useCallback(
    (key: string) => (invalid: boolean) => setBad((b) => (!!b[key] === invalid ? b : { ...b, [key]: invalid })),
    []
  );
  return { invalid: Object.values(bad).some(Boolean), watch };
}

export const CHECK_NUMBER_HINT = "Check the number marked in red.";

/**
 * Which fields the person actually changed. Edits send only those, so opening
 * an entry and fixing the note never re-rounds a volume or a weight through
 * the display units (100 ml must stay 100 ml, not 3.5 oz → 103.5 ml).
 */
export function useTouched() {
  const [touched, setTouched] = useState<Record<string, true>>({});
  const touch = useCallback((key: string) => setTouched((t) => (t[key] ? t : { ...t, [key]: true })), []);
  return { touched, touch };
}

/** Fields that were cleared in an edit go to the server as null (PATCH merges data). */
export function withNulls<T extends Record<string, unknown>>(next: T, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...next };
  for (const k of keys) if (out[k] === undefined) out[k] = null;
  return out;
}

/** Drop undefined keys (for creates). */
export function compact<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}
