import { NextRequest } from "next/server";
import { careErrorResponse, json, readJson, sessionCare, withCare } from "@/lib/maple/api";
import { sessionMember } from "@/lib/maple/auth";
import { careRowCount, careTarget, createCarePerson, deleteCarePerson, eligible, patchCareSettings } from "@/lib/maple/care-store";

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
    // The admin login logging as nobody is the family's password, so it sets up like an owner.
    const admin = s.viewer.id === "admin";
    const member = s.members.find((m) => m.email === s.viewer.id);
    const caller = admin ? { email: "admin", role: "owner" } : eligible(member) ? member : null;
    if (!caller) return json({ error: "Only a family member can set this up." }, 403);
    // A member's email, or just her name (she doesn't need her own sign-in).
    const picked = s.members.find((m) => m.email === body.member);
    const t = eligible(picked) ? { id: picked.email } : careTarget(typeof body.name === "string" ? body.name : typeof body.member === "string" ? body.member : "", s.members);
    if (!t) return json({ error: "Type her name." }, 400);
    if ("ambiguous" in t) return json({ error: `That matches more than one person: ${t.ambiguous.join(", ")}.` }, 400);
    const person = await createCarePerson(t.id, caller.email, s.members);
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
