"use client";

import { formatDuration } from "@/lib/maple/time";
import type { UnitSystem } from "@/lib/maple/types";
import { formatVolume } from "@/lib/maple/units";
import type { RibbonRow } from "./PatternsTab";
import { Icon } from "./icons";
import { cx, tone } from "./ui";

type Activity = "all" | "feeds" | "sleep" | "diapers";
type Props = {
  rows: RibbonRow[];
  mode: "days" | "nights";
  units: UnitSystem;
  night: boolean;
  activity?: Activity;
  onPickDay?: (key: string) => void;
};

const C = 130;
const R = { tummy: 94, sleep: 82, cluster: 74, feed: 66, diaper: 50 };
const point = (radius: number, fraction: number) => {
  const a = fraction * Math.PI * 2;
  return [C + radius * Math.sin(a), C - radius * Math.cos(a)];
};

/** Fractions come from the same local-clock windows as the ribbons. A full
 * circle needs two arcs, or SVG would draw the coincident endpoints as nothing. */
function arc(radius: number, start: number, end: number): string {
  const [x, y] = point(radius, start);
  const [ex, ey] = point(radius, end);
  if (end - start >= 0.99999) {
    const [mx, my] = point(radius, start + 0.5);
    return `M ${x} ${y} A ${radius} ${radius} 0 1 1 ${mx} ${my} A ${radius} ${radius} 0 1 1 ${ex} ${ey}`;
  }
  return `M ${x} ${y} A ${radius} ${radius} 0 ${end - start > 0.5 ? 1 : 0} 1 ${ex} ${ey}`;
}

/** Point events need a visible mark; durations keep their actual clock span. */
function markArc(radius: number, start: number, end: number): string {
  return arc(radius, start, end > start ? end : Math.min(1, start + 1 / 180));
}

function Track({ radius, nowX }: { radius: number; nowX: number | null }) {
  return (
    <>
      <path d={arc(radius, 0, nowX ?? 1)} fill="none" stroke="var(--v-track)" strokeWidth={8} />
      {nowX != null && <path d={arc(radius, nowX, 1)} fill="none" stroke="var(--v-axis)" strokeWidth={1} strokeDasharray="2 4" opacity={0.55} />}
    </>
  );
}

