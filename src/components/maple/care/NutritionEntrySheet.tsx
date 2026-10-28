"use client";

import { useState } from "react";
import { DEFAULT_TZ } from "@/lib/maple/time";
import type { CareNutritionEntry, CareNutritionInput } from "@/lib/maple/types";
import { mlToOz, ozToMl } from "@/lib/maple/units";
import { RecordedTimeField } from "../TimeField";
import { Button, Segmented, Sheet, cx, tone } from "../ui";
import { ApiError, useMaple } from "../useMaple";
import { Problem, errorText } from "./parts";
import type { UseCare } from "./useCare";

function amountText(entry: CareNutritionEntry | undefined, units: "us" | "metric"): string {
  const value = entry?.kind === "drink" ? entry.data.amount_ml : null;
  return value == null ? "" : String(units === "metric" ? value : Math.round(mlToOz(value) * 100) / 100);
}

export default function NutritionEntrySheet({ kind, entry, care, onClose, onSave, saving }: {
  kind: "food" | "drink";
  entry?: CareNutritionEntry;
  care: UseCare;
  onClose: () => void;
  onSave: (input: CareNutritionInput, existing?: CareNutritionEntry) => Promise<void>;
  saving: boolean;
}) {
  const { state, now, units, refresh } = useMaple();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const [base, setBase] = useState(entry);
  const [description, setDescription] = useState(entry?.kind === "food" ? entry.data.description : "");
  const [meal, setMeal] = useState<"meal" | "snack">(entry?.kind === "food" ? entry.data.meal : "meal");
  const [name, setName] = useState(entry?.kind === "drink" ? entry.data.name : "");
  const [amount, setAmount] = useState(() => amountText(entry, units));
  const [when, setWhen] = useState(entry ? new Date(entry.at) : now);
  const [timeInvalid, setTimeInvalid] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [showTime, setShowTime] = useState(!!entry);
  const current = base ? care.state.entries.find((item): item is CareNutritionEntry => item.id === base.id && (item.kind === "food" || item.kind === "drink")) : null;
  const changed = !!base && !!current && current.updated_at !== base.updated_at;
  const gone = !!base && !current;
  const volume = amount.trim() === "" ? null : Number(amount);
  const amountMl = base?.kind === "drink" && amount === amountText(base, units) ? base.data.amount_ml ?? null
    : volume == null ? null : units === "metric" ? volume : ozToMl(volume);
  const amountInvalid = amountMl != null && (!Number.isFinite(amountMl) || amountMl <= 0 || amountMl > 5000);
  const disabled = saving || timeInvalid || (kind === "drink" && (!name.trim() || amountInvalid)) || changed || gone || refused;
  const close = () => { if (!saving) onClose(); };
  const reset = () => {
    if (!current) return;
    setBase(current);
    if (current.kind === "food") { setDescription(current.data.description); setMeal(current.data.meal); }
    else {
      setName(current.data.name);
      setAmount(amountText(current, units));
    }
    setWhen(new Date(current.at));
    setTimeInvalid(false);
    setProblem(null);
    setRefused(false);
  };
  const save = async () => {
    if (disabled) return;
    setProblem(null);
    const at = showTime ? when.toISOString() : now().toISOString();
    const input: CareNutritionInput = kind === "food"
      ? { kind, at, data: { description: description.trim() || (meal === "snack" ? "Snack" : "Meal"), meal }, note: base?.note }
      : { kind, at, data: { name: name.trim(), amount_ml: amountMl }, note: base?.note };
    try { await onSave(input, base); onClose(); }
    catch (error) {
      setProblem(errorText(error));
      if (error instanceof ApiError && error.status === 409) { setRefused(true); void refresh(); }
    }
  };

  return <Sheet open onClose={close} title={base ? "Edit food or drink" : kind === "food" ? "Ate something" : "Had a drink"} subtitle={care.self ? "For you" : `For ${care.name}`} calm footer={
    <div className="space-y-3">
      <Problem className="mt-0">{problem}</Problem>
      <div className="flex gap-3">
        <Button variant="soft" size="lg" onClick={close} disabled={saving}>Cancel</Button>
        <Button size="lg" className="flex-1" disabled={disabled} onClick={() => void save()}>{saving ? "Saving…" : base ? "Save changes" : kind === "food" ? "Log food" : "Log drink"}</Button>
      </div>
    </div>
  }>
    {(changed || refused) && <div role="status" className={cx(tone.inset, "space-y-2 p-3 text-[15px]")}>
      <p>This entry changed while you were editing. Your change hasn&apos;t been saved.</p>
      {changed ? <Button variant="soft" onClick={reset}>Use latest entry</Button> : <Button variant="soft" onClick={() => void refresh()}>Refresh latest entry</Button>}
    </div>}
    {gone && <p role="status" className={cx(tone.muted, "text-[15px]")}>This entry was removed. Your change hasn&apos;t been saved.</p>}
    <fieldset disabled={saving} className="min-w-0 space-y-5">
      {kind === "food" ? <FoodFields meal={meal} setMeal={setMeal} description={description} setDescription={setDescription} />
        : <DrinkFields name={name} setName={setName} amount={amount} setAmount={setAmount} units={units} invalid={amountInvalid} />}
      {showTime ? <RecordedTimeField label={kind === "food" ? "Eaten at" : "Drank at"} value={when} onChange={setWhen} onInvalidChange={setTimeInvalid} tz={tz} />
        : <button type="button" className="min-h-[44px] text-[14px] font-medium text-mp-accent-fg" onClick={() => setShowTime(true)}>Just now · Change time</button>}
    </fieldset>
  </Sheet>;
}

