"use client";

import { AnimatePresence, motion, useDragControls, useReducedMotion } from "framer-motion";
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  addDays,
  dayKey,
  formatDayLabel,
  formatDuration,
  formatRelative,
  formatTime,
  localParts,
  parseDayKey,
  zonedTimeToUtc,
} from "@/lib/maple/time";
import type { Member } from "@/lib/maple/types";
import { Icon, type IconName } from "./icons";
import { useNightActive } from "./nightLook";
import { useMaple, useNow, type Toast } from "./useMaple";

/**
 * Small UI kit for Maple's Log. Big tap targets (≥ 44px), quiet surfaces,
 * color only where it means something. Colors come from the mp-* tokens
 * (src/app/maple/maple.css), which also carry dark mode and the night look,
 * so nothing here needs a dark: variant. Icons come from ./icons, never
 * emoji. Other maple components should build from these so the app feels
 * like one thing.
 */

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** Shared class strings. */
export const tone = {
  /** A white card on the paper background. No outline by day; a hairline in dark and at night, where surface on bg is too close to see (--mp-edge). */
  card: "rounded-[20px] border border-(--mp-edge) bg-mp-surface",
  /** A well inside a card or sheet (time scrubber, disclosure). */
  inset: "rounded-2xl bg-mp-sunken",
  /** Section and sheet titles: the UI sans, semibold. */
  heading: "font-semibold tracking-[-0.01em] text-mp-ink",
  /** Page titles and her name only: the display serif. */
  display: "font-[family-name:var(--font-display)] font-semibold tracking-[-0.01em] text-mp-ink",
  body: "text-mp-ink",
  muted: "text-mp-ink-2",
  faint: "text-mp-ink-3",
  /** Field labels: sentence case, not shouting. */
  label: "text-[13px] font-medium text-mp-ink-2",
  input:
    "w-full rounded-xl border border-mp-line bg-mp-surface px-3.5 py-3 text-base text-mp-ink outline-none transition placeholder:text-mp-ink-3 focus:border-mp-focus focus:ring-2 focus:ring-mp-focus/25",
  /** A tappable row inside a list card. */
  row: "flex w-full items-center gap-3 px-4 text-left transition active:bg-mp-ink/[0.04]",
  /** Hairline dividers between rows (use on the list container). */
  divide: "divide-y divide-mp-line",
};

// ── Buttons ──────────────────────────────────────────────────────────────

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "soft" | "ghost" | "danger" | "gold";
  size?: "sm" | "md" | "lg";
  type?: "button" | "submit";
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-pressed"?: boolean;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
};

export function Button({ children, onClick, variant = "primary", size = "md", type = "button", disabled, className, ...rest }: ButtonProps) {
  const v = {
    primary: "bg-mp-accent text-mp-on-accent hover:opacity-90",
    // "gold" was the celebratory variant; one primary color keeps the app calm.
    gold: "bg-mp-accent text-mp-on-accent hover:opacity-90",
    soft: "bg-mp-sunken text-mp-ink hover:bg-mp-ink/10",
    ghost: "text-mp-accent-fg hover:bg-mp-ink/5",
    danger: "bg-mp-danger/10 text-mp-danger hover:bg-mp-danger/15",
  }[variant];
  const s = {
    sm: "min-h-[44px] rounded-[10px] px-3 text-sm",
    md: "min-h-[44px] rounded-xl px-4 text-[15px]",
    lg: "min-h-[52px] rounded-[14px] px-5 text-base",
  }[size];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={rest["aria-label"]}
      aria-pressed={rest["aria-pressed"]}
      aria-expanded={rest["aria-expanded"]}
      aria-controls={rest["aria-controls"]}
      className={cx(
        "inline-flex items-center justify-center gap-2 font-semibold transition active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100",
        v,
        s,
        className
      )}
    >
      {children}
    </button>
  );
}

export function Chip({
  children,
  selected,
  onClick,
  color,
  raised,
  className,
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  /** Accent hex for the selected state. */
  color?: string;
  /** Sitting on a sunken well (the time scrubber): give it a surface so it still reads as a chip. */
  raised?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={ariaLabel}
      style={selected && color ? { backgroundColor: color, borderColor: color } : undefined}
      className={cx(
        "inline-flex min-h-[40px] items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition active:scale-[0.97]",
        selected
          ? color
            ? "mp-kind-fill text-white"
            : "border-mp-accent bg-mp-accent text-mp-on-accent"
          : raised
            ? "border-mp-line bg-mp-raised text-mp-ink hover:bg-mp-ink/5"
            : "border-transparent bg-mp-sunken text-mp-ink hover:bg-mp-ink/10",
        className
      )}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  "aria-label": ariaLabel,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div className={cx("flex rounded-xl bg-mp-sunken p-[2px]", className)} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "min-h-[40px] flex-1 rounded-[10px] px-3 text-sm transition",
            value === o.value
              ? "bg-mp-raised font-semibold text-mp-ink shadow-[0_1px_3px_rgba(0,0,0,0.12)]"
              : "font-medium text-mp-ink-2"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Fields ───────────────────────────────────────────────────────────────

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className={cx(tone.label, "mb-1.5 block")}>{label}</span>
      {children}
      {hint && <span className={cx(tone.muted, "mt-1 block text-xs")}>{hint}</span>}
    </label>
  );
}

