"use client";

import { AnimatePresence } from "framer-motion";
import { useEffect, useRef } from "react";
import { nursingRuns } from "@/lib/maple/feed";
import { feedRowParts, recentRows } from "@/lib/maple/feed-rows";
import { feedingPlanOf } from "@/lib/maple/feeding-plan";
import { dayKey, formatClock, formatDuration } from "@/lib/maple/time";
import AlertStack from "./AlertCard";
import AccountMenu from "./AccountMenu";
import type { NavTarget } from "./AppNav";
import { babyFirstName, useBabyWords } from "./familyWords";
import Celebrations from "./Celebrations";
import { AskChatButton } from "./chat/AskChat";
import Dock from "./Dock";
import DailyDiscovery from "./development/DailyDiscovery";
import EntryRow, { entryEditPreset, photoUrl } from "./EntryRow";
import NextFeedCard from "./feeding/NextFeedCard";
import { HelpFooter } from "./HelpSheet";
import Hero from "./Hero";
import { SleepNow, useFoldedSleepId } from "./sleep/SleepCards";
import { LastNightCard, LeftRunningAsk } from "./sleep/LastNight";
import { GoalReturnToday } from "./sleep/SleepReturn";
import StatusCard from "./StatusCard";
import { SIDE_NAME, timerNumbers } from "./FeedParts";
import TimerCard from "./TimerCard";
import UpNext from "./UpNext";
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
  // One sleep, one card: a bassinet try's card, or a holding turn's (her sleep in arms), is that sleep's card too, so its timer card steps aside.
  const folded = useFoldedSleepId();
  if (!state || !summary) return null;

  const born = !!state.baby.born_at;
  const nothingYet = state.entries.length === 0;
  // The feeds as counted, from every loaded entry: a feed's parts (its milk at the breast, its top-ups) ride on its row
  // (feed-rows.ts), so one feed is one of the three rows. A part of the feed still going is on that feed's card.
  const rowParts = feedRowParts(nursingRuns(state.entries, now));
  const recent = recentRows(state.entries, rowParts, 3);
  const timing = summary.active.length > 0;
  // A bassinet try or someone holding her awake: shown on every family phone, in Right now.
  const sleepNow = !!state.sleep && (state.sleep.tries.some((t) => !t.ended_at) || state.sleep.shifts.some((x) => !x.ended_at));
  // The care team's feeding plan: its Next feed card is in Right now from the first feed on, before anything is logged.
  const feedPlan = born && state.me.role !== "photos" && !!feedingPlanOf(state.baby.settings);

  return (
    // data-today-page: what tapShield holds for a moment after the page moves under the thumb (a try card appearing).
    <div data-today-page className="space-y-6 px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-4">
      {timing && <TitleTicker />}
      {(!born || timing) && (
        <header className="flex min-h-[44px] items-center justify-between gap-3 px-1">
          {born ? <h1 className={cx(tone.display, "min-w-0 truncate text-[34px] leading-[1.05]")}>{state.baby.name}</h1> : <p className={cx(tone.display, "text-[34px] leading-[1.05]")}>Today</p>}
          <AccountMenu />
        </header>
      )}
      {born ? (
        timing ? (
          null
        ) : (
          <Hero />
        )
      ) : (
        <Waiting />
      )}
      {readOnly && <LatestMoment />}
      <AlertStack tiers={["emergency", "now"]} onNavigate={onNavigate} />

      {(!nothingYet || timing || sleepNow || feedPlan) && (
        <section aria-labelledby="right-now">
          <h2 id="right-now" className="sr-only">
            Right now
          </h2>
          <div className="space-y-3">
            <AnimatePresence initial={false}>
              {summary.active.filter((e) => e.id !== folded).map((e) => (
                // Keyed by kind: only one of each runs, and the optimistic copy hands over to the saved one without a remount.
                // A sleep timer left running overnight asks "Woke at 6:30 AM?" on its own card (the Last night card's first question).
                <TimerCard key={e.kind} entry={e} ask={e.kind === "sleep" ? <LeftRunningAsk entry={e} /> : undefined} />
              ))}
            </AnimatePresence>
            <SleepNow />
            {/*
              What to do at the next feed by the care team's plan (feeding/NextFeedCard). Before Last fed, so its one big
              action (Start Left, Log bottle) clears the dock at 375x667 without scrolling; Last fed and the next side follow.
            */}
            <NextFeedCard />
            <StatusCard />
          </div>
        </section>
      )}
      {/* While you slept, one line, above the morning's card: the partner who slept sees it without scrolling past the card. */}
      <WhileYouSlept />
      {/* Back after a quiet stretch on a goal: one card, once, with a clean restart to choose. */}
      <GoalReturnToday />
      {/* The morning after (sleep plan or goal): last night from the log, its unlogged stretches, and the adult's own check-in,
          straight after Right now, so its question clears the dock. After noon, folded to its one "More about last night"
          row with nothing else to show, it stands at the end of Up next instead, and that row's Answer brings it back here. */}
      <LastNightCard />
      {/*
        Up next: her next medicine and the sleep plan (its everyday Put down, and the way into the plan and goals for every
        role that reads the log), one row each, then after noon the folded Last night row. After Last night, so the
        morning's question still clears the dock.
      */}
      <UpNext />
      {nothingYet && born && <FreshPage readOnly={readOnly} />}

      <AlertStack tiers={["today", "mention", "nudge"]} onNavigate={onNavigate} />

      {/* Recently logged, and today's totals as its footnote: one group, not two cards. The totals show even with no finished row. */}
      {!nothingYet && (
        <div className="space-y-1">
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
                  <EntryRow
                    key={e.id}
                    entry={e}
                    now={now}
                    showRelative
                    quietAction
                    parts={rowParts.byRow.get(e.id)}
                    onOpenPart={(b) => open({ kind: b.kind, entry: b })}
                    onClick={() => open({ kind: e.kind, entry: e, preset: entryEditPreset(e, readOnly) })}
                  />
                ))}
              </div>
            </section>
          )}
          <LoggedToday onDetails={() => onNavigate("patterns")} />
        </div>
      )}
      <DailyDiscovery />
      <Celebrations />

      <HelpFooter />

      {/* Room for the dock, which publishes its height (the shell already pads for the tab bar). */}
      {!readOnly && <div aria-hidden className="h-[calc(var(--maple-dock-h,150px)-16px)]" />}
      <Dock />
    </div>
  );
}

