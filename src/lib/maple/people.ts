import { captureAppEventSoon } from "@/lib/analytics/server";
import { babyNameFor, emailInvite } from "@/lib/email/notices";
import { careLevelOf, careLevelProblem, storedCareLevel, type AccessRole, type CareLevel } from "./access";
import { BadRequest, familyName, Forbidden } from "./api";
import { addMember, createInvite, listInvites, listMembers, memberFor, normalizeEmail, removeMember, revokeInvite, updateMember, type Invite } from "./auth";
import { getCarePerson } from "./care-store";
import { FAMILY_ONE, type FamilyCtx } from "./family";
import { NotFound } from "./store";
import type { Member } from "./types";

/**
 * Who's in a family and what each person reaches, changed the same way from
 * People settings (the members and invites routes), Maple's chat and the MCP
 * tools (people-mcp.ts). Owners only, in their own family: inviting by
 * email (family 1 adds the address at once, as it always has; anywhere else
 * it's a pending invite only that address can take up), changing someone's
 * role or their level on her page (access.ts), removing someone, and
 * cancelling an invite. Problems throw BadRequest, Forbidden or NotFound
 * with words fit to show the person.
 */

export const MAX_MEMBERS = 12;

type Actor = Pick<Member, "email" | "role" | "display_name">;

function ownerOnly(me: Actor, what: string) {
  if (me.role !== "owner") throw new Forbidden(`Only an owner can ${what}.`);
}

/** The care person's member id, or null when the family has no page for her. */
export async function carePersonOf(ctx: Pick<FamilyCtx, "familyId">): Promise<string | null> {
  return (await getCarePerson(ctx))?.member ?? null;
}

/** Her page's level as stored for this role, or a BadRequest when the role can't have it. */
function careFor(role: AccessRole, care: CareLevel | null | undefined): CareLevel | null | undefined {
  if (care === undefined || care === null) return care;
  const problem = careLevelProblem(role, care);
  if (problem) throw new BadRequest(problem);
  return storedCareLevel(role, care);
}

export type InviteOutcome =
  /** Already in the family: nothing changed. */
  | { kind: "member"; member: Member }
  /** Family 1: the address is a member now and signs in with it (under the account it's connected to, if any). */
  | { kind: "added"; email: string }
  /** Anywhere else: a pending invite only that address can take up, by its link. */
  | { kind: "invited"; invite: Invite; url: string; emailed: boolean };

/**
 * Invites one person by email with a role and, optionally, a level on her
 * page (left out, the role's default). `origin` is the site the link opens
 * on. Sends the invite email where email is set up (emailInvite, under the
 * sender's daily cap); `emailed` says whether it went.
 */
export async function inviteByEmail(
  ctx: FamilyCtx,
  me: Actor,
  opts: { email: unknown; role: AccessRole; care?: CareLevel | null; name?: unknown; origin: string }
): Promise<InviteOutcome> {
  ownerOnly(me, "invite people");
  const email = normalizeEmail(opts.email);
  if (!email) throw new BadRequest("Enter a valid email address");
  const care = careFor(opts.role, opts.care) ?? null;
  const name = opts.name === undefined ? null : familyName(ctx, opts.name, 40, "Their name");
  const current = await listMembers(ctx);
  const already = current.find((m) => m.email === email);
  if (already) return { kind: "member", member: already };
  if (ctx.familyId === FAMILY_ONE) {
    if (current.length >= MAX_MEMBERS) throw new BadRequest("That's a lot of people already!");
    // Their initial until they pick an emoji (Family tab), like every other way in.
    await addMember(ctx, email, me.email, null, opts.role, care, name);
    return { kind: "added", email };
  }
  const open = (await listInvites(ctx)).filter((i) => i.email !== email);
  if (current.length + open.length >= MAX_MEMBERS) throw new BadRequest("That's a lot of people already!");
  const { invite, token } = await createInvite(ctx, { role: opts.role, displayName: name, emoji: null, createdBy: me.email, email, care });
  const actor = { familyId: ctx.familyId, member: me.email, role: me.role };
  captureAppEventSoon(actor, "invite_created");
  // The token rides in the #fragment, which browsers never send to servers or logs.
  const url = `${opts.origin}/signup#join=${token}`;
  const emailed = await emailInvite({
    inviteId: invite.id,
    to: email,
    sender: me.email,
    inviter: me.display_name,
    baby: await babyNameFor(ctx),
    link: url,
    expiresAt: invite.expires_at,
    timeZone: ctx.tz,
    origin: opts.origin,
  });
  if (emailed) captureAppEventSoon(actor, "invite_sent");
  return { kind: "invited", invite, url, emailed };
}

