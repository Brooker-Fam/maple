"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WEIGHT_GAIN_NOTE } from "@/lib/maple/guidelines";
import { ageInDays, curves, percentileFor, type Measure, type Percentile } from "@/lib/maple/growth";
import { dayKey, formatDayLabel } from "@/lib/maple/time";
import { CM_PER_IN, G_PER_LB, formatLength, formatWeight } from "@/lib/maple/units";
import type { Baby, Entry, EntryOf, UnitSystem } from "@/lib/maple/types";
import { Button, Segmented, cx, tone } from "./ui";

/**
 * Her measurements on the WHO girls' growth standards (3rd–97th percentile
 * bands). Loaded lazily by Patterns because growth.ts carries the WHO tables.
 * Percentiles describe; they aren't targets, so nothing here is colored as
 * good or bad, and an implausible value only asks for a double-check.
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
};

const FIELD = { weight: "weight_g", length: "length_cm", head: "head_cm" } as const;
const BIRTH_FIELD = { weight: "birth_weight_g", length: "birth_length_cm", head: "birth_head_cm" } as const;
const NOUN: Record<Measure, string> = { weight: "weight", length: "length", head: "head size" };
const ORD: Record<number, string> = { 3: "3rd", 15: "15th", 50: "50th", 85: "85th", 97: "97th" };

/**
 * Validated against the card surfaces (≥ 3:1, chroma ≥ 0.10): gold for her,
 * sage washes for the WHO bands, which sit well below her marks in weight.
 */
const VARS =
  "[--g-her:#B78C24] [--g-surface:#FEFCF8] [--g-outer:rgba(92,122,74,0.10)] [--g-inner:rgba(92,122,74,0.20)] [--g-mid:#5C7A4A] [--g-grid:rgba(29,68,32,0.09)] [--g-axis:rgba(29,68,32,0.30)] [--g-birth:#8A6A1F] " +
  "dark:[--g-her:#C9A04A] dark:[--g-surface:#112418] dark:[--g-outer:rgba(169,192,143,0.09)] dark:[--g-inner:rgba(169,192,143,0.18)] dark:[--g-mid:#A9C08F] dark:[--g-grid:rgba(245,237,223,0.08)] dark:[--g-axis:rgba(245,237,223,0.26)] dark:[--g-birth:#E0C27A]";

