"use client";

import { useState } from "react";
import { FOOD_GROUPS, type CareFoodItem, type FoodGroup, type NutrientKey } from "@/lib/maple/care-nutrition-types";
import { cleanCareFoodItems, FOOD_ITEM_LIMITS, NUTRIENT_LIMITS } from "@/lib/maple/care-nutrition-validation";
import { Button, cx, tone } from "../ui";

export const FOOD_GROUP_LABELS: Record<FoodGroup, string> = {
  protein: "Protein foods", fruit: "Fruit", vegetables: "Vegetables", whole_grains: "Whole grains",
  dairy_or_fortified: "Dairy or fortified alternatives", legumes: "Beans & lentils", nuts_seeds: "Nuts & seeds",
};
const NUTRIENT_LABELS: Record<NutrientKey, string> = {
  protein_g: "Protein (g)", fiber_g: "Fiber (g)", carbs_g: "Carbs (g)", fat_g: "Fat (g)", energy_kcal: "Energy (kcal)",
};

export function foodItemsValid(items: CareFoodItem[]): boolean {
  try { cleanCareFoodItems(items); return true; }
  catch { return false; }
}

export function FoodItemsFields({ items, onChange }: { items: CareFoodItem[]; onChange: (items: CareFoodItem[]) => void }) {
  const update = (index: number, item: CareFoodItem) => onChange(items.map((existing, i) => i === index ? item : existing));
  return <div className="space-y-3">
    <div className="space-y-1">
      <p className={tone.label}>Food details <span className={tone.faint}>(optional)</span></p>
      <p className={cx(tone.muted, "text-[13px] leading-relaxed")}>Add what you know. Blank numbers stay unknown; zero means none. Numbers are for the portion you enter.</p>
    </div>
    {items.map((item, index) => <FoodItemFields key={index} item={item} index={index} onChange={(next) => update(index, next)} onRemove={() => onChange(items.filter((_, i) => i !== index))} />)}
    {items.length < FOOD_ITEM_LIMITS.items && <Button variant="soft" onClick={() => onChange([...items, { name: "", portion: null, nutrients: {}, groups: null, source: "manual" }])}>Add food item</Button>}
    {items.length >= FOOD_ITEM_LIMITS.items && <p className={cx(tone.faint, "text-[13px]")}>Up to 12 foods per entry.</p>}
  </div>;
}

function FoodItemFields({ item, index, onChange, onRemove }: {
  item: CareFoodItem; index: number; onChange: (item: CareFoodItem) => void; onRemove: () => void;
}) {
  const label = `Food ${index + 1}`;
  const nutrients = (keys: NutrientKey[]) => keys.map((key) => <NutrientField key={key} nutrient={key} label={label} value={item.nutrients[key]} onChange={(value) => onChange({ ...item, nutrients: { ...item.nutrients, [key]: value } })} />);
  return <fieldset className={cx(tone.inset, "min-w-0 space-y-3 p-3")}>
    <legend className="sr-only">{label}</legend>
    <div className="flex items-center justify-between gap-2">
      <span className={tone.label}>{label}</span>
      <button type="button" onClick={onRemove} aria-label={`Remove ${label.toLowerCase()}`} className="min-h-[44px] px-2 text-[13px] font-medium text-mp-accent-fg">Remove</button>
    </div>
    <TextField label={`${label} name`} title="Food" value={item.name} onChange={(name) => onChange({ ...item, name })} max={FOOD_ITEM_LIMITS.name} placeholder="Eggs, lentils, yogurt…" />
    <TextField label={`${label} portion`} title="Portion (optional)" value={item.portion ?? ""} onChange={(portion) => onChange({ ...item, portion: portion || null })} max={FOOD_ITEM_LIMITS.portion} placeholder="Two eggs, a bowl, a cup…" />
    <p className={cx(tone.faint, "text-[12px] leading-relaxed")}>Changing the food or portion does not recalculate these numbers.</p>
    <div className="grid grid-cols-2 gap-3">{nutrients(["protein_g", "fiber_g"])}</div>
    <label className="block space-y-1">
      <span className={tone.label}>Source</span>
      <select aria-label={`${label} source`} className={tone.input} value={item.source} onChange={(event) => onChange({ ...item, source: event.target.value as CareFoodItem["source"] })}>
        <option value="manual">Entered manually</option><option value="estimate">Estimate</option><option value="label">Package label</option>
      </select>
    </label>
    <details className="space-y-3">
      <summary className="min-h-[44px] cursor-pointer py-3 text-[14px] font-medium text-mp-accent-fg">Food groups &amp; more details</summary>
      <FoodGroups value={item.groups} onChange={(groups) => onChange({ ...item, groups })} label={label} />
      <div className="grid grid-cols-2 gap-3">{nutrients(["carbs_g", "fat_g", "energy_kcal"])}</div>
      <TextField label={`${label} note`} title="Source or food note (optional)" value={item.note ?? ""} onChange={(note) => onChange({ ...item, note: note || null })} max={FOOD_ITEM_LIMITS.note} placeholder="Label serving size, estimate details…" />
    </details>
  </fieldset>;
}

