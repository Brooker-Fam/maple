"use client";

import { useId, type ReactNode } from "react";
import { feedPartsList, planUnitsOf } from "@/lib/maple/describe";
import { bottleAmount, gapSummary, minutesShort, sideMinutesText, spanText, stepsIn, type GapStep, type Latch } from "@/lib/maple/feed";
import { dayKey, formatDayLabel, formatDuration, formatTime } from "@/lib/maple/time";
import type { UnitSystem } from "@/lib/maple/types";
import { formatVolume } from "@/lib/maple/units";
import { DETAIL_COLOR } from "./palette";
import { HowToRead, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

/**
 * Between feeds, under the Day clock (History → Patterns): every time she
 * went on the breast and every bottle in the window, in order, and between
 * each pair the time from one start to the next, as a number and a bar, so
 * each gap can be read on its own the way a lactation consultant reads a
 * feeding log (a run of short gaps, a few long ones). On top, how many gaps
 * fell under an hour, 1 to 2 hours and so on, and the longest.
 *
 * Rows come from feed.ts feedGaps: coming off for under 2 minutes is the
 * same row, any longer and going back on is a new one, whatever was tapped.
 * Back on within 10 minutes is still one feed on Today and in the counts, so
 * its row says "back on after 6m"; milk at the breast and a top-up are part
 * of their feed, so they ride on that row ("+ 20 ml in the syringe", "+ 35 ml
 * top-up"), never a row or a gap of their own. A cluster is a shaded band, never folded,
 * so its gaps show too. The time on the breast just before the window leads,
 * quieter, so a day's first gap (from the evening before) shows. It only
 * describes what was logged: no targets, no scores, and over 12 hours
 * between two logged feeds reads as a gap in the log.
 */

/** Bars fill against the longest gap shown, or 4 hours if every gap is shorter, so short days don't fill the row. */
const BAR_FLOOR_MIN = 240;
const BUCKET_NAMES = ["Under 1 hour", "1 to 2 hours", "2 to 3 hours", "3 to 4 hours", "4 hours or more"];
const GRID = "grid grid-cols-[64px_20px_minmax(0,1fr)] gap-x-1.5";
// A cluster's band; at night the sunken ink is too close to the card, so it's the night look's amber wash (as .mp-kind's).
const BAND = "-mx-2 px-2 bg-mp-sunken/70 [.maple-night_&]:bg-[rgb(224_169_59/0.08)]";

/** Unique per row (a bottle can begin the same minute as nursing). */
const stepKey = (s: GapStep) => (s.feed.kind === "bottle" ? `b${s.feed.entry.id}` : `n${s.feed.latch.entries[0].id}-${s.start}`);

/** "Left", "Right", "Back and forth" for one side; "L 20 · R 9" for more, the minutes on each. */
function sidesText(latch: Latch): string {
  const { has } = latch.min;
  const sides = Number(has.L) + Number(has.R) + Number(has.B);
  if (sides === 0) return "";
  if (sides === 1) return has.L ? "Left" : has.R ? "Right" : "Back and forth";
  return sideMinutesText(latch.min);
}

/**
 * A row's words: what it was, then its sides, what was given with it (as Today says it: "+ 20 ml in the syringe",
 * "+ 30 ml top-up", with the plan's unit beside the app's, planUnits), and how soon she was back on.
 */
function feedWords(step: GapStep, units: UnitSystem, planUnits: UnitSystem | null): { main: string; more: string[] } {
  if (step.feed.kind === "bottle") {
    const ml = bottleAmount(step.feed.entry.data);
    return { main: ml ? `Bottle · ${formatVolume(ml, units)}` : "Bottle", more: [] };
  }
  const latch = step.feed.latch;
  const total = minutesShort(latch.min.total);
  const more = [sidesText(latch), ...feedPartsList(latch.topUps, units, planUnits), step.backOnMin !== null ? `back on after ${minutesShort(step.backOnMin)}` : ""].filter(Boolean);
  return { main: latch.end === null ? `Nursing · ${total} so far` : `Nursed ${total}`, more };
}

/** The mark on the line: a dot for nursing, a ring for a bottle; quieter for the one before the window. */
function Mark({ step, context }: { step: GapStep; context: boolean }) {
  const base = "relative z-[1] mt-[5px] block h-2.5 w-2.5 shrink-0 rounded-full";
  if (context) return <span aria-hidden className={cx(base, "border-[1.5px] border-mp-ink-3 bg-mp-surface")} />;
  if (step.feed.kind === "bottle") return <span aria-hidden className={cx(base, "mp-kind-ink border-2 border-current bg-mp-surface")} style={{ color: DETAIL_COLOR.bottle }} />;
  return <span aria-hidden className={cx(base, "mp-kind-fill")} style={{ backgroundColor: DETAIL_COLOR.nursing }} />;
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
}: {
  /** Every time on the breast and every bottle loaded (feedGaps), so the window's first gap can reach back before it. */
  steps: GapStep[];
  /** The dial's window: rows that began in [lo, hi), up to now. */
  lo: number;
  hi: number;
  nowMs: number;
  tz: string;
  todayKey: string;
  units: UnitSystem;
}) {
  const id = useId();
  // With a plan saved in the other unit, a feed's parts say the plan's too, as Today and the feed's row do.
  const planUnits = planUnitsOf(useMaple().state?.baby.settings);
  const inWindow = stepsIn(steps, lo, Math.min(hi, nowMs + 1));
  const summary = gapSummary(inWindow);
  if (!inWindow.length || !summary.gaps || !summary.longest) return null;

  // The one before the window, when the window's first has a counted gap from it.
  const firstIndex = steps.indexOf(inWindow[0]);
  const before = inWindow[0].gapMin !== null && firstIndex > 0 ? steps[firstIndex - 1] : null;
  const shown = before ? [before, ...inWindow] : inWindow;
  const longest = summary.longest;
  const scale = Math.max(BAR_FLOOR_MIN, ...shown.map((s) => s.gapMin ?? 0));
  const most = Math.max(1, ...summary.buckets);
  // Day names only when the list crosses midnight (the evening before, or the last 24 hours).
  const days = shown.map((s) => dayKey(s.start, tz));
  const manyDays = new Set(days).size > 1;

  // Each cluster's band: from its first row shown to its last, a bottle between them included.
  const bands = new Map<number, { first: number; last: number }>();
  shown.forEach((s, i) => {
    if (s.cluster === null) return;
    const band = bands.get(s.cluster);
    if (band) band.last = i;
    else bands.set(s.cluster, { first: i, last: i });
  });
  const bandAt = (i: number) => [...bands.values()].find((b) => i >= b.first && i <= b.last) ?? null;
  // A cluster's own span and count, from every time on the breast loaded (it may reach past the window).
  const clusterWords = (cluster: number) => {
    const latches = steps.flatMap((s) => (s.feed.kind === "breast" && s.feed.latch.run.cluster === cluster ? [s.feed.latch] : []));
    const runs = new Set(latches.map((l) => l.run));
    const ends = [...runs].map((r) => r.end);
    const end = ends.includes(null) ? null : Math.max(...(ends as number[]));
    return [`Cluster ${spanText(latches[0].start, end, tz)}`, `${runs.size} feeds`];
  };

  const rows: ReactNode[] = [];
  shown.forEach((step, i) => {
    const band = bandAt(i);
    const inBand = band !== null && i > band.first;
    if (i > 0) {
      // Between two rows: the time from the start of the one before to the start of this one.
      const long = step.gapMin === null && step.sinceMs !== null;
      if (step.gapMin !== null || long) {
        rows.push(
          <li key={`gap-${stepKey(step)}`} className={cx(GRID, inBand && BAND)}>
            <span />
            <span className="relative">
              <Spine />
            </span>
            {long ? (
              <span className="py-1.5 text-[13px] leading-snug text-mp-ink-2">
                <span className="font-semibold tabular-nums text-mp-ink">{formatDuration(step.sinceMs! / 1000)}</span>
                <span className="sr-only"> until the next logged feed</span>
                <span className="block text-[12px] text-mp-ink-3">Over 12 hours, so it&apos;s left out in case a feed wasn&apos;t logged.</span>
              </span>
            ) : (
              <span className="flex min-h-[28px] items-center gap-2.5 py-0.5">
                <span className="min-w-[58px] shrink-0 text-[14px] font-semibold whitespace-nowrap tabular-nums text-mp-ink">
                  {minutesShort(step.gapMin!)}
                  <span className="sr-only"> until the next start</span>
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
    if (band && band.first === i) {
      rows.push(
        <li key={`band-${stepKey(step)}`} className={cx(GRID, BAND, "rounded-t-xl pt-1.5")}>
          <span />
          <span className="relative">{i > 0 && <Spine />}</span>
          <span className="pb-0.5 text-[12px] font-semibold text-mp-ink-2 tabular-nums">
            {clusterWords(step.cluster!).map((bit, n) => (
              <span key={bit}>
                {n > 0 && " · "}
                <span className="whitespace-nowrap">{bit}</span>
              </span>
            ))}
          </span>
        </li>
      );
    }

    const context = step === before;
    if (manyDays && (i === 0 || days[i] !== days[i - 1])) {
      rows.push(
        <li key={`day-${stepKey(step)}`} className={cx(GRID, band && BAND)}>
          <span className="text-right text-[11px] leading-4 font-medium text-mp-ink-3">{dayWord(days[i], todayKey)}</span>
          <span className="relative">{i > 0 && <Spine />}</span>
          <span />
        </li>
      );
    }
    const words = feedWords(step, units, planUnits);
    rows.push(
      <li key={`row-${stepKey(step)}`} className={cx(GRID, band && BAND, band?.last === i && "rounded-b-xl pb-1")}>
        <span className={cx("pt-px text-right text-[13px] leading-[18px] tabular-nums", context ? "text-mp-ink-3" : "text-mp-ink-2")}>{formatTime(step.start, tz)}</span>
        <span className="relative flex justify-center">
          <Spine first={i === 0} last={i === shown.length - 1} />
          <Mark step={step} context={context} />
        </span>
        <span className={cx("min-w-0 pb-1 text-[14px] leading-[18px]", context ? "text-mp-ink-2" : "text-mp-ink")}>
          <span className={cx(!context && "font-medium")}>{words.main}</span>
          {words.more.map((bit) => (
            <span key={bit} className="text-[13px] text-mp-ink-2">
              {" · "}
              <span className="whitespace-nowrap">{bit}</span>
            </span>
          ))}
        </span>
      </li>
    );
  });

  return (
    <section aria-labelledby={id} className="mt-3 rounded-[18px] border border-mp-line bg-mp-surface">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-3.5">
        <h3 id={id} className={cx(tone.heading, "text-[15px]")}>Between feeds</h3>
        <span className="text-[12px] text-mp-ink-3">Start to start</span>
      </div>
      <p className="px-4 pt-1 text-[13px] leading-snug text-mp-ink-2 tabular-nums">
        {summary.gaps} gap{summary.gaps === 1 ? "" : "s"} · longest <strong className="font-semibold text-mp-ink">{minutesShort(summary.longestMin!)}</strong>, {spanText(longest.start - longest.sinceMs!, longest.start, tz)}
      </p>
      <dl aria-label="Gaps by length" className="space-y-1 px-4 pt-2.5 pb-3.5">
        {summary.buckets.map((count, i) => (
          <div key={i} className="grid grid-cols-[104px_minmax(0,1fr)_28px] items-center gap-2">
            <dt className="text-[12px] text-mp-ink-2">{BUCKET_NAMES[i]}</dt>
            <dd aria-hidden className="h-2 rounded-full bg-mp-sunken">
              {count > 0 && <span className="block h-full rounded-full bg-[var(--v-gap,var(--mp-ink-3))]" style={{ width: `${Math.max(4, (count / most) * 100)}%` }} />}
            </dd>
            <dd className="text-right text-[14px] font-semibold tabular-nums text-mp-ink">{count}</dd>
          </div>
        ))}
      </dl>
      <ol aria-label="Feeds and the time between them" className="border-t border-mp-line px-3 pt-3 pb-1">
        {rows}
      </ol>
      <HowToRead className="border-t border-mp-line px-4">
        <p>Each row is a time on the breast, or a bottle on its own. Between rows is the time from one start to the next start. Coming off for under 2 minutes, like switching sides, stays on the same row, and milk at the breast or a top-up given with nursing is on its row.</p>
        <p>Back on within 10 minutes counts as the same feed on Today and in the feed counts. Here it gets its own row, marked &ldquo;back on after&rdquo;, so that gap shows too.</p>
        <p>A shaded band is a cluster: 3 or more feeds, each starting less than 30 minutes after the last one ended.</p>
        <p>Only what was logged counts. Over 12 hours between two logged feeds is left out of the numbers, in case a feed wasn&apos;t logged.</p>
      </HowToRead>
    </section>
  );
}
