import { BadRequest, json, readJson, withCare } from "@/lib/maple/api";
import { moveFromMaple, undoMoveFromMaple } from "@/lib/maple/care-store";

export const dynamic = "force-dynamic";

/**
 * POST { entry_id, med_id? } — "Move to {Name}'s medicines": her dose is
 * created (on that plan, or a one-off with the entry's name and dose) and
 * Maple's medicine entry soft-deleted, in one statement.
 * POST { undo: { entry_id, dose_id } } — the toast's Undo: both put back.
 */
export const POST = withCare("POST /api/maple/care/move", async (request, me, s) => {
  // Moving touches Maple's log too: a viewer there can't.
  if (me.role === "viewer") return json({ error: "You have view-only access." }, 403);
  const body = await readJson(request);
  const undo = body.undo as { entry_id?: unknown; dose_id?: unknown } | undefined;
  if (undo) {
    if (typeof undo.entry_id !== "number" || typeof undo.dose_id !== "number") throw new BadRequest("undo needs entry_id and dose_id");
    await undoMoveFromMaple(s, { entryId: undo.entry_id, doseId: undo.dose_id });
    return json({ ok: true });
  }
  if (typeof body.entry_id !== "number" || !Number.isSafeInteger(body.entry_id)) throw new BadRequest("entry_id is required");
  const medId = typeof body.med_id === "number" ? body.med_id : null;
  return json(await moveFromMaple(s, { entryId: body.entry_id, planId: medId }), 201);
}, { write: true });
