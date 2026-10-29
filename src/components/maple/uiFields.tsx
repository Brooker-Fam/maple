"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { addDays, dayKey, formatDayLabel, formatDuration, formatRelative, formatTime, localParts, parseDayKey, zonedTimeToUtc } from "@/lib/maple/time";
import { Icon } from "./icons";
import { useMaple, useNow } from "./useMaple";
import { Chip, Segmented, cx, tone } from "./ui";

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

const STEP_BTN = "mp-control flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-mp-sunken text-mp-ink active:scale-95";

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
  offsets = [1, 5, 15, 30, 60, 120],
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
              onChange(new Date(now().getTime() - m * 60000));
            }}
          >
            {m < 60 ? `${m} min ago` : `${m / 60}h ago`}
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
        "mp-control touch-manipulation select-none [-webkit-touch-callout:none] transition active:scale-[0.96] disabled:opacity-35 disabled:active:scale-100",
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
  quick = [0, 1, 5, 15, 30, 60, 120],
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
    // A one-minute adjustment preserves seconds, just like the recorded-time controls.
    set(latest.current + mins * MIN_MS);
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
      className="mp-control -my-2 min-h-[44px] rounded-lg px-1 text-[13px] font-semibold text-mp-accent-fg"
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
          {quick.map((m) => (
            <Chip
              key={m}
              raised
              className="min-h-[44px]!"
              selected={chip?.m === m && chip.at === t}
              onClick={() => setChip({ m, at: set(nowFn().getTime() - m * MIN_MS) })}
            >
              {m === 0 ? "Now" : `${m < 60 ? `${m} min` : `${m / 60}h`} ago`}
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
  startQuick,
}: {
  start: Date;
  end: Date;
  onChange: (start: Date, end: Date) => void;
  tz: string;
  labels?: [string, string];
  /** Minutes; [] hides the chips. */
  durations?: number[];
  /** "{N}m ago" chips under the start (only the ones that leave the start before the end). */
  startQuick?: number[];
}) {
  const { now } = useMaple();
  const ms = Math.max(0, end.getTime() - start.getTime());
  const startChips = startQuick?.filter((m) => now().getTime() - m * MIN_MS <= end.getTime() - MIN_MS);
  const fmt = (m: number) => (m < 60 ? `${m}m` : `${Math.round((m / 60) * 10) / 10}h`);
  return (
    <div className="space-y-2">
      <TimeScrubber label={labels[0]} value={start} max={end} quick={startChips?.length ? startChips : false} tz={tz} onChange={(s) => onChange(s, end)} />
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
