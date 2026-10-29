"use client";

import { useRef } from "react";
import type { CareNutritionInput } from "@/lib/maple/types";
import { formatVolume, ozToMl } from "@/lib/maple/units";
import { useChatNav } from "../chat/ChatNav";
import { Icon } from "../icons";
import { Button, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { errorText } from "./parts";
import type { UseCare } from "./useCare";

export default function NutritionQuickActions({ care, day, today, tz, save, saving, open }: {
  care: UseCare;
  day: string;
  today: string;
  tz: string;
  save: (input: CareNutritionInput) => Promise<void>;
  saving: boolean;
  open: (kind: "food" | "drink") => void;
}) {
  const { units, now, toast } = useMaple();
  const { ask } = useChatNav();
  const waterUntil = useRef(0);
  const waterMl = units === "metric" ? 250 : ozToMl(8);
  const waterLabel = formatVolume(waterMl, units);
  const logWater = async () => {
    if (saving || performance.now() < waterUntil.current) return;
    waterUntil.current = performance.now() + 1500;
    try { await save({ kind: "drink", at: now().toISOString(), data: { name: "Water", amount_ml: waterMl } }); }
    catch (error) { toast(errorText(error), { tone: "error" }); }
  };
  const logWithChat = () => ask({
    label: `Food and drink for ${care.name}`,
    prompt: `Log food or drink for ${care.name} on ${day} (${tz}). Estimate protein and fiber for foods. ${day !== today ? "Ask for the time if I don't give it. " : ""}Only log the intake I describe below.\n\n${care.self ? "I had" : `${care.name} had`}: `,
  });

  return <div className="space-y-3">
    <div className="space-y-2">
      <Button size="lg" className="w-full gap-2" disabled={saving} onClick={logWithChat}>
        <Icon name="message-square" size={20} />Log food or drink
      </Button>
      <p className={cx(tone.muted, "px-1 text-[13px] leading-relaxed")}>Opens a chat draft to log food and drinks, with protein and fiber estimates for food.</p>
    </div>
    <button type="button" disabled={saving} aria-label={`Log water, ${waterLabel}`} onClick={() => void logWater()} className={cx(tone.card, "flex min-h-[52px] w-full items-center gap-2 px-3 py-3 text-mp-accent-fg transition active:bg-mp-sunken disabled:opacity-50")}>
      <Icon name="droplet" size={20} /><span className="text-[15px] font-semibold">Water</span><span className="ml-auto text-[13px] text-mp-ink-2">{waterLabel} · just now</span>
    </button>
    <details className="px-1">
      <summary className="min-h-[44px] cursor-pointer py-3 text-[14px] font-medium text-mp-accent-fg">Log manually</summary>
      <p className={cx(tone.muted, "mb-2 text-[13px] leading-relaxed")}>Save only what you enter, without AI analysis. Works offline too.</p>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Log food and drink manually">
        <button type="button" disabled={saving} onClick={() => open("food")} className={cx(tone.card, "min-h-[48px] px-2 py-3 text-[15px] font-semibold text-mp-accent-fg active:bg-mp-sunken disabled:opacity-50")}>Ate something</button>
        <button type="button" disabled={saving} onClick={() => open("drink")} className={cx(tone.card, "min-h-[48px] px-2 py-3 text-[15px] font-medium text-mp-accent-fg active:bg-mp-sunken disabled:opacity-50")}>Other drink</button>
      </div>
    </details>
  </div>;
}