function Circle({ row, mode, units, night, activity, onPickDay }: Omit<Props, "rows" | "activity"> & { row: RibbonRow; activity: Activity }) {
  const s = row.stats;
  const showSleep = activity === "all" || activity === "sleep";
  const showFeeds = activity === "all" || activity === "feeds";
  const showDiapers = activity === "all" || activity === "diapers";
  const hasLogs = activity === "sleep" ? s.sleeps > 0 || s.sleepSec > 0
    : activity === "feeds" ? s.feeds > 0 || row.feeds.length > 0
      : activity === "diapers" ? s.diapers > 0
        : s.feeds + s.diapers + s.sleeps + s.sleepSec + s.tummySec > 0 || row.feeds.length > 0;
  const empty = activity === "all" ? "No activity logged" : `No ${activity === "feeds" ? "feeds" : activity} logged`;
  const summary = [
    showFeeds && `${s.feeds} feed${s.feeds === 1 ? "" : "s"}`,
    showFeeds && s.breastFeeds === 0 && row.feeds.some((feed) => !feed.bottle) && "Nursing continued from earlier",
    showSleep && `${formatDuration(s.sleepSec)} sleep`,
    showDiapers && `${s.wet} wet · ${s.dirty} dirty`,
    showFeeds && s.bottleMl > 0 && `${formatVolume(s.bottleMl, units)} by bottle`,
    activity === "all" && s.tummySec > 0 && `${formatDuration(s.tummySec)} tummy time`,
  ].filter((part): part is string => typeof part === "string");
  const ticks = mode === "days" ? ["Midnight", "6 AM", "Noon", "6 PM"] : ["Noon", "6 PM", "Midnight", "6 AM"];
  const [nowInnerX, nowInnerY] = point(39, row.nowX ?? 0);
  const [nowOuterX, nowOuterY] = point(102, row.nowX ?? 0);
  const aria = `${row.label}${row.nowX != null ? ", so far" : ""}. ${hasLogs ? `Logged: ${summary.join("; ")}` : empty}.${row.dst ? ` ${row.dst}.` : ""}${onPickDay ? " Open this day in the Timeline." : ""}`;
  const body = (
    <>
      <span className="flex min-h-10 items-center justify-between gap-2">
        <span className={cx(tone.heading, "text-sm leading-snug")}>{row.label}</span>
        {onPickDay && <Icon name="chevron-right" size={16} className="shrink-0 text-mp-ink-3" />}
      </span>
      <svg viewBox="0 0 260 260" className="mx-auto block w-full max-w-[280px]" aria-hidden="true">
        <text x={C} y={17} textAnchor="middle" className="fill-mp-ink-2 text-[14px] font-medium">{ticks[0]}</text>
        <text x={256} y={135} textAnchor="end" className="fill-mp-ink-2 text-[14px] font-medium">{ticks[1]}</text>
        <text x={C} y={253} textAnchor="middle" className="fill-mp-ink-2 text-[14px] font-medium">{ticks[2]}</text>
        <text x={4} y={135} className="fill-mp-ink-2 text-[14px] font-medium">{ticks[3]}</text>
        {[0, 0.25, 0.5, 0.75].map((f) => {
          const [x1, y1] = point(99, f);
          const [x2, y2] = point(104, f);
          return <line key={f} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--v-axis)" />;
        })}
        {showSleep && <Track radius={R.sleep} nowX={row.nowX} />}
        {showFeeds && <Track radius={R.feed} nowX={row.nowX} />}
        {showDiapers && <Track radius={R.diaper} nowX={row.nowX} />}
        {showSleep && row.sleeps.map((sp, i) => <path key={`s${i}`} d={markArc(R.sleep, sp.x1, sp.x2)} fill="none" stroke="var(--v-sleep)" strokeWidth={10}><title>{sp.title}</title></path>)}
        {activity === "all" && row.tummies.map((sp, i) => <path key={`t${i}`} d={markArc(R.tummy, sp.x1, sp.x2)} fill="none" stroke="var(--v-tummy)" strokeWidth={4}><title>{sp.title}</title></path>)}
        {showFeeds && row.clusters.map((sp, i) => <path key={`c${i}`} d={markArc(R.cluster, sp.x1, sp.x2)} fill="none" stroke="var(--v-bottle)" strokeWidth={3} opacity={0.4}><title>{sp.title}</title></path>)}
        {showFeeds && row.feeds.map((feed, i) => (
          <g key={`f${i}`}>
            <title>{feed.title}</title>
            <path d={markArc(R.feed, feed.x1, feed.x2)} fill="none" stroke={feed.bottle ? "var(--v-bottle)" : "var(--v-nurse)"} strokeWidth={8} strokeLinecap={feed.bottle ? "round" : "butt"} />
            {feed.bottle && night && <path d={markArc(R.feed, feed.x1, feed.x2)} fill="none" stroke="var(--v-surface)" strokeWidth={4} strokeLinecap="round" />}
          </g>
        ))}
        {showDiapers && row.diapers.map((diaper, i) => {
          const [x, y] = point(R.diaper, diaper.x);
          return (
            <g key={`d${i}`}>
              <title>{diaper.title}</title>
              <circle cx={x} cy={y} r={5.5} fill="var(--v-surface)" />
              {diaper.pee && diaper.poop ? (
                <>
                  <circle cx={x} cy={y} r={3.7} fill={night ? "var(--v-surface)" : "var(--v-pee)"} stroke="var(--v-pee)" strokeWidth={1.4} />
                  <path d={`M ${x} ${y - 4.4} A 4.4 4.4 0 0 1 ${x} ${y + 4.4} Z`} fill="var(--v-poop)" />
                </>
              ) : (
                <circle cx={x} cy={y} r={3.7} fill={diaper.poop ? "var(--v-poop)" : diaper.pee ? night ? "var(--v-surface)" : "var(--v-pee)" : "var(--v-axis)"} stroke={diaper.pee ? "var(--v-pee)" : "none"} strokeWidth={1.4} />
              )}
            </g>
          );
        })}
        {row.nowX != null && (
          <g>
            <line x1={nowInnerX} y1={nowInnerY} x2={nowOuterX} y2={nowOuterY} stroke="var(--v-now)" strokeWidth={1.5} />
            <circle cx={nowOuterX} cy={nowOuterY} r={3} fill="var(--v-now)" />
          </g>
        )}
        <text x={C} y={128} textAnchor="middle" className="fill-mp-ink text-[17px] font-semibold">24h clock</text>
        <text x={C} y={147} textAnchor="middle" className="fill-mp-ink-2 text-[12px]">{row.nowX != null ? "so far" : mode === "nights" ? "noon to noon" : "one day"}</text>
      </svg>
      <span className="block min-h-12 text-center text-[13px] leading-snug text-mp-ink-2 tabular-nums">
        {hasLogs ? summary.map((line, i) => <span key={i} className="block">{line}</span>) : empty}
      </span>
      {row.dst && <span className="mt-2 block text-center text-xs text-mp-ink-2">{row.dst}</span>}
    </>
  );
  const className = cx("min-w-0 rounded-2xl border border-mp-line px-3 pt-2 pb-3 text-left", onPickDay && "transition hover:bg-mp-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mp-accent-fg active:bg-mp-sunken");
  return onPickDay ? <button type="button" className={className} aria-label={aria} onClick={() => onPickDay(row.jumpKey)}>{body}</button>
    : <div className={className}>{body}</div>;
}

/** The ribbons bent around a clock. Shared row data keeps dates, nights,
 * totals, running timers and DST notices identical across both layouts. */
export default function PatternCircles({ rows, mode, units, night, activity = "all", onPickDay }: Props) {
  return (
    <div>
      <p className={cx(tone.muted, "pt-3 pb-4 text-[13px] leading-snug")}>
        {mode === "days" ? "Midnight" : "Noon"} is at the top.
        {activity === "all" && " Rings, outside to inside: sleep, feeds, diapers."}
        {rows.some((row) => row.nowX != null) && " The line marks now; dotted tracks are still ahead."}
      </p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-3">
        {rows.map((row) => <Circle key={row.key} row={row} mode={mode} units={units} night={night} activity={activity} onPickDay={onPickDay} />)}
      </div>
    </div>
  );
}
