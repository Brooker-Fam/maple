import { BadRequest, Forbidden, json, readJson, withMember } from "@/lib/maple/api";
import { listMembers, memberFor, normalizeEmail, normalizeMemberId } from "@/lib/maple/auth";
import { addMember, removeMember, updateMember } from "@/lib/maple/store";

export const dynamic = "force-dynamic";

const MAX_MEMBERS = 12;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export const GET = withMember("GET /api/maple/members", async () => json({ members: await listMembers() }));

/**
 * POST { email, role? } — owners invite family by Google address. (For people
 * without Google, see /api/maple/invites for one-time links.)
 */
export const POST = withMember("POST /api/maple/members", async (request, me) => {
  if (me.role !== "owner") throw new Forbidden("Only an owner can invite people");
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  if (!email) throw new BadRequest("Enter a valid email address");
  const current = await listMembers();
  if (current.some((m) => m.email === email)) return json({ members: current });
  if (current.length >= MAX_MEMBERS) throw new BadRequest("That's a lot of people already!");
  // Their initial until they pick an emoji (Family tab), like every other way in.
  await addMember(email, me.email, null, body.role === "viewer" ? "viewer" : "member");
  return json({ members: await listMembers() });
});

/**
 * PATCH { email?, display_name?, emoji?, color? } — rename yourself or pick an
 * emoji; owners can tidy anyone's.
 */
export const PATCH = withMember("PATCH /api/maple/members", async (request, me) => {
  const body = await readJson(request);
  const target = body.email === undefined ? me.email : normalizeMemberId(body.email);
  if (!target) throw new BadRequest("Invalid email");
  if (target !== me.email && me.role !== "owner") throw new Forbidden("You can only edit yourself");
  if (!(await memberFor(target))) throw new BadRequest("Not a member");

  const patch: { display_name?: string | null; emoji?: string | null; color?: string | null; role?: "member" | "viewer" } = {};
  if ("display_name" in body) {
    const n = String(body.display_name ?? "").trim();
    patch.display_name = n ? n.slice(0, 40) : null;
  }
  if ("emoji" in body) {
    const e = String(body.emoji ?? "").trim();
    if ([...e].length > 4) throw new BadRequest("Pick a single emoji");
    patch.emoji = e || null;
  }
  if ("role" in body) {
    if (me.role !== "owner") throw new Forbidden("Only an owner can change roles");
    if (body.role !== "member" && body.role !== "viewer") throw new BadRequest("role must be member or viewer");
    if (target === me.email) throw new BadRequest("You can't change your own role");
    patch.role = body.role;
  }
  if ("color" in body) {
    if (body.color !== null && !HEX_RE.test(String(body.color))) throw new BadRequest("color must be #RRGGBB");
    patch.color = (body.color as string | null) ?? null;
  }
  await updateMember(target, patch);
  return json({ members: await listMembers() });
});

/** DELETE ?email= — owners remove someone (never an owner, never themselves). */
export const DELETE = withMember("DELETE /api/maple/members", async (request, me) => {
  if (me.role !== "owner") throw new Forbidden("Only an owner can remove people");
  const email = normalizeMemberId(new URL(request.url).searchParams.get("email"));
  if (!email) throw new BadRequest("Invalid email");
  if (email === me.email) throw new BadRequest("You can't remove yourself");
  if (!(await removeMember(email, me.email))) throw new BadRequest("Owners can't be removed");
  return json({ members: await listMembers() });
});
