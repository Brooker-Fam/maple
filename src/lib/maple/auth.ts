import { OAuth2Client } from "google-auth-library";
import { createHash, randomBytes } from "crypto";
import type { NextRequest, NextResponse } from "next/server";
import { query, transaction } from "@/lib/db";
import { IDENTITY_LOCK } from "./auth-identities";
import { getAppBaseUrl, encryptSecret, openSecret } from "@/lib/secret-box";
import { verifyAdminCreds } from "@/lib/mcp/auth";
import type { Member, Role } from "./types";
import { parseCareLevel, type AccessRole, type CareLevel } from "./access";
import { LEGACY_ORIGIN, MAPLE_ORIGIN } from "./origin";
import { NotFound, StoreUnavailable } from "./store";
import { adminFamilyId, carrierFamily, familyForSession, FAMILY_ONE, homeFamilyOf, parseFamilyId, signupMode, type FamilyCtx, type FamilyScope } from "./family";

/**
 * Identity for Maple's Log at /maple: sign in with Google (identity scopes only), and an encrypted cookie holds
 * just who you are. What you can reach comes from maple_members, so nothing
 * secret ever travels in a URL.
 *
 * The cookie is set on /api/maple and /oauth/authorize (SESSION_PATHS): the
 * consent page reads it too, so connecting Claude or ChatGPT to Maple signs in
 * the same way.
 *
 * Fallback: the site admin login (ADMIN_USER/ADMIN_PASS) signs in as the
 * pseudo-member "admin", so the log works before Google is set up.
 *
 * Uses GOOGLE_CLIENT_ID/SECRET; Google only redirects to URIs registered on
 * that OAuth client, so {origin}/api/maple/auth/callback must be listed there.
 */

export const SESSION_COOKIE = "maple_session";
export const STATE_COOKIE = "maple_oauth_state";
/** Where Google sends people back, so where the state cookie must reach. */
export const STATE_COOKIE_PATH = "/api/maple/auth/callback";
export const MAPLE_STATE_PREFIX = "maple.";
const SESSION_DAYS = 180;
export const ADMIN_ID = "admin";

export function isGoogleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function isPasswordConfigured(): boolean {
  return !!(process.env.ADMIN_USER && process.env.ADMIN_PASS && process.env.GOOGLE_CLIENT_SECRET);
}

/**
 * The origin a sign-in runs on: the one the browser is on when it's this app or the old
 * address that forwards here, else this deployment's own. Google's redirect, the state
 * cookie and the session cookie must all be on the host the browser sees.
 */
export function signInSite(raw: string | null | undefined): string {
  const own = getAppBaseUrl();
  if (!raw) return own;
  const site = raw.replace(/\/+$/, "");
  return site === own || site === MAPLE_ORIGIN || site === LEGACY_ORIGIN ? site : own;
}

function client(site: string) {
  return new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, `${site}${STATE_COOKIE_PATH}`);
}

export function authorizeUrl(state: string, site: string = getAppBaseUrl()): string {
  return client(site).generateAuthUrl({
    access_type: "online",
    prompt: "select_account",
    // Name for "logged by Brittany"; nothing beyond identity.
    scope: ["openid", "email", "profile"],
    state,
  });
}

export type GoogleIdentity = { email: string; name: string | null };

/** Exchanges the callback code for a verified identity. */
export async function identityFromCode(code: string, site: string = getAppBaseUrl()): Promise<GoogleIdentity | null> {
  const c = client(site);
  const { tokens } = await c.getToken(code);
  if (!tokens.id_token) return null;
  const ticket = await c.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.email || payload.email_verified === false) return null;
  const name = (payload.given_name || payload.name || "").trim();
  return { email: payload.email.trim().toLowerCase(), name: name || null };
}

export function checkAdminPassword(user: string, pass: string): boolean {
  return verifyAdminCreds(user, pass);
}

// ── session cookie ────────────────────────────────────────────────────

/**
 * The admin pseudo-member's session is tied to the current ADMIN_PASS, so
 * changing that password signs "admin" out everywhere.
 */
function adminFingerprint(): string {
  return createHash("sha256").update(`maple-admin:${process.env.ADMIN_PASS ?? ""}`).digest("hex").slice(0, 16);
}

export function sealSession(id: string, familyId: number): string {
  const body: { id: string; fam: number; iat: number; pf?: string } = { id, fam: familyId, iat: Date.now() };
  if (id === ADMIN_ID) body.pf = adminFingerprint();
  return encryptSecret(JSON.stringify(body));
}

