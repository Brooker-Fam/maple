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

/** "3 oz" / "90 ml" (oz to the nearest quarter, ml to the nearest 5). */
export function formatVolume(ml: number | null | undefined, units: UnitSystem = "us"): string {
  if (ml == null || !Number.isFinite(ml)) return "—";
  if (units === "metric") return `${Math.round(ml / 5) * 5 || Math.round(ml)} ml`;
  const oz = Math.round(mlToOz(ml) * 4) / 4;
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
