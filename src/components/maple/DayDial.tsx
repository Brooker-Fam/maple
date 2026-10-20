"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { describeEntry, entryEmoji } from "@/lib/maple/describe";
import { STOOL_COLOR_INFO } from "@/lib/maple/guidelines";
import { statsFor } from "@/lib/maple/insights";
import { addDays, babyAge, dayBounds, dayKey, DEFAULT_TZ, formatDayLabel, formatDuration, formatTime, localParts } from "@/lib/maple/time";
import type { Entry, FeedData } from "@/lib/maple/types";
import { MAPLE_LEAF_PATH } from "./Hero";
import { useSheets } from "./sheets";
import { cx, tone } from "./ui";
import { useMaple, useNow } from "./useMaple";

/**
 * The Day Dial: a 24-hour clock face (midnight at the top, clockwise) showing
 * the last 24 hours ending now, so at 3am you see last night and yesterday
 * evening instead of an empty dial. Sleep is the outer ring, feeds the middle
 * (rust = left, honey = right, cream = bottle), diapers are dots (pee dew-blue,
 * poop in its logged color). Older marks fade. Tap anywhere on the ring to see
 * what happened around then and edit it.
 */

const C = 160;
const R = { night: 150, label: 161, sleep: 132, feed: 110, diaper: 88, handIn: 68, handOut: 150 };
const COLORS = {
  sleep: "#B8A9C9",
  left: "#B5452B",
  right: "#E0A93B",
  bottleFill: "#FDF8F0",
  bottleEdge: "#C49A3C",
  pee: "#7FA7B5",
  poop: "#8B5A2B",
  hand: "#D9772B",
};
const MIN_ARC_DEG = 3;
const TAP_WINDOW_MS = 20 * 60_000;

type View = "rolling" | string;

type Arc = { key: string; entry: Entry; r: number; a0: number; span: number; color: string; width: number; opacity: number; live: boolean; bottle?: boolean; s: number; e: number };
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

