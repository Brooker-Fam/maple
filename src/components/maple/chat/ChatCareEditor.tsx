"use client";

import { useState } from "react";
import type { CareEntry } from "@/lib/maple/types";
import { forMom } from "@/lib/maple/care";
import { assessMomTemp } from "@/lib/maple/guidelines";
import { cToF, fToC } from "@/lib/maple/units";
import { nutritionAmountText, nutritionEditData } from "@/lib/maple/chat/nutrition-edit";
import { useCare } from "../care/useCare";
import { RecordedTimeField } from "../TimeField";
import { AssessmentCard } from "../sheets/parts";
import { Button, Segmented, Sheet, cx, tone } from "../ui";
import { useMaple } from "../useMaple";

/** The same version-checked care actions used on her page, including old entries outside its recent window. */
export default function ChatCareEditor({ entry, onClose }: { entry: CareEntry; onClose: () => void }) {
  const care = useCare();
  const { state, units, online, now } = useMaple();
  // A preference change elsewhere cannot reinterpret an amount already being edited.
  const [editUnits] = useState(units);
  const [when, setWhen] = useState(new Date(entry.at));
  const [invalid, setInvalid] = useState(false);
  const [text, setText] = useState(entry.note ?? "");
  const [temperature, setTemperature] = useState(entry.kind === "temp" ? String(Math.round((units === "us" ? cToF(entry.data.temp_c) : entry.data.temp_c) * 10) / 10) : "");
  const [description, setDescription] = useState(entry.kind === "food" ? entry.data.description : "");
  const [meal, setMeal] = useState<"meal" | "snack">(entry.kind === "food" ? entry.data.meal : "meal");
  const [drinkName, setDrinkName] = useState(entry.kind === "drink" ? entry.data.name : "");
  const [amount, setAmount] = useState(entry.kind === "drink" ? nutritionAmountText(entry, units) : "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!care?.access.write) return null;
  const temp = Number(temperature);
  const tempC = editUnits === "us" ? fToC(temp) : temp;
  let nutritionData: ReturnType<typeof nutritionEditData> | null = null;
  let nutritionProblem: string | null = null;
  if (entry.kind === "food" || entry.kind === "drink") {
    try { nutritionData = nutritionEditData(entry, { description, meal, name: drinkName, amount }, editUnits); }
    catch (error) {
      const message = error instanceof Error ? error.message : "Check the food or drink details.";
      nutritionProblem = message.startsWith("Drink amount") ? `Enter a positive amount up to ${editUnits === "metric" ? "5,000 ml" : "169 oz"}, or leave it blank.` : message;
    }
  }
  const valid = !invalid && !nutritionProblem && (entry.kind !== "temp" || (temperature.trim() && Number.isFinite(tempC) && tempC >= 30 && tempC <= 45)) && (entry.kind !== "question" || !!text.trim());
  const assessment = entry.kind === "temp" && temperature.trim() && tempC >= 32 && tempC <= 43 ? assessMomTemp(tempC) : null;
  const save = async () => {
    if (busy || !valid || !online) return;
    setBusy(true); setProblem(null);
    try {
      if (entry.kind === "dose") {
        const saved = await care.act.editDoseTime(entry, when.toISOString());
        if (!saved) throw new Error("Change not confirmed");
      }
      else await care.act.editEntry(entry.id, {
        at: when.toISOString(),
        ...(entry.kind === "temp" ? { data: { temp_c: tempC } } : entry.kind === "question" ? { note: text.trim() } : { data: nutritionData }),
      }, entry.updated_at);
      onClose();
    } catch { setProblem("Couldn't confirm this change. Close this editor and check the latest entry before trying again."); }
    finally { setBusy(false); }
  };
  return <Sheet open onClose={() => { if (!busy) onClose(); }} title={entry.kind === "dose" ? "Edit dose time" : entry.kind === "temp" ? "Edit temperature" : entry.kind === "food" ? "Edit food" : entry.kind === "drink" ? "Edit drink" : "Edit question"} calm footer={
    <div className="space-y-3">
      {problem && <p role="alert" className="text-[14px] text-mp-danger">{problem}</p>}
      <div className="flex gap-3"><Button variant="soft" onClick={onClose} disabled={busy}>Cancel</Button><Button className="flex-1" onClick={() => void save()} disabled={busy || !valid || !online}>{busy ? "Saving…" : "Save"}</Button></div>
    </div>
  }>
    <fieldset disabled={busy} className="space-y-4">
      <RecordedTimeField label={entry.kind === "dose" ? entry.data.skipped ? "Skipped at" : "Taken at" : entry.kind === "food" ? "Eaten at" : entry.kind === "drink" ? "Drank at" : "Recorded at"} value={when} onChange={setWhen} onInvalidChange={setInvalid} tz={state?.baby.timezone ?? "America/New_York"} max={new Date(now().getTime() + 60_000)} />
      {entry.kind === "temp" && <label className={cx(tone.body, "block space-y-2 text-[15px]")}><span>Temperature (°{editUnits === "us" ? "F" : "C"})</span><input inputMode="decimal" type="number" step="0.1" value={temperature} onChange={(event) => setTemperature(event.target.value)} className={tone.input} /></label>}
      {assessment && <AssessmentCard a={forMom(assessment, care.name, care.self)} audience="mom" />}
      {entry.kind === "question" && <label className={cx(tone.body, "block space-y-2 text-[15px]")}><span>Question for her OB</span><textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={2000} rows={4} className={tone.input} /></label>}
      {entry.kind === "food" && <>
        <Segmented aria-label="Food type" value={meal} onChange={setMeal} options={[{ value: "meal", label: "Meal" }, { value: "snack", label: "Snack" }]} />
        <label className={cx(tone.body, "block space-y-2 text-[15px]")}><span>What was it? (optional)</span><textarea aria-label="What was it?" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} rows={3} className={tone.input} /></label>
      </>}
      {entry.kind === "drink" && <>
        <label className={cx(tone.body, "block space-y-2 text-[15px]")}><span>Drink</span><input aria-label="Drink" value={drinkName} onChange={(event) => setDrinkName(event.target.value)} maxLength={100} className={tone.input} /></label>
        <label className={cx(tone.body, "block space-y-2 text-[15px]")}><span>Amount in {editUnits === "metric" ? "ml" : "oz"} (optional)</span><input aria-label={`Amount in ${editUnits === "metric" ? "ml" : "oz"}`} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Leave blank if unsure" className={tone.input} /></label>
      </>}
      {nutritionProblem && <p role="alert" className="text-[14px] text-mp-danger">{nutritionProblem}</p>}
    </fieldset>
  </Sheet>;
}
