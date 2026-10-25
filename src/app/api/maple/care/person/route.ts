import { json, readJson, withCare } from "@/lib/maple/api";
import { deleteCarePerson, patchCareSettings } from "@/lib/maple/care-store";

export const dynamic = "force-dynamic";

const ROUTE = "/api/maple/care/person";

// There's no POST: her page always exists (getCarePerson makes it on first read).

/** PATCH { shared_with?, settings? } — her: sharing and every setting; shared writers: the shared settings. */
export const PATCH = withCare(`PATCH ${ROUTE}`, async (request, _me, s) => {
  const body = await readJson(request);
  await patchCareSettings(s, { shared_with: body.shared_with, settings: body.settings });
  return json({ ok: true });
}, { write: true });

/**
 * DELETE { confirm: true } — everything on her page, for good (hard delete,
 * cascades). An empty page takes its place on the next read.
 */
export const DELETE = withCare(`DELETE ${ROUTE}`, async (request, _me, s) => {
  const body = await readJson(request).catch(() => ({}) as Record<string, unknown>);
  if (body.confirm !== true) return json({ error: "Confirm to delete everything here." }, 400);
  await deleteCarePerson(s.person!.member);
  return json({ ok: true });
}, { write: true });
