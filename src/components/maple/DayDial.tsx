"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { describeEntry } from "@/lib/maple/describe";
import { clockContains, clockFraction, clockSpans } from "@/lib/maple/clock-spans";
import { clusterLine, feedClusters, nursingRuns, type FeedCluster } from "@/lib/maple/feed";
import { diaperTargets, FEEDS_PER_DAY, STOOL_COLOR_INFO, tummyGoalMinutes } from "@/lib/maple/guidelines";
import { statsFor } from "@/lib/maple/insights";
import { nursingSpans } from "@/lib/maple/nursing-spans";
import { addDays, babyAge, dayBounds, dayKey, DEFAULT_TZ, formatDayLabel, formatDuration, formatTime, localParts, parseDayKey, tzOffsetMinutes, zonedTimeToUtc } from "@/lib/maple/time";
import type { Entry } from "@/lib/maple/types";
import { useMilestoneWords } from "./familyWords";
import { useClockMinute } from "./FeedParts";
import { MAPLE_LEAF_PATH } from "./Hero";
import type { PatternActivity } from "./PatternActivity";
import { DROPLET_PATH, Icon, KindBadge } from "./icons";
import { logSwitches } from "./MoreSheet";
import { useNightActive } from "./nightLook";
import { DETAIL_COLOR, SIDE_COLOR } from "./palette";
import { useSheets } from "./sheets";
import { Tallies } from "./StatusCard";
import { Button, Segmented, cx, tone } from "./ui";
import { useMaple } from "./useMaple";
import { useDayHistory } from "./useDayHistory";

/**
 * The Day Dial: a 24-hour clock face (midnight at the top, clockwise) in
 * History's Day clock view. Sleep is the
 * outer ring, feeds the middle (rust = left, honey = right, a hollow gold pill
 * = bottle), diapers the inner track: pee an upright blue drop, poop a dot in
 * its logged color, both a dot with a small drop. Tap anywhere on the ring to
 * see what happened around then and edit it.
 *
 * One range control drives both the dial and the tallies under it ("The day so
 * far"): the last 24 hours ending now (at 3am that's last night and yesterday
 * evening, not an empty dial; older marks fade), today from midnight to now,
 * yesterday, or an older day with the arrows.
 *
 * By day and in dark mode the marks keep their kind colors. At night they fold
 * into the amber, told apart by lane, strength and shape (a hollow drop for
 * pee, a hollow pill for bottles, Right striped against Left's solid band,
 * back and forth a crosshatch); the legend follows. The night hours are
 * shaded in the face's own ink, and the one ornament is the maple leaf on
 * the now hand.
 *
 * Back and forth (both sides, not tracked) is striped in the two side
 * colors by day. A thin bracket just outside the feed ring spans each
 * cluster (3+ feeds, each under 30 minutes after the last); tapping it says
 * "Cluster 6:02–8:40 PM · 4 feeds · nursed 1h 52m" above its feeds.
 */

const C = 160;
const R = { night: 150, label: 161, sleep: 132, feed: 110, bracket: 120.5, diaper: 88, handIn: 68, handOut: 150 };
// The kinds' own colors (palette.ts), so a mark on the dial matches its tile, row and toast. Sleep stays lighter on the ring.
const COLORS = {
  sleep: "#B8A9C9",
  left: SIDE_COLOR.L,
  right: SIDE_COLOR.R,
  // The bottle pill is hollow: its inside is the face color (stroke-mp-surface), so it never glares white at night.
  bottleEdge: "#C49A3C",
  pee: DETAIL_COLOR.pee,
  poop: DETAIL_COLOR.poop,
  hand: "#D9772B",
};
type Palette = Record<keyof typeof COLORS, string>;
const amber = (a: number) => `rgb(224 169 59 / ${a})`;
/** The night look: every kind in the amber, strongest where it matters most (the left side, the diapers). */
const NIGHT_COLORS: Palette = {
  sleep: amber(0.35),
  left: amber(0.85),
  // Striped (the dial's hatch pattern), so it can be nearly as strong as Left and still read as the other side.
  right: amber(0.8),
  bottleEdge: amber(0.55),
  pee: amber(0.7),
  poop: amber(0.7),
  hand: COLORS.hand,
};
const MIN_ARC_DEG = 3;
const TAP_WINDOW_MS = 20 * 60_000;
/** Set once the person has tapped the ring on this device: the "tap the ring" hint has done its job. */
const HINT_KEY = "maple-dial-tapped";

/** "rolling" (the last 24 hours, ending now), "today" (midnight to now), or a past day's key. */
type View = "rolling" | "today" | string;

type Arc = {
  key: string;
  entry: Entry;
  lane: "sleep" | "feed" | "bottle";
  r: number;
  a0: number;
  span: number;
  color: string;
  width: number;
  opacity: number;
  live: boolean;
  /** Night: the Right side, striped (two strengths of one amber alone looked the same). */
  hatch: boolean;
  /** Back and forth: striped in both side colors (a crosshatch at night). */
  both: boolean;
  s: number;
  e: number;
};
/**
 * A diaper on the inner track. `color` is the poop's (its logged stool color; null when none was logged, drawn
 * neutral). `edge`: a stool color that would vanish into the face (black in dark mode, white or pale by day) gets a ring.
 */
type Dot = { key: string; entry: Entry; a: number; pee: boolean; poop: boolean; color: string | null; edge: "dark" | "light" | null; opacity: number; t: number };

const rad = (deg: number) => (deg * Math.PI) / 180;
const pt = (r: number, deg: number): [number, number] => [C + r * Math.sin(rad(deg)), C - r * Math.cos(rad(deg))];
const f = (n: number) => Math.round(n * 100) / 100;

