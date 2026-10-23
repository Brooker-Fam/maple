"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { feedTotals } from "@/lib/maple/feed";
import {
  DISCLAIMER,
  FEEDS_PER_DAY,
  SLEEP_TOTAL_NOTE,
  STOOL_COLOR_INFO,
  diaperTargets,
  tummyGoalMinutes,
} from "@/lib/maple/guidelines";
import { isVitaminD, statsFor, type DayStats } from "@/lib/maple/insights";
import {
  DEFAULT_TZ,
  addDays,
  babyAge,
  dayBounds,
  dayKey,
  daysBetween,
  formatDayLabel,
  formatDuration,
  formatTime,
  localParts,
  parseDayKey,
  zonedTimeToUtc,
} from "@/lib/maple/time";
import { formatTempBoth, formatVolume, formatWeightBoth, formatLengthBoth, mlToOz } from "@/lib/maple/units";
import type { Entry, EntryOf, MapleState, StoolColor, UnitSystem } from "@/lib/maple/types";
import type { TabId } from "./MapleApp";
import { Icon, KindBadge } from "./icons";
import { bucketWindows, dstNote, fetchRange, mergeLive, requestTimelineDay, statsByDay, useEntryRange, type TimeWindow } from "./LogTab";
import { KIND_COLOR } from "./palette";
import { useSheets } from "./sheets";
import { Button, Card, EmptyState, SectionTitle, Segmented, cx, tone } from "./ui";
import { useMaple, useNow } from "./useMaple";

/**
 * Patterns: the rhythm of her days (ribbons), daily totals, growth on the WHO
 * curves, and a plain-text summary for the pediatrician. Everything here
 * describes what was logged; nothing scores it. Charts are hand-rolled SVG
 * (no chart library), sized to the card with a ResizeObserver.
 */

// The growth chart carries ~60 KB of WHO tables: load it only when Patterns renders it.
const GrowthChart = dynamic(() => import("./GrowthChart"), {
  ssr: false,
  loading: () => <div className="h-[360px]" aria-hidden />,
});

const H = 3600_000;
const MIN = 60_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Chart colors: palette.ts hues, re-stepped per theme so each pair that
 * shares a chart clears the data-viz checks (OKLCH chroma ≥ 0.10, adjacent
 * ΔE ≥ 15 normal / ≥ 8 under protan & deutan simulation, ≥ 3:1 on the card;
 * honey is the one sub-3:1 mark in light mode, so every chart has a table).
 * Ribbon lanes (feeds on top, sleep/tummy middle, diapers bottom) separate
 * classes by position as well as hue.
 *
 * The chrome (grid, track, axis, the halo around diaper dots) comes from the
 * mp-* tokens, so it follows dark mode and the night look on its own. The
 * series keep their dark-mode hues at night, like the day dial, so a legend
 * still matches its marks, but dimmed toward the night surface the way
 * photos are; the chrome-like marks (band, target ticks, dot edges) turn
 * amber there.
 */
const VIZ_VARS =
  "[--v-grid:var(--mp-line)] [--v-track:var(--mp-sunken)] [--v-axis:color-mix(in_srgb,var(--mp-ink)_28%,transparent)] [--v-surface:var(--mp-surface)] " +
  "[--v-sleep:#9077BC] [--v-nurse:#C55F1D] [--v-bottle:#E0A93B] [--v-pee:#389EC1] [--v-poop:#905718] [--v-tummy:#69863E] [--v-pump:#CA805D] " +
  "[--v-band:rgba(92,122,74,0.13)] [--v-target:#7A5A12] [--v-dot-edge:rgba(29,68,32,0.35)] [--v-now:#C55F1D] " +
  "dark:[--v-sleep:#9E85CB] dark:[--v-nurse:#BF4213] dark:[--v-bottle:#B88C06] dark:[--v-pee:#3CA1C4] dark:[--v-poop:#985E22] dark:[--v-pump:#C97E5B] " +
  "dark:[--v-band:rgba(169,192,143,0.13)] dark:[--v-target:#E0C27A] dark:[--v-dot-edge:rgba(245,237,223,0.5)] dark:[--v-now:#E0A93B] " +
  "[.maple-night_&]:[--v-sleep:color-mix(in_srgb,#9E85CB_72%,#13170F)] [.maple-night_&]:[--v-nurse:color-mix(in_srgb,#BF4213_85%,#13170F)] [.maple-night_&]:[--v-bottle:color-mix(in_srgb,#B88C06_85%,#13170F)] " +
  "[.maple-night_&]:[--v-pee:color-mix(in_srgb,#3CA1C4_72%,#13170F)] [.maple-night_&]:[--v-poop:color-mix(in_srgb,#985E22_85%,#13170F)] [.maple-night_&]:[--v-tummy:color-mix(in_srgb,#69863E_80%,#13170F)] [.maple-night_&]:[--v-pump:color-mix(in_srgb,#C97E5B_80%,#13170F)] " +
  "[.maple-night_&]:[--v-band:rgb(224_169_59/0.08)] [.maple-night_&]:[--v-target:rgb(224_169_59/0.7)] [.maple-night_&]:[--v-dot-edge:rgb(224_169_59/0.3)] [.maple-night_&]:[--v-now:#D9772B]";

const AXIS_TEXT = "fill-mp-ink-3 text-[10px] tabular-nums";

type Range = "7" | "14" | "30" | "all";
type RibbonMode = "days" | "nights";

// ── Tab ──────────────────────────────────────────────────────────────────

export default function PatternsTab({ onNavigate }: { onNavigate?: (t: TabId) => void } = {}) {
  const { state, units, readOnly } = useMaple();
  const { open } = useSheets();
  const now = useNow(60_000);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const todayKey = dayKey(now, tz);
  const bornAt = state?.baby.born_at ?? null;
  const bornKey = bornAt ? dayKey(Date.parse(bornAt), tz) : null;

  const [range, setRange] = useState<Range>("7");
  const [mode, setMode] = useState<RibbonMode>("days");

  const span = range === "all" ? Math.min(daysBetween(bornKey ?? addDays(todayKey, -29), todayKey) + 1, 399) : Number(range);
  let fromKey = addDays(todayKey, -(span - 1));
  if (bornKey && bornKey > fromKey) fromKey = bornKey > todayKey ? todayKey : bornKey;
  // One extra day back so the first night (noon → noon) and sleeps across midnight are complete.
  const { entries, ready, loaded, loadedFrom, partialDays } = useEntryRange(addDays(fromKey, -1), todayKey);
  // While older weeks load (newest first), show only what has arrived instead of empty days.
  const viewFrom = ready || !loadedFrom || loadedFrom <= fromKey ? fromKey : loadedFrom;

  const days = useMemo(() => statsByDay(entries, viewFrom, todayKey, now, tz), [entries, viewFrom, todayKey, now, tz]);
  const loggedDays = days.filter((d) => d.feeds + d.diapers + d.sleeps > 0).length;
  // Charts start at the first logged day: blank days before logging began would read as "0 feeds".
  const firstLogged = days.findIndex((d) => d.feeds + d.diapers + d.sleeps > 0);
  const chartDays = firstLogged > 0 ? days.slice(firstLogged) : days;

  const goToDay = useCallback(
    (key: string) => {
      if (!onNavigate) return;
      requestTimelineDay(key);
      onNavigate("log");
    },
    [onNavigate]
  );

  if (!state) return null;

  return (
    <div className={cx("px-4 pt-[max(1.25rem,env(safe-area-inset-top))]", VIZ_VARS)}>
      <header className="mb-4">
        <h1 className={cx(tone.display, "text-[34px] leading-[1.05]")}>Patterns</h1>
        <p className={cx(tone.muted, "mt-1 text-[15px] leading-snug")}>What the days have looked like, for you and her pediatrician.</p>
      </header>

      <Segmented
        className="mb-6"
        value={range}
        onChange={setRange}
        options={[
          { value: "7", label: "7 days" },
          { value: "14", label: "14 days" },
          { value: "30", label: "30 days" },
          { value: "all", label: "All" },
        ]}
      />

      <div className={cx("space-y-6 transition-opacity", !ready && loaded && "opacity-60")} aria-busy={!ready}>
        {!loaded ? (
          <EmptyState icon="leaf" title="Gathering the pages…" />
        ) : (
          <>
            {loggedDays < 2 && ready && (
              <Card>
                <EmptyState icon="cat" title="Patterns need a few days to grow">
                  Bruce is keeping count ({Math.min(loggedDays, 2)} of 2 days). Keep logging and her rhythms will show up here.
                </EmptyState>
              </Card>
            )}
            {loggedDays >= 2 && <Insights days={chartDays} entries={entries} todayKey={todayKey} tz={tz} />}

            {!ready && <p className={cx(tone.faint, "px-1 text-xs")}>Gathering earlier days…</p>}
            {partialDays.length > 0 && (
              <p className={cx(tone.inset, tone.muted, "flex gap-2.5 px-4 py-3 text-[13px] leading-snug")} role="status">
                <Icon name="info" size={16} className="mt-px shrink-0 text-mp-ink-3" />
                <span>
                  {partialDays.map((k) => formatDayLabel(k, todayKey)).join(", ")} had more entries than we can load at once, so the
                  counts for {partialDays.length === 1 ? "that day" : "those days"} only include the most recent ones.
                </span>
              </p>
            )}
            {loggedDays >= 1 && (
              <Ribbons
                entries={entries}
                fromKey={viewFrom}
                todayKey={todayKey}
                tz={tz}
                now={now}
                bornAt={bornAt}
                mode={mode}
                onMode={setMode}
                onPickDay={onNavigate ? goToDay : undefined}
                units={units}
              />
            )}

            {loggedDays >= 2 && (
              <DailyCharts days={chartDays} entries={entries} todayKey={todayKey} tz={tz} bornAt={bornAt} units={units} now={now} />
            )}
          </>
        )}

        <section aria-labelledby="maple-growth">
          <SectionTitle>
            <span id="maple-growth">Growth</span>
          </SectionTitle>
          <Card>
            <GrowthChart
              baby={state.baby}
              growth={state.growth}
              units={units}
              todayKey={todayKey}
              onAdd={readOnly ? undefined : () => open({ kind: "growth" })}
              onEdit={(e) => open({ kind: "growth", entry: e })}
            />
          </Card>
        </section>

        <VisitSummary state={state} todayKey={todayKey} tz={tz} now={now} />

        <p className={cx(tone.muted, "px-2 pb-4 text-center text-xs leading-snug")}>{DISCLAIMER}</p>
      </div>
    </div>
  );
}

