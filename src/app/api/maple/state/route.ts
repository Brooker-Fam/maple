import { listMembers } from "@/lib/maple/auth";
import { json, withMember } from "@/lib/maple/api";
import { getBaby, lifetimeCounts, listEntries, rev, toClientEntry, touchLastSeen } from "@/lib/maple/store";
import type { MapleState, MapleStateUnchanged } from "@/lib/maple/types";

export const dynamic = "force-dynamic";

const WINDOW_HOURS = 72;

/**
 * The app's snapshot: baby, people, the last few days of entries, running
 * timers and all growth points. Polled every ~10s; `?rev=` short-circuits to
 * { unchanged: true } with one cheap query when nothing moved.
 */
export const GET = withMember("GET /api/maple/state", async (request, me) => {
  const now = new Date();
  const [baby, seenAt] = await Promise.all([getBaby(), touchLastSeen(me.email)]);
  const current = await rev(baby.id);
  if (new URL(request.url).searchParams.get("rev") === current) {
    return json({ unchanged: true, now: now.toISOString(), rev: current } satisfies MapleStateUnchanged);
  }

  const [entries, growth, members, lifetime] = await Promise.all([
    listEntries({
      babyId: baby.id,
      from: new Date(now.getTime() - WINDOW_HOURS * 3600_000),
      includeActive: true,
      limit: 2000,
    }),
    listEntries({ babyId: baby.id, kinds: ["growth"], ascending: true, limit: 2000 }),
    listMembers(),
    lifetimeCounts(baby.id),
  ]);

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
  };
  return json(body);
});
