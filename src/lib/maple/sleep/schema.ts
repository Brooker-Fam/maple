import { query } from "@/lib/db";

/**
 * The sleep plan's tables (sleep/store.ts). Additive, made with family_id
 * NOT NULL from the start and cascading from maple_families, so nothing
 * older writes them, a rollback reads past them, and deleting a family
 * deletes them. Enumerations (stage, outcome, tags, places) are checked in
 * code, not in CHECK constraints, so a new choice never needs a non-additive
 * migration.
 *
 * maple_sleep_plans: one row per baby (the family's plan for moving from
 * held sleep to the bassinet). `revision` moves with every change, and an
 * edit names the revision it was made from.
 *
 * maple_sleep_tries: one row per bassinet try. A running try has no
 * ended_at (one per baby). `sleep_entry_id` is the sleep entry the try sits
 * on (a try never counts as sleep itself, so sleep is never counted twice);
 * `made_sleep` says the try created that entry, so deleting the try removes
 * it too. Soft deletes, like maple_entries, so Undo can bring one back.
 *
 * maple_sleep_shifts: who is holding the baby awake (an adult staying awake
 * while holding her), since when, and the planned handoff. One open shift
 * per baby.
 */
export async function migrateSleep(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS maple_sleep_plans (
    family_id BIGINT NOT NULL REFERENCES maple_families(id) ON DELETE CASCADE,
    baby_id INTEGER NOT NULL REFERENCES maple_babies(id) ON DELETE CASCADE,
    stage SMALLINT NOT NULL DEFAULT 1,
    stage_since TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sleeps_now TEXT,
    goal TEXT,
    tries_per_day SMALLINT NOT NULL DEFAULT 1,
    try_times JSONB NOT NULL DEFAULT '[]'::jsonb,
    fallback TEXT,
    snoozed_until TEXT CHECK (snoozed_until ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    revision INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    updated_by TEXT,
    source TEXT NOT NULL DEFAULT 'web',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (family_id, baby_id)
  )`);

  await query(`CREATE TABLE IF NOT EXISTS maple_sleep_tries (
    id BIGSERIAL PRIMARY KEY,
    family_id BIGINT NOT NULL REFERENCES maple_families(id) ON DELETE CASCADE,
    baby_id INTEGER NOT NULL REFERENCES maple_babies(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    outcome TEXT,
    put_down_by TEXT,
    tags TEXT[] NOT NULL DEFAULT '{}',
    note TEXT,
    sleep_entry_id BIGINT REFERENCES maple_entries(id) ON DELETE SET NULL,
    made_sleep BOOLEAN NOT NULL DEFAULT FALSE,
    created_by TEXT,
    updated_by TEXT,
    source TEXT NOT NULL DEFAULT 'web',
    client_id TEXT,
    device TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    CHECK (ended_at IS NULL OR ended_at >= started_at),
    CHECK ((ended_at IS NULL) = (outcome IS NULL))
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maple_sleep_tries_time ON maple_sleep_tries (family_id, baby_id, started_at DESC) WHERE deleted_at IS NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maple_sleep_tries_updated ON maple_sleep_tries (family_id, baby_id, updated_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maple_sleep_tries_sleep ON maple_sleep_tries (sleep_entry_id) WHERE sleep_entry_id IS NOT NULL`);
  // One running try per baby, even when two phones tap Put down at once.
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_sleep_tries_running ON maple_sleep_tries (family_id, baby_id) WHERE ended_at IS NULL AND deleted_at IS NULL`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_sleep_tries_client ON maple_sleep_tries (family_id, client_id) WHERE client_id IS NOT NULL`);

  await query(`CREATE TABLE IF NOT EXISTS maple_sleep_shifts (
    id BIGSERIAL PRIMARY KEY,
    family_id BIGINT NOT NULL REFERENCES maple_families(id) ON DELETE CASCADE,
    baby_id INTEGER NOT NULL REFERENCES maple_babies(id) ON DELETE CASCADE,
    holder TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    handoff_at TIMESTAMPTZ,
    next_holder TEXT,
    ended_at TIMESTAMPTZ,
    ended_how TEXT,
    created_by TEXT,
    updated_by TEXT,
    source TEXT NOT NULL DEFAULT 'web',
    client_id TEXT,
    device TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    CHECK (ended_at IS NULL OR ended_at >= started_at)
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maple_sleep_shifts_time ON maple_sleep_shifts (family_id, baby_id, started_at DESC) WHERE deleted_at IS NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maple_sleep_shifts_updated ON maple_sleep_shifts (family_id, baby_id, updated_at DESC)`);
  // The push tick finds families with a handoff coming up without reading every shift.
  await query(`CREATE INDEX IF NOT EXISTS idx_maple_sleep_shifts_handoff ON maple_sleep_shifts (handoff_at) WHERE ended_at IS NULL AND deleted_at IS NULL AND handoff_at IS NOT NULL`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_sleep_shifts_open ON maple_sleep_shifts (family_id, baby_id) WHERE ended_at IS NULL AND deleted_at IS NULL`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_sleep_shifts_client ON maple_sleep_shifts (family_id, client_id) WHERE client_id IS NOT NULL`);
}
