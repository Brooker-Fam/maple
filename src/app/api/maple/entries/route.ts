import { BadRequest, idParam, json, readJson, withMember } from "@/lib/maple/api";
import { createEntryOnce, getBaby, listDeleted, listEntries, softDeleteEntry, toClientEntry, updateEntry } from "@/lib/maple/store";
import { dayBounds, dayKey, daysBetween, isDayKey } from "@/lib/maple/time";
import { isEntryKind } from "@/lib/maple/validate";
import type { CreateEntryInput, EntryKind, UpdateEntryInput } from "@/lib/maple/types";

export const dynamic = "force-dynamic";

const MAX_DAYS = 400;
/** A little slack for phone clocks running ahead of the server. */
const FUTURE_SLACK_MS = 10 * 60_000;

function instant(value: unknown, label: string): Date {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new BadRequest(`${label} must be an ISO timestamp`);
  }
  const d = new Date(value);
  if (d.getTime() > Date.now() + FUTURE_SLACK_MS) throw new BadRequest(`${label} is in the future`);
  return d;
}

function kindsParam(raw: string | null): EntryKind[] | undefined {
  if (!raw) return undefined;
  const kinds = raw.split(",").map((k) => k.trim()).filter(Boolean);
  for (const k of kinds) if (!isEntryKind(k)) throw new BadRequest(`Unknown kind "${k}"`);
  return kinds as EntryKind[];
}

/**
 * GET /api/maple/entries?from=YYYY-MM-DD&to=YYYY-MM-DD&kind=feed,diaper&limit=
 * Local days in the baby's timezone, inclusive. Without from/to: newest first,
 * all time (moments, exports), capped by `limit`. `?deleted=1` lists what was
 * removed in the last 24 hours ("Recently removed", with updated_by = who).
 */
export const GET = withMember("GET /api/maple/entries", async (request) => {
  const baby = await getBaby();
  const sp = new URL(request.url).searchParams;
  if (sp.get("deleted") === "1") {
    const removed = await listDeleted(baby.id, new Date(Date.now() - 24 * 3600_000));
    return json({ entries: removed.map(toClientEntry), tz: baby.timezone });
  }
  const kinds = kindsParam(sp.get("kind"));
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 2000, 1), 5000);
  const fromKey = sp.get("from");
  const toKey = sp.get("to") ?? dayKey(new Date(), baby.timezone);

  let from: Date | undefined;
  let to: Date | undefined;
  if (fromKey) {
    if (!isDayKey(fromKey) || !isDayKey(toKey)) throw new BadRequest("from/to must be YYYY-MM-DD");
    const span = daysBetween(fromKey, toKey);
    if (span < 0) throw new BadRequest("from is after to");
    if (span > MAX_DAYS) throw new BadRequest(`At most ${MAX_DAYS} days at a time`);
    from = dayBounds(fromKey, baby.timezone)[0];
    to = dayBounds(toKey, baby.timezone)[1];
  }

  const entries = await listEntries({ babyId: baby.id, kinds, from, to, limit });
  // Hitting the limit means there's more (newest first): page with a narrower range.
  return json({ entries: entries.map(toClientEntry), tz: baby.timezone, truncated: entries.length >= limit });
});

/**
 * POST /api/maple/entries — log something. Send a client_id (UUID) and a
 * retried request returns the first save (`deduped: true`) instead of a twin.
 */
export const POST = withMember("POST /api/maple/entries", async (request, me) => {
  const body = await readJson<CreateEntryInput>(request);
  if (!isEntryKind(body.kind)) throw new BadRequest("Unknown kind");
  const baby = await getBaby();
  const startedAt = body.started_at ? instant(body.started_at, "Start time") : new Date();
  const endedAt = body.ended_at ? instant(body.ended_at, "End time") : undefined;
  const { entry, deduped } = await createEntryOnce({
    babyId: baby.id,
    kind: body.kind,
    startedAt,
    endedAt,
    data: body.data ?? {},
    note: typeof body.note === "string" ? body.note : null,
    createdBy: me.email,
    source: "web",
    clientId: body.client_id,
  });
  return json({ entry: toClientEntry(entry), deduped }, deduped ? 200 : 201);
}, { write: true });

/** PATCH /api/maple/entries?id= — edit time, details, or note. */
export const PATCH = withMember("PATCH /api/maple/entries", async (request, me) => {
  const id = idParam(request);
  const body = await readJson<UpdateEntryInput>(request);
  const entry = await updateEntry(id, {
    startedAt: body.started_at ? instant(body.started_at, "Start time") : undefined,
    endedAt: body.ended_at === null ? null : body.ended_at ? instant(body.ended_at, "End time") : undefined,
    data: body.data && typeof body.data === "object" ? body.data : undefined,
    note: body.note === undefined ? undefined : typeof body.note === "string" ? body.note : null,
  }, me.email);
  return json({ entry: toClientEntry(entry) });
}, { write: true });

/** DELETE /api/maple/entries?id= — soft delete (restorable for undo). */
export const DELETE = withMember("DELETE /api/maple/entries", async (request, me) => {
  const entry = await softDeleteEntry(idParam(request), me.email);
  return json({ entry: toClientEntry(entry) });
}, { write: true });
