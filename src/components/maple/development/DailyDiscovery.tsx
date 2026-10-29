"use client";

import { useEffect, useRef, useState } from "react";
import { dailyDiscovery, developmentAge } from "@/lib/maple/development";
import { DEVELOPMENT_COPY, type DevelopmentTopic } from "@/lib/maple/guidelines/development";
import { dayKey } from "@/lib/maple/time";
import { useAppNav } from "../AppNav";
import { Icon, type IconName } from "../icons";
import { useNightActive } from "../nightLook";
import { useSheets } from "../sheets";
import { Button, Sheet, cx, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import DiscoveryPreferences from "./DiscoveryPreferences";
import { useDiscoveryPreferences } from "./useDiscoveryPreferences";

const ICONS: Record<DevelopmentTopic, IconName> = { brain: "lightbulb", connection: "heart", feeding: "bottle", movement: "tummy", communication: "message-square", sleep: "moon" };

export default function DailyDiscovery() {
  const [choosing, setChoosing] = useState(false);
  const { state } = useMaple();
  const now = useNow(60_000);
  const { update } = useDiscoveryPreferences();
  return (
    <>
      <DiscoveryCard onChoose={() => setChoosing(true)} />
      <Sheet open={choosing} onClose={() => setChoosing(false)} title="Daily discoveries" footer={<Button onClick={() => setChoosing(false)} className="w-full">Done</Button>}>
        <DiscoveryPreferences />
        <Button variant="ghost" className="mt-3 w-full" onClick={() => {
          if (state) update({ hiddenDay: dayKey(now, state.baby.timezone) });
          setChoosing(false);
        }}>Hide for today</Button>
      </Sheet>
    </>
  );
}

function DiscoveryCard({ onChoose }: { onChoose: () => void }) {
  const { state, summary, readOnly } = useMaple();
  const now = useNow(60_000);
  const night = useNightActive();
  const { open } = useSheets();
  const { go } = useAppNav();
  const { preferences, update, ready } = useDiscoveryPreferences();
  const [revealed, setRevealed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (revealed) heading.current?.focus({ preventScroll: true });
  }, [revealed]);
  const discovery = state && ready && preferences.enabled ? dailyDiscovery(state.baby, now, preferences.topics) : null;
  if (!state || !discovery) return null;
  const today = dayKey(now, state.baby.timezone);
  const quiet = night || !!summary?.active.length;
  const age = developmentAge(state.baby, now);
  const tummyTimer = summary?.active.find((entry) => entry.kind === "tummy");

  if (preferences.hiddenDay === today) return (
    <div className="flex min-h-[44px] flex-wrap items-center justify-between gap-x-2 px-1 text-[13px] text-mp-ink-3">
      <span>Discovery hidden for today</span>
      <button type="button" onClick={() => update({ hiddenDay: null })} className="min-h-[44px] px-2 font-medium text-mp-accent-fg">Show again</button>
    </div>
  );
  if (quiet && !revealed) return (
    <button type="button" onClick={() => setRevealed(true)} className="flex min-h-[48px] w-full items-center gap-3 rounded-xl px-3 text-left text-[14px] text-mp-ink-2">
      <Icon name="leaf" size={18} /><span className="flex-1">Today&apos;s little discovery</span><Icon name="chevron-down" size={16} />
    </button>
  );

  return (
    <section aria-labelledby="daily-discovery-title" className="border-l-2 border-mp-accent-fg/50 pl-4 pr-1">
      <div className="flex items-center gap-2 text-[13px] text-mp-ink-2">
        <Icon name={ICONS[discovery.topic]} size={17} />
        <span className="flex-1">A little discovery</span>
        <button type="button" aria-label="Discovery options" onClick={onChoose} className="-mr-2 flex h-11 w-11 items-center justify-center rounded-full text-mp-ink-3"><Icon name="ellipsis" size={19} /></button>
      </div>
      <h2 ref={heading} tabIndex={-1} id="daily-discovery-title" className={cx(tone.heading, "text-[19px] leading-snug outline-none")}>{discovery.title}</h2>
      <p className={cx(tone.muted, "mt-1.5 text-[15px] leading-relaxed")}>{discovery.body}</p>
      <details key={discovery.id} className="mt-1">
        <summary className="min-h-[44px] cursor-pointer py-3 text-[13px] font-medium text-mp-accent-fg">{discovery.activity ? "A small idea & sources" : "About this discovery"}</summary>
        <div className="space-y-3 pb-3 text-[14px] leading-relaxed text-mp-ink-2">
          {discovery.activity && <p><strong className="font-semibold text-mp-ink">Try together: </strong>{discovery.activity}</p>}
          {discovery.action === "tummy" && <>
            <p>{DEVELOPMENT_COPY.tummySafety}</p>
            {!readOnly && <Button variant="soft" size="sm" onClick={() => open({ kind: "tummy", entry: tummyTimer })}>{tummyTimer ? "View tummy time" : "Log tummy time"}</Button>}
          </>}
          <p className="text-[13px]">{DEVELOPMENT_COPY.rotation}</p>
          {age?.corrected && discovery.ageBasis === "developmental" && <div className="text-[13px]">
            <p>{age.label}. {DEVELOPMENT_COPY.correctedAge}</p>
            <a href={DEVELOPMENT_COPY.correctedAgeSource.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center text-mp-accent-fg underline underline-offset-4">About corrected age</a>
          </div>}
          <a href={discovery.source.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center text-mp-accent-fg underline underline-offset-4">Source: {discovery.source.label}</a>
          <button type="button" onClick={() => go("moments")} className="block min-h-[44px] text-left font-medium text-mp-accent-fg">Milestones to notice in Moments</button>
        </div>
      </details>
    </section>
  );
}
