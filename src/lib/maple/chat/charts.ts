import { z } from "zod";
import { dayKey, isDayKey } from "../time";
import type { Baby, Entry } from "../types";

/** Small, dated read-only snapshots. No model-authored values, notes, or record IDs. */
export const CHART_DAYS = 14;
export const CHART_GROWTH_POINTS = 60;

const date = z.string().refine(isDayKey, "Expected a local day");
const instant = z.string().datetime({ offset: true });
const timezone = z.string().max(64).refine((tz) => {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}, "Expected a timezone");
const count = z.number().finite().int().min(0).max(2000);
const hours = z.number().finite().min(0).max(72);
const weight = z.number().finite().positive().max(200_000);
const base = { version: z.literal(1), asOf: instant, timezone, from: date, to: date };

export const activityMetricSchema = z.enum(["feeds", "sleep", "diapers"]);
export type ActivityMetric = z.infer<typeof activityMetricSchema>;

const activitySchema = z.object({
  ...base,
  kind: z.literal("activity"),
  range: z.union([z.literal(7), z.literal(14)]),
  metric: activityMetricSchema,
  days: z.array(z.object({
    date,
    partial: z.boolean(),
    feeds: count.nullable(),
    sleepHours: hours.nullable(),
    wet: count.nullable(),
    dirty: count.nullable(),
  })).max(CHART_DAYS),
});

const growthSchema = z.object({
  ...base,
  kind: z.literal("growth"),
  birthWeightG: weight.nullable(),
  truncated: z.boolean(),
  points: z.array(z.object({
    at: instant,
    weightG: weight,
    birth: z.boolean(),
    percentile: z.number().finite().min(0).max(100).nullable(),
    percentileLabel: z.string().max(12).nullable(),
    implausible: z.boolean(),
  })).max(CHART_GROWTH_POINTS + 1),
});

export const chatChartSchema = z.discriminatedUnion("kind", [activitySchema, growthSchema]);
export type ActivityChartSnapshot = z.infer<typeof activitySchema>;
export type GrowthChartSnapshot = z.infer<typeof growthSchema>;
export type ChatChartSnapshot = z.infer<typeof chatChartSchema>;

/** Old/unknown versions fail quietly in the renderer; they never become controls. */
export function parseChatChart(value: unknown): ChatChartSnapshot | null {
  const result = chatChartSchema.safeParse(value);
  return result.success ? result.data : null;
}

const summarySchema = z.object({
  per_day: z.array(z.object({ date, partial: z.boolean().optional(), feeds: count, wet: count, dirty: count, sleep_hours: hours })).max(31),
});

/** One day of the activity chart: null where nothing of that kind was logged. */
export type ActivityDay = ActivityChartSnapshot["days"][number];

/**
 * daily_summary's `per_day` rows as the activity chart's `length` local days
 * ending `to`, or null when anything in them can't be trusted: summarySchema's
 * rules (no more than 31 rows; counts whole and 0–2000; sleep 0–72 hours), a
 * day listed twice, or a `to` that isn't a calendar day. A missing log is not
 * evidence that the baby had no feeds or sleep, so feeds, sleep, or diapers
 * with nothing logged that day are null, never 0 (a day with only a dirty
 * diaper still says 0 wet), and `to` (today) is partial.
 *
 * The MCP App view (mcp-apps/activity.ts) runs this function's own source in
 * the host's frame, so it imports and names nothing outside itself and has no
 * inner named functions (a bundler's name helpers would travel with them).
 */
