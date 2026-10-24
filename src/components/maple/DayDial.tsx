"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { describeEntry } from "@/lib/maple/describe";
import { diaperTargets, FEEDS_PER_DAY, STOOL_COLOR_INFO, tummyGoalMinutes } from "@/lib/maple/guidelines";
import { statsFor } from "@/lib/maple/insights";
import { addDays, babyAge, dayBounds, dayKey, DEFAULT_TZ, formatDayLabel, formatDuration, formatTime, localParts, parseDayKey, zonedTimeToUtc } from "@/lib/maple/time";
import type { Entry, FeedData } from "@/lib/maple/types";
import { useClockMinute } from "./FeedParts";
import { MAPLE_LEAF_PATH } from "./Hero";
import { Icon, KindBadge } from "./icons";
import { useNightActive } from "./nightLook";
import { useSheets } from "./sheets";
import { Tallies } from "./StatusCard";
import { Segmented, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

/**
 * The Day Dial: a 24-hour clock face (midnight at the top, clockwise). It's
 * Today's hero, so it sits on the page without a card or a title. Sleep is the
 * outer ring, feeds the middle (rust = left, honey = right, a hollow gold pill
 * = bottle), diapers are dots (pee dew-blue, poop in its logged color). Tap
 * anywhere on the ring to see what happened around then and edit it.
 *
 * One range control drives both the dial and the tallies under it ("The day so
 * far"): the last 24 hours ending now (at 3am that's last night and yesterday
 * evening, not an empty dial; older marks fade), today from midnight to now,
 * yesterday, or an older day with the arrows.
 *
 * By day and in dark mode the marks keep their kind colors. At night they fold
 * into the amber, told apart by lane, strength and shape (a hollow ring for
 * pee and bottles), with a soft amber glow; the legend follows.
 */

const C = 160;
const R = { night: 150, label: 161, sleep: 132, feed: 110, diaper: 88, handIn: 68, handOut: 150 };
const COLORS = {
  sleep: "#B8A9C9",
  left: "#B5452B",
  right: "#E0A93B",
  // The bottle pill is hollow: its inside is the face color (stroke-mp-surface), so it never glares white at night.
  bottleEdge: "#C49A3C",
  pee: "#7FA7B5",
  poop: "#8B5A2B",
  hand: "#D9772B",
};
type Palette = typeof COLORS;
const amber = (a: number) => `rgb(224 169 59 / ${a})`;
/** The night look: every kind in the amber, strongest where it matters most (the left side, the diapers). */
const NIGHT_COLORS: Palette = {
  sleep: amber(0.35),
  left: amber(0.85),
  right: amber(0.55),
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
  s: number;
  e: number;
};
type Dot = { key: string; entry: Entry; a: number; pee: boolean; poop: boolean; color: string; opacity: number; t: number };

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
  const p = localParts(t, tz);
  return ((p.hour * 60 + p.minute + p.second / 60) / 1440) * 360;
}