// ── Insights: a few plain sentences, descriptive only ────────────────────

function hourLabel(h: number): string {
  const hh = ((h % 24) + 24) % 24;
  if (hh === 0) return "midnight";
  if (hh === 12) return "noon";
  return `${hh % 12} ${hh < 12 ? "AM" : "PM"}`;
}

function Insights({ days, entries, todayKey, tz }: { days: DayStats[]; entries: Entry[]; todayKey: string; tz: string }) {
  const lines = useMemo(() => {
    const out: string[] = [];
    // Whole days only (today is still being written).
    const full = days.filter((d) => d.key !== todayKey && d.feeds + d.diapers + d.sleeps > 0);
    const base = full.length ? full : days;
    const keys = new Set(base.map((d) => d.key));
    const feeds = entries.filter((e): e is EntryOf<"feed"> => e.kind === "feed" && keys.has(dayKey(Date.parse(e.started_at), tz)));

    const avgFeeds = base.reduce((n, d) => n + d.feeds, 0) / Math.max(1, base.length);
    if (feeds.length) {
      // Busiest 3-hour stretch of the clock, if one clearly stands out.
      const byHour = new Array(24).fill(0) as number[];
      for (const f of feeds) byHour[localParts(Date.parse(f.started_at), tz).hour]++;
      let best = 0;
      let bestCount = 0;
      for (let h = 0; h < 24; h++) {
        const c = byHour[h] + byHour[(h + 1) % 24] + byHour[(h + 2) % 24];
        if (c > bestCount) {
          best = h;
          bestCount = c;
        }
      }
      const busy = feeds.length >= 8 && bestCount / feeds.length >= 0.2 ? `, busiest between ${hourLabel(best)} and ${hourLabel(best + 3)}` : "";
      out.push(`About ${Math.round(avgFeeds)} feed${Math.round(avgFeeds) === 1 ? "" : "s"} a day${busy}.`);
    }

    const left = base.reduce((n, d) => n + d.leftSec, 0);
    const right = base.reduce((n, d) => n + d.rightSec, 0);
    if (left + right >= 30 * 60) {
      const l = Math.round((left / (left + right)) * 100);
      out.push(`Nursing split: L ${l}% · R ${100 - l}%.`);
    }

    let clusterDays = 0;
    let evening = 0;
    let total = 0;
    for (const d of base) {
      const [a, b] = dayBounds(d.key, tz);
      const cs = findClusters(
        feeds.filter((f) => {
          const t = Date.parse(f.started_at);
          return t >= a.getTime() && t < b.getTime();
        })
      );
      if (cs.length) clusterDays++;
      for (const c of cs) {
        total++;
        const h = localParts(c.from, tz).hour;
        if (h >= 16 && h < 24) evening++;
      }
    }
    if (clusterDays) {
      const when = evening / total > 0.6 ? ", mostly in the evening" : "";
      out.push(`Close-together feeds (3 or more within 3 hours) on ${clusterDays} of ${base.length} day${base.length === 1 ? "" : "s"}${when}.`);
    } else {
      const sleep = base.reduce((n, d) => n + d.sleepSec, 0) / Math.max(1, base.length);
      if (sleep >= 3600) out.push(`About ${formatDuration(sleep)} of logged sleep a day.`);
    }
    return out.slice(0, 3);
  }, [days, entries, todayKey, tz]);

  if (!lines.length) return null;
  // The first line is the headline; the rest read on as one short paragraph.
  const [lead, ...rest] = lines;
  return (
    <section aria-labelledby="maple-lately" className="px-1">
      <h2 id="maple-lately" className={tone.label}>
        Lately
      </h2>
      <p className="mt-1 text-[20px] leading-[1.3] font-semibold tracking-[-0.01em] text-mp-ink">{lead}</p>
      {rest.length > 0 && <p className={cx(tone.muted, "mt-1.5 text-[17px] leading-snug")}>{rest.join(" ")}</p>}
    </section>
  );
}

// ── Ribbons ──────────────────────────────────────────────────────────────

type Span = { x1: number; x2: number; title: string };
type FeedMark = Span & { bottle: boolean };
type DiaperMark = { x: number; pee: boolean; poop: boolean; title: string };
type Cluster = { from: number; to: number; count: number };
type RibbonRow = {
  key: string;
  label: string;
  /** The day to open in the Timeline when tapped. */
  jumpKey: string;
  dst: string | null;
  stats: DayStats;
  sleeps: Span[];
  tummies: Span[];
  feeds: FeedMark[];
  diapers: DiaperMark[];
  clusters: (Span & { count: number })[];
  nowX: number | null;
};

/**
 * Where an instant sits on a 24-hour ribbon, by local clock time (so a sleep
 * from 1 to 3 AM always lines up under "12a–6a", even on DST days). Instants
 * outside the row clamp to its edges.
 */
export function wallFrac(t: number, start: number, end: number, wallStartMin: number, tz: string): number {
  if (t <= start) return 0;
  if (t >= end) return 1;
  const p = localParts(t, tz);
  let m = p.hour * 60 + p.minute + p.second / 60 - wallStartMin;
  if (m < 0) m += 1440;
  return Math.min(1, m / 1440);
}

/** A span clipped to the row; when clocks fall back the repeated hour keeps its real length. */
export function spanFrac(s: number, e: number, start: number, end: number, wallStartMin: number, tz: string): [number, number] {
  const a = Math.max(s, start);
  const b = Math.min(e, end);
  const x1 = wallFrac(a, start, end, wallStartMin, tz);
  let x2 = wallFrac(b, start, end, wallStartMin, tz);
  if (x2 < x1) x2 = Math.min(1, x1 + (b - a) / (24 * H));
  return [x1, x2];
}

/**
 * Runs of close-together feeds: every feed that sits in some 3-hour window
 * holding 3+ feed starts, grouped while the gaps stay under 3 hours.
 * Descriptive only ("cluster · 4 feeds in 2h 50m").
 */
function findClusters(feeds: Entry[]): Cluster[] {
  const starts = feeds.map((f) => Date.parse(f.started_at)).sort((a, b) => a - b);
  const inCluster = starts.map(() => false);
  for (let i = 0; i < starts.length; i++) {
    let j = i;
    while (j + 1 < starts.length && starts[j + 1] - starts[i] <= 3 * H) j++;
    if (j - i + 1 >= 3) for (let k = i; k <= j; k++) inCluster[k] = true;
  }
  const out: Cluster[] = [];
  starts.forEach((t, k) => {
    if (!inCluster[k]) return;
    const last = out[out.length - 1];
    if (last && inCluster[k - 1] && t - last.to <= 3 * H) {
      last.to = t;
      last.count++;
    } else out.push({ from: t, to: t, count: 1 });
  });
  return out.filter((c) => c.count >= 3);
}

