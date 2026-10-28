"use client";

import { AnimatePresence } from "framer-motion";
import { useEffect, useRef } from "react";
import { dayKey, formatClock, formatDuration } from "@/lib/maple/time";
import AlertStack from "./AlertCard";
import type { NavTarget } from "./AppNav";
import { babyFirstName, useBabyWords, useFamilyOne } from "./familyWords";
import Celebrations from "./Celebrations";
import { AskChatButton } from "./chat/AskChat";
import Dock from "./Dock";
import EntryRow, { entryEditPreset, photoUrl } from "./EntryRow";
import { HelpFooter } from "./HelpSheet";
import Hero from "./Hero";
import StatusCard from "./StatusCard";
import { SIDE_NAME, timerNumbers } from "./FeedParts";
import TimerCard from "./TimerCard";
import Waiting from "./Waiting";
import WhileYouSlept from "./WhileYouSlept";
import { useSheets } from "./sheets";
import { Icon } from "./icons";
import { cx, tone } from "./ui";
import { useMaple, useNow } from "./useMaple";

const KIND_TITLE: Record<string, string> = { feed: "Nursing", sleep: "Asleep", tummy: "Tummy time", pump: "Pumping" };

export default function TodayTab({ onNavigate }: { onNavigate: (t: NavTarget) => void }) {
  const { state, summary, readOnly } = useMaple();
  const { open } = useSheets();
  const now = useNow(30_000);
  if (!state || !summary) return null;

  const born = !!state.baby.born_at;
  const nothingYet = state.entries.length === 0;
  const recent = state.entries.filter((e) => !e.active).slice(0, 3);
  const timing = summary.active.length > 0;

  return (
    <div className="space-y-6 px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-4">
      {timing && <TitleTicker />}
      {born ? (
        timing ? (
          // The hero folds away while a timer runs; her name stays the page's heading.
          <h1 className="sr-only">{state.baby.name}</h1>
        ) : (
          <Hero />
        )
      ) : (
        <Waiting />
      )}
      {readOnly && <LatestMoment />}
      <AlertStack tiers={["emergency", "now"]} onNavigate={onNavigate} />

      {(!nothingYet || timing) && (
        <section aria-labelledby="right-now">
          <h2 id="right-now" className="sr-only">
            Right now
          </h2>
          <div className="space-y-3">
            <AnimatePresence initial={false}>
              {summary.active.map((e) => (
                // Keyed by kind: only one of each runs, and the optimistic copy hands over to the saved one without a remount.
                <TimerCard key={e.kind} entry={e} />
              ))}
            </AnimatePresence>
            <StatusCard />
          </div>
        </section>
      )}
      <WhileYouSlept />
      {nothingYet && born && <FreshPage readOnly={readOnly} />}

      <AlertStack tiers={["today", "mention", "nudge"]} onNavigate={onNavigate} />

      {recent.length > 0 && (
        <section aria-labelledby="recent">
          <div className="mb-1 flex items-center justify-between px-1">
            <h2 id="recent" className={cx(tone.heading, "text-[17px]")}>
              Recently logged
            </h2>
            <button
              type="button"
              onClick={() => onNavigate("log")}
              className="-mr-2 inline-flex min-h-[44px] items-center gap-0.5 px-2 text-[15px] font-medium text-mp-accent-fg"
            >
              See all
              <Icon name="chevron-right" size={16} />
            </button>
          </div>
          <div className={cx(tone.card, tone.divide, "overflow-hidden")}>
            {recent.map((e) => (
              <EntryRow key={e.id} entry={e} now={now} showRelative onClick={readOnly ? undefined : () => open({ kind: e.kind, entry: e, preset: entryEditPreset(e) })} />
            ))}
          </div>
        </section>
      )}

      {!nothingYet && <LoggedToday onDetails={() => onNavigate("patterns")} />}
      <Celebrations />

      <HelpFooter />

      {/* Room for the dock, which publishes its height (the shell already pads for the tab bar). */}
      {!readOnly && <div aria-hidden className="h-[calc(var(--maple-dock-h,150px)-16px)]" />}
      <Dock />
    </div>
  );
}

