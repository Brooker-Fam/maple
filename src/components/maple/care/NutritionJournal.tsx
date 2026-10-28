"use client";

import { formatTime } from "@/lib/maple/time";
import type { CareFoodItem } from "@/lib/maple/care-nutrition-types";
import type { CareNutritionEntry } from "@/lib/maple/types";
import { formatVolume } from "@/lib/maple/units";
import { Icon } from "../icons";
import { cx, tone } from "../ui";
import { GROUP } from "./parts";

export function NutritionJournal({ entries, units, tz, writable, saving, onEdit, onRemove, onRepeat }: {
  entries: CareNutritionEntry[]; units: "us" | "metric"; tz: string; writable: boolean; saving: boolean;
  onEdit: (entry: CareNutritionEntry) => void; onRemove: (entry: CareNutritionEntry) => void; onRepeat: (entry: CareNutritionEntry & { kind: "food" }) => void;
}) {
  if (!entries.length) return <p className={cx(tone.faint, "px-1 text-[13px]")}>Nothing logged for this day. A meal or snack is enough.</p>;
  return <div className={GROUP}>{entries.map((entry) => {
    const name = entry.kind === "food" ? entry.data.description : entry.data.name;
    const amount = entry.kind === "drink" && entry.data.amount_ml != null ? formatVolume(entry.data.amount_ml, units) : null;
    const pending = entry.pending || entry.id < 0;
    return <article key={entry.id} className="space-y-1 py-3 pl-4 pr-1">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <p className={cx(tone.body, "break-words text-[15px] leading-snug")}>{name}{amount && <span className={tone.muted}> · {amount}</span>}</p>
          <p className={cx(tone.muted, "mt-1 text-[13px] tabular-nums")}>{formatTime(entry.at, tz)}{entry.kind === "food" ? ` · ${entry.data.meal === "snack" ? "Snack" : "Meal"}` : amount ? "" : " · Amount unknown"}</p>
          {pending && <p className={cx(tone.faint, "mt-0.5 text-[12px]")}>On this phone, not synced</p>}
        </div>
        {writable && <>
          <button type="button" aria-label={`Edit ${name}`} disabled={pending || saving} title={pending ? "Edit after sync" : undefined} onClick={() => onEdit(entry)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-mp-accent-fg active:bg-mp-sunken disabled:opacity-30"><Icon name="pencil" size={18} /></button>
          <button type="button" aria-label={`Remove ${name}`} disabled={saving} onClick={() => onRemove(entry)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-mp-ink-3 active:bg-mp-sunken disabled:opacity-30"><Icon name="trash-2" size={18} /></button>
        </>}
      </div>
      {entry.kind === "food" && <div className="pr-3">
        {entry.data.items?.length ? <details><summary className="cursor-pointer py-2 text-[13px] font-medium text-mp-accent-fg">{entry.data.items.length} {entry.data.items.length === 1 ? "food" : "foods"} · View details</summary><ul className="space-y-3 pb-2">{entry.data.items.map((item, index) => <FoodItemDetail key={index} item={item} />)}</ul></details> : <p className={cx(tone.faint, "mt-1 text-[12px]")}>Nutrition details not added</p>}
        {writable && <button type="button" aria-label={`Log ${name} again`} disabled={pending || saving} onClick={() => onRepeat(entry)} className="min-h-[44px] text-[13px] font-medium text-mp-accent-fg disabled:opacity-30">Log again</button>}
      </div>}
    </article>;
  })}</div>;
}

function FoodItemDetail({ item }: { item: CareFoodItem }) {
  const nutrient = (value: number | null | undefined) => value == null ? "unknown" : `${value} g`;
  return <li className="space-y-1 text-[13px] leading-relaxed">
    <p className={tone.body}>{item.name}{item.portion ? ` · ${item.portion}` : ""}</p>
    <p className={tone.muted}>{item.source === "estimate" ? "Estimate" : item.source === "label" ? "Package label" : "Entered manually"} · Protein {nutrient(item.nutrients.protein_g)} · Fiber {nutrient(item.nutrients.fiber_g)}</p>
    {item.note && <p className={cx(tone.faint, "break-words")}>{item.note}</p>}
  </li>;
}