/**
 * What typed text means: empty, a number, or something to fix. "100..4" or a
 * number past the field's max is invalid, never quietly the last good value
 * (a fever typed with a double dot must not save as 100.0°F).
 */
export function parseTypedNumber(text: string, max: number): { value: number | null; invalid: boolean } {
  if (text === "") return { value: null, invalid: false };
  const n = Number(text);
  if (!Number.isFinite(n) || n > max) return { value: null, invalid: true };
  return { value: n, invalid: false };
}

/**
 * Typed text for a number field that follows the value from outside, except
 * that a typo stays on screen (with the value null) until it's fixed. Reports
 * invalid ↔ valid to `onInvalid`, and clears the flag when the field goes away.
 * Fields that swap places (Bottle ↔ Breast) need distinct keys so one field's
 * typo and flag never carry over to another.
 */
export function useTypedNumber(value: number | null, max: number, onInvalid?: (invalid: boolean) => void) {
  const [text, setText] = useState(value == null ? "" : String(value));
  useEffect(() => {
    setText((t) => {
      if (t !== "" && Number(t) === value) return t; // same number ("2." mid-typing)
      if (value == null && parseTypedNumber(t, max).invalid) return t; // keep the typo visible
      return value == null ? "" : String(value);
    });
  }, [value, max]);
  const invalid = parseTypedNumber(text, max).invalid;
  const report = useRef(onInvalid);
  useEffect(() => {
    report.current = onInvalid;
  });
  useEffect(() => {
    report.current?.(invalid);
    return () => report.current?.(false);
  }, [invalid]);
  return { text, setText, invalid };
}

/** "Check this number" under a field holding a typo. */
export function NumberProblem({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span role="alert" className="mt-1 block text-xs font-semibold text-mp-danger">
      Check this number
    </span>
  );
}

const STEP_BTN = "flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-mp-sunken text-mp-ink active:scale-95";

/** Number input with − / + buttons. Empty string = no value; unreadable text = no value plus "Check this number". */
export function Stepper({
  value,
  onChange,
  step = 1,
  min = 0,
  max = 9999,
  suffix,
  decimals = 0,
  ariaLabel,
  onInvalid,
  start,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  decimals?: number;
  ariaLabel: string;
  /** Called with true while the text isn't a usable number (so a form can hold Save). */
  onInvalid?: (invalid: boolean) => void;
  /** An empty field's first − or + lands here, not at `min` (a field that starts blank rather than at a made-up reading). */
  start?: number;
}) {
  const { text, setText, invalid } = useTypedNumber(value, max, onInvalid);
  const bump = (d: number) => {
    if (value == null && start != null) return onChange(start);
    const next = Math.min(max, Math.max(min, Math.round(((value ?? 0) + d) * 10 ** decimals) / 10 ** decimals));
    onChange(next);
  };
  return (
    <div>
      <div className="flex items-center gap-2">
        <button type="button" aria-label={`Less ${ariaLabel}`} onClick={() => bump(-step)} className={STEP_BTN}>
          <Icon name="minus" size={22} />
        </button>
        <div className="relative flex-1">
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
            className={cx(tone.input, "text-center text-xl font-semibold tabular-nums", suffix && "pr-12", invalid && "border-mp-danger! ring-2! ring-mp-danger/25!")}
          />
          {suffix && <span className={cx(tone.muted, "pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-sm")}>{suffix}</span>}
        </div>
        <button type="button" aria-label={`More ${ariaLabel}`} onClick={() => bump(step)} className={STEP_BTN}>
          <Icon name="plus" size={22} />
        </button>
      </div>
      <NumberProblem show={invalid} />
    </div>
  );
}

/** "When did it happen?" — Now by default, quick offsets, or an exact time. */
export function WhenField({
  label = "When",
  value,
  onChange,
  tz,
  offsets = [5, 15, 30, 60, 120],
}: {
  label?: string;
  /** null = now */
  value: Date | null;
  onChange: (d: Date | null) => void;
  tz: string;
  offsets?: number[];
}) {
  const { now } = useMaple();
  // Opening at one of the quick offsets (holding a dock button presets 15m ago) lights that chip;
  // any other time already set (editing an entry) goes straight to the scrubber.
  const offsetOf = () => (value == null ? null : (offsets.find((m) => Math.abs(now().getTime() - m * 60000 - value.getTime()) < 30_000) ?? null));
  const [custom, setCustom] = useState(() => value != null && offsetOf() == null);
  // Which quick chip was tapped, so it stays lit as the clock moves on.
  const [chip, setChip] = useState<number | null>(offsetOf);
  const n = now();

  return (
    <div>
      <span className={cx(tone.label, "mb-1.5 block")}>{label}</span>
      <div className="flex flex-wrap gap-2">
        <Chip selected={!value && !custom} onClick={() => { setCustom(false); setChip(null); onChange(null); }}>
          Now
        </Chip>
        {offsets.map((m) => (
          <Chip
            key={m}
            selected={!custom && !!value && chip === m}
            onClick={() => {
              setCustom(false);
              setChip(m);
              onChange(new Date(n.getTime() - m * 60000));
            }}
          >
            {m < 60 ? `${m}m ago` : `${m / 60}h ago`}
          </Chip>
        ))}
        <Chip selected={custom} onClick={() => { setCustom(true); setChip(null); }}>
          <Icon name="clock-3" size={16} />
          Pick a time
        </Chip>
      </div>
      {custom && <TimeScrubber value={value ?? n} onChange={onChange} tz={tz} quick={false} label={`${label}: exact time`} hideLabel className="mt-2" />}
      {value && !custom && (
        <p className={cx(tone.muted, "mt-1.5 text-xs")}>
          {formatDayLabel(dayKey(value, tz), dayKey(n, tz))} at {formatTime(value, tz)}
        </p>
      )}
    </div>
  );
}

