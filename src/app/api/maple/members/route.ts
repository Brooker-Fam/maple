import { membersForReader } from "@/lib/maple/photo-access";
import { clearAnalyticsContext } from "@/lib/analytics/context";
import { BadRequest, familyName, Forbidden, json, readJson, withMember } from "@/lib/maple/api";
import {
  clearSessionCookies,
  leaveFamily,
  listMembers,
  memberFor,
  normalizeMemberId,
  updateMember,
} from "@/lib/maple/auth";
import { parseCareLevel, type AccessRole, type CareLevel } from "@/lib/maple/access";
import { FAMILY_ONE } from "@/lib/maple/family";
import { accessPatch, inviteByEmail, removePerson } from "@/lib/maple/people";
import { publicOrigin } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** `care` in a body: her page's level ("none" / "view" / "log"), null for the role's default, absent to leave it. */
function careOf(body: Record<string, unknown>): CareLevel | null | undefined {
  if (!("care" in body)) return undefined;
  if (body.care === null) return null;
  const care = parseCareLevel(body.care);
  if (!care) throw new BadRequest("care must be none, view, or log");
  return care;
}

export const GET = withMember("GET /api/maple/members", async (_request, _me, ctx) => json({ members: membersForReader(ctx, await listMembers(ctx)) }), { photos: true });

/** POST { email, role?, care? } — owners invite by address (see people.ts: family 1 adds it at once). */
export const POST = withMember("POST /api/maple/members", async (request, me, ctx) => {
  if (me.role !== "owner") throw new Forbidden("Only an owner can invite people");
  const body = await readJson(request);
  const role: AccessRole = body.role === "viewer" || body.role === "photos" ? body.role : "member";
  const out = await inviteByEmail(ctx, me, { email: body.email, role, care: careOf(body), origin: publicOrigin(request) });
  if (out.kind === "invited") return json({ members: await listMembers(ctx), invite: out.invite, url: out.url, emailed: out.emailed }, 201);
  if (out.kind === "member") return json({ members: await listMembers(ctx) });
  return json({ members: membersForReader(ctx, await listMembers(ctx)) });
});

/**
 * PATCH { email?, display_name?, emoji?, color?, role?, care? } — rename
 * yourself or pick an emoji; owners can tidy anyone's, and change someone
 * else's role or their level on her page (people.ts).
 */
export const PATCH = withMember("PATCH /api/maple/members", async (request, me, ctx) => {
  const body = await readJson(request);
  const target = body.email === undefined ? me.email : normalizeMemberId(body.email);
  if (!target) throw new BadRequest("Invalid email");
  if (target !== me.email && me.role !== "owner") throw new Forbidden("You can only edit yourself");
  const current = await memberFor(ctx, target);
  if (!current) throw new BadRequest("Not a member");

  const patch: { display_name?: string | null; emoji?: string | null; color?: string | null; role?: AccessRole; care?: CareLevel | null } = {};
  if ("display_name" in body) patch.display_name = familyName(ctx, body.display_name, 40, "The name");
  if ("emoji" in body) {
    const e = String(body.emoji ?? "").trim();
    if ([...e].length > 4) throw new BadRequest("Pick a single emoji");
    patch.emoji = e || null;
  }
  if ("role" in body || "care" in body) {
    if (me.role !== "owner") throw new Forbidden("Only an owner can change roles");
    if ("role" in body && body.role !== "member" && body.role !== "viewer" && body.role !== "photos") throw new BadRequest("role must be member, viewer, or photos");
    if (target === me.email) throw new BadRequest("You can't change your own role");
    Object.assign(patch, await accessPatch(ctx, me, current, { role: "role" in body ? (body.role as AccessRole) : undefined, care: careOf(body) }));
  }
  if ("color" in body) {
    if (body.color !== null && !HEX_RE.test(String(body.color))) throw new BadRequest("color must be #RRGGBB");
    patch.color = (body.color as string | null) ?? null;
  }
  await updateMember(ctx, target, patch);
  return json({ members: membersForReader(ctx, await listMembers(ctx)) });
}, { photos: true });

/**
 * DELETE ?email= — owners remove someone (never an owner). Your own address
 * leaves the family (not family 1, and never its last owner) and signs you out of it.
 */
export const DELETE = withMember("DELETE /api/maple/members", async (request, me, ctx) => {
  const email = normalizeMemberId(new URL(request.url).searchParams.get("email"));
  if (!email) throw new BadRequest("Invalid email");
  if (email === me.email && ctx.familyId !== FAMILY_ONE) {
    const refused = await leaveFamily(ctx, me.email);
    if (refused === "last_owner") throw new BadRequest("You're the only owner, so you can't leave this log.");
    if (refused) throw new BadRequest("You can't leave this log.");
    const res = json({ left: true });
    clearAnalyticsContext(res);
    clearSessionCookies(res);
    return res;
  }
  if (me.role !== "owner") throw new Forbidden("Only an owner can remove people");
  await removePerson(ctx, me, email);
  return json({ members: membersForReader(ctx, await listMembers(ctx)) });
}, { photos: true });