function nightLabel(key: string, todayKey: string): string {
  const d = daysBetween(key, todayKey);
  if (d === 0) return "Tonight";
  if (d === 1) return "Last night";
  const { year, month, day } = parseDayKey(key);
  const wd = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${WEEKDAYS[wd]} night, ${MONTHS[month - 1]} ${day}`;
}

function entryEnd(e: Entry, now: Date): number {
  const s = Date.parse(e.started_at);
  if (e.ended_at) return Date.parse(e.ended_at);
  if (e.active) return now.getTime();
  if (e.kind === "feed" && e.data.method !== "bottle") return s + feedTotals(e.data, now).total * 1000;
  return s;
}

function buildRibbon(
  entries: Entry[],
  fromKey: string,
  todayKey: string,
  mode: RibbonMode,
  tz: string,
  now: Date,
  bornAt: string | null,
  units: UnitSystem
): RibbonRow[] {
  const nowMs = now.getTime();
  const bornMs = bornAt ? Date.parse(bornAt) : null;
  const wallStartMin = mode === "nights" ? 720 : 0;

  // Row windows, oldest first: local days, or noon → noon for nights.
  const windows: TimeWindow[] = [];
  for (let k = mode === "nights" ? addDays(fromKey, -1) : fromKey; k <= todayKey; k = addDays(k, 1)) {
    let start: number;
    let end: number;
    if (mode === "nights") {
      const a = parseDayKey(k);
      const b = parseDayKey(addDays(k, 1));
      start = zonedTimeToUtc(a.year, a.month, a.day, 12, 0, tz).getTime();
      end = zonedTimeToUtc(b.year, b.month, b.day, 12, 0, tz).getTime();
    } else {
      const [a, b] = dayBounds(k, tz);
      start = a.getTime();
      end = b.getTime();
    }
    if (start > nowMs || (bornMs != null && end <= bornMs)) continue;
    windows.push({ key: k, start, end });
  }
  const buckets = bucketWindows(entries, windows, now);

  const rows: RibbonRow[] = [];
  windows.forEach(({ key: k, start, end }, w) => {
    const inRow = buckets[w];
    const row: RibbonRow = {
      key: k,
      label: mode === "nights" ? nightLabel(k, todayKey) : formatDayLabel(k, todayKey),
      jumpKey: mode === "nights" && addDays(k, 1) <= todayKey ? addDays(k, 1) : k,
      dst: null,
      stats: statsFor(inRow, new Date(start), new Date(end), k, now),
      sleeps: [],
      tummies: [],
      feeds: [],
      diapers: [],
      clusters: [],
      nowX: nowMs >= start && nowMs < end ? wallFrac(nowMs, start, end, wallStartMin, tz) : null,
    };
    const hours = Math.round((end - start) / H);
    if (hours === 25) row.dst = mode === "days" ? dstNote(k, tz) : "25 hours (clocks fell back)";
    if (hours === 23) row.dst = mode === "days" ? dstNote(k, tz) : "23 hours (clocks sprang forward)";

    const when = (s: number, e: number) => `${formatTime(s, tz)}${e > s + MIN ? `–${formatTime(e, tz)}` : ""}`;
    const feedsInRow: Entry[] = [];
    for (const e of inRow) {
      const s = Date.parse(e.started_at);
      if (e.kind === "sleep" || e.kind === "tummy") {
        const eEnd = entryEnd(e, now);
        if (eEnd <= start || s >= end || eEnd <= s) continue;
        const [x1, x2] = spanFrac(s, eEnd, start, end, wallStartMin, tz);
        const title = `${e.kind === "sleep" ? "Sleep" : "Tummy time"} ${formatDuration((eEnd - s) / 1000)} · ${when(s, eEnd)}`;
        (e.kind === "sleep" ? row.sleeps : row.tummies).push({ x1, x2, title });
      } else if (e.kind === "feed") {
        if (s < start || s >= end) continue;
        feedsInRow.push(e);
        const bottle = e.data.method === "bottle";
        const eEnd = entryEnd(e, now);
        const [x1, x2] = spanFrac(s, Math.max(eEnd, s + (bottle ? 10 * MIN : 0)), start, end, wallStartMin, tz);
        const what = bottle
          ? `Bottle${e.data.amount_ml ? ` ${formatVolume(e.data.amount_ml, units)}` : ""}`
          : `Nursed ${formatDuration(feedTotals(e.data, now).total)}`;
        row.feeds.push({ x1, x2, bottle, title: `${what} · ${when(s, eEnd)}` });
      } else if (e.kind === "diaper") {
        if (s < start || s >= end) continue;
        const what = e.data.pee && e.data.poop ? "Wet + dirty" : e.data.poop ? "Dirty" : e.data.pee ? "Wet" : "Dry";
        row.diapers.push({ x: wallFrac(s, start, end, wallStartMin, tz), pee: !!e.data.pee, poop: !!e.data.poop, title: `${what} diaper · ${formatTime(s, tz)}` });
      }
    }
    for (const c of findClusters(feedsInRow)) {
      const [x1, x2] = spanFrac(c.from - 10 * MIN, c.to + 30 * MIN, start, end, wallStartMin, tz);
      row.clusters.push({ x1, x2, count: c.count, title: `cluster · ${c.count} feeds in ${formatDuration((c.to - c.from) / 1000)}` });
    }
    rows.push(row);
  });
  // Drop the blank rows from before logging began (gaps in the middle stay: they're real).
  const first = rows.findIndex((r) => r.sleeps.length + r.feeds.length + r.diapers.length + r.tummies.length > 0);
  return (first > 0 ? rows.slice(first) : rows).reverse();
}

function useWidth<T extends HTMLElement>(): [(el: T | null) => (() => void) | undefined, number] {
  const [w, setW] = useState(0);
  const ref = useCallback((el: T | null) => {
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const ROW_H = 34;
const RIBBON_PAGE = 30;

function Ribbons({
  entries,
  fromKey,
  todayKey,
  tz,
  now,
  bornAt,
  mode,
  onMode,
  onPickDay,
  units,
}: {
  entries: Entry[];
  fromKey: string;
  todayKey: string;
  tz: string;
  now: Date;
  bornAt: string | null;
  mode: RibbonMode;
  onMode: (m: RibbonMode) => void;
  onPickDay?: (key: string) => void;
  units: UnitSystem;
}) {
  const rows = useMemo(
    () => buildRibbon(entries, fromKey, todayKey, mode, tz, now, bornAt, units),
    [entries, fromKey, todayKey, mode, tz, now, bornAt, units]
  );
  const [showAll, setShowAll] = useState(false);
  const [ref, W] = useWidth<HTMLDivElement>();
  const shown = showAll ? rows : rows.slice(0, RIBBON_PAGE);
  const ticks = mode === "days" ? ["12a", "6a", "12p", "6p", "12a"] : ["12p", "6p", "12a", "6a", "12p"];

  return (
    <section aria-labelledby="maple-ribbons">
      <SectionTitle
        action={
          <Segmented
            className="w-[152px] shrink-0"
            value={mode}
            onChange={onMode}
            options={[
              { value: "days", label: "Days" },
              { value: "nights", label: "Nights" },
            ]}
          />
        }
      >
        <span id="maple-ribbons">Day ribbons</span>
      </SectionTitle>

      <div className={cx(tone.card, "px-3 pb-3")}>
        <RibbonLegend />
        {/* Sticky clock: stays put while the rows scroll under it. */}
        <div className="sticky top-[env(safe-area-inset-top)] z-10 -mx-3 bg-mp-surface px-3 pt-1.5 pb-1">
          <div className="relative h-4" aria-hidden>
            {ticks.map((t, i) => (
              <span
                key={i}
                className={cx(tone.faint, "absolute top-0 text-[10px] font-semibold tabular-nums")}
                style={{
                  left: `${(i / 4) * 100}%`,
                  transform: i === 0 ? "none" : i === 4 ? "translateX(-100%)" : "translateX(-50%)",
                }}
              >
                {t}
              </span>
            ))}
          </div>
        </div>

        <div ref={ref}>
          {W > 0 &&
            shown.map((r) => (
              <RibbonRowView key={r.key} row={r} W={W} units={units} onPick={onPickDay ? () => onPickDay(r.jumpKey) : undefined} />
            ))}
        </div>
        {rows.length > shown.length && (
          <div className="pt-3 text-center">
            <Button variant="soft" onClick={() => setShowAll(true)}>
              Show all {rows.length} {mode}
            </Button>
          </div>
        )}
        <p className={cx(tone.faint, "px-2 pt-3 text-center text-xs leading-snug")}>
          Each row is one {mode === "days" ? "day, midnight to midnight" : "night, noon to noon"}.
          {onPickDay && " Tap a row to open that day in the Timeline."}
        </p>
      </div>
    </section>
  );
}

function RibbonLegend() {
  const item = (swatch: ReactNode, label: string) => (
    <span className="inline-flex items-center gap-1.5">
      <svg width="16" height="10" aria-hidden className="shrink-0">
        {swatch}
      </svg>
      {label}
    </span>
  );
  return (
    <div className={cx(tone.muted, "flex flex-wrap gap-x-3 gap-y-1 pt-3 pb-1 text-[11px] font-medium")}>
      {item(<rect x="0" y="1" width="16" height="8" rx="2.5" fill="var(--v-sleep)" />, "Sleep")}
      {item(<rect x="5" y="0" width="5" height="10" rx="1" fill="var(--v-nurse)" />, "Nursing")}
      {item(<rect x="5" y="0" width="5" height="10" rx="1" fill="var(--v-bottle)" />, "Bottle")}
      {item(<circle cx="8" cy="5" r="4" fill="var(--v-pee)" />, "Pee")}
      {item(<circle cx="8" cy="5" r="4" fill="var(--v-poop)" />, "Poop")}
      {item(<rect x="0" y="2.5" width="16" height="5" rx="2" fill="var(--v-tummy)" />, "Tummy")}
      {item(<rect x="0" y="0" width="16" height="10" rx="2" fill="var(--v-bottle)" opacity="0.22" />, "Close-together feeds")}
    </div>
  );
}

function RibbonRowView({ row, W, units, onPick }: { row: RibbonRow; W: number; units: UnitSystem; onPick?: () => void }) {
  const s = row.stats;
  const summary = [
    `${s.feeds} feed${s.feeds === 1 ? "" : "s"}`,
    `${s.wet} wet`,
    `${s.dirty} dirty`,
    s.sleepSec >= 60 ? `${formatDuration(s.sleepSec)} sleep` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const x = (f: number) => f * W;
  const aria = `${row.label}: ${summary}${row.clusters.length ? `; ${row.clusters.map((c) => c.title).join("; ")}` : ""}${
    s.bottleMl ? `; ${formatVolume(s.bottleMl, units)} by bottle` : ""
  }`;

  const body = (
    <>
      <span className="flex flex-wrap items-baseline justify-between gap-x-2 pt-2 pb-1">
        <span className={cx(tone.body, "text-[13px] font-semibold")}>
          {row.label}
          {row.dst && (
            <span className="ml-1.5 inline-flex items-center gap-1 align-[-1px] text-[11px] font-semibold text-mp-maple">
              <Icon name="clock-3" size={12} strokeWidth={2} />
              {row.dst}
            </span>
          )}
        </span>
        <span className={cx(tone.muted, "text-[11px] tabular-nums")}>{summary}</span>
      </span>
      <svg width={W} height={ROW_H} className="block overflow-visible" aria-hidden>
        <rect x={0} y={7} width={W} height={16} rx={4} fill="var(--v-track)" />
        {[1, 2, 3].map((q) => (
          <line key={q} x1={x(q / 4)} x2={x(q / 4)} y1={0} y2={ROW_H} stroke="var(--v-grid)" strokeWidth={1} />
        ))}
        {row.clusters.map((c, i) => {
          const w = Math.max(4, x(c.x2) - x(c.x1));
          return (
            <g key={`c${i}`}>
              <rect x={x(c.x1)} y={0} width={w} height={ROW_H} rx={4} fill="var(--v-bottle)" opacity={0.2}>
                <title>{c.title}</title>
              </rect>
            </g>
          );
        })}
        {row.sleeps.map((sp, i) => (
          <rect key={`s${i}`} x={x(sp.x1)} y={7} width={Math.max(2, x(sp.x2) - x(sp.x1))} height={16} rx={3} fill="var(--v-sleep)">
            <title>{sp.title}</title>
          </rect>
        ))}
        {row.tummies.map((sp, i) => (
          <rect key={`t${i}`} x={x(sp.x1)} y={11} width={Math.max(2, x(sp.x2) - x(sp.x1))} height={8} rx={2} fill="var(--v-tummy)">
            <title>{sp.title}</title>
          </rect>
        ))}
        {row.feeds.map((f, i) => (
          <rect
            key={`f${i}`}
            x={x(f.x1)}
            y={0}
            width={Math.max(2, x(f.x2) - x(f.x1))}
            height={5}
            rx={1}
            fill={f.bottle ? "var(--v-bottle)" : "var(--v-nurse)"}
          >
            <title>{f.title}</title>
          </rect>
        ))}
        {row.diapers.map((d, i) => {
          const cx_ = Math.min(W - 4, Math.max(4, x(d.x)));
          const cy = 29.5;
          const r = 3.6;
          return (
            <g key={`d${i}`}>
              <title>{d.title}</title>
              <circle cx={cx_} cy={cy} r={r + 1.5} fill="var(--v-surface)" />
              {d.pee && d.poop ? (
                <>
                  <path d={`M${cx_},${cy - r}A${r},${r} 0 0 0 ${cx_},${cy + r}Z`} fill="var(--v-pee)" />
                  <path d={`M${cx_},${cy - r}A${r},${r} 0 0 1 ${cx_},${cy + r}Z`} fill="var(--v-poop)" />
                </>
              ) : (
                <circle cx={cx_} cy={cy} r={r} fill={d.poop ? "var(--v-poop)" : d.pee ? "var(--v-pee)" : "var(--v-axis)"} />
              )}
            </g>
          );
        })}
        {row.nowX != null && (
          <g>
            <line x1={x(row.nowX)} x2={x(row.nowX)} y1={0} y2={ROW_H} stroke="var(--v-now)" strokeWidth={1.5} />
            <circle cx={x(row.nowX)} cy={1.5} r={2.5} fill="var(--v-now)" />
          </g>
        )}
      </svg>
    </>
  );

  if (!onPick) {
    return (
      <div role="img" aria-label={aria} className="block border-b border-mp-line pb-1 last:border-0">
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onPick}
      aria-label={`${aria}. Open in the Timeline`}
      className="-mx-1 block w-[calc(100%+0.5rem)] border-b border-mp-line px-1 pb-1 text-left transition last:border-0 hover:bg-mp-ink/[0.03] active:bg-mp-ink/[0.05]"
    >
      {body}
    </button>
  );
}

// ── Daily charts ─────────────────────────────────────────────────────────

/** Calendar-day target: her day of life at the middle of that day (clamped to birth and now). */
function dayOfLifeFor(key: string, tz: string, bornAt: string | null, now: Date): number | null {
  if (!bornAt) return null;
  const [a, b] = dayBounds(key, tz);
  const born = Date.parse(bornAt);
  if (b.getTime() <= born) return null;
  const mid = Math.min(now.getTime(), Math.max(born, (a.getTime() + b.getTime()) / 2));
  return babyAge(bornAt, new Date(mid), tz).dayOfLife;
}

function shortDate(key: string): string {
  const { month, day } = parseDayKey(key);
  return `${month}/${day}`;
}

/** 0 and 2–3 round steps up to at least `max` (whole steps only for counts). */
function niceTicks(max: number, target = 3, integer = false): number[] {
  const m = Math.max(max, 1e-9);
  const raw = m / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const factors = integer && pow <= 1 ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
  const step = Math.max(integer ? 1 : 0, factors.map((f) => f * pow).find((s) => m / s <= target) ?? 10 * pow);
  const out: number[] = [];
  for (let v = 0; v < m + step * 0.999; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

type Scale = {
  W: number;
  left: number;
  slot: number;
  barW: number;
  top: number;
  bottom: number;
  cx: (i: number) => number;
  y: (v: number) => number;
};

/**
 * Shared frame for the daily charts: hairline grid, y ticks, date labels,
 * and a per-day hit area (pointer, tap, or ←/→ keys) that shows a tooltip.
 */
function ChartFrame({
  n,
  keys,
  todayKey,
  height,
  yMax,
  yTicks,
  yLabel,
  ariaLabel,
  tooltip,
  children,
}: {
  n: number;
  keys: string[];
  todayKey: string;
  height: number;
  yMax: number;
  yTicks: number[];
  yLabel: (v: number) => string;
  ariaLabel: string;
  tooltip: (i: number) => ReactNode;
  children: (s: Scale) => ReactNode;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      box.current = el;
      return ref(el);
    },
    [ref]
  );

  // Tap outside to dismiss the tooltip on touch screens.
  useEffect(() => {
    if (active == null) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setActive(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [active]);

  const LEFT = 30;
  const RIGHT = 4;
  const TOP = 10;
  const BOTTOM = 18;
  const plotW = Math.max(0, W - LEFT - RIGHT);
  const slot = n ? plotW / n : 0;
  const s: Scale = {
    W,
    left: LEFT,
    slot,
    barW: Math.max(2, Math.min(24, slot * 0.62)),
    top: TOP,
    bottom: height - BOTTOM,
    cx: (i) => LEFT + slot * (i + 0.5),
    y: (v) => height - BOTTOM - (Math.min(v, yMax) / yMax) * (height - BOTTOM - TOP),
  };
  const labelEvery = Math.max(1, Math.ceil(34 / Math.max(slot, 1)));
  const tipX = active != null ? s.cx(active) : 0;

  return (
    <div ref={setRefs} className="relative" style={{ height }}>
      {W > 0 && (
        <svg
          width={W}
          height={height}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          className="block touch-pan-y overflow-visible rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-mp-focus/60"
          onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
          onFocus={() => setActive((a) => a ?? n - 1)}
          onBlur={() => setActive(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setActive((a) => Math.max(0, (a ?? n) - 1));
            else if (e.key === "ArrowRight") setActive((a) => Math.min(n - 1, (a ?? -1) + 1));
            else if (e.key === "Escape") setActive(null);
            else return;
            e.preventDefault();
          }}
        >
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={LEFT} x2={W - RIGHT} y1={s.y(v)} y2={s.y(v)} stroke={v === 0 ? "var(--v-axis)" : "var(--v-grid)"} strokeWidth={1} />
              <text x={LEFT - 5} y={s.y(v)} dy="0.32em" textAnchor="end" className={AXIS_TEXT}>
                {yLabel(v)}
              </text>
            </g>
          ))}
          {active != null && <rect x={LEFT + slot * active} y={TOP - 6} width={slot} height={s.bottom - TOP + 6} rx={4} fill="var(--v-grid)" />}
          {children(s)}
          {keys.map((k, i) => {
            if ((n - 1 - i) % labelEvery !== 0) return null;
            const label = k === todayKey ? "Today" : shortDate(k);
            // Keep edge labels inside the card instead of clipping them.
            const half = label.length * 2.9;
            const atEnd = s.cx(i) + half > W - 1;
            return (
              <text key={k} x={atEnd ? W - 1 : s.cx(i)} y={height - 4} textAnchor={atEnd ? "end" : "middle"} className={AXIS_TEXT}>
                {label}
              </text>
            );
          })}
          {keys.map((k, i) => (
            <rect
              key={`hit-${k}`}
              x={LEFT + slot * i}
              y={0}
              width={slot}
              height={height}
              fill="transparent"
              onPointerEnter={(e) => e.pointerType === "mouse" && setActive(i)}
              onPointerDown={() => setActive((a) => (a === i ? null : i))}
            />
          ))}
        </svg>
      )}
      {active != null && W > 0 && (
        <div
          role="status"
          className="pointer-events-none absolute bottom-[calc(100%-4px)] z-20 w-max max-w-[240px] rounded-xl bg-mp-toast px-3 py-2 text-xs text-mp-on-toast shadow-[0_8px_24px_rgba(0,0,0,0.18)] [.maple-night_&]:ring-1 [.maple-night_&]:ring-mp-line"
          style={{
            left: tipX,
            transform: tipX < 90 ? "translateX(-12px)" : tipX > W - 90 ? "translateX(calc(-100% + 12px))" : "translateX(-50%)",
          }}
        >
          <p className="mb-0.5 font-semibold">{formatDayLabel(keys[active], todayKey)}</p>
          {tooltip(active)}
        </div>
      )}
    </div>
  );
}

function TipRow({ color, value, label, dot }: { color: string; value: string; label: string; dot?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <svg width="12" height="8" aria-hidden className="shrink-0">
        {dot ? <circle cx="6" cy="4" r="3.5" fill={color} /> : <line x1="0" x2="12" y1="4" y2="4" stroke={color} strokeWidth="3" strokeLinecap="round" />}
      </svg>
      <strong className="font-semibold tabular-nums">{value}</strong>
      <span className="opacity-80">{label}</span>
    </span>
  );
}

function ChartCard({
  title,
  subtitle,
  legend,
  note,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Series colors are the --v-* variables, so the dots follow the night look with the marks. */
  legend?: { color: string; label: string }[];
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure className={cx(tone.card, "px-3 pt-4 pb-3")}>
      <figcaption className="mb-3 px-1">
        <h3 className={cx(tone.heading, "text-[15px]")}>{title}</h3>
        {subtitle && <p className={cx(tone.muted, "mt-0.5 text-[13px] leading-snug")}>{subtitle}</p>}
        {legend && legend.length > 1 && (
          <p className={cx(tone.muted, "mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-xs font-medium")}>
            {legend.map((l) => (
              <span key={l.label} className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: l.color }} />
                {l.label}
              </span>
            ))}
          </p>
        )}
      </figcaption>
      {children}
      {note && <p className={cx(tone.muted, "mt-2 px-1 text-xs leading-snug")}>{note}</p>}
    </figure>
  );
}

type BarSeries = { id: string; label: string; color: string; values: number[] };

/** Column chart, stacked when there's more than one series. Today's column (partial) is lighter. */
function Columns({
  keys,
  todayKey,
  series,
  height = 128,
  band,
  integer = false,
  yLabel,
  valueLabel,
  ariaLabel,
  tooltip,
}: {
  keys: string[];
  todayKey: string;
  series: BarSeries[];
  height?: number;
  band?: { lo: number; hi: number };
  /** Counts: whole-number ticks. */
  integer?: boolean;
  yLabel: (v: number) => string;
  valueLabel: (v: number) => string;
  ariaLabel: string;
  tooltip: (i: number) => ReactNode;
}) {
  const n = keys.length;
  const totals = keys.map((_, i) => series.reduce((t, s) => t + (s.values[i] ?? 0), 0));
  const ticks = niceTicks(Math.max(...totals, band?.hi ?? 0, 1), 3, integer);
  const yMax = ticks[ticks.length - 1];
  const last = n - 1;
  return (
    <ChartFrame n={n} keys={keys} todayKey={todayKey} height={height} yMax={yMax} yTicks={ticks} yLabel={yLabel} ariaLabel={ariaLabel} tooltip={tooltip}>
      {(s) => (
        <>
          {band && (
            <rect x={s.left} y={s.y(band.hi)} width={s.W - s.left - 4} height={s.y(band.lo) - s.y(band.hi)} fill="var(--v-band)" />
          )}
          {keys.map((k, i) => {
            let cum = 0;
            const topIdx = series.map((ser, j) => ((ser.values[i] ?? 0) > 0 ? j : -1)).reduce((a, b) => Math.max(a, b), -1);
            const x = s.cx(i) - s.barW / 2;
            return (
              <g key={k} opacity={k === todayKey ? 0.55 : 1}>
                {series.map((ser, j) => {
                  const v = ser.values[i] ?? 0;
                  if (v <= 0) return null;
                  const y0 = s.y(cum) - (cum > 0 ? 2 : 0); // 2px surface gap between stacked segments
                  cum += v;
                  const y1 = s.y(cum);
                  const h = y0 - y1;
                  if (h <= 0.5) return null;
                  return j === topIdx ? (
                    <path key={ser.id} d={topRounded(x, y1, s.barW, h, 4)} fill={ser.color} />
                  ) : (
                    <rect key={ser.id} x={x} y={y1} width={s.barW} height={h} fill={ser.color} />
                  );
                })}
              </g>
            );
          })}
          {/* The latest value rides its column when there's room; otherwise the tooltip and table carry it. */}
          {totals[last] > 0 && s.slot >= 34 && (
            <text
              x={Math.min(s.cx(last), s.W - 2 - valueLabel(totals[last]).length * 2.9)}
              y={s.y(totals[last]) - 4}
              textAnchor="middle"
              className="fill-mp-ink-2 text-[10px] font-semibold tabular-nums"
            >
              {valueLabel(totals[last])}
            </text>
          )}
        </>
      )}
    </ChartFrame>
  );
}

type DotDay = { colors: string[]; target: number | null };

/** "Each dot is one diaper" columns, with a short target tick per day. */
function DotColumns({
  keys,
  todayKey,
  data,
  ariaLabel,
  tooltip,
}: {
  keys: string[];
  todayKey: string;
  data: DotDay[];
  ariaLabel: string;
  tooltip: (i: number) => ReactNode;
}) {
  const maxCount = Math.max(1, ...data.map((d) => Math.max(d.colors.length, d.target ?? 0)));
  const yMax = maxCount + 1;
  const height = Math.min(190, Math.max(104, yMax * 11 + 28));
  const ticks = niceTicks(yMax - 1, 2, true).filter((t) => t <= yMax);
  return (
    <ChartFrame n={keys.length} keys={keys} todayKey={todayKey} height={height} yMax={yMax} yTicks={ticks} yLabel={(v) => String(v)} ariaLabel={ariaLabel} tooltip={tooltip}>
      {(s) => {
        const step = s.y(0) - s.y(1);
        const r = Math.max(2, Math.min(5, s.slot * 0.34, step / 2 - 0.75));
        return keys.map((k, i) => {
          const d = data[i];
          const partial = k === todayKey;
          return (
            <g key={k}>
              {d.colors.map((c, j) => (
                <circle key={j} cx={s.cx(i)} cy={s.y(j + 0.5)} r={r} fill={c} stroke="var(--v-dot-edge)" strokeWidth={0.75} opacity={partial ? 0.65 : 1} />
              ))}
              {d.target != null && (
                <line
                  x1={s.cx(i) - Math.min(s.slot * 0.45, 11)}
                  x2={s.cx(i) + Math.min(s.slot * 0.45, 11)}
                  y1={s.y(d.target)}
                  y2={s.y(d.target)}
                  stroke="var(--v-target)"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  opacity={partial ? 0.45 : 0.9}
                />
              )}
            </g>
          );
        });
      }}
    </ChartFrame>
  );
}

function DailyCharts({
  days,
  entries,
  todayKey,
  tz,
  bornAt,
  units,
  now,
}: {
  days: DayStats[];
  entries: Entry[];
  todayKey: string;
  tz: string;
  bornAt: string | null;
  units: UnitSystem;
  now: Date;
}) {
  const [asTable, setAsTable] = useState(false);
  const keys = days.map((d) => d.key);
  const so = (i: number) => (keys[i] === todayKey ? " so far" : "");

  const targets = useMemo(
    () =>
      days.map((d) => {
        const dol = dayOfLifeFor(d.key, tz, bornAt, now);
        return dol ? { dol, ...diaperTargets(dol) } : null;
      }),
    [days, tz, bornAt, now]
  );

  // Stool colors per day, in the order they happened.
  const stools = useMemo(() => {
    const m = new Map<string, (StoolColor | null)[]>();
    const sorted = entries
      .filter((e): e is EntryOf<"diaper"> => e.kind === "diaper" && e.data.poop)
      .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
    for (const e of sorted) {
      const k = dayKey(Date.parse(e.started_at), tz);
      const list = m.get(k) ?? [];
      list.push(e.data.color ?? null);
      m.set(k, list);
    }
    return m;
  }, [entries, tz]);

  const vol = (ml: number) => (units === "us" ? Math.round(mlToOz(ml) * 4) / 4 : Math.round(ml));
  const volUnit = units === "us" ? "oz" : "ml";
  const anyBottle = days.some((d) => d.bottleMl > 0);
  const anyPump = days.some((d) => d.pumpMl > 0);
  const anyBottleFeeds = days.some((d) => d.bottleFeeds > 0);
  const anyNursing = days.some((d) => d.nursingSec > 0);
  const anyTummy = days.some((d) => d.tummySec > 0);
  const totalL = days.reduce((n, d) => n + d.leftSec, 0);
  const totalR = days.reduce((n, d) => n + d.rightSec, 0);
  const lPct = totalL + totalR ? Math.round((totalL / (totalL + totalR)) * 100) : 0;
  const bornAge = bornAt ? babyAge(bornAt, now, tz) : null;

  return (
    <section aria-labelledby="maple-daily" className="space-y-3">
      <SectionTitle
        action={
          <button
            type="button"
            onClick={() => setAsTable((x) => !x)}
            className="-my-2 inline-flex min-h-[44px] items-center gap-1.5 px-1 text-[15px] font-medium text-mp-accent-fg"
          >
            <Icon name={asTable ? "chart-column" : "table"} size={18} />
            {asTable ? "Charts" : "Table"}
          </button>
        }
      >
        <span id="maple-daily">Day by day</span>
      </SectionTitle>

      {asTable ? (
        <DailyTable days={days} todayKey={todayKey} units={units} />
      ) : (
        <>
          <ChartCard
            title="Feeds per day"
            subtitle={`Shaded band: ${FEEDS_PER_DAY[0]}–${FEEDS_PER_DAY[1]} a day, typical for newborns.`}
            legend={
              anyBottleFeeds
                ? [
                    { color: "var(--v-nurse)", label: "Nursing" },
                    { color: "var(--v-bottle)", label: "Bottle" },
                  ]
                : undefined
            }
          >
            <Columns
              keys={keys}
              todayKey={todayKey}
              band={{ lo: FEEDS_PER_DAY[0], hi: FEEDS_PER_DAY[1] }}
              integer
              series={[
                { id: "breast", label: "Nursing", color: "var(--v-nurse)", values: days.map((d) => d.breastFeeds) },
                { id: "bottle", label: "Bottle", color: "var(--v-bottle)", values: days.map((d) => d.bottleFeeds) },
              ]}
              yLabel={(v) => String(v)}
              valueLabel={(v) => String(v)}
              ariaLabel={`Feeds per day: ${days.map((d) => `${shortDate(d.key)} ${d.feeds}`).join(", ")}`}
              tooltip={(i) => (
                <>
                  <TipRow color="var(--v-nurse)" value={String(days[i].breastFeeds)} label={`nursing${so(i)}`} />
                  {anyBottleFeeds && <TipRow color="var(--v-bottle)" value={String(days[i].bottleFeeds)} label="bottle" />}
                </>
              )}
            />
          </ChartCard>

          <ChartCard
            title="Wet diapers"
            subtitle="Each dot is one wet diaper. The short line is the least to expect for her day of life."
          >
            <DotColumns
              keys={keys}
              todayKey={todayKey}
              data={days.map((d, i) => ({ colors: new Array(d.wet).fill("var(--v-pee)"), target: targets[i]?.wet ?? null }))}
              ariaLabel={`Wet diapers per day: ${days.map((d) => `${shortDate(d.key)} ${d.wet}`).join(", ")}`}
              tooltip={(i) => (
                <>
                  <TipRow dot color="var(--v-pee)" value={String(days[i].wet)} label={`wet${so(i)}`} />
                  {targets[i] && <span className="block opacity-80">Expect at least {targets[i]!.wet} around Day {targets[i]!.dol}</span>}
                </>
              )}
            />
          </ChartCard>

          <ChartCard
            title="Dirty diapers"
            subtitle="Each dot is one dirty diaper, in its color: black at first, then green, then mustard yellow."
          >
            <DotColumns
              keys={keys}
              todayKey={todayKey}
              data={days.map((d, i) => ({
                colors: (stools.get(d.key) ?? []).map((c) => (c ? STOOL_COLOR_INFO[c].hex : "var(--v-poop)")),
                target: targets[i]?.dirty ?? null,
              }))}
              ariaLabel={`Dirty diapers per day: ${days.map((d) => `${shortDate(d.key)} ${d.dirty}`).join(", ")}`}
              tooltip={(i) => {
                const cs = stools.get(keys[i]) ?? [];
                const counts = new Map<string, number>();
                for (const c of cs) {
                  const label = c ? STOOL_COLOR_INFO[c].label.toLowerCase() : "no color noted";
                  counts.set(label, (counts.get(label) ?? 0) + 1);
                }
                return (
                  <>
                    <TipRow dot color="var(--v-poop)" value={String(days[i].dirty)} label={`dirty${so(i)}`} />
                    {[...counts].map(([l, c]) => (
                      <span key={l} className="block opacity-80">
                        {c > 1 ? `${c}× ` : ""}
                        {l}
                      </span>
                    ))}
                    {targets[i]?.dirty != null && <span className="block opacity-80">Expect at least {targets[i]!.dirty} around Day {targets[i]!.dol}</span>}
                  </>
                );
              }}
            />
          </ChartCard>

          <ChartCard title="Sleep per day" note={`${SLEEP_TOTAL_NOTE} Only logged sleep counts here, so a missed nap makes a day look short.`}>
            <Columns
              keys={keys}
              todayKey={todayKey}
              series={[{ id: "sleep", label: "Sleep", color: "var(--v-sleep)", values: days.map((d) => d.sleepSec / 3600) }]}
              yLabel={(v) => (v ? `${v}h` : "0")}
              valueLabel={(v) => formatDuration(v * 3600)}
              ariaLabel={`Logged sleep per day: ${days.map((d) => `${shortDate(d.key)} ${formatDuration(d.sleepSec)}`).join(", ")}`}
              tooltip={(i) => <TipRow color="var(--v-sleep)" value={formatDuration(days[i].sleepSec)} label={`logged sleep${so(i)}`} />}
            />
          </ChartCard>

          {anyNursing && (
            <ChartCard
              title="Nursing minutes, left and right"
              subtitle={totalL + totalR >= 60 ? `Over these days: L ${lPct}% · R ${100 - lPct}%.` : undefined}
              legend={[
                { color: "var(--v-nurse)", label: "L · Left" },
                { color: "var(--v-bottle)", label: "R · Right" },
              ]}
            >
              <Columns
                keys={keys}
                todayKey={todayKey}
                series={[
                  { id: "L", label: "Left", color: "var(--v-nurse)", values: days.map((d) => d.leftSec / 3600) },
                  { id: "R", label: "Right", color: "var(--v-bottle)", values: days.map((d) => d.rightSec / 3600) },
                ]}
                yLabel={(v) => (v ? `${v}h` : "0")}
                valueLabel={(v) => formatDuration(v * 3600)}
                ariaLabel={`Nursing minutes per day: ${days.map((d) => `${shortDate(d.key)} left ${Math.round(d.leftSec / 60)}, right ${Math.round(d.rightSec / 60)}`).join("; ")}`}
                tooltip={(i) => (
                  <>
                    <TipRow color="var(--v-nurse)" value={formatDuration(days[i].leftSec)} label="L" />
                    <TipRow color="var(--v-bottle)" value={formatDuration(days[i].rightSec)} label={`R${so(i)}`} />
                  </>
                )}
              />
            </ChartCard>
          )}

          {anyBottle && (
            <ChartCard title={`Bottle per day (${volUnit})`}>
              <Columns
                keys={keys}
                todayKey={todayKey}
                series={[{ id: "bottle", label: "Bottle", color: "var(--v-bottle)", values: days.map((d) => vol(d.bottleMl)) }]}
                yLabel={(v) => String(v)}
                valueLabel={(v) => `${v} ${volUnit}`}
                ariaLabel={`Bottle volume per day: ${days.map((d) => `${shortDate(d.key)} ${formatVolume(d.bottleMl, units)}`).join(", ")}`}
                tooltip={(i) => <TipRow color="var(--v-bottle)" value={formatVolume(days[i].bottleMl, units)} label={`by bottle${so(i)}`} />}
              />
            </ChartCard>
          )}

          {anyPump && (
            <ChartCard title={`Pumped per day (${volUnit})`}>
              <Columns
                keys={keys}
                todayKey={todayKey}
                series={[{ id: "pump", label: "Pumped", color: "var(--v-pump)", values: days.map((d) => vol(d.pumpMl)) }]}
                yLabel={(v) => String(v)}
                valueLabel={(v) => `${v} ${volUnit}`}
                ariaLabel={`Pumped per day: ${days.map((d) => `${shortDate(d.key)} ${formatVolume(d.pumpMl, units)}`).join(", ")}`}
                tooltip={(i) => <TipRow color="var(--v-pump)" value={formatVolume(days[i].pumpMl, units)} label={`pumped${so(i)}`} />}
              />
            </ChartCard>
          )}

          {anyTummy && (
            <ChartCard
              title="Tummy time per day"
              subtitle={bornAge ? `A goal of about ${tummyGoalMinutes(bornAge.days)} minutes a day at her age, in short sessions.` : undefined}
            >
              <Columns
                keys={keys}
                todayKey={todayKey}
                height={110}
                series={[{ id: "tummy", label: "Tummy time", color: "var(--v-tummy)", values: days.map((d) => d.tummySec / 60) }]}
                yLabel={(v) => (v ? `${v}m` : "0")}
                valueLabel={(v) => formatDuration(v * 60)}
                ariaLabel={`Tummy time per day: ${days.map((d) => `${shortDate(d.key)} ${formatDuration(d.tummySec)}`).join(", ")}`}
                tooltip={(i) => <TipRow color="var(--v-tummy)" value={formatDuration(days[i].tummySec)} label={`tummy time${so(i)}`} />}
              />
            </ChartCard>
          )}
          <p className={cx(tone.faint, "px-2 text-xs leading-snug")}>
            Tap or hover a day for its numbers. Counts come from what was logged, so a missed entry makes a day look light.
          </p>
        </>
      )}
    </section>
  );
}

/** The charts' accessible twin: every number, one row per day. */
function DailyTable({ days, todayKey, units }: { days: DayStats[]; todayKey: string; units: UnitSystem }) {
  const anyBottle = days.some((d) => d.bottleMl > 0);
  // The table scrolls sideways on a phone; the day column stays put, with a
  // hairline (an inset shadow, so it travels with the sticky cell) to show
  // the other columns slide under it.
  const sticky = "first:sticky first:left-0 first:bg-mp-surface first:pl-4 first:shadow-[inset_-1px_0_0_var(--mp-line)] last:pr-4";
  const th = cx(tone.faint, "px-2.5 pt-3 pb-2 text-left text-xs font-medium whitespace-nowrap", sticky);
  const td = cx(tone.body, "px-2.5 py-2.5 tabular-nums whitespace-nowrap", sticky);
  return (
    <div
      className={cx(tone.card, "overflow-x-auto")}
      // A soft edge on the right while more columns are off-screen: the cover
      // scrolls with the content and hides the edge once you reach the end.
      style={{
        background:
          "linear-gradient(var(--mp-surface), var(--mp-surface)) right / 16px 100% no-repeat local, " +
          "linear-gradient(to left, color-mix(in srgb, var(--mp-ink) 9%, transparent), transparent) right / 14px 100% no-repeat scroll, " +
          "var(--mp-surface)",
      }}
    >
      <table className="w-full text-sm">
        <caption className="sr-only">Daily totals</caption>
        <thead>
          <tr className="border-b border-mp-line">
            <th scope="col" className={th}>Day</th>
            <th scope="col" className={th}>Feeds</th>
            <th scope="col" className={th}>Nursing L / R</th>
            {anyBottle && <th scope="col" className={th}>Bottle</th>}
            <th scope="col" className={th}>Wet</th>
            <th scope="col" className={th}>Dirty</th>
            <th scope="col" className={th}>Sleep</th>
          </tr>
        </thead>
        <tbody>
          {[...days].reverse().map((d) => (
            <tr key={d.key} className="border-b border-mp-line last:border-0">
              <th scope="row" className={cx(td, "text-left font-medium")}>
                {formatDayLabel(d.key, todayKey)}
              </th>
              <td className={td}>{d.feeds}</td>
              <td className={td}>
                {formatDuration(d.leftSec)} / {formatDuration(d.rightSec)}
              </td>
              {anyBottle && <td className={td}>{d.bottleMl ? formatVolume(d.bottleMl, units) : <span className={tone.faint}>—</span>}</td>}
              <td className={td}>{d.wet}</td>
              <td className={td}>{d.dirty}</td>
              <td className={td}>{formatDuration(d.sleepSec)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Visit summary ────────────────────────────────────────────────────────

/** Consecutive day keys as "Oct 15–16", "Oct 18". */
function dayRuns(keys: string[]): string {
  const sorted = [...new Set(keys)].sort();
  const runs: string[][] = [];
  for (const k of sorted) {
    const last = runs[runs.length - 1];
    if (last && addDays(last[last.length - 1], 1) === k) last.push(k);
    else runs.push([k]);
  }
  return runs
    .map((r) => {
      const a = parseDayKey(r[0]);
      if (r.length === 1) return `${MONTHS[a.month - 1]} ${a.day}`;
      const b = parseDayKey(r[r.length - 1]);
      return a.month === b.month ? `${MONTHS[a.month - 1]} ${a.day}–${b.day}` : `${MONTHS[a.month - 1]} ${a.day}–${MONTHS[b.month - 1]} ${b.day}`;
    })
    .join(", ");
}

function shortDay(key: string): string {
  const { year, month, day } = parseDayKey(key);
  return `${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}, ${MONTHS[month - 1]} ${day}`;
}

/** Plain text a pediatrician can skim: the last 7 days, newest first. */
export async function buildVisitSummary(opts: {
  state: MapleState;
  history: Entry[];
  notes: Entry[];
  todayKey: string;
  tz: string;
  now: Date;
}): Promise<string> {
  const { state, todayKey, tz, now } = opts;
  const baby = state.baby;
  const entries = mergeLive(opts.history, state);
  const born = baby.born_at ? Date.parse(baby.born_at) : null;
  const bornKey = born != null ? dayKey(born, tz) : null;
  let from = addDays(todayKey, -6);
  if (bornKey && bornKey > from) from = bornKey;
  const name = baby.nickname || baby.name;
  const out: string[] = [];

  out.push(`${baby.name}: visit summary (${from === todayKey ? dayRuns([from]) : `${dayRuns([from])} to ${dayRuns([todayKey])}`})`);
  if (born != null) {
    const age = babyAge(baby.born_at!, now, tz);
    out.push(`Born ${shortDay(bornKey!)} at ${formatTime(born, tz)} · today she's ${age.label.replace(/ old$/, "")} old (Day ${age.dayOfLife})`);
  }
  const birthBits = [
    baby.birth_weight_g ? `weight ${formatWeightBoth(baby.birth_weight_g)}` : null,
    baby.birth_length_cm ? `length ${formatLengthBoth(baby.birth_length_cm)}` : null,
    baby.birth_head_cm ? `head ${formatLengthBoth(baby.birth_head_cm)}` : null,
  ].filter(Boolean);
  if (birthBits.length) out.push(`At birth: ${birthBits.join(", ")}`);
  out.push(`From what we logged at home in Maple's Log. Times are ${tz.replace("_", " ")}.`);

  const questions = opts.notes
    .filter((e) => e.kind === "note" && e.data.for_doctor && !e.data.done)
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  if (questions.length) {
    out.push("", "QUESTIONS FOR THE DOCTOR");
    for (const q of questions) out.push(`• ${q.note?.trim() || "(question)"} (${shortDay(dayKey(Date.parse(q.started_at), tz))})`);
  }

  out.push("", "DAY BY DAY (newest first)");
  for (let k = todayKey; k >= from; k = addDays(k, -1)) {
    const [a, b] = dayBounds(k, tz);
    const d = statsFor(entries, a, b, k, now);
    const feedBits: string[] = [];
    if (d.nursingSec) feedBits.push(`nursing ${formatDuration(d.nursingSec)}: L ${formatDuration(d.leftSec)} / R ${formatDuration(d.rightSec)}`);
    if (d.bottleFeeds) feedBits.push(`${d.bottleFeeds} bottle${d.bottleFeeds === 1 ? "" : "s"}${d.bottleMl ? `, ${formatVolume(d.bottleMl, "us")} (${Math.round(d.bottleMl)} ml)` : ""}`);
    const parts = [
      `${d.feeds} feed${d.feeds === 1 ? "" : "s"}${feedBits.length ? ` (${feedBits.join("; ")})` : ""}`,
      `${d.wet} wet / ${d.dirty} dirty`,
      `sleep ${formatDuration(d.sleepSec)}`,
    ];
    if (d.pumpMl) parts.push(`pumped ${formatVolume(d.pumpMl, "us")} (${Math.round(d.pumpMl)} ml)`);
    out.push(`${shortDay(k)}${k === todayKey ? " (so far)" : ""}: ${parts.join(" · ")}`);
  }

  const inWeek = (e: Entry) => {
    const k = dayKey(Date.parse(e.started_at), tz);
    return k >= from && k <= todayKey;
  };
  const week = entries.filter(inWeek).sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));

  const colorDays = new Map<string, string[]>();
  for (const e of week) {
    if (e.kind !== "diaper" || !e.data.poop || !e.data.color) continue;
    const label = STOOL_COLOR_INFO[e.data.color].label.toLowerCase();
    colorDays.set(label, [...(colorDays.get(label) ?? []), dayKey(Date.parse(e.started_at), tz)]);
  }
  if (colorDays.size) {
    out.push("", "POOP COLORS SEEN");
    for (const [label, ks] of colorDays) out.push(`• ${label}: ${dayRuns(ks)}`);
  }

  const temps = week.filter((e): e is EntryOf<"temp"> => e.kind === "temp");
  if (temps.length) {
    out.push("", "TEMPERATURES");
    for (const t of temps) {
      const at = Date.parse(t.started_at);
      out.push(`• ${shortDay(dayKey(at, tz))} ${formatTime(at, tz)}: ${formatTempBoth(t.data.temp_c)}${t.data.method ? `, ${t.data.method}` : ""}`);
    }
  }

  const dDays = new Set(week.filter((e) => e.kind === "med" && isVitaminD(e.data.name)).map((e) => dayKey(Date.parse(e.started_at), tz)));
  const allDays: string[] = [];
  for (let k = from; k <= todayKey; k = addDays(k, 1)) allDays.push(k);
  const notGiven = allDays.filter((k) => !dDays.has(k));
  out.push("", "VITAMIN D");
  out.push(
    `Logged on ${dDays.size} of ${allDays.length} day${allDays.length === 1 ? "" : "s"}${notGiven.length && dDays.size ? ` (not logged: ${dayRuns(notGiven)})` : ""}`
  );
  const otherMeds = week.filter((e): e is EntryOf<"med"> => e.kind === "med" && !isVitaminD(e.data.name));
  for (const m of otherMeds) {
    const at = Date.parse(m.started_at);
    out.push(`• ${m.data.name}${m.data.dose ? ` ${m.data.dose}` : ""}: ${shortDay(dayKey(at, tz))} ${formatTime(at, tz)}`);
  }

  const growth = state.growth.filter((e): e is EntryOf<"growth"> => e.kind === "growth").sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  if (growth.length) {
    const g = born != null ? await import("@/lib/maple/growth") : null;
    out.push("", "WEIGHT & MEASUREMENTS");
    for (const e of growth) {
      const at = Date.parse(e.started_at);
      const ageDays = born != null && g ? g.ageInDays(baby.born_at!, e.started_at) : null;
      const bits: string[] = [];
      if (e.data.weight_g != null) {
        let w = formatWeightBoth(e.data.weight_g);
        if (baby.birth_weight_g) {
          const pct = Math.round(((e.data.weight_g - baby.birth_weight_g) / baby.birth_weight_g) * 1000) / 10;
          w += `, ${pct > 0 ? "+" : pct < 0 ? "−" : "±"}${Math.abs(pct)}% vs birth`;
        }
        const p = g && ageDays != null ? g.percentileFor("weight", e.data.weight_g, ageDays) : null;
        if (p && !p.implausible) w += `, about the ${p.label} percentile (WHO)`;
        bits.push(w);
      }
      if (e.data.length_cm != null) bits.push(`length ${formatLengthBoth(e.data.length_cm)}`);
      if (e.data.head_cm != null) bits.push(`head ${formatLengthBoth(e.data.head_cm)}`);
      if (!bits.length) continue;
      out.push(`• ${shortDay(dayKey(at, tz))}${e.data.at === "doctor" ? " (doctor's scale)" : e.data.at === "home" ? " (home scale)" : ""}: ${bits.join("; ")}`);
    }
  }

  out.push("", `Logged by ${name}'s family. Counts only include what we wrote down.`);
  return out.join("\n");
}