// ── Time scrubber ────────────────────────────────────────────────────────

const MIN_MS = 60_000;
const pad2 = (x: number) => String(x).padStart(2, "0");

/**
 * A wall-clock time on a local day, as an instant. The night clocks fall
 * back, 1:00–1:59 AM happens twice: prefer the second pass when the first
 * would be more than 2 hours ago (at 3:10 AM, "1:30" means 1h 40m ago, not
 * 2h 40m). Elsewhere it's plain zonedTimeToUtc.
 */
export function resolveWallTime(key: string, hour: number, minute: number, tz: string, now: Date): Date {
  const { year, month, day } = parseDayKey(key);
  const first = zonedTimeToUtc(year, month, day, hour, minute, tz);
  const second = new Date(first.getTime() + 60 * MIN_MS);
  const p = localParts(second, tz);
  const repeats = p.hour === hour && p.minute === minute && dayKey(second, tz) === key;
  if (repeats && now.getTime() - first.getTime() > 120 * MIN_MS && second.getTime() <= now.getTime() + MIN_MS) return second;
  return first;
}

/** Which pass through a repeated (clocks fell back) hour this instant is, if any. */
function repeatedPass(d: Date, tz: string): "first" | "second" | null {
  const p = localParts(d, tz);
  const later = localParts(d.getTime() + 60 * MIN_MS, tz);
  if (later.hour === p.hour && later.minute === p.minute) return "first";
  const earlier = localParts(d.getTime() - 60 * MIN_MS, tz);
  if (earlier.hour === p.hour && earlier.minute === p.minute) return "second";
  return null;
}

/**
 * A button that fires once on press and keeps firing while held (after
 * 400ms, every 110ms), for nudging a time or a number one-handed.
 */
