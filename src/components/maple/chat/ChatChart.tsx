"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { parseChatChart, type ActivityChartSnapshot, type ActivityMetric, type ChatChartSnapshot, type GrowthChartSnapshot } from "@/lib/maple/chat/charts";
import { formatWeight } from "@/lib/maple/units";
import { useAppNav } from "../AppNav";
import { Icon } from "../icons";
import { Segmented, cx, tone } from "../ui";
import { useMaple } from "../useMaple";

const W = 320;
const H = 156;
const LEFT = 36;
const RIGHT = 12;
const TOP = 12;
const BOTTOM = 128;
const INK = "var(--mp-accent-fg)";
const GRID = "var(--mp-line)";
const AXIS = "fill-mp-ink-3 text-[10px]";

const dayLabel = (day: string, long = false) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(long ? { year: "numeric" } : {}), timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
const whenLabel = (at: string, timezone: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: timezone }).format(new Date(at));
const shortWhen = (at: string, timezone: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: timezone }).format(new Date(at));
const noLog = "No logs";

/** Cards are dated server snapshots. Changing a view never makes a new log or runs a model call. */
type ChartActions = { onAsk?: (prompt: string) => void; disabled?: boolean };

export default function ChatChart({ chart: raw, onAsk, disabled }: { chart: ChatChartSnapshot | unknown } & ChartActions) {
  const chart = useMemo(() => parseChatChart(raw), [raw]);
  if (!chart) return null;
  return chart.kind === "activity" ? <ActivityCard chart={chart} onAsk={onAsk} disabled={disabled} /> : <GrowthCard chart={chart} onAsk={onAsk} disabled={disabled} />;
}

function Card({ title, chart, children, onRefresh, disabled }: { title: string; chart: ChatChartSnapshot; children: ReactNode; onRefresh?: () => void; disabled?: boolean }) {
  const nav = useAppNav();
  return (
    <section className={cx(tone.card, "min-w-0 p-3.5")} aria-label={title}>
      <h3 className={cx(tone.body, "text-[16px] font-semibold")}>{title}</h3>
      <p className={cx(tone.faint, "mt-1 text-[12px] leading-snug")}>Snapshot · {whenLabel(chart.asOf, chart.timezone)}</p>
      <div className="mt-3">{children}</div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 border-t border-mp-line pt-1">
        {onRefresh && <button type="button" disabled={disabled} onClick={onRefresh} className="min-h-11 text-[13px] font-medium text-mp-accent-fg disabled:opacity-40">Refresh chart</button>}
        <button type="button" onClick={() => nav.go("patterns")} className="min-h-11 text-[13px] font-medium text-mp-accent-fg">Open history</button>
      </div>
    </section>
  );
}

