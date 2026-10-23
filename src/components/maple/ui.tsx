"use client";

import { AnimatePresence, motion, useDragControls } from "framer-motion";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
import { useMaple, useNow } from "./useMaple";

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
  /** A white card on the paper background, with a hairline edge. */
  card: "rounded-[20px] border border-mp-line bg-mp-surface",
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
    sm: "min-h-[36px] rounded-[10px] px-3 text-sm",
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
    <div className={cx("flex rounded-xl bg-mp-sunken p-[3px]", className)} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "min-h-[38px] flex-1 rounded-[10px] px-3 text-sm transition",
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
}) {
  const { text, setText, invalid } = useTypedNumber(value, max, onInvalid);
  const bump = (d: number) => {
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
  // Opening with a time already set (editing, or "log an earlier one") goes straight to the scrubber.
  const [custom, setCustom] = useState(() => value != null);
  // Which quick chip was tapped, so it stays lit as the clock moves on.
  const [chip, setChip] = useState<number | null>(null);
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
 * now + 1 minute.
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
    set(Math.round(latest.current / MIN_MS) * MIN_MS + mins * MIN_MS);
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

  const pickDay = (k: string) => {
    setChip(null);
    const n = nowFn();
    set(Math.min(resolveWallTime(k, p.hour, p.minute, tz, n).getTime(), n.getTime()));
  };

  return (
    <div role="group" aria-label={label ?? "Time"} className={cx(tone.inset, "p-3", className)}>
      <div className="-mt-1 flex items-center justify-between gap-3">
        <span className={tone.label}>{label && !hideLabel ? label : ""}</span>
        <button
          type="button"
          onClick={() => setExact((x) => !x)}
          aria-expanded={exact}
          className="-my-2 min-h-[44px] px-1 text-[13px] font-semibold text-mp-accent-fg"
        >
          Exact time…
        </button>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="text-[28px] leading-tight font-semibold tracking-[-0.02em] text-mp-ink tabular-nums">{formatTime(value, tz)}</span>
        <span className={cx(tone.muted, "text-sm")}>
          {formatDayLabel(key, todayKey)} · {formatRelative(value, now)}
        </span>
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
            className="h-[52px] rounded-xl border border-mp-line bg-mp-raised text-lg font-semibold text-mp-ink tabular-nums"
          >
            {d < 0 ? "−" : "+"}
            {Math.abs(d)}
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

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useDragControls();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        // m-0!: a sheet rendered inside a space-y list mustn't pick up its margin and float off the bottom.
        <div className="fixed inset-0 z-[80] m-0! flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
          <motion.div
            className="absolute inset-0 bg-black/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            ref={panelRef}
            tabIndex={-1}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 320 }}
            drag="y"
            dragListener={false}
            dragControls={drag}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 120 || info.velocity.y > 600) onClose();
            }}
            className="relative flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-[24px] bg-mp-bg outline-none sm:rounded-[24px]"
          >
            {/* Drag from the header to dismiss; the body scrolls normally. */}
            <div className="shrink-0 touch-none" onPointerDown={(e) => drag.start(e)}>
            <div className="mx-auto mt-2 h-[5px] w-9 rounded-full bg-mp-ink/15" />
            <div className="flex items-center justify-between gap-3 px-5 pt-2 pb-3">
              <h2 className={cx(tone.heading, "text-[20px]")}>{title}</h2>
              <button type="button" onClick={onClose} aria-label="Close" className="-mr-1.5 flex h-11 w-11 items-center justify-center rounded-full">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-mp-sunken text-mp-ink-2">
                  <Icon name="x" size={18} strokeWidth={2.25} />
                </span>
              </button>
            </div>
            </div>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 pb-4">
              {children}
            </div>
            {footer && (
              <div className="shrink-0 border-t border-mp-line px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
                {footer}
              </div>
            )}
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
    <div className="mb-2 flex min-h-[28px] items-end justify-between gap-3 px-1">
      <h2 className={cx(tone.heading, "text-[17px]")}>{children}</h2>
      {action}
    </div>
  );
}

/** A member's own emoji if they picked one, otherwise their initial. */
export function Avatar({ member, size = 28 }: { member: Member | null; size?: number }) {
  const name = member?.display_name ?? member?.email ?? "";
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span
      title={name}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
        // Emoji keep their own colors, so they're dimmed at night like photos.
        member?.emoji ? "bg-mp-sunken [.maple-night_&]:opacity-60 [.maple-night_&]:grayscale-[40%]" : "mp-kind-fill text-white"
      )}
      style={{
        width: size,
        height: size,
        fontSize: member?.emoji ? size * 0.55 : size * 0.45,
        backgroundColor: member?.emoji ? undefined : member?.color ?? "#5C7A4A",
      }}
      aria-hidden
    >
      {member?.emoji ?? initial}
    </span>
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
 * covers a button you're about to tap.
 */
export function ToastHost() {
  const { toasts, dismissToast } = useMaple();
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--maple-dock-h,0px)+72px+env(safe-area-inset-bottom))] z-[90] flex flex-col items-center gap-2 px-4" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8 }}
            className={cx(
              "pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl px-4 py-3 text-[15px] shadow-[0_8px_30px_rgba(0,0,0,0.18)] [.maple-night_&]:ring-1 [.maple-night_&]:ring-mp-line",
              t.tone === "error" ? "bg-[#8A2F1C] text-white [.maple-night_&]:bg-[#2A140C] [.maple-night_&]:text-[#F0A07A]" : "bg-mp-toast text-mp-on-toast"
            )}
          >
            <Icon name={t.tone === "error" ? "triangle-alert" : t.tone === "info" ? "info" : "circle-check"} size={20} className="shrink-0 self-start opacity-80" />
            <span className="flex-1">
              {t.text}
              {t.actions?.length ? (
                <span className="mt-2 flex flex-wrap gap-1.5">
                  {t.actions.map((a) => (
                    <button
                      key={a.label}
                      type="button"
                      aria-label={a.ariaLabel ?? a.label}
                      onClick={() => {
                        a.onClick();
                        dismissToast(t.id);
                      }}
                      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-current/15 px-2.5 text-xs font-semibold"
                    >
                      {a.color && <span className="mp-kind-fill h-4 w-4 rounded-full ring-1 ring-current/40" style={{ backgroundColor: a.color }} aria-hidden />}
                      {a.label}
                    </button>
                  ))}
                </span>
              ) : null}
            </span>
            {t.undo && (
              <button
                type="button"
                onClick={() => {
                  t.undo?.();
                  dismissToast(t.id);
                }}
                className="min-h-[36px] shrink-0 rounded-full bg-current/15 px-3 text-sm font-semibold"
              >
                Undo
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