const AXIS_TEXT = "fill-[#5C6B57] text-[10px] tabular-nums dark:fill-[#B9B39C]";

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
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export default function GrowthChart({ baby, growth, units, todayKey, onAdd, onEdit }: Props) {
  const [measure, setMeasure] = useState<Measure>("weight");
  const bornAt = baby.born_at;

  const points = useMemo<Point[]>(() => {
    if (!bornAt) return [];
    const out: Point[] = [];
    const birth = baby[BIRTH_FIELD[measure]];
    if (birth != null) {
      out.push({ key: "birth", ageDays: 0, value: birth, at: bornAt, where: "birth", pct: percentileFor(measure, birth, 0) });
    }
    for (const e of growth) {
      if (e.kind !== "growth") continue;
      const v = (e as EntryOf<"growth">).data[FIELD[measure]];
      if (v == null) continue;
      const age = ageInDays(bornAt, e.started_at);
      out.push({ key: String(e.id), ageDays: age, value: v, at: e.started_at, where: e.data.at ?? null, entry: e, pct: percentileFor(measure, v, age) });
    }
    return out.sort((a, b) => a.ageDays - b.ageDays);
  }, [baby, bornAt, growth, measure]);

  const hasAny =
    !!bornAt &&
    (baby.birth_weight_g != null || baby.birth_length_cm != null || baby.birth_head_cm != null || growth.some((e) => e.kind === "growth"));

  if (!bornAt) {
    return (
      <div className={VARS}>
        <p className={cx(tone.muted, "py-6 text-center text-sm")}>
          🌱 Once she&apos;s here, her measurements will sit on the WHO growth curves.
        </p>
      </div>
    );
  }

  if (!hasAny) {
    return (
      <div className={cx(VARS, "py-6 text-center")}>
        <p className={cx(tone.heading, "text-lg")}>No weigh-ins yet</p>
        <p className={cx(tone.muted, "mt-1 text-sm")}>Add her birth stats or numbers from the next checkup.</p>
        {onAdd && (
          <Button className="mt-3" variant="soft" onClick={onAdd}>
            📏 Add a measurement
          </Button>
        )}
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
      {points.length ? (
        <>
          <Plot measure={measure} points={points} units={units} birthValue={baby[BIRTH_FIELD[measure]]} />
          <PointsTable measure={measure} points={points} units={units} birthWeight={baby.birth_weight_g} tz={baby.timezone} todayKey={todayKey} onEdit={onEdit} />
        </>
      ) : (
        <div className="py-6 text-center">
          <p className={cx(tone.muted, "text-sm")}>No {NOUN[measure]} measurements yet.</p>
          {onAdd && (
            <Button className="mt-3" variant="soft" size="sm" onClick={onAdd}>
              📏 Add one
            </Button>
          )}
        </div>
      )}
      <div className={cx(tone.muted, "mt-3 space-y-1.5 text-xs leading-snug")}>
        <p>
          Shaded bands are the WHO growth standards for girls: the wide band spans the 3rd to 97th percentile, the deeper, narrower one
          the 15th to 85th, and the dashed line is the 50th. Percentiles describe where she sits among healthy girls her age; they aren&apos;t
          targets. Her pediatrician watches the curve over time.
        </p>
        {measure === "weight" && <p>{WEIGHT_GAIN_NOTE}</p>}
      </div>
    </div>
  );
}

function Plot({ measure, points, units, birthValue }: { measure: Measure; points: Point[]; units: UnitSystem; birthValue: number | null }) {
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
  const bands = useMemo(() => curves(measure, 0, xMax, xMax <= 60 ? 1 : xMax <= 240 ? 3 : 7), [measure, xMax]);
  const u = axisUnit(measure, units);

  // A value far off the charts (usually a typo or lb/kg mix-up) shouldn't squash the
  // whole chart: it's pinned to the edge, ringed, and flagged in the table.
  const plausible = points.filter((p) => !p.pct?.implausible);
  const lo = Math.min(...bands[0].points.map((p) => p[1]), ...plausible.map((p) => p.value));
  const hi = Math.max(...bands[bands.length - 1].points.map((p) => p[1]), ...plausible.map((p) => p.value));
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
  const ariaLabel = `${NOUN[measure]} on the WHO girls' growth curves: ${points
    .map((p) => `${formatValue(measure, p.value, units)} ${ageLabel(p.ageDays, p.where === "birth")}${p.pct ? `, about the ${p.pct.label} percentile` : ""}`)
    .join("; ")}`;

  return (
    <div ref={setRefs} className="relative" style={{ height: H_ }}>
      {W > 0 && (
        <svg
          width={W}
          height={H_}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          className="block touch-pan-y rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[#C49A3C]/60"
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

          <path d={area(bands[4].points, bands[0].points)} fill="var(--g-outer)" />
          <path d={area(bands[3].points, bands[1].points)} fill="var(--g-inner)" />
          <path d={line(bands[2].points)} fill="none" stroke="var(--g-mid)" strokeWidth={1.25} strokeDasharray="4 4" opacity={0.75} />
          {edge.map((e) => (
            <text key={e.p} x={W - RIGHT + 4} y={e.y} dy="0.32em" className={AXIS_TEXT}>
              {ORD[e.p]}
            </text>
          ))}

          {measure === "weight" && birthValue != null && (
            <g>
              <line x1={LEFT} x2={W - RIGHT} y1={y(birthValue)} y2={y(birthValue)} stroke="var(--g-birth)" strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
              <text x={W - RIGHT - 4} y={y(birthValue) + 12} textAnchor="end" className="fill-[#7A5A12] text-[10px] font-semibold dark:fill-[#E0C27A]">
                birth weight
              </text>
            </g>
          )}

          {her.length > 1 && <path d={line(her)} fill="none" stroke="var(--g-her)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
          {points.map((p, i) => {
            const cx = x(p.ageDays);
            const cy = y(p.value);
            const hollow = p.where === "home";
            if (p.pct?.implausible) {
              return (
                <g key={p.key}>
                  <circle cx={cx} cy={cy} r={6} fill="var(--g-surface)" stroke="var(--g-birth)" strokeWidth={1.5} strokeDasharray="2 2" />
                  <text x={cx} y={cy} dy="0.35em" textAnchor="middle" className="fill-[#7A5A12] text-[9px] font-bold dark:fill-[#E0C27A]">
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
          className="pointer-events-none absolute z-20 w-max max-w-[230px] rounded-xl bg-[#1D4420] px-3 py-2 text-xs text-[#FDF8F0] shadow-lg dark:bg-[#F5EDDF] dark:text-[#14210F]"
          style={{
            left: tipX,
            bottom: H_ - y(tip.value) + 12,
            transform: tipX < 100 ? "translateX(-12px)" : tipX > W - 100 ? "translateX(calc(-100% + 12px))" : "translateX(-50%)",
          }}
        >
          <strong className="block text-sm">{formatValue(measure, tip.value, units)}</strong>
          <span className="block opacity-90">
            {ageLabel(tip.ageDays, tip.where === "birth")}
            {tip.where === "doctor" ? (measure === "weight" ? " · doctor's scale" : " · at the doctor's") : ""}
            {tip.where === "home" ? (measure === "weight" ? " · home scale" : " · measured at home") : ""}
          </span>
          {tip.pct && !tip.pct.implausible && <span className="block opacity-90">about the {tip.pct.label} percentile</span>}
          {tip.pct?.implausible && <span className="block opacity-90">far outside the usual range: worth a double-check</span>}
        </div>
      )}
      <p className={cx(tone.muted, "pointer-events-none absolute top-0 right-0 flex gap-3 text-[10px] font-medium")} aria-hidden>
        <span className="inline-flex items-center gap-1">
          <svg width="10" height="10">
            <circle cx="5" cy="5" r="4" fill="var(--g-her)" />
          </svg>
          doctor
        </span>
        <span className="inline-flex items-center gap-1">
          <svg width="10" height="10">
            <circle cx="5" cy="5" r="3.2" fill="none" stroke="var(--g-her)" strokeWidth="1.6" />
          </svg>
          home
        </span>
      </p>
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
  onEdit,
}: {
  measure: Measure;
  points: Point[];
  units: UnitSystem;
  birthWeight: number | null;
  tz: string;
  todayKey: string;
  onEdit?: (e: Entry) => void;
}) {
  const rows = [...points].reverse();
  const th = "px-1.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[#5C7A4A] dark:text-[#A9C08F]";
  return (
    <table className="mt-3 w-full text-sm">
      <caption className="sr-only">Her {NOUN[measure]} measurements</caption>
      <thead>
        <tr className="border-b border-[#1D4420]/10 dark:border-[#F5EDDF]/10">
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
              className={cx("border-b border-[#1D4420]/5 align-top last:border-0 dark:border-[#F5EDDF]/5", editable && "cursor-pointer hover:bg-[#1D4420]/[0.03] dark:hover:bg-[#F5EDDF]/[0.04]")}
            >
              <th scope="row" className={cx(tone.body, "px-1.5 py-2 text-left font-semibold")}>
                {editable ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit!(p.entry!);
                    }}
                    aria-label={`Edit the ${when} measurement`}
                    className="text-left underline-offset-2 hover:underline">
                    {when}
                  </button>
                ) : (
                  when
                )}
                <span className={cx(tone.muted, "block text-[11px] font-normal")}>
                  {ageLabel(p.ageDays, p.where === "birth")}
                  {p.where === "home" ? " · home" : p.where === "doctor" ? " · doctor" : ""}
                </span>
              </th>
              <td className={cx(tone.body, "px-1.5 py-2 whitespace-nowrap tabular-nums")}>{formatValue(measure, p.value, units)}</td>
              <td className={cx(tone.body, "px-1.5 py-2 tabular-nums")}>
                {p.pct?.implausible ? (
                  <span
                    className="inline-block rounded-full bg-[#C49A3C]/20 px-2 py-0.5 text-[11px] font-semibold text-[#6B4A10] dark:text-[#E8CF9A]"
                    title="Far outside the usual range, which often means a typo or a lb/kg mix-up."
                  >
                    ⚠️ double-check
                  </span>
                ) : (
                  p.pct?.label ?? "—"
                )}
              </td>
              {measure === "weight" && (
                <td className={cx(tone.body, "px-1.5 py-2 text-right tabular-nums")}>
                  {change == null ? "—" : `${change > 0 ? "+" : change < 0 ? "−" : "±"}${Math.abs(change)}%`}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
