import { FORTY_DAYS, FORTY_DAY_NOTES, FORTY_DAY_STAGES, type FortyDaysNote, type FortyDaysStage } from "./guidelines/forty-days";
import { babyAge } from "./time";

/**
 * Which day of the first forty it is (1 is the day of the birth), by the same
 * clock as Today's "Day 6" (babyAge's dayOfLife in the family's timezone), so
 * her page and Today never disagree; null before the birth, without one, or
 * once the forty days are over.
 */
export function fortyDay(bornAt: string | null | undefined, now: Date, tz: string): number | null {
  if (!bornAt) return null;
  const born = Date.parse(bornAt);
  if (!Number.isFinite(born) || !Number.isFinite(now.getTime()) || born > now.getTime()) return null;
  const day = babyAge(bornAt, now, tz).dayOfLife;
  return day >= 1 && day <= FORTY_DAYS ? day : null;
}

/** The stretch of the forty days a day falls in. */
export function fortyDaysStage(day: number): FortyDaysStage | null {
  return FORTY_DAY_STAGES.find((s) => day >= s.from && day <= s.to) ?? null;
}

/** One day's note: that stretch's notes taken in turn from its first day, so the same day always reads the same note. */
export function fortyDaysNote(day: number): FortyDaysNote | null {
  const stage = fortyDaysStage(day);
  if (!stage) return null;
  const notes = FORTY_DAY_NOTES.filter((n) => n.stage === stage.id);
  return notes.length ? notes[(day - stage.from) % notes.length] : null;
}