export function RepeatButton({
  onStep,
  children,
  ariaLabel,
  disabled,
  className,
}: {
  onStep: () => void;
  children: ReactNode;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const step = useRef(onStep);
  const timers = useRef<{ wait?: number; tick?: number }>({});
  useEffect(() => {
    step.current = onStep;
  });
  const stop = useCallback(() => {
    window.clearTimeout(timers.current.wait);
    window.clearInterval(timers.current.tick);
    timers.current = {};
  }, []);
  useEffect(() => stop, [stop]);
  useEffect(() => {
    if (disabled) stop();
  }, [disabled, stop]);

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onPointerDown={(e) => {
        if (e.button !== 0 || disabled) return;
        stop();
        step.current();
        timers.current.wait = window.setTimeout(() => {
          timers.current.tick = window.setInterval(() => step.current(), 110);
        }, 400);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      // Keyboard (Enter/Space) clicks have detail 0; pointer presses already stepped.
      onClick={(e) => {
        if (e.detail === 0) step.current();
      }}
      onContextMenu={(e) => e.preventDefault()}
      className={cx(
        "touch-manipulation select-none [-webkit-touch-callout:none] transition active:scale-[0.96] disabled:opacity-35 disabled:active:scale-100",
        className
      )}
    >
      {children}
    </button>
  );
}

/**
 * Pick a time with one thumb: the time big, −5/−1/+1/+5 (hold to keep
 * going), "minutes ago" chips, a Yesterday/Today toggle around midnight, and
 * an "Exact time…" escape hatch (a native time-only picker). Never later than
 * now + 1 minute. nudgeStyle "words" spells the nudges out ("5 min" over
 * "earlier"), for Fix times, where a bare − or + reads as arithmetic.
 */
export function TimeScrubber({
  value,
  onChange,
  tz,
  label,
  hideLabel,
  quick = [0, 5, 15, 30, 60, 120],
  min,
  max,
  className,
  nudgeStyle = "signed",
}: {
  value: Date;
  onChange: (d: Date) => void;
  tz: string;
  /** Shown above the time ("Fell asleep"), and the group's accessible name. */
  label?: string;
  hideLabel?: boolean;
  /** "Minutes ago" chips (0 = Now); false hides them. */
  quick?: number[] | false;
  /** Earliest allowed (e.g. a range's start). */
  min?: Date;
  /** Latest allowed; never later than now + 1 minute anyway. */
  max?: Date;
  className?: string;
  /** "signed": −5 −1 +1 +5. "words": "5 min / earlier" … "5 min / later". */
  nudgeStyle?: "signed" | "words";
}) {
  const { now: nowFn } = useMaple();
  const now = useNow(30_000);
  // The chip tapped and the instant it produced: it stays lit until the time changes, not until the clock ticks.
  const [chip, setChip] = useState<{ m: number; at: number } | null>(null);
  const [exact, setExact] = useState(false);
  const latest = useRef(value.getTime());
  useEffect(() => {
    latest.current = value.getTime();
  }, [value]);

  const ceiling = () => Math.min(nowFn().getTime() + MIN_MS, max?.getTime() ?? Infinity);
  const set = (t: number) => {
    const next = Math.max(min?.getTime() ?? -Infinity, Math.min(ceiling(), t));
    latest.current = next;
    onChange(new Date(next));
    return next;
  };
  const step = (mins: number) => {
    setChip(null);
    // Step from the minute that's shown (seconds are hidden), so "1 min earlier" always changes it.
    set(Math.floor(latest.current / MIN_MS) * MIN_MS + mins * MIN_MS);
  };

  const t = value.getTime();
  const todayKey = dayKey(now, tz);
  const key = dayKey(value, tz);
  const yesterdayKey = addDays(todayKey, -1);
  const p = localParts(value, tz);
  // Around midnight "11:50" could mean either day, so offer the toggle (and whenever it's not today).
  const showDays = localParts(now, tz).hour < 3 || key !== todayKey;
  const days = [...(key < yesterdayKey ? [key] : []), yesterdayKey, todayKey];
  const pass = repeatedPass(value, tz);
  // "Later" stops at now (the extra minute in the clamp only absorbs rounding and clock skew).
  const atMax = t >= Math.min(nowFn().getTime() - 30_000, (max?.getTime() ?? Infinity) - 1000);
  const atMin = min ? t <= min.getTime() + 1000 : false;

  const showLabel = !!label && !hideLabel;
  const exactButton = (
    <button
      type="button"
      onClick={() => setExact((x) => !x)}
      aria-expanded={exact}
      className="-my-2 min-h-[44px] px-1 text-[13px] font-semibold text-mp-accent-fg"
    >
      Exact time…
    </button>
  );

  const pickDay = (k: string) => {
    setChip(null);
    const n = nowFn();
    set(Math.min(resolveWallTime(k, p.hour, p.minute, tz, n).getTime(), n.getTime()));
  };

  return (
    <div role="group" aria-label={label ?? "Time"} className={cx(tone.inset, "p-3", className)}>
      {showLabel && (
        <div className="-mt-1 flex items-center justify-between gap-3">
          <span className={tone.label}>{label}</span>
          {exactButton}
        </div>
      )}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="text-[28px] leading-tight font-semibold tracking-[-0.02em] text-mp-ink tabular-nums">{formatTime(value, tz)}</span>
        <span className={cx(tone.muted, "text-sm")}>
          {formatDayLabel(key, todayKey)} · {formatRelative(value, now)}
        </span>
        {/* Without a label row, "Exact time…" sits beside the time instead of alone on a line. */}
        {!showLabel && <span className="ml-auto self-center">{exactButton}</span>}
      </div>
      {pass && (
        <p className={cx(tone.muted, "text-xs")}>
          Clocks fell back: this is the {pass} {formatTime(value, tz)}.
        </p>
      )}

      <div className="mt-2 grid grid-cols-4 gap-2">
        {[-5, -1, 1, 5].map((d) => (
          <RepeatButton
            key={d}
            onStep={() => step(d)}
            disabled={d < 0 ? atMin : atMax}
            ariaLabel={`${Math.abs(d)} minute${Math.abs(d) === 1 ? "" : "s"} ${d < 0 ? "earlier" : "later"}`}
            className={cx(
              "h-[52px] rounded-xl border border-mp-line bg-mp-raised font-semibold text-mp-ink tabular-nums",
              nudgeStyle === "words" ? "flex flex-col items-center justify-center leading-tight" : "text-lg"
            )}
          >
            {nudgeStyle === "words" ? (
              <>
                <span className="text-[15px]">{Math.abs(d)} min</span>
                <span className="text-[12px] font-medium text-mp-ink-2">{d < 0 ? "earlier" : "later"}</span>
              </>
            ) : (
              <>
                {d < 0 ? "−" : "+"}
                {Math.abs(d)}
              </>
            )}
          </RepeatButton>
        ))}
      </div>

      {quick && quick.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {quick.map((m, i) => (
            <Chip
              key={m}
              raised
              selected={chip?.m === m && chip.at === t}
              onClick={() => setChip({ m, at: set(nowFn().getTime() - m * MIN_MS) })}
            >
              {m === 0 ? "Now" : `${m < 60 ? `${m}m` : `${m / 60}h`}${i === quick.length - 1 ? " ago" : ""}`}
            </Chip>
          ))}
        </div>
      )}

      {showDays && (
        <Segmented
          className="mt-2"
          value={key}
          onChange={pickDay}
          options={days.map((k) => ({ value: k, label: formatDayLabel(k, todayKey) }))}
        />
      )}
      {exact && (
        <input
          type="time"
          aria-label={`${label ?? "Time"}: exact clock time`}
          value={`${pad2(p.hour)}:${pad2(p.minute)}`}
          onChange={(e) => {
            const m = /^(\d{2}):(\d{2})/.exec(e.target.value);
            if (!m) return;
            const n = nowFn();
            let at = resolveWallTime(key, +m[1], +m[2], tz, n);
            // "11:30" typed at 1 AM means last night, not later today.
            if (at.getTime() > n.getTime() + MIN_MS && key === dayKey(n, tz)) {
              at = resolveWallTime(addDays(key, -1), +m[1], +m[2], tz, n);
            }
            setChip(null);
            set(at.getTime());
          }}
          className={cx(tone.input, "mt-2")}
        />
      )}
    </div>
  );
}

/**
 * Start and end for timed things (sleep, a feed logged afterwards, tummy
 * time, pumping): two scrubbers, the live duration between them, and
 * duration chips that set start = end − duration. Moving the start keeps the
 * end where it is.
 */
export function TimeRange({
  start,
  end,
  onChange,
  tz,
  labels = ["Started", "Ended"],
  durations = [15, 30, 45, 60, 90, 120, 180],
}: {
  start: Date;
  end: Date;
  onChange: (start: Date, end: Date) => void;
  tz: string;
  labels?: [string, string];
  /** Minutes; [] hides the chips. */
  durations?: number[];
}) {
  const ms = Math.max(0, end.getTime() - start.getTime());
  const fmt = (m: number) => (m < 60 ? `${m}m` : `${Math.round((m / 60) * 10) / 10}h`);
  return (
    <div className="space-y-2">
      <TimeScrubber label={labels[0]} value={start} max={end} quick={false} tz={tz} onChange={(s) => onChange(s, end)} />
      <div className="px-1" role="group" aria-label="Duration">
        <p className={cx(tone.body, "flex items-baseline gap-2 text-sm")}>
          <Icon name="arrow-right" size={14} className="rotate-90 self-center text-mp-ink-3" />
          <span className={tone.muted}>Duration</span>
          <span className="text-base font-semibold tabular-nums">{ms < MIN_MS ? "0m" : formatDuration(ms / 1000)}</span>
        </p>
        {durations.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {durations.map((m) => (
              <Chip key={m} selected={Math.abs(ms - m * MIN_MS) < 30_000} onClick={() => onChange(new Date(end.getTime() - m * MIN_MS), end)}>
                {fmt(m)}
              </Chip>
            ))}
          </div>
        )}
      </div>
      <TimeScrubber
        label={labels[1]}
        value={end}
        tz={tz}
        onChange={(e) => onChange(e.getTime() < start.getTime() ? e : start, e)}
      />
    </div>
  );
}

