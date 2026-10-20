"use client";

import { useEffect, useState } from "react";
import { describeEntry, entryEmoji } from "@/lib/maple/describe";
import { WEIGHT_GAIN_NOTE } from "@/lib/maple/guidelines";
import { cmToIn, formatLength, formatWeight, gramsToLbOz, inToCm, lbOzToGrams } from "@/lib/maple/units";
import type { GrowthData, UnitSystem } from "@/lib/maple/types";
import { Segmented, Sheet, WhenField, cx, tone } from "../ui";
import type { SheetProps } from "./index";
import {
  CHECK_NUMBER_HINT,
  ContextNote,
  Label,
  LoggedBy,
  MiniStepper,
  NoteField,
  SheetFooter,
  presetStart,
  pnum,
  pstr,
  useNumberChecks,
  useOpenCount,
  useSheetBase,
  useTouched,
} from "./parts";

/**
 * Log or edit measurements: weight as lb + oz side by side (the way a
 * pediatric scale reads out) or grams, length and head in inches or cm, and
 * whether it was the doctor's scale or home. Each number shows its WHO
 * percentile for her age as you type; the percentile tables (~60 KB) load
 * only when this sheet opens. A number far outside the charts gets a gentle
 * "double-check" (usually a lb/kg or in/cm mix-up).
 */

type Growth = typeof import("@/lib/maple/growth");

/** Rough newborn-to-toddler bounds before the WHO check loads (or before birth time is known). */
const SANE = { weight: [1000, 20000], length: [35, 100], head: [25, 55] } as const;

export default function GrowthSheet(props: SheetProps) {
  const n = useOpenCount(props.open);
  return <GrowthForm key={n} {...props} />;
}

