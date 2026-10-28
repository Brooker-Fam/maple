import { query, transaction } from "../db";
import { analyticsConfig } from "./config";

export type AnalyticsActor = { familyId: number; member: string; role?: string };
export type AnalyticsIdentity = { distinctId: string; familyGroupId: string };

export async function resolveAnalyticsActor(actor: AnalyticsActor): Promise<AnalyticsIdentity | null> {
  if (!analyticsConfig() || !actor || !Number.isSafeInteger(actor.familyId) || actor.familyId < 1 ||
      typeof actor.member !== "string" || !actor.member || actor.member.length > 320 || actor.member === "admin" || actor.member.startsWith("invite:")) return null;
  const result = await transaction([
    { sql: `SELECT email FROM maple_members WHERE family_id = $1 AND email = $2 AND (family_id = 1 OR accepted_at IS NOT NULL) FOR KEY SHARE`, params: [actor.familyId, actor.member] },
    { sql: `INSERT INTO maple_analytics_members (member)
        SELECT email FROM maple_members WHERE family_id = $1 AND email = $2 AND (family_id = 1 OR accepted_at IS NOT NULL)
        ON CONFLICT (member) DO NOTHING`, params: [actor.familyId, actor.member] },
    { sql: `INSERT INTO maple_analytics_families (family_id)
        SELECT family_id FROM maple_members WHERE family_id = $1 AND email = $2 AND (family_id = 1 OR accepted_at IS NOT NULL)
        ON CONFLICT (family_id) DO NOTHING`, params: [actor.familyId, actor.member] },
    { sql: `SELECT a.analytics_id AS person_id, f.analytics_id AS group_id
        FROM maple_analytics_members a JOIN maple_members m ON m.email = a.member
        JOIN maple_analytics_families f ON f.family_id = m.family_id
        WHERE m.family_id = $1 AND m.email = $2 AND (m.family_id = 1 OR m.accepted_at IS NOT NULL)`, params: [actor.familyId, actor.member] },
  ]);
  const row = result?.[3]?.[0];
  return row ? { distinctId: String(row.person_id), familyGroupId: String(row.group_id) } : null;
}

export async function claimAnalyticsVisitor(visitorId: string, distinctId: string): Promise<boolean> {
  const rows = await query(`INSERT INTO maple_analytics_links (visitor_id, member_id) VALUES ($1, $2)
    ON CONFLICT (visitor_id) DO UPDATE SET visitor_id = EXCLUDED.visitor_id
      WHERE maple_analytics_links.member_id = EXCLUDED.member_id RETURNING visitor_id`, [visitorId, distinctId]);
  return Boolean(rows?.length);
}