/**
 * The checked patch for changing someone's role and/or their level on her
 * page: owners only, never their own or another owner's (owners always have
 * all of it), and never her page for her own account (it's always hers).
 * `care` null puts the role's default back.
 */
export async function accessPatch(
  ctx: FamilyCtx,
  me: Actor,
  target: Member,
  change: { role?: AccessRole; care?: CareLevel | null }
): Promise<{ role?: AccessRole; care?: CareLevel | null }> {
  if (change.role !== undefined) ownerOnly(me, "change roles");
  if (change.care !== undefined) ownerOnly(me, "change who sees her page");
  if (target.email === me.email) throw new BadRequest("You can't change your own access");
  if (target.role === "owner") throw new BadRequest("Owners always have full access");
  const role = change.role ?? (target.role as AccessRole);
  const patch: { role?: AccessRole; care?: CareLevel | null } = {};
  if (change.role !== undefined) patch.role = change.role;
  if (change.care !== undefined) {
    if (change.care !== null && change.care !== "log" && target.email === (await carePersonOf(ctx))) {
      throw new BadRequest("It's her own page, so she always has it");
    }
    patch.care = careFor(role, change.care) ?? null;
  }
  return patch;
}

/** Changes one member's role and/or level on her page (accessPatch's rules); the member before and after. */
export async function changeAccess(
  ctx: FamilyCtx,
  me: Actor,
  targetId: string,
  change: { role?: AccessRole; care?: CareLevel | null }
): Promise<{ before: Member; after: Member }> {
  const before = await memberFor(ctx, targetId);
  if (!before) throw new BadRequest("Not a member");
  const patch = await accessPatch(ctx, me, before, change);
  await updateMember(ctx, targetId, patch);
  const after = await memberFor(ctx, targetId);
  if (!after) throw new NotFound("Not a member");
  return { before, after };
}

/** Removes someone (never yourself, never an owner but the admin login): removeMember's tombstone, tokens and her share list. */
export async function removePerson(ctx: FamilyCtx, me: Actor, targetId: string): Promise<Member> {
  ownerOnly(me, "remove people");
  if (targetId === me.email) throw new BadRequest("You can't remove yourself");
  const target = await memberFor(ctx, targetId);
  if (!target) throw new BadRequest("Not a member");
  if (!(await removeMember(ctx, targetId, me.email))) throw new BadRequest("Owners can't be removed");
  return target;
}

/** Revokes one unused invite in this family; NotFound when there's no such open invite. */
export async function cancelInvite(ctx: FamilyCtx, me: Actor, inviteId: number): Promise<Invite> {
  ownerOnly(me, "revoke invites");
  const invite = (await listInvites(ctx)).find((i) => i.id === inviteId);
  if (!invite) throw new NotFound("No open invite with that id");
  await revokeInvite(ctx, inviteId);
  return invite;
}

/** Her page as a person reaches it, for the people tools: their own account always has it. */
export function pageLevel(m: Member, carePerson: string | null): CareLevel {
  return carePerson && m.email === carePerson && (m.role === "owner" || m.role === "member") ? "log" : careLevelOf(m);
}
