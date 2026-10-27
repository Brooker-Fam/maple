import { familyBudgets, globalMonthlyCeiling } from "../chat/caps";
import { familiesPerDay } from "../family/limits";
import { dayKey, startOfDay } from "../time";
import { FAMILY_UPLOAD_LIMITS } from "../upload-quota";
import type { Metric } from "./policy";
import { rows } from "./store";

function monthBefore(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 2, 1)).toISOString().slice(0, 7);
}

export async function usageMetrics(now: Date, env: Record<string, string | undefined> = process.env): Promise<Metric[]> {
  const utcDay = now.toISOString().slice(0, 10);
  const previousDay = new Date(now.getTime() - 24 * 3_600_000).toISOString().slice(0, 10);
  const days = [previousDay, utcDay];
  const utcMonth = utcDay.slice(0, 7);
  const family = (await rows(`SELECT timezone, ai_monthly_micro FROM maple_families WHERE id = 1`))[0];
  if (!family) throw new Error("usage_alerts_family_missing");
  const localMonth = dayKey(now, String(family.timezone)).slice(0, 7);
  const utcMonths = [monthBefore(utcMonth), utcMonth];
  const localMonths = [monthBefore(localMonth), localMonth];
  const monthStart = startOfDay(`${localMonth}-01`, String(family.timezone));
  const [cost, uploads, photos, signups] = await Promise.all([
    rows(`SELECT
      COALESCE(SUM(cost_micro_usd) FILTER (WHERE created_at >= $1 AND (family_id IS NULL OR family_id <> 1)), 0) AS others,
      COALESCE(SUM(cost_micro_usd) FILTER (WHERE created_at >= $2 AND (family_id = 1 OR (family_id IS NULL AND NOT EXISTS (SELECT 1 FROM maple_families WHERE id <> 1)))), 0) AS family_one,
      COALESCE(SUM(cost_micro_usd) FILTER (WHERE created_at >= $4 AND created_at < $1 AND (family_id IS NULL OR family_id <> 1)), 0) AS others_previous,
      COALESCE(SUM(cost_micro_usd) FILTER (WHERE created_at >= $5 AND created_at < $2 AND (family_id = 1 OR (family_id IS NULL AND NOT EXISTS (SELECT 1 FROM maple_families WHERE id <> 1)))), 0) AS family_one_previous
      FROM maple_ai_usage WHERE created_at <= $3 AND created_at >= LEAST($4, $5)`, [`${utcMonth}-01T00:00:00.000Z`, monthStart.toISOString(), now.toISOString(), `${utcMonths[0]}-01T00:00:00.000Z`, startOfDay(`${localMonths[0]}-01`, String(family.timezone)).toISOString()]),
    rows(`SELECT COALESCE(SUM(tokens) FILTER (WHERE day = $1::date), 0) AS previous,
      COALESCE(SUM(tokens) FILTER (WHERE day = $2::date), 0) AS today,
      COALESCE(SUM(tokens), 0) AS total FROM maple_upload_counts WHERE family_id <> 1`, days),
    rows(`SELECT f.id,
      COALESCE((SELECT SUM(jsonb_array_length(CASE WHEN jsonb_typeof(data->'photos') = 'array' THEN data->'photos' ELSE '[]'::jsonb END))
        FROM maple_entries WHERE family_id = f.id AND kind = 'moment'), 0) AS photos
      FROM maple_families f WHERE f.id <> 1`),
    rows(`SELECT period::text, COALESCE(MAX((SELECT COUNT(*) FROM maple_families recent
        WHERE recent.id <> 1 AND recent.created_at > arrival.created_at - INTERVAL '1 day' AND recent.created_at <= arrival.created_at)), 0) AS n
      FROM (VALUES ($1::date), ($2::date)) AS days(period)
      LEFT JOIN maple_families arrival ON arrival.id <> 1 AND arrival.created_at >= period::timestamp AT TIME ZONE 'UTC'
        AND arrival.created_at < (period + 1)::timestamp AT TIME ZONE 'UTC' AND arrival.created_at <= $3
      GROUP BY period ORDER BY period`, [...days, now.toISOString()]),
  ]);
  const budget = familyBudgets({ day: null, month: family.ai_monthly_micro === null ? null : BigInt(String(family.ai_monthly_micro)) }, { familyOne: true }, env);
  return [
    ...utcMonths.map((month, i): Metric => ({ key: "chat/others", label: "Other families' chat", period: month, used: BigInt(String(cost[0][i ? "others" : "others_previous"])), limit: globalMonthlyCeiling(env), money: true })),
    ...localMonths.map((month, i): Metric => ({ key: "chat/family-1", label: "Family 1 chat", period: month, used: BigInt(String(cost[0][i ? "family_one" : "family_one_previous"])), limit: budget.month, money: true })),
    ...signups.map((day): Metric => ({ key: "signup", label: "Peak sign-ups in a rolling 24 hours", period: String(day.period), used: BigInt(String(day.n)), limit: BigInt(familiesPerDay(env.MAPLE_SIGNUP_DAILY_MAX)) })),
    ...days.map((day, i): Metric => ({ key: "uploads/others/daily", label: "Other families' upload tokens", period: day, used: BigInt(String(uploads[0][i ? "today" : "previous"])), limit: BigInt(FAMILY_UPLOAD_LIMITS.tokensPerDay) })),
    { key: "uploads/others/total", label: "Other families' lifetime upload tokens", period: "lifetime", used: BigInt(String(uploads[0].total)), limit: BigInt(FAMILY_UPLOAD_LIMITS.tokensTotal) },
    ...photos.flatMap((family): Metric[] => [
      { key: `photos/${family.id}`, label: `Family ${family.id} saved photos`, period: "lifetime", used: BigInt(String(family.photos)), limit: BigInt(FAMILY_UPLOAD_LIMITS.photos) },
    ]),
  ];
}
