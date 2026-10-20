import { google } from "googleapis";
import { createHash } from "crypto";
import type { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getAppBaseUrl, encryptSecret, decryptSecret } from "@/lib/google";
import { verifyAdminCreds } from "@/lib/mcp/auth";
import type { Member, Role } from "./types";

/**
 * Identity for Maple's Log at /maple. Mirrors the birth plan's pattern:
 * sign in with Google (identity scopes only), and an encrypted cookie holds
 * just who you are. What you can reach comes from maple_members, so nothing
 * secret ever travels in a URL.
 *
 * The cookie lives at path "/" (not /api/maple) because /oauth/authorize reads
 * it too: connecting Claude or ChatGPT to Maple signs in the same way.
 *
 * Fallback: the site admin login (ADMIN_USER/ADMIN_PASS) signs in as the
 * pseudo-member "admin", so the log works before Google is set up.
 *
 * Reuses GOOGLE_CLIENT_ID/SECRET. Add {BASE_URL}/api/maple/auth/callback to the
 * OAuth client's authorized redirect URIs.
 */

export const SESSION_COOKIE = "maple_session";
export const STATE_COOKIE = "maple_oauth_state";
const SESSION_DAYS = 180;
export const ADMIN_ID = "admin";

const DEFAULT_EMOJIS = ["🌲", "🌸", "🦊", "🍄", "🦉", "🐿️", "🦔", "🌻", "🐝", "🍁"];

export function isGoogleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function isPasswordConfigured(): boolean {
  return !!(process.env.ADMIN_USER && process.env.ADMIN_PASS && process.env.GOOGLE_CLIENT_SECRET);
}

function redirectUri(): string {
  return `${getAppBaseUrl()}/api/maple/auth/callback`;
}

function client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri()
  );
}

export function authorizeUrl(state: string): string {
  return client().generateAuthUrl({
    access_type: "online",
    prompt: "select_account",
    // Name for "logged by Brittany"; nothing beyond identity.
    scope: ["openid", "email", "profile"],
    state,
  });
}

export type GoogleIdentity = { email: string; name: string | null };

