import { listMembers } from "@/lib/maple/auth";
import { json, withMember } from "@/lib/maple/api";
import { careRev, careSession, careStateFor, eligible, viewerFor } from "@/lib/maple/care-store";
import { getBaby, lifetimeCounts, listEntries, rev, toClientEntry, touchLastSeen } from "@/lib/maple/store";
import { pushTickQuietly } from "@/lib/maple/push";
import type { MapleState, MapleStateUnchanged } from "@/lib/maple/types";
import { after } from "next/server";

export const dynamic = "force-dynamic";

const WINDOW_HOURS = 72;

/**
 * The app's snapshot: baby, people, the last few days of entries, running
 * timers and all growth points, plus mom's area as this reader may see it.
 * Polled every ~10s; `?rev=` short-circuits to { unchanged: true } with a
 * few cheap queries when nothing moved.
 *
 * The rev is per member: `${baseRev}|c:${careRev}`, where careRev covers
 * only the care rows this reader can read. A reader with no access gets the
 * base rev alone, so nothing about her (an Only me dose, a check-in, any
 * write at all for someone she doesn't share with) ever changes their token.
 */
export const GET = withMember("GET /api/maple/state", async (request, me) => {
  const now = new Date();
  // An open app keeps pill reminders on time between the scheduled ticks (push.ts), after answering.
  try {
    after(pushTickQuietly);
  } catch {
    // outside a request (scripts calling the handler directly)
  }
  const [baby, seenAt, members] = await Promise.all([getBaby(), touchLastSeen(me.email), listMembers()]);
  const care = await careSession(viewerFor(me, baby, members), { members, baby });
  const [base, cRev] = await Promise.all([rev(baby.id), careRev(care)]);
  const current = cRev === null ? base : `${base}|c:${cRev}`;
  if (new URL(request.url).searchParams.get("rev") === current) {
    return json({ unchanged: true, now: now.toISOString(), rev: current } satisfies MapleStateUnchanged);
  }

  const [entries, growth, lifetime, careState] = await Promise.all([
    listEntries({
      babyId: baby.id,
      from: new Date(now.getTime() - WINDOW_HOURS * 3600_000),
      includeActive: true,
      limit: 2000,
    }),
    listEntries({ babyId: baby.id, kinds: ["growth"], ascending: true, limit: 2000 }),
    lifetimeCounts(baby.id),
    careStateFor(care),
  ]);

  // Before setup: who may set it up (an owner for anyone, a member for herself) sees the setup rows.
  const caller = members.find((m) => m.email === care.viewer.id);
  const canSetUp = !care.person && eligible(caller);

  const body: MapleState = {
    now: now.toISOString(),
    baby,
    me,
    members,
    entries: entries.map(toClientEntry),
    growth,
    lifetime,
    rev: current,
    seen_at: seenAt,
    ...(careState ? { care: careState } : {}),
    ...(canSetUp ? { care_setup: caller.role === "owner" ? "anyone" : "self" } : {}),
  };
  return json(body);
});
