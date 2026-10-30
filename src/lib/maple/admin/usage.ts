import { query } from "@/lib/db";
import { FAMILY_ONE } from "../family";
import { StoreUnavailable } from "../store";
import { ADMIN_FEATURES, ADMIN_SOURCES, type AdminFeature, type AdminSource, type AdminUsage, type AdminUsageCount } from "./types";

/**
 * What families use, for the operator's admin page: counts of entries,
 * days, messages and switches, never what was logged. Entries count by when
 * they were saved (created_at) and only while not deleted. "Days" are
 * 24-hour periods counted back from the snapshot, so no family's timezone is
 * needed. Chat counts come from maple_chat_daily, which outlives deleted chat
 * history; its days are each family's dates, read inside the UTC window with
 * a day's slack ahead for zones east of UTC. Feedback counts every family's,
 * the original family's too, as its list does (admin/details.ts).
 */

/** The group an entry's kind falls in. */
export const featureOf = (e: string) => `CASE
  WHEN ${e}.kind = 'feed' THEN 'feeds'
  WHEN ${e}.kind = 'pump' THEN 'pumping'
  WHEN ${e}.kind = 'diaper' THEN 'diapers'
  WHEN ${e}.kind = 'sleep' THEN 'sleep'
  WHEN ${e}.kind = 'growth' THEN 'growth'
  WHEN ${e}.kind IN ('temp', 'vitals', 'med') THEN 'health'
  WHEN ${e}.kind = 'moment' THEN 'moments'
  WHEN ${e}.kind = 'note' THEN 'notes'
  ELSE 'routines' END`;

/** How an entry was added. */
export const sourceOf = (e: string) => `CASE
  WHEN ${e}.source = 'chat' THEN 'chat'
  WHEN ${e}.source = 'shortcut' THEN 'siri'
  WHEN ${e}.source IN ('claude', 'chatgpt', 'muse', 'grok', 'mcp') THEN 'assistant'
  WHEN ${e}.source = 'epic' THEN 'import'
  ELSE 'app' END`;

/** maple_chat_daily rows from the last 30 (or 7) days, as `d`; $2 is the snapshot. */
const chatDays = (days: 7 | 30) =>
  `d.day >= ($2::timestamptz AT TIME ZONE 'UTC')::date - ${days - 1} AND d.day <= ($2::timestamptz AT TIME ZONE 'UTC')::date + 1`;

const SAVED_30D = (e: string) => `${e}.deleted_at IS NULL AND ${e}.created_at > $2::timestamptz - INTERVAL '720 hours' AND ${e}.created_at <= $2::timestamptz`;
const SAVED_7D = (e: string) => `${e}.deleted_at IS NULL AND ${e}.created_at > $2::timestamptz - INTERVAL '168 hours' AND ${e}.created_at <= $2::timestamptz`;
const PERIODS_AGO = (e: string) => `floor(extract(epoch FROM ($2::timestamptz - ${e}.created_at)) / 86400)`;

function counts<K extends string>(keys: readonly K[], rows: unknown): AdminUsageCount<K>[] {
  const got = new Map((Array.isArray(rows) ? rows : []).map((r: { key: K; families: number; entries: number }) => [r.key, r]));
  return keys.map((key) => ({ key, families: Number(got.get(key)?.families ?? 0), entries: Number(got.get(key)?.entries ?? 0) }));
}

