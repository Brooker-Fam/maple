"use client";

import { useDraftChanged } from "../useDraftChanged";

import { useEffect, useState } from "react";
import { describeEntry } from "@/lib/maple/describe";
import { WEIGHT_GAIN_NOTE } from "@/lib/maple/guidelines";
import { cmToIn, formatLength, formatWeight, gramsToLbOz, inToCm, lbOzToGrams } from "@/lib/maple/units";
import type { EntryOf, GrowthData, UnitSystem } from "@/lib/maple/types";
import { useBabyWords } from "../familyWords";
import { Icon } from "../icons";
import { Button, Segmented, Sheet, WhenField, cx, tone } from "../ui";
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
 * percentile as you type, on the girls' or boys' standard (none with no sex
 * set); the percentile tables (~120 KB) load only when this sheet opens. A
 * number far outside the charts gets a gentle "double-check" (usually a
 * lb/kg or in/cm mix-up).
 */

type Growth = typeof import("@/lib/maple/growth");

/** Rough newborn-to-toddler bounds before the WHO check loads (or before birth time is known). */
const SANE = { weight: [1000, 20000], length: [35, 100], head: [25, 55] } as const;

export default function GrowthSheet(props: SheetProps) {
  const n = useOpenCount(props.open);
  if (props.entry?.kind === "growth" && props.entry.source === "epic") {
    return <ImportedGrowth key={n} open={props.open} onClose={props.onClose} entry={props.entry} />;
  }
  return <GrowthForm key={n} {...props} />;
}

/** Clinical copies stay as received; deleting a copy still uses Maple's usual Undo. */
function ImportedGrowth({ open, onClose, entry }: { open: boolean; onClose: () => void; entry: EntryOf<"growth"> }) {
  const { tz, units, remove, readOnly } = useSheetBase();
  const date = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: tz }).format(new Date(entry.started_at));
  const values = [
    entry.data.weight_g != null ? { name: "Weight", value: formatWeight(entry.data.weight_g, units) } : null,
    entry.data.length_cm != null ? { name: "Length", value: formatLength(entry.data.length_cm, units) } : null,
    entry.data.head_cm != null ? { name: "Head circumference", value: formatLength(entry.data.head_cm, units) } : null,
  ].filter((value): value is { name: string; value: string } => value !== null);
  return <Sheet open={open} onClose={onClose} title="Imported measurements" footer={
    <div className="flex items-center gap-3">
      {!readOnly && <button type="button" onClick={() => { onClose(); void remove(entry.id, { toast: "Imported measurements deleted" }); }} className="-ml-2 min-h-[52px] rounded-[14px] px-3 text-base font-semibold text-mp-danger transition hover:bg-mp-danger/10 active:scale-[0.97]">Delete</button>}
      <Button size="lg" className="flex-1" onClick={onClose}>Close</Button>
    </div>
  }>
    <LoggedBy entry={entry} />
    <dl className={cx(tone.card, tone.divide, "overflow-hidden")}>
      <div className="flex items-start justify-between gap-4 px-4 py-3"><dt className={tone.muted}>Source</dt><dd className={cx(tone.body, "text-right")}>MyChart import</dd></div>
      <div className="flex items-start justify-between gap-4 px-4 py-3"><dt className={tone.muted}>Measurement date</dt><dd className={cx(tone.body, "text-right")}>{date}</dd></div>
      {values.map((value) => <div key={value.name} className="flex items-start justify-between gap-4 px-4 py-3"><dt className={tone.muted}>{value.name}</dt><dd className={cx(tone.body, "text-right font-medium")}>{value.value}</dd></div>)}
    </dl>
    {entry.note && <p className={cx(tone.muted, "whitespace-pre-wrap break-words text-[13px] leading-relaxed")}>{entry.note}</p>}
    <ContextNote>Imported measurements keep the values and date received from MyChart. They cannot be edited in Maple.</ContextNote>
  </Sheet>;
}

