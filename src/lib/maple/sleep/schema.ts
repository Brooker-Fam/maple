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
 *
 * maple_sleep_goals: the family's sleep goals (sleep/goal-store.ts), one row
 * each, with its targets, weekly steps and night roster as JSONB checked in
 * code (goals.ts cleanGoalInput), so a new kind never needs a non-additive
 * migration. `item_seq` numbers the items so an id is never reused, and
 * `revision` moves with every change (an edit names the one it was made
 * from). Soft deletes; `client_id` for retries.
 *
 * maple_sleep_checkins: each adult's answer for one night (`night`: the try
 * day key) about their own protected window: yes, partly or no and a short
 * note, never hours slept, mood or health. One per adult per night while
 * not deleted; only that adult writes theirs.
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
  await migrateShiftAsks();
  await migrateTryPauses();

  await query(`CREATE TABLE IF NOT EXISTS maple_sleep_goals (
    id BIGSERIAL PRIMARY KEY,
    family_id BIGINT NOT NULL REFERENCES maple_families(id) ON DELETE CASCADE,
    baby_id INTEGER NOT NULL REFERENCES maple_babies(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    why TEXT,
    target_date TEXT CHECK (target_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    status TEXT NOT NULL DEFAULT 'active',
    targets JSONB NOT NULL DEFAULT '[]'::jsonb,
    steps JSONB NOT NULL DEFAULT '[]'::jsonb,
    roster JSONB NOT NULL DEFAULT '[]'::jsonb,
    item_seq INTEGER NOT NULL DEFAULT 0,
    last_review_at TIMESTAMPTZ,
    review_note TEXT,
    closed_at TIMESTAMPTZ,
    revision INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    updated_by TEXT,
    source TEXT NOT NULL DEFAULT 'web',
    client_id TEXT,
    device TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maple_sleep_goals_baby ON maple_sleep_goals (family_id, baby_id, created_at DESC) WHERE deleted_at IS NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maple_sleep_goals_updated ON maple_sleep_goals (family_id, baby_id, updated_at DESC)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_sleep_goals_client ON maple_sleep_goals (family_id, client_id) WHERE client_id IS NOT NULL`);
  await migrateGoalTemplate();

  await query(`CREATE TABLE IF NOT EXISTS maple_sleep_checkins (
    id BIGSERIAL PRIMARY KEY,
    family_id BIGINT NOT NULL REFERENCES maple_families(id) ON DELETE CASCADE,
    baby_id INTEGER NOT NULL REFERENCES maple_babies(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    night TEXT NOT NULL CHECK (night ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    protected TEXT NOT NULL,
    note TEXT,
    source TEXT NOT NULL DEFAULT 'web',
    client_id TEXT,
    device TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
  )`);
  // One per adult per night, even when two of their phones save at once.
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_sleep_checkins_night ON maple_sleep_checkins (family_id, baby_id, member, night) WHERE deleted_at IS NULL`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_sleep_checkins_client ON maple_sleep_checkins (family_id, client_id) WHERE client_id IS NOT NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maple_sleep_checkins_night ON maple_sleep_checkins (family_id, baby_id, night DESC) WHERE deleted_at IS NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maple_sleep_checkins_updated ON maple_sleep_checkins (family_id, baby_id, updated_at DESC)`);
  await migrateCheckinExtras();
}

/**
 * The morning's extra one-tap answers on a check-in (sleep/types.ts
 * CheckinExtras): where the baby spent most of the night, a bassinet try
 * the log doesn't have (and the minutes its "long" meant), and whether the
 * planned handoff happened as planned. Nullable and checked in code, so an
 * older row has none and an older release reads past them.
 */
async function migrateCheckinExtras(): Promise<void> {
  await query(`ALTER TABLE maple_sleep_checkins ADD COLUMN IF NOT EXISTS place TEXT`);
  await query(`ALTER TABLE maple_sleep_checkins ADD COLUMN IF NOT EXISTS untimed_try TEXT`);
  await query(`ALTER TABLE maple_sleep_checkins ADD COLUMN IF NOT EXISTS untimed_min SMALLINT`);
  await query(`ALTER TABLE maple_sleep_checkins ADD COLUMN IF NOT EXISTS handoff TEXT`);
}

/**
 * A holding turn's ask ("Wake [partner]"): who the holder asked to take over
 * and when, both nullable. Nothing changes hands until that person has her,
 * so an ask is never a handoff. Additive: an older release reads past them
 * and shows the turn as it was.
 */
async function migrateShiftAsks(): Promise<void> {
  await query(`ALTER TABLE maple_sleep_shifts ADD COLUMN IF NOT EXISTS asked_to TEXT`);
  await query(`ALTER TABLE maple_sleep_shifts ADD COLUMN IF NOT EXISTS asked_at TIMESTAMPTZ`);
}

/**
 * The template a goal was made from (sleep/types.ts GoalTemplate: for a
 * "Back to work" goal, who goes back to work and when, and who nurses), for
 * the coach notes that need it later. Nullable JSONB checked in code, so an
 * older release reads past it and a goal made by hand has none.
 */
async function migrateGoalTemplate(): Promise<void> {
  await query(`ALTER TABLE maple_sleep_goals ADD COLUMN IF NOT EXISTS template JSONB`);
  await migrateGoalRestarts();
}

/**
 * The family's own clean restart of a goal (sleep/types.ts SleepGoal): `counts_from`, the night it was picked up again
 * after a quiet stretch, and `paused_until`, the night it counts again after easing off. Both nullable dates, so an
 * older release reads past them and counts the goal from the night it was set, as before.
 */
async function migrateGoalRestarts(): Promise<void> {
  await query(`ALTER TABLE maple_sleep_goals ADD COLUMN IF NOT EXISTS counts_from TEXT CHECK (counts_from ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')`);
  await query(`ALTER TABLE maple_sleep_goals ADD COLUMN IF NOT EXISTS paused_until TEXT CHECK (paused_until ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')`);
}

/**
 * When Siri last said "pause until the next try" after this try (a retry
 * that ended awake), so a put down said again within two minutes goes ahead
 * (quick/sleep.ts). Nullable, never part of the app's state, and set without
 * moving updated_at; an older release reads past it.
 */
async function migrateTryPauses(): Promise<void> {
  await query(`ALTER TABLE maple_sleep_tries ADD COLUMN IF NOT EXISTS pause_said_at TIMESTAMPTZ`);
}