export function TextArea({ value, onChange, placeholder, rows = 2 }: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  return (
    <textarea
      value={value}
      rows={rows}
      maxLength={2000}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={cx(tone.input, "resize-none")}
    />
  );
}

// ── Sheet (bottom drawer) ────────────────────────────────────────────────

/**
 * Make everything outside `el` inert (the app, the dock, the tab bar), so
 * Tab and Switch Control stay in an open sheet and can't reach Done in the
 * dock behind it. The toast host stays live (a toast leaving as the sheet
 * opens must not let a tap fall through it); while a sheet is open, toasts
 * draw inside it (sheetSlots). Returns the undo, which clears only what this
 * call set.
 */
function inertOutside(el: HTMLElement): () => void {
  const set: HTMLElement[] = [];
  const shut = (n: Element) => {
    if (!(n instanceof HTMLElement) || n.inert || n.matches("script, style, link, template, [data-maple-toasts]")) return;
    if (n.querySelector("[data-maple-toasts]")) {
      for (const c of Array.from(n.children)) shut(c);
      return;
    }
    n.inert = true;
    set.push(n);
  };
  let node: HTMLElement = el;
  while (node.parentElement && node !== document.body) {
    for (const sib of Array.from(node.parentElement.children)) if (sib !== node) shut(sib);
    node = node.parentElement;
  }
  return () => {
    for (const n of set) n.inert = false;
  };
}

/**
 * The open sheets' toast slots, newest last. While a sheet is open ToastHost
 * draws toasts in the top one, between its body and its footer, so a toast
 * takes room instead of sitting over the sheet's times or its Save (timer
 * toasts wait meanwhile, see SheetProvider; an error still shows).
 */
const sheetSlots: HTMLElement[] = [];
const slotSubs = new Set<() => void>();
const subscribeSlots = (cb: () => void) => {
  slotSubs.add(cb);
  return () => {
    slotSubs.delete(cb);
  };
};
const topSlot = () => sheetSlots[sheetSlots.length - 1] ?? null;
const noSlot = () => null;
function setSlot(el: HTMLElement, on: boolean) {
  const i = sheetSlots.indexOf(el);
  if (on === i >= 0) return;
  if (on) sheetSlots.push(el);
  else sheetSlots.splice(i, 1);
  for (const cb of slotSubs) cb();
}

/** The open sheets, newest last: Escape closes only the top one (and nothing while that one is locked). */
const openSheets: object[] = [];

/** How long a locked sheet ignores taps after it opens: a double tap on whatever opened it must not start a call. */
const LOCK_HOLD_MS = 700;
const SheetArmed = createContext(true);

/** False for a locked sheet's first moments, while its buttons ignore taps (they show it as aria-disabled). */
export function useSheetArmed(): boolean {
  return useContext(SheetArmed);
}

