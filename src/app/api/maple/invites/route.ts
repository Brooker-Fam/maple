import { BadRequest, familyName, Forbidden, idParam, json, readJson, withMember } from "@/lib/maple/api";
import { careLevelProblem, parseCareLevel, storedCareLevel, type AccessRole } from "@/lib/maple/access";
import { createInvite, listInvites, listMembers, revokeInvite } from "@/lib/maple/auth";
import { MAX_MEMBERS } from "@/lib/maple/people";
import { publicOrigin } from "@/lib/mcp/auth";
import { captureAppEventSoon } from "@/lib/analytics/server";

export const dynamic = "force-dynamic";

/**
 * One-time invite links for family who'd rather not sign in with Google
 * (grandparents, a night nurse). Owners only, into their own family. The link
 * works once, for 7 days; only its hash is stored, so the URL is shown
 * exactly once.
 */

export const GET = withMember("GET /api/maple/invites", async (_request, me, ctx) => {
  if (me.role !== "owner") throw new Forbidden("Only an owner can see invites");
  return json({ invites: await listInvites(ctx) });
});

/** POST { display_name, emoji?, role: "member" | "viewer" | "photos", care? } → { invite, url }. `care`: her page's level for them (access.ts), else the role's default. */
export const POST = withMember("POST /api/maple/invites", async (request, me, ctx) => {
  if (me.role !== "owner") throw new Forbidden("Only an owner can invite people");
  const body = await readJson(request);
  const name = familyName(ctx, body.display_name, 40, "Their name");
  if (!name) throw new BadRequest("Who's it for? Add a name.");
  const emoji = String(body.emoji ?? "").trim();
  if ([...emoji].length > 4) throw new BadRequest("Pick a single emoji");
  const role: AccessRole = body.role === "viewer" || body.role === "photos" ? body.role : "member";
  const care = body.care === undefined || body.care === null ? null : parseCareLevel(body.care);
  if (body.care != null && !care) throw new BadRequest("care must be none, view, or log");
  const problem = care ? careLevelProblem(role, care) : null;
  if (problem) throw new BadRequest(problem);
  if ((await listMembers(ctx)).length + (await listInvites(ctx)).length >= MAX_MEMBERS) {
    throw new BadRequest("That's a lot of people already!");
  }
  const { invite, token } = await createInvite(ctx, {
    role,
    displayName: name,
    emoji: emoji || null,
    createdBy: me.email,
    care: care ? storedCareLevel(role, care) : null,
  });
  captureAppEventSoon({ familyId: ctx.familyId, member: me.email, role: me.role }, "invite_created");
  // The token rides in the #fragment, which browsers never send to servers or logs.
  return json({ invite, url: `${publicOrigin(request)}/maple/join#${token}` }, 201);
});

export const DELETE = withMember("DELETE /api/maple/invites", async (request, me, ctx) => {
  if (me.role !== "owner") throw new Forbidden("Only an owner can revoke invites");
  await revokeInvite(ctx, idParam(request));
  return json({ invites: await listInvites(ctx) });
});