function FoodFields({ meal, setMeal, description, setDescription }: {
  meal: "meal" | "snack"; setMeal: (value: "meal" | "snack") => void; description: string; setDescription: (value: string) => void;
}) {
  return <>
    <Segmented value={meal} onChange={setMeal} options={[{ value: "meal", label: "Meal" }, { value: "snack", label: "Snack" }]} />
    <label className="block space-y-2">
      <span className={tone.label}>What was it? <span className={tone.faint}>(optional)</span></span>
      <textarea aria-label="What was it?" className={cx(tone.input, "min-h-[88px] resize-none")} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} placeholder="Toast and eggs, a bowl of soup…" rows={2} />
    </label>
    <p className={cx(tone.muted, "text-[13px] leading-snug")}>A few words are enough. Add a portion only if you want to.</p>
  </>;
}

function DrinkFields({ name, setName, amount, setAmount, units, invalid }: {
  name: string; setName: (value: string) => void; amount: string; setAmount: (value: string) => void; units: "us" | "metric"; invalid: boolean;
}) {
  return <>
    <label className="block space-y-2">
      <span className={tone.label}>Drink</span>
      <input aria-label="Drink" className={tone.input} value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="Water, tea, milk…" />
    </label>
    <div className="flex flex-wrap gap-2">
      {["Water", "Tea", "Coffee", "Milk"].map((value) => <button key={value} type="button" onClick={() => setName(value)} aria-pressed={name === value} className="min-h-[44px] rounded-xl border border-mp-line px-3 text-[14px] font-medium text-mp-accent-fg aria-pressed:bg-mp-accent aria-pressed:text-mp-on-accent">{value}</button>)}
    </div>
    <label className="block space-y-2">
      <span className={tone.label}>Amount in {units === "metric" ? "ml" : "oz"} <span className={tone.faint}>(optional)</span></span>
      <input aria-label={`Amount in ${units === "metric" ? "ml" : "oz"}`} inputMode="decimal" className={tone.input} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Leave blank if unsure" aria-invalid={invalid || undefined} />
    </label>
    {invalid && <p role="alert" className="text-[13px] text-mp-danger">Enter a positive amount up to {units === "metric" ? "5,000 ml" : "169 oz"}, or leave it blank.</p>}
  </>;
}
