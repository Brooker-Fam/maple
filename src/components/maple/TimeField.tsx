"use client";

import { useEffect, useId, useState } from "react";
import { dayKey, formatDayLabel, formatTime, localParts } from "@/lib/maple/time";
import { parseRecordedTime } from "@/lib/maple/time-edit";
import { cx, tone } from "./ui";
import { useMaple, useNow } from "./useMaple";

function fields(value: Date, tz: string) {
  const p = localParts(value, tz);
  return { basis: value.getTime(), tz, day: dayKey(value, tz), clock: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` };
}

/** The same visible date and clock for a dose, a nursing moment, or an earlier log. */
export function RecordedTimeField({ label, hideLabel, value, onChange, tz, min, max, onInvalidChange }: {
  label: string;
  /** The enclosing editor already displays the question; keep the accessible name. */
  hideLabel?: boolean;
  value: Date;
  onChange: (value: Date) => void;
  tz: string;
  min?: Date;
  max?: Date;
  onInvalidChange: (invalid: boolean) => void;
}) {
  const id = useId();
  const { now: nowFn } = useMaple();
  const now = useNow(30_000);
  const [draft, setDraft] = useState(() => fields(value, tz));
  if (draft.basis !== value.getTime() || draft.tz !== tz) setDraft(fields(value, tz));
  const ceiling = max ?? new Date(now.getTime() + 60_000);
  const result = parseRecordedTime(draft.day, draft.clock, tz, value, { min, max: ceiling });
  const invalid = !result.valid;
  useEffect(() => { onInvalidChange(invalid); }, [invalid, onInvalidChange]);
  const parsedTime = result.valid ? result.date.getTime() : null;
  useEffect(() => {
    // A future draft can become valid as the clock advances. Save must use what
    // the visible fields say, rather than the previous valid value.
    if (parsedTime !== null && parsedTime !== value.getTime()) onChange(new Date(parsedTime));
  }, [parsedTime, value, onChange]);

  const change = (day: string, clock: string) => {
    setDraft({ ...draft, day, clock });
    const parsed = parseRecordedTime(day, clock, tz, value, { min, max: max ?? new Date(nowFn().getTime() + 60_000) });
    onInvalidChange(!parsed.valid);
    if (parsed.valid) onChange(parsed.date);
  };
  const choose = (date: Date) => {
    const next = fields(date, tz);
    setDraft(next);
    onInvalidChange(false);
    onChange(date);
  };
  const nudge = (minutes: number) => {
    if (result.valid) choose(new Date(result.date.getTime() + minutes * 60_000));
  };

  return (
    <fieldset className={cx(tone.inset, "min-w-0 space-y-3 p-3")}>
      <legend className="sr-only">{label}</legend>
      {!hideLabel && <p className="text-[15px] font-semibold text-mp-ink">{label}</p>}
      <p id={`${id}-status`} role={invalid ? "alert" : "status"} aria-atomic="true" className={cx("leading-snug tabular-nums", invalid ? "text-[13px] text-mp-danger" : "text-[17px] font-semibold text-mp-ink")}>
        {result.valid ? `${formatDayLabel(dayKey(result.date, tz), dayKey(now, tz))} at ${formatTime(result.date, tz)}` : result.message}
      </p>
      <div role="group" aria-label="Adjust time" className="grid grid-cols-4 gap-1.5">
        {[-5, -1, 1, 5].map((minutes) => {
          const next = result.valid ? result.date.getTime() + minutes * 60_000 : null;
          return (
            <button
              key={minutes}
              type="button"
              aria-label={`${Math.abs(minutes)} min ${minutes < 0 ? "earlier" : "later"}`}
              disabled={next === null || (!!min && next < min.getTime()) || next > ceiling.getTime()}
              onClick={() => nudge(minutes)}
              className="mp-control flex min-h-[52px] min-w-0 flex-col items-center justify-center rounded-xl border border-mp-line bg-mp-surface px-1 py-2 text-mp-ink disabled:opacity-40"
            >
              <span className="text-[15px] leading-tight font-semibold tabular-nums">{minutes < 0 ? "−" : "+"}{Math.abs(minutes)} min</span>
              <span className="text-[12px] leading-tight font-medium text-mp-ink-2">{minutes < 0 ? "earlier" : "later"}</span>
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,160px),1fr))] gap-3">
        <label className={cx(tone.label, "min-w-0 space-y-1.5")}>
          <span className="block">Date</span>
          <input type="date" aria-label={`${label}: date`} aria-invalid={invalid || undefined} aria-describedby={`${id}-status`} value={draft.day} onChange={(e) => change(e.target.value, draft.clock)} className={cx(tone.input, "min-h-[48px] min-w-0 max-w-full")} />
        </label>
        <label className={cx(tone.label, "min-w-0 space-y-1.5")}>
          <span className="block">Time</span>
          <input type="time" aria-label={`${label}: time`} aria-invalid={invalid || undefined} aria-describedby={`${id}-status`} value={draft.clock} onChange={(e) => change(draft.day, e.target.value)} className={cx(tone.input, "min-h-[48px] min-w-0 max-w-full")} />
        </label>
      </div>
      {result.alternatives && result.alternatives.length > 1 && (
        <div className="space-y-1.5">
          <p className={cx(tone.muted, "text-[13px]")}>The clocks go back. Which occurrence?</p>
          <div className="flex flex-wrap gap-2">
            {result.alternatives.map((at, i) => (
              <button key={at.toISOString()} type="button" aria-pressed={!!result.date && Math.floor(at.getTime() / 60_000) === Math.floor(result.date.getTime() / 60_000)} disabled={(!!min && at < min) || at > ceiling} onClick={() => choose(at)} className="mp-control min-h-[44px] rounded-xl border border-mp-line bg-mp-surface px-3 text-sm font-medium text-mp-accent-fg disabled:opacity-40 aria-pressed:bg-mp-accent aria-pressed:text-mp-on-accent">
                {i === 0 ? "First" : "Second"} {formatTime(at, tz)}
              </button>
            ))}
          </div>
        </div>
      )}
    </fieldset>
  );
}
