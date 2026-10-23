"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { TIER_LABEL, type AlertTier, type Assessment } from "@/lib/maple/guidelines";
import { babyAge, DEFAULT_TZ, dayKey, formatDayLabel, formatTime } from "@/lib/maple/time";
import type { Entry, EntryKind, Source } from "@/lib/maple/types";
import { Icon, type IconName } from "../icons";
import { Button, NumberProblem, RepeatButton, TextArea, cx, parseTypedNumber, tone, useTypedNumber } from "../ui";
import { useMaple } from "../useMaple";

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

/** "Logged by Matt 🌲 via Claude · 3:12 AM · edited by Brittany", under the sheet title. */
export function LoggedBy({ entry }: { entry: Entry }) {
  const { member, memberName, now, tz } = useSheetBase();
  const who = member(entry.created_by);
  const name = who?.display_name ?? memberName(entry.created_by);
  const via = VIA[entry.source];
  const created = new Date(entry.created_at);
  const day = formatDayLabel(dayKey(created, tz), dayKey(now(), tz));
  const when = `${day === "Today" ? "" : `${day} `}${formatTime(created, tz)}`;
  const editor = entry.updated_by
    ? entry.updated_by === entry.created_by
      ? "edited"
      : `edited by ${memberName(entry.updated_by)}`
    : null;
  return (
    <p className={cx(tone.muted, "text-[13px] leading-snug")}>
      Logged by {name}
      {who?.emoji ? ` ${who.emoji}` : ""}
      {via ? ` via ${via}` : ""} · {when}
      {editor ? ` · ${editor}` : ""}
      {entry.id < 0 && " · waiting to sync"}
    </p>
  );
}

