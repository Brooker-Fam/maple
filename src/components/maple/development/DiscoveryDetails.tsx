"use client";

import type { ReactNode } from "react";
import { developmentAge } from "@/lib/maple/development";
import { DEVELOPMENT_COPY, type Discovery } from "@/lib/maple/guidelines/development";
import { useAppNav } from "../AppNav";
import { useSheets } from "../sheets";
import { Button } from "../ui";
import { useMaple, useNow } from "../useMaple";

export default function DiscoveryDetails({ discovery, onLeave, milestones = true, children }: { discovery: Discovery; onLeave?: () => void; milestones?: boolean; children?: ReactNode }) {
  const { state, summary, readOnly } = useMaple();
  const now = useNow(60_000);
  const { open } = useSheets();
  const { go } = useAppNav();
  const age = state && developmentAge(state.baby, now);
  const tummyTimer = summary?.active.find((entry) => entry.kind === "tummy");
  return (
    <details key={discovery.id} className="mt-1">
      <summary className="min-h-[44px] cursor-pointer py-3 text-[13px] font-medium text-mp-accent-fg">{discovery.activity ? "A small idea & sources" : "About this discovery"}</summary>
      <div className="space-y-3 pb-3 text-[14px] leading-relaxed text-mp-ink-2">
        {discovery.activity && <p><strong className="font-semibold text-mp-ink">Try together: </strong>{discovery.activity}</p>}
        {discovery.action === "tummy" && <>
          <p>{DEVELOPMENT_COPY.tummySafety}</p>
          {!readOnly && <Button variant="soft" size="sm" onClick={() => {
            onLeave?.();
            open({ kind: "tummy", entry: tummyTimer });
          }}>{tummyTimer ? "View tummy time" : "Log tummy time"}</Button>}
        </>}
        <p className="text-[13px]">{DEVELOPMENT_COPY.rotation}</p>
        {age?.corrected && discovery.ageBasis === "developmental" && <div className="text-[13px]">
          <p>{age.label}. {DEVELOPMENT_COPY.correctedAge}</p>
          <a href={DEVELOPMENT_COPY.correctedAgeSource.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center text-mp-accent-fg underline underline-offset-4">About corrected age</a>
        </div>}
        <a href={discovery.source.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center text-mp-accent-fg underline underline-offset-4">Source: {discovery.source.label}</a>
        {milestones && <button type="button" onClick={() => {
          onLeave?.();
          go("moments");
        }} className="block min-h-[44px] text-left font-medium text-mp-accent-fg">Milestones to notice in Moments</button>}
        {children}
      </div>
    </details>
  );
}
