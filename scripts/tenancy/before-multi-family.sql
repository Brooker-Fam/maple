-- The schema as src/lib/migrate.ts built it at 65dbcc5, before families (its baby seed left out).
-- schema.check.ts loads it, adds synthetic rows the way older code writes them, then runs today's migrate.ts over it.

CREATE TABLE IF NOT EXISTS upload_rate_limit (
  ip_hash VARCHAR(64) NOT NULL,
  window_start TIMESTAMP NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, window_start)
);

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
);

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
);

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
);

CREATE INDEX IF NOT EXISTS idx_maple_entries_time ON maple_entries(baby_id, started_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_maple_entries_kind ON maple_entries(baby_id, kind, started_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_maple_entries_updated ON maple_entries(baby_id, updated_at DESC);

ALTER TABLE maple_entries ADD COLUMN IF NOT EXISTS updated_by TEXT;

ALTER TABLE maple_entries ADD COLUMN IF NOT EXISTS client_id TEXT;

ALTER TABLE maple_members ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

DROP INDEX IF EXISTS idx_maple_entries_active;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_entries_running ON maple_entries(baby_id, kind) WHERE active AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_entries_client ON maple_entries(client_id) WHERE client_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS maple_removed (
  email TEXT PRIMARY KEY,
  removed_by TEXT,
  removed_at TIMESTAMPTZ DEFAULT NOW()
);

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
);

CREATE TABLE IF NOT EXISTS maple_tokens (
  id SERIAL PRIMARY KEY,
  member TEXT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  label TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS maple_care_people (
  member TEXT PRIMARY KEY,
  shared_with JSONB NOT NULL DEFAULT '[]'::jsonb,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_care_people_one ON maple_care_people ((TRUE));

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
);

CREATE INDEX IF NOT EXISTS idx_maple_care_meds_person ON maple_care_meds(person, sort, id) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_care_meds_client ON maple_care_meds(client_id) WHERE client_id IS NOT NULL;

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
);

CREATE INDEX IF NOT EXISTS idx_maple_care_entries_time ON maple_care_entries(person, at DESC) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_maple_care_entries_med ON maple_care_entries(med_id, at DESC) WHERE deleted_at IS NULL AND kind = 'dose';

UPDATE maple_care_meds SET private = FALSE WHERE private;

UPDATE maple_care_entries SET private = FALSE WHERE private;

CREATE INDEX IF NOT EXISTS idx_maple_care_entries_updated ON maple_care_entries(person, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_care_entries_client ON maple_care_entries(client_id) WHERE client_id IS NOT NULL;

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
);

CREATE INDEX IF NOT EXISTS idx_maple_care_mood_time ON maple_care_mood(person, at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_care_mood_client ON maple_care_mood(client_id) WHERE client_id IS NOT NULL;

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
);

CREATE INDEX IF NOT EXISTS idx_maple_push_subs_member ON maple_push_subs(member);

CREATE TABLE IF NOT EXISTS maple_push_sent (
  key TEXT PRIMARY KEY,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS device_id TEXT;

ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS receipt_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_push_subs_receipt ON maple_push_subs(receipt_token) WHERE receipt_token IS NOT NULL;

UPDATE maple_push_subs SET receipt_token = replace(gen_random_uuid()::text, '-', '') WHERE receipt_token IS NULL;

ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS last_delivered_at TIMESTAMPTZ;

ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS last_delivered_key TEXT;

ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS undelivered INT NOT NULL DEFAULT 0;

ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS needs_resubscribe BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS test_due_at TIMESTAMPTZ;

ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS test_sent_at TIMESTAMPTZ;

ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS test_via TEXT;

ALTER TABLE maple_push_subs ADD COLUMN IF NOT EXISTS test_key TEXT;

ALTER TABLE maple_push_sent ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'sent';

ALTER TABLE maple_push_sent ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 1;

ALTER TABLE maple_push_sent ADD COLUMN IF NOT EXISTS sub_id BIGINT;

ALTER TABLE maple_push_sent ADD COLUMN IF NOT EXISTS ref TEXT;

CREATE INDEX IF NOT EXISTS idx_maple_push_sent_ref ON maple_push_sent(ref, sent_at DESC) WHERE ref IS NOT NULL;

INSERT INTO maple_push_sent (key, sent_at) VALUES ('floor:v2', NOW()) ON CONFLICT (key) DO NOTHING;

ALTER TABLE maple_care_entries ADD COLUMN IF NOT EXISTS device TEXT;

ALTER TABLE maple_entries ADD COLUMN IF NOT EXISTS device TEXT;

CREATE TABLE IF NOT EXISTS maple_chat_threads (
  id TEXT PRIMARY KEY,
  member TEXT NOT NULL,
  title TEXT,
  model TEXT NOT NULL,
  busy_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_maple_chat_threads_member ON maple_chat_threads(member, updated_at DESC);

ALTER TABLE maple_chat_threads ADD COLUMN IF NOT EXISTS viewer_only BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE maple_chat_threads ADD COLUMN IF NOT EXISTS care_open BOOLEAN NOT NULL DEFAULT TRUE;

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
);

CREATE INDEX IF NOT EXISTS idx_maple_chat_messages_daily ON maple_chat_messages(member, created_at DESC) WHERE role = 'user';

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
);

CREATE INDEX IF NOT EXISTS idx_maple_ai_usage_time ON maple_ai_usage(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_maple_ai_usage_thread ON maple_ai_usage(thread_id, id DESC);

CREATE TABLE IF NOT EXISTS maple_chat_daily (
  member TEXT NOT NULL,
  day DATE NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (member, day)
);

CREATE TABLE IF NOT EXISTS maple_consents (
  member TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (member, kind)
);

CREATE TABLE IF NOT EXISTS maple_waitlist (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  baby_month DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS maple_waitlist (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  baby_month DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

UPDATE maple_waitlist SET baby_month = NULL WHERE baby_month IS NOT NULL;