export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  calm,
  locked,
  actions,
  display,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** One quiet line under the title ("Nursing · feed started 4:00 PM"). */
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * Fix times: it stops at 90% of the screen, and focus goes to the title,
   * then back to whatever opened it. (Every sheet fades in without a slide
   * at night and under Reduce Motion.)
   */
  calm?: boolean;
  /**
   * The crisis sheet: no backdrop close, no drag-to-dismiss, no Escape and no
   * X, so the only ways out are its own `actions`. For its first 700 ms every
   * tap inside is ignored (useSheetArmed tells its buttons to say so).
   */
  locked?: boolean;
  /** Small text buttons in the header row, at the top; a locked sheet's only way out ("Close"). */
  actions?: ReactNode;
  /** The title in the display serif, larger: her screen's name, the one place it's used (§11.5). */
  display?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const drag = useDragControls();
  const night = useNightActive();
  const reduce = useReducedMotion();
  // A locked sheet holds its taps for a moment each time it opens (React's "adjust state while rendering" pattern).
  const [armed, setArmed] = useState(!locked);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open && locked && armed) setArmed(false);
  }
  useEffect(() => {
    if (!open || armed) return;
    const t = window.setTimeout(() => setArmed(true), LOCK_HOLD_MS);
    return () => window.clearTimeout(t);
  }, [open, armed]);
  const lockedRef = useRef(locked);
  useEffect(() => {
    lockedRef.current = locked;
  });
  // No slide at 3am or with Reduce Motion: it fades in where it will sit.
  const still = night || !!reduce;
  // aria-modal alone doesn't keep focus in: the background goes inert while it's open.
  // The opener is noted first (going inert takes its focus) and refocused once it's live again.
  useEffect(() => {
    if (!open || !rootRef.current) return;
    const opener = document.activeElement as HTMLElement | null;
    const undo = inertOutside(rootRef.current);
    return () => {
      undo();
      if (calm && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open, calm]);
  // Toasts come in here while it's open (and go back above the dock as it starts to close).
  useEffect(() => {
    const el = slotRef.current;
    if (!open || !el) return;
    setSlot(el, true);
    return () => setSlot(el, false);
  }, [open]);
  // A toast in the slot takes the body's room. What you were on stays in view: the field you're typing in, or the
  // bottom of the form if you'd scrolled down to it (never a jump from the top, where the sheet's main choice is).
  useEffect(() => {
    const slot = slotRef.current;
    const body = bodyRef.current;
    if (!open || !slot || !body) return;
    let h = slot.offsetHeight;
    const nearBottom = () => body.scrollTop > 0 && body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    let atBottom = nearBottom();
    const onScroll = () => (atBottom = nearBottom());
    const ro = new ResizeObserver(() => {
      const grew = slot.offsetHeight - h;
      h = slot.offsetHeight;
      if (grew <= 0) return;
      if (atBottom) body.scrollTop += grew;
      const a = document.activeElement;
      if (a instanceof HTMLElement && a !== body && body.contains(a)) a.scrollIntoView({ block: "nearest" });
    });
    body.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(slot);
    return () => {
      body.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [open]);
  // The latest onClose without re-running the effect: a parent ticking every second (the dock) would otherwise pull focus back to the top each time.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    // Only the top sheet answers Escape, so a sheet opened from another closes alone and a locked one stays put.
    const me = {};
    openSheets.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || openSheets[openSheets.length - 1] !== me || lockedRef.current) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    (calm ? titleRef.current : panelRef.current)?.focus();
    return () => {
      openSheets.splice(openSheets.indexOf(me), 1);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, calm]);

  return (
    <AnimatePresence>
      {open && (
        // m-0!: a sheet rendered inside a space-y list mustn't pick up its margin and float off the bottom.
        <div ref={rootRef} className="fixed inset-0 z-[80] m-0! flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
          <motion.div
            className={cx("absolute inset-0", night ? "bg-black/55" : "bg-black/40")}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={locked ? undefined : onClose}
          />
          <motion.div
            ref={panelRef}
            tabIndex={-1}
            initial={still ? { opacity: 0 } : { y: "100%" }}
            animate={still ? { opacity: 1 } : { y: 0 }}
            exit={still ? { opacity: 0 } : { y: "100%" }}
            transition={still ? { duration: 0.18 } : { type: "spring", damping: 30, stiffness: 320 }}
            drag={locked ? false : "y"}
            dragListener={false}
            dragControls={drag}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 120 || info.velocity.y > 600) onClose();
            }}
            // A locked sheet's first moments: a tap (or Enter) does nothing, a tel: link included.
            onClickCapture={
              armed
                ? undefined
                : (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }
            }
            className={cx(
              "relative flex w-full max-w-lg flex-col rounded-t-[24px] bg-mp-bg outline-none sm:rounded-[24px]",
              calm ? "max-h-[90dvh]" : "max-h-[92dvh]"
            )}
          >
            <SheetArmed.Provider value={armed}>
            {/* Drag from the header to dismiss; the body scrolls normally. A locked sheet has no grabber and doesn't drag. */}
            <div className={cx("shrink-0", !locked && "touch-none")} onPointerDown={locked ? undefined : (e) => drag.start(e)}>
            {locked ? (
              // No grabber: its way out is a row of small text buttons at the very top, never down by the thumb.
              <div className="flex min-h-[44px] flex-wrap items-center justify-end gap-x-1 px-3 pt-2">{actions}</div>
            ) : (
              <div className="mx-auto mt-2 h-[5px] w-9 rounded-full bg-mp-ink/15" />
            )}
            <div className={cx("flex items-center justify-between gap-3 px-5 pb-3", locked ? "pt-0.5" : "pt-2")}>
              <div className="min-w-0">
                <h2 ref={titleRef} tabIndex={calm ? -1 : undefined} className={cx(display ? tone.display : tone.heading, display ? "text-[28px] leading-tight" : "text-[20px]", "outline-none")}>
                  {title}
                </h2>
                {subtitle && <p className="mt-0.5 text-[13px] leading-snug text-mp-ink-2">{subtitle}</p>}
              </div>
              {!locked && (
                <div className="-mr-1.5 flex shrink-0 items-center gap-1">
                  {actions}
                  <button type="button" onClick={onClose} aria-label="Close" className="flex h-11 w-11 items-center justify-center rounded-full">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-mp-sunken text-mp-ink-2">
                      <Icon name="x" size={18} strokeWidth={2.25} />
                    </span>
                  </button>
                </div>
              )}
            </div>
            </div>
            <div ref={bodyRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 pb-4">
              {children}
            </div>
            {/*
              Toasts while it's open (ToastHost portals them here): above the footer, never over it. A hairline
              sets one off from the form, so it can't read as the field above it; with no footer, it keeps clear
              of the home indicator.
            */}
            <div
              ref={slotRef}
              className={cx("shrink-0 px-5 not-empty:border-t not-empty:border-mp-line not-empty:pt-3", !footer && "pb-[env(safe-area-inset-bottom)]")}
              aria-live="polite"
            />
            {footer && (
              <div className="shrink-0 border-t border-mp-line px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
                {footer}
              </div>
            )}
            </SheetArmed.Provider>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

// ── Bits ─────────────────────────────────────────────────────────────────

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(tone.card, "p-4", className)}>{children}</div>;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex min-h-[28px] items-center justify-between gap-3 px-1">
      <h2 className={cx(tone.heading, "text-[17px]")}>{children}</h2>
      {action}
    </div>
  );
}

