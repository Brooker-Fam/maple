import { query, transaction } from "@/lib/db";
import { FAMILY_ONE, parseFamilyId } from "../family";
import { FAMILY_TABLES } from "../family-tables";

/**
 * Families that started onboarding and never logged anything are deleted
 * after ABANDONED_DAYS (docs/multi-family-plan.md 4.2), so a sign-up left
 * half-way doesn't stay a full account forever. Never family 1, never a
 * family that has finished setting up or logged an entry or a dose. Every
 * row with the family's id goes, children first (the family keys have no
 * cascade); usage rows keep their cost with the family set to null.
 */

export const ABANDONED_DAYS = 30;

/** Children before parents: messages before threads, her entries before her page, entries before babies. */
export const CLEANUP_ORDER = [
  "maple_chat_messages",
  "maple_chat_threads",
  "maple_chat_daily",
  "maple_consents",
  "maple_care_mood",
  "maple_care_entries",
  "maple_care_meds",
  "maple_care_people",
  "maple_push_subs",
  "maple_tokens",
  "maple_invites",
  "maple_removed",
  "maple_entries",
  "maple_babies",
  "maple_members",
] as const satisfies readonly (typeof FAMILY_TABLES)[number][];

const STILL_ABANDONED = `EXISTS (
  SELECT 1 FROM maple_families f WHERE f.id = $1 AND f.id <> ${FAMILY_ONE} AND f.status = 'onboarding' AND f.created_at < $2
    AND NOT EXISTS (SELECT 1 FROM maple_entries e WHERE e.family_id = f.id)
    AND NOT EXISTS (SELECT 1 FROM maple_care_entries c WHERE c.family_id = f.id)
)`;

/** Deletes up to `limit` abandoned families; returns their ids. */
export async function deleteAbandonedFamilies(now = new Date(), limit = 25): Promise<number[]> {
  const cutoff = new Date(now.getTime() - ABANDONED_DAYS * 86_400_000).toISOString();
  const rows = await query(
    `SELECT f.id FROM maple_families f WHERE f.id <> ${FAMILY_ONE} AND f.status = 'onboarding' AND f.created_at < $1
       AND NOT EXISTS (SELECT 1 FROM maple_entries e WHERE e.family_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM maple_care_entries c WHERE c.family_id = f.id)
     ORDER BY f.id LIMIT $2`,
    [cutoff, limit]
  );
  const gone: number[] = [];
  for (const r of rows ?? []) {
    const id = parseFamilyId(r.id);
    if (id === null || id === FAMILY_ONE) continue;
    // The lock makes a family finishing its setup right now wait, and then every delete finds it no longer abandoned.
    const out = await transaction([
      { sql: `SELECT id FROM maple_families WHERE id = $1 FOR UPDATE`, params: [id] },
      ...CLEANUP_ORDER.map((t) => ({ sql: `DELETE FROM ${t} WHERE family_id = $1 AND ${STILL_ABANDONED}`, params: [id, cutoff] })),
      { sql: `DELETE FROM maple_families WHERE id = $1 AND ${STILL_ABANDONED} RETURNING id`, params: [id, cutoff] },
    ]);
    if (out?.[out.length - 1]?.length) gone.push(id);
  }
  return gone;
}
