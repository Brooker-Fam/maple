import type { CareDataByKind } from "./types";

function requiredText(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Add ${label}.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`Keep ${label} under ${max + 1} characters.`);
  return trimmed;
}

export function cleanCareNutritionData<K extends "food" | "drink">(kind: K, data: unknown): CareDataByKind[K] {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Add the food or drink details.");
  const d = data as Record<string, unknown>;
  if (kind === "food") {
    const description = requiredText(d.description, 500, "what you ate");
    if (d.meal !== "meal" && d.meal !== "snack") throw new Error("Choose meal or snack.");
    return { description, meal: d.meal } as CareDataByKind[K];
  }
  const name = requiredText(d.name, 100, "what you drank");
  const amount = d.amount_ml;
  if (amount !== undefined && amount !== null && (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 5000)) {
    throw new Error("Drink amount must be more than 0 and at most 5000 mL.");
  }
  return { name, ...(amount === undefined ? {} : { amount_ml: amount }) } as CareDataByKind[K];
}
