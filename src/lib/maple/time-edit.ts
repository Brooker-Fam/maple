import { dayKey, formatTime, localParts, tzOffsetMinutes, zonedTimeToUtc } from "./time";

export type RecordedTimeResult =
  | { valid: true; date: Date; alternatives: Date[] }
  | { valid: false; message: string; date?: Date; alternatives?: Date[] };

/** An explicit date never silently becomes yesterday, now, or a neighbouring event. */
export function parseRecordedTime(
  day: string,
  clock: string,
  tz: string,
  reference: Date,
  bounds: { min?: Date; max?: Date } = {}
): RecordedTimeResult {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const t = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!d || !t) return { valid: false, message: "Choose a date and time." };
  const [year, month, date] = d.slice(1).map(Number);
  const [hour, minute] = t.slice(1).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, date));
  if (year < 1900 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== date || hour > 23 || minute > 59) {
    return { valid: false, message: "Check the date and time." };
  }
  const first = zonedTimeToUtc(year, month, date, hour, minute, tz);
  // Include half-hour clock changes as well as the usual one-hour DST change.
  const alternatives = [-120, -90, -60, -30, 0, 30, 60, 90, 120]
    .map((offset) => new Date(first.getTime() + offset * 60_000))
    .filter((candidate) => {
      const p = localParts(candidate, tz);
      return p.year === year && p.month === month && p.day === date && p.hour === hour && p.minute === minute;
    });
  if (!alternatives.length) return { valid: false, message: "The clocks skip this time on that date. Choose another time." };
  // Keep the saved occurrence of a repeated hour. Offer both occurrences in the UI.
  const offset = tzOffsetMinutes(reference, tz);
  let chosen = alternatives.find((candidate) => tzOffsetMinutes(candidate, tz) === offset) ?? alternatives[0];
  if (dayKey(reference, tz) === day && Math.floor(reference.getTime() / 60_000) === Math.floor(chosen.getTime() / 60_000)) chosen = reference;
  const firstMinute = bounds.min && new Date(Math.ceil(bounds.min.getTime() / 60_000) * 60_000);
  const lastMinute = bounds.max && new Date(Math.floor(bounds.max.getTime() / 60_000) * 60_000);
  if (bounds.min && chosen < bounds.min) return { valid: false, date: chosen, alternatives, message: `Choose ${dayKey(firstMinute!, tz)} at ${formatTime(firstMinute!, tz)} or later.` };
  if (bounds.max && chosen > bounds.max) return { valid: false, date: chosen, alternatives, message: `Choose ${dayKey(lastMinute!, tz)} at ${formatTime(lastMinute!, tz)} or earlier.` };
  return { valid: true, date: chosen, alternatives };
}