function PointNavigation({ label, index, length, onPick, children }: { label: string; index: number; length: number; onPick: (i: number) => void; children: ReactNode }) {
  return (
    <div className={cx(tone.inset, "mt-2 flex min-h-[60px] items-center gap-1 px-1.5 py-1")}>
      <button type="button" aria-label={`Previous ${label}`} disabled={index <= 0} onClick={() => onPick(index - 1)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-mp-ink-2 disabled:opacity-25 focus-visible:outline-2 focus-visible:outline-mp-focus">
        <Icon name="chevron-left" size={18} />
      </button>
      <div className="min-w-0 flex-1 text-center" aria-live="polite">{children}</div>
      <button type="button" aria-label={`Next ${label}`} disabled={index >= length - 1} onClick={() => onPick(index + 1)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-mp-ink-2 disabled:opacity-25 focus-visible:outline-2 focus-visible:outline-mp-focus">
        <Icon name="chevron-right" size={18} />
      </button>
    </div>
  );
}

function ActivityCard({ chart, onAsk, disabled }: { chart: ActivityChartSnapshot } & ChartActions) {
  const [metric, setMetric] = useState<ActivityMetric>(chart.metric);
  const [range, setRange] = useState<"7" | "14">(String(chart.range) as "7" | "14");
  const [picked, setPicked] = useState(chart.to);
  const helpId = useId();
  const days = chart.days.slice(-Number(range));
  const index = Math.max(0, days.findIndex((day) => day.date === picked) < 0 ? days.length - 1 : days.findIndex((day) => day.date === picked));
  const selected = days[index];
  const value = (day: typeof days[number]) => metric === "feeds" ? day.feeds : metric === "sleep" ? day.sleepHours : day.wet == null || day.dirty == null ? null : day.wet + day.dirty;
  const detail = (day: typeof days[number]) => {
    if (value(day) == null) return noLog;
    if (metric === "sleep") return `${day.sleepHours} h logged`;
    if (metric === "diapers") return `${day.wet} wet · ${day.dirty} dirty`;
    return `${day.feeds} feed${day.feeds === 1 ? "" : "s"} logged`;
  };
  const max = Math.max(1, ...days.map((day) => value(day) ?? 0));
  const ceiling = metric === "sleep" ? Math.max(2, Math.ceil(max / 2) * 2) : Math.max(2, Math.ceil(max / 4) * 4);
  const y = (n: number) => BOTTOM - n / ceiling * (BOTTOM - TOP);
  const slot = (W - LEFT - RIGHT) / Math.max(1, days.length);
  const x = (i: number) => LEFT + slot * (i + 0.5);
  const bar = Math.min(22, slot * 0.64);
  const pick = (i: number) => { if (days[i]) setPicked(days[i].date); };
  return (
    <Card title="Activity over time" chart={chart} disabled={disabled} onRefresh={onAsk ? () => onAsk(`Refresh the chart of logged ${metric === "feeds" ? "feeds" : metric === "sleep" ? "sleep" : "wet and dirty diapers"} for the last ${range} days.`) : undefined}>
      <Segmented className="[&_button]:min-h-11" aria-label="Chart metric" value={metric} onChange={setMetric} options={[{ value: "feeds", label: "Feeds" }, { value: "sleep", label: "Sleep" }, { value: "diapers", label: "Diapers" }]} />
      <div className="mt-2 max-w-[200px]">
        <Segmented className="[&_button]:min-h-11" aria-label="Chart range" value={range} onChange={setRange} options={[{ value: "7", label: "7 days" }, { value: "14", label: "14 days" }]} />
      </div>
      {metric === "diapers" && <div className={cx(tone.muted, "mt-2 flex items-center gap-3 text-[12px]")}>
        <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-mp-accent-fg opacity-35" />Wet</span>
        <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-mp-accent-fg opacity-90" />Dirty</span>
      </div>}
      {days.length ? (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 block w-full overflow-visible rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-mp-focus/60 touch-pan-y" role="group" aria-label={`${metric === "sleep" ? "Logged sleep in hours" : metric === "diapers" ? "Wet and dirty diaper counts" : "Logged feeds"}, ${range} days. Use the arrow keys to explore.`} aria-describedby={helpId} tabIndex={0} onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            pick(Math.min(days.length - 1, Math.max(0, index + (event.key === "ArrowLeft" ? -1 : 1))));
          }}>
            {[0, ceiling / 2, ceiling].map((tick) => <g key={tick}><line x1={LEFT} x2={W - RIGHT} y1={y(tick)} y2={y(tick)} stroke={GRID} /><text x={LEFT - 6} y={y(tick)} dy="0.32em" textAnchor="end" className={AXIS}>{tick}{metric === "sleep" ? "h" : ""}</text></g>)}
            {days.map((day, i) => {
              const n = value(day);
              return <g key={day.date}>
                {i === index && <rect x={x(i) - slot / 2} y={TOP - 6} width={slot} height={BOTTOM - TOP + 12} rx={4} fill={INK} opacity={0.08} />}
                {n == null ? <line x1={x(i) - 4} x2={x(i) + 4} y1={BOTTOM - 3} y2={BOTTOM - 3} stroke="var(--mp-ink-3)" strokeDasharray="2 2" /> : metric === "diapers" ? <>
                  <rect x={x(i) - bar / 2} y={y(day.wet!)} width={bar} height={BOTTOM - y(day.wet!)} rx={2} fill={INK} opacity={0.35} />
                  <rect x={x(i) - bar / 2} y={y(n)} width={bar} height={y(day.wet!) - y(n)} rx={2} fill={INK} opacity={0.9} />
                </> : <rect x={x(i) - bar / 2} y={y(n)} width={bar} height={Math.max(1, BOTTOM - y(n))} rx={3} fill={INK} opacity={day.partial ? 0.5 : 0.9} />}
                <rect x={x(i) - slot / 2} y={0} width={slot} height={H} fill="transparent" onPointerDown={() => pick(i)}><title>{dayLabel(day.date, true)}{day.partial ? ", partial day" : ""}: {detail(day)}</title></rect>
                {(i === 0 || i === days.length - 1 || (i < days.length - 2 && i % (days.length > 7 ? 4 : 2) === 0)) && <text x={x(i)} y={H - 7} textAnchor="middle" className={AXIS}>{dayLabel(day.date)}</text>}
              </g>;
            })}
          </svg>
          <PointNavigation label="day" index={index} length={days.length} onPick={pick}>
            <p className={cx(tone.muted, "text-[12px]")}>{dayLabel(selected.date)}{selected.partial ? " · partial day" : ""}</p>
            <p className={cx(tone.body, "mt-0.5 text-[14px] font-medium tabular-nums")}>{detail(selected)}</p>
          </PointNavigation>
          <details className="mt-2">
            <summary className="flex min-h-11 cursor-pointer items-center text-[13px] font-medium text-mp-accent-fg">Show data</summary>
            <table className="w-full text-[12px] tabular-nums"><caption className="sr-only">{metric} logged by day</caption><thead><tr className="border-b border-mp-line"><th scope="col" className="py-2 text-left font-medium">Day</th><th scope="col" className="py-2 text-right font-medium">{metric === "sleep" ? "Logged sleep" : metric === "diapers" ? "Wet / dirty" : "Feeds"}</th></tr></thead><tbody>{days.map((day) => <tr key={day.date} className="border-b border-mp-line last:border-0"><th scope="row" className="py-2 text-left font-normal">{dayLabel(day.date)}{day.partial ? " (partial)" : ""}</th><td className="py-2 text-right">{detail(day)}</td></tr>)}</tbody></table>
          </details>
        </>
      ) : <p className={cx(tone.muted, "py-5 text-[14px]")}>No activity has been logged for these days.</p>}
      <p id={helpId} className={cx(tone.faint, "mt-2 text-[12px] leading-snug")}>Only logged activity. Missing logs are not zero activity.{metric === "diapers" ? " A diaper can count as both wet and dirty." : ""}</p>
    </Card>
  );
}