function TextField({ label, title, value, onChange, max, placeholder }: { label: string; title: string; value: string; onChange: (value: string) => void; max: number; placeholder: string }) {
  return <label className="block space-y-1"><span className={tone.label}>{title}</span><input aria-label={label} className={tone.input} value={value} onChange={(event) => onChange(event.target.value)} maxLength={max} placeholder={placeholder} /></label>;
}

function NutrientField({ nutrient, label, value, onChange }: { nutrient: NutrientKey; label: string; value: number | null | undefined; onChange: (value: number | null) => void }) {
  const [draft, setDraft] = useState({ value, text: value == null ? "" : String(value) });
  if (!Object.is(draft.value, value)) setDraft({ value, text: value == null ? "" : String(value) });
  const invalid = value != null && (!Number.isFinite(value) || value < 0 || value > NUTRIENT_LIMITS[nutrient]);
  const change = (text: string) => {
    const next = text.trim() === "" ? null : Number(text);
    setDraft({ value: next, text });
    onChange(next);
  };
  return <label className="block min-w-0 space-y-1">
    <span className={tone.label}>{NUTRIENT_LABELS[nutrient]}</span>
    <input aria-label={`${label} ${NUTRIENT_LABELS[nutrient].toLowerCase()}`} inputMode="decimal" className={tone.input} value={draft.text} onChange={(event) => change(event.target.value)} placeholder="Unknown" aria-invalid={invalid || undefined} />
    {invalid && <span className="block text-[12px] text-mp-danger">Enter 0–{NUTRIENT_LIMITS[nutrient]}, or leave blank.</span>}
  </label>;
}

function FoodGroups({ value, onChange, label }: { value: FoodGroup[] | null; onChange: (groups: FoodGroup[] | null) => void; label: string }) {
  return <fieldset className="space-y-2"><legend className={tone.label}>Food groups (optional)</legend>
    <div className="flex flex-wrap gap-2">
      {FOOD_GROUPS.map((group) => <button key={group} type="button" aria-label={`${label}: ${FOOD_GROUP_LABELS[group]}`} aria-pressed={value?.includes(group) ?? false} onClick={() => onChange(value?.includes(group) ? value.filter((item) => item !== group) : [...value ?? [], group])} className="min-h-[44px] rounded-xl border border-mp-line px-3 py-2 text-left text-[13px] text-mp-accent-fg aria-pressed:bg-mp-accent aria-pressed:text-mp-on-accent">{FOOD_GROUP_LABELS[group]}</button>)}
    </div>
    <select aria-label={`${label} group assessment`} className={tone.input} value={value === null ? "unknown" : "assessed"} onChange={(event) => onChange(event.target.value === "unknown" ? null : value ?? [])}>
      <option value="unknown">Not assessed</option><option value="assessed">Groups selected (or none apply)</option>
    </select>
  </fieldset>;
}
