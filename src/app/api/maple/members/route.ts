import { membersForReader } from "@/lib/maple/photo-access";
import { clearAnalyticsContext } from "@/lib/analytics/context";
import { captureAppEventSoon } from "@/lib/analytics/server";
import { BadRequest, familyName, Forbidden, json, readJson, withMember } from "@/lib/maple/api";
import {
  addMember,
  clearSessionCookies,
  createInvite,
  leaveFamily,
  listInvites,
  listMembers,
  memberFor,
  normalizeEmail,
  normalizeMemberId,
  removeMember,
  updateMember,
} from "@/lib/maple/auth";
import { babyNameFor, emailInvite } from "@/lib/email/notices";
import { FAMILY_ONE } from "@/lib/maple/family";
import { publicOrigin } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";

const MAX_MEMBERS = 12;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export const GET = withMember("GET /api/maple/members", async (_request, _me, ctx) => json({ members: membersForReader(ctx, await listMembers(ctx)) }), { photos: true });

export const POST = withMember("POST /api/maple/members", async (request, me, ctx) => {
  if (me.role !== "owner") throw new Forbidden("Only an owner can invite people");
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  if (!email) throw new BadRequest("Enter a valid email address");
  const role = body.role === "viewer" || body.role === "photos" ? body.role : "member";
  const current = await listMembers(ctx);
  if (current.some((m) => m.email === email)) return json({ members: current });
  if (ctx.familyId !== FAMILY_ONE) {
    const open = (await listInvites(ctx)).filter((i) => i.email !== email);
    if (current.length + open.length >= MAX_MEMBERS) throw new BadRequest("That's a lot of people already!");
    const { invite, token } = await createInvite(ctx, { role, displayName: null, emoji: null, createdBy: me.email, email });
    const actor = { familyId: ctx.familyId, member: me.email, role: me.role };
    captureAppEventSoon(actor, "invite_created");
    const origin = publicOrigin(request);
    // The token rides in the #fragment, which browsers never send to servers or logs.
    const url = `${origin}/signup#join=${token}`;
    const emailed = await emailInvite({
      inviteId: invite.id,
      to: email,
      sender: me.email,
      inviter: me.display_name,
      baby: await babyNameFor(ctx),
      link: url,
      expiresAt: invite.expires_at,
      timeZone: ctx.tz,
      origin,
    });
    if (emailed) captureAppEventSoon(actor, "invite_sent");
    return json({ members: current, invite, url, emailed }, 201);
  }
  if (current.length >= MAX_MEMBERS) throw new BadRequest("That's a lot of people already!");
  // Their initial until they pick an emoji (Family tab), like every other way in.
  await addMember(ctx, email, me.email, null, role);
  return json({ members: membersForReader(ctx, await listMembers(ctx)) });
});

/**
 * PATCH { email?, display_name?, emoji?, color? } — rename yourself or pick an
 * emoji; owners can tidy anyone's.
 */
export const PATCH = withMember("PATCH /api/maple/members", async (request, me, ctx) => {
  const body = await readJson(request);
  const target = body.email === undefined ? me.email : normalizeMemberId(body.email);
  if (!target) throw new BadRequest("Invalid email");
  if (target !== me.email && me.role !== "owner") throw new Forbidden("You can only edit yourself");
  if (!(await memberFor(ctx, target))) throw new BadRequest("Not a member");

  const patch: { display_name?: string | null; emoji?: string | null; color?: string | null; role?: "member" | "viewer" | "photos" } = {};
  if ("display_name" in body) patch.display_name = familyName(ctx, body.display_name, 40, "The name");
  if ("emoji" in body) {
    const e = String(body.emoji ?? "").trim();
    if ([...e].length > 4) throw new BadRequest("Pick a single emoji");
    patch.emoji = e || null;
  }
  if ("role" in body) {
    if (me.role !== "owner") throw new Forbidden("Only an owner can change roles");
    if (body.role !== "member" && body.role !== "viewer" && body.role !== "photos") throw new BadRequest("role must be member, viewer, or photos");
    if (target === me.email) throw new BadRequest("You can't change your own role");
    patch.role = body.role;
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
  if (email === me.email) throw new BadRequest("You can't remove yourself");
  if (!(await removeMember(ctx, email, me.email))) throw new BadRequest("Owners can't be removed");
  return json({ members: membersForReader(ctx, await listMembers(ctx)) });
}, { photos: true });