/**
 * Today's totals, one line under Recently logged ("Today: 3 feeds · 4 wet · 2 dirty · 4h 00m sleep logged"), which
 * opens History → Patterns; under it, one quiet line that missing entries aren't counted, and Ask about today.
 */
function LoggedToday({ onDetails }: { onDetails: () => void }) {
  const { summary, state } = useMaple();
  const now = useNow(60_000);
  if (!summary || !state) return null;
  const s = summary.today;
  const today = dayKey(now, state.baby.timezone);
  const num = (value: string | number) => <strong className="font-semibold text-mp-ink tabular-nums">{value}</strong>;
  return (
    <section aria-labelledby="logged-today" className="px-1">
      {/* Named for screen readers and the page's outline; on screen the line says "Today:" itself. */}
      <h2 id="logged-today" className="sr-only">
        Logged today
      </h2>
      <button type="button" onClick={onDetails} className="mp-explore-today flex min-h-[44px] w-full items-center py-2 text-left text-[13px] leading-snug text-mp-ink-2">
        {/* Wraps between the totals, never inside one, and the chevron stays with the last. */}
        <span>
          <span className="whitespace-nowrap">Today: {num(s.feeds)} {s.feeds === 1 ? "feed" : "feeds"} ·</span>{" "}
          <span className="whitespace-nowrap">{num(s.wet)} wet ·</span>{" "}
          <span className="whitespace-nowrap">{num(s.dirty)} dirty ·</span>{" "}
          <span className="whitespace-nowrap">
            {s.sleepSec > 0 ? <>{num(formatDuration(s.sleepSec))} sleep logged</> : "No sleep logged today"}
            {/* Says where the line goes, for screen readers too. */}
            <Icon name="chevron-right" size={15} label="Explore patterns" className="ml-0.5 inline-block align-[-3px] text-mp-ink-3" />
          </span>
        </span>
      </button>
      <p className={cx(tone.faint, "text-[13px] leading-snug")}>Missing entries are not counted.</p>
      {/* Its negative margin lines the icon up with the text above. */}
      <AskChatButton
        className="-ml-1.5 gap-1.5! px-1.5! text-[13px]!"
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

/** A curled-up cat for the empty page. */
function RestingCat({ className }: { className?: string }) {
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
  return (
    <section className={cx(tone.card, "px-6 py-8 text-center")}>
      <RestingCat className="mx-auto h-10 w-[72px]" />
      <p className={cx(tone.heading, "mt-3 text-[20px]")}>A fresh page</p>
      <p className={cx(tone.muted, "mx-auto mt-1 max-w-[18rem] text-[15px]")}>
        {readOnly ? "Nothing logged yet today. Check back soon." : `Tap a button below when ${w.name} eats, sleeps, or needs a change.`}
      </p>
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
      <img src={photoUrl(m.id, m.data.photos?.[0]?.id ?? 0, "full")} alt={m.data.title ?? babyFirstName(state?.baby)} className="aspect-[4/3] w-full rounded-[14px] object-cover" />
      {m.data.title && <figcaption className="mt-2.5 px-2 text-center text-[15px] font-medium text-mp-ink">{m.data.title}</figcaption>}
    </figure>
  );
}
