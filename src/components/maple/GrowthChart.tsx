"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WEIGHT_GAIN_NOTE } from "@/lib/maple/guidelines";
import { ageInDays, curves, readingFor, whoChartFor, type Measure, type Percentile, type WhoChart } from "@/lib/maple/growth";
import { dayKey, formatDayLabel } from "@/lib/maple/time";
import { CM_PER_IN, G_PER_LB, formatLength, formatWeight } from "@/lib/maple/units";
import type { Baby, Entry, EntryOf, UnitSystem } from "@/lib/maple/types";
import { babyWords } from "./familyWords";
import { Icon } from "./icons";
import { Button, EmptyState, HowToRead, Segmented, cx, tone } from "./ui";

/**
 * The baby's measurements on the WHO growth standard for their sex (3rd–97th
 * percentile bands), or on their own when no sex is set. Loaded lazily by
 * Patterns because growth.ts carries the WHO tables. Percentiles describe;
 * they aren't targets, so nothing here is colored as good or bad, and an
 * implausible value only asks for a double-check.
 */

type Props = {
  baby: Baby;
  growth: Entry[];
  units: UnitSystem;
  /** Local 'YYYY-MM-DD' today, for "Today"/"Yesterday" labels. */
  todayKey: string;
  onAdd?: () => void;
  onEdit?: (e: Entry) => void;
};

type Point = {
  key: string;
  ageDays: number;
  /** Storage units: grams or cm. */
  value: number;
  at: string;
  where: "birth" | "doctor" | "home" | null;
  entry?: Entry;
  pct: Percentile | null;
  implausible: boolean;
};

const FIELD = { weight: "weight_g", length: "length_cm", head: "head_cm" } as const;
const BIRTH_FIELD = { weight: "birth_weight_g", length: "birth_length_cm", head: "birth_head_cm" } as const;
const NOUN: Record<Measure, string> = { weight: "weight", length: "length", head: "head size" };
const ORD: Record<number, string> = { 3: "3rd", 15: "15th", 50: "50th", 85: "85th", 97: "97th" };
/** Room around the points when there are no bands to set the scale (grams / cm). */
const BARE_PAD: Record<Measure, number> = { weight: 250, length: 2, head: 1 };

/**
 * Validated against the card surfaces (≥ 3:1, chroma ≥ 0.10): gold for her,
 * sage washes for the WHO bands, which sit well below her marks in weight.
 * The chrome (surface, grid, axis) is the mp-* tokens, so it follows dark
 * mode and the night look; at night everything folds into the one amber,
 * like the Patterns charts: her marks strongest (0.85), the bands a faint
 * wash, the 50th and birth lines in between. Doctor/home stays solid/hollow.
 */
const VARS =
  "[--g-surface:var(--mp-surface)] [--g-grid:var(--mp-line)] [--g-axis:color-mix(in_srgb,var(--mp-ink)_28%,transparent)] " +
  "[--g-her:#B78C24] [--g-outer:rgba(92,122,74,0.10)] [--g-inner:rgba(92,122,74,0.20)] [--g-mid:#5C7A4A] [--g-birth:#8A6A1F] " +
  "dark:[--g-her:#C9A04A] dark:[--g-outer:rgba(169,192,143,0.09)] dark:[--g-inner:rgba(169,192,143,0.18)] dark:[--g-mid:#A9C08F] dark:[--g-birth:#E0C27A] " +
  "[.maple-night_&]:[--g-her:rgb(224_169_59/0.85)] [.maple-night_&]:[--g-outer:rgb(224_169_59/0.06)] [.maple-night_&]:[--g-inner:rgb(224_169_59/0.12)] " +
  "[.maple-night_&]:[--g-mid:rgb(224_169_59/0.55)] [.maple-night_&]:[--g-birth:rgb(224_169_59/0.7)]";

const AXIS_TEXT = "fill-mp-ink-3 text-[10px] tabular-nums";

