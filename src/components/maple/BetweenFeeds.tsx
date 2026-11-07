"use client";

import { useId, type ReactNode } from "react";
import { FEED_COUNT_RULE, gapSummary, minutesShort, spanMinutes, spanText, stepsIn, type FeedStep } from "@/lib/maple/feed";
import { dayKey, formatDayLabel, formatDuration, formatTime, formatTimeNear } from "@/lib/maple/time";
import type { UnitSystem } from "@/lib/maple/types";
import { formatVolume } from "@/lib/maple/units";
import { DETAIL_COLOR } from "./palette";
import { sidesLabel } from "./StatusCard";
import { HowToRead, cx, tone } from "./ui";

/**
 * Between feeds, under the Day clock (History → Patterns): the window's feeds
 * in order, each with how long it ran and on which sides, and between each
 * pair the time from one start to the next, as a number and a bar to compare
 * by eye. It's a feeding log as a lactation consultant reads one, counted as
 * every other screen counts feeds (feed.ts feedSteps: under 10 minutes off
 * the breast is one feed, each bottle is its own). A cluster folds into one
 * row with its feed times. The feed just before the window leads, quieter,
 * so a day's first gap (the one from the evening before) shows too. It only
 * describes what was logged: no targets and no scores, and over 12 hours
 * between two logged feeds reads as a gap in the log.
 */

/** Bars fill against the longest gap shown, or 4 hours if every gap is shorter, so short days don't fill the row. */
const BAR_FLOOR_MIN = 240;

type Item =
  | { type: "feed"; step: FeedStep; context: boolean }
  | { type: "cluster"; steps: FeedStep[] };

const firstOf = (it: Item) => (it.type === "feed" ? it.step : it.steps[0]);
/** Unique per feed (a bottle can begin the same minute as a nursing feed): its first entry's id. */
const stepKey = (s: FeedStep) => (s.feed.kind === "bottle" ? `b${s.feed.entry.id}` : `n${s.feed.run.entries[0].id}-${s.start}`);

/**
 * One row per feed, except a cluster's feeds shown together: from its first run to its last, taking any bottle
 * between them along (a top-up never splits a cluster in two).
 */
function rowsOf(shown: FeedStep[], before: FeedStep | null): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < shown.length; i++) {
    const s = shown[i];
    const cluster = s.feed.kind === "breast" ? s.feed.run.cluster : null;
    let last = i;
    if (cluster !== null) {
      for (let j = i + 1; j < shown.length; j++) {
        const x = shown[j].feed;
        if (x.kind === "bottle") continue;
        if (x.run.cluster !== cluster) break;
        last = j;
      }
    }
    if (last > i) {
      items.push({ type: "cluster", steps: shown.slice(i, last + 1) });
      i = last;
    } else items.push({ type: "feed", step: s, context: s === before });
  }
  return items;
}

/** "8:03, 8:35, 9:12, 11:29 AM": AM/PM only where it changes, and on the last. */
function timesText(times: number[], tz: string): string {
  return times.map((t, i) => (i < times.length - 1 ? formatTimeNear(t, times[i + 1], tz) : formatTime(t, tz))).join(", ");
}

/** A feed row's words: what it was, then its sides and anything worth knowing about it. */
function feedWords(step: FeedStep, tz: string, units: UnitSystem): { main: string; more: string | null } {
  if (step.feed.kind === "bottle") {
    const ml = step.feed.entry.data.amount_ml;
    return { main: ml ? `Bottle · ${formatVolume(ml, units)}` : "Bottle", more: null };
  }
  const run = step.feed.run;
  const total = minutesShort(run.min.total);
  const bits: string[] = [];
  const sides = sidesLabel(run);
  if (sides) bits.push(sides);
  // Short breaks (under 10 minutes off) are the same feed: say so, with when it ended, rather than hide the time.
  if (!run.live && run.end !== null && spanMinutes(run.start, run.end) - run.min.total >= 3) bits.push(`on and off until ${formatTime(run.end, tz)}`);
  if (run.cluster !== null) bits.push("part of a cluster");
  return { main: run.live ? `Nursing · ${total} so far` : `Nursed ${total}`, more: bits.length ? bits.join(" · ") : null };
}

/** The mark on the line: a dot for nursing, a ring for a bottle, a ringed dot for a cluster; quieter for the feed before. */
function Mark({ item }: { item: Item }) {
  const base = "relative z-[1] mt-[5px] block shrink-0 rounded-full";
  if (item.type === "cluster") {
    return (
      <span aria-hidden className={cx(base, "mp-kind-ink flex h-3 w-3 items-center justify-center border-[1.5px] border-current bg-mp-surface")} style={{ color: DETAIL_COLOR.nursing }}>
        <span className="block h-1.5 w-1.5 rounded-full bg-current" />
      </span>
    );
  }
  if (item.context) return <span aria-hidden className={cx(base, "h-2.5 w-2.5 border-[1.5px] border-mp-ink-3 bg-mp-surface")} />;
  if (item.step.feed.kind === "bottle") {
    return <span aria-hidden className={cx(base, "mp-kind-ink h-2.5 w-2.5 border-2 border-current bg-mp-surface")} style={{ color: DETAIL_COLOR.bottle }} />;
  }
  return <span aria-hidden className={cx(base, "mp-kind-fill h-2.5 w-2.5")} style={{ backgroundColor: DETAIL_COLOR.nursing }} />;
}

