export const FOOD_GROUPS = ["protein", "fruit", "vegetables", "whole_grains", "dairy_or_fortified", "legumes", "nuts_seeds"] as const;
export type FoodGroup = typeof FOOD_GROUPS[number];

export const NUTRIENT_KEYS = ["protein_g", "fiber_g", "carbs_g", "fat_g", "energy_kcal"] as const;
export type NutrientKey = typeof NUTRIENT_KEYS[number];

export type CareFoodItem = {
  name: string;
  portion: string | null;
  nutrients: Partial<Record<NutrientKey, number | null>>;
  groups: FoodGroup[] | null;
  source: "estimate" | "label" | "manual";
  note?: string | null;
};

export type NutrientTotal = { total: number | null; knownItems: number; estimatedItems: number };
export type FoodNutritionSummary = {
  nutrients: Record<NutrientKey, NutrientTotal>;
  groups: FoodGroup[];
  itemCount: number;
  unassessedEntries: number;
  assessedGroupItems: number;
  unknownGroupItems: number;
};
