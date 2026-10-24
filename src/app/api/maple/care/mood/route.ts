import { idParam, json, readJson, withCare } from "@/lib/maple/api";
import { createMood, deleteMood, listMood, updateMood } from "@/lib/maple/care-store";

export const dynamic = "force-dynamic";

const ROUTE = "/api/maple/care/mood";
const MAX_DAYS = 120;

/**
 * Her check-ins and fuller check-ins. Her own session only: everyone else,
 * her assistants and the admin login included, gets 404. Never shared, never
 * in an export, Siri or the MCP.
 */

/** GET ?days= (default 14, at most 120). */
export const GET = withCare(`GET ${ROUTE}`, async (request, _me, s) => {
  const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get("days")) || 14, 1), MAX_DAYS);
  return json({ entries: await listMood(s, { from: new Date(s.now.getTime() - days * 86400_000) }) });
}, { mood: true });

/** POST { kind: "checkin" | "screen", at?, data, note?, client_id }. A screen's scores are worked out here. */
export const POST = withCare(`POST ${ROUTE}`, async (request, _me, s) => {
  const { entry, deduped } = await createMood(s, await readJson(request));
  return json({ entry, deduped }, deduped ? 200 : 201);
}, { mood: true });

/** PATCH ?id= — { data?, note? } (a check-in's chips and note, a screen's answers). */
export const PATCH = withCare(`PATCH ${ROUTE}`, async (request, _me, s) => {
  const body = await readJson(request);
  const entry = await updateMood(s, idParam(request), {
    data: body.data && typeof body.data === "object" && !Array.isArray(body.data) ? (body.data as Record<string, unknown>) : undefined,
    note: body.note === undefined ? undefined : typeof body.note === "string" ? body.note : null,
  });
  return json({ entry });
}, { mood: true });

/** DELETE ?id= — a hard delete: the row is gone. */
export const DELETE = withCare(`DELETE ${ROUTE}`, async (request, _me, s) => {
  await deleteMood(s, idParam(request));
  return json({ ok: true });
}, { mood: true });
