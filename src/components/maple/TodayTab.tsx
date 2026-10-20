"use client";

import { AnimatePresence } from "framer-motion";
import { useEffect, useRef } from "react";
import { formatClock } from "@/lib/maple/time";
import AlertStack, { EmergencyHelp } from "./AlertCard";
import Celebrations from "./Celebrations";
import DayDial from "./DayDial";
import Dock from "./Dock";
import EntryRow, { photoUrl } from "./EntryRow";
import Hero from "./Hero";
import type { TabId } from "./MapleApp";
import StatusCard, { DiaperBrigade, Tallies } from "./StatusCard";
import TimerCard, { SIDE_NAME, timerNumbers } from "./TimerCard";
import Waiting from "./Waiting";
import WhileYouSlept from "./WhileYouSlept";
import { useSheets } from "./sheets";
import { cx, tone } from "./ui";
import { useMaple, useNow } from "./useMaple";

/**
 * Today: the screen parents use one-handed at 3am. Top to bottom: who she is
 * (or the waiting hero), anything urgent, the "while you slept" hand-off, the
 * 3am answers, running timers, the day dial, tallies, and the last few
 * entries. Logging lives in the dock pinned above the tab bar, so nothing
 * here needs a scroll to reach.
 */

const KIND_TITLE: Record<string, string> = { feed: "Nursing", sleep: "Asleep", tummy: "Tummy time", pump: "Pumping" };

export default function TodayTab({ onNavigate }: { onNavigate: (t: TabId) => void }) {
  const { state, summary, readOnly } = useMaple();
  const { open } = useSheets();
  const now = useNow(30_000);
  if (!state || !summary) return null;

  const born = !!state.baby.born_at;
  const nothingYet = state.entries.length === 0;
  const recent = state.entries.filter((e) => !e.active).slice(0, 5);

  return (
    <div className="space-y-4 px-4 pb-4">
      {summary.active.length > 0 && <TitleTicker />}
      {born ? <Hero /> : <Waiting />}
      {readOnly && <LatestMoment />}

      <AlertStack tiers={["emergency", "now"]} onNavigate={onNavigate} />
      <Celebrations />
      <WhileYouSlept />

      {nothingYet ? born && <FreshPage readOnly={readOnly} /> : <StatusCard />}

      <AnimatePresence initial={false}>
        {summary.active.map((e) => (
          // Keyed by kind: only one of each runs, and the optimistic copy hands over to the saved one without a remount.
          <TimerCard key={e.kind} entry={e} />
        ))}
      </AnimatePresence>

      <AlertStack tiers={["today", "mention", "nudge"]} onNavigate={onNavigate} />

      {!nothingYet && (
        <>
          <DayDial />
          <Tallies />
          <DiaperBrigade />
        </>
      )}

      {recent.length > 0 && (
        <section aria-labelledby="recent">
          <div className="mb-1 flex items-end justify-between px-1">
            <h2 id="recent" className={cx(tone.heading, "text-xl")}>
              Recent
            </h2>
            <button
              type="button"
              onClick={() => onNavigate("log")}
              className="min-h-[44px] rounded-full px-3 text-sm font-semibold text-[#5C7A4A] hover:bg-[#1D4420]/5 dark:text-[#A9C08F]"
            >
              See all →
            </button>
          </div>
          <div className={cx(tone.card, "p-1.5")}>
            {recent.map((e) => (
              <EntryRow key={e.id} entry={e} now={now} showRelative onClick={readOnly ? undefined : () => open({ kind: e.kind, entry: e })} />
            ))}
          </div>
        </section>
      )}

      <EmergencyHelp />

      {/* Room for the dock, which publishes its height (the shell already pads for the tab bar). */}
      {!readOnly && <div aria-hidden className="h-[calc(var(--maple-dock-h,150px)-8px)]" />}
      <Dock />
    </div>
  );
}

/** "⏱ 12:04 · Right · Maple" in the tab title while a timer runs, so it shows in the app switcher. */
function TitleTicker() {
  const { summary, state } = useMaple();
  const now = useNow(1000);
  const original = useRef<string | null>(null);
  const e = summary?.active[0];
  const name = (state?.baby.nickname || state?.baby.name || "Maple").split(" ")[0];
  let title: string | null = null;
  if (e) {
    const n = timerNumbers(e, now);
    const what = e.kind === "feed" ? SIDE_NAME[n.side ?? "L"] : KIND_TITLE[e.kind] ?? "Timer";
    title = `⏱ ${formatClock(n.elapsed)} · ${n.paused ? "Paused" : what} · ${name}`;
  }
  useEffect(() => {
    if (original.current == null) original.current = document.title;
  }, []);
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
  useEffect(
    () => () => {
      if (original.current != null) document.title = original.current;
    },
    []
  );
  return null;
}

/** Bruce, curled up, guarding the empty page. */
function Bruce({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 36" className={className} aria-hidden>
      <g className="fill-[#3A3530] dark:fill-[#B9B39C]">
        <path d="M10,32 C4,32 3,24 8,20 C14,15 26,13 38,14 C50,15 58,20 58,27 C58,31 54,33 48,33 Z" />
        <path d="M50,30 C60,30 62,22 56,18" fill="none" strokeWidth="4" strokeLinecap="round" className="stroke-[#3A3530] dark:stroke-[#B9B39C]" />
        <ellipse cx="14" cy="24" rx="9" ry="7.5" />
        <path d="M7,19 L8.5,11.5 L13,17 Z" />
        <path d="M15,16.5 L20,10.5 L21,18 Z" />
      </g>
      <path d="M9.5,24 Q11,25 12.5,24 M15.5,24 Q17,25 18.5,24" className="stroke-[#FDF8F0] dark:stroke-[#12261A]" strokeWidth="0.9" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function FreshPage({ readOnly }: { readOnly: boolean }) {
  return (
    <section className={cx(tone.card, "px-6 py-8 text-center")}>
      <Bruce className="mx-auto h-10 w-[72px] opacity-80" />
      <p className={cx(tone.heading, "mt-3 text-2xl")}>A fresh page</p>
      <p className={cx(tone.muted, "mx-auto mt-1 max-w-[18rem] text-[15px]")}>
        {readOnly ? "Nothing logged yet today. Check back soon." : "Tap a button below when Maple eats, sleeps, or needs a change."}
      </p>
      <p className={cx(tone.muted, "mt-3 text-xs italic")}>Bruce is guarding an empty page.</p>
    </section>
  );
}

/** For view-only family: the newest photo, big, right under the hero. */
function LatestMoment() {
  const { state } = useMaple();
  const m = state?.entries.find((e) => e.kind === "moment" && e.id > 0 && e.data.photos?.length);
  if (!m || m.kind !== "moment") return null;
  return (
    <figure className="overflow-hidden rounded-3xl bg-white p-2 pb-3 shadow-[0_6px_24px_rgba(29,68,32,0.12)] dark:bg-[#12261A]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photoUrl(m.id, 0, "full")} alt={m.data.title ?? "Maple"} className="aspect-[4/3] w-full rounded-2xl object-cover" />
      {m.data.title && <figcaption className={cx(tone.heading, "mt-2 text-center text-lg italic")}>{m.data.title}</figcaption>}
    </figure>
  );
}
