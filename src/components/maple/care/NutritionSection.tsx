"use client";

import { useState } from "react";
import { careNutritionSummary } from "@/lib/maple/care-nutrition";
import { addDays, dayKey, DEFAULT_TZ, formatDayLabel } from "@/lib/maple/time";
import type { CareNutritionEntry, CareNutritionInput } from "@/lib/maple/types";
import { Button, SectionTitle, cx, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { NutritionDaySummary } from "./NutritionDaySummary";
import NutritionEntrySheet from "./NutritionEntrySheet";
import { NutritionJournal } from "./NutritionJournal";
import NutritionQuickActions from "./NutritionQuickActions";
import { errorText } from "./parts";
import type { UseCare } from "./useCare";
import { useNutrition } from "./useNutrition";
import { useNutritionHistory } from "./useNutritionHistory";

export default function NutritionSection({ care }: { care: UseCare }) {
  const { state, units, now: clock, toast } = useMaple();
  const now = useNow(30_000);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const today = dayKey(now, tz);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const day = selectedDay && selectedDay <= today && selectedDay >= addDays(today, -6) ? selectedDay : today;
  const [sheet, setSheet] = useState<{ kind: "food" | "drink"; entry?: CareNutritionEntry } | null>(null);
  const { save, saving } = useNutrition(care);
  const history = useNutritionHistory(day, today);
  const summary = careNutritionSummary(care.state.entries, state?.entries ?? [], { now, tz, feeding: care.state.settings.feeding });
  const entries = day === today ? summary.dayEntries : history.entries;
  const saveEntry = async (input: CareNutritionInput, existing?: CareNutritionEntry) => {
    await save(input, existing);
    history.reload();
  };
  const repeat = async (entry: CareNutritionEntry & { kind: "food" }) => {
    try { await save({ kind: "food", at: clock().toISOString(), data: entry.data, note: entry.note }); }
    catch (error) { toast(errorText(error), { tone: "error" }); }
  };
  const remove = async (entry: CareNutritionEntry) => {
    try { await care.act.deleteEntry(entry.id); } catch {}
    history.reload();
  };
  return <section aria-labelledby="her-nutrition" className="space-y-3">
    <SectionTitle><span id="her-nutrition">Food &amp; drink</span></SectionTitle>
    {care.access.write && <NutritionQuickActions care={care} day={day} today={today} tz={tz} save={save} saving={saving} open={(kind) => setSheet({ kind })} />}
    <div className="space-y-3 px-1">
      {summary.nursingLine && <p className={cx(tone.muted, "text-[13px] leading-relaxed")}>{summary.nursingLine}</p>}
      {summary.suggestions.map((suggestion) => <div key={suggestion.title} className="space-y-1">
        <p className={cx(tone.body, "text-[15px] font-medium")}>{suggestion.title}</p>
        <p className={cx(tone.muted, "text-[14px] leading-relaxed")}>{suggestion.body}</p>
        <a href={suggestion.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center text-[13px] font-medium text-mp-accent-fg underline underline-offset-2">{suggestion.sourceLabel}</a>
      </div>)}
    </div>
    <label className="flex items-center gap-3 px-1"><span className={cx(tone.label, "shrink-0")}>Last 7 days</span>
      <select aria-label="Food and drink day" value={day} onChange={(event) => setSelectedDay(event.target.value)} className={cx(tone.input, "min-w-0 flex-1")}>
        {Array.from({ length: 7 }, (_, index) => addDays(today, -index)).map((key) => <option key={key} value={key}>{formatDayLabel(key, today, { long: true })}</option>)}
      </select>
    </label>
    {history.loading && !history.loaded && <p role="status" className={cx(tone.muted, "px-1 text-[14px]")}>Loading food and drink…</p>}
    {history.error && day !== today && <div role="alert" className={cx(tone.inset, "space-y-2 p-3 text-[14px]")}><p>{history.loaded ? "Couldn't refresh this day. Showing the last loaded entries." : "Couldn't load this day."} {history.error}</p><Button variant="soft" onClick={history.reload}>Try again</Button></div>}
    {(day === today || history.loaded) && <NutritionDaySummary entries={entries} units={units} />}
    {day !== today && !history.loaded && entries.length > 0 && <p className={cx(tone.muted, "px-1 text-[13px]")}>Entries saved on this phone are shown below. The rest of this day hasn&apos;t loaded yet.</p>}
    {(day === today || history.loaded || entries.length > 0) && <NutritionJournal entries={entries} units={units} tz={tz} writable={care.access.write} saving={saving} onEdit={(entry) => setSheet({ kind: entry.kind, entry })} onRemove={(entry) => void remove(entry)} onRepeat={(entry) => void repeat(entry)} />}
    {sheet && care.access.write && <NutritionEntrySheet key={sheet.entry?.id ?? sheet.kind} {...sheet} care={care} onClose={() => setSheet(null)} onSave={saveEntry} saving={saving}
      currentEntry={day === today ? undefined : sheet.entry ? history.entries.find((entry) => entry.id === sheet.entry?.id) ?? null : undefined} onRefresh={history.reload} />}
  </section>;
}
