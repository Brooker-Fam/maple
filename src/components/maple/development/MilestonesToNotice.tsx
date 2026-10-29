"use client";

import { applicableMilestones, developmentAge } from "@/lib/maple/development";
import { DEVELOPMENT_COPY } from "@/lib/maple/guidelines/development";
import type { Baby, EntryOf } from "@/lib/maple/types";
import { Icon } from "../icons";
import { Button, cx, tone } from "../ui";
import { useNow } from "../useMaple";

type Moment = EntryOf<"moment">;

export default function MilestonesToNotice({
  baby,
  moments,
  viewer,
  onOpen,
  onAdd,
}: {
  baby: Baby;
  moments: Moment[];
  viewer: boolean;
  onOpen: (moment: Moment) => void;
  onAdd: (preset: Record<string, unknown>) => void;
}) {
  const now = useNow(60_000);
  const age = developmentAge(baby, now);
  const milestones = applicableMilestones(baby, now).slice(0, 3);
  if (!age || !milestones.length) return null;
  const saved = new Map(moments.filter((moment) => moment.id > 0).map((moment) => [moment.data.milestone, moment]));
  const sources = [...new Map(milestones.map((milestone) => [milestone.source.url, milestone.source])).values()];
  if (age.corrected) sources.push(DEVELOPMENT_COPY.correctedAgeSource);

  return (
    <details className={cx(tone.card, "group/milestones")}>
      <summary className="flex min-h-[68px] cursor-pointer list-none items-center gap-3 rounded-[20px] px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-mp-focus/60 [&::-webkit-details-marker]:hidden">
        <Icon name="leaf" size={20} className="shrink-0 text-mp-ink-2" />
        <span className="min-w-0 flex-1">
          <span className={cx(tone.heading, "block text-[15px]")}>Milestones to notice</span>
          <span className={cx(tone.muted, "mt-0.5 block text-[13px]")}>CDC · By {milestones[0].byMonths} months</span>
        </span>
        <Icon name="chevron-down" size={18} className="shrink-0 text-mp-ink-3 transition group-open/milestones:rotate-180 motion-reduce:transition-none" />
      </summary>
      <div className="px-4 pb-4">
        <p className={cx(tone.muted, "text-sm leading-relaxed")}>{DEVELOPMENT_COPY.milestoneIntro}</p>
        <p className={cx(tone.faint, "mt-1 text-[13px] leading-relaxed")}>
          {age.label}{age.corrected && `. ${DEVELOPMENT_COPY.correctedAge}`}
        </p>
        <ul className={cx(tone.divide, "mt-2")}>
          {milestones.map((milestone) => {
            const moment = saved.get(milestone.id);
            return (
              <li key={milestone.id} className="py-3">
                <p className={cx(tone.body, "text-[15px] leading-snug")}>{milestone.label}</p>
                {moment ? (
                  <Button variant="ghost" size="sm" className="-ml-3 mt-1" onClick={() => onOpen(moment)} aria-label={`Open saved moment: ${milestone.label}`}>
                    <Icon name="leaf" size={15} />
                    Open saved moment
                  </Button>
                ) : !viewer ? (
                  <Button variant="ghost" size="sm" className="-ml-3 mt-1" onClick={() => onAdd({ milestone: milestone.id, title: milestone.label })} aria-label={`Save a moment: ${milestone.label}`}>
                    <Icon name="plus" size={15} />
                    Save a moment
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div className="border-t border-mp-line pt-3">
          <p className={cx(tone.muted, "text-[13px] leading-relaxed")}>{DEVELOPMENT_COPY.milestoneNote} {DEVELOPMENT_COPY.milestoneConcern}</p>
          {sources.map((source) => (
            <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer" className="mt-1 flex min-h-[44px] items-center text-[13px] font-medium text-mp-accent-fg underline underline-offset-2">
              {source.label}
            </a>
          ))}
        </div>
      </div>
    </details>
  );
}