/**
 * One color per person, for their initial disc and their share of the diaper
 * bar. Sage first (Matt's green suit); none of them is a kind's hue, so a
 * person never reads as a feed or a diaper.
 */
export const MEMBER_PALETTE = ["#5C7A4A", "#8C4A5E", "#4E6E7E", "#6E6A3A", "#5A5F78"];

/** A member's own color if they set one, otherwise their place in the family list picks one from MEMBER_PALETTE. */
export function memberColor(m: Pick<Member, "email" | "color"> | null, members: Member[]): string {
  if (m?.color) return m.color;
  // By the order people joined, leaving out the shared admin login (so the first family member is sage); someone no
  // longer in the list gets a neutral, never another person's colour.
  const i = members.filter((x) => x.email !== "admin").findIndex((x) => x.email === m?.email);
  return i < 0 ? "rgb(110 117 105)" : MEMBER_PALETTE[i % MEMBER_PALETTE.length];
}

/**
 * Who logged it: their initial on their color. At 24px and up a member's own
 * emoji shows instead if they picked one; smaller than that it's always the
 * initial (an emoji at 16px is a smudge, and a grey one at night).
 */
export function Avatar({ member, size = 28 }: { member: Member | null; size?: number }) {
  const { state } = useMaple();
  const name = member?.display_name ?? member?.email ?? "";
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  const emoji = size >= 24 ? member?.emoji : null;
  return (
    <span
      title={name}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
        // Emoji keep their own colors, so they're dimmed at night like photos.
        emoji ? "bg-mp-sunken [.maple-night_&]:opacity-60 [.maple-night_&]:grayscale-[40%]" : "mp-kind-fill text-white"
      )}
      style={{
        width: size,
        height: size,
        fontSize: emoji ? size * 0.55 : size * 0.45,
        backgroundColor: emoji ? undefined : memberColor(member, state?.members ?? []),
      }}
      aria-hidden
    >
      {emoji || initial}
    </span>
  );
}

/** A chart's explanation, one tap away: "How to read this", closed by default. */
export function HowToRead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <details className={cx("group/how px-1", className)}>
      <summary className="-ml-1 inline-flex min-h-[44px] cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 text-[13px] font-medium text-mp-ink-2 outline-none focus-visible:ring-2 focus-visible:ring-mp-focus/60 [&::-webkit-details-marker]:hidden">
        <Icon name="info" size={15} className="text-mp-ink-3" />
        How to read this
        <Icon name="chevron-down" size={15} className="text-mp-ink-3 transition group-open/how:rotate-180 motion-reduce:transition-none" />
      </summary>
      <div className={cx(tone.muted, "space-y-2 pb-2 text-[13px] leading-snug")}>{children}</div>
    </details>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="px-6 py-10 text-center">
      {icon && (
        <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-mp-sunken text-mp-ink-3">
          <Icon name={icon} size={24} />
        </span>
      )}
      <p className={cx(tone.heading, "text-[17px]")}>{title}</p>
      {children && <div className={cx(tone.muted, "mx-auto mt-1 max-w-[20rem] text-sm")}>{children}</div>}
    </div>
  );
}

