import { query } from "@/lib/db";
import type { FamilyScope } from "./family";
import { windowAt, type RosterSpan } from "./sleep/handoff";
import { windowsBetween, type RosterGoals } from "./sleep/roster";
import { activeRosters } from "./sleep/roster-read";

/**
 * Quiet during my protected sleep: Maple's server holds a phone's nursing
 * and medicine notices while its person sleeps, since an iPhone web push
 * always shows (it can't be silent, badge-only or Time Sensitive), so the
 * only quiet that works is not sending.
 *
 * A phone is quiet when all of these hold right now:
 *   - its setting is on (prefs.quiet_window; unset means on), and its person
 *     is on an active sleep goal's night roster, inside their own protected
 *     window (sleep/handoff.ts windowAt);
 *   - they aren't holding her on an open holding turn;
 *   - they haven't been in Maple in the last 15 minutes (QUIET_ACTIVE_MS):
 *     the app open on a phone of theirs (maple_members.last_seen_at, which
 *     the open app's state reads move at most once a minute, and only while
 *     it's on screen), or anything they logged or changed, from any channel
 *     (the app, Siri, the chat, Claude): an entry in Maple's log, a dose or
 *     reading on her page, a bassinet try, a holding turn or their check-in.
 *     Someone awake and using Maple hears everything as usual.
 *
 * What a quiet phone holds (push.ts and notify.ts ask): the nursing timer,
 * unless its person started or changed that feed, and her medicines'
 * reminders (OK again, set times), except on her own phone, which always
 * gets her own. A handoff is never held: it only ever goes to the people
 * it's about (the holder and the next holder, or the person asked). Nor is
 * "Logged": it replaces the reminder (or the last "Logged") on the lock
 * screen, and held, that older notice would read as a dose not taken. A
 * held reminder stays unclaimed, so it goes once the phone isn't quiet (the
 * window's end, which push-wake.ts wakes for) while it's still due, however
 * long the window ran (push.ts counts its 3-hour cutoff from the window's
 * end); a held nursing update is claimed as held, so a retry never sends it
 * later.
 *
 * What it keeps: a small note per phone for each notice it held, in
 * maple_push_sent with the rest of the send log (a reminder's `wait:` row
 * with its window's end, a nursing update's `held` claim), deleted after 3
 * days. The window comes from the roster, and "awake" from rows Maple
 * already keeps.
 */

const MIN = 60_000;

/** Someone in Maple this recently is awake: their phones aren't quiet. */
export const QUIET_ACTIVE_MS = 15 * MIN;

/** The phones that are quiet now: sub id → the protected window they're in. */
export type QuietPhones = Map<number, RosterSpan>;

type QuietSub = { id: number; member: string; prefs: { quiet_window?: boolean } };
type Scope = Pick<FamilyScope, "familyId" | "babyId" | "tz">;

/** The family's phones that are quiet right now (see above). `goals`: the active rosters, when the caller already has them. */
export async function quietPhones(scope: Scope, subs: readonly QuietSub[], now: Date, goals?: RosterGoals): Promise<QuietPhones> {
  const out: QuietPhones = new Map();
  const wanting = subs.filter((s) => s.prefs.quiet_window !== false);
  if (!wanting.length || scope.babyId == null) return out;
  const roster = goals ?? (await activeRosters(scope));
  if (!roster.length) return out;
  const t = now.getTime();
  const inWindow = new Map<string, RosterSpan>();
  for (const member of new Set(wanting.map((s) => s.member))) {
    const w = windowAt(roster, member, t, scope.tz);
    if (w) inWindow.set(member, w);
  }
  if (!inWindow.size) return out;
  const awake = await awakeOf(scope, [...inWindow.keys()], now);
  for (const s of wanting) {
    const w = inWindow.get(s.member);
    if (w && !awake.has(s.member)) out.set(s.id, w);
  }
  return out;
}

/**
 * Of `members`, who is awake by Maple's rows: holding her on the open turn,
 * or in Maple in the 15 minutes before `now` (the app on screen, or anything
 * they logged or changed). One query, all the family's own rows.
 */
