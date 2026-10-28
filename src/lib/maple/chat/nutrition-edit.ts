import { cleanCareNutritionData } from "../care-nutrition-validation";
import type { CareNutritionEntry, UnitSystem } from "../types";
import { mlToOz, ozToMl } from "../units";

export type NutritionDraft = { description: string; meal: "meal" | "snack"; name: string; amount: string };

export function nutritionAmountText(entry: CareNutritionEntry, units: UnitSystem): string {
  const value = entry.kind === "drink" ? entry.data.amount_ml : null;
  return value == null ? "" : String(units === "metric" ? value : Math.round(mlToOz(value) * 100) / 100);
}

/** Use the same validation as the care API; an untouched rounded amount keeps its original precision. */
export function nutritionEditData(entry: CareNutritionEntry, draft: NutritionDraft, units: UnitSystem) {
  if (entry.kind === "food") return cleanCareNutritionData("food", {
    description: draft.description.trim() || (draft.meal === "snack" ? "Snack" : "Meal"), meal: draft.meal,
  });
  const amount = draft.amount.trim() === "" ? null : Number(draft.amount);
  const amountMl = draft.amount === nutritionAmountText(entry, units) ? entry.data.amount_ml ?? null
    : amount == null ? null : units === "metric" ? amount : ozToMl(amount);
  return cleanCareNutritionData("drink", { name: draft.name, amount_ml: amountMl });
}
