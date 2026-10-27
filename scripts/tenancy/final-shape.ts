import { isPglite, query } from "../../src/lib/db";
import { FAMILY_TABLES } from "../../src/lib/maple/family-tables";

/**
 * The schema after the Phase 3 contract (docs/multi-family-plan.md): family_id
 * NOT NULL with no default, the old global keys gone, the care page keyed by
 * family. Applied only to a check's in-memory database, so a statement that
 * forgets family_id fails loudly (23502) and an old ON CONFLICT target fails
 * with 42P10, instead of either landing in family 1.
 *
 * Not the production contract script: that one is written and reviewed on
 * its own, run by the owner after Phase 2 has served cleanly, and never from
 * migrate.ts.
 */
export const FINAL_SHAPE: string[] = [
  ...FAMILY_TABLES.flatMap((t) => [
    `ALTER TABLE ${t} ALTER COLUMN family_id SET NOT NULL`,
    `ALTER TABLE ${t} ALTER COLUMN family_id DROP DEFAULT`,
  ]),
  `ALTER TABLE maple_members DROP CONSTRAINT maple_members_pkey`,
  `ALTER TABLE maple_members ADD CONSTRAINT maple_members_pkey PRIMARY KEY USING INDEX uniq_maple_members_family_email`,
  `ALTER TABLE maple_removed DROP CONSTRAINT maple_removed_pkey`,
  `ALTER TABLE maple_removed ADD CONSTRAINT maple_removed_pkey PRIMARY KEY USING INDEX uniq_maple_removed_family_email`,
  `ALTER TABLE maple_chat_daily DROP CONSTRAINT maple_chat_daily_pkey`,
  `ALTER TABLE maple_chat_daily ADD CONSTRAINT maple_chat_daily_pkey PRIMARY KEY USING INDEX uniq_maple_chat_daily_family`,
  `ALTER TABLE maple_consents DROP CONSTRAINT maple_consents_pkey`,
  `ALTER TABLE maple_consents ADD CONSTRAINT maple_consents_pkey PRIMARY KEY USING INDEX uniq_maple_consents_family`,
  `DROP INDEX uniq_maple_entries_client`,
  `DROP INDEX uniq_maple_care_meds_client`,
  `DROP INDEX uniq_maple_care_entries_client`,
  `DROP INDEX uniq_maple_care_mood_client`,
  `ALTER TABLE maple_push_subs DROP CONSTRAINT maple_push_subs_endpoint_key`,
  `DROP INDEX uniq_maple_care_people_one`,
  `ALTER TABLE maple_care_meds DROP CONSTRAINT maple_care_meds_person_fkey`,
  `ALTER TABLE maple_care_entries DROP CONSTRAINT maple_care_entries_person_fkey`,
  `ALTER TABLE maple_care_mood DROP CONSTRAINT maple_care_mood_person_fkey`,
  `ALTER TABLE maple_care_people DROP CONSTRAINT maple_care_people_pkey`,
  `ALTER TABLE maple_care_people ADD CONSTRAINT maple_care_people_pkey PRIMARY KEY USING INDEX uniq_maple_care_people_family`,
  ...["maple_care_meds", "maple_care_entries", "maple_care_mood"].map(
    (t) => `ALTER TABLE ${t} ADD CONSTRAINT fk_${t}_care_family FOREIGN KEY (family_id) REFERENCES maple_care_people(family_id) ON DELETE CASCADE`
  ),
  `ALTER TABLE maple_entries ADD CONSTRAINT fk_maple_entries_family_baby FOREIGN KEY (family_id, baby_id) REFERENCES maple_babies(family_id, id)`,
];

export async function applyFinalShape(): Promise<void> {
  if (!isPglite()) throw new Error("applyFinalShape runs only against a pglite: database");
  for (const statement of FINAL_SHAPE) await query(statement);
}
