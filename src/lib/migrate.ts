import { neon } from "@neondatabase/serverless";

async function migrate() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log("No DATABASE_URL set, skipping migration.");
    return;
  }

  const sql = neon(databaseUrl);
  console.log("Running database migrations...");

  // Fixed-hourly-window counter keyed by hashed IP — caps how many upload tokens
  // one source can mint, so a stranger who finds the URL can't burn Blob storage.
  await sql`
    CREATE TABLE IF NOT EXISTS upload_rate_limit (
      ip_hash VARCHAR(64) NOT NULL,
      window_start TIMESTAMP NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ip_hash, window_start)
    )
  `;

  // ========================================
  // MAPLE'S LOG (/maple)
  // Newborn tracker: feeds, diapers, sleep, growth, temps, photos. One row per
  // event in maple_entries (kind + JSONB data, metric units); running timers
  // are rows with active = TRUE. Reached by membership (Google sign-in), and
  // from Claude/ChatGPT through the MCP server at /api/maple/mcp.
  // ========================================

  await sql`
    CREATE TABLE IF NOT EXISTS maple_babies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      nickname TEXT,
      sex TEXT,
      due_date DATE,
      born_at TIMESTAMPTZ,
      birth_weight_g INTEGER,
      birth_length_cm NUMERIC(5,1),
      birth_head_cm NUMERIC(5,1),
      timezone TEXT NOT NULL DEFAULT 'America/New_York',
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    INSERT INTO maple_babies (name, nickname, sex, due_date)
    SELECT 'Maple Jane', 'Maple', 'female', DATE '2026-10-20'
    WHERE NOT EXISTS (SELECT 1 FROM maple_babies)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS maple_members (
      email TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'member',
      display_name TEXT,
      emoji TEXT,
      color TEXT,
      added_by TEXT,
      added_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS maple_entries (
      id BIGSERIAL PRIMARY KEY,
      baby_id INTEGER NOT NULL REFERENCES maple_babies(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT FALSE,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      note TEXT,
      created_by TEXT,
      updated_by TEXT,
      source TEXT NOT NULL DEFAULT 'web',
      -- Client-generated id: retries (flaky hospital Wi-Fi, an assistant
      -- re-sending a tool call) return the first save instead of a duplicate.
      client_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_maple_entries_time ON maple_entries(baby_id, started_at DESC) WHERE deleted_at IS NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_maple_entries_kind ON maple_entries(baby_id, kind, started_at DESC) WHERE deleted_at IS NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_maple_entries_updated ON maple_entries(baby_id, updated_at DESC)`;
  // Columns added while the feature was in development: keep databases built
  // from an earlier draft of these tables in step.
  await sql`ALTER TABLE maple_entries ADD COLUMN IF NOT EXISTS updated_by TEXT`;
  await sql`ALTER TABLE maple_entries ADD COLUMN IF NOT EXISTS client_id TEXT`;
  await sql`ALTER TABLE maple_members ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`;
  await sql`DROP INDEX IF EXISTS idx_maple_entries_active`;

  // One running timer per kind, even when both phones tap Start at once.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_entries_running ON maple_entries(baby_id, kind) WHERE active AND deleted_at IS NULL`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_entries_client ON maple_entries(client_id) WHERE client_id IS NOT NULL`;

  // People an owner removed. Keeps an allowlisted address (MAPLE_ALLOWED_EMAILS)
  // from rejoining by just signing in again; inviting them again clears it.
  await sql`
    CREATE TABLE IF NOT EXISTS maple_removed (
      email TEXT PRIMARY KEY,
      removed_by TEXT,
      removed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // One-time invite links for family who'd rather not use Google (grandparents).
  // Only the SHA-256 of the token is stored.
  await sql`
    CREATE TABLE IF NOT EXISTS maple_invites (
      id SERIAL PRIMARY KEY,
      token_hash CHAR(64) NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'member',
      display_name TEXT,
      emoji TEXT,
      created_by TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      used_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // Personal tokens for hands-free logging (iOS Shortcuts / "Hey Siri, Maple
  // pee"). Hashed; shown to the member once.
  await sql`
    CREATE TABLE IF NOT EXISTS maple_tokens (
      id SERIAL PRIMARY KEY,
      member TEXT NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      label TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    )
  `;

  // FOR MOM: the person who gave birth, her medicines, temperature, questions and
  // check-ins. Separate from maple_entries on purpose: nothing here is about
  // Maple, and every read goes through careAccess() in src/lib/maple/care.ts.
  await sql`
    CREATE TABLE IF NOT EXISTS maple_care_people (
      member TEXT PRIMARY KEY,
      shared_with JSONB NOT NULL DEFAULT '[]'::jsonb,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_care_people_one ON maple_care_people ((TRUE))`;

  // Ids are random 8-digit numbers made by care-store.ts, not a sequence:
  // a gap in a sequence would show other readers that a private row exists.
  await sql`
    CREATE TABLE IF NOT EXISTS maple_care_meds (
      id BIGINT PRIMARY KEY CHECK (id BETWEEN 10000000 AND 99999999),
      person TEXT NOT NULL REFERENCES maple_care_people(member) ON DELETE CASCADE,
      name TEXT NOT NULL,
      also_called TEXT,
      dose_text TEXT,
      units_per_dose TEXT,
      schedule JSONB NOT NULL DEFAULT '{"type":"as_needed"}'::jsonb,
      max_24h NUMERIC,
      limit_unit TEXT CHECK (limit_unit IN ('tablets', 'caplets', 'capsules', 'doses', 'mL')),
      label_text TEXT,
      reason TEXT,
      contains_apap BOOLEAN NOT NULL DEFAULT FALSE,
      instructions TEXT,
      course_start DATE,
      course_end DATE,
      show_on_today BOOLEAN NOT NULL DEFAULT TRUE,
      private BOOLEAN NOT NULL DEFAULT FALSE,
      stopped_at TIMESTAMPTZ,
      reviewed_at TIMESTAMPTZ,
      reviewed_by TEXT,
      sort INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      updated_by TEXT,
      source TEXT NOT NULL DEFAULT 'web',
      client_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted_at TIMESTAMPTZ,
      CHECK (max_24h IS NULL OR limit_unit IS NOT NULL)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_maple_care_meds_person ON maple_care_meds(person, sort, id) WHERE deleted_at IS NULL`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_care_meds_client ON maple_care_meds(client_id) WHERE client_id IS NOT NULL`;

  await sql`
    CREATE TABLE IF NOT EXISTS maple_care_entries (
      id BIGINT PRIMARY KEY CHECK (id BETWEEN 10000000 AND 99999999),
      person TEXT NOT NULL REFERENCES maple_care_people(member) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('dose', 'temp', 'question', 'bp')),
      med_id BIGINT REFERENCES maple_care_meds(id) ON DELETE SET NULL,
      at TIMESTAMPTZ NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      note TEXT,
      private BOOLEAN NOT NULL DEFAULT FALSE,
      created_by TEXT,
      updated_by TEXT,
      source TEXT NOT NULL DEFAULT 'web',
      client_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_maple_care_entries_time ON maple_care_entries(person, at DESC) WHERE deleted_at IS NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_maple_care_entries_med ON maple_care_entries(med_id, at DESC) WHERE deleted_at IS NULL AND kind = 'dose'`;
  // "Only me" is gone (one rule: everyone signed in sees her whole page), so no row stays hidden.
  await sql`UPDATE maple_care_meds SET private = FALSE WHERE private`;
  await sql`UPDATE maple_care_entries SET private = FALSE WHERE private`;
  await sql`CREATE INDEX IF NOT EXISTS idx_maple_care_entries_updated ON maple_care_entries(person, updated_at DESC)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_care_entries_client ON maple_care_entries(client_id) WHERE client_id IS NOT NULL`;

  // Check-ins and fuller check-ins: hers only, never shared, hard-deleted, never in MCP or Siri.
  // Their own table and sequence, so no other reader ever sees their ids.
  await sql`
    CREATE TABLE IF NOT EXISTS maple_care_mood (
      id BIGSERIAL PRIMARY KEY,
      person TEXT NOT NULL REFERENCES maple_care_people(member) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('checkin', 'screen')),
      at TIMESTAMPTZ NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      note TEXT,
      source TEXT NOT NULL DEFAULT 'web',
      client_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_maple_care_mood_time ON maple_care_mood(person, at DESC)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_care_mood_client ON maple_care_mood(client_id) WHERE client_id IS NOT NULL`;

  // Push notifications (pill reminders): one row per phone that turned them on, and a log of what was sent so a
  // reminder goes out once however many ticks see it.
  await sql`
    CREATE TABLE IF NOT EXISTS maple_push_subs (
      id BIGSERIAL PRIMARY KEY,
      member TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
      device TEXT,
      failures INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      last_sent_at TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_maple_push_subs_member ON maple_push_subs(member)`;
  await sql`
    CREATE TABLE IF NOT EXISTS maple_push_sent (
      key TEXT PRIMARY KEY,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Notifications, round two (src/lib/maple/push.ts, push-wake.ts, notify.ts).
  // Per phone: a per-install id (only to tell "the other phone" apart, never a
  // person), the receipt token its worker sends back, delivery and test
  // health, and a flag when the push service says its keys no longer match.
  await sql`ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS device_id TEXT`;
  await sql`ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS receipt_token TEXT`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_push_subs_receipt ON maple_push_subs(receipt_token) WHERE receipt_token IS NOT NULL`;
  // Phones that were on before receipts existed get a token too (32 hex characters, like saveSub's).
  await sql`UPDATE maple_push_subs SET receipt_token = replace(gen_random_uuid()::text, '-', '') WHERE receipt_token IS NULL`;
  await sql`ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS last_delivered_at TIMESTAMPTZ`;
  await sql`ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS last_delivered_key TEXT`;
  await sql`ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS undelivered INT NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS needs_resubscribe BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS test_due_at TIMESTAMPTZ`;
  await sql`ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS test_sent_at TIMESTAMPTZ`;
  await sql`ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS test_via TEXT`;
  await sql`ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS test_key TEXT`;
  // Send-once per phone that survives a failed send: a claim is 'sending', then
  // 'sent' or 'failed' (claimable again, up to 3 attempts). sub_id and ref
  // ("med:<planId>", "nurse:<entryId>") say who got what, for "Logged".
  await sql`ALTER TABLE maple_push_sent ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'sent'`;
  await sql`ALTER TABLE maple_push_sent ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE maple_push_sent ADD COLUMN IF NOT EXISTS sub_id BIGINT`;
  await sql`ALTER TABLE maple_push_sent ADD COLUMN IF NOT EXISTS ref TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS idx_maple_push_sent_ref ON maple_push_sent(ref, sent_at DESC) WHERE ref IS NOT NULL`;
  // Reminders due before this deploy were claimed under the old per-member keys: don't send them again.
  await sql`INSERT INTO maple_push_sent (key, sent_at) VALUES ('floor:v2', NOW()) ON CONFLICT (key) DO NOTHING`;
  // The phone (per-install id) that made a write: her doses and Maple's timers. Nothing in Maple's views reads it.
  await sql`ALTER TABLE maple_care_entries ADD COLUMN IF NOT EXISTS device TEXT`;
  await sql`ALTER TABLE maple_entries ADD COLUMN IF NOT EXISTS device TEXT`;

  console.log("Migrations complete.");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