/** Exchanges the callback code for a verified identity. */
export async function identityFromCode(code: string): Promise<GoogleIdentity | null> {
  const c = client();
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

export function sealSession(id: string): string {
  const body: { id: string; iat: number; pf?: string } = { id, iat: Date.now() };
  if (id === ADMIN_ID) body.pf = adminFingerprint();
  return encryptSecret(JSON.stringify(body));
}

/** The member id in a session cookie (an email, "admin" or "invite:<n>"), or null. */
export function openSession(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const { id, iat, pf } = JSON.parse(decryptSecret(raw));
    if (typeof id !== "string" || !id) return null;
    if (typeof iat !== "number" || Date.now() - iat > SESSION_DAYS * 864e5) return null;
    if (id === ADMIN_ID && pf !== adminFingerprint()) return null;
    return id;
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

export function setSessionCookies(res: NextResponse, id: string): void {
  const value = sealSession(id);
  for (const path of SESSION_PATHS) res.headers.append("Set-Cookie", sessionCookieHeader(value, path, SESSION_MAX_AGE));
  // An old cookie at "/" (early builds) would be sent alongside and could
  // shadow the new one, so expire it.
  res.headers.append("Set-Cookie", sessionCookieHeader("", "/", 0));
}

export function clearSessionCookies(res: NextResponse): void {
  // "/" too: early builds set it there.
  for (const path of [...SESSION_PATHS, "/"]) res.headers.append("Set-Cookie", sessionCookieHeader("", path, 0));
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

function rowToMember(r: Record<string, unknown>): Member {
  return {
    email: String(r.email),
    role: (r.role === "owner" || r.role === "viewer" ? r.role : "member") as Role,
    display_name: r.display_name == null ? null : String(r.display_name),
    emoji: r.emoji == null ? null : String(r.emoji),
    color: r.color == null ? null : String(r.color),
  };
}

export async function memberFor(id: string): Promise<Member | null> {
  const rows = await query(
    `SELECT email, role, display_name, emoji, color FROM maple_members WHERE email = $1`,
    [id]
  );
  if (!rows || !rows.length) return null;
  return rowToMember(rows[0]);
}

export async function listMembers(): Promise<Member[]> {
  const rows = await query(
    `SELECT email, role, display_name, emoji, color FROM maple_members ORDER BY added_at, email`
  );
  return rows ? rows.map(rowToMember) : [];
}

function allowlist(): string[] {
  return (process.env.MAPLE_ALLOWED_EMAILS || process.env.BIRTH_ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function pickEmoji(): Promise<string> {
  const rows = await query(`SELECT emoji FROM maple_members`);
  const used = new Set((rows ?? []).map((r) => String(r.emoji)));
  return DEFAULT_EMOJIS.find((e) => !used.has(e)) ?? "🍁";
}

/**
 * Resolves a Google sign-in to a member, adding them when allowed.
 *
 * Narrow on purpose so a stray Google account can't get in: invited members
 * always can; an allowlisted address (MAPLE_ALLOWED_EMAILS, else the birth
 * plan's BIRTH_ALLOWED_EMAILS) may join; with no allowlist only the very first
 * Google sign-in may claim the log, as its owner.
 */
export async function joinWithGoogle(
  who: GoogleIdentity
): Promise<{ member: Member | null; reason?: "not_invited" | "unavailable" }> {
  const existing = await memberFor(who.email);
  if (existing) {
    if (!existing.display_name && who.name) {
      await query(`UPDATE maple_members SET display_name = $2 WHERE email = $1`, [who.email, who.name]);
      return { member: { ...existing, display_name: who.name } };
    }
    return { member: existing };
  }

  // Someone an owner removed stays out until they're invited again.
  const removed = await query(`SELECT 1 FROM maple_removed WHERE email = $1`, [who.email]);
  if (removed === null) return { member: null, reason: "unavailable" };
  if (removed.length) return { member: null, reason: "not_invited" };

  const people = await query(`SELECT COUNT(*)::int AS n FROM maple_members WHERE email <> $1`, [ADMIN_ID]);
  if (people === null) return { member: null, reason: "unavailable" };
  const noOneYet = Number(people[0]?.n ?? 0) === 0;

  const allowed = allowlist();
  if (allowed.length ? !allowed.includes(who.email) : !noOneYet) {
    return { member: null, reason: "not_invited" };
  }

  const role: Role = noOneYet ? "owner" : "member";
  const inserted = await query(
    `INSERT INTO maple_members (email, role, display_name, emoji, added_by)
     VALUES ($1, $2, $3, $4, 'self')
     ON CONFLICT (email) DO NOTHING`,
    [who.email, role, who.name, await pickEmoji()]
  );
  if (inserted === null) return { member: null, reason: "unavailable" };
  return { member: await memberFor(who.email) };
}

/** True if an owner removed this member (they stay out until invited again). */
export async function isRemoved(id: string): Promise<boolean> {
  const rows = await query(`SELECT 1 FROM maple_removed WHERE email = $1`, [id]);
  return !!rows && rows.length > 0;
}

/**
 * The admin password signs in as an owner pseudo-member named "Admin",
 * unless a real owner removed it (then the password no longer opens Maple).
 */
export async function ensureAdminMember(): Promise<Member | "removed" | null> {
  if (await isRemoved(ADMIN_ID)) return "removed";
  const done = await query(
    `INSERT INTO maple_members (email, role, display_name, emoji, added_by)
     VALUES ($1, 'owner', 'Admin', '🗝️', 'self')
     ON CONFLICT (email) DO NOTHING`,
    [ADMIN_ID]
  );
  if (done === null) return null;
  return memberFor(ADMIN_ID);
}

/** The signed-in member behind a request's cookie, or null. */
export async function sessionMember(request: NextRequest): Promise<Member | null> {
  const id = openSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!id) return null;
  return memberFor(id);
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
