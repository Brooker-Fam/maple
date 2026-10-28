import { query } from "@/lib/db";
import { ADMIN_ID, familyOf, type Fam } from "./auth";
import type { ChatConsent } from "./chat/types";
import { StoreUnavailable } from "./store";
import type { Member } from "./types";

/**
 * What members have agreed to (maple_consents, one row per family, member and kind):
 * the chat's terms (`chat`), and the care person letting the chat see her
 * page: her food, drinks, medicines and doses, temperatures and questions for her OB
 * (`chat_care`). A row counts only at its kind's current version, so raising
 * a version here asks everyone again. Turning chat_care off deletes her row,
 * and one from before her page was made (deleted and made again) doesn't count.
 * Consent is per family: agreeing in one family's log says nothing about another's.
 */


export type ConsentKind = "chat" | "chat_care";

export const CONSENT_VERSION: Record<ConsentKind, number> = { chat: 1, chat_care: 2 };

export const consentCurrent = (kind: ConsentKind, version: unknown): boolean => version != null && Number(version) >= CONSENT_VERSION[kind];

async function rows(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const r = await query(sql, params);
  if (r === null) throw new StoreUnavailable();
  return r as Record<string, unknown>[];
}

/**
 * Her own account, never the admin login (its password is Matt's, even when
 * it acts as her), and never a viewer: careAccess's `self`.
 */
export const isCarePerson = (member: Pick<Member, "email" | "role">, person: string | null): boolean =>
  person != null && member.email !== ADMIN_ID && member.role !== "viewer" && member.email === person;

export async function chatConsent(fam: Fam, member: Pick<Member, "email" | "role">): Promise<ChatConsent> {
  const r = await rows(
    `SELECT
       (SELECT version FROM maple_consents WHERE family_id = $1 AND member = $2 AND kind = 'chat') AS chat,
       (SELECT member FROM maple_care_people WHERE family_id = $1 LIMIT 1) AS person,
       (SELECT c.version FROM maple_consents c
          JOIN maple_care_people p ON p.family_id = c.family_id AND p.member = c.member AND c.accepted_at >= p.created_at
         WHERE c.family_id = $1 AND c.kind = 'chat_care' LIMIT 1) AS care`,
    [familyOf(fam), member.email]
  );
  const row = r[0] ?? {};
  const person = typeof row.person === "string" ? row.person : null;
  return { terms: consentCurrent("chat", row.chat), care: consentCurrent("chat_care", row.care), self: isCarePerson(member, person) };
}

export async function acceptConsent(fam: Fam, member: string, kind: ConsentKind): Promise<void> {
  await rows(
    `INSERT INTO maple_consents (family_id, member, kind, version) VALUES ($1, $2, $3, $4)
     ON CONFLICT (family_id, member, kind) DO UPDATE SET version = EXCLUDED.version, accepted_at = NOW()`,
    [familyOf(fam), member, kind, CONSENT_VERSION[kind]]
  );
}

export async function withdrawConsent(fam: Fam, member: string, kind: ConsentKind): Promise<void> {
  await rows(`DELETE FROM maple_consents WHERE family_id = $1 AND member = $2 AND kind = $3`, [familyOf(fam), member, kind]);
}