function arcPath(r: number, a0: number, span: number): string {
  const s = Math.min(span, 359.9);
  const [x0, y0] = pt(r, a0);
  const [x1, y1] = pt(r, a0 + s);
  return `M ${f(x0)} ${f(y0)} A ${r} ${r} 0 ${s > 180 ? 1 : 0} 1 ${f(x1)} ${f(y1)}`;
}

function sectorPath(r: number, a0: number, span: number): string {
  const [x0, y0] = pt(r, a0);
  const [x1, y1] = pt(r, a0 + span);
  return `M ${C} ${C} L ${f(x0)} ${f(y0)} A ${r} ${r} 0 ${span > 180 ? 1 : 0} 1 ${f(x1)} ${f(y1)} Z`;
}

/** Clock angle (0° = midnight at the top) of an instant in the baby's zone. */
function clockDeg(t: number, tz: string): number {
  return clockFraction(t, 0, tz) * 360;
}

export function buildDayDialMarks(entries: Entry[], lo: number, hi: number, nowMs: number, tz: string, fade = false, pal: Palette = COLORS, night = false) {
  const arcs: Arc[] = [];
  const dots: Dot[] = [];
  const opacityAt = (t: number) => (fade ? Math.max(0.4, 1 - 0.6 * ((nowMs - t) / 3600_000 / 24)) : 1);
  const addArc = (entry: Entry, key: string, lane: Arc["lane"], s0: number, e0: number, r: number, color: string, width: number, live: boolean, hatch = false, both = false) => {
    if (s0 === e0 && lane !== "sleep") {
      if (s0 < lo || s0 >= hi || s0 > nowMs) return;
      arcs.push({ key, entry, lane, r, a0: clockDeg(s0, tz), span: MIN_ARC_DEG, color, width, opacity: opacityAt(s0), live, hatch, both, s: s0, e: e0 });
      return;
    }
    for (const [i, piece] of clockSpans(s0, e0, lo, Math.min(hi, nowMs), 0, tz).entries()) {
      arcs.push({ key: `${key}-${i}`, entry, lane, r, a0: piece.x1 * 360, span: (piece.x2 - piece.x1) * 360, color, width, opacity: opacityAt(piece.end), live, hatch, both, s: piece.start, e: piece.end });
    }
  };

  for (const entry of entries) {
    const start = Date.parse(entry.started_at);
    const end = entry.ended_at ? Date.parse(entry.ended_at) : entry.active ? nowMs : start;
    if (entry.kind === "sleep") {
      addArc(entry, `s${entry.id}`, "sleep", start, end, R.sleep, pal.sleep, 16, entry.active);
    } else if (entry.kind === "feed") {
      const d = entry.data;
      if (d.method === "bottle") {
        addArc(entry, `b${entry.id}`, "bottle", start, Math.max(end, start), R.feed, pal.bottleEdge, 14, false);
      } else {
        nursingSpans(entry, new Date(nowMs)).forEach((part, i) => {
          addArc(entry, `f${entry.id}-${i}`, "feed", part.start, part.end, R.feed, part.side === "R" ? pal.right : pal.left, 14, part.live, night && part.side === "R", part.side === "B");
        });
      }
    } else if (entry.kind === "diaper") {
      if (start < lo || start >= hi || start > nowMs) continue;
      // At night every poop is the same amber: the stool color is in the details and the entry. A poop with no color
      // logged is neutral, never a made-up brown.
      const stool = entry.data.poop ? entry.data.color : undefined;
      const color = night ? pal.poop : stool ? STOOL_COLOR_INFO[stool].hex : null;
      const edge = night || !stool ? null : stool === "black" ? "dark" : stool === "white" || stool === "pale_yellow" ? "light" : null;
      dots.push({ key: `d${entry.id}`, entry, a: clockDeg(start, tz), pee: entry.data.pee, poop: entry.data.poop, color, edge, opacity: opacityAt(start), t: start });
    }
  }
  // Long arcs first so short ones (and live ones) draw on top.
  arcs.sort((x, y) => Number(x.live) - Number(y.live) || y.span - x.span);
  return { arcs, dots };
}

