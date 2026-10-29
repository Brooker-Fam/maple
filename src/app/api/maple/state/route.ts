import { photoState } from "@/lib/maple/photo-access";
import { listMembers } from "@/lib/maple/auth";
import { json, withMember } from "@/lib/maple/api";
import { careRev, careSession, careStateFor, viewerFor } from "@/lib/maple/care-store";
import { getBaby, lifetimeCounts, listEntries, rev, toClientEntry, touchLastSeen } from "@/lib/maple/store";
import { familyInfo } from "@/lib/maple/family-info";
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
export const GET = withMember("GET /api/maple/state", async (request, me, ctx) => {
  const now = new Date();
  if (me.role === "photos") {
    const [baby, members] = await Promise.all([getBaby(ctx), listMembers(ctx)]);
    const body = await photoState(ctx, me, baby, members, now);
    if (new URL(request.url).searchParams.get("rev") === body.rev) {
      return json({ unchanged: true, now: body.now, rev: body.rev } satisfies MapleStateUnchanged);
    }
    return json(body);
  }
  // An open app keeps pill reminders on time between the scheduled ticks (push.ts), after answering.
  try {
    after(() => pushTickQuietly(ctx.familyId));
  } catch {
    // outside a request (scripts calling the handler directly)
  }
  const [baby, seenAt, members] = await Promise.all([getBaby(ctx), touchLastSeen(ctx, me.email), listMembers(ctx)]);
  const care = await careSession(viewerFor(me, baby, members), { familyId: ctx.familyId, members, baby });
  const [base, cRev] = await Promise.all([rev(ctx, baby.id), careRev(care)]);
  const current = cRev === null ? base : `${base}|c:${cRev}`;
  if (new URL(request.url).searchParams.get("rev") === current) {
    return json({ unchanged: true, now: now.toISOString(), rev: current } satisfies MapleStateUnchanged);
  }

  const [entries, growth, lifetime, careState] = await Promise.all([
    listEntries(ctx, {
      babyId: baby.id,
      from: new Date(now.getTime() - WINDOW_HOURS * 3600_000),
      includeActive: true,
      limit: 2000,
    }),
    listEntries(ctx, { babyId: baby.id, kinds: ["growth"], ascending: true, limit: 2000 }),
    lifetimeCounts(ctx, baby.id),
    careStateFor(care),
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
    ...(careState ? { care: careState } : {}),
    family: familyInfo(ctx, members),
  };
  return json(body);
}, { photos: true });