async function awakeOf(scope: Scope, members: string[], now: Date): Promise<Set<string>> {
  const since = new Date(now.getTime() - QUIET_ACTIVE_MS).toISOString();
  const rows = await query(
    `SELECT DISTINCT who FROM (
       SELECT holder AS who FROM maple_sleep_shifts WHERE family_id = $1 AND baby_id = $2 AND ended_at IS NULL AND deleted_at IS NULL
       UNION ALL SELECT email FROM maple_members WHERE family_id = $1 AND last_seen_at >= $4::timestamptz
       UNION ALL SELECT created_by FROM maple_entries WHERE family_id = $1 AND baby_id = $2 AND updated_at >= $4::timestamptz AND created_at >= $4::timestamptz
       UNION ALL SELECT updated_by FROM maple_entries WHERE family_id = $1 AND baby_id = $2 AND updated_at >= $4::timestamptz
       UNION ALL SELECT created_by FROM maple_care_entries WHERE family_id = $1 AND created_at >= $4::timestamptz
       UNION ALL SELECT updated_by FROM maple_care_entries WHERE family_id = $1 AND updated_at >= $4::timestamptz
       UNION ALL SELECT created_by FROM maple_sleep_tries WHERE family_id = $1 AND baby_id = $2 AND created_at >= $4::timestamptz
       UNION ALL SELECT updated_by FROM maple_sleep_tries WHERE family_id = $1 AND baby_id = $2 AND updated_at >= $4::timestamptz
       UNION ALL SELECT created_by FROM maple_sleep_shifts WHERE family_id = $1 AND baby_id = $2 AND created_at >= $4::timestamptz
       UNION ALL SELECT updated_by FROM maple_sleep_shifts WHERE family_id = $1 AND baby_id = $2 AND updated_at >= $4::timestamptz
       UNION ALL SELECT member FROM maple_sleep_checkins WHERE family_id = $1 AND baby_id = $2 AND updated_at >= $4::timestamptz
     ) seen WHERE who = ANY($3::text[])`,
    [scope.familyId, scope.babyId, members, since]
  );
  if (rows === null) throw new Error("No database");
  return new Set(rows.map((r) => String((r as { who: unknown }).who)));
}

/** A nursing update this phone holds now: a quiet phone holds it, unless its person started or changed that feed. */
export const holdsNursing = (quiet: QuietPhones, sub: Pick<QuietSub, "id" | "member">, feed: { created_by: string | null; updated_by: string | null }) =>
  quiet.has(sub.id) && sub.member !== feed.created_by && sub.member !== feed.updated_by;

/**
 * A reminder due this soon before a window opens can still be held in it:
 * its wake comes a few seconds after the moment, and a send the push
 * service refused is tried again a minute or so later.
 */
export const HOLD_LEAD_MS = 10 * MIN;

/**
 * The ends of the protected windows that would hold one of her reminders on
 * a quiet phone, for push-wake.ts to wake at: a window (of an adult in
 * `members`, whose phone wants her reminders and keeps quiet on) with a
 * reminder moment inside it, or due up to HOLD_LEAD_MS before it opens, so
 * the held reminder goes out when it ends, however long it ran. Ends in
 * (now, until]. A reminder a tick has already held is woken for from its
 * own note too (push.ts markWaiting).
 */
export async function quietWindowEnds(scope: Scope, members: readonly string[], moments: readonly number[], now: Date, until: number): Promise<number[]> {
  if (!members.length || !moments.length || scope.babyId == null) return [];
  const roster = await activeRosters(scope);
  if (!roster.length) return [];
  const t = now.getTime();
  const ends = new Set<number>();
  for (const member of new Set(members)) {
    for (const w of windowsBetween(roster, member, t, until, scope.tz)) {
      if (w.end <= t || w.end > until) continue;
      if (moments.some((m) => m >= w.start - HOLD_LEAD_MS && m < w.end)) ends.add(w.end);
    }
  }
  return [...ends].sort((a, b) => a - b);
}
