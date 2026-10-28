import type { CareDataByKind } from "./types";
import { FOOD_GROUPS, NUTRIENT_KEYS, type CareFoodItem, type FoodGroup, type NutrientKey } from "./care-nutrition-types";

export const FOOD_ITEM_LIMITS = { items: 12, name: 120, portion: 120, note: 500 } as const;
export const NUTRIENT_LIMITS: Record<NutrientKey, number> = { protein_g: 500, fiber_g: 150, carbs_g: 500, fat_g: 500, energy_kcal: 5000 };

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Add valid ${label}.`);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Add ${label}.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`Keep ${label} under ${max + 1} characters.`);
  return trimmed;
}

function optionalText(value: unknown, max: number, label: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || value.trim().length > max) throw new Error(`Keep ${label} under ${max + 1} characters.`);
  return value.trim() || null;
}

function cleanNutrients(value: unknown): CareFoodItem["nutrients"] {
  const input = value === undefined ? {} : record(value, "nutrient details");
  const nutrients: CareFoodItem["nutrients"] = {};
  for (const key of NUTRIENT_KEYS) {
    const amount = input[key];
    if (amount === undefined) continue;
    if (amount !== null && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > NUTRIENT_LIMITS[key])) {
      throw new Error(`${key} must be from 0 to ${NUTRIENT_LIMITS[key]}, or left unknown.`);
    }
    nutrients[key] = amount;
  }
  return nutrients;
}

function cleanGroups(value: unknown): FoodGroup[] | null {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > FOOD_GROUPS.length || value.some((group) => !FOOD_GROUPS.includes(group))) {
    throw new Error("Choose recognized food groups, or leave them unknown.");
  }
  return [...new Set(value)] as FoodGroup[];
}

export function cleanCareFoodItems(value: unknown): CareFoodItem[] {
  if (!Array.isArray(value) || value.length > FOOD_ITEM_LIMITS.items) throw new Error(`Add at most ${FOOD_ITEM_LIMITS.items} foods.`);
  return value.map((raw) => {
    const item = record(raw, "food details");
    if (item.source !== "estimate" && item.source !== "label" && item.source !== "manual") throw new Error("Say whether food details are estimated, from a label or entered manually.");
    return {
      name: requiredText(item.name, FOOD_ITEM_LIMITS.name, "the food name"),
      portion: optionalText(item.portion, FOOD_ITEM_LIMITS.portion, "the portion"),
      nutrients: cleanNutrients(item.nutrients),
      groups: cleanGroups(item.groups),
      source: item.source,
      ...(item.note === undefined ? {} : { note: optionalText(item.note, FOOD_ITEM_LIMITS.note, "the food note") }),
    };
  });
}

export function cleanCareNutritionData<K extends "food" | "drink">(kind: K, data: unknown): CareDataByKind[K] {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Add the food or drink details.");
  const d = data as Record<string, unknown>;
  if (kind === "food") {
    const description = requiredText(d.description, 500, "what you ate");
    if (d.meal !== "meal" && d.meal !== "snack") throw new Error("Choose meal or snack.");
    return { description, meal: d.meal, ...(d.items === undefined ? {} : { items: cleanCareFoodItems(d.items) }) } as CareDataByKind[K];
  }
  const name = requiredText(d.name, 100, "what you drank");
  const amount = d.amount_ml;
  if (amount !== undefined && amount !== null && (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 5000)) {
    throw new Error("Drink amount must be more than 0 and at most 5000 mL.");
  }
  return { name, ...(amount === undefined ? {} : { amount_ml: amount }) } as CareDataByKind[K];
}
