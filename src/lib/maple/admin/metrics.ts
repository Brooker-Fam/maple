import { query } from "@/lib/db";
import { FAMILY_ONE } from "../family";
import { StoreUnavailable } from "../store";
import type { AdminMetrics } from "./types";
import { readAdminUsage } from "./usage";

/**
 * Operator-only aggregate read. Call only after the metrics-admin check.
 * Counts describe records that still exist, not a historical signup ledger.
 * Rolling windows end at `now`; the chart has 30 UTC calendar days including
 * today. "Active" family status means setup completed, not recent usage.
 * What families use (admin/usage.ts) and feedback counts come with it.
 */
export async function readAdminMetrics(now = new Date()): Promise<AdminMetrics> {
  const at = now.toISOString();
  const [rows, usage] = await Promise.all([query(
    `WITH families AS (
       SELECT id, status, created_at FROM maple_families WHERE id <> $1
     ), members AS (
       SELECT m.email, m.family_id, m.last_seen_at
       FROM maple_members m JOIN families f ON f.id = m.family_id
       WHERE m.accepted_at IS NOT NULL AND m.email <> 'admin'
     ), days AS (
       SELECT generate_series(
         ($2::timestamptz AT TIME ZONE 'UTC')::date - 29,
         ($2::timestamptz AT TIME ZONE 'UTC')::date,
         INTERVAL '1 day'
       )::date AS day
     ), daily AS (
       SELECT d.day, COUNT(f.id)::int AS count
       FROM days d LEFT JOIN families f
         ON (f.created_at AT TIME ZONE 'UTC')::date = d.day AND f.created_at <= $2::timestamptz
       GROUP BY d.day
     )
     SELECT jsonb_build_object(
       'generatedAt', $2::text,
       'families', (SELECT jsonb_build_object(
         'total', COUNT(*)::int,
         'signedUp7d', COUNT(*) FILTER (WHERE created_at > $2::timestamptz - INTERVAL '168 hours' AND created_at <= $2::timestamptz)::int,
         'signedUp30d', COUNT(*) FILTER (WHERE created_at > $2::timestamptz - INTERVAL '720 hours' AND created_at <= $2::timestamptz)::int,
         'onboarding', COUNT(*) FILTER (WHERE status = 'onboarding')::int,
         'setupComplete', COUNT(*) FILTER (WHERE status = 'active')::int,
         'deleting', COUNT(*) FILTER (WHERE status = 'deleting')::int
       ) FROM families),
       'people', (SELECT jsonb_build_object('total', COUNT(DISTINCT email)::int)
         FROM members WHERE email NOT LIKE 'invite:%'),
       'activity', jsonb_build_object(
         'families7d', (SELECT COUNT(DISTINCT family_id)::int FROM members
           WHERE last_seen_at > $2::timestamptz - INTERVAL '168 hours' AND last_seen_at <= $2::timestamptz),
         'families30d', (SELECT COUNT(DISTINCT family_id)::int FROM members
           WHERE last_seen_at > $2::timestamptz - INTERVAL '720 hours' AND last_seen_at <= $2::timestamptz),
         'entries30d', (SELECT COUNT(*)::int FROM maple_entries e JOIN families f ON f.id = e.family_id
           WHERE e.deleted_at IS NULL AND e.created_at > $2::timestamptz - INTERVAL '720 hours' AND e.created_at <= $2::timestamptz)
       ),
       'waitlist', (SELECT jsonb_build_object('total', COUNT(*)::int) FROM maple_waitlist),
       'dailySignups', (SELECT jsonb_agg(jsonb_build_object('date', to_char(day, 'YYYY-MM-DD'), 'count', count) ORDER BY day) FROM daily)
     ) AS metrics`,
    [FAMILY_ONE, at]
  ), readAdminUsage(now)]);
  if (!rows?.[0]?.metrics) throw new StoreUnavailable();
  return { ...(rows[0].metrics as Omit<AdminMetrics, "usage" | "feedback">), ...usage, generatedAt: at };
}
