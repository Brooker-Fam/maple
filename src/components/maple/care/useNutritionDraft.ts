"use client";

import { useState } from "react";
import { cleanCareFoodItems } from "@/lib/maple/care-nutrition-validation";
import type { CareFoodItem } from "@/lib/maple/care-nutrition-types";
import type { CareNutritionEntry, CareNutritionInput } from "@/lib/maple/types";
import { mlToOz, ozToMl } from "@/lib/maple/units";
import { parseTypedNumber } from "../uiFields";
import { useMaple } from "../useMaple";
import { foodItemsValid } from "./FoodItemsFields";

function amountText(entry: CareNutritionEntry | undefined, units: "us" | "metric"): string {
  const value = entry?.kind === "drink" ? entry.data.amount_ml : null;
  return value == null ? "" : String(units === "metric" ? value : Math.round(mlToOz(value) * 100) / 100);
}

export function useNutritionDraft(kind: "food" | "drink", entry?: CareNutritionEntry) {
  const { now, units } = useMaple();
  const [editUnits] = useState(units);
  const [base, setBase] = useState(entry);
  const [description, setDescription] = useState(entry?.kind === "food" ? entry.data.description : "");
  const [meal, setMeal] = useState<"meal" | "snack">(entry?.kind === "food" ? entry.data.meal : "meal");
  const [items, setItems] = useState<CareFoodItem[]>(entry?.kind === "food" ? entry.data.items ?? [] : []);
  const [name, setName] = useState(entry?.kind === "drink" ? entry.data.name : "");
  const [amount, setAmount] = useState(() => amountText(entry, editUnits));
  const [when, setWhen] = useState(entry ? new Date(entry.at) : now);
  const [timeInvalid, setTimeInvalid] = useState(false);
  const [showTime, setShowTime] = useState(!!entry);
  const parsed = parseTypedNumber(amount.trim() === "" ? "" : amount, Infinity);
  const volume = parsed.value;
  const amountMl = base?.kind === "drink" && amount === amountText(base, editUnits) ? base.data.amount_ml ?? null
    : volume == null ? null : editUnits === "metric" ? volume : ozToMl(volume);
  const amountInvalid = parsed.invalid || amountMl != null && (!Number.isFinite(amountMl) || amountMl <= 0 || amountMl > 5000);
  const invalid = timeInvalid || (kind === "drink" ? !name.trim() || amountInvalid : !foodItemsValid(items));
  const reset = (current: CareNutritionEntry) => {
    setBase(current);
    if (current.kind === "food") { setDescription(current.data.description); setMeal(current.data.meal); setItems(current.data.items ?? []); }
    else { setName(current.data.name); setAmount(amountText(current, editUnits)); }
    setWhen(new Date(current.at));
    setTimeInvalid(false);
  };
  const input = (): CareNutritionInput => {
    const at = showTime ? when.toISOString() : now().toISOString();
    if (kind === "drink") return { kind, at, data: { name: name.trim(), amount_ml: amountMl }, note: base?.note };
    const hasItems = items.length > 0 || (base?.kind === "food" && base.data.items !== undefined);
    return { kind, at, data: { description: description.trim() || (meal === "snack" ? "Snack" : "Meal"), meal, ...(hasItems ? { items: cleanCareFoodItems(items) } : {}) }, note: base?.note };
  };
  return { base, description, setDescription, meal, setMeal, items, setItems, name, setName, amount, setAmount, when, setWhen, timeInvalid, setTimeInvalid, showTime, setShowTime, amountInvalid, invalid, editUnits, reset, input };
}