export default function DayDial({ activity = "all" }: { activity?: PatternActivity }) {
  const { state, summary, units, readOnly } = useMaple();
  const words = useMilestoneWords();
  const { open, current: currentSheet } = useSheets();
  // On the clock minute, so a running feed's minutes in the list flip with the card's and the Timeline's.
  const now = useClockMinute();
  const night = useNightActive();
  const reduceMotion = useReducedMotion();
  const uid = useId().replace(/[^\w-]/g, "");
  const hatchId = `maple-dial-hatch-${uid}`;
  const bothId = `maple-dial-both-${uid}`;
  const hintId = `maple-dial-hint-${uid}`;
  const orientationId = `maple-dial-orientation-${uid}`;
  const detailId = `maple-dial-detail-${uid}`;
  const [choice, setChoice] = useState<View | null>(null);
  const [pop, setPop] = useState<{ t: number; items: Entry[]; cluster?: FeedCluster } | null>(null);
  const [hint, setHint] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const browseRef = useRef<HTMLElement>(null);
  const detailFocusRef = useRef<HTMLElement | null>(null);
  const editOpenerRef = useRef<HTMLElement | null>(null);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const todayKey = dayKey(now, tz);
  const yesterday = addDays(todayKey, -1);
  const bornKey = state?.baby.born_at ? dayKey(Date.parse(state.baby.born_at), tz) : null;
  const oldest = bornKey && bornKey > addDays(todayKey, -60) ? bornKey : addDays(todayKey, -60);
  // At 3am "today" is nearly empty and misleading: before 9am it opens on the last 24 hours.
  const picked: View = choice ?? (localParts(now, tz).hour < 9 ? "rolling" : "today");
  // A day picked as a key that has since become today (past midnight) is just "today".
  const view: View = picked === todayKey ? "today" : picked;
  const rolling = view === "rolling";
  const isToday = view === "today";
  /** The calendar day shown, or null for the rolling 24 hours. */
  const dayView = rolling ? null : isToday ? todayKey : view;
  const past = dayView != null && !isToday;
  // The state snapshot holds ~72h; older days come from the API.
  const needsFetch = dayView != null && dayView < yesterday;
  const history = useDayHistory(needsFetch ? dayView : null);
  const loading = needsFetch && history.loading;
  const loadError = needsFetch && history.error;
  const unavailable = needsFetch && !history.loaded;

  // The "tap the ring" hint shows until the first tap on this device (screen readers always get it).
  useEffect(() => {
    try {
      setHint(localStorage.getItem(HINT_KEY) == null);
    } catch {
      setHint(true);
    }
  }, []);
  const hintDone = () => {
    if (!hint) return;
    setHint(false);
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      // storage blocked: the hint comes back next visit
    }
  };

  // A new activity has its own events. Never leave a hidden event selected.
  useEffect(() => { setPop(null); }, [activity]);

  const closeDetails = () => {
    setPop(null);
    if (triggerRef.current?.isConnected) triggerRef.current.focus();
    else browseRef.current?.focus();
  };
  const revealDetails = () => requestAnimationFrame(() => {
    detailRef.current?.scrollIntoView({ block: "nearest", behavior: night || reduceMotion ? "instant" : "smooth" });
  });

  // A fresh snapshot may contain a log newer than the minute tick. Include it
  // immediately, while never extending a duration beyond the current clock.
  const nowMs = Math.max(now.getTime(), state ? Date.parse(state.now) : 0);
  const [lo, hi] = useMemo(() => {
    // Point events exactly at now belong in the window; local midnight does not.
    if (!dayView) return [nowMs - 24 * 3600_000, nowMs + 1];
    // DST-safe local midnights; today runs to now, a past day to its end.
    const [a, b] = dayBounds(dayView, tz);
    return [a.getTime(), Math.min(b.getTime(), nowMs + 1)];
  }, [dayView, nowMs, tz]);

  const source = useMemo(() => {
    if (!state) return [];
    if (!needsFetch) return state.entries;
    return history.entries;
  }, [history.entries, needsFetch, state]);

  // A remote deletion can remove the focused Edit action. Keep Escape and
  // keyboard navigation in the surviving details, without interrupting a sheet.
  useEffect(() => {
    if (currentSheet || !pop) return;
    const lost = [detailFocusRef.current, editOpenerRef.current].some((element) => element && !element.isConnected);
    if (!lost) { editOpenerRef.current = null; return; }
    const recover = () => {
      const active = document.activeElement;
      if (active === document.body && detailRef.current?.getClientRects().length) {
        detailRef.current.focus();
        editOpenerRef.current = null;
        observer.disconnect();
      } else if (active instanceof HTMLElement && active !== document.body && !active.closest('[role="dialog"]')) {
        // Focus has already moved deliberately, or the sheet restored it.
        editOpenerRef.current = null;
        observer.disconnect();
      }
    };
    // A closing sheet remains mounted for its exit animation. Wait for its
    // actual removal instead of racing it with a fixed delay.
    const observer = new MutationObserver(recover);
    observer.observe(document.body, { childList: true, subtree: true });
    const frame = requestAnimationFrame(recover);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [source, pop, currentSheet]);

  const pal = night ? NIGHT_COLORS : COLORS;
  const marks = useMemo(() => buildDayDialMarks(source, lo, hi, nowMs, tz, rolling, pal, night), [source, lo, hi, nowMs, tz, rolling, pal, night]);
  const arcs = marks.arcs.filter((mark) => activity === "all" || (activity === "sleep" ? mark.lane === "sleep" : activity === "feeds" && mark.lane !== "sleep"));
  const dots = activity === "all" || activity === "diapers" ? marks.dots : [];
  // One set of numbers for the dial's label and the tallies below, from the same entries and window.
  const runs = useMemo(() => nursingRuns(source, now), [source, now]);
  const stats = useMemo(() => statsFor(source, new Date(lo), new Date(hi), dayView ?? "last24h", now, runs), [source, lo, hi, dayView, now, runs]);
  // A bracket outside the feed ring for each cluster that reaches into the view.
  const brackets = useMemo(
    () =>
      (activity === "all" || activity === "feeds" ? feedClusters(runs) : [])
        .flatMap((c) => clockSpans(c.start, c.end ?? nowMs, lo, Math.min(hi, nowMs), 0, tz)
          .map((piece) => ({ c, a0: piece.x1 * 360, span: (piece.x2 - piece.x1) * 360, s: piece.start, e: piece.end }))),
    [runs, lo, hi, nowMs, tz, activity]
  );

  if (!state || !summary) return null;

  const showHand = rolling || isToday;
  const nowDeg = clockDeg(nowMs, tz);
  const offsetChange = tzOffsetMinutes(hi - 1, tz) - tzOffsetMinutes(lo, tz);
  // Her day of life on a past day (today's is in the header).
  const pastAge = past && state.baby.born_at ? babyAge(state.baby.born_at, new Date(hi - 1), tz) : null;
  const plotted = [...arcs.map((a) => a.entry), ...dots.map((d) => d.entry)].filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i);
  // Selection stores identity, never a stale version of an edited/deleted log.
  const selectedIds = new Set(pop?.items.map((entry) => entry.id));
  const selectedCluster = pop?.cluster ? brackets.find(({ c }) => c.entries.some((entry) => selectedIds.has(entry.id)))?.c : undefined;
  const selectedItems = selectedCluster ? selectedCluster.entries : plotted.filter((entry) => selectedIds.has(entry.id));
  const rangeName = rolling ? "Last 24 hours" : formatDayLabel(dayView ?? todayKey, todayKey, { long: true });
  const activitySummary = activity === "feeds" ? `${stats.feeds} feeds logged`
    : activity === "sleep" ? `${formatDuration(stats.sleepSec)} sleep logged`
      : activity === "diapers" ? `${stats.wet} wet and ${stats.dirty} dirty diapers logged`
        : `${stats.feeds} feeds, ${stats.wet} wet and ${stats.dirty} dirty diapers, ${formatDuration(stats.sleepSec)} sleep logged`;
  const label = loading ? `${rangeName}: loading logged events.` : loadError && unavailable ? `${rangeName}: couldn't load logged events.` : `${rangeName}: ${activitySummary}.`;

  // The usual numbers for her day of life (on a past day, for the age she was then). Off while warnings are off.
  const targets = summary.targets && pastAge ? { ...diaperTargets(pastAge.dayOfLife), feeds: FEEDS_PER_DAY, tummyMin: tummyGoalMinutes(pastAge.days) } : summary.targets;
  const targetDay = pastAge ? pastAge.dayOfLife : summary.age?.dayOfLife ?? null;
  const talliesTitle = rolling ? "Last 24 hours" : isToday ? "The day so far" : formatDayLabel(dayView ?? todayKey, todayKey, { long: true });

  const onTap = (ev: React.MouseEvent<SVGSVGElement>) => {
    if (unavailable) return;
    const svg = svgRef.current;
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const scale = 348 / box.width;
    const x = (ev.clientX - box.left) * scale - 14 - C;
    const y = (ev.clientY - box.top) * scale - 14 - C;
    const r = Math.hypot(x, y);
    if (r < 28 || r > 168) {
      setPop(null);
      return;
    }
    hintDone();
    triggerRef.current = null;
    const deg = (Math.atan2(x, -y) * 180) / Math.PI;
    const tapMin = (((deg + 360) % 360) / 360) * 1440;
    let t: number;
    if (!dayView) {
      const nowMin = (nowDeg / 360) * 1440;
      t = nowMs - (((nowMin - tapMin) % 1440) + 1440) % 1440 * 60_000;
    } else {
      // The wall-clock time on that day, so a DST day's extra or missing hour lands right.
      const d = parseDayKey(dayView);
      t = zonedTimeToUtc(d.year, d.month, d.day, Math.floor(tapMin / 60), Math.floor(tapMin % 60), tz).getTime();
    }
    // In a cluster, on the feed ring or its bracket: the details say so ("Cluster 6:02–8:40 PM · 4 feeds · …"). On the
    // bracket itself (between the feed and sleep rings) it lists the cluster's feeds.
    const fraction = tapMin / 1440;
    const matchingClusters = r >= R.feed - 8 && r <= R.sleep - 6
      ? [...new Map(brackets.filter((b) => clockContains(fraction, b.a0 / 360, (b.a0 + b.span) / 360, 10)).map((b) => [b.c.start, b])).values()] : [];
    const inCluster = matchingClusters.length === 1 ? matchingClusters[0] : undefined;
    if (matchingClusters.length && r >= R.feed + 6) {
      const feeds = [...new Map(matchingClusters.flatMap((b) => b.c.entries).map((entry) => [entry.id, entry])).values()]
        .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
      setPop({ t: matchingClusters[0].s, items: feeds, cluster: inCluster?.c });
      revealDetails();
      return;
    }
    // Hit the same pieces we drew. Reconstructing one UTC instant from the
    // angle would miss the second occurrence of 1 AM when clocks fall back,
    // and an entry's overall start/end would incorrectly include nursing pauses.
    const nearArcs = arcs.filter((a) => clockContains(fraction, a.a0 / 360, a.a0 / 360 + (a.e - a.s) / (24 * 3600_000), a.s === a.e ? TAP_WINDOW_MS / 60_000 : Math.max(0, 6 - (a.e - a.s) / 120_000)));
    const nearDots = dots.filter((d) => clockContains(fraction, d.a / 360, d.a / 360, TAP_WINDOW_MS / 60_000));
    const firstArc = nearArcs[0];
    if (firstArc) t = firstArc.s + Math.max(0, Math.min(firstArc.e - firstArc.s, (fraction - firstArc.a0 / 360) * 24 * 3600_000));
    else if (nearDots[0]) t = nearDots[0].t;
    const near = [...new Map([...nearArcs.map((a) => a.entry), ...nearDots.map((d) => d.entry)].map((entry) => [entry.id, entry])).values()]
      .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
    setPop({ t, items: near, cluster: inCluster?.c });
    revealDetails();
  };

  // Earlier from the last 24 hours or today is yesterday; later from yesterday is today.
  const earlier = addDays(dayView ?? todayKey, -1);
  const canEarlier = earlier >= oldest;
  const canLater = past;
  const step = (dir: -1 | 1) => {
    setPop(null);
    if (dir === -1) {
      if (canEarlier) setChoice(earlier);
    } else if (dayView && canLater) {
      const next = addDays(dayView, 1);
      setChoice(next >= todayKey ? "today" : next);
    }
  };

  const nightStart = (20 / 24) * 360;
  const nightSpan = (11 / 24) * 360;

  // The center readout: the time (or the day), and what the ring covers. The counts are in the tallies below.
  const sub = loading ? "Loading…" : loadError && unavailable ? "Couldn't load" : past ? (pastAge ? `Day ${pastAge.dayOfLife}` : "") : rolling ? "Last 24 hours" : "Since midnight";
  const mainY = sub ? C - 8 : C;


  return (
    <>
      <section aria-label="Day dial" className="mp-day-explorer" aria-busy={loading || history.refreshing}>
        <p id={orientationId} className="sr-only">
          A 24-hour clock: midnight at the top, noon at the bottom. Read clockwise.
        </p>
        {offsetChange !== 0 && <p className={cx(tone.muted, "mx-auto mb-3 max-w-[380px] px-2 text-center text-[13px] leading-snug")}>
          {offsetChange < 0 ? "Some clock times repeat here. Both occurrences share the ring; totals include both." : "The clock skips ahead here. Skipped times stay blank on the ring."}
        </p>}
        <div className="mp-day-scene relative mx-auto w-full max-w-[380px]">
          <svg
            ref={svgRef}
            viewBox="-14 -14 348 348"
            role="img"
            aria-label={label}
            aria-describedby={`${orientationId}${unavailable ? "" : ` ${hintId}`}`}
            onClick={onTap}
            className={cx("block h-auto w-full select-none", !unavailable && "cursor-pointer")}
          >
            <style>{`
              @keyframes maple-dial-dash { to { stroke-dashoffset: -24; } }
              .maple-dial-live { animation: maple-dial-dash 2.4s linear infinite; }
              @media (prefers-reduced-motion: reduce) { .maple-dial-live { animation: none; } }
              .maple-night .maple-dial-live { animation: none; }
            `}</style>
            <defs>
              {/* Night: Right's stripes, across the band wherever it runs round the ring (Left stays solid). */}
              <pattern id={hatchId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="2.4" height="4" fill={NIGHT_COLORS.right} />
              </pattern>
              {/* Back and forth: both side colors in stripes by day; at night a crosshatch (Right's stripes run one way only). */}
              {night ? (
                <pattern id={bothId} width="4.5" height="4.5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="1.7" height="4.5" fill={NIGHT_COLORS.left} />
                  <rect width="4.5" height="1.7" fill={NIGHT_COLORS.left} />
                </pattern>
              ) : (
                <pattern id={bothId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="3" height="6" fill={COLORS.left} />
                  <rect x="3" width="3" height="6" fill={COLORS.right} />
                </pattern>
              )}
            </defs>

            {/* face, with the night hours (8pm–7am) shaded in the paper's own ink */}
            <circle cx={C} cy={C} r={R.night} strokeWidth={1} className="mp-dial-face fill-mp-surface stroke-mp-line" />
            <path d={sectorPath(R.night, nightStart, nightSpan)} className="fill-mp-ink/[0.035] [.maple-night_&]:fill-mp-ink/[0.05]" />
            {/* lanes: the whole ring, or for today only midnight to now */}
            {isToday ? (
              <>
                <path d={arcPath(R.sleep, 0, nowDeg)} fill="none" strokeWidth={16} className="stroke-mp-ink/[0.05]" />
                <path d={arcPath(R.feed, 0, nowDeg)} fill="none" strokeWidth={14} className="stroke-mp-ink/[0.05]" />
                <path d={arcPath(R.diaper, 0, nowDeg)} fill="none" strokeWidth={1} strokeDasharray="1 4" className="stroke-mp-ink/20" />
              </>
            ) : (
              <>
                <circle cx={C} cy={C} r={R.sleep} fill="none" strokeWidth={16} className="stroke-mp-ink/[0.05]" />
                <circle cx={C} cy={C} r={R.feed} fill="none" strokeWidth={14} className="stroke-mp-ink/[0.05]" />
                <circle cx={C} cy={C} r={R.diaper} fill="none" strokeWidth={1} strokeDasharray="1 4" className="stroke-mp-ink/20" />
              </>
            )}
            {/* ticks every 3 hours, labels every 6 */}
            {Array.from({ length: 8 }, (_, i) => {
              const a = i * 45;
              const [x0, y0] = pt(143, a);
              const [x1, y1] = pt(i % 2 ? 147 : 150, a);
              return <line key={i} x1={f(x0)} y1={f(y0)} x2={f(x1)} y2={f(y1)} strokeWidth={1.4} strokeLinecap="round" className="stroke-mp-ink/25" />;
            })}
            {[
              ["Midnight", 0],
              ["6 AM", 90],
              ["Noon", 180],
              ["6 PM", 270],
            ].map(([t, a]) => {
              const [x, y] = pt(R.label, a as number);
              return (
                <text key={t} x={f(x)} y={f(y)} textAnchor={a === 90 ? "end" : a === 270 ? "start" : "middle"} dominantBaseline="central" fontSize="11" fontWeight="500" className="fill-mp-ink-3">
                  {t}
                </text>
              );
            })}

            <g>
              {/* sleep + feeds */}
              {arcs.map((a) => {
                const d = arcPath(a.r, a.a0, a.span);
                if (a.lane === "bottle") {
                  return (
                    <g key={a.key} opacity={a.opacity}>
                      <path d={d} fill="none" stroke={a.color} strokeWidth={a.width} strokeLinecap="round" />
                      <path d={d} fill="none" strokeWidth={a.width - 5} strokeLinecap="round" className="stroke-mp-surface" />
                    </g>
                  );
                }
                // Night's Right is striped, its live part too (the live dashes rest at night anyway); back and forth is
                // striped in both side colors (crosshatched at night), and its live part rests too.
                const patterned = a.hatch || a.both;
                const mark = (
                  <path
                    d={d}
                    fill="none"
                    stroke={a.both ? `url(#${bothId})` : a.hatch ? `url(#${hatchId})` : a.color}
                    strokeWidth={a.width}
                    strokeLinecap="round"
                    strokeDasharray={a.live && !patterned ? "8 4" : undefined}
                    className={a.live && !patterned ? "maple-dial-live" : undefined}
                  />
                );
                // At night Left and Right are one amber, so a 1px gap keeps neighbors apart (and shows between Right's stripes).
                return night && a.lane === "feed" ? (
                  <g key={a.key} opacity={a.opacity}>
                    <path d={d} fill="none" stroke="var(--mp-bg)" strokeWidth={a.width + 2} strokeLinecap="round" />
                    {mark}
                  </g>
                ) : (
                  <g key={a.key} opacity={a.opacity}>
                    {mark}
                  </g>
                );
              })}
              {/* clusters: a thin bracket just outside the feed ring, with a tick at each end */}
              {brackets.map((b, i) => {
                const end = b.a0 + Math.min(b.span, 359.9);
                const tick = (deg: number) => {
                  const [x0, y0] = pt(R.bracket - 3.5, deg);
                  const [x1, y1] = pt(R.bracket + 0.5, deg);
                  return <line x1={f(x0)} y1={f(y0)} x2={f(x1)} y2={f(y1)} strokeWidth={1.4} strokeLinecap="round" className="stroke-mp-ink-3" />;
                };
                return (
                  <g key={`k${i}`} aria-hidden>
                    <path d={arcPath(R.bracket, b.a0, b.span)} fill="none" strokeWidth={1.4} strokeLinecap="round" className="stroke-mp-ink-3" />
                    {tick(b.a0)}
                    {tick(end)}
                  </g>
                );
              })}
              {/*
                diapers, each ringed in the face color so neighbors stay apart: pee an upright drop (never rotated, a
                drop points up), poop a dot in its stool color, both a dot with a small drop at its shoulder. At night
                the drop is hollow and the dot solid amber, so shape alone tells them apart.
              */}
              {dots.map((d) => {
                const [x, y] = pt(R.diaper, d.a);
                // A drop h units tall centred on (dx, dy); the halo is in dial units whatever the scale.
                const drop = (dx: number, dy: number, h: number, halo: number) => {
                  const k = h / 18;
                  return (
                    <path
                      d={DROPLET_PATH}
                      transform={`translate(${f(dx - 12 * k)} ${f(dy - 12.7 * k)}) scale(${f(k)})`}
                      fill={night ? undefined : pal.pee}
                      stroke={night ? pal.pee : undefined}
                      strokeWidth={f(halo / k)}
                      strokeLinejoin="round"
                      className={night ? "fill-mp-surface" : "stroke-mp-surface"}
                    />
                  );
                };
                return (
                  <g key={d.key} opacity={d.opacity}>
                    {d.poop && (
                      <circle
                        cx={f(x)}
                        cy={f(d.pee ? y + 1.5 : y)}
                        r={d.pee ? 5 : 5.5}
                        fill={d.color ?? undefined}
                        strokeWidth="1"
                        className={cx(
                          // One stroke class per case (two same-property utilities would fight on class order): meconium
                          // on the dark face, chalky or pale on the white one, get a faint ring so they don't vanish.
                          d.edge === "light" ? "stroke-mp-ink/30 dark:stroke-mp-surface" : "stroke-mp-surface",
                          !d.color && "fill-mp-ink-3",
                          d.edge === "dark" && "dark:stroke-[rgb(236_231_220/0.35)]"
                        )}
                      />
                    )}
                    {d.pee && (d.poop ? drop(x + 4.5, y - 4, 9, night ? 1.4 : 1.6) : drop(x, y, 13, night ? 1.5 : 1))}
                  </g>
                );
              })}
            </g>

            {/* now hand (whenever the ring reaches now) */}
            {showHand && (
              <g>
                <line x1={C} y1={C} x2={f(pt(156, nowDeg)[0])} y2={f(pt(156, nowDeg)[1])} strokeWidth={0.8} className="stroke-mp-ink/25" />
                <line
                  x1={f(pt(R.handIn, nowDeg)[0])}
                  y1={f(pt(R.handIn, nowDeg)[1])}
                  x2={f(pt(R.handOut - 8, nowDeg)[0])}
                  y2={f(pt(R.handOut - 8, nowDeg)[1])}
                  stroke={COLORS.hand}
                  strokeWidth={2.6}
                  strokeLinecap="round"
                />
                <path d={MAPLE_LEAF_PATH} transform={`translate(${f(pt(R.handOut - 2, nowDeg)[0])} ${f(pt(R.handOut - 2, nowDeg)[1])}) rotate(${f(nowDeg)}) scale(0.62)`} fill={COLORS.hand} />
              </g>
            )}

            {/* center */}
            <circle cx={C} cy={C} r={66} className="mp-dial-center fill-mp-surface" />
            <text
              x={C}
              y={mainY}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={past ? 18 : 28}
              fontWeight="600"
              letterSpacing="-0.02em"
              className="fill-mp-ink tabular-nums"
            >
              {past && dayView ? formatDayLabel(dayView, todayKey) : formatTime(nowMs, tz)}
            </text>
            {sub && (
              <text
                x={C}
                y={C + 17}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={past && !unavailable ? 13 : 11}
                fontWeight={past && !unavailable ? 600 : 500}
                className={past && !unavailable ? "fill-mp-maple [.maple-night_&]:fill-mp-ink-2" : "fill-mp-ink-3"}
              >
                {sub}
              </text>
            )}
          </svg>

        </div>

        {/* Shown until the first tap on this device; screen readers always have it. */}
        {!unavailable && <p id={hintId} className={hint ? cx(tone.faint, "mt-1 text-center text-[13px]") : "sr-only"}>
          Tap the ring to see what happened
        </p>}

        {loadError && (
          <div className={cx(tone.inset, "mx-auto mt-3 flex max-w-[380px] items-center gap-3 px-3 py-2")} role="status">
            <p className={cx(tone.muted, "flex-1 text-[13px] leading-snug")}>{history.loaded ? "Couldn't update this day. Showing the last loaded entries." : "Couldn't load this day's log."}</p>
            <Button size="sm" variant="soft" onClick={history.reload}>Try again</Button>
          </div>
        )}
        {history.refreshing && <p role="status" className={cx(tone.muted, "mt-3 text-center text-[13px]")}>Updating this day…</p>}
        {needsFetch && history.partialDays.length > 0 && <p role="status" className={cx(tone.muted, "mt-3 px-3 text-center text-[13px]")}>Some entries could not be loaded. Totals for this day may be incomplete.</p>}

        <p className={cx(tone.muted, "mt-3 px-2 text-center text-[12px] leading-relaxed")}>
          {activity === "sleep" ? "Sleep · outer ring" : activity === "feeds" ? "Feeds · middle ring" : activity === "diapers" ? "Diapers · inner ring" : "Sleep outside · Feeds in the middle · Diapers inside"}
        </p>
        <Legend pal={pal} night={night} nursing={(activity === "all" || activity === "feeds") && (logSwitches(state.baby).nursing || arcs.some((a) => a.lane === "feed"))} both={arcs.some((a) => a.both)} cluster={brackets.length > 0} bottle={arcs.some((a) => a.lane === "bottle")} activity={activity} />

        {/* One range for the dial and the tallies under it. */}
        <div className="mt-4 flex items-center justify-center gap-1">
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={!canEarlier}
            aria-label="Earlier day"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-mp-ink-2 transition active:bg-mp-ink/5 disabled:opacity-30"
          >
            <Icon name="chevron-left" size={22} />
          </button>
          <Segmented
            aria-label="Which day"
            // On a 320px screen (an SE with Display Zoom) three options only fit a little tighter, as "24h".
            className="max-w-[284px] min-w-0 flex-1 max-[359px]:[&>button]:px-2"
            value={view}
            onChange={(v) => {
              setPop(null);
              setChoice(v);
            }}
            options={[
              {
                value: "rolling",
                label: (
                  <>
                    <span className="max-[359px]:hidden">Last </span>24h
                  </>
                ),
              },
              { value: "today", label: "Today" },
              { value: yesterday, label: "Yesterday" },
            ]}
          />
          <button
            type="button"
            onClick={() => step(1)}
            disabled={!canLater}
            aria-label="Later day"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-mp-ink-2 transition active:bg-mp-ink/5 disabled:opacity-30"
          >
            <Icon name="chevron-right" size={22} />
          </button>
        </div>

        {!unavailable && <>
          <p className="mp-dial-summary" role="status">{activitySummary}.
            {stats.breastFeeds === 0 && arcs.some((arc) => arc.lane === "feed") && <span>Nursing continued from earlier. Feeds count in the window where they started.</span>}
            <span>Missing entries are not counted.</span>
          </p>

          <AnimatePresence initial={false}>
            {pop && (
              <motion.div
                id={detailId}
                ref={detailRef}
                role="region"
                aria-label="Selected log entries"
                tabIndex={-1}
                onFocusCapture={(event) => { detailFocusRef.current = event.target as HTMLElement; }}
                onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) detailFocusRef.current = null; }}
                onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closeDetails(); } }}
                initial={night || reduceMotion ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: night || reduceMotion ? 1 : 0 }}
                transition={{ duration: night || reduceMotion ? 0 : 0.18 }}
                className="mp-dial-details"
              >
                <div className="flex items-center justify-between gap-2 pl-4">
                  <h3 className={cx(tone.heading, "min-w-0 py-2 text-[14px] leading-snug")}>{selectedCluster ? clusterLine(selectedCluster, tz) : `Around ${formatTime(pop.t, tz)}`}</h3>
                  <button type="button" onClick={closeDetails} aria-label="Close event details" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-mp-ink-2">
                    <Icon name="x" size={18} />
                  </button>
                </div>
                {selectedItems.length ? (
                  <div className={cx(tone.divide, "max-h-[320px] overflow-y-auto overscroll-contain border-t border-mp-line")}>
                    {selectedItems.map((entry) => {
                      const description = describeEntry(entry, { units, now, words });
                      return (
                        <div key={entry.id} className="flex items-start gap-2.5 px-4 py-3">
                          <KindBadge entry={entry} size={30} />
                          <div className="min-w-0 flex-1">
                            <p className={cx(tone.heading, "text-[15px] leading-snug")}>{description.title}</p>
                            {description.detail && <p className={cx(tone.muted, "mt-0.5 text-[13px] leading-relaxed")}>{description.detail}</p>}
                            <p className={cx(tone.muted, "mt-1 text-[12px] tabular-nums")}>{formatTime(entry.started_at, tz)}</p>
                            {!readOnly && <button type="button" onClick={(event) => { editOpenerRef.current = event.currentTarget; open({ kind: entry.kind, entry }); }} aria-label={`Edit ${description.title.toLowerCase()} at ${formatTime(entry.started_at, tz)}`} className="-ml-2 mt-1 inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 text-[13px] font-semibold text-mp-accent-fg">Edit entry <Icon name="pencil" size={13} /></button>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : <p className={cx(tone.muted, "px-4 pb-4 text-sm")}>{pop.items.length ? "This entry is no longer in this view." : "Nothing logged around then."}</p>}
              </motion.div>
            )}
          </AnimatePresence>

          <details className="mp-dial-log">
            <summary ref={browseRef}><span>Browse logged entries</span><span className="tabular-nums">{plotted.length}</span></summary>
            {brackets.length > 0 && <ul className={cx(tone.muted, "space-y-1 px-3 pb-2 text-[12px]")}>{[...new Map(brackets.map(({ c }) => [c.start, c])).values()].map((cluster) => <li key={cluster.start}>{clusterLine(cluster, tz)}</li>)}</ul>}
            {plotted.length ? <div className={cx(tone.divide, "max-h-[280px] overflow-y-auto overscroll-contain")}>
              {[...plotted].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at)).map((entry) => {
                const description = describeEntry(entry, { units, now, words });
                return <button
                  key={entry.id}
                  type="button"
                  aria-label={`${formatTime(entry.started_at, tz)}: ${description.text}`}
                  aria-controls={pop ? detailId : undefined}
                  aria-pressed={pop?.items.some((item) => item.id === entry.id) ?? false}
                  onClick={(event) => {
                    triggerRef.current = event.currentTarget;
                    hintDone();
                    setPop({ t: Date.parse(entry.started_at), items: [entry] });
                    requestAnimationFrame(() => detailRef.current?.focus());
                  }}
                  className="mp-dial-log-entry"
                >
                  <KindBadge entry={entry} size={26} />
                  <span className="min-w-0 flex-1 text-left"><span className="block truncate text-[14px] font-medium">{description.title}</span>{description.detail && <span className="block truncate text-[12px] text-mp-ink-2">{description.detail}</span>}</span>
                  <span className="shrink-0 text-[12px] tabular-nums text-mp-ink-2">{formatTime(entry.started_at, tz)}</span>
                </button>;
              })}
            </div> : <p className={cx(tone.muted, "px-3 pb-3 text-[13px]")}>No {activity === "all" ? "feeds, sleep or diapers" : activity} logged in this window.</p>}
          </details>
        </>}
      </section>

      {!unavailable && <Tallies stats={stats} title={activity === "all" ? talliesTitle : `All activity · ${talliesTitle}`} targets={targets} targetDay={targetDay} />}
    </>
  );
}

