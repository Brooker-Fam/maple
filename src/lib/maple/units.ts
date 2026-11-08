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

// ── Amounts both ways, on this phone ─────────────────────────────────────

/**
 * This phone's "Amounts in ml and oz" (Settings → This device → Units, kept by
 * useMaple's setVolumeBoth). On, formatVolume and formatVolumeRange say every
 * amount both ways, the phone's units first: "2 oz (59.1 ml)", "60 ml (2.03
 * oz)". Only the app's provider turns it on, in the browser; the server never
 * does, so Claude, the chat and Siri say what they always have (both already:
 * formatVolumeBoth). Off, every amount reads exactly as before.
 */
let volumesBothOn = false;
export function setVolumesBoth(on: boolean): void {
  volumesBothOn = on;
}
export const volumesBoth = (): boolean => volumesBothOn;

/** The other system: "us" for "metric", "metric" for "us". */
export const otherUnits = (units: UnitSystem): UnitSystem => (units === "metric" ? "us" : "metric");

/** One amount in one unit only ("2 oz", "59.1 ml"), whatever the phone shows: each half of an amount said both ways. */
export function volumeIn(ml: number | null | undefined, units: UnitSystem = "us"): string {
  if (ml == null || !Number.isFinite(ml)) return "—";
  if (units === "metric") return ml > 0 && ml < 0.05 ? "<0.1 ml" : `${trim(ml)} ml`;
  const oz = mlToOz(ml);
  if (oz > 0 && oz < 0.005) return "<0.01 oz";
  return `${trim(oz, 2)} oz`;
}

/** "2 oz" / "59.1 ml"; with this phone's both on, the other beside it: "2 oz (59.1 ml)". */
export function formatVolume(ml: number | null | undefined, units: UnitSystem = "us"): string {
  if (ml == null || !Number.isFinite(ml)) return "—";
  return volumesBothOn ? `${volumeIn(ml, units)} (${volumeIn(ml, otherUnits(units))})` : volumeIn(ml, units);
}

/** Where a line wraps at its dots (the More sheet's lines): both with a dot, "2 oz · 59.1 ml"; one unit while the phone shows one. */
export function formatVolumeShort(ml: number | null | undefined, units: UnitSystem = "us"): string {
  if (ml == null || !Number.isFinite(ml)) return "—";
  return volumesBothOn ? `${volumeIn(ml, units)} · ${volumeIn(ml, otherUnits(units))}` : volumeIn(ml, units);
}

/**
 * Where a line holds one amount (a dock tile's subline at 320px): the amount and its words ("2 oz last"); with this
 * phone's both on, the other unit on a line of its own under it ("2 oz last\n59.1 ml", shown pre-line).
 */
export function volumeLines(ml: number, units: UnitSystem, after = ""): string {
  return `${volumeIn(ml, units)}${after}${volumesBothOn ? `\n${volumeIn(ml, otherUnits(units))}` : ""}`;
}

/**
 * An amount field's number for an amount in ml, in the field's unit: ml to
 * 0.1, oz to 0.01 (a tiny one to 3 figures, so it never reads 0). What a typed
 * number saves is fieldMl.
 */
export function fieldAmount(ml: number, units: UnitSystem): number {
  if (units === "metric") return Math.round(ml * 10) / 10;
  const oz = mlToOz(ml);
  return Number(oz > 0 && oz < 0.01 ? oz.toPrecision(3) : oz.toFixed(2));
}

/** What a number typed in a field's unit saves: ml, to 0.1. */
export const fieldMl = (shown: number, units: UnitSystem): number => Math.round((units === "metric" ? shown : ozToMl(shown)) * 10) / 10;

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
  return `${volumeIn(ml, "us")} (${volumeIn(ml, "metric")})`;
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

/** A range in one unit only ("50–70 ml", "1.69–2.37 oz", one amount when it's one number), whatever the phone shows. */
export function volumeRangeIn(t: FeedTarget, units: UnitSystem = "us"): string {
  if (t.min === t.max) return volumeIn(t.min, units);
  if (units === "metric") return `${trim(t.min)}–${trim(t.max)} ml`;
  return `${trim(mlToOz(t.min), 2)}–${trim(mlToOz(t.max), 2)} oz`;
}

/**
 * "50–70 ml", "1.69–2.37 oz", or one amount ("50 ml") when the range is one
 * number; with this phone's both on, the other beside it: "50–70 ml
 * (1.69–2.37 oz)".
 */
export function formatVolumeRange(t: FeedTarget, units: UnitSystem = "us"): string {
  return volumesBothOn ? `${volumeRangeIn(t, units)} (${volumeRangeIn(t, otherUnits(units))})` : volumeRangeIn(t, units);
}

/** Both systems, for Claude: "50–70 ml (1.69–2.37 oz)". */
export function formatVolumeRangeBoth(t: FeedTarget): string {
  return `${volumeRangeIn(t, "metric")} (${volumeRangeIn(t, "us")})`;
}

/**
 * The target per feed the family typed, from and up to, in the shown unit:
 * ml, or null when both are blank. One alone is the whole target ("50").
 * Throws a message for a typo. `exact`: the ml a number stands for while it
 * still shows an amount as it was (a saved one, or one a unit switch moved),
 * so it saves as that amount, never re-rounded through the other unit.
 */
export function feedTargetFrom(from: string, to: string, units: UnitSystem, exact?: (shown: number) => number | undefined): FeedTarget | null {
  const read = (text: string) => {
    const t = text.trim().replace(",", ".");
    if (!t) return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Enter the target per feed as ${units === "metric" ? "ml, like 45 and 60" : "oz, like 1.5 and 2"}`);
    const kept = exact?.(n);
    if (kept != null) return kept;
    return Math.round((units === "metric" ? n : ozToMl(n)) * 10) / 10;
  };
  const a = read(from);
  const b = read(to);
  if (a == null && b == null) return null;
  const lo = a ?? b!;
  const hi = b ?? a!;
  return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
}
