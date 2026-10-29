import { query } from "@/lib/db";

/** Private, short-lived encrypted reviews; saved growth points remain ordinary log entries. */
export async function migrateEpic(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS maple_epic_attempts (
    family_id BIGINT NOT NULL REFERENCES maple_families(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    state_hash CHAR(64) NOT NULL,
    browser_hash CHAR(64) NOT NULL,
    sealed_payload TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    PRIMARY KEY (family_id, member)
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maple_epic_attempt_expiry ON maple_epic_attempts(expires_at)`);
  await query(`CREATE TABLE IF NOT EXISTS maple_epic_pending (
    family_id BIGINT NOT NULL REFERENCES maple_families(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    id TEXT NOT NULL,
    baby_id INTEGER NOT NULL REFERENCES maple_babies(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL,
    sealed_payload TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (family_id, member)
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maple_epic_pending_expiry ON maple_epic_pending(expires_at)`);
  await query(`CREATE TABLE IF NOT EXISTS maple_epic_imports (
    family_id BIGINT NOT NULL REFERENCES maple_families(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    baby_id INTEGER NOT NULL REFERENCES maple_babies(id) ON DELETE CASCADE,
    entry_id BIGINT PRIMARY KEY REFERENCES maple_entries(id) ON DELETE CASCADE,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maple_epic_import_member ON maple_epic_imports(family_id, member, baby_id)`);

  // Membership's composite index is deliberately rebuildable by migrateFamilies after
  // an interrupted concurrent index build. A foreign key here would pin that index.
  // Keep deletion cleanup at the database boundary without adding that dependency.
  await query(`DO $install$
    BEGIN
      IF to_regprocedure('maple_epic_purge_member_v1()') IS NULL THEN
        CREATE FUNCTION maple_epic_purge_member_v1() RETURNS trigger LANGUAGE plpgsql AS $function$
        BEGIN
          DELETE FROM maple_epic_attempts WHERE family_id = OLD.family_id AND member = OLD.email;
          DELETE FROM maple_epic_pending WHERE family_id = OLD.family_id AND member = OLD.email;
          RETURN OLD;
        END
        $function$;
      END IF;
    EXCEPTION WHEN duplicate_function OR unique_violation THEN
      -- Another build installed the same function after the existence check.
      IF to_regprocedure('maple_epic_purge_member_v1()') IS NULL THEN RAISE; END IF;
    END
  $install$`);
  await query(`DO $install$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'maple_epic_member_deleted'
        AND tgrelid = 'maple_members'::regclass AND NOT tgisinternal) THEN
        CREATE TRIGGER maple_epic_member_deleted AFTER DELETE ON maple_members
          FOR EACH ROW EXECUTE FUNCTION maple_epic_purge_member_v1();
      END IF;
    EXCEPTION WHEN duplicate_object THEN
      -- Another build installed the trigger after the existence check.
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'maple_epic_member_deleted'
        AND tgrelid = 'maple_members'::regclass AND NOT tgisinternal) THEN RAISE; END IF;
    END
  $install$`);
}
