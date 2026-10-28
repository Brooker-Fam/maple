import { FOOD_GROUPS, NUTRIENT_KEYS, type FoodGroup, type FoodNutritionSummary } from "./care-nutrition-types";
import type { CareEntry } from "./types";

export function foodNutritionSummary(entries: readonly CareEntry[]): FoodNutritionSummary {
  const summary: FoodNutritionSummary = {
    nutrients: Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, { total: null, knownItems: 0, estimatedItems: 0 }])) as FoodNutritionSummary["nutrients"],
    groups: [],
    itemCount: 0,
    unassessedEntries: 0,
    assessedGroupItems: 0,
    unknownGroupItems: 0,
  };
  const groups = new Set<FoodGroup>();
  for (const entry of entries) {
    if (entry.kind !== "food") continue;
    if (!entry.data.items?.length) {
      summary.unassessedEntries++;
      continue;
    }
    for (const item of entry.data.items) {
      summary.itemCount++;
      if (Array.isArray(item.groups)) {
        summary.assessedGroupItems++;
        for (const group of item.groups) groups.add(group);
      } else summary.unknownGroupItems++;
      for (const key of NUTRIENT_KEYS) {
        const value = item.nutrients?.[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
        const nutrient = summary.nutrients[key];
        nutrient.total = (nutrient.total ?? 0) + value;
        nutrient.knownItems++;
        if (item.source === "estimate") nutrient.estimatedItems++;
      }
    }
  }
  summary.groups = FOOD_GROUPS.filter((group) => groups.has(group));
  return summary;
}
