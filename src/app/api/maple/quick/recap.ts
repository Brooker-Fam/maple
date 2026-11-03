import { query } from "@/lib/db";
import { json } from "@/lib/maple/api";
import { careTime } from "@/lib/maple/care";
import { memberName } from "@/lib/maple/insights";
import { recapWords, sinceHead } from "@/lib/maple/sleep/catchup";
import { recapSpan } from "@/lib/maple/sleep/roster";
import { activeRosters } from "@/lib/maple/sleep/roster-read";
import { listTries, openShift } from "@/lib/maple/sleep/store";
import { listEntries, StoreUnavailable } from "@/lib/maple/store";
import type { Member } from "@/lib/maple/types";
import type { QuickCtx } from "./sleep";

/**
 * "Maple, what did I miss?" (POST /api/maple/quick { action: "recap" }): what
 * was logged while the speaker was away, in at most three sentences
 * (sleep/catchup.ts recapWords): "Since 10 PM: 2 feeds, the last at 1:10 AM
 * on the left; 1 wet diaper; a bassinet try that stayed asleep 1 hour 50
 * minutes." A sleep still running in a car seat, stroller, carrier or
 * grown-up bed adds one more, the take-over catch-up's "Move her to …, on
 * her back, as soon as you can." It counts from the start of the speaker's
 * protected window on the night roster when they're in it or just came out
 * of it (this try day, so last night's until noon: sleep/roster.ts
 * recapSpan), else from their last visit to the app
 * (maple_members.last_seen_at, only read: a recap never moves it, so the
 * app's While you slept still counts from that visit), at most 24 hours back
 * (the last 8 hours with no visit on record).
 *
 * Read only, for anyone who can read the log (viewers too; the route turns
 * photos-only guests away): Maple's log, the bassinet tries and the holding
 * turn, everything in the family's zone. Nothing of her page and no
 * check-ins.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
/** With no visit on record: the last 8 hours, as maple_status's "last_seen" recap does. */
const NO_VISIT_MS = 8 * HOUR;
/** A visit longer ago than this counts from this far back. */
const MAX_BACK_MS = 24 * HOUR;

/** The speaker's last visit to the app in this family, read without moving it (null: none on record). */
async function lastVisit(c: Pick<QuickCtx, "fam" | "me">): Promise<number | null> {
  const rows = await query(`SELECT last_seen_at FROM maple_members WHERE family_id = $1 AND email = $2`, [c.fam.familyId, c.me.email]);
  if (rows === null) throw new StoreUnavailable();
  const at = (rows[0] as { last_seen_at?: unknown } | undefined)?.last_seen_at;
  return at ? new Date(at as string).getTime() : null;
}

export async function recap(c: QuickCtx, members: Member[]): Promise<Response> {
  const t = c.now.getTime();
  const span = recapSpan(await activeRosters(c.fam), c.me.email, c.now, c.tz);
  let since: number;
  let head: string;
  let basis: "protected_window" | "last_window" | "last_visit" | "last_24_hours" | "last_8_hours";
  if (span) {
    since = span.start;
    basis = span.now ? "protected_window" : "last_window";
    head = sinceHead(since, c.now, c.tz);
  } else {
    const seen = await lastVisit(c);
    if (seen !== null && t - seen <= MAX_BACK_MS) {
      since = Math.min(seen, t);
      basis = "last_visit";
      head = sinceHead(since, c.now, c.tz, (at) => careTime(at, c.now, c.tz));
    } else if (seen !== null) {
      since = t - MAX_BACK_MS;
      basis = "last_24_hours";
      head = "In the last 24 hours";
    } else {
      since = t - NO_VISIT_MS;
      basis = "last_8_hours";
      head = "In the last 8 hours";
    }
  }
  // A little before `since` too, so a feed that began then reads as one, and the next side as Today has it.
  const [entries, tries, shift] = await Promise.all([
    listEntries(c.fam, { babyId: c.baby.id, from: new Date(Math.min(since - 2 * HOUR, t - 26 * HOUR)), includeActive: true, limit: 2000 }),
    listTries(c.fam, c.baby.id, { from: new Date(since), limit: 200 }),
    openShift(c.fam, c.baby.id),
  ]);
  const speak = recapWords({ since, head, entries, tries, shift, now: c.now, tz: c.tz, vo: c.vo, me: c.me.email, name: (id) => memberName(id, members) });
  return json({ ok: true, speak, since: new Date(since).toISOString(), basis });
}