/**
 * The sticky footer: [Delete] (danger ghost, editing only) on the left and
 * the primary action on the right. Viewers just get Close.
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
        <p className={cx(tone.muted, "flex-1 text-sm")}>View only. Ask Matt or Brittany to change this.</p>
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
            className="min-h-[56px] rounded-full px-4 text-base font-semibold text-[#9A3A24] transition hover:bg-[#B5452B]/10 active:scale-[0.97] dark:text-[#F4A68F] dark:hover:bg-[#E07A5F]/15"
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

/** Closed by default: the fields most people skip at 3am. */
export function MoreDetails({ summary, children, label = "More details" }: { summary?: string; children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();
  return (
    <div className={cx(tone.inset, "border border-[#1D4420]/[0.08] dark:border-[#F5EDDF]/[0.08]")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-[48px] w-full items-center justify-between gap-3 px-4 text-left"
      >
        <span className="min-w-0">
          <span className={cx(tone.body, "text-[15px] font-semibold")}>{label}</span>
          {summary && <span className={cx(tone.muted, "ml-2 truncate text-sm")}>· {summary}</span>}
        </span>
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
            <div className="space-y-4 px-4 pt-1 pb-4">{children}</div>
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
  /** @deprecated Ignored: pass an icon. */
  emoji?: string;
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
      {optional && <span className="ml-1 font-medium tracking-normal normal-case opacity-70">(optional)</span>}
    </span>
  );
}

const TIER_STYLE: Record<AlertTier, string> = {
  emergency: "bg-[#8E1B12] text-white border-[#8E1B12]",
  now: "bg-[#B5452B]/[0.09] border-[#B5452B] text-[#5E1F12] dark:bg-[#B5452B]/20 dark:text-[#F7D3C6]",
  today: "bg-[#D9772B]/[0.10] border-[#D9772B] text-[#5A3210] dark:bg-[#D9772B]/15 dark:text-[#F6DDBF]",
  mention: "bg-[#5C7A4A]/10 border-[#5C7A4A] text-[#22381A] dark:bg-[#5C7A4A]/20 dark:text-[#D7E4C8]",
  nudge: "bg-[#C49A3C]/12 border-[#C49A3C] text-[#4A3A12] dark:bg-[#C49A3C]/15 dark:text-[#EFE0B8]",
};

/** Calm card for guidance from guidelines.ts: who to call, plainly, with tap-to-call for urgent tiers. */
export function AssessmentCard({ a, className }: { a: Assessment; className?: string }) {
  const { state } = useMaple();
  const settings = state?.baby.settings ?? {};
  const ped = typeof settings.pediatrician_phone === "string" ? settings.pediatrician_phone : null;
  const after = typeof settings.after_hours_phone === "string" ? settings.after_hours_phone : null;
  const urgent = a.tier === "emergency" || a.tier === "now" || a.tier === "today";
  const solid = a.tier === "emergency";
  const link = cx(
    "inline-flex min-h-[44px] items-center gap-1.5 rounded-full px-4 text-sm font-semibold",
    solid ? "bg-white text-[#8E1B12]" : "bg-[#1D4420] text-[#FDF8F0] dark:bg-[#F5EDDF] dark:text-[#14210F]"
  );
  return (
    <div role="status" className={cx("rounded-2xl border-l-4 px-4 py-3", TIER_STYLE[a.tier], className)}>
      <p className={cx("text-[11px] font-bold tracking-[0.12em] uppercase", solid ? "text-white/85" : "opacity-80")}>{TIER_LABEL[a.tier]}</p>
      <p className="mt-0.5 text-[15px] leading-snug font-semibold">{a.title}</p>
      <p className={cx("mt-1 text-sm leading-relaxed", solid ? "text-white/90" : "opacity-90")}>{a.body}</p>
      {urgent && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {a.tier === "emergency" && (
            <a href="tel:911" className={link}>
              <Icon name="phone" size={16} />
              Call 911
            </a>
          )}
          {ped && (
            <a href={`tel:${ped.replace(/[^\d+]/g, "")}`} className={link}>
              <Icon name="phone" size={16} />
              Pediatrician
            </a>
          )}
          {after && (
            <a href={`tel:${after.replace(/[^\d+]/g, "")}`} className={link}>
              <Icon name="phone" size={16} />
              After-hours line
            </a>
          )}
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

/** Editing a running timer: the timer card controls it; only the note is editable here. */
export function RunningNote({ kind }: { kind: EntryKind }) {
  return (
    <div className={cx(tone.inset, "flex gap-3 px-4 py-3")}>
      <Icon name="timer" size={20} className="mt-0.5 shrink-0 text-mp-ink-2" />
      <p className={cx(tone.body, "text-sm leading-relaxed")}>
        <span className="font-semibold">{RUNNING_LABEL[kind] ?? "This timer is running"}.</span> Use the timer card on Today to switch, pause,
        fix the start or stop it. You can add a note here.
      </p>
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
  const btn =
    "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#1D4420]/[0.07] text-xl font-semibold text-[#1D4420] dark:bg-[#F5EDDF]/10 dark:text-[#F5EDDF]";
  return (
    <div className="min-w-0">
      <span className={cx(tone.label, "mb-1.5 block")}>{label}</span>
      <div className="flex items-center gap-1">
        <RepeatButton ariaLabel={`Less ${ariaLabel}`} onStep={() => bump(-step)} disabled={(value ?? 0) <= min} className={btn}>
          −
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
              "w-full rounded-2xl border bg-white py-2.5 text-center text-xl font-semibold text-[#1D4420] tabular-nums outline-none focus:ring-2 dark:bg-[#0E1E12] dark:text-[#F5EDDF]",
              invalid
                ? "border-[#B5452B] ring-2 ring-[#B5452B]/30 focus:ring-[#B5452B]/30"
                : "border-[#1D4420]/15 focus:border-[#C49A3C] focus:ring-[#C49A3C]/30 dark:border-[#C49A3C]/20",
              unit ? "pr-7 pl-1" : "px-1"
            )}
          />
          {unit && <span className={cx(tone.muted, "pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs")}>{unit}</span>}
        </span>
        <RepeatButton ariaLabel={`More ${ariaLabel}`} onStep={() => bump(step)} disabled={(value ?? 0) >= max} className={btn}>
          +
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
