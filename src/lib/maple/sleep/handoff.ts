/**
 * The next planned handoff against the night roster. A handoff is never
 * planned inside the protected window of the person it goes to (an active
 * sleep goal's roster: goals.ts windowOn), since every phone with handoff
 * reminders on would ring then. The default (as long as the turn handed
 * over, engine.ts nextHandoff) moves to the end of that window, or, when
 * that end is over 12 hours from the handoff, to no planned handoff, and
 * `why` says so for the reply, the toast and the catch-up. An explicit time
 * someone picked is theirs and never moves. Pure, for the store, the app and
 * the tools.
 */
import { addDays, formatTime, formatTimeNear } from "../time";
import { tryDayKey } from "./engine";
import { windowOn, windowOnNight } from "./goals";
import { HANDOFF_AHEAD_MS, type SleepGoal } from "./types";

/** One adult's protected window (or windows back to back) as instants. */
export type RosterSpan = { member: string; start: number; end: number };

/**
 * Why the next handoff isn't the default: it fell in `member`'s protected
 * window (`starts_at` to `ends_at`), so it's planned for the window's end
 * (`planned_at`), or for none (null) when that's over 12 hours away.
 */
export type HandoffWhy = { member: string; starts_at: string; ends_at: string; default_at: string; planned_at: string | null };

type Goals = readonly (Pick<SleepGoal, "status" | "roster"> & { template?: SleepGoal["template"] })[];

/**
 * The protected window of `member`, on an active goal's roster, that `t` falls in ([start, end), on the night it began), or
 * null. A Back to work roster starts on its own night (`template.roster_from`): before it, none of its windows is on.
 */
export function windowAt(goals: Goals, member: string, t: number, tz: string): RosterSpan | null {
  const night = tryDayKey(t, tz);
  for (const g of goals) {
    if (g.status !== "active") continue;
    const from = g.template?.roster_from ?? null;
    for (const w of g.roster) {
      if (w.member !== member) continue;
      // A window belongs to the night it begins on (a try day, noon to noon), so one covering t began that night or the one before.
      for (const n of [addDays(night, -1), night]) {
        if (!windowOnNight(w, n) || (from && n < from)) continue;
        const [s, e] = windowOn(w, n, tz).map((d) => d.getTime());
        if (t >= s && t < e) return { member, start: s, end: e };
      }
    }
  }
  return null;
}

/**
 * The planned handoff to `nextHolder` at `at` (the default, from `from`, the
 * moment of this handoff), moved off their protected sleep: to the end of
 * the window it falls in (windows back to back count as one), or null when
 * that's over HANDOFF_AHEAD_MS after `from`. `why` is null when it stands.
 */
export function handoffAroundRoster(o: { at: number; from: number; nextHolder: string | null | undefined; goals: Goals; tz: string }): { at: number | null; why: HandoffWhy | null } {
  if (!o.nextHolder) return { at: o.at, why: null };
  let t = o.at;
  let first: RosterSpan | null = null;
  for (let i = 0; i < 6; i++) {
    const w = windowAt(o.goals, o.nextHolder, t, o.tz);
    if (!w || w.end <= t) break;
    first = first ?? w;
    t = w.end;
  }
  if (!first) return { at: o.at, why: null };
  const at = t - o.from <= HANDOFF_AHEAD_MS ? t : null;
  const iso = (x: number) => new Date(x).toISOString();
  return { at, why: { member: o.nextHolder, starts_at: iso(first.start), ends_at: iso(t), default_at: iso(o.at), planned_at: at == null ? null : iso(at) } };
}

/** "1:30–6:30 AM": a protected window's times. */
export const windowRange = (why: Pick<HandoffWhy, "starts_at" | "ends_at">, tz: string) => `${formatTimeNear(why.starts_at, why.ends_at, tz)}–${formatTime(why.ends_at, tz)}`;

/**
 * Why the next handoff moved, in a phone's words (`name`: whose window, or
 * "your"): "after Sam's protected sleep (1:30–6:30 AM)", or, with none
 * planned, "none planned: Sam's protected sleep (…) runs past 12 hours from now".
 */
export function handoffWhyWords(why: HandoffWhy, name: string, tz: string): string {
  const whose = name === "your" ? "your" : `${name}'s`;
  return why.planned_at ? `after ${whose} protected sleep (${windowRange(why, tz)})` : `none planned: ${whose} protected sleep (${windowRange(why, tz)}) runs past 12 hours from now`;
}
