import { BadRequest, idParam, json, readJson, withCare } from "@/lib/maple/api";
import {
  careDayRange,
  careDiscardedBy,
  createCareEntry,
  deleteCareEntry,
  listCareEntries,
  updateCareEntry,
  type CareSession,
} from "@/lib/maple/care-store";
import { deviceOf } from "@/lib/maple/device";
import { NotFound } from "@/lib/maple/store";
import { dayKey, daysBetween, isDayKey } from "@/lib/maple/time";
import { isCareKind } from "@/lib/maple/validate";
import type { CareKind } from "@/lib/maple/types";

export const dynamic = "force-dynamic";

const ROUTE = "/api/maple/care/entries";
const MAX_DAYS = 400;

/** An edit or delete of an entry someone deleted meanwhile: 404 with who did it ({ reason: "discarded", deleted_by }). */
async function orGone(s: CareSession, id: number, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof NotFound)) throw err;
    const who = await careDiscardedBy(s, id);
    if (who === undefined) throw err;
    return json({ error: "Not found", reason: "discarded", deleted_by: who }, 404);
  }
}

/**
 * GET ?from=YYYY-MM-DD&to=YYYY-MM-DD&kind=dose,temp — local days in the
 * family's zone, inclusive, newest first; only what this reader may see.
 */
export const GET = withCare(`GET ${ROUTE}`, async (request, _me, s) => {
  const sp = new URL(request.url).searchParams;
  const kinds = sp.get("kind")?.split(",").map((k) => k.trim()).filter(Boolean);
  for (const k of kinds ?? []) if (!isCareKind(k)) throw new BadRequest(`Unknown kind "${k}"`);
  const fromKey = sp.get("from");
  const toKey = sp.get("to") ?? dayKey(s.now, s.tz);
  let range: { from?: Date; to?: Date } = {};
  if (fromKey) {
    if (!isDayKey(fromKey) || !isDayKey(toKey)) throw new BadRequest("from/to must be YYYY-MM-DD");
    const span = daysBetween(fromKey, toKey);
    if (span < 0) throw new BadRequest("from is after to");
    if (span > MAX_DAYS) throw new BadRequest(`At most ${MAX_DAYS} days at a time`);
    range = careDayRange(fromKey, toKey, s.tz);
  }
  const entries = await listCareEntries(s, { ...range, kinds: kinds as CareKind[] | undefined });
  return json({ entries, tz: s.tz });
});

/**
 * POST { kind, at, med_id?, data, note?, private?, client_id, allow_duplicate? }
 * → { created, deduped?, entry, notes, possible_duplicate?, reason?, status? }.
 * A likely duplicate dose comes back created: false (200) until it's sent
 * again with allow_duplicate.
 */
export const POST = withCare(`POST ${ROUTE}`, async (request, _me, s) => {
  const body = await readJson(request);
  if (!isCareKind(body.kind)) throw new BadRequest("Unknown kind");
  // This phone's id (X-Maple-Device): "Logged" goes to the other phones, not this one.
  const result = await createCareEntry(s, body, "web", { device: deviceOf(request) });
  return json(result, result.created ? 201 : 200);
}, { write: true });

/** PATCH ?id= — { at?, data?, note?, private?, expect_updated_at? }. */
export const PATCH = withCare(`PATCH ${ROUTE}`, async (request, _me, s) => {
  const id = idParam(request);
  const body = await readJson(request);
  const expect = body.expect_updated_at;
  if (expect !== undefined && (typeof expect !== "string" || Number.isNaN(Date.parse(expect)))) {
    throw new BadRequest("expect_updated_at must be an ISO timestamp");
  }
  return orGone(s, id, async () =>
    json(
      await updateCareEntry(s, id, {
        at: typeof body.at === "string" ? body.at : undefined,
        data: body.data && typeof body.data === "object" && !Array.isArray(body.data) ? (body.data as Record<string, unknown>) : undefined,
        note: body.note === undefined ? undefined : typeof body.note === "string" ? body.note : null,
        private: typeof body.private === "boolean" ? body.private : undefined,
        expect_updated_at: expect as string | undefined,
      })
    )
  );
}, { write: true });

/** DELETE ?id= — soft delete (Undo restores it). */
export const DELETE = withCare(`DELETE ${ROUTE}`, async (request, _me, s) => {
  const id = idParam(request);
  return orGone(s, id, async () => json({ entry: await deleteCareEntry(s, id) }));
}, { write: true });