function GrowthForm({ open, onClose, entry, preset }: SheetProps) {
  const { tz, units, log, update, remove, now, bornAt, clock, state } = useSheetBase();
  const w = useBabyWords();
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

  // Keep measured metric values separate from the rounded fields. Viewing
  // another unit must not change a reading or revive one that was cleared.
  const initW = d.weight_g ?? pnum(preset, "weight_g");
  const initLength = d.length_cm ?? pnum(preset, "length_cm");
  const initHead = d.head_cm ?? pnum(preset, "head_cm");
  const [weightG, setWeightG] = useState(initW);
  const [lenCm, setLenCm] = useState(initLength);
  const [headCm, setHeadCm] = useState(initHead);
  const [lb, setLb] = useState<number | null>(() => (initW != null ? gramsToLbOz(initW).lb : null));
  const [oz, setOz] = useState<number | null>(() => (initW != null ? gramsToLbOz(initW).oz : null));
  const [grams, setGrams] = useState<number | null>(() => (initW != null ? Math.round(initW) : null));
  const toLen = (cm: number | undefined, system: UnitSystem) =>
    cm == null ? null : system === "us" ? Math.round(cmToIn(cm) * 100) / 100 : Math.round(cm * 10) / 10;
  const [length, setLength] = useState<number | null>(() => toLen(initLength, units));
  const [head, setHead] = useState<number | null>(() => toLen(initHead, units));
  const [at, setAt] = useState<"home" | "doctor" | undefined>(() => e ? d.at : pstr(preset, "at") === "home" ? "home" : "doctor");
  const [when, setWhen] = useState<Date | null>(() => (e ? new Date(e.started_at) : presetStart(preset)));
  const [note, setNote] = useState(e?.note ?? pstr(preset, "note") ?? "");
  const [busy, setBusy] = useState(false);
  const [timeInvalid, setTimeInvalid] = useState(false);
  const checks = useNumberChecks();
  const dirty = useDraftChanged({ timeInvalid, sys, lb, oz, grams, length, head, weightG, lenCm, headCm, at, when, note, invalid: checks.invalid });
  // Only typing or stepping changes the measured value.
  const { touched, touch } = useTouched();
  const editWeight = (field: "lb" | "oz" | "g", value: number | null) => {
    touch("weight");
    if (field === "g") {
      setGrams(value);
      setWeightG(value ?? undefined);
      return;
    }
    const nextLb = field === "lb" ? value : lb;
    const nextOz = field === "oz" ? value : oz;
    if (field === "lb") setLb(value);
    else setOz(value);
    setWeightG(nextLb == null && nextOz == null ? undefined : lbOzToGrams(nextLb ?? 0, nextOz ?? 0));
  };
  const editLength = (key: "length" | "head", value: number | null) => {
    touch(key);
    const cm = value == null ? undefined : us ? inToCm(value) : value;
    if (key === "length") {
      setLength(value);
      setLenCm(cm);
    } else {
      setHead(value);
      setHeadCm(cm);
    }
  };

  /** Convert the display from the measured values, never from a rounded display. */
  const switchUnits = (next: UnitSystem) => {
    if (next === sys || checks.invalid) return;
    const w = weightG == null ? null : gramsToLbOz(weightG);
    setLb(w?.lb ?? null);
    setOz(w?.oz ?? null);
    setGrams(weightG == null ? null : Math.round(weightG));
    setLength(toLen(lenCm, next));
    setHead(toLen(headCm, next));
    setSys(next);
  };

  const t = when ?? now();
  const ageDays = bornAt ? Math.max(0, (t.getTime() - Date.parse(bornAt)) / 86_400_000) : null;
  const sex = state?.baby.sex ?? null;
  const read = (measure: keyof typeof SANE, v: number | undefined) =>
    v != null && v > 0 && growth && ageDays != null ? growth.readingFor(measure, v, ageDays, sex) : null;
  const rW = read("weight", weightG);
  const rL = read("length", lenCm);
  const rH = read("head", headCm);
  const pW = rW?.pct ?? null;
  const pL = rL?.pct ?? null;
  const pH = rH?.pct ?? null;
  const off = (measure: keyof typeof SANE, v: number | undefined, r: ReturnType<typeof read>) =>
    v != null && v > 0 && (r?.implausible || v < SANE[measure][0] || v > SANE[measure][1]);
  const hasAny = weightG != null || lenCm != null || headCm != null;

  const data = {
    weight_g: weightG != null && touched.weight ? Math.round(weightG) : weightG,
    length_cm: lenCm != null && touched.length ? Math.round(lenCm * 10) / 10 : lenCm,
    head_cm: headCm != null && touched.head ? Math.round(headCm * 10) / 10 : headCm,
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
    if (touched.at && at !== e?.data.at) changed.at = at;
    return Object.keys(changed).length ? changed : undefined;
  };

  const save = async () => {
    if (busy || timeInvalid) return;
    setBusy(true);
    try {
      const noteVal = note.trim() || null;
      const bits = [
        data.weight_g != null && formatWeight(data.weight_g, sys),
        data.length_cm != null && formatLength(data.length_cm, sys),
        data.head_cm != null && `head ${formatLength(data.head_cm, sys)}`,
      ].filter(Boolean);
      const p = pW ?? pL ?? pH;
      const pLine = p ? ` · ${p.label} percentile` : "";
      if (e) {
        const res = await update(
          e.id,
          {
            data: editData(),
            started_at: when && when.getTime() !== Date.parse(e.started_at) ? when.toISOString() : undefined,
            note: noteVal,
          },
          { toast: `Updated · ${bits.join(" · ")}${pLine}` }
        );
        if (res) onClose();
        return;
      }
      const saved = await log(
        { kind: "growth", started_at: when?.toISOString(), data: Object.fromEntries(Object.entries(data).filter(([, v]) => v != null)), note: noteVal },
        { toast: `${bits.join(" · ")}${pLine} · ${clock(t)}` }
      );
      if (saved) onClose();
    } finally {
      setBusy(false);
    }
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
      dirty={dirty}
      locked={busy}
      onClose={onClose}
      title={e ? describeEntry(e).title : "Growth"}
      footer={
        <fieldset disabled={busy} className="min-w-0">
          <SheetFooter
            onClose={onClose}
            onDelete={e ? del : undefined}
            onPrimary={() => void save()}
            label={e ? "Save" : "Log it"}
            busy={busy}
            disabled={timeInvalid || checks.invalid || !savable || (!!e && e.id < 0)}
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
        </fieldset>
      }
    >
      <fieldset disabled={busy} aria-busy={busy} className="min-w-0 space-y-5">
        {e && <LoggedBy entry={e} />}

        {/* Where and which units, side by side: both set how the numbers below read. */}
        <div className="flex gap-3">
          <div className="min-w-0 flex-1">
            <Label>Weighed at</Label>
            <Segmented<"home" | "doctor" | "">
              value={at ?? ""}
              onChange={(next) => { if (next) { touch("at"); setAt(next); } }}
              options={[
                { value: "doctor", label: "Doctor" },
                { value: "home", label: "Home" },
              ]}
            />
          </div>
          <div className="min-w-0 flex-1">
            <Label>Units</Label>
            <fieldset disabled={checks.invalid} className="min-w-0">
              <Segmented<UnitSystem>
                value={sys}
                onChange={switchUnits}
                options={[
                  { value: "us", label: "lb · in" },
                  { value: "metric", label: "g · cm" },
                ]}
              />
            </fieldset>
            {checks.invalid && <p className="mt-1.5 text-xs text-mp-danger">Correct the number before changing units.</p>}
          </div>
        </div>

        <section aria-label="Weight">
          {/* Keep enough space for the measured numbers on narrow phones. */}
          <Label optional className="mb-0">
            Weight
          </Label>
          {us ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <MiniStepper key="lb" label={null} unit="lb" ariaLabel="pounds" value={lb} onChange={(v) => editWeight("lb", v)} max={40} onInvalid={checks.watch("lb")} />
              <MiniStepper key="oz" label={null} unit="oz" ariaLabel="ounces" value={oz} onChange={(v) => editWeight("oz", v)} step={0.1} decimals={1} max={15.9} onInvalid={checks.watch("oz")} />
            </div>
          ) : (
            <MiniStepper key="grams" label={null} unit="g" ariaLabel="grams" value={grams} onChange={(v) => editWeight("g", v)} step={10} max={30000} onInvalid={checks.watch("grams")} />
          )}
          <Reading p={pW} warn={off("weight", weightG, rW)} extra={!us && weightG ? `${(weightG / 1000).toFixed(2)} kg` : undefined} />
        </section>

        <div className="grid gap-3 sm:grid-cols-2">
          <section aria-label="Length">
            <MiniStepper label={`Length`} unit={lenUnit} ariaLabel={`length in ${us ? "inches" : "centimetres"}`} value={length} onChange={(v) => editLength("length", v)} step={us ? 0.25 : 0.5} decimals={2} max={us ? 50 : 130} onInvalid={checks.watch("length")} />
            <Reading p={pL} warn={off("length", lenCm, rL)} compact />
          </section>
          <section aria-label="Head">
            <MiniStepper label={`Head`} unit={lenUnit} ariaLabel={`head circumference in ${us ? "inches" : "centimetres"}`} value={head} onChange={(v) => editLength("head", v)} step={us ? 0.25 : 0.5} decimals={2} max={us ? 25 : 60} onInvalid={checks.watch("head")} />
            <Reading p={pH} warn={off("head", headCm, rH)} compact />
          </section>
        </div>

        <WhenField value={when} onChange={setWhen} onInvalidChange={setTimeInvalid} tz={tz} offsets={[30, 60, 120, 240]} />
        <NoteField value={note} onChange={setNote} placeholder="Anything the doctor said?" />
        {sex == null ? (
          <ContextNote>
            WHO&apos;s growth standards are separate for girls and boys. {w.Name}&apos;s sex isn&apos;t set, so there are no percentiles here.
          </ContextNote>
        ) : (
          !bornAt && <ContextNote>Percentiles show up once {w.his} birth time is added.</ContextNote>
        )}
        <ContextNote icon="scale">{WEIGHT_GAIN_NOTE}</ContextNote>
      </fieldset>
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
  const w = useBabyWords();
  if (warn) {
    // Colored like NumberProblem's "Check this number": a number to look at again, not an alert.
    return (
      <p className="mt-1.5 flex gap-1.5 text-xs leading-snug font-medium text-mp-danger">
        <Icon name="circle-alert" size={14} className="mt-px shrink-0" />
        <span>Double-check this one. Maybe lb vs kg, or in vs cm?</span>
      </p>
    );
  }
  if (!p && !extra) return null;
  return (
    <p className={cx(tone.muted, "mt-1.5 text-xs")}>
      {extra}
      {extra && p ? " · " : ""}
      {p ? (compact ? `${p.label} percentile` : `About the ${p.label} percentile for ${w.his} age (WHO)`) : ""}
    </p>
  );
}
