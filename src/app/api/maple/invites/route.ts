import { BadRequest, Forbidden, idParam, json, readJson, withMember } from "@/lib/maple/api";
import { listMembers } from "@/lib/maple/auth";
import { createInvite, listInvites, revokeInvite } from "@/lib/maple/store";
import { publicOrigin } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";

const MAX_MEMBERS = 12;

/**
 * One-time invite links for family who'd rather not sign in with Google
 * (grandparents, a night nurse). Owners only. The link works once, for 7
 * days; only its hash is stored, so the URL is shown exactly once.
 */

export const GET = withMember("GET /api/maple/invites", async (_request, me) => {
  if (me.role !== "owner") throw new Forbidden("Only an owner can see invites");
  return json({ invites: await listInvites() });
});

/** POST { display_name, emoji?, role: "member" | "viewer" } → { invite, url } */
export const POST = withMember("POST /api/maple/invites", async (request, me) => {
  if (me.role !== "owner") throw new Forbidden("Only an owner can invite people");
  const body = await readJson(request);
  const name = String(body.display_name ?? "").trim().slice(0, 40);
  if (!name) throw new BadRequest("Who's it for? Add a name.");
  const emoji = String(body.emoji ?? "").trim();
  if ([...emoji].length > 4) throw new BadRequest("Pick a single emoji");
  if ((await listMembers()).length + (await listInvites()).length >= MAX_MEMBERS) {
    throw new BadRequest("That's a lot of people already!");
  }
  const { invite, token } = await createInvite({
    role: body.role === "viewer" ? "viewer" : "member",
    displayName: name,
    emoji: emoji || null,
    createdBy: me.email,
  });
  // The token rides in the #fragment, which browsers never send to servers or logs.
  return json({ invite, url: `${publicOrigin(request)}/maple/join#${token}` }, 201);
});

export const DELETE = withMember("DELETE /api/maple/invites", async (request, me) => {
  if (me.role !== "owner") throw new Forbidden("Only an owner can revoke invites");
  await revokeInvite(idParam(request));
  return json({ invites: await listInvites() });
});