export function activityDays(perDay: unknown, to: unknown, length: number): ActivityDay[] | null {
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof to !== "string" || !DAY.test(to) || !Array.isArray(perDay) || perDay.length > 31) return null;
  const rows = new Map<string, { partial: boolean; feeds: number; sleep: number; wet: number; dirty: number }>();
  for (const raw of perDay as unknown[]) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    if (typeof row.date !== "string" || !DAY.test(row.date) || rows.has(row.date)) return null;
    if (row.partial !== undefined && typeof row.partial !== "boolean") return null;
    if (![row.feeds, row.wet, row.dirty].every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 2000)) return null;
    if (typeof row.sleep_hours !== "number" || !Number.isFinite(row.sleep_hours) || row.sleep_hours < 0 || row.sleep_hours > 72) return null;
    rows.set(row.date, { partial: row.partial === true, feeds: row.feeds as number, sleep: row.sleep_hours, wet: row.wet as number, dirty: row.dirty as number });
  }
  const [year, month, day] = to.split("-").map(Number);
  const days: ActivityDay[] = [];
  for (let back = length - 1; back >= 0; back--) {
    const at = new Date(Date.UTC(year, month - 1, day - back));
    const date = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-${String(at.getUTCDate()).padStart(2, "0")}`;
    const row = rows.get(date);
    const diapers = !!row && row.wet + row.dirty > 0;
    days.push({
      date,
      partial: date === to || !!row?.partial,
      feeds: row && row.feeds > 0 ? row.feeds : null,
      sleepHours: row && row.sleep > 0 ? row.sleep : null,
      wet: diapers ? row.wet : null,
      dirty: diapers ? row.dirty : null,
    });
  }
  return days.length > 0 && days[days.length - 1].date === to ? days : null;
}

export function buildActivityChart(summary: unknown, opts: { now: Date; timezone: string; range?: 7 | 14; metric?: ActivityMetric }): ActivityChartSnapshot {
  const rows = summarySchema.parse(summary).per_day;
  const to = dayKey(opts.now, opts.timezone);
  // summarySchema has already held the rows to activityDays's rules; what's left for it to refuse is a day listed twice.
  const days = activityDays(rows, to, CHART_DAYS);
  if (!days) throw new Error("Duplicate chart day");
  return activitySchema.parse({ version: 1, kind: "activity", asOf: opts.now.toISOString(), timezone: opts.timezone, from: days[0].date, to, range: opts.range ?? 7, metric: opts.metric ?? "feeds", days });
}

/** Uses the same WHO calculations as Growth in History; tables stay out of the chat's client bundle. */
export async function buildGrowthChart(
  baby: Pick<Baby, "born_at" | "birth_weight_g" | "sex">,
  entries: readonly Entry[],
  opts: { now: Date; timezone: string; truncated?: boolean },
): Promise<GrowthChartSnapshot> {
  const { ageInDays, readingFor } = await import("../growth");
  const to = dayKey(opts.now, opts.timezone);
  const weights = entries.filter((entry) => entry.kind === "growth" && entry.data.weight_g != null && Date.parse(entry.started_at) <= opts.now.getTime())
    .map((entry) => ({ at: entry.started_at, weightG: weight.parse(entry.kind === "growth" ? entry.data.weight_g : undefined), birth: false }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const selected = weights.slice(-CHART_GROWTH_POINTS);
  const birthWeightG = baby.birth_weight_g == null ? null : weight.parse(baby.birth_weight_g);
  if (baby.born_at && Date.parse(baby.born_at) <= opts.now.getTime() && birthWeightG != null) selected.unshift({ at: baby.born_at, weightG: birthWeightG, birth: true });
  selected.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const points = selected.map((point) => {
    const reading = baby.born_at ? readingFor("weight", point.weightG, ageInDays(baby.born_at, point.at), baby.sex) : { pct: null, implausible: false };
    return { ...point, percentile: reading.pct?.percentile ?? null, percentileLabel: reading.pct?.label ?? null, implausible: reading.implausible };
  });
  return growthSchema.parse({
    version: 1, kind: "growth", asOf: opts.now.toISOString(), timezone: opts.timezone,
    from: points.length ? dayKey(new Date(points[0].at), opts.timezone) : to, to,
    birthWeightG, truncated: !!opts.truncated || weights.length > CHART_GROWTH_POINTS, points,
  });
}
