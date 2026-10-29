import { DEVELOPMENT_MILESTONES, DEVELOPMENT_TOPICS, DISCOVERIES, type DevelopmentMilestone, type Discovery } from "./guidelines/development";
import { addDays, dayKey, daysBetween, DEFAULT_TZ, parseDayKey } from "./time";
import type { Baby } from "./types";

export type DevelopmentAge = { days: number; months: number; corrected: boolean; label: string };
type DevelopmentBaby = Pick<Baby, "born_at" | "timezone" | "settings">;

function monthAnniversary(birthDay: string, months: number): string {
  const birth = parseDayKey(birthDay);
  const monthEnd = new Date(Date.UTC(birth.year, birth.month + months, 0));
  const day = Math.min(birth.day, monthEnd.getUTCDate());
  return new Date(Date.UTC(monthEnd.getUTCFullYear(), monthEnd.getUTCMonth(), day)).toISOString().slice(0, 10);
}

function calendarAge(birthDay: string, today: string, corrected: boolean): DevelopmentAge | null {
  if (today < birthDay) return null;
  const b = parseDayKey(birthDay);
  const n = parseDayKey(today);
  let months = (n.year - b.year) * 12 + n.month - b.month;
  if (today < monthAnniversary(birthDay, months)) months -= 1;
  const days = daysBetween(birthDay, today);
  const unit = months < 2 ? `${days} ${days === 1 ? "day" : "days"}` : `${months} months`;
  return { days, months, corrected, label: `${unit}${corrected ? " corrected age" : " old"}` };
}

function ages(baby: DevelopmentBaby, now: Date) {
  if (!baby.born_at || !Number.isFinite(now.getTime())) return null;
  const datePart = /^(\d{4}-\d{2}-\d{2})T/.exec(baby.born_at)?.[1];
  const born = new Date(baby.born_at);
  if (!datePart || addDays(datePart, 0) !== datePart || !Number.isFinite(born.getTime()) || born > now) return null;
  try {
    const tz = baby.timezone || DEFAULT_TZ;
    const birthDay = dayKey(born, tz);
    const today = dayKey(now, tz);
    if (today > monthAnniversary(birthDay, 24)) return null;
    const chronological = calendarAge(birthDay, today, false);
    const gestation = baby.settings.gestational_age_weeks;
    const corrected = typeof gestation === "number" && Number.isFinite(gestation) && gestation >= 22 && gestation < 37;
    const correctedBirthDay = corrected ? addDays(birthDay, Math.round((40 - gestation) * 7)) : birthDay;
    return { chronological, developmental: calendarAge(correctedBirthDay, today, corrected), birthDay, today };
  } catch {
    return null;
  }
}

export function developmentAge(baby: DevelopmentBaby, now: Date): DevelopmentAge | null {
  return ages(baby, now)?.developmental ?? null;
}

export function eligibleDiscoveries(baby: DevelopmentBaby, now: Date, topics: readonly string[] = []): readonly Discovery[] {
  const age = ages(baby, now);
  if (!age?.chronological) return [];
  const selected = new Set(topics.filter((topic) => DEVELOPMENT_TOPICS.some(({ id }) => id === topic)));
  return DISCOVERIES.filter((item) => {
    const contentAge = item.ageBasis === "chronological" ? age.chronological : age.developmental;
    return contentAge && (!selected.size || selected.has(item.topic)) && contentAge.months >= item.minMonths && contentAge.months < item.maxMonths;
  });
}

export function dailyDiscovery(baby: DevelopmentBaby, now: Date, topics: readonly string[]): Discovery | null {
  const age = ages(baby, now);
  if (!age?.chronological) return null;
  const eligible = eligibleDiscoveries(baby, now, topics);
  if (!eligible.length) return null;
  return eligible[daysBetween(age.birthDay, age.today) % eligible.length];
}

export function applicableMilestones(baby: DevelopmentBaby, now: Date): readonly DevelopmentMilestone[] {
  const age = developmentAge(baby, now);
  if (!age) return [];
  const byMonths = DEVELOPMENT_MILESTONES.find((milestone) => milestone.byMonths >= age.months)?.byMonths;
  return DEVELOPMENT_MILESTONES.filter((milestone) => milestone.byMonths === byMonths);
}
