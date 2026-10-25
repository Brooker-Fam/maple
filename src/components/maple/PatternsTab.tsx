"use client";

import dynamic from "next/dynamic";
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { feedClusters, feedTotals, nursingRuns, spanText, type FeedCluster, type NursingRun } from "@/lib/maple/feed";
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
import type { NavTarget } from "./AppNav";
import { useCareNav } from "./care/CareNav";
import { NavRow } from "./care/parts";
import { Icon, KindBadge } from "./icons";
import { bucketWindows, dstNote, fetchRange, mergeLive, requestTimelineDay, statsByDay, useEntryRange, type TimeWindow } from "./LogTab";
import { useNightActive } from "./nightLook";
import { KIND_COLOR } from "./palette";
import { useSheets } from "./sheets";
import { Button, Card, EmptyState, HowToRead, SectionTitle, Segmented, cx, tone } from "./ui";
import { useMaple, useNow } from "./useMaple";

/**
 * Patterns (History's second segment): the rhythm of her days (ribbons),
 * daily totals and growth on the WHO curves, under a row to "For the doctor"
 * (questions, the plain-text visit summary, her doctor's numbers; the
 * summary card itself, VisitSummary, lives here and shows in that sheet).
 * Everything here describes what was logged; nothing scores it. Charts are
 * hand-rolled SVG (no chart library), sized to the card with a
 * ResizeObserver.
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
 * Left and right nursing wear the side colors (rust and honey, as on the
 * dial and the side discs), so "L" is the same color on every screen.
 * Ribbon lanes (feeds on top, sleep/tummy middle, diapers bottom) separate
 * classes by position as well as hue.
 *
 * The chrome (grid, track, axis, the halo around diaper dots) comes from the
 * mp-* tokens, so it follows dark mode and the night look on its own.
 *
 * At night every series folds into the one amber, like the dock's dots and
 * the badges, and is told apart by lane, shape and strength instead of hue:
 * sleep a soft wash (0.35), nursing solid (left 0.85, right 0.55, with a 1px
 * seam between them), bottles a hollow outline (0.55), wet diapers a hollow
 * ring (0.7), dirty ones a solid dot (0.7), tummy time and pumping 0.45. The
 * alphas live here; the hollow shapes switch on useNightActive(). Legends
 * draw from the same values, so a key always matches its marks. Stool colors
 * fold into the amber too, as on the day dial; the diaper tooltip names them.
 */
const VIZ_VARS =
  "[--v-grid:var(--mp-line)] [--v-track:var(--mp-sunken)] [--v-axis:color-mix(in_srgb,var(--mp-ink)_28%,transparent)] [--v-surface:var(--mp-surface)] " +
  "[--v-sleep:#9077BC] [--v-nurse:#C55F1D] [--v-bottle:#E0A93B] [--v-pee:#4F8FAE] [--v-poop:#905718] [--v-tummy:#69863E] [--v-pump:#CA805D] " +
  "[--v-left:#B5452B] [--v-right:#E0A93B] [--v-both:#8C7C6B] [--v-band:rgba(92,122,74,0.13)] [--v-target:#7A5A12] [--v-dot-edge:rgba(29,68,32,0.35)] [--v-now:#C55F1D] " +
  "dark:[--v-sleep:#9E85CB] dark:[--v-nurse:#BF4213] dark:[--v-bottle:#B88C06] dark:[--v-pee:#3CA1C4] dark:[--v-poop:#985E22] dark:[--v-pump:#C97E5B] " +
  "dark:[--v-left:#CF5B3E] dark:[--v-right:#D9A23A] dark:[--v-both:#A99A88] dark:[--v-band:rgba(169,192,143,0.13)] dark:[--v-target:#E0C27A] dark:[--v-dot-edge:rgba(245,237,223,0.5)] dark:[--v-now:#E0A93B] " +
  "[.maple-night_&]:[--v-sleep:rgb(224_169_59/0.35)] [.maple-night_&]:[--v-nurse:rgb(224_169_59/0.85)] [.maple-night_&]:[--v-bottle:rgb(224_169_59/0.55)] " +
  "[.maple-night_&]:[--v-left:rgb(224_169_59/0.85)] [.maple-night_&]:[--v-right:rgb(224_169_59/0.55)] [.maple-night_&]:[--v-both:rgb(224_169_59/0.3)] " +
  "[.maple-night_&]:[--v-pee:rgb(224_169_59/0.7)] [.maple-night_&]:[--v-poop:rgb(224_169_59/0.7)] [.maple-night_&]:[--v-tummy:rgb(224_169_59/0.45)] [.maple-night_&]:[--v-pump:rgb(224_169_59/0.45)] " +
  "[.maple-night_&]:[--v-band:rgb(224_169_59/0.08)] [.maple-night_&]:[--v-target:rgb(224_169_59/0.7)] [.maple-night_&]:[--v-dot-edge:rgb(224_169_59/0.3)] [.maple-night_&]:[--v-now:#D9772B]";

