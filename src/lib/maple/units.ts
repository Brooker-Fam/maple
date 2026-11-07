/**
 * Unit conversion and display for Maple's Log. Everything is stored metric;
 * the family reads lb/oz, inches, °F and fl oz by default ("us").
 */
import type { UnitSystem } from "./types";

export const G_PER_LB = 453.59237;
export const G_PER_OZ = G_PER_LB / 16;
export const CM_PER_IN = 2.54;
export const ML_PER_FL_OZ = 29.5735295625;

export const lbOzToGrams = (lb: number, oz = 0) => lb * G_PER_LB + oz * G_PER_OZ;
export const kgToGrams = (kg: number) => kg * 1000;
export const inToCm = (inches: number) => inches * CM_PER_IN;
export const cmToIn = (cm: number) => cm / CM_PER_IN;
export const fToC = (f: number) => ((f - 32) * 5) / 9;
export const cToF = (c: number) => (c * 9) / 5 + 32;
export const ozToMl = (oz: number) => oz * ML_PER_FL_OZ;
export const mlToOz = (ml: number) => ml / ML_PER_FL_OZ;

/** 3345 g → { lb: 7, oz: 6.0 } (oz to one decimal, carried into lb at 16). */
export function gramsToLbOz(g: number): { lb: number; oz: number } {
  const totalOz = Math.round((g / G_PER_OZ) * 10) / 10;
  const lb = Math.floor(totalOz / 16);
  const oz = Math.round((totalOz - lb * 16) * 10) / 10;
  return oz >= 16 ? { lb: lb + 1, oz: 0 } : { lb, oz };
}

const trim = (n: number, digits = 1) => {
  const s = n.toFixed(digits);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
};

/** "7 lb 6 oz" / "3.35 kg". */
export function formatWeight(g: number | null | undefined, units: UnitSystem = "us"): string {
  if (g == null || !Number.isFinite(g)) return "—";
  if (units === "metric") return g < 1000 ? `${Math.round(g)} g` : `${trim(g / 1000, 2)} kg`;
  const { lb, oz } = gramsToLbOz(g);
  return `${lb} lb ${trim(oz)} oz`;
}

/** Weight change with a sign: "+5.2 oz" / "+150 g". */
export function formatWeightDelta(g: number, units: UnitSystem = "us"): string {
  const sign = g > 0 ? "+" : g < 0 ? "−" : "±";
  const abs = Math.abs(g);
  if (units === "metric") return `${sign}${Math.round(abs)} g`;
  const oz = abs / G_PER_OZ;
  if (oz < 16) return `${sign}${trim(oz)} oz`;
  const { lb, oz: rem } = gramsToLbOz(abs);
  return `${sign}${lb} lb ${trim(rem)} oz`;
}

/** "20.5 in" / "52 cm". */
export function formatLength(cm: number | null | undefined, units: UnitSystem = "us"): string {
  if (cm == null || !Number.isFinite(cm)) return "—";
  return units === "metric" ? `${trim(cm)} cm` : `${trim(cmToIn(cm), 2)} in`;
}

/** "100.4°F" / "38.0°C". */
export function formatTemp(c: number | null | undefined, units: UnitSystem = "us"): string {
  if (c == null || !Number.isFinite(c)) return "—";
  return units === "metric" ? `${c.toFixed(1)}°C` : `${cToF(c).toFixed(1)}°F`;
}

export function formatVolume(ml: number | null | undefined, units: UnitSystem = "us"): string {
  if (ml == null || !Number.isFinite(ml)) return "—";
  if (units === "metric") return ml > 0 && ml < 0.05 ? "<0.1 ml" : `${trim(ml)} ml`;
  const oz = mlToOz(ml);
  if (oz > 0 && oz < 0.005) return "<0.01 oz";
  return `${trim(oz, 2)} oz`;
}

/** Both systems, for MCP responses: "7 lb 6 oz (3.35 kg)". */
export function formatWeightBoth(g: number): string {
  return `${formatWeight(g, "us")} (${formatWeight(g, "metric")})`;
}
export function formatLengthBoth(cm: number): string {
  return `${formatLength(cm, "us")} (${formatLength(cm, "metric")})`;
}
export function formatTempBoth(c: number): string {
  return `${formatTemp(c, "us")} (${formatTemp(c, "metric")})`;
}
export function formatVolumeBoth(ml: number): string {
  return `${formatVolume(ml, "us")} (${formatVolume(ml, "metric")})`;
}

// ── a feed's target, from the family's care team ─────────────────────────

/** A target per feed in ml (settings.feed_target_ml): typed by the family from their care team, never Maple's own number. */
export type FeedTarget = { min: number; max: number };

/** The saved target per feed, when it's a well-formed one (validate.ts checkFeedTarget keeps it so); null otherwise. */
export function feedTargetOf(settings: Record<string, unknown> | null | undefined): FeedTarget | null {
  const t = settings?.feed_target_ml as { min?: unknown; max?: unknown } | null | undefined;
  if (!t || typeof t !== "object") return null;
  const { min, max } = t;
  if (typeof min !== "number" || typeof max !== "number" || !Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) return null;
  return { min, max };
}

/** "45–60 ml", "1.5–2 oz", or one amount ("50 ml") when the range is one number. */
export function formatVolumeRange(t: FeedTarget, units: UnitSystem = "us"): string {
  if (t.min === t.max) return formatVolume(t.min, units);
  if (units === "metric") return `${trim(t.min)}–${trim(t.max)} ml`;
  return `${trim(mlToOz(t.min), 2)}–${trim(mlToOz(t.max), 2)} oz`;
}

/** Both systems, for Claude: "45–60 ml (1.5–2 oz)". */
export function formatVolumeRangeBoth(t: FeedTarget): string {
  return `${formatVolumeRange(t, "metric")} (${formatVolumeRange(t, "us")})`;
}

/**
 * The target per feed the family typed, from and up to, in the shown unit:
 * ml, or null when both are blank. One alone is the whole target ("50").
 * Throws a message for a typo.
 */
export function feedTargetFrom(from: string, to: string, units: UnitSystem): FeedTarget | null {
  const read = (text: string) => {
    const t = text.trim().replace(",", ".");
    if (!t) return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Enter the target per feed as ${units === "metric" ? "ml, like 45 and 60" : "oz, like 1.5 and 2"}`);
    return Math.round((units === "metric" ? n : ozToMl(n)) * 10) / 10;
  };
  const a = read(from);
  const b = read(to);
  if (a == null && b == null) return null;
  const lo = a ?? b!;
  const hi = b ?? a!;
  return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
}
