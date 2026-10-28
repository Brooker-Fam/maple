import { query } from "@/lib/db";

/** Additive auth tables. Codes and browser tokens are never kept in clear. */
export async function migrateAuth(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS maple_auth_challenges (
      token_hash CHAR(64) PRIMARY KEY,
      email_key CHAR(64) NOT NULL,
      code_hash CHAR(64) NOT NULL,
      sealed_payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS maple_auth_challenges_email_idx ON maple_auth_challenges (email_key, created_at)`);
  await query(`CREATE INDEX IF NOT EXISTS maple_auth_challenges_expiry_idx ON maple_auth_challenges (expires_at)`);
  await query(`
    CREATE TABLE IF NOT EXISTS maple_oauth_attempts (
      state_hash CHAR(64) PRIMARY KEY,
      browser_hash CHAR(64) NOT NULL,
      sealed_payload TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS maple_oauth_attempts_expiry_idx ON maple_oauth_attempts (expires_at)`);
  await query(`
    CREATE TABLE IF NOT EXISTS maple_auth_identities (
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      member_id TEXT NOT NULL,
      label TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (provider, subject)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS maple_auth_identities_member_idx ON maple_auth_identities (member_id)`);
}