function VisitSummary({ state, todayKey, tz, now }: { state: MapleState; todayKey: string; tz: string; now: Date }) {
  const { api, toast } = useMaple();
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (fallback) area.current?.select();
  }, [fallback, text]);

  const build = async () => {
    setBusy(true);
    setCopied(false);
    try {
      const from = addDays(todayKey, -7);
      const [hist, notes] = await Promise.all([
        fetchRange(api, from, todayKey),
        api<{ entries: Entry[] }>(`/api/maple/entries?kind=note&limit=2000`).catch(() => ({ entries: [] as Entry[] })),
      ]);
      const summary = await buildVisitSummary({ state, history: hist.entries, notes: notes.entries, todayKey, tz, now });
      setText(summary);
      try {
        await navigator.clipboard.writeText(summary);
        setCopied(true);
        setFallback(false);
        toast("Visit summary copied. Paste it into a message or the patient portal.");
      } catch {
        setFallback(true);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't build the summary", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="maple-visit">
      <SectionTitle>
        <span id="maple-visit">For her pediatrician</span>
      </SectionTitle>
      <Card>
        <div className="flex gap-3">
          <KindBadge icon="stethoscope" color={KIND_COLOR.vitals} />
          <div className="min-w-0">
            <p className={cx(tone.heading, "text-[15px]")}>Visit summary</p>
            <p className={cx(tone.muted, "mt-0.5 text-[13px] leading-snug")}>
              The last 7 days in plain text: doctor questions, feeds, wet and dirty diapers, poop colors, sleep, temperatures, vitamin D and weights.
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => void build()} disabled={busy} className="flex-1 whitespace-nowrap">
            <Icon name={copied && !busy ? "check" : "copy"} size={18} />
            {busy ? "Gathering…" : copied ? "Copied" : "Copy summary"}
          </Button>
          {/* A real link so the browser downloads it; styled as Button's "soft" variant. */}
          <a
            href="/api/maple/export"
            download
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-mp-sunken px-4 text-[15px] font-semibold text-mp-ink transition hover:bg-mp-ink/10 active:scale-[0.98]"
          >
            <Icon name="download" size={18} />
            CSV
            <span className="sr-only">: download every entry as a spreadsheet</span>
          </a>
        </div>
        {text && fallback && (
          <div className="mt-3">
            <p className={cx(tone.muted, "mb-1.5 text-xs")}>Your browser blocked copying. Select all and copy:</p>
            <textarea ref={area} readOnly value={text} rows={10} className={cx(tone.input, "font-mono text-xs leading-snug")} onFocus={(e) => e.currentTarget.select()} />
          </div>
        )}
        {text && !fallback && (
          <details className="group mt-2">
            <summary className="-mb-2 inline-flex min-h-[44px] cursor-pointer list-none items-center gap-1 text-sm font-medium text-mp-accent-fg [&::-webkit-details-marker]:hidden">
              Preview
              <Icon name="chevron-down" size={16} className="transition group-open:rotate-180" />
            </summary>
            <pre className={cx(tone.inset, tone.body, "mt-2 max-h-72 overflow-auto p-3 text-xs leading-snug whitespace-pre-wrap")}>{text}</pre>
          </details>
        )}
      </Card>
    </section>
  );
}
