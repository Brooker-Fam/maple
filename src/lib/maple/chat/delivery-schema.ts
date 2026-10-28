import { query } from "@/lib/db";

/** Additive tables only: older deployments ignore these without changing their writes. */
export async function migrateChatDelivery(): Promise<void> {
  await query(`ALTER TABLE maple_chat_daily ADD COLUMN IF NOT EXISTS cancellations INTEGER NOT NULL DEFAULT 0`);
  await query(`CREATE TABLE IF NOT EXISTS maple_chat_deliveries (
    family_id BIGINT NOT NULL REFERENCES maple_families(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL,
    thread_id TEXT,
    message_id TEXT NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (family_id, member, request_id)
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maple_chat_deliveries_time ON maple_chat_deliveries(accepted_at)`);
  await query(`ALTER TABLE maple_chat_deliveries ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`);
  await query(`CREATE TABLE IF NOT EXISTS maple_chat_member_locks (
    family_id BIGINT NOT NULL REFERENCES maple_families(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    lease_id TEXT NOT NULL,
    busy_until TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (family_id, member)
  )`);
}
