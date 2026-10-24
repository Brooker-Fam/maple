import { idParam, json, readJson, withCare } from "@/lib/maple/api";
import { deleteCarePlan, reviewCarePlan, saveCarePlan, stopCarePlan } from "@/lib/maple/care-store";
import type { PlanInput } from "@/lib/maple/types";

export const dynamic = "force-dynamic";

const ROUTE = "/api/maple/care/meds";

/**
 * POST — add a medicine to her list (a plan plus client_id). Every number is
 * what the family typed from her label; blanks stay blank. Only me is hers
 * to set, and a mood medicine she adds starts as Only me.
 */
export const POST = withCare(`POST ${ROUTE}`, async (request, _me, s) => {
  const body = await readJson<PlanInput & { client_id?: string }>(request);
  const { id: _id, ...input } = body;
  void _id;
  const saved = await saveCarePlan(s, input as PlanInput, { source: "web" });
  return json({ plan: saved.plan, notes: saved.notes, deduped: saved.deduped, private_default: saved.madePrivate || undefined }, saved.deduped ? 200 : 201);
}, { write: true });

/**
 * PATCH ?id= — change a plan (partial, with expect_updated_at: a newer edit
 * answers 409 "changed" with the latest plan). Also { reviewed: true }
 * ("Matches the label"), { stopped: true | false } (stop, or its Undo) and
 * { deleted: false } (the Undo of a delete).
 */
export const PATCH = withCare(`PATCH ${ROUTE}`, async (request, _me, s) => {
  const id = idParam(request);
  const body = await readJson<Record<string, unknown>>(request);
  if (body.deleted === false) return json({ plan: await deleteCarePlan(s, id, true) });
  if (body.reviewed === true) return json({ plan: await reviewCarePlan(s, id) });
  if (typeof body.stopped === "boolean") return json({ plan: await stopCarePlan(s, id, body.stopped) });
  const { expect_updated_at, reviewed: _r, stopped: _s, deleted: _d, client_id: _c, ...patch } = body;
  void [_r, _s, _d, _c];
  const saved = await saveCarePlan(s, { ...(patch as Partial<PlanInput>), id } as PlanInput, {
    source: "web",
    expectUpdatedAt: typeof expect_updated_at === "string" && !Number.isNaN(Date.parse(expect_updated_at)) ? expect_updated_at : undefined,
  });
  return json({ plan: saved.plan, notes: saved.notes });
}, { write: true });

/** DELETE ?id= — soft delete (a mistake). Doses already logged stay in the history. */
export const DELETE = withCare(`DELETE ${ROUTE}`, async (request, _me, s) => {
  return json({ plan: await deleteCarePlan(s, idParam(request)) });
}, { write: true });
