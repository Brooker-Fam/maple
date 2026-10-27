import { query } from "@/lib/db";

/**
 * Sign-up's own table, additive and idempotent like the rest of migrate.ts.
 * An invite code for MAPLE_SIGNUP=invite is kept only as its SHA-256 and makes
 * `max_uses` families (one by default). Not family data: a code belongs to no
 * family until it's spent, and then `families` lists the ones it made.
 */
export async function migrateSignup() {
  await query(`
    CREATE TABLE IF NOT EXISTS maple_signup_codes (
      code_hash CHAR(64) PRIMARY KEY,
      label TEXT,
      max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
      uses INTEGER NOT NULL DEFAULT 0,
      families BIGINT[] NOT NULL DEFAULT '{}',
      expires_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ
    )
  `);
}
