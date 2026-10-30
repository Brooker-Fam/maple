import { pathToFileURL } from "node:url";
import { query, transaction } from "./db";
import { FAMILY_OPTIONAL_TABLES, FAMILY_TABLES } from "./maple/family-tables";
import { migrateSignup } from "./maple/family/schema";
import { migrateAuth } from "./maple/auth-schema";
import { migrateAnalytics } from "./analytics/schema";
import { migrateChatDelivery } from "./maple/chat/delivery-schema";
import { migrateEpic } from "./maple/epic/schema";

async function sql(strings: TemplateStringsArray, ...values: unknown[]) {
  const text = strings.reduce((out, part, i) => `${out}$${i}${part}`);
  return (await query(text, values)) ?? [];
}

export async function migrate() {
  if (!process.env.DATABASE_URL) {
    console.log("No DATABASE_URL set, skipping migration.");
    return;
  }

  console.log("Running database migrations...");
  const contracted = !!(await familyPrimaryKey("maple_care_people", ["family_id"]));

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
  if (!contracted) await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_entries_client ON maple_entries(client_id) WHERE client_id IS NOT NULL`;

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
  if (!contracted) await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_care_people_one ON maple_care_people ((TRUE))`;

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
  if (!contracted) await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_care_meds_client ON maple_care_meds(client_id) WHERE client_id IS NOT NULL`;

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
  await expandCareKinds();
  await sql`CREATE INDEX IF NOT EXISTS idx_maple_care_entries_med ON maple_care_entries(med_id, at DESC) WHERE deleted_at IS NULL AND kind = 'dose'`;
  // "Only me" is gone (one rule: everyone signed in sees her whole page), so no row stays hidden.
  await sql`UPDATE maple_care_meds SET private = FALSE WHERE private`;
  await sql`UPDATE maple_care_entries SET private = FALSE WHERE private`;
  await sql`CREATE INDEX IF NOT EXISTS idx_maple_care_entries_updated ON maple_care_entries(person, updated_at DESC)`;
  if (!contracted) await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_care_entries_client ON maple_care_entries(client_id) WHERE client_id IS NOT NULL`;

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
  if (!contracted) await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_care_mood_client ON maple_care_mood(client_id) WHERE client_id IS NOT NULL`;

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

  // The in-app chat (src/lib/maple/chat/). A thread is one member's and nobody
  // else's; deleting it deletes its messages. Messages are the AI SDK's
  // UIMessage parts as sent, never trimmed. Two rewrites: an approval's
  // continuation replaces its own assistant message, and a new message sent
  // instead of a tap stores that pending request as a no. Usage rows carry
  // token counts and integer micro-dollar cost only, no content, and outlive
  // their thread, as does the daily message count.
  await sql`
    CREATE TABLE IF NOT EXISTS maple_chat_threads (
      id TEXT PRIMARY KEY,
      member TEXT NOT NULL,
      title TEXT,
      model TEXT NOT NULL,
      busy_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_maple_chat_threads_member ON maple_chat_threads(member, updated_at DESC)`;
  // Every turn in it ran as a viewer. A viewer opens only these, so someone made a viewer can't reread her data from older chats.
  await sql`ALTER TABLE maple_chat_threads ADD COLUMN IF NOT EXISTS viewer_only BOOLEAN NOT NULL DEFAULT FALSE`;
  // Some turn in it ran with her page open to the chat (chat_care), so its history can carry her data; older threads all did.
  // While her page is closed, these never go back to the model.
  await sql`ALTER TABLE maple_chat_threads ADD COLUMN IF NOT EXISTS care_open BOOLEAN NOT NULL DEFAULT TRUE`;
  await sql`
    CREATE TABLE IF NOT EXISTS maple_chat_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES maple_chat_threads(id) ON DELETE CASCADE,
      member TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      parts JSONB NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (thread_id, seq)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_maple_chat_messages_daily ON maple_chat_messages(member, created_at DESC) WHERE role = 'user'`;
  await sql`
    CREATE TABLE IF NOT EXISTS maple_ai_usage (
      id BIGSERIAL PRIMARY KEY,
      member TEXT NOT NULL,
      thread_id TEXT,
      message_id TEXT,
      step INTEGER NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cost_micro_usd BIGINT NOT NULL,
      price_key TEXT NOT NULL,
      finish_reason TEXT,
      generation_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_maple_ai_usage_time ON maple_ai_usage(created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_maple_ai_usage_thread ON maple_ai_usage(thread_id, id DESC)`;
  await sql`
    CREATE TABLE IF NOT EXISTS maple_chat_daily (
      member TEXT NOT NULL,
      day DATE NOT NULL,
      messages INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (member, day)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS maple_consents (
      member TEXT NOT NULL,
      kind TEXT NOT NULL,
      version INTEGER NOT NULL,
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (member, kind)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS maple_waitlist (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      baby_month DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS maple_waitlist (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      baby_month DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  // A due month can say someone is pregnant, so the waitlist keeps none.
  await sql`UPDATE maple_waitlist SET baby_month = NULL WHERE baby_month IS NOT NULL`;

  // Operator-triggered waitlist invitations. A durable claim prevents a later
  // retry from duplicating a send after a timeout or uncertain provider result.
  await sql`
    CREATE TABLE IF NOT EXISTS maple_waitlist_outreach (
      waitlist_id BIGINT NOT NULL REFERENCES maple_waitlist(id) ON DELETE CASCADE,
      campaign TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'uncertain')),
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      provider_id TEXT,
      PRIMARY KEY (waitlist_id, campaign)
    )
  `;

  await migrateFamilies();
  await migrateSignup();
  await migrateAuth();
  await migrateAnalytics();
  await migrateChatDelivery();
  await migrateChatImages();
  await migrateEpic();

  console.log("Migrations complete.");
}

async function migrateChatImages(): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS maple_chat_images (
    id TEXT PRIMARY KEY,
    family_id BIGINT NOT NULL REFERENCES maple_families(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    viewer_only BOOLEAN NOT NULL,
    data_base64 TEXT NOT NULL CHECK (length(data_base64) <= 699052),
    byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 524288),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reserved_until TIMESTAMPTZ,
    CHECK (octet_length(decode(data_base64, 'base64')) = byte_length)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_maple_chat_images_member ON maple_chat_images (family_id, member, created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_maple_chat_images_expiry ON maple_chat_images (created_at)`;
  await sql`CREATE TABLE IF NOT EXISTS maple_chat_image_uploads (
    family_id BIGINT NOT NULL REFERENCES maple_families(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    day DATE NOT NULL,
    uploads INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (family_id, member, day)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS maple_chat_image_generations (
    family_id BIGINT NOT NULL REFERENCES maple_families(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    generation BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (family_id, member)
  )`;
}

// ========================================
// FAMILIES (docs/multi-family-plan.md, Phase 1: expand only)
// Every family-owned maple_* row gets a family_id. The Brooker family is
// family 1, and DEFAULT 1 files a row from code that doesn't pass one yet
// (brooker-wedding's copy of Maple writes these tables too) under them. New
// unique keys sit beside the old ones, which brooker-wedding's ON CONFLICT
// targets still name. Nothing here drops, renames, retypes or tightens: that
// is the separate contract step, never run from a build.
// ========================================

export async function migrateFamilies() {
  await sql`
    CREATE TABLE IF NOT EXISTS maple_families (
      id BIGSERIAL PRIMARY KEY,
      name TEXT,
      timezone TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT 'US',
      units TEXT NOT NULL DEFAULT 'us' CHECK (units IN ('us', 'metric')),
      status TEXT NOT NULL DEFAULT 'onboarding' CHECK (status IN ('onboarding', 'active', 'deleting')),
      plan TEXT NOT NULL DEFAULT 'beta' CHECK (plan IN ('beta', 'free', 'plus')),
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      onboarding JSONB NOT NULL DEFAULT '{}'::jsonb,
      ai_daily_micro BIGINT,
      ai_monthly_micro BIGINT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delete_requested_at TIMESTAMPTZ
    )
  `;
  await sql`
    INSERT INTO maple_families (id, timezone, status)
    SELECT 1, COALESCE((SELECT timezone FROM maple_babies ORDER BY id LIMIT 1), 'America/New_York'), 'active'
    ON CONFLICT (id) DO NOTHING
  `;
  // Only while the sequence is unused: setting it from MAX(id) later would hand a deleted family's id to a new one.
  await sql`SELECT setval('maple_families_id_seq', GREATEST(1, (SELECT MAX(id) FROM maple_families)), true) FROM maple_families_id_seq WHERE NOT is_called`;

  for (const table of FAMILY_TABLES) {
    await addColumn(table, "family_id", "BIGINT DEFAULT 1");
    await familyKey(table, "");
  }
  for (const table of FAMILY_OPTIONAL_TABLES) {
    await addColumn(table, "family_id", "BIGINT");
  }
  await familyKey("maple_push_sent", "ON DELETE CASCADE");
  await familyKey("maple_ai_usage", "ON DELETE SET NULL");

  for (const table of FAMILY_TABLES) {
    await query(`UPDATE ${table} SET family_id = 1 WHERE family_id IS NULL`);
  }
  // While the Brookers are the only family, every cost row and missed-reminder record is theirs.
  await sql`UPDATE maple_ai_usage SET family_id = 1 WHERE family_id IS NULL AND NOT EXISTS (SELECT 1 FROM maple_families WHERE id <> 1)`;
  await sql`
    UPDATE maple_push_sent SET family_id = 1
    WHERE family_id IS NULL AND (key LIKE 'miss:%' OR key LIKE 'gap:%') AND NOT EXISTS (SELECT 1 FROM maple_families WHERE id <> 1)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS maple_upload_counts (
      family_id BIGINT NOT NULL REFERENCES maple_families(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (family_id, day)
    )
  `;

  await addColumn("maple_babies", "archived_at", "TIMESTAMPTZ");
  await addColumn("maple_members", "role_word", "TEXT");
  await addColumn("maple_members", "accepted_at", "TIMESTAMPTZ");
  await addColumn("maple_invites", "email", "TEXT");
  // How far someone reaches into her page, when an owner set it apart from their role's default
  // (src/lib/maple/access.ts): 'none', 'view' or 'log'; NULL is the role's default. Code from before
  // it reads every owner and member as reaching all of her page, so clear these before rolling back past it.
  await addColumn("maple_members", "care_access", "TEXT");
  await addColumn("maple_invites", "care_access", "TEXT");

  // With every row in family 1 these hold exactly when the old keys do, so they build cleanly beside them.
  await index("uniq_maple_babies_family_id", "maple_babies (family_id, id)", true);
  await familyUniqueIndex("maple_members", ["family_id", "email"], "uniq_maple_members_family_email");
  await familyUniqueIndex("maple_removed", ["family_id", "email"], "uniq_maple_removed_family_email");
  await index("uniq_maple_entries_family_client", "maple_entries (family_id, client_id) WHERE client_id IS NOT NULL", true);
  await familyUniqueIndex("maple_care_people", ["family_id"], "uniq_maple_care_people_family");
  await index("uniq_maple_care_meds_family_client", "maple_care_meds (family_id, client_id) WHERE client_id IS NOT NULL", true);
  await index("uniq_maple_care_entries_family_client", "maple_care_entries (family_id, client_id) WHERE client_id IS NOT NULL", true);
  await index("uniq_maple_care_mood_family_client", "maple_care_mood (family_id, client_id) WHERE client_id IS NOT NULL", true);
  await index("uniq_maple_push_subs_family_endpoint", "maple_push_subs (family_id, endpoint)", true);
  await familyUniqueIndex("maple_chat_daily", ["family_id", "member", "day"], "uniq_maple_chat_daily_family");
  await familyUniqueIndex("maple_consents", ["family_id", "member", "kind"], "uniq_maple_consents_family");

  await index("idx_maple_entries_family_time", "maple_entries (family_id, baby_id, started_at DESC) WHERE deleted_at IS NULL");
  await index("idx_maple_entries_family_kind", "maple_entries (family_id, baby_id, kind, started_at DESC) WHERE deleted_at IS NULL");
  await index("idx_maple_entries_family_updated", "maple_entries (family_id, baby_id, updated_at DESC)");
  await index("idx_maple_invites_family", "maple_invites (family_id, created_at DESC)");
  await index("idx_maple_tokens_family", "maple_tokens (family_id, member)");
  await index("idx_maple_care_meds_family", "maple_care_meds (family_id, sort, id) WHERE deleted_at IS NULL");
  await index("idx_maple_care_entries_family_time", "maple_care_entries (family_id, at DESC) WHERE deleted_at IS NULL");
  await index("idx_maple_care_entries_family_updated", "maple_care_entries (family_id, updated_at DESC)");
  await index("idx_maple_care_mood_family_time", "maple_care_mood (family_id, at DESC)");
  await index("idx_maple_push_subs_family", "maple_push_subs (family_id, member)");
  await index("idx_maple_push_sent_family", "maple_push_sent (family_id, sent_at DESC) WHERE family_id IS NOT NULL");
  await index("idx_maple_chat_threads_family", "maple_chat_threads (family_id, member, updated_at DESC)");
  await index("idx_maple_chat_messages_family_daily", "maple_chat_messages (family_id, member, created_at DESC) WHERE role = 'user'");
  await index("idx_maple_ai_usage_family_time", "maple_ai_usage (family_id, created_at DESC)");
}

async function familyPrimaryKey(table: string, columns: string[]): Promise<string | null> {
  const rows = await sql`SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid = to_regclass(${table}) AND c.contype = 'p'
      AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.ord) = ${columns}::text[]`;
  return rows.length ? String(rows[0].conname) : null;
}

async function expandCareKinds() {
  const name = "maple_care_entries_kind_v2_check";
  const rows = await sql`SELECT convalidated FROM pg_constraint WHERE conname = ${name} AND conrelid = 'maple_care_entries'::regclass`;
  if (!rows.length) {
    try {
      await alter(`ALTER TABLE maple_care_entries ADD CONSTRAINT ${name} CHECK (kind IN ('dose', 'temp', 'question', 'bp', 'food', 'drink')) NOT VALID`);
    } catch (err) {
      if (codeOf(err) !== "42710") throw err;
    }
  }
  if (!rows[0]?.convalidated) await alter(`ALTER TABLE maple_care_entries VALIDATE CONSTRAINT ${name}`);
  const old = await sql`SELECT 1 FROM pg_constraint WHERE conname = 'maple_care_entries_kind_check' AND conrelid = 'maple_care_entries'::regclass`;
  if (old.length) await alter("ALTER TABLE maple_care_entries DROP CONSTRAINT IF EXISTS maple_care_entries_kind_check");
}

async function familyUniqueIndex(table: string, columns: string[], name: string) {
  const primary = await familyPrimaryKey(table, columns);
  await index(primary ?? name, `${table} (${columns.join(", ")})`, true);
}

/** ALTER TABLE only when the column is missing: even a no-op ADD COLUMN IF NOT EXISTS takes the table's lock. */
async function addColumn(table: string, column: string, type: string) {
  const rows = await sql`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${table} AND column_name = ${column}`;
  if (!rows.length) await alter(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
}

const codeOf = (err: unknown) => String((err as { code?: unknown })?.code ?? "");

/** The family foreign key, added NOT VALID and then validated, so no write waits on the check of existing rows. */
async function familyKey(table: string, onDelete: string) {
  const name = `fk_${table}_family`;
  const rows = await sql`SELECT convalidated FROM pg_constraint WHERE conname = ${name} AND conrelid = to_regclass(${table})`;
  if (!rows.length) {
    try {
      await alter(`ALTER TABLE ${table} ADD CONSTRAINT ${name} FOREIGN KEY (family_id) REFERENCES maple_families(id) ${onDelete} NOT VALID`);
    } catch (err) {
      // 42710: another build migrating the same database (a Preview beside Production) added it first.
      if (codeOf(err) !== "42710") throw err;
    }
  }
  if (!rows[0]?.convalidated) await alter(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}`);
}

async function index(name: string, on: string, unique = false) {
  const rows = await sql`SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass(${name})`;
  if (rows[0]?.indisvalid) return;
  const make = `CREATE ${unique ? "UNIQUE " : ""}INDEX`;
  try {
    if (rows.length) await query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
    await query(`${make} CONCURRENTLY IF NOT EXISTS ${name} ON ${on}`);
  } catch (err) {
    const code = codeOf(err);
    const constraint = (err as { constraint?: unknown })?.constraint;
    if (code === "25001") {
      if (rows.length) await alter(`DROP INDEX IF EXISTS ${name}`);
      await alter(`${make} IF NOT EXISTS ${name} ON ${on}`);
    } else if (code !== "42P07" && !(code === "23505" && constraint === "pg_class_relname_nsp_index")) throw err;
  }
  const created = await sql`SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass(${name})`;
  if (!created[0]?.indisvalid) throw new Error(`migration_index_invalid:${name}`);
}

/** Each ALTER waits at most 3 s for its lock (a queued ALTER would stall every request behind it), then retries. */
async function alter(statement: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      await transaction([{ sql: "SET LOCAL lock_timeout = '3s'" }, { sql: statement }]);
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== "55P03" || attempt >= 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  migrate().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