/** The line the marks sit on, through the mark column of every row, from the first mark to the last (10px: a mark's center). */
function Spine({ first = false, last = false }: { first?: boolean; last?: boolean }) {
  if (first && last) return null;
  return <span aria-hidden className={cx("absolute left-1/2 w-[1.5px] -translate-x-1/2 bg-mp-line", first ? "top-[10px] bottom-0" : last ? "top-0 h-[10px]" : "inset-y-0")} />;
}

/** "Today", "Yesterday", else the weekday: a list crosses at most one midnight past the window's own day, so "Mon" is enough. */
function dayWord(key: string, todayKey: string): string {
  return formatDayLabel(key, todayKey).split(",")[0];
}

export default function BetweenFeeds({
  steps,
  lo,
  hi,
  nowMs,
  tz,
  todayKey,
  units,
  usualMin,
}: {
  /** Every feed loaded (feedSteps), so the window's first gap can reach back before it. */
  steps: FeedStep[];
  /** The dial's window: feeds that began in [lo, hi), up to now. */
  lo: number;
  hi: number;
  nowMs: number;
  tz: string;
  todayKey: string;
  units: UnitSystem;
  /** About every, when the screen already says it another way (the last 24 hours: Today's Feeds lately). */
  usualMin?: number | null;
}) {
  const id = useId();
  const inWindow = stepsIn(steps, lo, Math.min(hi, nowMs + 1));
  const summary = gapSummary(inWindow);
  if (!inWindow.length || !summary.gaps) return null;

  // The feed before the window, when the window's first feed has a counted gap from it.
  const firstIndex = steps.indexOf(inWindow[0]);
  const before = inWindow[0].gapMin !== null && firstIndex > 0 ? steps[firstIndex - 1] : null;
  const items = rowsOf(before ? [before, ...inWindow] : inWindow, before);
  const usual = usualMin ?? summary.usualMin;
  const anyCluster = inWindow.some((s) => s.inCluster);
  const longest = summary.longest!;
  const scale = Math.max(BAR_FLOOR_MIN, ...items.map((it) => firstOf(it).gapMin ?? 0));
  // Day names only when the list crosses midnight (the evening before, or the last 24 hours).
  const days = items.map((it) => dayKey(firstOf(it).start, tz));
  const manyDays = new Set(days).size > 1;

  const rows: ReactNode[] = [];
  items.forEach((item, i) => {
    const step = firstOf(item);
    const last = i === items.length - 1;
    if (i > 0) {
      // Between two rows: the time from the start of the one before to the start of this one.
      const long = step.gapMin === null && step.sinceMs !== null;
      if (step.gapMin !== null || long) {
        const words = step.gapMin !== null ? minutesShort(step.gapMin) : formatDuration(step.sinceMs! / 1000);
        rows.push(
          <li key={`gap-${stepKey(step)}`} className="relative grid grid-cols-[64px_20px_minmax(0,1fr)] gap-x-1.5">
            <span />
            <span className="relative">
              <Spine />
            </span>
            {long ? (
              <span className="py-1.5 text-[13px] leading-snug text-mp-ink-2">
                <span className="font-semibold tabular-nums text-mp-ink">{words}</span>
                <span className="sr-only"> until the next logged feed</span>
                <span className="block text-[12px] text-mp-ink-3">Over 12 hours, so it&apos;s left out in case a feed wasn&apos;t logged.</span>
              </span>
            ) : (
              <span className="flex min-h-[30px] items-center gap-2.5 py-1">
                <span className="min-w-[58px] shrink-0 text-[14px] font-semibold whitespace-nowrap tabular-nums text-mp-ink">
                  {words}
                  <span className="sr-only"> until the next feed{step.inCluster ? ", in a cluster" : ""}</span>
                </span>
                <span aria-hidden className="h-1.5 min-w-0 flex-1">
                  <span
                    className="block h-full rounded-full bg-[var(--v-gap,var(--mp-ink-3))]"
                    style={{ width: `${Math.max(3, Math.min(100, (step.gapMin! / scale) * 100))}%` }}
                  />
                </span>
              </span>
            )}
          </li>
        );
      }
    }

    const dayLabel = manyDays && (i === 0 || days[i] !== days[i - 1]) ? dayWord(days[i], todayKey) : null;
    const time = (
      <span className={cx("pt-px text-right text-[13px] leading-[18px] tabular-nums", item.type === "feed" && item.context ? "text-mp-ink-3" : "text-mp-ink-2")}>
        {dayLabel && <span className="block text-[11px] leading-4 font-medium text-mp-ink-3">{dayLabel}</span>}
        {formatTime(step.start, tz)}
      </span>
    );
    let body: ReactNode;
    if (item.type === "cluster") {
      const runs = item.steps.flatMap((s) => (s.feed.kind === "breast" ? [s.feed.run] : []));
      const bottles = item.steps.filter((s) => s.feed.kind === "bottle");
      const inside = item.steps.slice(1).flatMap((s) => (s.gapMin === null ? [] : [s.gapMin]));
      const closest = Math.min(...inside);
      const furthest = Math.max(...inside);
      const apart = !inside.length ? null : closest === furthest ? `${minutesShort(closest)} apart` : `${minutesShort(closest)}–${minutesShort(furthest)} apart`;
      const nursed = runs.reduce((n, r) => n + r.min.total, 0);
      // A cluster past the window's edge (across midnight on a past day) shows only its feeds in the window: say so.
      const cluster = runs[0].cluster;
      const all = steps.filter((x) => x.feed.kind === "breast" && x.feed.run.cluster === cluster).length;
      body = (
        <span className="min-w-0 pb-1.5 text-[14px] leading-[18px] text-mp-ink">
          <span className="font-semibold">Cluster · {all > runs.length ? `${runs.length} of its ${all} feeds` : `${runs.length} feeds`}</span>
          <span className="mt-0.5 block text-[12px] leading-snug text-mp-ink-2 tabular-nums">{timesText(runs.map((r) => r.start), tz)}</span>
          <span className="block text-[12px] leading-snug text-mp-ink-3">
            {[apart, `nursed ${minutesShort(nursed)}`, ...bottles.map((b) => `bottle at ${formatTime(b.start, tz)}`)].filter(Boolean).join(" · ")}
          </span>
        </span>
      );
    } else {
      const words = feedWords(item.step, tz, units);
      body = (
        <span className={cx("min-w-0 pb-1.5 text-[14px] leading-[18px]", item.context ? "text-mp-ink-2" : "text-mp-ink")}>
          <span className={cx(!item.context && "font-medium")}>{words.main}</span>
          {words.more && <span className="mt-0.5 block text-[12px] leading-snug text-mp-ink-2">{words.more}</span>}
        </span>
      );
    }
    rows.push(
      <li key={`${item.type}-${stepKey(step)}`} className="relative grid grid-cols-[64px_20px_minmax(0,1fr)] gap-x-1.5">
        {time}
        <span className="relative flex justify-center">
          <Spine first={i === 0} last={last} />
          <Mark item={item} />
        </span>
        {body}
      </li>
    );
  });

  return (
    <section aria-labelledby={id} className="mt-3 rounded-[18px] border border-mp-line bg-mp-surface">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-3.5">
        <h3 id={id} className={cx(tone.heading, "text-[15px]")}>Between feeds</h3>
        <span className="text-[12px] text-mp-ink-3">Start to start</span>
      </div>
      <dl className="flex gap-2 px-3 pt-2.5 pb-3">
        {usual !== null && (
          <div className="min-w-0 flex-1 rounded-xl bg-mp-sunken px-3 py-2">
            <dt className="text-[12px] text-mp-ink-2">About every</dt>
            <dd className="text-[22px] leading-tight font-semibold tracking-[-0.01em] text-mp-ink tabular-nums">{minutesShort(usual)}</dd>
            {anyCluster && <dd className="text-[11px] text-mp-ink-3">outside clusters</dd>}
          </div>
        )}
        <div className="min-w-0 flex-1 rounded-xl bg-mp-sunken px-3 py-2">
          <dt className="text-[12px] text-mp-ink-2">Longest gap</dt>
          <dd className="text-[22px] leading-tight font-semibold tracking-[-0.01em] text-mp-ink tabular-nums">{minutesShort(summary.longestMin!)}</dd>
          <dd className="text-[11px] text-mp-ink-3 tabular-nums">{spanText(longest.start - longest.sinceMs!, longest.start, tz)}</dd>
        </div>
      </dl>
      <ol aria-label="Feeds and the time between them" className="border-t border-mp-line px-3 pt-3 pb-1">
        {rows}
      </ol>
      <HowToRead className="border-t border-mp-line px-4">
        <p>Each bar is the time from the start of one feed to the start of the next, the way Today counts Last feed. A longer bar is a longer gap.</p>
        <p>{FEED_COUNT_RULE} A cluster shows as one row, and About every leaves the gaps inside it out.</p>
        <p>Only what was logged counts. Over 12 hours between two logged feeds is left out of the numbers, in case a feed wasn&apos;t logged.</p>
      </HowToRead>
    </section>
  );
}