function ageLabel(d: number, birth: boolean): string {
  if (birth) return "at birth";
  if (d < 1) return "first day";
  if (d < 14) return `${Math.floor(d)} day${Math.floor(d) === 1 ? "" : "s"} old`;
  if (d < 60) {
    const w = Math.floor(d / 7);
    const r = Math.floor(d % 7);
    return `${w} week${w === 1 ? "" : "s"}${r ? `, ${r} day${r === 1 ? "" : "s"}` : ""}`;
  }
  const m = Math.floor(d / 30.4375);
  return `${m} month${m === 1 ? "" : "s"}`;
}

function formatValue(measure: Measure, v: number, units: UnitSystem): string {
  return measure === "weight" ? formatWeight(v, units) : formatLength(v, units);
}

/** Storage → the unit the axis is read in (lb, kg, in, cm), and back. */
function axisUnit(measure: Measure, units: UnitSystem): { to: (v: number) => number; from: (v: number) => number; label: (v: number) => string } {
  if (measure === "weight") {
    return units === "us"
      ? { to: (g) => g / G_PER_LB, from: (lb) => lb * G_PER_LB, label: (lb) => `${Number.isInteger(lb) ? lb : lb.toFixed(1)} lb` }
      : { to: (g) => g / 1000, from: (kg) => kg * 1000, label: (kg) => `${kg} kg` };
  }
  return units === "us"
    ? { to: (cm) => cm / CM_PER_IN, from: (i) => i * CM_PER_IN, label: (i) => `${i}″` }
    : { to: (cm) => cm, from: (cm) => cm, label: (cm) => `${cm}` };
}

