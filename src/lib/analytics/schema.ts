import { query } from "../db";

export async function migrateAnalytics(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS maple_analytics_members (
    member TEXT PRIMARY KEY, analytics_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS maple_analytics_families (
    family_id BIGINT PRIMARY KEY REFERENCES maple_families(id) ON DELETE CASCADE,
    analytics_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS maple_analytics_links (
    visitor_id UUID PRIMARY KEY,
    member_id UUID REFERENCES maple_analytics_members(analytics_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS maple_analytics_deliveries (
    event_id UUID PRIMARY KEY, distinct_id UUID NOT NULL, event TEXT NOT NULL,
    member_id UUID REFERENCES maple_analytics_members(analytics_id) ON DELETE CASCADE,
    family_id UUID REFERENCES maple_analytics_families(analytics_id) ON DELETE CASCADE,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), delivered_at TIMESTAMPTZ,
    environment TEXT NOT NULL, is_test BOOLEAN NOT NULL DEFAULT FALSE
  )`);
  await query(`ALTER TABLE maple_analytics_deliveries ADD COLUMN IF NOT EXISTS session_id UUID`);
  await query(`CREATE INDEX IF NOT EXISTS maple_analytics_deliveries_time ON maple_analytics_deliveries(occurred_at)`);
  await query(`CREATE OR REPLACE FUNCTION maple_analytics_remove_orphan() RETURNS TRIGGER AS $$
    BEGIN
      DELETE FROM maple_analytics_members a WHERE a.member = OLD.email
        AND NOT EXISTS (SELECT 1 FROM maple_members m WHERE m.email = a.member);
      RETURN NULL;
    END;
  $$ LANGUAGE plpgsql`);
  await query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'maple_analytics_member_deleted') THEN
      CREATE TRIGGER maple_analytics_member_deleted AFTER DELETE ON maple_members
        FOR EACH ROW EXECUTE FUNCTION maple_analytics_remove_orphan();
    END IF;
  END $$`);
}

export async function pruneAnalytics(): Promise<void> {
  await query(`DELETE FROM maple_analytics_members a WHERE NOT EXISTS (SELECT 1 FROM maple_members m WHERE m.email = a.member)`);
  await query(`DELETE FROM maple_analytics_deliveries WHERE occurred_at < NOW() - INTERVAL '7 days'`);
  await query(`DELETE FROM maple_analytics_links WHERE created_at < NOW() - INTERVAL '31 days'`);
}