function buildMarks(entries: Entry[], lo: number, hi: number, nowMs: number, tz: string, fade: boolean, pal: Palette, night: boolean) {
  const arcs: Arc[] = [];
  const dots: Dot[] = [];
  const opacityAt = (t: number) => (fade ? Math.max(0.4, 1 - 0.6 * ((nowMs - t) / 3600_000 / 24)) : 1);
  const addArc = (entry: Entry, key: string, lane: Arc["lane"], s0: number, e0: number, r: number, color: string, width: number, live: boolean) => {
    const s = Math.max(s0, lo);
    const e = Math.min(e0, hi);
    if (e < s || s0 > hi || e0 < lo) return;
    const span = Math.max(MIN_ARC_DEG, (e - s) / 60_000 / 4);
    arcs.push({ key, entry, lane, r, a0: clockDeg(s, tz), span, color, width, opacity: opacityAt(e), live, s: s0, e: e0 });
  };

  for (const entry of entries) {
    const start = Date.parse(entry.started_at);
    const end = entry.ended_at ? Date.parse(entry.ended_at) : entry.active ? nowMs : start;
    if (entry.kind === "sleep") {
      addArc(entry, `s${entry.id}`, "sleep", start, end, R.sleep, pal.sleep, 16, entry.active);
    } else if (entry.kind === "feed") {
      const d = entry.data as FeedData;
      if (d.method === "bottle") {
        addArc(entry, `b${entry.id}`, "bottle", start, Math.max(end, start), R.feed, pal.bottleEdge, 14, false);
      } else if (d.segments?.length) {
        d.segments.forEach((seg, i) => {
          const s = Date.parse(seg.start);
          const e = seg.end ? Date.parse(seg.end) : entry.active ? nowMs : s;
          addArc(entry, `f${entry.id}-${i}`, "feed", s, e, R.feed, seg.side === "L" ? pal.left : pal.right, 14, entry.active && !seg.end);
        });
      } else {
        // A feed logged by minutes: first side, then the other.
        const first = d.first_side ?? (d.left_sec ? "L" : "R");
        const a = (first === "L" ? d.left_sec : d.right_sec) ?? 0;
        const b = (first === "L" ? d.right_sec : d.left_sec) ?? 0;
        const col = (side: string) => (side === "L" ? pal.left : pal.right);
        addArc(entry, `f${entry.id}-a`, "feed", start, start + a * 1000, R.feed, col(first), 14, false);
        if (b > 0) addArc(entry, `f${entry.id}-b`, "feed", start + a * 1000, start + (a + b) * 1000, R.feed, col(first === "L" ? "R" : "L"), 14, false);
      }
    } else if (entry.kind === "diaper") {
      if (start < lo || start > hi) continue;
      // At night every poop is the same amber: the stool color is in the popover and the entry.
      const color = entry.data.poop ? (night ? pal.poop : entry.data.color ? STOOL_COLOR_INFO[entry.data.color].hex : pal.poop) : pal.pee;
      dots.push({ key: `d${entry.id}`, entry, a: clockDeg(start, tz), pee: entry.data.pee, poop: entry.data.poop, color, opacity: opacityAt(start), t: start });
    }
  }
  // Long arcs first so short ones (and live ones) draw on top.
  arcs.sort((x, y) => Number(x.live) - Number(y.live) || y.span - x.span);
  return { arcs, dots };
}