/** Every family but family 1, together. Call only after the metrics-admin check. */
export async function readAdminUsage(now: Date): Promise<{ usage: AdminUsage; feedback: { total: number; last7d: number; well: number; okay: number; notWell: number } }> {
  const rows = await query(
    `WITH fams AS (
       SELECT id, status FROM maple_families WHERE id <> $1
     ), recent AS (
       SELECT e.family_id, ${featureOf("e")} AS feature, ${sourceOf("e")} AS via, ${PERIODS_AGO("e")}::int AS ago
       FROM maple_entries e JOIN fams f ON f.id = e.family_id WHERE ${SAVED_30D("e")}
     ), care AS (
       SELECT c.family_id FROM maple_care_entries c JOIN fams f ON f.id = c.family_id WHERE ${SAVED_30D("c")}
     ), chat AS (
       SELECT d.family_id, d.member, d.messages, ${chatDays(7)} AS week
       FROM maple_chat_daily d JOIN fams f ON f.id = d.family_id WHERE ${chatDays(30)} AND d.messages > 0
     ), logging AS (
       SELECT f.id, (SELECT COUNT(DISTINCT r.ago)::int FROM recent r WHERE r.family_id = f.id AND r.ago < 7) AS days
       FROM fams f WHERE f.status = 'active'
     ), features AS (
       SELECT feature AS key, COUNT(DISTINCT family_id)::int AS families, COUNT(*)::int AS entries FROM recent GROUP BY feature
       UNION ALL SELECT 'recovery', COUNT(DISTINCT family_id)::int, COUNT(*)::int FROM care
       UNION ALL SELECT 'chat', COUNT(DISTINCT family_id)::int, COALESCE(SUM(messages), 0)::int FROM chat
     ), sources AS (
       SELECT via AS key, COUNT(DISTINCT family_id)::int AS families, COUNT(*)::int AS entries FROM recent GROUP BY via
     )
     SELECT jsonb_build_object(
       'logging', jsonb_build_object(
         'families7d', (SELECT COUNT(DISTINCT family_id)::int FROM recent WHERE ago < 7),
         'entries7d', (SELECT COUNT(*)::int FROM recent WHERE ago < 7),
         'mostDays', (SELECT COUNT(*)::int FROM logging WHERE days >= 4),
         'someDays', (SELECT COUNT(*)::int FROM logging WHERE days BETWEEN 1 AND 3),
         'noDays', (SELECT COUNT(*)::int FROM logging WHERE days = 0)
       ),
       'features', (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) FROM features x),
       'sources', (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) FROM sources x),
       'chat', jsonb_build_object(
         'families30d', (SELECT COUNT(DISTINCT family_id)::int FROM chat),
         'people30d', (SELECT COUNT(DISTINCT member)::int FROM chat WHERE member <> 'admin'),
         'messages7d', (SELECT COALESCE(SUM(messages), 0)::int FROM chat WHERE week),
         'messages30d', (SELECT COALESCE(SUM(messages), 0)::int FROM chat)
       ),
       'turnedOn', jsonb_build_object(
         'notifications', (SELECT COUNT(DISTINCT s.family_id)::int FROM maple_push_subs s JOIN fams f ON f.id = s.family_id),
         'siri', (SELECT COUNT(DISTINCT t.family_id)::int FROM maple_tokens t JOIN fams f ON f.id = t.family_id WHERE t.revoked_at IS NULL),
         'recoveryPage', (SELECT COUNT(DISTINCT p.family_id)::int FROM maple_care_people p JOIN fams f ON f.id = p.family_id),
         'memories', (SELECT COUNT(DISTINCT m.family_id)::int FROM maple_memories m JOIN fams f ON f.id = m.family_id WHERE m.status = 'active'),
         'shared', (SELECT COUNT(*)::int FROM (SELECT m.family_id FROM maple_members m JOIN fams f ON f.id = m.family_id
           WHERE m.accepted_at IS NOT NULL AND m.email <> 'admin' GROUP BY m.family_id HAVING COUNT(*) >= 2) x)
       ),
       'feedback', (SELECT jsonb_build_object(
         'total', COUNT(*)::int,
         'last7d', (COUNT(*) FILTER (WHERE fb.created_at > $2::timestamptz - INTERVAL '168 hours'))::int,
         'well', (COUNT(*) FILTER (WHERE fb.rating = 'well'))::int,
         'okay', (COUNT(*) FILTER (WHERE fb.rating = 'okay'))::int,
         'notWell', (COUNT(*) FILTER (WHERE fb.rating = 'not_well'))::int
       ) FROM maple_feedback fb WHERE fb.created_at <= $2::timestamptz)
     ) AS usage`,
    [FAMILY_ONE, now.toISOString()]
  );
  const raw = rows?.[0]?.usage as (Omit<AdminUsage, "features" | "sources"> & { features: unknown; sources: unknown; feedback: { total: number; last7d: number; well: number; okay: number; notWell: number } }) | undefined;
  if (!raw) throw new StoreUnavailable();
  const { feedback, features, sources, ...rest } = raw;
  return { usage: { ...rest, features: counts(ADMIN_FEATURES, features), sources: counts(ADMIN_SOURCES, sources) }, feedback };
}

export type AdminFamilyUsage = {
  entries7d: number;
  entries30d: number;
  /** Of the last seven 24-hour periods, how many had an entry saved. */
  days7d: number;
  lastEntryAt: string | null;
  lastSeenAt: string | null;
  chat30d: number;
  /** Groups used in the last 30 days, in ADMIN_FEATURES order. */
  features: AdminFeature[];
  sources: AdminSource[];
};