function LoggedToday({ onDetails }: { onDetails: () => void }) {
  const { summary, state } = useMaple();
  const now = useNow(60_000);
  if (!summary || !state) return null;
  const s = summary.today;
  const today = dayKey(now, state.baby.timezone);
  return (
    <section aria-labelledby="logged-today" className={cx(tone.card, "px-4 py-3")}>
      <div className="flex items-center justify-between gap-3">
        <h2 id="logged-today" className={cx(tone.heading, "text-[17px]")}>Logged today</h2>
        <button type="button" onClick={onDetails} className="-my-2 -mr-2 inline-flex min-h-[44px] items-center gap-0.5 px-2 text-[15px] font-semibold text-mp-accent-fg">
          Patterns <Icon name="chevron-right" size={16} />
        </button>
      </div>
      <p className="mt-2 text-[15px] leading-relaxed text-mp-ink">
        <span className="whitespace-nowrap">{s.feeds} {s.feeds === 1 ? "feed" : "feeds"}</span>{" · "}
        <span className="whitespace-nowrap">{s.wet} wet</span>{" · "}
        <span className="whitespace-nowrap">{s.dirty} dirty</span>
      </p>
      <p className={cx(tone.muted, "mt-0.5 text-[13px]")}>{s.sleeps ? `${formatDuration(s.sleepSec)} sleep logged` : "No sleep logged today"}. Missing entries are not counted.</p>
      <AskChatButton
        className="mt-2"
        label="Today's log"
        prompt={`Can you summarize ${babyFirstName(state.baby)}'s feeds, diapers and sleep logged on ${today} (${state.baby.timezone}) so far? Keep it brief and distinguish missing logs from recorded activity.`}
      >
        Ask about today
      </AskChatButton>
    </section>
  );
}

/**
 * "6:02 · Right · Maple" (the time on this side) in the tab title while a
 * timer runs, so it shows in the app switcher; "Break 4:12 · Maple" while
 * paused; "1:32:04 · Asleep · Maple".
 */
function TitleTicker() {
  const { summary, state } = useMaple();
  const now = useNow(1000);
  const original = useRef<string | null>(null);
  const e = summary?.active[0];
  const name = babyFirstName(state?.baby);
  let title: string | null = null;
  if (e) {
    const n = timerNumbers(e, now);
    if (n.parts.length && n.paused) title = `Break ${formatClock(n.current.sec)} · ${name}`;
    else if (n.parts.length) title = `${formatClock(n.current.sec)} · ${SIDE_NAME[n.current.side ?? "L"]} · ${name}`;
    else title = `${formatClock(n.elapsed)} · ${KIND_TITLE[e.kind] ?? "Timer"} · ${name}`;
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
      <g className="fill-mp-ink-2">
        <path d="M10,32 C4,32 3,24 8,20 C14,15 26,13 38,14 C50,15 58,20 58,27 C58,31 54,33 48,33 Z" />
        <path d="M50,30 C60,30 62,22 56,18" fill="none" strokeWidth="4" strokeLinecap="round" className="stroke-mp-ink-2" />
        <ellipse cx="14" cy="24" rx="9" ry="7.5" />
        <path d="M7,19 L8.5,11.5 L13,17 Z" />
        <path d="M15,16.5 L20,10.5 L21,18 Z" />
      </g>
      <path d="M9.5,24 Q11,25 12.5,24 M15.5,24 Q17,25 18.5,24" className="stroke-mp-surface" strokeWidth="0.9" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function FreshPage({ readOnly }: { readOnly: boolean }) {
  const w = useBabyWords();
  const one = useFamilyOne();
  return (
    <section className={cx(tone.card, "px-6 py-8 text-center")}>
      <Bruce className="mx-auto h-10 w-[72px]" />
      <p className={cx(tone.heading, "mt-3 text-[20px]")}>A fresh page</p>
      <p className={cx(tone.muted, "mx-auto mt-1 max-w-[18rem] text-[15px]")}>
        {readOnly ? "Nothing logged yet today. Check back soon." : `Tap a button below when ${w.name} eats, sleeps, or needs a change.`}
      </p>
      {one && <p className={cx(tone.faint, "mt-3 text-xs")}>Bruce is guarding an empty page.</p>}
    </section>
  );
}

/** For view-only family: the newest photo, big, right under the hero. */
function LatestMoment() {
  const { state } = useMaple();
  const m = state?.entries.find((e) => e.kind === "moment" && e.id > 0 && e.data.photos?.length);
  if (!m || m.kind !== "moment") return null;
  return (
    <figure className={cx(tone.card, "overflow-hidden p-2", m.data.title ? "pb-3" : "")}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photoUrl(m.id, 0, "full")} alt={m.data.title ?? babyFirstName(state?.baby)} className="aspect-[4/3] w-full rounded-[14px] object-cover" />
      {m.data.title && <figcaption className="mt-2.5 px-2 text-center text-[15px] font-medium text-mp-ink">{m.data.title}</figcaption>}
    </figure>
  );
}
