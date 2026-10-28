import { z } from "zod";
import { addDays, dayKey, isDayKey } from "../time";
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

export function buildActivityChart(summary: unknown, opts: { now: Date; timezone: string; range?: 7 | 14; metric?: ActivityMetric }): ActivityChartSnapshot {
  const rows = summarySchema.parse(summary).per_day;
  const to = dayKey(opts.now, opts.timezone);
  const from = addDays(to, 1 - CHART_DAYS);
  const byDay = new Map(rows.map((row) => [row.date, row]));
  if (byDay.size !== rows.length) throw new Error("Duplicate chart day");
  const days = Array.from({ length: CHART_DAYS }, (_, i) => {
    const date = addDays(from, i);
    const row = byDay.get(date);
    const diapers = !!row && row.wet + row.dirty > 0;
    return {
      date,
      partial: date === to || !!row?.partial,
      // A missing log is not evidence that the baby had no feeds or sleep.
      feeds: row && row.feeds > 0 ? row.feeds : null,
      sleepHours: row && row.sleep_hours > 0 ? row.sleep_hours : null,
      wet: diapers ? row!.wet : null,
      dirty: diapers ? row!.dirty : null,
    };
  });
  return activitySchema.parse({ version: 1, kind: "activity", asOf: opts.now.toISOString(), timezone: opts.timezone, from, to, range: opts.range ?? 7, metric: opts.metric ?? "feeds", days });
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