const iso = (value: unknown): string | null => (value == null ? null : new Date(value as string).toISOString());

const ordered = <K extends string>(keys: readonly K[], raw: unknown): K[] => {
  const got = new Set(Array.isArray(raw) ? raw : []);
  return keys.filter((key) => got.has(key));
};

/** One page's families, by id. */
export async function readFamilyUsage(ids: number[], now: Date): Promise<Map<number, AdminFamilyUsage>> {
  if (!ids.length) return new Map();
  const rows = await query(
    `SELECT f.id,
       (SELECT COUNT(*)::int FROM maple_entries e WHERE e.family_id = f.id AND ${SAVED_7D("e")}) AS entries7d,
       (SELECT COUNT(*)::int FROM maple_entries e WHERE e.family_id = f.id AND ${SAVED_30D("e")}) AS entries30d,
       (SELECT COUNT(DISTINCT ${PERIODS_AGO("e")})::int FROM maple_entries e WHERE e.family_id = f.id AND ${SAVED_7D("e")}) AS days7d,
       (SELECT MAX(e.created_at) FROM maple_entries e WHERE e.family_id = f.id AND e.deleted_at IS NULL AND e.created_at <= $2::timestamptz) AS last_entry_at,
       (SELECT MAX(m.last_seen_at) FROM maple_members m WHERE m.family_id = f.id AND m.accepted_at IS NOT NULL AND m.email <> 'admin' AND m.last_seen_at <= $2::timestamptz) AS last_seen_at,
       (SELECT COALESCE(SUM(d.messages), 0)::int FROM maple_chat_daily d WHERE d.family_id = f.id AND ${chatDays(30)}) AS chat30d,
       (SELECT COALESCE(jsonb_agg(DISTINCT ${featureOf("e")}), '[]'::jsonb) FROM maple_entries e WHERE e.family_id = f.id AND ${SAVED_30D("e")})
         || CASE WHEN EXISTS (SELECT 1 FROM maple_care_entries c WHERE c.family_id = f.id AND ${SAVED_30D("c")}) THEN '["recovery"]'::jsonb ELSE '[]'::jsonb END
         || CASE WHEN EXISTS (SELECT 1 FROM maple_chat_daily d WHERE d.family_id = f.id AND d.messages > 0 AND ${chatDays(30)}) THEN '["chat"]'::jsonb ELSE '[]'::jsonb END AS features,
       (SELECT COALESCE(jsonb_agg(DISTINCT ${sourceOf("e")}), '[]'::jsonb) FROM maple_entries e WHERE e.family_id = f.id AND ${SAVED_30D("e")}) AS sources
     FROM maple_families f WHERE f.id = ANY($1::bigint[]) AND f.id <> $3`,
    [ids, now.toISOString(), FAMILY_ONE]
  );
  if (!rows) throw new StoreUnavailable();
  return new Map(rows.map((r) => [Number(r.id), {
    entries7d: Number(r.entries7d),
    entries30d: Number(r.entries30d),
    days7d: Number(r.days7d),
    lastEntryAt: iso(r.last_entry_at),
    lastSeenAt: iso(r.last_seen_at),
    chat30d: Number(r.chat30d),
    features: ordered(ADMIN_FEATURES, r.features),
    sources: ordered(ADMIN_SOURCES, r.sources),
  }]));
}

export type AdminPersonUsage = { entries30d: number; chat30d: number };

/** One page's people, by member id: what they saved and sent in their families but family 1. */
export async function readPersonUsage(emails: string[], now: Date): Promise<Map<string, AdminPersonUsage>> {
  if (!emails.length) return new Map();
  const rows = await query(
    `SELECT u.email,
       (SELECT COUNT(*)::int FROM maple_members m JOIN maple_entries e ON e.family_id = m.family_id AND e.created_by = m.email
         WHERE m.email = u.email AND m.family_id <> $3 AND ${SAVED_30D("e")}) AS entries30d,
       (SELECT COALESCE(SUM(d.messages), 0)::int FROM maple_chat_daily d WHERE d.member = u.email AND d.family_id <> $3 AND ${chatDays(30)}) AS chat30d
     FROM unnest($1::text[]) AS u(email)`,
    [emails, now.toISOString(), FAMILY_ONE]
  );
  if (!rows) throw new StoreUnavailable();
  return new Map(rows.map((r) => [String(r.email), { entries30d: Number(r.entries30d), chat30d: Number(r.chat30d) }]));
}