function GrowthCard({ chart, onAsk, disabled }: { chart: GrowthChartSnapshot } & ChartActions) {
  const { units } = useMaple();
  const [selected, setSelected] = useState(chart.points.length - 1);
  const helpId = useId();
  const points = chart.points;
  const index = Math.max(0, Math.min(selected, points.length - 1));
  const picked = points[index];
  const weights = points.map((point) => point.weightG);
  if (chart.birthWeightG != null) weights.push(chart.birthWeightG);
  const min = Math.min(...weights);
  const max = Math.max(...weights);
  const pad = Math.max(100, (max - min) * 0.15);
  const low = Math.max(0, min - pad);
  const high = max + pad;
  const start = points.length ? Date.parse(points[0].at) : 0;
  const end = points.length ? Date.parse(points[points.length - 1].at) : 1;
  const x = (at: string) => end === start ? (LEFT + W - RIGHT) / 2 : LEFT + (Date.parse(at) - start) / (end - start) * (W - LEFT - RIGHT);
  const y = (grams: number) => BOTTOM - (grams - low) / (high - low) * (BOTTOM - TOP);
  const line = points.map((point, i) => `${i === 0 ? "M" : "L"}${x(point.at)},${y(point.weightG)}`).join(" ");
  const axisWeight = (g: number) => units === "us" ? `${(g / 453.59237).toFixed(1)} lb` : `${(g / 1000).toFixed(1)} kg`;
  return (
    <Card title="Weight over time" chart={chart} disabled={disabled} onRefresh={onAsk ? () => onAsk("Refresh the weight chart with the latest recorded weigh-ins.") : undefined}>
      {points.length ? <>
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full overflow-visible rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-mp-focus/60 touch-pan-y" role="group" aria-label="Recorded weight over time. Use the arrow keys to explore measurements." aria-describedby={helpId} tabIndex={0} onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setSelected(Math.min(points.length - 1, Math.max(0, index + (event.key === "ArrowLeft" ? -1 : 1))));
        }}>
          {[low, high].map((value) => <g key={value}><line x1={LEFT} x2={W - RIGHT} y1={y(value)} y2={y(value)} stroke={GRID} /><text x={LEFT - 6} y={y(value)} dy="0.32em" textAnchor="end" className={AXIS}>{axisWeight(value)}</text></g>)}
          {chart.birthWeightG != null && <line x1={LEFT} x2={W - RIGHT} y1={y(chart.birthWeightG)} y2={y(chart.birthWeightG)} stroke="var(--mp-ink-3)" strokeDasharray="4 4"><title>Birth weight: {formatWeight(chart.birthWeightG, units)}</title></line>}
          <path d={line} fill="none" stroke={INK} strokeWidth={2} strokeLinejoin="round" />
          {points.map((point, i) => <g key={`${point.at}-${i}`}>
            {i === index && <circle cx={x(point.at)} cy={y(point.weightG)} r={8} fill="none" stroke={INK} opacity={0.35} strokeWidth={3} />}
            <circle cx={x(point.at)} cy={y(point.weightG)} r={point.birth ? 3 : 4} fill={point.birth ? "var(--mp-surface)" : INK} stroke={INK} strokeWidth={1.5} />
            <circle cx={x(point.at)} cy={y(point.weightG)} r={13} fill="transparent" onPointerDown={() => setSelected(i)}><title>{point.birth ? "Birth weight" : whenLabel(point.at, chart.timezone)}: {formatWeight(point.weightG, units)}</title></circle>
          </g>)}
          <text x={LEFT} y={H - 7} textAnchor="start" className={AXIS}>{shortWhen(points[0].at, chart.timezone)}</text>
          {points.length > 1 && <text x={W - RIGHT} y={H - 7} textAnchor="end" className={AXIS}>{shortWhen(points[points.length - 1].at, chart.timezone)}</text>}
        </svg>
        <PointNavigation label="measurement" index={index} length={points.length} onPick={setSelected}>
          <p className={cx(tone.muted, "text-[12px] leading-snug")}>{picked.birth ? "At birth" : whenLabel(picked.at, chart.timezone)}</p>
          <p className={cx(tone.body, "mt-0.5 text-[14px] font-medium tabular-nums")}>{formatWeight(picked.weightG, units)}</p>
          {picked.percentileLabel && <p className={cx(tone.muted, "mt-0.5 text-[12px]")}>{picked.percentileLabel} percentile · WHO</p>}
          {picked.implausible && <p className={cx(tone.muted, "mt-1 text-[12px] leading-snug")}>This measurement is worth double-checking.</p>}
        </PointNavigation>
        {chart.birthWeightG != null && <p className={cx(tone.faint, "mt-2 text-[12px]")}>Dashed line: birth weight, {formatWeight(chart.birthWeightG, units)}</p>}
        <details className="mt-1"><summary className="flex min-h-11 cursor-pointer items-center text-[13px] font-medium text-mp-accent-fg">Show data</summary><table className="w-full text-[12px] tabular-nums"><caption className="sr-only">Recorded weights</caption><thead><tr className="border-b border-mp-line"><th scope="col" className="py-2 text-left font-medium">When</th><th scope="col" className="py-2 text-right font-medium">Weight</th></tr></thead><tbody>{points.map((point, i) => <tr key={`${point.at}-${i}`} className="border-b border-mp-line last:border-0"><th scope="row" className="py-2 pr-2 text-left font-normal">{point.birth ? "At birth" : whenLabel(point.at, chart.timezone)}</th><td className="py-2 text-right">{formatWeight(point.weightG, units)}</td></tr>)}</tbody></table></details>
      </> : <p className={cx(tone.muted, "py-5 text-[14px]")}>No recorded weights yet. A saved weigh-in will appear in the next chart.</p>}
      <p id={helpId} className={cx(tone.faint, "mt-2 text-[12px] leading-snug")}>Recorded measurements, not a prediction. Percentiles describe growth; they are not targets.{chart.truncated ? " Showing the latest 60 weigh-ins plus birth weight when recorded." : ""}</p>
    </Card>
  );
}
