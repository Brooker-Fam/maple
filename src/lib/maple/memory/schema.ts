import { query } from "@/lib/db";

/**
 * Family memories' tables (memory/store.ts). Additive and made with
 * family_id NOT NULL from the start, cascading from maple_families, so
 * nothing older writes them and deleting a family deletes its memories.
 *
 * maple_memory_state: one row per family, its switches and the counters a
 * write is checked against. maple_memories: one row per version of a
 * memory; a correction marks the old row superseded and points the new one
 * at it (predecessor_id). Forget deletes the rows outright. Civil dates are
 * TEXT (YYYY-MM-DD), compared as strings, so no driver turns them into a
 * Date in the server's timezone.
 */
export async function migrateMemories(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS maple_memory_state (
    family_id BIGINT PRIMARY KEY REFERENCES maple_families(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 0,
    epoch INTEGER NOT NULL DEFAULT 0,
    capture_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    use_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    forget_floor TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS maple_memories (
    id BIGSERIAL PRIMARY KEY,
    family_id BIGINT NOT NULL REFERENCES maple_families(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    fact TEXT NOT NULL,
    fact_key TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'resolved', 'archived')),
    valid_from TEXT CHECK (valid_from ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    valid_to TEXT CHECK (valid_to ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    review_on TEXT CHECK (review_on ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    revision INTEGER NOT NULL DEFAULT 1,
    predecessor_id BIGINT,
    said_by TEXT,
    via TEXT NOT NULL,
    source_text TEXT,
    source_words BOOLEAN NOT NULL DEFAULT FALSE,
    stated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    ended_by TEXT,
    ended_via TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maple_memories_family ON maple_memories (family_id, status, stated_at DESC)`);
  // Two current memories never say the same thing: saving it again confirms the one there.
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_maple_memories_active_fact ON maple_memories (family_id, fact_key) WHERE status = 'active'`);
}
