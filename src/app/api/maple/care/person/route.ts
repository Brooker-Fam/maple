import { NextRequest } from "next/server";
import { careErrorResponse, json, readJson, sessionCare, withCare } from "@/lib/maple/api";
import { sessionMember } from "@/lib/maple/auth";
import { careRowCount, createCarePerson, deleteCarePerson, eligible, patchCareSettings } from "@/lib/maple/care-store";

export const dynamic = "force-dynamic";

const ROUTE = "/api/maple/care/person";

/**
 * POST { member } — set up mom's area for one person. She can, for herself,
 * or an owner can on her behalf; the app never guesses who. One per log
 * (409 if there's one already). It starts shared with every other owner.
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const me = await sessionMember(request);
    if (!me) return json({ error: "Not signed in" }, 401);
    const s = await sessionCare(me);
    const body = await readJson(request);
    const caller = s.members.find((m) => m.email === s.viewer.id);
    const target = s.members.find((m) => m.email === body.member);
    if (!eligible(target)) return json({ error: "Choose an owner or member of Maple's Log." }, 400);
    if (!eligible(caller) || (caller.role !== "owner" && caller.email !== target.email)) {
      return json({ error: "Only she, or an owner, can set this up." }, 403);
    }
    const person = await createCarePerson(target.email, caller.email, s.members);
    return json({ person: { member: person.member, created_by: person.created_by } }, 201);
  } catch (error) {
    return careErrorResponse(`POST ${ROUTE}`, error);
  }
}

/** PATCH { shared_with?, settings? } — her: sharing and every setting; shared writers: the shared settings. */
export const PATCH = withCare(`PATCH ${ROUTE}`, async (request, _me, s) => {
  const body = await readJson(request);
  await patchCareSettings(s, { shared_with: body.shared_with, settings: body.settings });
  return json({ ok: true });
}, { write: true });

/**
 * DELETE { confirm: true } — everything here, for good (hard delete,
 * cascades). Her at any time; whoever set it up only while nothing has been
 * saved yet.
 */
export const DELETE = withCare(`DELETE ${ROUTE}`, async (request, _me, s) => {
  const body = await readJson(request).catch(() => ({}) as Record<string, unknown>);
  if (body.confirm !== true) return json({ error: "Confirm to delete everything here." }, 400);
  const p = s.person!;
  const creator = !s.viewer.viaAdmin && p.created_by === s.viewer.id;
  if (!s.access.manage && !(creator && (await careRowCount(p.member)) === 0)) {
    return json({ error: `Only ${s.name} can delete this page now.` }, 403);
  }
  await deleteCarePerson(p.member);
  return json({ ok: true });
});
