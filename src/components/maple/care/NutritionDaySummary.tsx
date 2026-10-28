"use client";

import { foodNutritionSummary } from "@/lib/maple/care-nutrition-summary";
import type { NutrientTotal } from "@/lib/maple/care-nutrition-types";
import type { CareNutritionEntry } from "@/lib/maple/types";
import { formatVolume } from "@/lib/maple/units";
import { cx, tone } from "../ui";
import { FOOD_GROUP_LABELS } from "./FoodItemsFields";

export function NutritionDaySummary({ entries, units }: { entries: CareNutritionEntry[]; units: "us" | "metric" }) {
  const nutrition = foodNutritionSummary(entries);
  const food = entries.filter((entry) => entry.kind === "food");
  const meals = food.filter((entry) => entry.data.meal === "meal").length;
  const drinks = entries.filter((entry) => entry.kind === "drink");
  const measured = drinks.filter((entry) => entry.data.amount_ml != null);
  const totalMl = measured.reduce((sum, entry) => sum + (entry.data.amount_ml ?? 0), 0);
  return <section aria-label="Recorded nutrition" className={cx(tone.card, "space-y-3 p-4")}>
    <div className="flex flex-wrap items-baseline justify-between gap-1">
      <p className={tone.label}>Recorded nutrition</p>
      <p className={cx(tone.muted, "text-[12px]")}>{meals} {meals === 1 ? "meal" : "meals"} · {food.length - meals} {food.length - meals === 1 ? "snack" : "snacks"}</p>
    </div>
    <dl className="grid grid-cols-3 gap-3">
      <NutrientStat name="Protein" value={nutrition.nutrients.protein_g} count={nutrition.itemCount} />
      <NutrientStat name="Fiber" value={nutrition.nutrients.fiber_g} count={nutrition.itemCount} />
      <div><dt className={cx(tone.muted, "text-[13px]")}>Fluids</dt><dd className={cx(tone.body, "mt-1 text-[18px] font-semibold tabular-nums")}>{measured.length ? formatVolume(totalMl, units) : "Unknown"}</dd><dd className={cx(tone.faint, "mt-1 text-[11px] leading-snug")}>{measured.length} measured{drinks.length > measured.length ? ` · ${drinks.length - measured.length} without amount` : ""}</dd></div>
    </dl>
    <p className={cx(tone.muted, "text-[12px] leading-relaxed")}>Only what you logged.{nutrition.unassessedEntries > 0 ? ` ${nutrition.unassessedEntries} food ${nutrition.unassessedEntries === 1 ? "entry has" : "entries have"} no nutrition details.` : " Blank details are not counted as zero."}</p>
    <div className="border-t border-mp-line pt-3">
      <p className={cx(tone.label, "mb-1")}>Food variety</p>
      <p className={cx(tone.muted, "text-[13px] leading-relaxed")}>{nutrition.groups.length ? nutrition.groups.map((group) => FOOD_GROUP_LABELS[group]).join(" · ") : nutrition.assessedGroupItems ? "No groups selected" : "Food groups not added"}</p>
      {nutrition.unknownGroupItems > 0 && <p className={cx(tone.faint, "mt-1 text-[12px]")}>{nutrition.unknownGroupItems} {nutrition.unknownGroupItems === 1 ? "food has" : "foods have"} unassessed groups.</p>}
    </div>
  </section>;
}

function NutrientStat({ name, value, count }: { name: string; value: NutrientTotal; count: number }) {
  return <div><dt className={cx(tone.muted, "text-[13px]")}>{name}</dt>
    <dd className={cx(tone.body, "mt-1 text-[18px] font-semibold tabular-nums")}>{value.total == null ? "Unknown" : `${Math.round(value.total * 10) / 10} g`}</dd>
    <dd className={cx(tone.faint, "mt-1 text-[11px] leading-snug")}>{value.knownItems} of {count} foods{value.estimatedItems ? ` · ${value.estimatedItems} estimated` : ""}</dd>
  </div>;
}
