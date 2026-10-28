"use client";

import { useRef, useState } from "react";
import { careNutritionSummary } from "@/lib/maple/care-nutrition";
import { DEFAULT_TZ, formatTime } from "@/lib/maple/time";
import type { CareNutritionEntry } from "@/lib/maple/types";
import { formatVolume, ozToMl } from "@/lib/maple/units";
import { Icon } from "../icons";
import { SectionTitle, cx, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import NutritionEntrySheet from "./NutritionEntrySheet";
import { GROUP, errorText } from "./parts";
import type { UseCare } from "./useCare";
import { useNutrition } from "./useNutrition";

export default function NutritionSection({ care }: { care: UseCare }) {
  const { state, units, now: clock, toast } = useMaple();
  const now = useNow(30_000);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const [sheet, setSheet] = useState<{ kind: "food" | "drink"; entry?: CareNutritionEntry } | null>(null);
  const waterUntil = useRef(0);
  const { save, saving } = useNutrition(care);
  const summary = careNutritionSummary(care.state.entries, state?.entries ?? [], { now, tz, feeding: care.state.settings.feeding });
  const waterMl = units === "metric" ? 250 : ozToMl(8);
  const waterLabel = formatVolume(waterMl, units);
  const logWater = async () => {
    if (saving || performance.now() < waterUntil.current) return;
    waterUntil.current = performance.now() + 1500;
    try { await save({ kind: "drink", at: clock().toISOString(), data: { name: "Water", amount_ml: waterMl } }); }
    catch (error) { toast(errorText(error), { tone: "error" }); }
  };

  return <section aria-labelledby="her-nutrition" className="space-y-3">
    <SectionTitle><span id="her-nutrition">Food &amp; drink</span></SectionTitle>
    {care.access.write && <div className="grid grid-cols-2 gap-2" role="group" aria-label="Log food and drink">
      <button type="button" disabled={saving} aria-label={`Log water, ${waterLabel}`} onClick={() => void logWater()} className={cx(tone.card, "row-span-2 flex min-h-[112px] min-w-0 flex-col items-center justify-center gap-1 px-3 py-4 text-mp-accent-fg transition active:bg-mp-sunken disabled:opacity-50")}>
        <Icon name="droplet" size={24} />
        <span className="text-[17px] font-semibold">Water</span>
        <span className="text-[13px] text-mp-ink-2">{waterLabel}</span>
      </button>
      <button type="button" disabled={saving} onClick={() => setSheet({ kind: "food" })} className={cx(tone.card, "flex min-h-[54px] items-center justify-center gap-2 px-2 py-3 text-[15px] font-semibold text-mp-accent-fg active:bg-mp-sunken disabled:opacity-50")}>Ate something</button>
      <button type="button" disabled={saving} onClick={() => setSheet({ kind: "drink" })} className={cx(tone.card, "flex min-h-[54px] items-center justify-center gap-2 px-2 py-3 text-[15px] font-medium text-mp-accent-fg active:bg-mp-sunken disabled:opacity-50")}>Other drink</button>
    </div>}
    <div className="space-y-1 px-1">
      {summary.nursingLine && <p className={cx(tone.muted, "text-[13px] leading-relaxed")}>{summary.nursingLine}</p>}
      <p className={cx(tone.body, "text-[15px] font-medium")}>{summary.suggestion.title}</p>
      <p className={cx(tone.muted, "text-[14px] leading-relaxed")}>{summary.suggestion.body}</p>
      <a href={summary.suggestion.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center text-[13px] font-medium text-mp-accent-fg underline underline-offset-2">{summary.suggestion.sourceLabel}</a>
    </div>
    {summary.dayEntries.length > 0 ? <div>
      <p className={cx(tone.label, "mb-2 px-1")}>Logged today</p>
      <div className={GROUP}>
        {summary.dayEntries.map((entry) => {
          const name = entry.kind === "food" ? entry.data.description : entry.data.name;
          const amount = entry.kind === "drink" && entry.data.amount_ml != null ? formatVolume(entry.data.amount_ml, units) : null;
          const pending = entry.pending || entry.id < 0;
          return <div key={entry.id} className="flex min-h-[64px] items-center gap-1 py-2 pl-4 pr-1">
            <div className="min-w-0 flex-1">
              <p className={cx(tone.body, "break-words text-[15px] leading-snug")}>{name}{amount && <span className={tone.muted}> · {amount}</span>}</p>
              <p className={cx(tone.muted, "mt-1 text-[13px] tabular-nums")}>{formatTime(entry.at, tz)}{entry.kind === "food" ? ` · ${entry.data.meal === "snack" ? "Snack" : "Meal"}` : ""}</p>
              {pending && <p className={cx(tone.faint, "mt-0.5 text-[12px]")}>On this phone, not synced</p>}
            </div>
            {care.access.write && <>
              <button type="button" aria-label={`Edit ${name}`} disabled={pending} title={pending ? "Edit after sync" : undefined} onClick={() => setSheet({ kind: entry.kind, entry })} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-mp-accent-fg active:bg-mp-sunken disabled:opacity-30"><Icon name="pencil" size={18} /></button>
              <button type="button" aria-label={`Remove ${name}`} onClick={() => void care.act.deleteEntry(entry.id).catch(() => {})} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-mp-ink-3 active:bg-mp-sunken"><Icon name="trash-2" size={18} /></button>
            </>}
          </div>;
        })}
      </div>
    </div> : <p className={cx(tone.faint, "px-1 text-[13px]")}>Log what you want to remember. A meal or snack is enough.</p>}
    {sheet && care.access.write && <NutritionEntrySheet key={sheet.entry?.id ?? sheet.kind} {...sheet} care={care} onClose={() => setSheet(null)} onSave={save} saving={saving} />}
  </section>;
}