function niceStep(span: number, target: number): number {
  const raw = span / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((f) => f * pow).find((s) => span / s <= target) ?? 10 * pow;
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

export default function GrowthChart({ baby, growth, units, todayKey, onAdd, onEdit }: Props) {
  const [measure, setMeasure] = useState<Measure>("weight");
  const bornAt = baby.born_at;
  const w = babyWords(baby);
  const chart = whoChartFor(baby.sex);

  const points = useMemo<Point[]>(() => {
    if (!bornAt) return [];
    const out: Point[] = [];
    const point = (p: Omit<Point, "pct" | "implausible">): Point => ({ ...p, ...readingFor(measure, p.value, p.ageDays, baby.sex) });
    const birth = baby[BIRTH_FIELD[measure]];
    if (birth != null) out.push(point({ key: "birth", ageDays: 0, value: birth, at: bornAt, where: "birth" }));
    for (const e of growth) {
      if (e.kind !== "growth") continue;
      const v = (e as EntryOf<"growth">).data[FIELD[measure]];
      if (v == null) continue;
      out.push(point({ key: String(e.id), ageDays: ageInDays(bornAt, e.started_at), value: v, at: e.started_at, where: e.data.at ?? null, entry: e }));
    }
    return out.sort((a, b) => a.ageDays - b.ageDays);
  }, [baby, bornAt, growth, measure]);

  const hasAny =
    !!bornAt &&
    (baby.birth_weight_g != null || baby.birth_length_cm != null || baby.birth_head_cm != null || growth.some((e) => e.kind === "growth"));

  if (!bornAt) {
    return (
      <div className={cx(VARS, "px-4 py-8 text-center")}>
        <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-mp-sunken text-mp-ink-3">
          <Icon name="sprout" size={24} />
        </span>
        <p className={cx(tone.muted, "mx-auto max-w-[20rem] text-[15px]")}>
          Once {w.hes} here, {w.his} measurements will {chart ? "sit on the WHO growth curves" : "be charted here"}.
        </p>
      </div>
    );
  }

  if (!hasAny) {
    return (
      <div className={VARS}>
        <EmptyState icon="ruler" title="No weigh-ins yet">
          Add {w.his} birth stats or numbers from the next checkup.
          {onAdd && (
            <span className="mt-4 block">
              <Button variant="soft" onClick={onAdd}>
                <Icon name="plus" size={18} />
                Add a measurement
              </Button>
            </span>
          )}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className={VARS}>
      <Segmented
        className="mb-3"
        value={measure}
        onChange={setMeasure}
        options={[
          { value: "weight", label: "Weight" },
          { value: "length", label: "Length" },
          { value: "head", label: "Head" },
        ]}
      />
      {!chart && (
        <p className={cx(tone.muted, "mb-3 flex gap-2 px-1 text-[13px] leading-relaxed")}>
          <Icon name="info" size={16} className="mt-[2px] shrink-0 text-mp-ink-3" />
          <span>
            WHO&apos;s growth standards are separate for girls and boys. {w.Name}&apos;s sex isn&apos;t set, so this shows the measurements without
            percentiles.
          </span>
        </p>
      )}
      {points.length ? (
        <>
          <Plot measure={measure} points={points} units={units} birthValue={baby[BIRTH_FIELD[measure]]} chart={chart} whose={w.His} />
          <PointsTable measure={measure} points={points} units={units} birthWeight={baby.birth_weight_g} tz={baby.timezone} todayKey={todayKey} whose={w.His} onEdit={onEdit} />
        </>
      ) : (
        <div className="py-8 text-center">
          <p className={cx(tone.muted, "text-[15px]")}>No {NOUN[measure]} measurements yet.</p>
          {onAdd && (
            <Button className="mt-3" variant="soft" size="sm" onClick={onAdd}>
              <Icon name="plus" size={16} />
              Add one
            </Button>
          )}
        </div>
      )}
      <HowToRead className="mt-2">
        {chart ? (
          <p>
            Shaded bands are the WHO growth standards for {chart}: the wide band spans the 3rd to 97th percentile, the deeper, narrower one
            the 15th to 85th, and the dashed line is the 50th. Percentiles describe where {w.he} sits among healthy {chart} {w.his} age; they
            aren&apos;t targets. {w.His} pediatrician watches the curve over time.
          </p>
        ) : (
          <p>Each dot is one measurement. {w.His} pediatrician watches the curve over time.</p>
        )}
        {measure === "weight" && <p>{WEIGHT_GAIN_NOTE}</p>}
      </HowToRead>
    </div>
  );
}

function Plot({
  measure,
  points,
  units,
  birthValue,
  chart,
  whose,
}: {
  measure: Measure;
  points: Point[];
  units: UnitSystem;
  birthValue: number | null;
  chart: WhoChart | null;
  whose: string;
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

  useEffect(() => {
    if (active == null) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setActive(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [active]);

  const maxAge = points[points.length - 1]?.ageDays ?? 0;
  const xMax = Math.min(730, Math.max(14, Math.ceil(maxAge * 1.3) + 1));
  const bands = useMemo(() => curves(measure, 0, xMax, xMax <= 60 ? 1 : xMax <= 240 ? 3 : 7, chart), [chart, measure, xMax]);
  const u = axisUnit(measure, units);

  // A value far off the charts (usually a typo or lb/kg mix-up) shouldn't squash the
  // whole chart: it's pinned to the edge, ringed, and flagged in the table.
  const plausible = points.filter((p) => !p.implausible);
  const scaled = bands.length || plausible.length ? plausible : points;
  let lo = Math.min(...(bands.length ? bands[0].points.map((p) => p[1]) : []), ...scaled.map((p) => p.value));
  let hi = Math.max(...(bands.length ? bands[bands.length - 1].points.map((p) => p[1]) : []), ...scaled.map((p) => p.value));
  if (!bands.length) {
    const pad = Math.max(BARE_PAD[measure], (hi - lo) * 0.08);
    lo -= pad;
    hi += pad;
  }
  const dLo = u.to(lo);
  const dHi = u.to(hi);
  const step = niceStep(dHi - dLo, 4);
  const tickLo = Math.floor(dLo / step) * step;
  const tickHi = Math.ceil(dHi / step) * step;
  const yTicks: number[] = [];
  for (let v = tickLo; v <= tickHi + step / 2; v += step) yTicks.push(Math.round(v * 100) / 100);

  const H_ = 250;
  const LEFT = 40;
  const RIGHT = 32;
  const TOP = 10;
  const BOTTOM = 22;
  const plotW = Math.max(0, W - LEFT - RIGHT);
  const x = (d: number) => LEFT + (d / xMax) * plotW;
  const yRaw = (stored: number) => H_ - BOTTOM - ((u.to(stored) - tickLo) / (tickHi - tickLo)) * (H_ - BOTTOM - TOP);
  const y = (stored: number) => Math.min(H_ - BOTTOM, Math.max(TOP, yRaw(stored)));

  const xStep = xMax <= 28 ? 7 : xMax <= 84 ? 14 : xMax <= 182 ? 30.4375 : 61;
  const xTicks: { d: number; label: string }[] = [];
  for (let d = 0; d <= xMax + 0.01; d += xStep) {
    const label = d === 0 ? "birth" : xStep < 30 ? `${Math.round(d / 7)} wk` : `${Math.round(d / 30.4375)} mo`;
    xTicks.push({ d, label });
  }

  const area = (a: [number, number][], b: [number, number][]) =>
    `M${a.map(([d, v]) => `${x(d)},${y(v)}`).join("L")}L${[...b].reverse().map(([d, v]) => `${x(d)},${y(v)}`).join("L")}Z`;
  const line = (pts: [number, number][]) => `M${pts.map(([d, v]) => `${x(d)},${y(v)}`).join("L")}`;

  // Right-edge percentile labels, nudged apart so they never overlap.
  const edge = bands.map((b) => ({ p: b.p, y: y(b.points[b.points.length - 1][1]) })).sort((a, b) => b.y - a.y);
  for (let i = 1; i < edge.length; i++) if (edge[i - 1].y - edge[i].y < 11) edge[i].y = edge[i - 1].y - 11;

  const her = plausible.map((p) => [p.ageDays, p.value] as [number, number]);
  const tip = active != null ? points[active] : null;
  const tipX = tip ? x(tip.ageDays) : 0;
  const ariaLabel = `${chart ? `${NOUN[measure]} on the WHO ${chart}' growth curves` : `${whose} ${NOUN[measure]}`}: ${points
    .map((p) => `${formatValue(measure, p.value, units)} ${ageLabel(p.ageDays, p.where === "birth")}${p.pct ? `, about the ${p.pct.label} percentile` : ""}`)
    .join("; ")}`;

  return (
    <div>
      <p className={cx(tone.muted, "mb-1 flex gap-3.5 px-1 text-xs font-medium")} aria-hidden>
        <span className="inline-flex items-center gap-1.5">
          <svg width="10" height="10">
            <circle cx="5" cy="5" r="4" fill="var(--g-her)" />
          </svg>
          At the doctor&apos;s
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="10" height="10">
            <circle cx="5" cy="5" r="3.2" fill="none" stroke="var(--g-her)" strokeWidth="1.6" />
          </svg>
          At home
        </span>
      </p>
      <div ref={setRefs} className="relative" style={{ height: H_ }}>
        {W > 0 && (
          <svg
            width={W}
            height={H_}
            role="img"
            aria-label={ariaLabel}
            tabIndex={0}
            className="block touch-pan-y rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-mp-focus/60"
            onFocus={() => setActive((a) => a ?? points.length - 1)}
            onBlur={() => setActive(null)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") setActive((a) => Math.max(0, (a ?? points.length) - 1));
              else if (e.key === "ArrowRight") setActive((a) => Math.min(points.length - 1, (a ?? -1) + 1));
              else if (e.key === "Escape") setActive(null);
              else return;
              e.preventDefault();
            }}
          >
            {yTicks.map((v) => {
              const yy = y(u.from(v));
              return (
                <g key={v}>
                  <line x1={LEFT} x2={W - RIGHT} y1={yy} y2={yy} stroke="var(--g-grid)" />
                  <text x={LEFT - 5} y={yy} dy="0.32em" textAnchor="end" className={AXIS_TEXT}>
                    {u.label(v)}
                  </text>
                </g>
              );
            })}
            {xTicks.map((t) => (
              <g key={t.d}>
                <line x1={x(t.d)} x2={x(t.d)} y1={TOP} y2={H_ - BOTTOM} stroke="var(--g-grid)" />
                <text x={x(t.d)} y={H_ - 6} textAnchor={t.d === 0 ? "start" : "middle"} className={AXIS_TEXT}>
                  {t.label}
                </text>
              </g>
            ))}
            <line x1={LEFT} x2={W - RIGHT} y1={H_ - BOTTOM} y2={H_ - BOTTOM} stroke="var(--g-axis)" />

            {bands.length > 0 && (
              <>
                <path d={area(bands[4].points, bands[0].points)} fill="var(--g-outer)" />
                <path d={area(bands[3].points, bands[1].points)} fill="var(--g-inner)" />
                <path d={line(bands[2].points)} fill="none" stroke="var(--g-mid)" strokeWidth={1.25} strokeDasharray="4 4" opacity={0.75} />
              </>
            )}
            {edge.map((e) => (
              <text key={e.p} x={W - RIGHT + 4} y={e.y} dy="0.32em" className={AXIS_TEXT}>
                {ORD[e.p]}
              </text>
            ))}

            {measure === "weight" && birthValue != null && (
              <g>
                <line x1={LEFT} x2={W - RIGHT} y1={y(birthValue)} y2={y(birthValue)} stroke="var(--g-birth)" strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
                <text x={W - RIGHT - 4} y={y(birthValue) + 12} textAnchor="end" fill="var(--g-birth)" className="text-[10px] font-semibold">
                  birth weight
                </text>
              </g>
            )}

            {her.length > 1 && <path d={line(her)} fill="none" stroke="var(--g-her)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
            {points.map((p, i) => {
              const cx = x(p.ageDays);
              const cy = y(p.value);
              const hollow = p.where === "home";
              if (p.implausible) {
                return (
                  <g key={p.key}>
                    <circle cx={cx} cy={cy} r={6} fill="var(--g-surface)" stroke="var(--g-birth)" strokeWidth={1.5} strokeDasharray="2 2" />
                    <text x={cx} y={cy} dy="0.35em" textAnchor="middle" fill="var(--g-birth)" className="text-[9px] font-bold">
                      ?
                    </text>
                    <circle
                      cx={cx}
                      cy={cy}
                      r={14}
                      fill="transparent"
                      onPointerEnter={(e) => e.pointerType === "mouse" && setActive(i)}
                      onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
                      onPointerDown={() => setActive((a) => (a === i ? null : i))}
                    />
                  </g>
                );
              }
              return (
                <g key={p.key}>
                  <circle cx={cx} cy={cy} r={6.5} fill="var(--g-surface)" />
                  <circle
                    cx={cx}
                    cy={cy}
                    r={hollow ? 3.75 : 4.5}
                    fill={hollow ? "var(--g-surface)" : "var(--g-her)"}
                    stroke={hollow ? "var(--g-her)" : "none"}
                    strokeWidth={hollow ? 2 : 0}
                  />
                  {active === i && <circle cx={cx} cy={cy} r={8.5} fill="none" stroke="var(--g-her)" strokeWidth={1.5} />}
                  <circle
                    cx={cx}
                    cy={cy}
                    r={14}
                    fill="transparent"
                    onPointerEnter={(e) => e.pointerType === "mouse" && setActive(i)}
                    onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
                    onPointerDown={() => setActive((a) => (a === i ? null : i))}
                  />
                </g>
              );
            })}
          </svg>
        )}
        {tip && W > 0 && (
          <div
            role="status"
            className="pointer-events-none absolute z-20 w-max max-w-[230px] rounded-xl bg-mp-toast px-3 py-2 text-xs text-mp-on-toast shadow-[0_8px_24px_rgba(0,0,0,0.18)] [.maple-night_&]:ring-1 [.maple-night_&]:ring-mp-line"
            style={{
              left: tipX,
              bottom: H_ - y(tip.value) + 12,
              transform: tipX < 100 ? "translateX(-12px)" : tipX > W - 100 ? "translateX(calc(-100% + 12px))" : "translateX(-50%)",
            }}
          >
            <strong className="block text-sm font-semibold tabular-nums">{formatValue(measure, tip.value, units)}</strong>
            <span className="block opacity-90">
              {ageLabel(tip.ageDays, tip.where === "birth")}
              {tip.where === "doctor" ? (measure === "weight" ? " · doctor's scale" : " · at the doctor's") : ""}
              {tip.where === "home" ? (measure === "weight" ? " · home scale" : " · measured at home") : ""}
            </span>
            {tip.pct && !tip.implausible && <span className="block opacity-90">about the {tip.pct.label} percentile</span>}
            {tip.implausible && <span className="block opacity-90">far outside the usual range: worth a double-check</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function PointsTable({
  measure,
  points,
  units,
  birthWeight,
  tz,
  todayKey,
  whose,
  onEdit,
}: {
  measure: Measure;
  points: Point[];
  units: UnitSystem;
  birthWeight: number | null;
  tz: string;
  todayKey: string;
  whose: string;
  onEdit?: (e: Entry) => void;
}) {
  const rows = [...points].reverse();
  const th = cx(tone.faint, "px-1.5 pt-1 pb-2 text-left text-xs font-medium");
  return (
    <table className="mt-4 w-full text-sm">
      <caption className="sr-only">{whose} {NOUN[measure]} measurements</caption>
      <thead>
        <tr className="border-b border-mp-line">
          <th scope="col" className={th}>
            When
          </th>
          <th scope="col" className={th}>
            {measure === "weight" ? "Weight" : measure === "length" ? "Length" : "Head"}
          </th>
          <th scope="col" className={th}>
            Percentile
          </th>
          {measure === "weight" && (
            <th scope="col" className={cx(th, "text-right whitespace-nowrap")}>
              vs birth
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => {
          const change =
            measure === "weight" && birthWeight && p.where !== "birth" ? Math.round(((p.value - birthWeight) / birthWeight) * 1000) / 10 : null;
          const editable = !!(p.entry && onEdit);
          const when = p.where === "birth" ? "Birth" : formatDayLabel(dayKey(Date.parse(p.at), tz), todayKey);
          return (
            <tr
              key={p.key}
              onClick={editable ? () => onEdit!(p.entry!) : undefined}
              className={cx("border-b border-mp-line align-top last:border-0", editable && "cursor-pointer transition hover:bg-mp-ink/[0.03] active:bg-mp-ink/[0.05]")}
            >
              <th scope="row" className={cx(tone.body, "px-1.5 py-2.5 text-left font-medium")}>
                {editable ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit!(p.entry!);
                    }}
                    aria-label={`Edit the ${when} measurement`}
                    // A 44px hit area that stays inside its own row (10px up to the cell's top, 14px down over
                    // the age line); the negative margins keep the row exactly as tall as before.
                    className="-mt-2.5 -mb-3.5 block w-full pt-2.5 pb-3.5 text-left underline-offset-2 hover:underline">
                    {when}
                  </button>
                ) : (
                  when
                )}
                <span className={cx(tone.faint, "block text-xs font-normal")}>
                  {ageLabel(p.ageDays, p.where === "birth")}
                  {p.where === "home" ? " · home" : p.where === "doctor" ? " · doctor" : ""}
                </span>
              </th>
              <td className={cx(tone.body, "px-1.5 py-2.5 whitespace-nowrap tabular-nums")}>{formatValue(measure, p.value, units)}</td>
              <td className={cx(tone.body, "px-1.5 py-2.5 tabular-nums")}>
                {p.implausible ? (
                  <span
                    className="inline-flex items-start gap-1 rounded-md bg-mp-danger/10 px-1.5 py-0.5 text-xs leading-snug font-semibold text-mp-danger"
                    title="Far outside the usual range, which often means a typo or a lb/kg mix-up."
                  >
                    <Icon name="circle-alert" size={13} strokeWidth={2} className="mt-px shrink-0" />
                    {/* Wraps at the hyphen on a phone, so the row never pushes the table wider than the card. */}
                    <span>Double-check</span>
                  </span>
                ) : (
                  p.pct?.label ?? <span className={tone.faint}>—</span>
                )}
              </td>
              {measure === "weight" && (
                <td className={cx(tone.body, "px-1.5 py-2.5 text-right tabular-nums")}>
                  {change == null ? <span className={tone.faint}>—</span> : `${change > 0 ? "+" : change < 0 ? "−" : "±"}${Math.abs(change)}%`}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