export default function DayDial() {
  const { state, summary, api, units, readOnly } = useMaple();
  const { open } = useSheets();
  // On the clock minute, so a running feed's minutes in the list flip with the card's and the Timeline's.
  const now = useClockMinute();
  const night = useNightActive();
  const uid = useId().replace(/[^\w-]/g, "");
  const glowId = `maple-dial-glow-${uid}`;
  const hintId = `maple-dial-hint-${uid}`;
  const [choice, setChoice] = useState<View | null>(null);
  const [fetched, setFetched] = useState<{ key: string; entries: Entry[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [pop, setPop] = useState<{ x: number; y: number; w: number; t: number; items: Entry[] } | null>(null);
  const [hint, setHint] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!needsFetch || !dayView || fetched?.key === dayView) return;
    let cancelled = false;
    setLoading(true);
    api<{ entries: Entry[] }>(`entries?from=${dayView}&to=${dayView}`)
      .then((r) => !cancelled && setFetched({ key: dayView, entries: r.entries }))
      .catch(() => !cancelled && setFetched({ key: dayView, entries: [] }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [api, dayView, fetched?.key, needsFetch]);

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

  // The popover closes with Escape or a tap anywhere outside the dial.
  const popOpen = !!pop;
  useEffect(() => {
    if (!popOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPop(null);
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setPop(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [popOpen]);

  const nowMs = now.getTime();
  const [lo, hi] = useMemo(() => {
    // A little slack past "now": the dial's clock ticks every 30s, and a diaper logged a second ago belongs on it.
    if (!dayView) return [nowMs - 24 * 3600_000, nowMs + 5 * 60_000];
    // DST-safe local midnights; today runs to now, a past day to its end.
    const [a, b] = dayBounds(dayView, tz);
    return [a.getTime(), Math.min(b.getTime(), nowMs + 5 * 60_000)];
  }, [dayView, nowMs, tz]);

  const source = useMemo(() => {
    if (!state) return [];
    if (!needsFetch) return state.entries;
    return fetched?.key === dayView ? fetched.entries : [];
  }, [dayView, fetched, needsFetch, state]);

  const pal = night ? NIGHT_COLORS : COLORS;
  const { arcs, dots } = useMemo(() => buildMarks(source, lo, hi, nowMs, tz, rolling, pal, night), [source, lo, hi, nowMs, tz, rolling, pal, night]);
  // One set of numbers for the dial's label and the tallies below, from the same entries and window.
  const stats = useMemo(() => statsFor(source, new Date(lo), new Date(hi + 1), dayView ?? "last24h", now), [source, lo, hi, dayView, now]);

  if (!state || !summary) return null;

  const showHand = rolling || isToday;
  const nowDeg = clockDeg(nowMs, tz);
  // Her day of life on a past day (today's is in the header).
  const pastAge = past && state.baby.born_at ? babyAge(state.baby.born_at, new Date(hi), tz) : null;
  const plotted = [...arcs.map((a) => a.entry), ...dots.map((d) => d.entry)].filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i);
  const rangeName = rolling ? "Last 24 hours" : formatDayLabel(dayView ?? todayKey, todayKey, { long: true });
  const label = `${rangeName}: ${stats.feeds} feeds, ${stats.wet} wet and ${stats.dirty} dirty diapers, ${formatDuration(stats.sleepSec)} asleep.`;

  // The usual numbers for her day of life (on a past day, for the age she was then). Off while warnings are off.
  const targets = summary.targets && pastAge ? { ...diaperTargets(pastAge.dayOfLife), feeds: FEEDS_PER_DAY, tummyMin: tummyGoalMinutes(pastAge.days) } : summary.targets;
  const targetDay = pastAge ? pastAge.dayOfLife : summary.age?.dayOfLife ?? null;
  const talliesTitle = rolling ? "Last 24 hours" : isToday ? "The day so far" : formatDayLabel(dayView ?? todayKey, todayKey, { long: true });

  const onTap = (ev: React.MouseEvent<SVGSVGElement>) => {
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
    const near = plotted
      .filter((e) => {
        const s = Date.parse(e.started_at);
        const end = e.ended_at ? Date.parse(e.ended_at) : e.active ? nowMs : s;
        return t >= s - TAP_WINDOW_MS && t <= end + TAP_WINDOW_MS;
      })
      .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
      .slice(0, 6);
    setPop({ x: ev.clientX - box.left, y: ev.clientY - box.top, w: box.width, t, items: near });
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
  const stars: [number, number][] = [
    [304, 145],
    [322, 146],
    [341, 144],
    [6, 146],
    [32, 145],
    [70, 144],
  ];

  // The center readout: the time (or the day), and what the ring covers. The counts are in the tallies below.
  const sub = loading ? "Loading…" : past ? (pastAge ? `Day ${pastAge.dayOfLife}` : "") : rolling ? "Last 24 hours" : "Since midnight";
  const mainY = sub ? C - 8 : C;
  // Wide enough for a title and its detail, never wider than the dial.
  const popW = pop ? Math.min(296, pop.w) : 0;

  return (
    <>
      <section aria-label="Day dial" className="pt-2">
        <div ref={boxRef} className="relative mx-auto w-full max-w-[380px]">
          <svg
            ref={svgRef}
            viewBox="-14 -14 348 348"
            role="img"
            aria-label={label}
            aria-describedby={hintId}
            onClick={onTap}
            className="block h-auto w-full cursor-pointer select-none"
          >
            <style>{`
              @keyframes maple-dial-dash { to { stroke-dashoffset: -24; } }
              .maple-dial-live { animation: maple-dial-dash 2.4s linear infinite; }
              @media (prefers-reduced-motion: reduce) { .maple-dial-live { animation: none; } }
              .maple-night .maple-dial-live { animation: none; }
            `}</style>
            <defs>
              {/* Night only: the marks carry a soft amber glow, the one place anything glows. */}
              <filter id={glowId} x="-10%" y="-10%" width="120%" height="120%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="2.5" result="blur" />
                <feFlood floodColor="#E0A93B" floodOpacity="0.4" />
                <feComposite in2="blur" operator="in" result="glow" />
                <feMerge>
                  <feMergeNode in="glow" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* face, with the night hours (8pm–7am) shaded */}
            <circle cx={C} cy={C} r={R.night} strokeWidth={1} className="fill-mp-surface stroke-mp-line" />
            <path d={sectorPath(R.night, nightStart, nightSpan)} className="fill-[#4B4F8F]/[0.07] dark:fill-[#9AA0E0]/[0.07] [.maple-night_&]:fill-mp-ink/[0.05]" />
            {stars.map(([a, r], i) => {
              const [x, y] = pt(r, a);
              return (
                <path
                  key={i}
                  d={`M${f(x)},${f(y - 2.2)} L${f(x + 0.6)},${f(y - 0.6)} L${f(x + 2.2)},${f(y)} L${f(x + 0.6)},${f(y + 0.6)} L${f(x)},${f(y + 2.2)} L${f(x - 0.6)},${f(y + 0.6)} L${f(x - 2.2)},${f(y)} L${f(x - 0.6)},${f(y - 0.6)} Z`}
                  className="fill-[#8C86C0] dark:fill-[#C8C2F0] [.maple-night_&]:fill-mp-ink-3"
                  opacity={0.7}
                />
              );
            })}
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
              ["12a", 0],
              ["6a", 90],
              ["12p", 180],
              ["6p", 270],
            ].map(([t, a]) => {
              const [x, y] = pt(R.label, a as number);
              return (
                <text key={t} x={f(x)} y={f(y)} textAnchor="middle" dominantBaseline="central" fontSize="11" fontWeight="500" className="fill-mp-ink-3">
                  {t}
                </text>
              );
            })}

            <g filter={night ? `url(#${glowId})` : undefined}>
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
                const mark = (
                  <path
                    d={d}
                    fill="none"
                    stroke={a.color}
                    strokeWidth={a.width}
                    strokeLinecap="round"
                    strokeDasharray={a.live ? "8 4" : undefined}
                    className={a.live ? "maple-dial-live" : undefined}
                  />
                );
                // At night Left and Right differ only in strength, so a 1px gap keeps neighbors apart.
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
              {/* diapers, each ringed in the face color so neighbors stay apart */}
              {dots.map((d) => {
                const [x, y] = pt(R.diaper, d.a);
                if (night) {
                  // Pee is a hollow ring, poop a filled dot; both is a ring half filled.
                  return (
                    <g key={d.key} opacity={d.opacity} transform={`translate(${f(x)} ${f(y)}) rotate(${f(d.a)})`}>
                      {d.pee && <circle r="4.75" stroke={pal.pee} strokeWidth="1.5" className="fill-mp-surface" />}
                      {d.poop &&
                        (d.pee ? (
                          <path d="M0,-5.5 A5.5,5.5 0 0 1 0,5.5 Z" fill={d.color} />
                        ) : (
                          <circle r="5.5" fill={d.color} strokeWidth="1" className="stroke-mp-surface" />
                        ))}
                    </g>
                  );
                }
                if (d.pee && d.poop) {
                  return (
                    <g key={d.key} opacity={d.opacity} transform={`translate(${f(x)} ${f(y)}) rotate(${f(d.a)})`}>
                      <path d="M0,-5.5 A5.5,5.5 0 0 0 0,5.5 Z" fill={pal.pee} />
                      <path d="M0,-5.5 A5.5,5.5 0 0 1 0,5.5 Z" fill={d.color} />
                      <circle r="5.5" fill="none" strokeWidth="1" className="stroke-mp-surface" />
                    </g>
                  );
                }
                return <circle key={d.key} cx={f(x)} cy={f(y)} r={5.5} fill={d.color} opacity={d.opacity} strokeWidth="1" className="stroke-mp-surface" />;
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
            <circle cx={C} cy={C} r={66} className="fill-mp-surface" />
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
                fontSize={past && !loading ? 13 : 11}
                fontWeight={past && !loading ? 600 : 500}
                className={past && !loading ? "fill-mp-maple" : "fill-mp-ink-3"}
              >
                {sub}
              </text>
            )}
          </svg>

          <AnimatePresence>
            {pop && (
              <motion.div
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="absolute z-10 overflow-hidden rounded-2xl border border-mp-line bg-mp-surface shadow-[0_10px_30px_rgba(0,0,0,0.16)] [.maple-night_&]:shadow-none"
                style={{
                  width: popW,
                  left: Math.max(0, Math.min(pop.x - popW / 2, pop.w - popW)),
                  top: pop.y > pop.w * 0.55 ? pop.y - 12 : pop.y + 12,
                  y: pop.y > pop.w * 0.55 ? "-100%" : 0,
                }}
              >
                <div className="flex items-center justify-between pl-3.5">
                  <p className={tone.label}>Around {formatTime(pop.t, tz)}</p>
                  <button type="button" onClick={() => setPop(null)} aria-label="Close" className="flex h-11 w-11 items-center justify-center text-mp-ink-3">
                    <Icon name="x" size={18} />
                  </button>
                </div>
                {pop.items.length ? (
                  <div className={cx(tone.divide, "border-t border-mp-line")}>
                    {pop.items.map((e) => {
                      const d = describeEntry(e, { units, now });
                      return (
                        <button
                          key={e.id}
                          type="button"
                          disabled={readOnly}
                          onClick={() => {
                            setPop(null);
                            open({ kind: e.kind, entry: e });
                          }}
                          className="flex min-h-[52px] w-full items-center gap-2.5 px-3.5 py-2 text-left transition enabled:active:bg-mp-ink/[0.04]"
                        >
                          <KindBadge entry={e} size={30} />
                          <span className="min-w-0 flex-1">
                            <span className={cx(tone.body, "block truncate text-[15px] font-medium")}>{d.title}</span>
                            {d.detail && <span className={cx(tone.muted, "block truncate text-[13px]")}>{d.detail}</span>}
                          </span>
                          <span className={cx(tone.muted, "shrink-0 text-[13px] tabular-nums")}>{formatTime(e.started_at, tz)}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className={cx(tone.muted, "px-3.5 pb-3.5 text-sm")}>Nothing logged around then.</p>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Shown until the first tap on this device; screen readers always have it. */}
        <p id={hintId} className={hint ? cx(tone.faint, "mt-1 text-center text-[13px]") : "sr-only"}>
          Tap the ring to see what happened
        </p>

        <ul className="sr-only">
          {plotted.map((e) => (
            <li key={e.id}>
              {formatTime(e.started_at, tz)}: {describeEntry(e, { units, now }).text}
            </li>
          ))}
        </ul>

        <Legend pal={pal} night={night} />

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
      </section>

      <Tallies stats={stats} title={talliesTitle} targets={targets} targetDay={targetDay} loading={loading} />
    </>
  );
}

/** What the marks mean: small swatches drawn like the marks themselves (amber, by strength and shape, at night). */
function Legend({ pal, night }: { pal: Palette; night: boolean }) {
  const dot = "h-[7px] w-[7px]";
  const ring = (color: string, width: string): { style: React.CSSProperties; className: string } => ({ style: { borderColor: color }, className: cx("h-2 w-2", width) });
  const items: { label: string; style: React.CSSProperties; className: string }[] = [
    { label: "Left", style: { backgroundColor: pal.left }, className: dot },
    { label: "Right", style: { backgroundColor: pal.right }, className: dot },
    { label: "Bottle", ...ring(pal.bottleEdge, "border-2") },
    { label: "Sleep", style: { backgroundColor: pal.sleep }, className: dot },
    { label: "Pee", ...(night ? ring(pal.pee, "border-[1.5px]") : { style: { backgroundColor: pal.pee }, className: dot }) },
    { label: "Poop", style: { backgroundColor: pal.poop }, className: dot },
  ];
  return (
    <div className={cx(tone.faint, "mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1 px-2 text-[11px]")} aria-hidden>
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <i className={cx("shrink-0 rounded-full", it.className)} style={it.style} />
          {it.label}
        </span>
      ))}
    </div>
  );
}