/**
 * Toasts pinned above the tab bar, and above Today's logging dock when it's
 * showing (the dock publishes its height as --maple-dock-h) so a toast never
 * covers a button you're about to tap. A toast with chips puts them and its
 * trailing button on one row under the text, so a timer toast stays two
 * lines tall at 375 px and doesn't climb over the card's live clock.
 *
 * While a sheet is open, toasts draw inside it, above its footer (sheetSlots):
 * the ones raised meanwhile, and any error. A confirmation already up when it
 * opened ("Saved", a diaper's color chips) is about something else, so it
 * waits outside and comes back above the dock if it hasn't timed out.
 */
export function ToastHost() {
  const { toasts, dismissToast } = useMaple();
  const night = useNightActive();
  const slot = useSyncExternalStore(subscribeSlots, topSlot, noSlot);
  // Which toasts were already up when this sheet opened (React's "adjust state while rendering" pattern).
  const [opened, setOpened] = useState<{ slot: HTMLElement | null; before: ReadonlySet<number> }>({ slot: null, before: new Set() });
  if (opened.slot !== slot) setOpened({ slot, before: new Set(toasts.map((t) => t.id)) });
  const inSheet = slot ? toasts.filter((t) => t.tone === "error" || !opened.before.has(t.id)) : [];
  return (
    <>
      <div
        data-maple-toasts
        className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--maple-dock-h,0px)+72px+env(safe-area-inset-bottom))] z-[90] flex flex-col items-center gap-2 px-4"
        aria-live="polite"
      >
        <AnimatePresence>
          {!slot &&
            toasts.map((t) => (
              <motion.div
                key={t.id}
                initial={{ opacity: 0, y: 16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8 }}
                className={cx("pointer-events-auto w-full max-w-md shadow-[0_8px_30px_rgba(0,0,0,0.18)]", toastLook(t))}
              >
                <ToastBody t={t} dismiss={dismissToast} />
              </motion.div>
            ))}
        </AnimatePresence>
      </div>
      {slot &&
        createPortal(
          <AnimatePresence initial={false}>
            {inSheet.map((t) => (
              // It opens room for itself (at night it just fades in, nothing slides).
              <motion.div
                key={t.id}
                initial={night ? { opacity: 0 } : { opacity: 0, height: 0 }}
                animate={night ? { opacity: 1 } : { opacity: 1, height: "auto" }}
                exit={night ? { opacity: 0 } : { opacity: 0, height: 0 }}
                transition={{ duration: 0.18 }}
                className="overflow-hidden"
              >
                <div className="pb-3">
                  <div className={toastLook(t)}>
                    <ToastBody t={t} dismiss={dismissToast} />
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>,
          slot
        )}
    </>
  );
}

const toastLook = (t: Toast) =>
  cx(
    // The card edge token: no ring by day, a hairline in dark mode and at night, where the toast is a dark card over dark cards.
    "rounded-2xl px-4 py-3 text-[15px] ring-1 ring-(--mp-edge)",
    t.tone === "error" ? "bg-[#8A2F1C] text-white [.maple-night_&]:bg-[#2A140C] [.maple-night_&]:text-[#F0A07A]" : "bg-mp-toast text-mp-on-toast"
  );

/** A toast's text, chips and trailing button (Undo, "Back to 4:25"). */
function ToastBody({ t, dismiss }: { t: Toast; dismiss: (id: number) => void }) {
  const undo = t.undo && (
    <button
      type="button"
      onClick={() => {
        t.undo?.();
        dismiss(t.id);
      }}
      className={cx("min-h-[44px] shrink-0 rounded-full bg-current/15 px-3 text-sm font-semibold whitespace-nowrap", !!t.actions?.length && "ml-auto")}
    >
      {t.undoLabel ?? "Undo"}
    </button>
  );
  return (
    <>
      <div className="flex items-center gap-3">
        {/* A diaper's own mark (drop or pile) says what was saved; everything else gets the check. */}
        <Icon name={t.icon ?? (t.tone === "error" ? "triangle-alert" : t.tone === "info" ? "info" : "circle-check")} size={20} className="shrink-0 opacity-80" />
        <span className="flex-1">{t.text}</span>
        {!t.actions?.length && undo}
      </div>
      {t.actions?.length ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {t.actions.map((a) => (
            <button
              key={a.label}
              type="button"
              aria-label={a.ariaLabel ?? (a.sub ? `${a.label}, ${a.sub}` : a.label)}
              onClick={() => {
                a.onClick();
                dismiss(t.id);
              }}
              className={cx(
                "inline-flex min-h-[44px] items-center gap-1.5 bg-current/15 font-semibold",
                // A chip with a second line (the time it produces) is a two-line tile.
                a.sub ? "min-w-[96px] flex-col items-start justify-center rounded-xl px-3 py-1 text-left" : "rounded-full px-3 text-xs"
              )}
            >
              {/* mp-swatch: the real colour, dimmed at night, never folded into amber (matching the diaper is the point). */}
              {a.color && <span className="mp-swatch h-4 w-4 rounded-full ring-1 ring-current/40" style={{ backgroundColor: a.color }} aria-hidden />}
              {a.sub ? (
                <>
                  <span className="text-[13px] leading-tight">{a.label}</span>
                  <span className="text-[12px] leading-tight font-medium tabular-nums opacity-80">{a.sub}</span>
                </>
              ) : (
                a.label
              )}
            </button>
          ))}
          {undo}
        </div>
      ) : null}
    </>
  );
}
