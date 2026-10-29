"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { dailyDiscovery, eligibleDiscoveries } from "@/lib/maple/development";
import { DEVELOPMENT_TOPICS, type DevelopmentTopic, type Discovery } from "@/lib/maple/guidelines/development";
import { useAppNav } from "../AppNav";
import { Icon } from "../icons";
import { Button, Sheet, cx, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import DiscoveryDetails from "./DiscoveryDetails";
import { useDiscoveryPreferences } from "./useDiscoveryPreferences";

export default function DiscoveryBrowser({ children, className, label, topicsFirst = false }: { children: ReactNode; className?: string; label?: string; topicsFirst?: boolean }) {
  const { state } = useMaple();
  const now = useNow(60_000);
  const { preferences } = useDiscoveryPreferences();
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState<DevelopmentTopic | null>(null);
  const [topicsOpen, setTopicsOpen] = useState(topicsFirst);
  const lastTopic = useRef<DevelopmentTopic | null>(null);
  const categoryButtons = useRef(new Map<DevelopmentTopic, HTMLButtonElement>());
  const categoryHeading = useRef<HTMLParagraphElement>(null);
  const { go } = useAppNav();
  const eligible = state ? eligibleDiscoveries(state.baby, now) : [];
  const discovery = state ? dailyDiscovery(state.baby, now, preferences.topics) ?? dailyDiscovery(state.baby, now, []) : null;
  const selected = DEVELOPMENT_TOPICS.find(({ id }) => id === topic);
  useEffect(() => {
    if (!open) return;
    if (topic) {
      categoryHeading.current?.focus({ preventScroll: true });
      categoryHeading.current?.scrollIntoView({ block: "nearest" });
    } else if (lastTopic.current) {
      const button = categoryButtons.current.get(lastTopic.current);
      button?.focus({ preventScroll: true });
      button?.scrollIntoView({ block: "nearest" });
    }
  }, [open, topic]);
  if (!eligible.length || !discovery) return <>{children}</>;

  return (
    <>
      <button type="button" aria-label={label} aria-haspopup="dialog" className={className} onClick={() => {
        lastTopic.current = null;
        setTopic(null);
        setTopicsOpen(topicsFirst);
        setOpen(true);
      }}>{children}</button>
      <Sheet open={open} onClose={() => setOpen(false)} title={selected?.label ?? "Growing today"} calm>
        {selected ? <div>
          <Button variant="ghost" size="sm" className="-ml-3 mb-3" onClick={() => setTopic(null)}><Icon name="chevron-left" size={16} />Back to topics</Button>
          <p ref={categoryHeading} tabIndex={-1} className={cx(tone.muted, "mb-3 text-sm outline-none")}>A few discoveries for this stage.</p>
          <div className="divide-y divide-mp-line">
            {eligible.filter((item) => item.topic === topic).map((item) => <article key={item.id} aria-label={item.title} className="py-4 first:pt-0">
              <DiscoveryReading discovery={item} onLeave={() => setOpen(false)} />
            </article>)}
          </div>
        </div> : <div className="space-y-5">
          {!topicsFirst && <article aria-label="Today's discovery">
            <p className={cx(tone.faint, "mb-2 text-[13px]")}>Today&apos;s little discovery</p>
            <DiscoveryReading discovery={discovery} onLeave={() => setOpen(false)} />
          </article>}
          <details open={topicsOpen} onToggle={(event) => setTopicsOpen(event.currentTarget.open)}>
            <summary className="flex min-h-[48px] cursor-pointer list-none items-center justify-between gap-3 border-t border-mp-line py-3 font-semibold text-mp-accent-fg [&::-webkit-details-marker]:hidden">
              Explore all topics<Icon name={topicsOpen ? "chevron-up" : "chevron-down"} size={18} />
            </summary>
            <div className={cx(tone.card, tone.divide, "overflow-hidden")}>
              {DEVELOPMENT_TOPICS.filter(({ id }) => eligible.some((item) => item.topic === id)).map(({ id, label: topicLabel }) => <button
                key={id} type="button" ref={(element) => { if (element) categoryButtons.current.set(id, element); else categoryButtons.current.delete(id); }}
                className={cx(tone.row, "min-h-[52px] scroll-my-2 justify-between py-3 text-left text-[15px]")}
                onClick={() => { lastTopic.current = id; setTopic(id); }}
              ><span>{topicLabel}</span><Icon name="chevron-right" size={16} className="shrink-0 text-mp-ink-3" /></button>)}
            </div>
          </details>
          <button type="button" className="flex min-h-[44px] items-center gap-2 text-left text-[14px] font-medium text-mp-accent-fg" onClick={() => { setOpen(false); go("moments"); }}><Icon name="leaf" size={17} />Milestones to notice in Moments</button>
        </div>}
      </Sheet>
    </>
  );
}

function DiscoveryReading({ discovery, onLeave }: { discovery: Discovery; onLeave: () => void }) {
  return <>
    <h3 className={cx(tone.heading, "text-[19px] leading-snug")}>{discovery.title}</h3>
    <p className={cx(tone.muted, "mt-1.5 text-[15px] leading-relaxed")}>{discovery.body}</p>
    <DiscoveryDetails discovery={discovery} onLeave={onLeave} milestones={false} />
  </>;
}
