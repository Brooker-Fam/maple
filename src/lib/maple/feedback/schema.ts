import { query } from "@/lib/db";

/**
 * Feedback's tables (feedback/store.ts). Additive and made with family_id
 * NOT NULL from the start, cascading from maple_families, so nothing older
 * writes them and deleting a family deletes its feedback.
 *
 * maple_feedback: one row per message someone sent to the person who makes
 * Maple, with who sent it (their member id and role then), from where, and
 * when its email was accepted. maple_feedback_asks: one row per member who
 * has answered or put off Today's question, so it isn't asked again.
 */
export async function migrateFeedback(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS maple_feedback (
    id BIGSERIAL PRIMARY KEY,
    family_id BIGINT NOT NULL REFERENCES maple_families(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    role TEXT NOT NULL,
    via TEXT NOT NULL CHECK (via IN ('chat', 'app', 'prompt')),
    topic TEXT CHECK (topic IN ('problem', 'idea', 'praise', 'other')),
    rating TEXT CHECK (rating IN ('well', 'okay', 'not_well')),
    message TEXT CHECK (message IS NULL OR char_length(message) BETWEEN 1 AND 2000),
    emailed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (message IS NOT NULL OR rating IS NOT NULL)
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maple_feedback_time ON maple_feedback (created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maple_feedback_member ON maple_feedback (family_id, member, created_at DESC)`);
  await query(`CREATE TABLE IF NOT EXISTS maple_feedback_asks (
    family_id BIGINT NOT NULL REFERENCES maple_families(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    snoozes INTEGER NOT NULL DEFAULT 0,
    ask_after TIMESTAMPTZ,
    answered_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (family_id, member)
  )`);
}