/** The stool colors the Poop key shows: plotted poops wear their own color, so the key does too. */
const LEGEND_STOOLS = [STOOL_COLOR_INFO.black.hex, STOOL_COLOR_INFO.green.hex, STOOL_COLOR_INFO.mustard.hex];

/**
 * What the marks mean: each swatch drawn in its mark's shape, in every mode (amber, by strength and shape, at night).
 * Back and forth, the cluster bracket and bottles join the key only when the dial shows them (a family with
 * Bottles off never sees a Bottle key).
 */
function Legend({ pal, night, nursing, both, cluster, bottle, activity }: { pal: Palette; night: boolean; nursing: boolean; both?: boolean; cluster?: boolean; bottle?: boolean; activity: PatternActivity }) {
  const dot = "h-[7px] w-[7px] rounded-full";
  // Sleep, and the sides at night, are short bands as on the ring (Right striped); a bottle is a hollow pill.
  const band = "h-2 w-4 rounded-full";
  const items: { label: string; mark: React.ReactNode }[] = [
    ...(nursing
      ? [
          { label: "Left", mark: <i className={cx("shrink-0", night ? band : dot)} style={{ backgroundColor: pal.left }} /> },
          {
            label: "Right",
            mark: night ? (
              <i className={cx("shrink-0", band)} style={{ backgroundImage: `repeating-linear-gradient(135deg, ${pal.right} 0 1.7px, transparent 1.7px 2.8px)` }} />
            ) : (
              <i className={cx("shrink-0", dot)} style={{ backgroundColor: pal.right }} />
            ),
          },
        ]
      : []),
    ...(both
      ? [
          {
            label: "Both sides",
            mark: (
              <i
                className={cx("shrink-0", band)}
                style={{
                  backgroundImage: night
                    ? `repeating-linear-gradient(45deg, ${pal.left} 0 1.2px, transparent 1.2px 3px), repeating-linear-gradient(135deg, ${pal.left} 0 1.2px, transparent 1.2px 3px)`
                    : `repeating-linear-gradient(135deg, ${pal.left} 0 2px, ${pal.right} 2px 4px)`,
                }}
              />
            ),
          },
        ]
      : []),
    ...(cluster
      ? [
          {
            label: "Cluster",
            mark: (
              <svg viewBox="0 0 16 8" width={16} height={8} className="shrink-0 text-mp-ink-3">
                <path d="M1.5 7 V2.5 H14.5 V7" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ),
          },
        ]
      : []),
    ...(bottle ? [{ label: "Bottle", mark: <i className={cx("shrink-0 border-2", band)} style={{ borderColor: pal.bottleEdge }} /> }] : []),
    { label: "Sleep", mark: <i className={cx("shrink-0", band)} style={{ backgroundColor: pal.sleep }} /> },
    {
      label: "Pee",
      mark: (
        <svg viewBox="0 0 24 24" width={10} height={12} className="shrink-0">
          <path d={DROPLET_PATH} fill={night ? "none" : pal.pee} stroke={night ? pal.pee : "none"} strokeWidth={3} strokeLinejoin="round" />
        </svg>
      ),
    },
    {
      label: "Poop",
      mark: night ? (
        <i className={cx("shrink-0", dot)} style={{ backgroundColor: pal.poop }} />
      ) : (
        <span className="inline-flex shrink-0">
          {LEGEND_STOOLS.map((c, i) => (
            // Each overlaps the last, parted by a hairline of the page.
            // The black one gets the dial's faint light ring in dark mode, or it vanishes on the page.
            <i
              key={c}
              className={cx(dot, i > 0 && "-ml-[3px]", i === 0 && "dark:shadow-[0_0_0_1px_rgb(236_231_220/0.35)]")}
              style={{ backgroundColor: c, boxShadow: i > 0 ? "0 0 0 1px var(--mp-bg)" : undefined }}
            />
          ))}
        </span>
      ),
    },
  ];
  return (
    <div className={cx(tone.faint, "mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1 px-2 text-[11px]")} aria-hidden>
      {items.filter((it) => activity === "all" || (it.label === "Sleep" ? activity === "sleep" : it.label === "Pee" || it.label === "Poop" ? activity === "diapers" : activity === "feeds")).map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          {it.mark}
          {it.label}
        </span>
      ))}
    </div>
  );
}