function buildMarks(entries: Entry[], lo: number, hi: number, nowMs: number, tz: string, fade: boolean) {
  const arcs: Arc[] = [];
  const dots: Dot[] = [];
  const opacityAt = (t: number) => (fade ? Math.max(0.4, 1 - 0.6 * ((nowMs - t) / 3600_000 / 24)) : 1);
  const addArc = (entry: Entry, key: string, s0: number, e0: number, r: number, color: string, width: number, live: boolean, bottle?: boolean) => {
    const s = Math.max(s0, lo);
    const e = Math.min(e0, hi);
    if (e < s || s0 > hi || e0 < lo) return;
    const span = Math.max(MIN_ARC_DEG, (e - s) / 60_000 / 4);
    arcs.push({ key, entry, r, a0: clockDeg(s, tz), span, color, width, opacity: opacityAt(e), live, bottle, s: s0, e: e0 });
  };

  for (const entry of entries) {
    const start = Date.parse(entry.started_at);
    const end = entry.ended_at ? Date.parse(entry.ended_at) : entry.active ? nowMs : start;
    if (entry.kind === "sleep") {
      addArc(entry, `s${entry.id}`, start, end, R.sleep, COLORS.sleep, 16, entry.active);
    } else if (entry.kind === "feed") {
      const d = entry.data as FeedData;
      if (d.method === "bottle") {
        addArc(entry, `b${entry.id}`, start, Math.max(end, start), R.feed, COLORS.bottleEdge, 14, false, true);
      } else if (d.segments?.length) {
        d.segments.forEach((seg, i) => {
          const s = Date.parse(seg.start);
          const e = seg.end ? Date.parse(seg.end) : entry.active ? nowMs : s;
          addArc(entry, `f${entry.id}-${i}`, s, e, R.feed, seg.side === "L" ? COLORS.left : COLORS.right, 14, entry.active && !seg.end);
        });
      } else {
        // A feed logged by minutes: first side, then the other.
        const first = d.first_side ?? (d.left_sec ? "L" : "R");
        const a = (first === "L" ? d.left_sec : d.right_sec) ?? 0;
        const b = (first === "L" ? d.right_sec : d.left_sec) ?? 0;
        const col = (side: string) => (side === "L" ? COLORS.left : COLORS.right);
        addArc(entry, `f${entry.id}-a`, start, start + a * 1000, R.feed, col(first), 14, false);
        if (b > 0) addArc(entry, `f${entry.id}-b`, start + a * 1000, start + (a + b) * 1000, R.feed, col(first === "L" ? "R" : "L"), 14, false);
      }
    } else if (entry.kind === "diaper") {
      if (start < lo || start > hi) continue;
      const color = entry.data.poop ? (entry.data.color ? STOOL_COLOR_INFO[entry.data.color].hex : COLORS.poop) : COLORS.pee;
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
  const now = useNow(30_000);
  const [view, setView] = useState<View>("rolling");
  const [fetched, setFetched] = useState<{ key: string; entries: Entry[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [pop, setPop] = useState<{ x: number; y: number; w: number; t: number; items: Entry[] } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const todayKey = dayKey(now, tz);
  const yesterday = addDays(todayKey, -1);
  const bornKey = state?.baby.born_at ? dayKey(Date.parse(state.baby.born_at), tz) : null;
  const oldest = bornKey && bornKey > addDays(todayKey, -60) ? bornKey : addDays(todayKey, -60);
  // The state snapshot holds ~72h; older days come from the API.
  const needsFetch = view !== "rolling" && view < addDays(todayKey, -1);

  useEffect(() => {
    if (!needsFetch || fetched?.key === view) return;
    let cancelled = false;
    setLoading(true);
    api<{ entries: Entry[] }>(`entries?from=${view}&to=${view}`)
      .then((r) => !cancelled && setFetched({ key: view, entries: r.entries }))
      .catch(() => !cancelled && setFetched({ key: view, entries: [] }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [api, fetched?.key, needsFetch, view]);

  const nowMs = now.getTime();
  const [lo, hi] = useMemo(() => {
    // A little slack past "now": the dial's clock ticks every 30s, and a diaper logged a second ago belongs on it.
    if (view === "rolling") return [nowMs - 24 * 3600_000, nowMs + 5 * 60_000];
    const [a, b] = dayBounds(view, tz);
    return [a.getTime(), Math.min(b.getTime(), nowMs)];
  }, [nowMs, tz, view]);

  const source = useMemo(() => {
    if (!state) return [];
    if (!needsFetch) return state.entries;
    return fetched?.key === view ? fetched.entries : [];
  }, [fetched, needsFetch, state, view]);

  const { arcs, dots } = useMemo(() => buildMarks(source, lo, hi, nowMs, tz, view === "rolling"), [source, lo, hi, nowMs, tz, view]);
  const stats = useMemo(() => statsFor(source, new Date(lo), new Date(hi + 1), view, now), [source, lo, hi, view, now]);

  if (!state || !summary) return null;

  const rolling = view === "rolling";
  const nowDeg = clockDeg(nowMs, tz);
  const dayOfLife = state.baby.born_at ? (rolling ? summary.age?.dayOfLife : babyAge(state.baby.born_at, new Date(hi), tz).dayOfLife) : null;
  const plotted = [...arcs.map((a) => a.entry), ...dots.map((d) => d.entry)].filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i);
  const label = `${rolling ? "Last 24 hours" : formatDayLabel(view, todayKey, { long: true })}: ${stats.feeds} feeds, ${stats.wet} wet and ${stats.dirty} dirty diapers, ${formatDuration(stats.sleepSec)} asleep.`;

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
    const deg = (Math.atan2(x, -y) * 180) / Math.PI;
    const tapMin = (((deg + 360) % 360) / 360) * 1440;
    let t: number;
    if (rolling) {
      const nowMin = (nowDeg / 360) * 1440;
      t = nowMs - (((nowMin - tapMin) % 1440) + 1440) % 1440 * 60_000;
    } else {
      t = lo + tapMin * 60_000;
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

  const step = (dir: -1 | 1) => {
    setPop(null);
    if (dir === -1) setView(rolling ? yesterday : addDays(view, -1) < oldest ? view : addDays(view, -1));
    else setView(rolling ? "rolling" : view >= yesterday ? "rolling" : addDays(view, 1));
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

  return (
    <section aria-labelledby="day-dial">
      <div className="mb-2 flex items-end justify-between px-1">
        <h2 id="day-dial" className={cx(tone.heading, "text-xl [.maple-night_&]:text-[#E0A93B]/85")}>
          Day dial
        </h2>
        <span className={cx(tone.muted, "text-xs")}>Tap the ring to see what happened</span>
      </div>
      <div className={cx(tone.card, "relative px-2 pt-3 pb-3 [.maple-night_&]:border-[#E0A93B]/10 [.maple-night_&]:bg-[#11140F]")}>
        <div className="relative mx-auto w-full max-w-[340px]">
          <svg
            ref={svgRef}
            viewBox="-14 -14 348 348"
            role="img"
            aria-label={label}
            onClick={onTap}
            className="block h-auto w-full cursor-pointer select-none"
          >
            <style>{`
              @keyframes maple-dial-dash { to { stroke-dashoffset: -24; } }
              .maple-dial-live { animation: maple-dial-dash 2.4s linear infinite; }
              @media (prefers-reduced-motion: reduce) { .maple-dial-live { animation: none; } }
              .maple-night .maple-dial-live { animation: none; }
            `}</style>
            {/* face */}
            <circle cx={C} cy={C} r={R.night} className="fill-[#FDF8F0] dark:fill-[#0E1E12] [.maple-night_&]:fill-[#0B0F0A]" />
            <path d={sectorPath(R.night, nightStart, nightSpan)} className="fill-[#4B4F8F]/[0.09] dark:fill-[#9AA0E0]/[0.08]" />
            {stars.map(([a, r], i) => {
              const [x, y] = pt(r, a);
              return <path key={i} d={`M${f(x)},${f(y - 2.2)} L${f(x + 0.6)},${f(y - 0.6)} L${f(x + 2.2)},${f(y)} L${f(x + 0.6)},${f(y + 0.6)} L${f(x)},${f(y + 2.2)} L${f(x - 0.6)},${f(y + 0.6)} L${f(x - 2.2)},${f(y)} L${f(x - 0.6)},${f(y - 0.6)} Z`} className="fill-[#8C86C0] dark:fill-[#C8C2F0]" opacity={0.7} />;
            })}
            {/* lanes */}
            <circle cx={C} cy={C} r={R.sleep} fill="none" strokeWidth={16} className="stroke-[#1D4420]/[0.05] dark:stroke-[#F5EDDF]/[0.05]" />
            <circle cx={C} cy={C} r={R.feed} fill="none" strokeWidth={14} className="stroke-[#1D4420]/[0.05] dark:stroke-[#F5EDDF]/[0.05]" />
            <circle cx={C} cy={C} r={R.diaper} fill="none" strokeWidth={1} strokeDasharray="1 4" className="stroke-[#1D4420]/20 dark:stroke-[#F5EDDF]/20" />
            {/* ticks every 3 hours, labels every 6 */}
            {Array.from({ length: 8 }, (_, i) => {
              const a = i * 45;
              const [x0, y0] = pt(143, a);
              const [x1, y1] = pt(i % 2 ? 147 : 150, a);
              return <line key={i} x1={f(x0)} y1={f(y0)} x2={f(x1)} y2={f(y1)} strokeWidth={1.4} strokeLinecap="round" className="stroke-[#1D4420]/30 dark:stroke-[#F5EDDF]/30" />;
            })}
            {[
              ["12a", 0],
              ["6a", 90],
              ["12p", 180],
              ["6p", 270],
            ].map(([t, a]) => {
              const [x, y] = pt(R.label, a as number);
              return (
                <text key={t} x={f(x)} y={f(y)} textAnchor="middle" dominantBaseline="central" fontSize="11" fontWeight="600" className="fill-[#5C6B57] dark:fill-[#B9B39C] [.maple-night_&]:fill-[#E0A93B]/50">
                  {t}
                </text>
              );
            })}

            {/* sleep + feeds */}
            {arcs.map((a) =>
              a.bottle ? (
                <g key={a.key} opacity={a.opacity}>
                  <path d={arcPath(a.r, a.a0, a.span)} fill="none" stroke={COLORS.bottleEdge} strokeWidth={a.width} strokeLinecap="round" />
                  <path d={arcPath(a.r, a.a0, a.span)} fill="none" stroke={COLORS.bottleFill} strokeWidth={a.width - 5} strokeLinecap="round" />
                </g>
              ) : (
                <path
                  key={a.key}
                  d={arcPath(a.r, a.a0, a.span)}
                  fill="none"
                  stroke={a.color}
                  strokeWidth={a.width}
                  strokeLinecap="round"
                  opacity={a.opacity}
                  strokeDasharray={a.live ? "8 4" : undefined}
                  className={a.live ? "maple-dial-live" : undefined}
                />
              )
            )}
            {/* diapers */}
            {dots.map((d) => {
              const [x, y] = pt(R.diaper, d.a);
              if (d.pee && d.poop) {
                return (
                  <g key={d.key} opacity={d.opacity} transform={`translate(${f(x)} ${f(y)}) rotate(${f(d.a)})`}>
                    <path d="M0,-5.5 A5.5,5.5 0 0 0 0,5.5 Z" fill={COLORS.pee} />
                    <path d="M0,-5.5 A5.5,5.5 0 0 1 0,5.5 Z" fill={d.color} />
                    <circle r="5.5" fill="none" strokeWidth="1" className="stroke-white/80 dark:stroke-black/40" />
                  </g>
                );
              }
              return <circle key={d.key} cx={f(x)} cy={f(y)} r={5.5} fill={d.color} opacity={d.opacity} strokeWidth="1" className="stroke-white/80 dark:stroke-black/40" />;
            })}

            {/* now hand (rolling view only) */}
            {rolling && (
              <g>
                <line x1={C} y1={C} x2={f(pt(156, nowDeg)[0])} y2={f(pt(156, nowDeg)[1])} strokeWidth={0.8} className="stroke-[#1D4420]/25 dark:stroke-[#F5EDDF]/25" />
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
            <circle cx={C} cy={C} r={66} className="fill-[#FDF8F0] dark:fill-[#0E1E12] [.maple-night_&]:fill-[#0B0F0A]" />
            <text x={C} y={C - 12} textAnchor="middle" fontSize={rolling ? 22 : 16} fontWeight="700" className="fill-[#1D4420] font-[family-name:var(--font-display)] lining-nums dark:fill-[#F5EDDF] [.maple-night_&]:fill-[#E0A93B]/85">
              {rolling ? formatTime(nowMs, tz) : formatDayLabel(view, todayKey)}
            </text>
            {dayOfLife != null && (
              <text x={C} y={C + 8} textAnchor="middle" fontSize="12" fontWeight="600" className="fill-[#B5452B] dark:fill-[#E0A93B]">
                Day {dayOfLife}
              </text>
            )}
            <text x={C} y={C + (dayOfLife != null ? 25 : 10)} textAnchor="middle" fontSize="11" className="fill-[#5C6B57] dark:fill-[#B9B39C] [.maple-night_&]:fill-[#E0A93B]/55">
              {loading ? "Loading…" : `${stats.feeds} feed${stats.feeds === 1 ? "" : "s"} · ${stats.wet}💧 ${stats.dirty}💩`}
            </text>
          </svg>

          <AnimatePresence>
            {pop && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                className="absolute z-10 w-[230px] rounded-2xl border border-[#1D4420]/10 bg-[#FDF8F0] p-2 shadow-xl dark:border-[#C49A3C]/20 dark:bg-[#14281A] [.maple-night_&]:bg-[#11140F]"
                style={{ left: Math.max(0, Math.min(pop.x - 115, pop.w - 230)), top: pop.y > pop.w * 0.55 ? pop.y - 12 : pop.y + 12, y: pop.y > pop.w * 0.55 ? "-100%" : 0 }}
              >
                <div className="flex items-center justify-between px-1.5 pb-1">
                  <p className={cx(tone.label)}>Around {formatTime(pop.t, tz)}</p>
                  <button type="button" onClick={() => setPop(null)} aria-label="Close" className={cx(tone.muted, "flex h-8 w-8 items-center justify-center rounded-full text-sm")}>
                    ✕
                  </button>
                </div>
                {pop.items.length ? (
                  pop.items.map((e) => {
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
                        className="flex min-h-[44px] w-full items-center gap-2 rounded-xl px-1.5 text-left hover:bg-[#1D4420]/5 dark:hover:bg-[#F5EDDF]/5"
                      >
                        <span aria-hidden className="w-7 text-center">
                          {entryEmoji(e)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={cx(tone.body, "block truncate text-sm font-semibold")}>{d.title}</span>
                          {d.detail && <span className={cx(tone.muted, "block truncate text-xs")}>{d.detail}</span>}
                        </span>
                        <span className={cx(tone.muted, "text-xs tabular-nums")}>{formatTime(e.started_at, tz)}</span>
                      </button>
                    );
                  })
                ) : (
                  <p className={cx(tone.muted, "px-1.5 pb-1.5 text-sm")}>Nothing logged around then.</p>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <ul className="sr-only">
          {plotted.map((e) => (
            <li key={e.id}>
              {formatTime(e.started_at, tz)}: {describeEntry(e, { units, now }).text}
            </li>
          ))}
        </ul>

        <Legend />

        <div className="mt-3 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={!rolling && view <= oldest}
            aria-label="Earlier day"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-[#1D4420]/[0.07] text-lg text-[#1D4420] disabled:opacity-30 dark:bg-[#F5EDDF]/10 dark:text-[#F5EDDF]"
          >
            ◀
          </button>
          <div className="flex rounded-full bg-[#1D4420]/[0.07] p-1 dark:bg-[#F5EDDF]/10" role="radiogroup" aria-label="Which day">
            {(["rolling", yesterday] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={view === v}
                onClick={() => {
                  setPop(null);
                  setView(v);
                }}
                className={cx(
                  "min-h-[36px] rounded-full px-3 text-sm font-semibold transition",
                  view === v ? "bg-white text-[#1D4420] shadow-sm dark:bg-[#C49A3C] dark:text-[#14210F]" : "text-[#1D4420]/70 dark:text-[#E8DCC0]/80"
                )}
              >
                {v === "rolling" ? "Last 24h" : "Yesterday"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => step(1)}
            disabled={rolling}
            aria-label="Later day"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-[#1D4420]/[0.07] text-lg text-[#1D4420] disabled:opacity-30 dark:bg-[#F5EDDF]/10 dark:text-[#F5EDDF]"
          >
            ▶
          </button>
        </div>
        {!rolling && view !== yesterday && (
          <p className={cx(tone.muted, "mt-1 text-center text-sm font-semibold")}>{formatDayLabel(view, todayKey, { long: true })}</p>
        )}
      </div>
    </section>
  );
}

function Legend() {
  const item = "inline-flex items-center gap-1.5";
  return (
    <div className={cx(tone.muted, "mt-1 flex flex-wrap justify-center gap-x-3 gap-y-1 px-2 text-[11px] font-medium")} aria-hidden>
      <span className={item}>
        <i className="h-1.5 w-4 rounded-full" style={{ backgroundColor: COLORS.left }} />L
      </span>
      <span className={item}>
        <i className="h-1.5 w-4 rounded-full" style={{ backgroundColor: COLORS.right }} />R
      </span>
      <span className={item}>
        <i className="h-2 w-4 rounded-full border-2" style={{ borderColor: COLORS.bottleEdge, backgroundColor: COLORS.bottleFill }} />
        Bottle
      </span>
      <span className={item}>
        <i className="h-1.5 w-4 rounded-full" style={{ backgroundColor: COLORS.sleep }} />
        Sleep
      </span>
      <span className={item}>
        <i className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS.pee }} />
        Pee
      </span>
      <span className={item}>
        <i className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS.poop }} />
        Poop
      </span>
    </div>
  );
}