const AXIS_TEXT = "fill-mp-ink-3 text-[10px] tabular-nums";
/** The Dirty lane's key: three stool colors she's likely to have (black, green, mustard). */
const DIRTY_KEY = [STOOL_COLOR_INFO.black.hex, STOOL_COLOR_INFO.green.hex, STOOL_COLOR_INFO.mustard.hex];
/** Shared chart margins: y labels on the left, dates along the bottom. */
const FRAME = { left: 30, right: 4, top: 10, bottom: 18 } as const;

type Range = "7" | "14" | "30" | "all";
type RibbonMode = "days" | "nights";

// For the doctor → "Growth chart": a request the tab takes once its charts have loaded (they sit above the growth
// chart, so a scroll before then lands short). Like requestTimelineDay: read when it mounts, or at once if it's there.
// It lapses after a while, so a request left behind (she went elsewhere first) never yanks a later visit down.
const GROWTH_ASK_MS = 30_000;
let pendingGrowth = 0;
const growthSubs = new Set<() => void>();
export function requestGrowthChart() {
  pendingGrowth = Date.now();
  for (const cb of growthSubs) cb();
}

// ── Tab ──────────────────────────────────────────────────────────────────

export default function PatternsTab({
  onNavigate,
  title = "Patterns",
  below,
}: {
  onNavigate?: (t: NavTarget) => void;
  /** The page title ("History" when it's History's segment). */
  title?: string;
  /** What sits under the title (History's Timeline | Patterns switch). */
  below?: ReactNode;
} = {}) {
  const { state, units, readOnly } = useMaple();
  const { open } = useSheets();
  const careNav = useCareNav();
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

  // "Growth chart" from For the doctor: scroll to it once everything above it has drawn (two frames after the last
  // week arrives) and this segment is showing; until then the request waits.
  const [growthAsk, setGrowthAsk] = useState(0);
  useEffect(() => {
    const cb = () => setGrowthAsk((n) => n + 1);
    growthSubs.add(cb);
    return () => {
      growthSubs.delete(cb);
    };
  }, []);
  const shown = below !== null;
  useEffect(() => {
    if (!pendingGrowth || !ready || !shown) return;
    if (Date.now() - pendingGrowth > GROWTH_ASK_MS) {
      pendingGrowth = 0;
      return;
    }
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const el = document.getElementById("maple-growth-chart");
        if (!el || !el.getClientRects().length) return;
        pendingGrowth = 0;
        el.scrollIntoView({ block: "start" });
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [ready, shown, growthAsk]);

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
      <header className="mb-4 px-1">
        <h1 className={cx(tone.display, "flex min-h-[44px] items-center text-[34px] leading-[1.05]")}>{title}</h1>
      </header>
      {below}

      {/* Her checkup things, one tap from the top: questions, the visit summary, her doctor's numbers. */}
      <div className={cx(tone.card, "mb-5 overflow-hidden")}>
        <NavRow
          icon="stethoscope"
          iconColor={KIND_COLOR.vitals}
          label="For her pediatrician"
          note="Questions to ask, the visit summary, her doctor's numbers"
          onClick={() => careNav.openDoctor()}
        />
      </div>

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
          <EmptyState title="Loading…" />
        ) : (
          <>
            {loggedDays < 2 && ready && (
              <Card>
                <EmptyState title="Patterns show up after two days">
                  {loggedDays > 0 && `Day ${loggedDays} of 2. `}Keep logging and her rhythms will appear here.
                </EmptyState>
              </Card>
            )}
            {loggedDays >= 2 && <Insights days={chartDays} entries={entries} todayKey={todayKey} tz={tz} now={now} />}

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

        <section aria-labelledby="maple-growth" id="maple-growth-chart" className="scroll-mt-[calc(env(safe-area-inset-top)+var(--maple-history-bar,0px)+12px)]">
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

function Insights({ days, entries, todayKey, tz, now }: { days: DayStats[]; entries: Entry[]; todayKey: string; tz: string; now: Date }) {
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

    // The Left/Right split leaves out back and forth (never split into made-up sides), and says so.
    const left = base.reduce((n, d) => n + d.leftSec, 0);
    const right = base.reduce((n, d) => n + d.rightSec, 0);
    const both = base.reduce((n, d) => n + d.bothSec, 0);
    if (left + right >= 30 * 60) {
      const l = Math.round((left / (left + right)) * 100);
      out.push(`Nursing split: L ${l}% · R ${100 - l}%${both >= 60 ? ", not counting back and forth" : ""}.`);
    }

    // Clusters by the one rule (feed.ts): 3+ feeds, each starting under 30 minutes after the last one ended.
    let clusterDays = 0;
    let evening = 0;
    let total = 0;
    const clusters = feedClusters(nursingRuns(entries, now));
    for (const d of base) {
      const [a, b] = dayBounds(d.key, tz);
      const cs = clusters.filter((c) => c.start >= a.getTime() && c.start < b.getTime());
      if (cs.length) clusterDays++;
      for (const c of cs) {
        total++;
        const h = localParts(c.start, tz).hour;
        if (h >= 16 && h < 24) evening++;
      }
    }
    if (clusterDays) {
      const when = evening / total > 0.6 ? ", mostly in the evening" : "";
      out.push(`Cluster feeds on ${clusterDays} of ${base.length} day${base.length === 1 ? "" : "s"}${when}.`);
    } else {
      const sleep = base.reduce((n, d) => n + d.sleepSec, 0) / Math.max(1, base.length);
      if (sleep >= 3600) out.push(`About ${formatDuration(sleep)} of logged sleep a day.`);
    }
    return out.slice(0, 3);
  }, [days, entries, todayKey, tz, now]);

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
  // Feeds and clusters by the one rule (feed.ts), worked out once from everything loaded.
  const runs: NursingRun[] = nursingRuns(entries, now);
  const clusters: FeedCluster[] = feedClusters(runs);

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
      stats: statsFor(inRow, new Date(start), new Date(end), k, now, runs),
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
    for (const c of clusters) {
      if (c.start < start || c.start >= end) continue;
      const [x1, x2] = spanFrac(c.start - 5 * MIN, (c.end ?? nowMs) + 5 * MIN, start, end, wallStartMin, tz);
      row.clusters.push({ x1, x2, count: c.feeds, title: `Cluster ${spanText(c.start, c.end, tz)} · ${c.feeds} feeds` });
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
    // A momentary 0 (an ancestor hidden, a re-layout for a capture) keeps the last width rather than unmounting the chart.
    const ro = new ResizeObserver(([e]) => {
      const w = Math.floor(e.contentRect.width);
      if (w > 0) setW(w);
    });
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
  const night = useNightActive();
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
        <RibbonLegend night={night} />
        {/* Sticky clock: stays put while the rows scroll under it. */}
        <div className="sticky top-[calc(env(safe-area-inset-top)+var(--maple-history-bar,0px))] z-10 -mx-3 bg-mp-surface px-3 pt-1.5 pb-1">
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
              <RibbonRowView key={r.key} row={r} W={W} units={units} night={night} onPick={onPickDay ? () => onPickDay(r.jumpKey) : undefined} />
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

/** The ribbon key, drawn like the marks (bottles and pee turn hollow at night, as they do in the rows). */
function RibbonLegend({ night }: { night: boolean }) {
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
      {item(
        night ? (
          <rect x="4.25" y="0.75" width="6.5" height="8.5" rx="1.75" fill="none" stroke="var(--v-bottle)" strokeWidth="1.5" />
        ) : (
          <rect x="5" y="0" width="5" height="10" rx="1" fill="var(--v-bottle)" />
        ),
        "Bottle"
      )}
      {item(
        night ? (
          <circle cx="8" cy="5" r="3.25" fill="none" stroke="var(--v-pee)" strokeWidth="1.5" />
        ) : (
          <circle cx="8" cy="5" r="4" fill="var(--v-pee)" />
        ),
        "Pee"
      )}
      {item(<circle cx="8" cy="5" r="4" fill="var(--v-poop)" />, "Poop")}
      {item(<rect x="0" y="2.5" width="16" height="5" rx="2" fill="var(--v-tummy)" />, "Tummy")}
      {item(<rect x="0" y="0" width="16" height="10" rx="2" fill="var(--v-bottle)" opacity="0.22" />, "Cluster")}
    </div>
  );
}

function RibbonRowView({ row, W, units, night, onPick }: { row: RibbonRow; W: number; units: UnitSystem; night: boolean; onPick?: () => void }) {
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
        {row.feeds.map((f, i) => {
          const w = Math.max(2, x(f.x2) - x(f.x1));
          // At night a bottle is a hollow pill (wide enough to read as one), like the dial's.
          return f.bottle && night ? (
            <rect
              key={`f${i}`}
              x={x(f.x1) + 0.75}
              y={0.75}
              width={Math.max(6, w) - 1.5}
              height={3.5}
              rx={1.75}
              fill="transparent"
              stroke="var(--v-bottle)"
              strokeWidth={1.5}
            >
              <title>{f.title}</title>
            </rect>
          ) : (
            <rect key={`f${i}`} x={x(f.x1)} y={0} width={w} height={5} rx={1} fill={f.bottle ? "var(--v-bottle)" : "var(--v-nurse)"}>
              <title>{f.title}</title>
            </rect>
          );
        })}
        {row.diapers.map((d, i) => {
          const cx_ = Math.min(W - 4, Math.max(4, x(d.x)));
          const cy = 29.5;
          const r = 3.6;
          // Night: wet is a hollow ring, dirty a solid dot; wet + dirty is half of each.
          const ring = r - 0.75;
          return (
            <g key={`d${i}`}>
              <title>{d.title}</title>
              <circle cx={cx_} cy={cy} r={r + 1.5} fill="var(--v-surface)" />
              {d.pee && d.poop ? (
                night ? (
                  <>
                    <path d={`M${cx_},${cy - ring}A${ring},${ring} 0 0 0 ${cx_},${cy + ring}`} fill="none" stroke="var(--v-pee)" strokeWidth={1.5} />
                    <path d={`M${cx_},${cy - r}A${r},${r} 0 0 1 ${cx_},${cy + r}Z`} fill="var(--v-poop)" />
                  </>
                ) : (
                  <>
                    <path d={`M${cx_},${cy - r}A${r},${r} 0 0 0 ${cx_},${cy + r}Z`} fill="var(--v-pee)" />
                    <path d={`M${cx_},${cy - r}A${r},${r} 0 0 1 ${cx_},${cy + r}Z`} fill="var(--v-poop)" />
                  </>
                )
              ) : d.pee && night ? (
                <circle cx={cx_} cy={cy} r={ring} fill="var(--v-surface)" stroke="var(--v-pee)" strokeWidth={1.5} />
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
 * Without yTicks the chart draws its own grid (the diaper lanes do).
 */
function ChartFrame({
  n,
  keys,
  todayKey,
  height,
  yMax = 1,
  yTicks = [],
  yLabel = String,
  ariaLabel,
  tooltip,
  children,
}: {
  n: number;
  keys: string[];
  todayKey: string;
  height: number;
  yMax?: number;
  yTicks?: number[];
  yLabel?: (v: number) => string;
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

  const { left: LEFT, right: RIGHT, top: TOP, bottom: BOTTOM } = FRAME;
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

/** A tooltip line: the series' key (hollow where its marks are), the number, and what it counts. */
function TipRow({ color, value, label, dot, hollow }: { color: string; value: string; label: string; dot?: boolean; hollow?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <svg width="12" height="8" aria-hidden className="shrink-0">
        {dot ? (
          hollow ? (
            <circle cx="6" cy="4" r="2.9" fill="none" stroke={color} strokeWidth="1.5" />
          ) : (
            <circle cx="6" cy="4" r="3.5" fill={color} />
          )
        ) : hollow ? (
          <rect x="0.75" y="1.25" width="10.5" height="5.5" rx="2.75" fill="none" stroke={color} strokeWidth="1.5" />
        ) : (
          <line x1="0" x2="12" y1="4" y2="4" stroke={color} strokeWidth="3" strokeLinecap="round" />
        )}
      </svg>
      <strong className="font-semibold tabular-nums">{value}</strong>
      <span className="opacity-80">{label}</span>
    </span>
  );
}

/** A legend key: a dot in the series color, or a ring where the marks are hollow (bottles at night). */
function KeyDot({ color, hollow }: { color: string; hollow?: boolean }) {
  return (
    <svg width="8" height="8" aria-hidden className="shrink-0">
      {hollow ? <circle cx="4" cy="4" r="3.25" fill="none" stroke={color} strokeWidth="1.5" /> : <circle cx="4" cy="4" r="4" fill={color} />}
    </svg>
  );
}

/**
 * One chart inside the grouped "Day by day" card: title, a live subtitle and
 * key when there is one, the plot, and its explanation behind "How to read this".
 */
function ChartBlock({
  title,
  subtitle,
  legend,
  how,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Series colors are the --v-* variables, so the keys follow the night look with the marks. */
  legend?: { color: string; label: string; hollow?: boolean }[];
  how?: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure className={cx("px-3 pt-4", how ? "pb-0.5" : "pb-3")}>
      <figcaption className="mb-3 px-1">
        <h3 className={cx(tone.heading, "text-[15px]")}>{title}</h3>
        {subtitle && <p className={cx(tone.muted, "mt-0.5 text-[13px] leading-snug")}>{subtitle}</p>}
        {legend && legend.length > 1 && (
          <p className={cx(tone.muted, "mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-xs font-medium")}>
            {legend.map((l) => (
              <span key={l.label} className="inline-flex items-center gap-1.5">
                <KeyDot color={l.color} hollow={l.hollow} />
                {l.label}
              </span>
            ))}
          </p>
        )}
      </figcaption>
      {children}
      {how && <HowToRead>{how}</HowToRead>}
    </figure>
  );
}

/** The quieter charts, folded into the bottom row of the card until asked for. */
function MoreCharts({ open, onToggle, summary, children }: { open: boolean; onToggle: () => void; summary: string; children: ReactNode }) {
  const id = useId();
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        className={cx(tone.row, "min-h-[52px]", !open && "rounded-b-[19px]")}
      >
        <span className={cx(tone.body, "shrink-0 text-[15px] font-medium")}>More charts</span>
        <span className={cx(tone.muted, "min-w-0 flex-1 truncate text-right text-sm")}>{summary}</span>
        <Icon name="chevron-down" size={18} className={cx("shrink-0 text-mp-ink-3 transition motion-reduce:transition-none", open && "rotate-180")} />
      </button>
      {open && (
        <div id={id} className={cx(tone.divide, "border-t border-mp-line")}>
          {children}
        </div>
      )}
    </div>
  );
}

/** At night bottles are hollow outlines (the series' color is then the stroke). */
type BarSeries = { id: string; label: string; color: string; values: number[]; hollow?: boolean };

/** Column chart, stacked when there's more than one series. Today's column (partial) is lighter. */
function Columns({
  keys,
  todayKey,
  series,
  height = 128,
  band,
  integer = false,
  night = false,
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
  night?: boolean;
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
  // Between stacked segments: a 2px gap by day; at night a 1px seam in the page color.
  const seam = night ? 1 : 2;
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
              <g key={k} opacity={k === todayKey ? (night ? 0.7 : 0.55) : 1}>
                {series.map((ser, j) => {
                  const v = ser.values[i] ?? 0;
                  if (v <= 0) return null;
                  const gap = cum > 0 ? seam : 0;
                  const y0 = s.y(cum) - gap;
                  cum += v;
                  const y1 = s.y(cum);
                  const h = y0 - y1;
                  if (h <= 0.5) return null;
                  const top = j === topIdx;
                  // Hollow segments are inset by half the stroke so they cover the same footprint.
                  const mark = ser.hollow ? (
                    top ? (
                      <path
                        d={topRounded(x + 0.75, y1 + 0.75, Math.max(0.5, s.barW - 1.5), Math.max(0.5, h - 1.5), 3.25)}
                        fill="none"
                        stroke={ser.color}
                        strokeWidth={1.5}
                      />
                    ) : (
                      <rect
                        x={x + 0.75}
                        y={y1 + 0.75}
                        width={Math.max(0.5, s.barW - 1.5)}
                        height={Math.max(0.5, h - 1.5)}
                        fill="none"
                        stroke={ser.color}
                        strokeWidth={1.5}
                      />
                    )
                  ) : top ? (
                    <path d={topRounded(x, y1, s.barW, h, 4)} fill={ser.color} />
                  ) : (
                    <rect x={x} y={y1} width={s.barW} height={h} fill={ser.color} />
                  );
                  return (
                    <Fragment key={ser.id}>
                      {night && gap > 0 && <rect x={x} y={y0} width={s.barW} height={gap} fill="var(--mp-bg)" />}
                      {mark}
                    </Fragment>
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

/** One day of the diaper chart: wet count, dirty diapers by stool color (null = not noted), and the least to expect. */
type DiaperDay = { wet: number; stools: (string | null)[]; wetTarget: number | null; dirtyTarget: number | null };

/**
 * Wet and dirty diapers in one chart: two lanes of dots on one day axis, each
 * dot one diaper (dirty ones in their stool color by day), with a short line at the
 * least to expect for her day of life. Both lanes share a step, so a dot and
 * a count are the same size in each.
 */
function DiaperLanes({
  keys,
  todayKey,
  data,
  night,
  ariaLabel,
  tooltip,
}: {
  keys: string[];
  todayKey: string;
  data: DiaperDay[];
  night: boolean;
  ariaLabel: string;
  tooltip: (i: number) => ReactNode;
}) {
  const wetMax = Math.max(1, ...data.map((d) => Math.max(d.wet, d.wetTarget ?? 0)));
  const dirtyMax = Math.max(1, ...data.map((d) => Math.max(d.stools.length, d.dirtyTarget ?? 0)));
  const step = Math.max(7, Math.min(11, 96 / (Math.max(wetMax, dirtyMax) + 0.5)));
  const LABEL = 18;
  const GAP = 12;
  // The first lane's name sits in the frame's top margin, right under the chart title.
  const wetLabel = 0;
  const wetTop = wetLabel + LABEL;
  const wetBottom = wetTop + (wetMax + 0.5) * step;
  const dirtyLabel = wetBottom + GAP;
  const dirtyTop = dirtyLabel + LABEL;
  const dirtyBottom = dirtyTop + (dirtyMax + 0.5) * step;
  const lanes = [
    { id: "wet", label: "Wet", max: wetMax, labelY: wetLabel, bottom: wetBottom },
    { id: "dirty", label: "Dirty", max: dirtyMax, labelY: dirtyLabel, bottom: dirtyBottom },
  ] as const;
  const height = dirtyBottom + FRAME.bottom;

  return (
    <ChartFrame n={keys.length} keys={keys} todayKey={todayKey} height={height} ariaLabel={ariaLabel} tooltip={tooltip}>
      {(s) => {
        const r = Math.max(2, Math.min(5, s.slot * 0.34, step / 2 - 0.75));
        const half = Math.min(s.slot * 0.45, 11);
        return lanes.map((lane) => {
          const wet = lane.id === "wet";
          const y = (v: number) => lane.bottom - v * step;
          const ticks = niceTicks(lane.max, 2, true).filter((t) => t <= lane.max + 0.5);
          const ky = lane.labelY + 5;
          return (
            <g key={lane.id}>
              {/* Lane name, keyed like its dots */}
              {wet && night ? (
                <circle cx={s.left + 4} cy={ky} r={3.25} fill="none" stroke="var(--v-pee)" strokeWidth={1.5} />
              ) : wet || night ? (
                <circle cx={s.left + 4} cy={ky} r={4} fill={wet ? "var(--v-pee)" : "var(--v-poop)"} />
              ) : (
                // Dirty dots wear their stool color, so the key is a few of them overlapping
                // (cut apart by the card), not one brown dot that matches none of them.
                DIRTY_KEY.map((hex, j) => (
                  <g key={hex}>
                    {j > 0 && <circle cx={s.left + 4 + 5 * j} cy={ky} r={5} fill="var(--v-surface)" />}
                    <circle cx={s.left + 4 + 5 * j} cy={ky} r={4} fill={hex} stroke="var(--v-dot-edge)" strokeWidth={0.75} />
                  </g>
                ))
              )}
              <text x={s.left + (wet || night ? 13 : 23)} y={ky} dy="0.35em" className="fill-mp-ink-2 text-[11px] font-medium">
                {lane.label}
              </text>
              {ticks.map((v) => (
                <g key={v}>
                  <line x1={s.left} x2={s.W - FRAME.right} y1={y(v)} y2={y(v)} stroke={v === 0 ? "var(--v-axis)" : "var(--v-grid)"} strokeWidth={1} />
                  <text x={s.left - 5} y={y(v)} dy="0.32em" textAnchor="end" className={AXIS_TEXT}>
                    {v}
                  </text>
                </g>
              ))}
              {keys.map((k, i) => {
                const d = data[i];
                const partial = k === todayKey;
                const cx_ = s.cx(i);
                const target = wet ? d.wetTarget : d.dirtyTarget;
                const dots: (string | null)[] = wet ? new Array<null>(d.wet).fill(null) : d.stools;
                return (
                  <g key={k}>
                    {dots.map((c, j) =>
                      wet ? (
                        night ? (
                          <circle key={j} cx={cx_} cy={y(j + 0.5)} r={r - 0.75} fill="var(--v-surface)" stroke="var(--v-pee)" strokeWidth={1.5} opacity={partial ? 0.65 : 1} />
                        ) : (
                          <circle key={j} cx={cx_} cy={y(j + 0.5)} r={r} fill="var(--v-pee)" stroke="var(--v-dot-edge)" strokeWidth={0.75} opacity={partial ? 0.65 : 1} />
                        )
                      ) : (
                        <circle
                          key={j}
                          cx={cx_}
                          cy={y(j + 0.5)}
                          r={r}
                          // At night every dirty dot is the solid amber, like the dial's: a dark stool color
                          // drawn there would read as a hollow ring (a wet diaper). The tooltip names each color.
                          fill={night ? "var(--v-poop)" : (c ?? "var(--v-poop)")}
                          stroke={night ? "none" : "var(--v-dot-edge)"}
                          strokeWidth={0.75}
                          opacity={partial ? 0.65 : 1}
                        />
                      )
                    )}
                    {target != null && (
                      <line
                        x1={cx_ - half}
                        x2={cx_ + half}
                        y1={y(target)}
                        y2={y(target)}
                        stroke="var(--v-target)"
                        strokeWidth={1.5}
                        strokeLinecap="round"
                        opacity={partial ? 0.45 : 0.9}
                      />
                    )}
                  </g>
                );
              })}
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
  const night = useNightActive();
  const [asTable, setAsTable] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
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
  const anyBoth = days.some((d) => d.bothSec > 0);
  const lPct = totalL + totalR ? Math.round((totalL / (totalL + totalR)) * 100) : 0;
  const bornAge = bornAt ? babyAge(bornAt, now, tz) : null;
  const more = [anyBottle && "bottle", anyPump && "pumped", anyTummy && "tummy time"].filter((m): m is string => !!m);
  const moreSummary = more.length ? more[0][0].toUpperCase() + more.join(", ").slice(1) : "";

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
          {/* One card, hairlines between charts. Not overflow-hidden: the first chart's tooltip may rise above its top edge. */}
          <div className={cx(tone.card, tone.divide)}>
            <ChartBlock
              title="Feeds per day"
              legend={
                anyBottleFeeds
                  ? [
                      { color: "var(--v-nurse)", label: "Nursing" },
                      { color: "var(--v-bottle)", label: "Bottle", hollow: night },
                    ]
                  : undefined
              }
              how={<p>{`Shaded band: ${FEEDS_PER_DAY[0]}–${FEEDS_PER_DAY[1]} a day, typical for newborns.`}</p>}
            >
              <Columns
                keys={keys}
                todayKey={todayKey}
                band={{ lo: FEEDS_PER_DAY[0], hi: FEEDS_PER_DAY[1] }}
                integer
                night={night}
                series={[
                  { id: "breast", label: "Nursing", color: "var(--v-nurse)", values: days.map((d) => d.breastFeeds) },
                  { id: "bottle", label: "Bottle", color: "var(--v-bottle)", values: days.map((d) => d.bottleFeeds), hollow: night },
                ]}
                yLabel={(v) => String(v)}
                valueLabel={(v) => String(v)}
                ariaLabel={`Feeds per day: ${days.map((d) => `${shortDate(d.key)} ${d.feeds}`).join(", ")}`}
                tooltip={(i) => (
                  <>
                    <TipRow color="var(--v-nurse)" value={String(days[i].breastFeeds)} label={`nursing${so(i)}`} />
                    {anyBottleFeeds && <TipRow color="var(--v-bottle)" hollow={night} value={String(days[i].bottleFeeds)} label="bottle" />}
                  </>
                )}
              />
            </ChartBlock>

            <ChartBlock
              title="Diapers"
              how={
                <>
                  <p>Each dot is one wet diaper. The short line is the least to expect for her day of life.</p>
                  <p>Each dot is one dirty diaper, in its color: black at first, then green, then mustard yellow.</p>
                </>
              }
            >
              <DiaperLanes
                keys={keys}
                todayKey={todayKey}
                night={night}
                data={days.map((d, i) => ({
                  wet: d.wet,
                  stools: (stools.get(d.key) ?? []).map((c) => (c ? STOOL_COLOR_INFO[c].hex : null)),
                  wetTarget: targets[i]?.wet ?? null,
                  dirtyTarget: targets[i]?.dirty ?? null,
                }))}
                ariaLabel={`Wet diapers per day: ${days.map((d) => `${shortDate(d.key)} ${d.wet}`).join(", ")}. Dirty diapers per day: ${days
                  .map((d) => `${shortDate(d.key)} ${d.dirty}`)
                  .join(", ")}`}
                tooltip={(i) => {
                  const cs = stools.get(keys[i]) ?? [];
                  const counts = new Map<string, number>();
                  for (const c of cs) {
                    const label = c ? STOOL_COLOR_INFO[c].label.toLowerCase() : "no color noted";
                    counts.set(label, (counts.get(label) ?? 0) + 1);
                  }
                  const t = targets[i];
                  return (
                    <>
                      <TipRow dot hollow={night} color="var(--v-pee)" value={String(days[i].wet)} label={`wet${so(i)}`} />
                      {t && <span className="block opacity-80">Expect at least {t.wet} wet around Day {t.dol}</span>}
                      <span className="mt-1 block">
                        <TipRow dot color="var(--v-poop)" value={String(days[i].dirty)} label={`dirty${so(i)}`} />
                      </span>
                      {[...counts].map(([l, c]) => (
                        <span key={l} className="block opacity-80">
                          {c > 1 ? `${c}× ` : ""}
                          {l}
                        </span>
                      ))}
                      {t?.dirty != null && <span className="block opacity-80">Expect at least {t.dirty} dirty around Day {t.dol}</span>}
                    </>
                  );
                }}
              />
            </ChartBlock>

            <ChartBlock title="Sleep per day" how={<p>{`${SLEEP_TOTAL_NOTE} Only logged sleep counts here, so a missed nap makes a day look short.`}</p>}>
              <Columns
                keys={keys}
                todayKey={todayKey}
                night={night}
                series={[{ id: "sleep", label: "Sleep", color: "var(--v-sleep)", values: days.map((d) => d.sleepSec / 3600) }]}
                yLabel={(v) => (v ? `${v}h` : "0")}
                valueLabel={(v) => formatDuration(v * 3600)}
                ariaLabel={`Logged sleep per day: ${days.map((d) => `${shortDate(d.key)} ${formatDuration(d.sleepSec)}`).join(", ")}`}
                tooltip={(i) => <TipRow color="var(--v-sleep)" value={formatDuration(days[i].sleepSec)} label={`logged sleep${so(i)}`} />}
              />
            </ChartBlock>

            {anyNursing && (
              <ChartBlock
                title={anyBoth ? "Nursing minutes, by side" : "Nursing minutes, left and right"}
                subtitle={
                  totalL + totalR >= 60 ? `Over these days: L ${lPct}% · R ${100 - lPct}%${anyBoth ? ", not counting back and forth" : ""}.` : undefined
                }
                legend={[
                  { color: "var(--v-left)", label: "L · Left" },
                  { color: "var(--v-right)", label: "R · Right" },
                  ...(anyBoth ? [{ color: "var(--v-both)", label: "Back and forth" }] : []),
                ]}
              >
                <Columns
                  keys={keys}
                  todayKey={todayKey}
                  night={night}
                  series={[
                    { id: "L", label: "Left", color: "var(--v-left)", values: days.map((d) => d.leftSec / 3600) },
                    { id: "R", label: "Right", color: "var(--v-right)", values: days.map((d) => d.rightSec / 3600) },
                    // Back and forth (both sides, not tracked) stacks on top as its own series, never split into L and R.
                    ...(anyBoth ? [{ id: "B", label: "Back and forth", color: "var(--v-both)", values: days.map((d) => d.bothSec / 3600) }] : []),
                  ]}
                  yLabel={(v) => (v ? `${v}h` : "0")}
                  valueLabel={(v) => formatDuration(v * 3600)}
                  ariaLabel={`Nursing minutes per day: ${days
                    .map((d) => `${shortDate(d.key)} left ${Math.round(d.leftSec / 60)}, right ${Math.round(d.rightSec / 60)}${d.bothSec ? `, back and forth ${Math.round(d.bothSec / 60)}` : ""}`)
                    .join("; ")}`}
                  tooltip={(i) => (
                    <>
                      <TipRow color="var(--v-left)" value={formatDuration(days[i].leftSec)} label="L" />
                      <TipRow color="var(--v-right)" value={formatDuration(days[i].rightSec)} label={anyBoth ? "R" : `R${so(i)}`} />
                      {anyBoth && <TipRow color="var(--v-both)" value={formatDuration(days[i].bothSec)} label={`back and forth${so(i)}`} />}
                    </>
                  )}
                />
              </ChartBlock>
            )}

            {more.length > 0 && (
              <MoreCharts open={moreOpen} onToggle={() => setMoreOpen((o) => !o)} summary={moreSummary}>
                {anyBottle && (
                  <ChartBlock title={`Bottle per day (${volUnit})`}>
                    <Columns
                      keys={keys}
                      todayKey={todayKey}
                      night={night}
                      series={[{ id: "bottle", label: "Bottle", color: "var(--v-bottle)", values: days.map((d) => vol(d.bottleMl)), hollow: night }]}
                      yLabel={(v) => String(v)}
                      valueLabel={(v) => `${v} ${volUnit}`}
                      ariaLabel={`Bottle volume per day: ${days.map((d) => `${shortDate(d.key)} ${formatVolume(d.bottleMl, units)}`).join(", ")}`}
                      tooltip={(i) => <TipRow color="var(--v-bottle)" hollow={night} value={formatVolume(days[i].bottleMl, units)} label={`by bottle${so(i)}`} />}
                    />
                  </ChartBlock>
                )}

                {anyPump && (
                  <ChartBlock title={`Pumped per day (${volUnit})`}>
                    <Columns
                      keys={keys}
                      todayKey={todayKey}
                      night={night}
                      series={[{ id: "pump", label: "Pumped", color: "var(--v-pump)", values: days.map((d) => vol(d.pumpMl)) }]}
                      yLabel={(v) => String(v)}
                      valueLabel={(v) => `${v} ${volUnit}`}
                      ariaLabel={`Pumped per day: ${days.map((d) => `${shortDate(d.key)} ${formatVolume(d.pumpMl, units)}`).join(", ")}`}
                      tooltip={(i) => <TipRow color="var(--v-pump)" value={formatVolume(days[i].pumpMl, units)} label={`pumped${so(i)}`} />}
                    />
                  </ChartBlock>
                )}

                {anyTummy && (
                  <ChartBlock
                    title="Tummy time per day"
                    how={bornAge ? <p>{`A goal of about ${tummyGoalMinutes(bornAge.days)} minutes a day at her age, in short sessions.`}</p> : undefined}
                  >
                    <Columns
                      keys={keys}
                      todayKey={todayKey}
                      height={110}
                      night={night}
                      series={[{ id: "tummy", label: "Tummy time", color: "var(--v-tummy)", values: days.map((d) => d.tummySec / 60) }]}
                      yLabel={(v) => (v ? `${v}m` : "0")}
                      valueLabel={(v) => formatDuration(v * 60)}
                      ariaLabel={`Tummy time per day: ${days.map((d) => `${shortDate(d.key)} ${formatDuration(d.tummySec)}`).join(", ")}`}
                      tooltip={(i) => <TipRow color="var(--v-tummy)" value={formatDuration(days[i].tummySec)} label={`tummy time${so(i)}`} />}
                    />
                  </ChartBlock>
                )}
              </MoreCharts>
            )}
          </div>
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
  const anyBoth = days.some((d) => d.bothSec > 0);
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
            <th scope="col" className={th}>{anyBoth ? "Nursing L / R / both" : "Nursing L / R"}</th>
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
                {anyBoth && ` / ${formatDuration(d.bothSec)}`}
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
    if (d.nursingSec) {
      const both = d.bothSec ? ` / back and forth ${formatDuration(d.bothSec)}` : "";
      feedBits.push(`nursing ${formatDuration(d.nursingSec)}: L ${formatDuration(d.leftSec)} / R ${formatDuration(d.rightSec)}${both}`);
    }
    if (d.clusters) feedBits.push(d.clusters === 1 ? "one cluster" : `${d.clusters} clusters`);
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

/** The visit summary card (copy as plain text, or the CSV), shown in "For the doctor". */
export function VisitSummary({ state, todayKey, tz, now }: { state: MapleState; todayKey: string; tz: string; now: Date }) {
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