function GrowthForm({ open, onClose, entry, preset }: SheetProps) {
  const { tz, units, log, update, remove, now, bornAt, clock } = useSheetBase();
  const e = entry?.kind === "growth" ? entry : undefined;
  const d: Partial<GrowthData> = e?.data ?? {};
  const [sys, setSys] = useState<UnitSystem>(units);
  const us = sys === "us";

  const [growth, setGrowth] = useState<Growth | null>(null);
  useEffect(() => {
    let live = true;
    import("@/lib/maple/growth")
      .then((m) => live && setGrowth(m))
      .catch(() => {
        // Percentiles are a bonus; the form works without them.
      });
    return () => {
      live = false;
    };
  }, []);

  // Stored in grams / cm; the fields hold whatever the current units show.
  const initW = d.weight_g ?? pnum(preset, "weight_g");
  const [lb, setLb] = useState<number | null>(() => (initW != null ? gramsToLbOz(initW).lb : null));
  const [oz, setOz] = useState<number | null>(() => (initW != null ? gramsToLbOz(initW).oz : null));
  const [grams, setGrams] = useState<number | null>(() => (initW != null ? Math.round(initW) : null));
  const toLen = (cm: number | undefined, system: UnitSystem) =>
    cm == null ? null : system === "us" ? Math.round(cmToIn(cm) * 100) / 100 : Math.round(cm * 10) / 10;
  const [length, setLength] = useState<number | null>(() => toLen(d.length_cm ?? pnum(preset, "length_cm"), units));
  const [head, setHead] = useState<number | null>(() => toLen(d.head_cm ?? pnum(preset, "head_cm"), units));
  const [at, setAt] = useState<"home" | "doctor">(() => d.at ?? (pstr(preset, "at") === "home" ? "home" : "doctor"));
  const [when, setWhen] = useState<Date | null>(() => (e ? new Date(e.started_at) : presetStart(preset)));
  const [note, setNote] = useState(e?.note ?? pstr(preset, "note") ?? "");
  const [busy, setBusy] = useState(false);
  const checks = useNumberChecks();
  // Switching lb ↔ kg converts what's shown; only typing or stepping counts as a change.
  const { touched, touch } = useTouched();
  const edit = (key: "weight" | "length" | "head", set: (v: number | null) => void) => (v: number | null) => {
    touch(key);
    set(v);
  };

  const weightG = us ? (lb == null && oz == null ? undefined : lbOzToGrams(lb ?? 0, oz ?? 0)) : (grams ?? undefined);
  const lenCm = length == null ? undefined : us ? inToCm(length) : length;
  const headCm = head == null ? undefined : us ? inToCm(head) : head;

  /** Switch the form's units, carrying the numbers across. */
  const switchUnits = (next: UnitSystem) => {
    if (next === sys) return;
    if (weightG != null) {
      const w = gramsToLbOz(weightG);
      setLb(w.lb);
      setOz(w.oz);
      setGrams(Math.round(weightG));
    }
    setLength(toLen(lenCm, next));
    setHead(toLen(headCm, next));
    setSys(next);
  };

  const t = when ?? now();
  const ageDays = bornAt ? Math.max(0, (t.getTime() - Date.parse(bornAt)) / 86_400_000) : null;
  const pct = (measure: "weight" | "length" | "head", v: number | undefined) =>
    v != null && v > 0 && growth && ageDays != null ? growth.percentileFor(measure, v, ageDays) : null;
  const pW = pct("weight", weightG);
  const pL = pct("length", lenCm);
  const pH = pct("head", headCm);
  const off = (measure: keyof typeof SANE, v: number | undefined, p: ReturnType<typeof pct>) =>
    v != null && v > 0 && (p?.implausible || v < SANE[measure][0] || v > SANE[measure][1]);
  const hasAny = weightG != null || lenCm != null || headCm != null;

  const data = {
    weight_g: weightG != null ? Math.round(weightG) : undefined,
    length_cm: lenCm != null ? Math.round(lenCm * 10) / 10 : undefined,
    head_cm: headCm != null ? Math.round(headCm * 10) / 10 : undefined,
    at,
  };
  // The server's limits; anything outside can't be saved.
  const savable =
    hasAny &&
    (data.weight_g == null || (data.weight_g >= 500 && data.weight_g <= 30000)) &&
    (data.length_cm == null || (data.length_cm >= 25 && data.length_cm <= 130)) &&
    (data.head_cm == null || (data.head_cm >= 20 && data.head_cm <= 60));

  /** Only the measurements that were changed: shown values are rounded through the display units. */
  const editData = () => {
    const changed: Record<string, unknown> = {};
    if (touched.weight) changed.weight_g = data.weight_g ?? null;
    if (touched.length) changed.length_cm = data.length_cm ?? null;
    if (touched.head) changed.head_cm = data.head_cm ?? null;
    if (at !== e?.data.at) changed.at = at;
    return Object.keys(changed).length ? changed : undefined;
  };

  const save = async () => {
    const noteVal = note.trim() || null;
    const bits = [
      data.weight_g != null && formatWeight(data.weight_g, sys),
      data.length_cm != null && formatLength(data.length_cm, sys),
      data.head_cm != null && `head ${formatLength(data.head_cm, sys)}`,
    ].filter(Boolean);
    const p = pW ?? pL ?? pH;
    const pLine = p ? ` · ${p.label} percentile` : "";
    if (e) {
      setBusy(true);
      const res = await update(
        e.id,
        {
          data: editData(),
          started_at: when && when.getTime() !== Date.parse(e.started_at) ? when.toISOString() : undefined,
          note: noteVal,
        },
        { toast: `Updated · ${bits.join(" · ")}${pLine}` }
      );
      setBusy(false);
      if (res) onClose();
      return;
    }
    onClose();
    void log(
      { kind: "growth", started_at: when?.toISOString(), data: Object.fromEntries(Object.entries(data).filter(([, v]) => v != null)), note: noteVal },
      { toast: `${bits.join(" · ")}${pLine} · ${clock(t)}`, emoji: "📏" }
    );
  };

  const del = () => {
    if (!e) return;
    onClose();
    void remove(e.id, { toast: "Measurements deleted" });
  };

  const lenUnit = us ? "in" : "cm";

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={e ? describeEntry(e).title : "Growth"}
      emoji={e ? entryEmoji(e) : "📏"}
      footer={
        <SheetFooter
          onClose={onClose}
          onDelete={e ? del : undefined}
          onPrimary={() => void save()}
          label={e ? "Save" : "Log it"}
          busy={busy}
          disabled={checks.invalid || !savable || (!!e && e.id < 0)}
          hint={
            checks.invalid
              ? CHECK_NUMBER_HINT
              : !hasAny
                ? "Add a weight, length or head measurement."
                : !savable
                  ? "One of those numbers is outside what can be saved."
                  : undefined
          }
        />
      }
    >
      {e && <LoggedBy entry={e} />}

      <div>
        <Label>Weighed at</Label>
        <Segmented<"home" | "doctor">
          value={at}
          onChange={setAt}
          options={[
            { value: "doctor", label: "Doctor" },
            { value: "home", label: "Home" },
          ]}
        />
      </div>

      <section aria-label="Weight">
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <Label optional className="mb-0">
            Weight
          </Label>
          <Segmented<UnitSystem>
            value={sys}
            onChange={switchUnits}
            options={[
              { value: "us", label: "lb · in" },
              { value: "metric", label: "kg · cm" },
            ]}
            className="w-[10rem] shrink-0"
          />
        </div>
        {us ? (
          <div className="grid grid-cols-2 gap-3">
            <MiniStepper key="lb" label="lb" ariaLabel="pounds" value={lb} onChange={edit("weight", setLb)} max={40} onInvalid={checks.watch("lb")} />
            <MiniStepper key="oz" label="oz" ariaLabel="ounces" value={oz} onChange={edit("weight", setOz)} step={0.1} decimals={1} max={15.9} onInvalid={checks.watch("oz")} />
          </div>
        ) : (
          <MiniStepper key="grams" label="grams" unit="g" ariaLabel="grams" value={grams} onChange={edit("weight", setGrams)} step={10} max={30000} onInvalid={checks.watch("grams")} />
        )}
        <Reading p={pW} warn={off("weight", weightG, pW)} extra={!us && weightG ? `${(weightG / 1000).toFixed(2)} kg` : undefined} />
      </section>

      <div className="grid grid-cols-2 gap-3">
        <section aria-label="Length">
          <MiniStepper label={`Length`} unit={lenUnit} ariaLabel={`length in ${us ? "inches" : "centimetres"}`} value={length} onChange={edit("length", setLength)} step={us ? 0.25 : 0.5} decimals={2} max={us ? 50 : 130} onInvalid={checks.watch("length")} />
          <Reading p={pL} warn={off("length", lenCm, pL)} compact />
        </section>
        <section aria-label="Head">
          <MiniStepper label={`Head`} unit={lenUnit} ariaLabel={`head circumference in ${us ? "inches" : "centimetres"}`} value={head} onChange={edit("head", setHead)} step={us ? 0.25 : 0.5} decimals={2} max={us ? 25 : 60} onInvalid={checks.watch("head")} />
          <Reading p={pH} warn={off("head", headCm, pH)} compact />
        </section>
      </div>

      <WhenField value={when} onChange={setWhen} tz={tz} offsets={[30, 60, 120, 240]} />
      <NoteField value={note} onChange={setNote} placeholder="Anything the doctor said?" />
      {!bornAt && <ContextNote emoji="🌱">Percentiles show up once her birth time is added.</ContextNote>}
      <ContextNote emoji="⚖️">{WEIGHT_GAIN_NOTE}</ContextNote>
    </Sheet>
  );
}

/** "About the 38th percentile (WHO)", or a gentle double-check. Neutral either way: percentiles aren't grades. */
function Reading({
  p,
  warn,
  extra,
  compact,
}: {
  p: { label: string } | null;
  warn: boolean | undefined;
  extra?: string;
  compact?: boolean;
}) {
  if (warn) {
    return (
      <p className="mt-1.5 rounded-xl bg-[#C49A3C]/15 px-2.5 py-1.5 text-xs leading-snug font-medium text-[#5A4410] dark:bg-[#C49A3C]/15 dark:text-[#EFD9A0]">
        Double-check this one. Maybe lb vs kg, or in vs cm?
      </p>
    );
  }
  if (!p && !extra) return null;
  return (
    <p className={cx(tone.muted, "mt-1.5 text-xs")}>
      {extra}
      {extra && p ? " · " : ""}
      {p ? (compact ? `${p.label} percentile` : `About the ${p.label} percentile for her age (WHO)`) : ""}
    </p>
  );
}
