/**
 * Growth percentiles against the WHO Child Growth Standards (0–24 months),
 * which are published separately for girls and boys. The tables are ~120 KB,
 * so client code should load this module lazily (the growth chart does)
 * rather than from the main /maple bundle.
 *
 * Math per WHO "Methods and development" (2006): LMS z-scores, with the
 * restricted tail adjustment beyond ±3 SD for weight only.
 */
import type { Baby } from "./types";
import { WHO_BOYS } from "./who-boys";
import { WHO_GIRLS, type WhoTables } from "./who-girls";

export type Measure = "weight" | "length" | "head";
export type WhoChart = "girls" | "boys";

const TABLES: Record<WhoChart, WhoTables> = { girls: WHO_GIRLS, boys: WHO_BOYS };

/** No sex, no chart: the standards differ enough that a guess would misplace every percentile. */
export function whoChartFor(sex: Baby["sex"] | undefined): WhoChart | null {
  return sex === "female" ? "girls" : sex === "male" ? "boys" : null;
}

const MAX_DAY = 730;
const DAY_MS = 86_400_000;

/** WHO Anthro's implausible-value limits: likely a typo or a lb/kg mix-up. */
const FLAG_LIMITS: Record<Measure, [number, number]> = {
  weight: [-6, 5],
  length: [-6, 6],
  head: [-5, 5],
};

function lms(chart: WhoChart, measure: Measure, ageDays: number): [number, number, number] | null {
  if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > MAX_DAY) return null;
  const rows = TABLES[chart][measure].rows;
  const lo = Math.floor(ageDays);
  const hi = Math.min(lo + 1, MAX_DAY);
  const f = ageDays - lo;
  const a = rows[lo];
  const b = rows[hi];
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
}

function valueAt(L: number, M: number, S: number, z: number): number {
  return L === 0 ? M * Math.exp(S * z) : M * Math.pow(1 + L * S * z, 1 / L);
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/**
 * z-score for a measurement in WHO units (kg for weight, cm otherwise).
 * Returns null outside 0–730 days, or with no chart.
 */
export function zScore(measure: Measure, value: number, ageDays: number, chart: WhoChart | null): number | null {
  const p = chart ? lms(chart, measure, ageDays) : null;
  if (!p || !(value > 0)) return null;
  const [L, M, S] = p;
  const z = L === 0 ? Math.log(value / M) / S : (Math.pow(value / M, L) - 1) / (L * S);
  if (measure !== "weight" || Math.abs(z) <= 3) return z;
  if (z > 3) {
    const sd3 = valueAt(L, M, S, 3);
    const sd2 = valueAt(L, M, S, 2);
    return 3 + (value - sd3) / (sd3 - sd2);
  }
  const sd3 = valueAt(L, M, S, -3);
  const sd2 = valueAt(L, M, S, -2);
  return -3 + (value - sd3) / (sd2 - sd3);
}

export type Percentile = {
  z: number;
  /** 0–100, one decimal. */
  percentile: number;
  /** "52nd", "<1st", ">99th". */
  label: string;
  /** A z this far out is more likely a typo than a measurement. */
  implausible: boolean;
};

function ordinal(n: number): string {
  const r = Math.round(n);
  const tens = r % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][r % 10] ?? "th";
  return `${r}${suffix}`;
}

/** Measurement in storage units (grams for weight, cm otherwise). */
export function percentileFor(measure: Measure, stored: number, ageDays: number, chart: WhoChart | null): Percentile | null {
  const value = measure === "weight" ? stored / 1000 : stored;
  const z = zScore(measure, value, ageDays, chart);
  if (z === null) return null;
  const pct = Math.round(normalCdf(z) * 1000) / 10;
  const [lo, hi] = FLAG_LIMITS[measure];
  const label = pct < 1 ? "<1st" : pct > 99 ? ">99th" : ordinal(pct);
  return { z, percentile: pct, label, implausible: z < lo || z > hi };
}

/** For a baby with no chart: implausible on both standards is a likely typo whichever one applies. */
export function implausibleOnBoth(measure: Measure, stored: number, ageDays: number): boolean {
  return (["girls", "boys"] as const).every((c) => percentileFor(measure, stored, ageDays, c)?.implausible === true);
}

/** A measurement read against the baby's own standard; with no sex set, no percentile and only the both-standards check. */
export function readingFor(
  measure: Measure,
  stored: number,
  ageDays: number,
  sex: Baby["sex"] | undefined
): { pct: Percentile | null; implausible: boolean } {
  const chart = whoChartFor(sex);
  const pct = percentileFor(measure, stored, ageDays, chart);
  return { pct, implausible: chart ? !!pct?.implausible : implausibleOnBoth(measure, stored, ageDays) };
}

/** Fractional days between birth and a measurement (clamped at 0). */
export function ageInDays(bornAt: string | Date, at: string | Date): number {
  return Math.max(0, (new Date(at).getTime() - new Date(bornAt).getTime()) / DAY_MS);
}

/** The WHO percentile lines charts usually show. */
export const CURVE_PERCENTILES = [3, 15, 50, 85, 97] as const;
const CURVE_Z: Record<(typeof CURVE_PERCENTILES)[number], number> = {
  3: -1.880794,
  15: -1.036433,
  50: 0,
  85: 1.036433,
  97: 1.880794,
};

/**
 * Percentile curves between two ages, in storage units (grams / cm), as
 * { p, points: [ageDays, value][] }. Sampled every `step` days. None with no chart.
 */
export function curves(
  measure: Measure,
  fromDay: number,
  toDay: number,
  step: number,
  chart: WhoChart | null
): { p: (typeof CURVE_PERCENTILES)[number]; points: [number, number][] }[] {
  if (!chart) return [];
  const start = Math.max(0, Math.floor(fromDay));
  const end = Math.min(MAX_DAY, Math.ceil(toDay));
  return CURVE_PERCENTILES.map((p) => {
    const points: [number, number][] = [];
    for (let d = start; d <= end; d += step) {
      const [L, M, S] = lms(chart, measure, d)!;
      const v = valueAt(L, M, S, CURVE_Z[p]);
      points.push([d, measure === "weight" ? v * 1000 : v]);
    }
    if (points.length && points[points.length - 1][0] !== end) {
      const [L, M, S] = lms(chart, measure, end)!;
      const v = valueAt(L, M, S, CURVE_Z[p]);
      points.push([end, measure === "weight" ? v * 1000 : v]);
    }
    return { p, points };
  });
}

export const WHO_MAX_DAY = MAX_DAY;
