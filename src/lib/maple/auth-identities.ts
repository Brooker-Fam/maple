import { query, transaction } from "@/lib/db";
import { normalizeEmail } from "@/lib/waitlist";

// Identities are immutable aliases to the existing member key. Family membership,
// roles and removals remain in maple_members, never in this table.
export const IDENTITY_LOCK = 72620262;

export class IdentityConflict extends Error {
  constructor() { super("identity_conflict"); }
}

export async function identityMember(provider: "apple" | "email", subject: string): Promise<string | null> {
  const rows = await query(`SELECT member_id FROM maple_auth_identities WHERE provider = $1 AND subject = $2`, [provider, subject]);
  if (rows === null) throw new Error("identity_unavailable");
  return rows.length ? String(rows[0].member_id) : null;
}

/** Read-only: failed authentication must never reserve or strand an address. */
export async function resolveEmailIdentity(email: string): Promise<string> {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error("invalid_identity");
  return (await identityMember("email", normalized)) ?? normalized;
}

/** A provider identity can never move between members or merge separate logs. */
export async function bindIdentity(provider: "apple" | "email", subject: string, memberId: string, label: string): Promise<void> {
  if (!normalizeEmail(memberId) || !subject || subject.length > 255) throw new IdentityConflict();
  const out = await transaction([
    { sql: `SELECT pg_advisory_xact_lock(${IDENTITY_LOCK})` },
    {
      sql: `INSERT INTO maple_auth_identities (provider, subject, member_id, label)
        SELECT $1, $2, $3, $4
        WHERE ($1 <> 'email' OR $2 = $3 OR (
          NOT EXISTS (SELECT 1 FROM maple_members WHERE email = $2)
          AND NOT EXISTS (SELECT 1 FROM maple_removed WHERE email = $2)
        ))
        ON CONFLICT DO NOTHING`,
      params: [provider, subject, memberId, label],
    },
    { sql: `SELECT member_id FROM maple_auth_identities WHERE provider = $1 AND subject = $2`, params: [provider, subject] },
  ]);
  if (!out) throw new Error("identity_unavailable");
  if (out[2]?.[0]?.member_id !== memberId) throw new IdentityConflict();
}

/** Apple returns a stable subject even when its private relay email changes. */
export async function resolveAppleIdentity(subject: string, email: string | null): Promise<string> {
  const known = await identityMember("apple", subject);
  if (known) return known;
  if (!email) throw new IdentityConflict();
  return resolveEmailIdentity(email);
}

/** Link both Apple's subject and verified relay address in one atomic operation. */
export async function bindAppleIdentity(subject: string, email: string | null, memberId: string): Promise<void> {
  if (!subject || subject.length > 255 || !normalizeEmail(memberId) || (email && !normalizeEmail(email))) throw new IdentityConflict();
  const out = await transaction([
    { sql: `SELECT pg_advisory_xact_lock(${IDENTITY_LOCK})` },
    {
      sql: `WITH checks AS (
        SELECT NOT EXISTS (SELECT 1 FROM maple_auth_identities WHERE provider = 'apple' AND subject = $1 AND member_id <> $3)
          AND ($2::text IS NULL OR (
            NOT EXISTS (SELECT 1 FROM maple_auth_identities WHERE provider = 'email' AND subject = $2 AND member_id <> $3)
            AND ($2 = $3 OR (
              NOT EXISTS (SELECT 1 FROM maple_members WHERE email = $2)
              AND NOT EXISTS (SELECT 1 FROM maple_removed WHERE email = $2)
            ))
          )) AS ok
      ), apple AS (
        INSERT INTO maple_auth_identities (provider, subject, member_id, label)
        SELECT 'apple', $1, $3, COALESCE($2, 'Apple account') FROM checks WHERE ok ON CONFLICT DO NOTHING
      ), email AS (
        INSERT INTO maple_auth_identities (provider, subject, member_id, label)
        SELECT 'email', $2, $3, $2 FROM checks WHERE ok AND $2::text IS NOT NULL ON CONFLICT DO NOTHING
      ) SELECT ok FROM checks`,
      params: [subject, email, memberId],
    },
  ]);
  if (!out) throw new Error("identity_unavailable");
  if (!out[1]?.[0]?.ok) throw new IdentityConflict();
}

export async function linkedIdentities(memberId: string): Promise<{ provider: "apple" | "email"; label: string }[]> {
  const rows = await query(`SELECT provider, label FROM maple_auth_identities WHERE member_id = $1 ORDER BY created_at`, [memberId]);
  if (!rows) throw new Error("identity_unavailable");
  return rows.filter(r => r.provider === "apple" || r.provider === "email").map(r => ({ provider: r.provider as "apple" | "email", label: String(r.label) }));
}
