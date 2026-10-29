import { createHash } from "crypto";
import { transaction, query } from "@/lib/db";
import { ACCEPTED_MEMBERSHIP, FAMILY_ONE, homeFamilyOf, parseFamilyId } from "../family";
import type { GoogleIdentity } from "../auth";
import { IDENTITY_LOCK } from "../auth-identities";
import { codeHash } from "./codes";
import { FAMILY_BUCKET, SIGNUP_LIMITS, connectionKey, familiesPerDay } from "./limits";

/**
 * What a verified Google sign-in through /signup does to the database:
 * create a family and its owner, or join an existing family by its invite
 * link. Nothing here ever adds anyone to family 1 except through that
 * family's own invite: the old "first Google sign-in claims the log" path
 * lives in auth.ts and /signup never reaches it.
 */

export type CreateRefusal = "code" | "account_limit" | "ip_limit" | "full" | "exists" | "unavailable";
export type Created = { familyId: number; reason?: undefined } | { familyId?: undefined; reason: CreateRefusal };

// Every sign-up waits on this one lock inside its own transaction, so the daily, per-connection and per-code
// limits are counted exactly, never raced past by two sign-ups at once.
const SIGNUP_LOCK = 72_620_261;

const CREATE = `
WITH checks AS (
  SELECT
    (NOT $5::boolean OR EXISTS (
      SELECT 1 FROM maple_signup_codes
      WHERE code_hash = $4 AND uses < max_uses AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
    )) AS code_ok,
    (NOT EXISTS (SELECT 1 FROM maple_members m WHERE m.email = $1 AND ${ACCEPTED_MEMBERSHIP("m")})
      AND NOT EXISTS (SELECT 1 FROM maple_auth_identities WHERE provider = 'email' AND subject = $1 AND member_id <> $1)) AS new_ok,
    (SELECT count(*) FROM maple_families WHERE created_by = $1 AND created_at > NOW() - INTERVAL '1 day') < $9 AS account_ok,
    (SELECT COALESCE(SUM(count), 0) FROM upload_rate_limit WHERE ip_hash = $7 AND window_start > NOW() - INTERVAL '1 day') < $8 AS ip_ok,
    (SELECT count(*) FROM maple_families WHERE id <> ${FAMILY_ONE} AND created_at > NOW() - INTERVAL '1 day') < $6 AS day_ok
), fam AS (
  INSERT INTO maple_families (timezone, status, created_by, settings)
  SELECT $3, 'onboarding', $1, $10::jsonb FROM checks
  WHERE code_ok AND new_ok AND account_ok AND ip_ok AND day_ok
  RETURNING id
), owner AS (
  INSERT INTO maple_members (family_id, email, role, display_name, added_by, accepted_at)
  SELECT id, $1, 'owner', $2, 'signup', NOW() FROM fam
  RETURNING family_id
), spent AS (
  UPDATE maple_signup_codes SET uses = uses + 1, last_used_at = NOW(), families = families || (SELECT id FROM fam)
  WHERE $5::boolean AND code_hash = $4 AND EXISTS (SELECT 1 FROM fam)
  RETURNING code_hash
), counted AS (
  INSERT INTO upload_rate_limit (ip_hash, window_start, count)
  SELECT $7, date_trunc('hour', NOW()), 1 FROM fam
  ON CONFLICT (ip_hash, window_start) DO UPDATE SET count = upload_rate_limit.count + 1
  RETURNING count
)
SELECT (SELECT family_id FROM owner) AS family_id, checks.* FROM checks`;

/**
 * A new family in `status: 'onboarding'` with this person as its owner, or
 * why not. `code` is the normalized invite code (MAPLE_SIGNUP=invite), spent
 * only when the family is made.
 */
