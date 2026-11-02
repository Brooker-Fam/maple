/**
 * The night roster as notifications and Siri read it: one adult's protected
 * windows on the family's active sleep goals (goals.ts owns the goals and
 * their windows; handoff.ts windowAt says whether a moment is inside one).
 * Pure, for the server and the app: Quiet during my protected sleep
 * (push-quiet.ts and the Notifications sheet's switch), the wake at a
 * window's end (push-wake.ts), and the moment Siri's "what did I miss?"
 * counts from (quick/recap.ts).
 */
import { addDays } from "../time";
import { tryDayKey } from "./engine";
import { windowOn, windowOnNight } from "./goals";
import type { RosterSpan } from "./handoff";
import type { RosterWindow, SleepGoal, WindowCovers } from "./types";
import { nightsLabel, shortClock } from "./words";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The goals as the roster reads them: status and roster, and the template (who nurses) where a goal has one. */
export type RosterGoals = readonly (Pick<SleepGoal, "status" | "roster"> & { template?: SleepGoal["template"] })[];

/** `member`'s windows on the active goals' rosters (a paused, met or dropped goal's roster protects no one). */
export function rosterWindowsOf(goals: RosterGoals, member: string): RosterWindow[] {
  return goals.filter((g) => g.status === "active").flatMap((g) => g.roster.filter((w) => w.member === member));
}

/** The adults with a window on an active goal's roster. */
export const rosterMembers = (goals: RosterGoals): string[] => [...new Set(goals.filter((g) => g.status === "active").flatMap((g) => g.roster.map((w) => w.member)))];

/**
 * Each of `member`'s protected windows that overlaps [from, to), as instants
 * in the family's zone (`tz`), earliest first; the same window on two goals
 * counts once. A window belongs to the night it begins on (a try day, noon
 * to noon), so the night before `from` is read too.
 */
export function windowsBetween(goals: RosterGoals, member: string, from: number, to: number, tz: string): RosterSpan[] {
  return spansOf(goals, member, from, to, tz).map(({ start, end }) => ({ member, start, end }));
}

type Span = RosterSpan & { window: RosterWindow; goal: RosterGoals[number] };

function spansOf(goals: RosterGoals, member: string, from: number, to: number, tz: string): Span[] {
  const active = goals.filter((g) => g.status === "active");
  if (to <= from || !active.some((g) => g.roster.some((w) => w.member === member))) return [];
  const out: Span[] = [];
  const seen = new Set<string>();
  const last = tryDayKey(to, tz);
  let night = addDays(tryDayKey(from, tz), -1);
  for (let i = 0; i < 400 && night <= last; i++, night = addDays(night, 1)) {
    for (const goal of active) {
      for (const w of goal.roster) {
        if (w.member !== member || !windowOnNight(w, night)) continue;
        const [start, end] = windowOn(w, night, tz).map((d) => d.getTime());
        if (end <= from || start >= to || seen.has(`${start}|${end}`)) continue;
        seen.add(`${start}|${end}`);
        out.push({ member, start, end, window: w, goal });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * How her feeds are covered in `member`'s protected window (the one going on
 * now, else the next that begins before `until`, the next planned handoff),
 * for the catch-up of whoever takes over from them: the window's end, its
 * `covers` (nurse, bottle or none; null when the window doesn't say), and who
 * nurses when the goal's template names them (Back to work): a member id,
 * null for a baby on bottles only, or undefined when the goal doesn't say.
 * Null without such a window.
 */
export function feedCover(goals: RosterGoals, member: string, now: number, until: number, tz: string): { member: string; end: number; covers: WindowCovers | null; nursing: string | null | undefined } | null {
  // The windows that overlap [now, until): the earliest is the one going on now, else the next to begin.
  const span = spansOf(goals, member, now, Math.max(until, now + MIN), tz)[0];
  if (!span) return null;
  const t = span.goal.template;
  return { member, end: span.end, covers: span.window.covers ?? null, nursing: t ? t.nursing : undefined };
}

/** Windows that touch or overlap read as one stretch of protected sleep. */
function stretchBack(spans: readonly RosterSpan[], span: RosterSpan): RosterSpan {
  let start = span.start;
  for (let moved = true; moved; ) {
    moved = false;
    for (const s of spans) {
      if (s.start < start && s.end >= start) {
        start = s.start;
        moved = true;
      }
    }
  }
  return { ...span, start };
}

/**
 * The protected sleep "what did I miss?" counts from: the window `member` is
 * in now (`now: true`), else their last one that ended by now on this try
 * day (noon to noon, so last night's until noon), with windows back to back
 * read as one, from where that stretch began. Null without one.
 */
export function recapSpan(goals: RosterGoals, member: string, now: Date, tz: string): (RosterSpan & { now: boolean }) | null {
  const t = now.getTime();
  const spans = windowsBetween(goals, member, t - 36 * HOUR, t + MIN, tz);
  if (!spans.length) return null;
  const current = spans.filter((s) => s.start <= t && t < s.end).sort((a, b) => a.start - b.start)[0];
  if (current) return { ...stretchBack(spans, current), now: true };
  const today = tryDayKey(now, tz);
  const ended = spans.filter((s) => s.end <= t && tryDayKey(s.start, tz) === today).sort((a, b) => b.end - a.end)[0];
  return ended ? { ...stretchBack(spans, ended), now: false } : null;
}

/**
 * "10 PM–2 AM", "10 PM–2 AM, Sun–Thu nights", "10 PM–2 AM and 4 AM–6 AM",
 * "10 PM–2 AM, Sun–Thu nights; 1 AM–6 AM, Fri and Sat nights": `member`'s
 * own windows on the active rosters, for the Notifications sheet's "Quiet
 * during my protected sleep (…)". Null when they have none, so the switch
 * shows only for the adults on a roster.
 */
export function quietWindowWords(goals: RosterGoals, member: string): string | null {
  const windows = rosterWindowsOf(goals, member);
  if (!windows.length) return null;
  const byTime = new Map<string, Set<number>>();
  for (const w of windows) {
    const time = `${shortClock(w.from)}–${shortClock(w.to)}`;
    byTime.set(time, new Set([...(byTime.get(time) ?? []), ...w.nights]));
  }
  const parts = [...byTime].map(([time, nights]) => (nights.size >= 7 ? time : `${time}, ${nightsLabel([...nights])}`));
  if (parts.length === 1) return parts[0];
  return parts.some((p) => p.includes(",")) ? parts.join("; ") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