/** Who a session cookie names (an email, "admin" or "invite:<n>") and its family claim, as sealed. */
export type SessionBody = { id: string; fam?: unknown };

/** A session cookie's body, or null. Its `fam` is checked by familyForSession, never trusted here. */
export function openSession(raw: string | undefined | null): SessionBody | null {
  if (!raw) return null;
  try {
    const opened = openSecret(raw);
    const { id, fam, iat, pf } = JSON.parse(opened.text);
    if (typeof id !== "string" || !id) return null;
    if (opened.prev && carrierFamily(fam) !== FAMILY_ONE) return null;
    if (typeof iat !== "number" || Date.now() - iat > SESSION_DAYS * 864e5) return null;
    if (id === ADMIN_ID && pf !== adminFingerprint()) return null;
    return fam === undefined ? { id } : { id, fam };
  } catch {
    return null;
  }
}

/**
 * The session cookie is scoped to the paths that read it: the app's API and
 * the MCP consent page. Never "/", or the browser would also send it through
 * the /ingest analytics proxy to a third party.
 */
export const SESSION_PATHS = ["/api/maple", "/oauth/authorize"] as const;
const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60;

// The same cookie name on two paths: NextResponse.cookies is keyed by name
// (a second set() would replace the first), so append raw headers. Any
// res.cookies.* call made AFTER these would rewrite Set-Cookie and drop them:
// call setSessionCookies/clearSessionCookies last.
function sessionCookieHeader(value: string, path: string, maxAge: number): string {
  const attrs = [`${SESSION_COOKIE}=${encodeURIComponent(value)}`, `Path=${path}`, `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Lax"];
  if (maxAge === 0) attrs.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

export function setSessionCookies(res: NextResponse, id: string, familyId: number): void {
  const value = sealSession(id, familyId);
  for (const path of SESSION_PATHS) res.headers.append("Set-Cookie", sessionCookieHeader(value, path, SESSION_MAX_AGE));
  // An old cookie at "/" (early builds) would be sent alongside and could
  // shadow the new one, so expire it.
  res.headers.append("Set-Cookie", sessionCookieHeader("", "/", 0));
  clearPendingAppleLink(res);
}

export function clearSessionCookies(res: NextResponse): void {
  // "/" too: early builds set it there.
  for (const path of [...SESSION_PATHS, "/"]) res.headers.append("Set-Cookie", sessionCookieHeader("", path, 0));
  clearPendingAppleLink(res);
}

// Apple's cross-site form_post cannot read the Lax login cookie. Invalidate
// its browser proof whenever this browser signs out, changes account, or
// switches families, so a pending link never attaches after an account change.
function clearPendingAppleLink(res: NextResponse): void {
  res.headers.append("Set-Cookie", "maple_apple_state=; Path=/api/maple/auth/apple/callback; Max-Age=0; HttpOnly; Secure; SameSite=None");
}

/**
 * Where to send someone after sign-in. Only our own app and the OAuth consent
 * page; anything else falls back to /maple (no open redirects).
 */
export function safeReturnPath(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string") return "/maple";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/maple";
  if (raw === "/maple" || raw.startsWith("/maple/") || raw.startsWith("/maple?")) return raw;
  if (raw.startsWith("/oauth/authorize?")) return raw;
  return "/maple";
}

// ── membership ────────────────────────────────────────────────────────

/** The family a call acts in: a FamilyCtx, a job's FamilyScope or just `{ familyId }`. */
export type Fam = Pick<FamilyScope, "familyId">;

/** Fails closed: a missing or malformed family never falls back to family 1. */
export function familyOf(fam: Fam): number {
  const id = parseFamilyId(fam?.familyId);
  if (id === null) throw Object.assign(new Error("family_required"), { code: "family_required" });
  return id;
}

/** The columns every Member read takes (care_access: her page, when set apart from the role's default). */
export const MEMBER_COLS = "email, role, display_name, emoji, color, care_access";

export function rowToMember(r: Record<string, unknown>): Member {
  const care = parseCareLevel(r.care_access);
  return {
    email: String(r.email),
    role: (r.role === "owner" || r.role === "viewer" || r.role === "photos" ? r.role : "member") as Role,
    display_name: r.display_name == null ? null : String(r.display_name),
    emoji: r.emoji == null ? null : String(r.emoji),
    color: r.color == null ? null : String(r.color),
    ...(care ? { care } : {}),
  };
}

export async function memberFor(fam: Fam, id: string): Promise<Member | null> {
  const rows = await query(
    `SELECT ${MEMBER_COLS} FROM maple_members WHERE family_id = $1 AND email = $2`,
    [familyOf(fam), id]
  );
  if (!rows || !rows.length) return null;
  return rowToMember(rows[0]);
}

export async function listMembers(fam: Fam): Promise<Member[]> {
  const rows = await query(
    `SELECT ${MEMBER_COLS} FROM maple_members WHERE family_id = $1 ORDER BY added_at, email`,
    [familyOf(fam)]
  );
  return rows ? rows.map(rowToMember) : [];
}

function allowlist(): string[] {
  return (process.env.MAPLE_ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export type GoogleJoin = { member: Member; familyId: number; reason?: undefined } | { member: null; familyId?: undefined; reason: "not_invited" | "unavailable" };

/**
 * Resolves a Google sign-in to a member and the family it opens, adding them
 * to family 1 when allowed.
 *
 * Someone who already belongs signs in to their home family (homeFamilyOf:
 * the one they used last, never one someone else put them in). Joining by
 * Google alone only ever reaches family 1, and narrowly, so a stray Google
 * account can't get in: an allowlisted address (MAPLE_ALLOWED_EMAILS) may
 * join; with no allowlist only the very first Google sign-in may claim the
 * log, as its owner, and never once sign-up is switched on (a stranger could
 * otherwise claim an empty family 1 from maplebaby.app).
 */
export async function joinWithGoogle(who: GoogleIdentity): Promise<GoogleJoin> {
  const home = await homeFamilyOf(who.email);
  if (home === null) return { member: null, reason: "unavailable" };
  if (home !== undefined) {
    const fam = { familyId: home };
    const existing = await memberFor(fam, who.email);
    if (existing) {
      await query(
        `UPDATE maple_members SET accepted_at = COALESCE(accepted_at, NOW()), display_name = COALESCE(display_name, $3)
         WHERE family_id = $1 AND email = $2 AND (accepted_at IS NULL OR (display_name IS NULL AND $3::text IS NOT NULL))`,
        [fam.familyId, who.email, who.name]
      );
      if (!existing.display_name && who.name) return { member: { ...existing, display_name: who.name }, familyId: fam.familyId };
      return { member: existing, familyId: fam.familyId };
    }
  }

  // Someone an owner removed stays out until they're invited again.
  const removed = await query(`SELECT 1 FROM maple_removed WHERE family_id = $1 AND email = $2`, [FAMILY_ONE, who.email]);
  if (removed === null) return { member: null, reason: "unavailable" };
  if (removed.length) return { member: null, reason: "not_invited" };

  const people = await query(`SELECT COUNT(*)::int AS n FROM maple_members WHERE family_id = $1 AND email <> $2`, [FAMILY_ONE, ADMIN_ID]);
  if (people === null) return { member: null, reason: "unavailable" };
  const noOneYet = Number(people[0]?.n ?? 0) === 0;

  const allowed = allowlist();
  if (allowed.length ? !allowed.includes(who.email) : !noOneYet || signupMode() !== "off") {
    return { member: null, reason: "not_invited" };
  }

  const role: Role = noOneYet ? "owner" : "member";
  // No emoji: avatars show the initial in the member's color until they pick one in Family.
  const inserted = await transaction([
    { sql: `SELECT pg_advisory_xact_lock(${IDENTITY_LOCK})` },
    { sql: `INSERT INTO maple_members (family_id, email, role, display_name, emoji, added_by, accepted_at)
      SELECT $1, $2, $3, $4, NULL, 'self', NOW()
      WHERE NOT EXISTS (SELECT 1 FROM maple_auth_identities WHERE provider = 'email' AND subject = $2 AND member_id <> $2)
      ON CONFLICT (family_id, email) DO NOTHING`, params: [FAMILY_ONE, who.email, role, who.name] },
  ]);
  if (inserted === null) return { member: null, reason: "unavailable" };
  const member = await memberFor({ familyId: FAMILY_ONE }, who.email);
  return member ? { member, familyId: FAMILY_ONE } : { member: null, reason: "unavailable" };
}

/** True if an owner of this family removed this member (they stay out until invited again). */
export async function isRemoved(fam: Fam, id: string): Promise<boolean> {
  const rows = await query(`SELECT 1 FROM maple_removed WHERE family_id = $1 AND email = $2`, [familyOf(fam), id]);
  return !!rows && rows.length > 0;
}

/**
 * The admin password signs in as an owner pseudo-member named "Admin" of its
 * one family (adminFamilyId), unless a real owner there removed it (then the
 * password no longer opens Maple).
 */
export async function ensureAdminMember(): Promise<Member | "removed" | null> {
  const fam = { familyId: adminFamilyId() };
  if (await isRemoved(fam, ADMIN_ID)) return "removed";
  const done = await query(
    `INSERT INTO maple_members (family_id, email, role, display_name, emoji, added_by, accepted_at)
     VALUES ($1, $2, 'owner', 'Admin', '🗝️', 'self', NOW())
     ON CONFLICT (family_id, email) DO NOTHING`,
    [fam.familyId, ADMIN_ID]
  );
  if (done === null) return null;
  return memberFor(fam, ADMIN_ID);
}

export type SignedIn = { member: Member; ctx: FamilyCtx };

/**
 * The member and family a session body or native ticket names, read fresh:
 * null unless they're a member of that family right now. A body without
 * `fam` (from before families) means family 1.
 */
export async function signedInAs(body: SessionBody | null | undefined): Promise<SignedIn | null> {
  if (!body) return null;
  const familyId = carrierFamily(body.fam);
  if (familyId === null) return null;
  const [ctx, member] = await Promise.all([familyForSession(body), memberFor({ familyId }, body.id)]);
  return ctx && member && ctx.familyId === familyId ? { member: { ...member, role: ctx.role }, ctx } : null;
}

/** The signed-in member behind a request's cookie, and their family, or null. */
export function sessionContext(request: NextRequest): Promise<SignedIn | null> {
  return signedInAs(openSession(request.cookies.get(SESSION_COOKIE)?.value));
}

// ── people in a family (Family → People) ──────────────────────────────

/**
 * Adds someone by Google address straight to family 1 (and lifts a removal
 * there), as its owners always have. Every other family invites by address
 * instead (createInvite with `email`), so nobody lands in a family they
 * didn't accept.
 */
export async function addMember(fam: Fam, email: string, addedBy: string, emoji: string | null, role: AccessRole = "member", care: CareLevel | null = null, displayName: string | null = null): Promise<void> {
  const familyId = familyOf(fam);
  if (familyId !== FAMILY_ONE) throw Object.assign(new Error("invite_by_email"), { code: "invite_by_email" });
  const identity = `COALESCE((SELECT member_id FROM maple_auth_identities WHERE provider = 'email' AND subject = $2), $2)`;
  const out = await transaction([
    { sql: `SELECT pg_advisory_xact_lock(${IDENTITY_LOCK})` },
    { sql: `DELETE FROM maple_removed WHERE family_id = $1 AND email = ${identity}`, params: [familyId, email] },
    { sql: `INSERT INTO maple_members (family_id, email, role, emoji, added_by, care_access, display_name) VALUES ($1, ${identity}, $3, $4, $5, $6, $7)
      ON CONFLICT (family_id, email) DO NOTHING`, params: [familyId, email, role, emoji, addedBy, care, displayName] },
  ]);
  if (!out) throw new StoreUnavailable();
}

/**
 * Remove someone from this family: their session, MCP tokens and Siri tokens
 * here stop working at once, and a tombstone keeps an allowlisted address from
 * simply signing back in with Google. Inviting them again (addMember) lifts it.
 */
export async function removeMember(fam: Fam, email: string, by: string): Promise<boolean> {
  const familyId = familyOf(fam);
  // Owners stay, except the "admin" pseudo-owner, which a real owner may remove.
  const rows = await q(
    `DELETE FROM maple_members WHERE family_id = $1 AND email = $2 AND (role <> 'owner' OR email = 'admin') RETURNING email`,
    [familyId, email]
  );
  if (!rows.length) return false;
  await q(`UPDATE maple_tokens SET revoked_at = NOW() WHERE family_id = $1 AND member = $2 AND revoked_at IS NULL`, [familyId, email]);
  await q(
    `INSERT INTO maple_removed (family_id, email, removed_by) VALUES ($1, $2, $3)
     ON CONFLICT (family_id, email) DO UPDATE SET removed_at = NOW(), removed_by = EXCLUDED.removed_by`,
    [familyId, email, by]
  );
  // Nobody removed keeps a place on her share list (careAccess turns them away anyway).
  await q(
    `UPDATE maple_care_people SET shared_with = shared_with - $2::text, updated_at = NOW() WHERE family_id = $1 AND shared_with ? $2::text`,
    [familyId, email]
  );
  return true;
}

export type LeaveRefusal = "family_one" | "last_owner" | "not_member";

/**
 * Leaves a family for good (Family → Leave): the membership, and with it the
 * Siri tokens, phones and chats here, stop at once; entries already logged
 * stay. Nobody is left without an owner, and family 1 keeps its rule that
 * people don't remove themselves. No tombstone: an owner can invite them again.
 */
export async function leaveFamily(fam: Fam, email: string): Promise<LeaveRefusal | null> {
  const familyId = familyOf(fam);
  if (familyId === FAMILY_ONE || email === ADMIN_ID) return "family_one";
  const rows = await q(
    `DELETE FROM maple_members m WHERE m.family_id = $1 AND m.email = $2
       AND (m.role <> 'owner' OR EXISTS (SELECT 1 FROM maple_members o WHERE o.family_id = $1 AND o.role = 'owner' AND o.email <> $2 AND o.email <> 'admin'))
     RETURNING m.email`,
    [familyId, email]
  );
  if (!rows.length) return (await memberFor(fam, email)) ? "last_owner" : "not_member";
  await q(`UPDATE maple_tokens SET revoked_at = NOW() WHERE family_id = $1 AND member = $2 AND revoked_at IS NULL`, [familyId, email]);
  await q(`DELETE FROM maple_push_subs WHERE family_id = $1 AND member = $2`, [familyId, email]);
  await q(`DELETE FROM maple_chat_threads WHERE family_id = $1 AND member = $2`, [familyId, email]);
  await q(
    `UPDATE maple_care_people SET shared_with = shared_with - $2::text, updated_at = NOW() WHERE family_id = $1 AND shared_with ? $2::text`,
    [familyId, email]
  );
  return null;
}

/**
 * `care`: her page for this member, as stored (storedCareLevel: null puts the
 * role's default back); left out, it stays as it is. An owner's role and
 * her page stay as they are.
 */
export async function updateMember(
  fam: Fam,
  email: string,
  patch: Partial<Pick<Member, "display_name" | "emoji" | "color">> & { role?: AccessRole | "owner"; care?: CareLevel | null }
): Promise<void> {
  const familyId = familyOf(fam);
  const rows = await q(`SELECT display_name, emoji, color, role, care_access FROM maple_members WHERE family_id = $1 AND email = $2`, [familyId, email]);
  if (!rows.length) throw new NotFound("Member not found");
  const cur = rows[0];
  const owner = cur.role === "owner";
  const role = patch.role && !owner ? patch.role : cur.role;
  await q(
    `UPDATE maple_members SET display_name = $3, emoji = $4, color = $5, role = $6, care_access = $7, updated_at = NOW() WHERE family_id = $1 AND email = $2`,
    [
      familyId,
      email,
      patch.display_name !== undefined ? patch.display_name : cur.display_name,
      patch.emoji !== undefined ? patch.emoji : cur.emoji,
      patch.color !== undefined ? patch.color : cur.color,
      role,
      patch.care !== undefined && !owner ? patch.care : cur.care_access,
    ]
  );
}

// ── invite links (family without Google) ──────────────────────────────

export type Invite = {
  id: number;
  role: Role;
  /** Her page for whoever takes it up, when the owner set it apart from the role's default (access.ts). */
  care?: CareLevel;
  /** Set on an invite by Google address: only that account can take it up, and only by signing in with it. */
  email: string | null;
  display_name: string | null;
  emoji: string | null;
  created_by: string | null;
  expires_at: string;
  used_at: string | null;
};

const INVITE_DAYS = 7;
const INVITE_COLS = "id, role, email, display_name, emoji, created_by, expires_at, used_at, care_access";
const inviteHash = (token: string) => createHash("sha256").update(token).digest("hex");
const isoOrNull = (v: unknown): string | null => (v == null ? null : new Date(v as string | Date).toISOString());

function rowToInvite(r: Record<string, unknown>): Invite {
  const care = parseCareLevel(r.care_access);
  return {
    id: Number(r.id),
    role: (r.role === "owner" || r.role === "viewer" || r.role === "photos" ? r.role : "member") as Role,
    ...(care ? { care } : {}),
    email: r.email == null ? null : String(r.email),
    display_name: r.display_name == null ? null : String(r.display_name),
    emoji: r.emoji == null ? null : String(r.emoji),
    created_by: r.created_by == null ? null : String(r.created_by),
    expires_at: isoOrNull(r.expires_at)!,
    used_at: isoOrNull(r.used_at),
  };
}

/**
 * A one-time link into the caller's family; only its hash is kept, so the
 * token is shown once. With `email` it's a pending invite for that Google
 * account: it opens only through Google sign-in as that address (joinByInvite),
 * never as a link member, and replaces an open one for the same address.
 */
export async function createInvite(
  fam: Fam,
  opts: { role: Role; displayName: string | null; emoji: string | null; createdBy: string; email?: string | null; care?: CareLevel | null }
): Promise<{ invite: Invite; token: string }> {
  const familyId = familyOf(fam);
  const token = randomBytes(24).toString("base64url");
  if (opts.email) await q(`DELETE FROM maple_invites WHERE family_id = $1 AND email = $2 AND used_at IS NULL`, [familyId, opts.email]);
  const rows = await q(
    `INSERT INTO maple_invites (family_id, token_hash, role, display_name, emoji, created_by, expires_at, email, care_access)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(days => $7), $8, $9)
     RETURNING ${INVITE_COLS}`,
    [familyId, inviteHash(token), opts.role, opts.displayName, opts.emoji, opts.createdBy, INVITE_DAYS, opts.email ?? null, opts.care ?? null]
  );
  return { invite: rowToInvite(rows[0]), token };
}

export async function listInvites(fam: Fam): Promise<Invite[]> {
  const rows = await q(
    `SELECT ${INVITE_COLS} FROM maple_invites
     WHERE family_id = $1 AND used_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC`,
    [familyOf(fam)]
  );
  return rows.map(rowToInvite);
}

/** The family an invite link (used or not) was made in, for its error copy; null when there's no such link. */
export async function inviteFamily(token: unknown): Promise<number | null> {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(token.trim())) return null;
  const rows = await query(`SELECT family_id FROM maple_invites WHERE token_hash = $1`, [inviteHash(token.trim())]);
  return parseFamilyId(rows?.[0]?.family_id);
}

export async function revokeInvite(fam: Fam, id: number): Promise<void> {
  await q(`DELETE FROM maple_invites WHERE id = $1 AND family_id = $2 AND used_at IS NULL`, [id, familyOf(fam)]);
}

/**
 * Redeem a one-time invite: creates the member "invite:<id>", with the name,
 * emoji and role the owner chose, in the family the link was made in. Null if
 * the link is used, expired, or its family is being deleted; "google" for an
 * invite made for one Google address, which only that account can take up.
 */
export async function redeemInvite(token: string): Promise<{ id: string; familyId: number } | "google" | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const rows = await q(
    `UPDATE maple_invites i SET used_at = NOW(), used_by = 'invite:' || i.id
     WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > NOW() AND i.email IS NULL
       AND EXISTS (SELECT 1 FROM maple_families f WHERE f.id = i.family_id AND f.status <> 'deleting')
     RETURNING i.id, i.family_id, i.role, i.display_name, i.emoji, i.created_by, i.care_access`,
    [inviteHash(token)]
  );
  if (!rows.length) {
    const forGoogle = await q(`SELECT 1 FROM maple_invites WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() AND email IS NOT NULL`, [inviteHash(token)]);
    return forGoogle.length ? "google" : null;
  }
  const r = rows[0];
  const familyId = parseFamilyId(r.family_id);
  if (familyId === null) return null;
  const id = `invite:${r.id}`;
  await q(
    `INSERT INTO maple_members (family_id, email, role, display_name, emoji, added_by, accepted_at, care_access) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
     ON CONFLICT (family_id, email) DO NOTHING`,
    [familyId, id, r.role === "viewer" || r.role === "photos" ? r.role : "member", r.display_name, r.emoji, r.created_by, parseCareLevel(r.care_access)]
  );
  return { id, familyId };
}

async function q(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const rows = await query(sql, params);
  if (rows === null) throw new StoreUnavailable();
  return rows as Record<string, unknown>[];
}

/** Member ids are lowercased emails, "admin", or "invite:<n>" for link invites. */
export function normalizeMemberId(raw: unknown): string | null {
  if (raw === ADMIN_ID) return ADMIN_ID;
  if (typeof raw === "string" && /^invite:\d{1,9}$/.test(raw)) return raw;
  return normalizeEmail(raw);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 254 ? e : null;
}