export async function createFamily(
  who: GoogleIdentity,
  opts: { code: string | null; tz: string; via: "invite" | "open"; terms: string },
  req: Request
): Promise<Created> {
  const settings = { signup: { via: opts.via, terms: opts.terms, at: new Date().toISOString() } };
  let out;
  try {
    out = await transaction([
      { sql: `SELECT pg_advisory_xact_lock(${IDENTITY_LOCK}), pg_advisory_xact_lock(${SIGNUP_LOCK})` },
      {
        sql: CREATE,
        params: [
          who.email,
          who.name,
          opts.tz,
          opts.code ? codeHash(opts.code) : null,
          opts.via === "invite",
          familiesPerDay(),
          connectionKey(req, FAMILY_BUCKET),
          SIGNUP_LIMITS.familiesPerIpPerDay,
          SIGNUP_LIMITS.familiesPerAccountPerDay,
          settings,
        ],
      },
    ]);
  } catch {
    return { reason: "unavailable" };
  }
  const row = out?.[1]?.[0];
  if (!row) return { reason: "unavailable" };
  const familyId = parseFamilyId(row.family_id);
  if (familyId !== null && familyId !== FAMILY_ONE) return { familyId };
  if (!row.new_ok) return { reason: "exists" };
  if (!row.code_ok) return { reason: "code" };
  if (!row.account_ok) return { reason: "account_limit" };
  if (!row.ip_ok) return { reason: "ip_limit" };
  if (!row.day_ok) return { reason: "full" };
  return { reason: "unavailable" };
}

/** The family an existing member signs in to (homeFamilyOf); null for someone in none, or without a database. */
export async function homeFamily(email: string): Promise<number | null> {
  return (await homeFamilyOf(email)) ?? null;
}

export type JoinRefusal = "invite" | "elsewhere" | "unavailable";
export type Joined = { familyId: number; added?: boolean; reason?: undefined } | { familyId?: undefined; reason: JoinRefusal };

const inviteHash = (token: string) => createHash("sha256").update(token).digest("hex");

const REDEEM = `
WITH inv AS (
  UPDATE maple_invites i SET used_at = NOW(), used_by = $2
  WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > NOW()
    AND NOT EXISTS (SELECT 1 FROM maple_auth_identities WHERE provider = 'email' AND subject = $2 AND member_id <> $2)
    AND (i.email = $2 OR i.email = $4 OR (i.email IS NULL AND NOT EXISTS (SELECT 1 FROM maple_removed r WHERE r.family_id = i.family_id AND r.email = $2)))
    AND EXISTS (SELECT 1 FROM maple_families f WHERE f.id = i.family_id AND f.status <> 'deleting')
    AND NOT EXISTS (SELECT 1 FROM maple_members m WHERE m.family_id = i.family_id AND m.email = $2)
  RETURNING i.family_id, i.role, i.display_name, i.emoji, i.created_by
), lifted AS (
  DELETE FROM maple_removed r USING inv WHERE r.family_id = inv.family_id AND r.email = $2
), added AS (
  INSERT INTO maple_members (family_id, email, role, display_name, emoji, added_by, accepted_at)
  SELECT family_id, $2, CASE WHEN role IN ('viewer', 'photos') THEN role ELSE 'member' END, COALESCE(display_name, $3), emoji, created_by, NOW() FROM inv
  ON CONFLICT (family_id, email) DO NOTHING
  RETURNING family_id
)
SELECT family_id FROM added`;

/**
 * Joins the family an invite link was made in as this Google account (not
 * the link's "invite:<n>" stand-in), so one person can belong to several
 * families and switch between them. Someone already in that family just
 * signs in to it and the link stays unused. An invite made for one address
 * opens only for that address, and lifts a removal there, as inviting
 * someone again always has; a link made for no one in particular never lets
 * in an address the family removed.
 */
export async function joinByInvite(who: GoogleIdentity, token: string, verifiedEmail = who.email): Promise<Joined> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return { reason: "invite" };
  const hash = inviteHash(token);
  try {
    const redeemed = await transaction([
      { sql: `SELECT pg_advisory_xact_lock(${IDENTITY_LOCK})` },
      { sql: REDEEM, params: [hash, who.email, who.name, verifiedEmail] },
    ]);
    const rows = redeemed?.[1];
    if (!rows) return { reason: "unavailable" };
    const familyId = parseFamilyId(rows[0]?.family_id);
    if (familyId !== null) return { familyId, added: true };
    const already = await query(
      `SELECT i.family_id FROM maple_invites i JOIN maple_members m ON m.family_id = i.family_id AND m.email = $2
       JOIN maple_families f ON f.id = i.family_id AND f.status <> 'deleting'
       WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > NOW() AND ${ACCEPTED_MEMBERSHIP("m")}`,
      [hash, who.email]
    );
    const member = parseFamilyId(already?.[0]?.family_id);
    return member !== null ? { familyId: member } : { reason: "invite" };
  } catch (error) {
    // Before the contract step an address can be in only one family (maple_members' old key on email).
    if ((error as { code?: string }).code === "23505") return { reason: "elsewhere" };
    return { reason: "unavailable" };
  }
}
