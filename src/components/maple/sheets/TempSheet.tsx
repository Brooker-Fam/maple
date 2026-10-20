"use client";

import { useMemo, useState } from "react";
import { describeEntry, entryEmoji } from "@/lib/maple/describe";
import { EMERGENCY_SIGNS, assessTemperature, assessVitals, earThermometerOk } from "@/lib/maple/guidelines";
import { cToF, fToC, formatTemp } from "@/lib/maple/units";
import { TEMP_METHODS, type EntryOf, type TempMethod } from "@/lib/maple/types";
import { Chip, Segmented, Sheet, Stepper, WhenField, cx, tone } from "../ui";
import type { SheetProps } from "./index";
import {
  AssessmentCard,
  CHECK_NUMBER_HINT,
  ContextNote,
  Label,
  LoggedBy,
  MoreDetails,
  NoteField,
  SheetFooter,
  presetStart,
  pstr,
  useOpenCount,
  useNumberChecks,
  useSheetBase,
  useTouched,
} from "./parts";

/**
 * Log or edit a temperature, in °F or °C to a tenth, with how it was taken
 * (it changes what the number means: an armpit reading of 99°F means
 * "recheck", a rectal 100.4°F means "call now" at her age). The guidance from
 * guidelines.ts shows as you type; nothing shows when there's nothing to say
 * (never an "all clear"). Heart rate, breathing and oxygen live under "Other
 * readings" and save as their own vitals entry.
 */

const METHOD_LABEL: Record<TempMethod, string> = { rectal: "Rectal", armpit: "Armpit", forehead: "Forehead", ear: "Ear" };
const r1 = (n: number) => Math.round(n * 10) / 10;

export default function TempSheet(props: SheetProps) {
  const n = useOpenCount(props.open);
  return <TempForm key={n} {...props} />;
}

function TempForm({ open, onClose, entry, preset }: SheetProps) {
  const { tz, units, state, log, update, remove, now, ageMonths, clock } = useSheetBase();
  const e = entry?.kind === "temp" ? entry : undefined;
  const [unit, setUnit] = useState<"F" | "C">(units === "metric" ? "C" : "F");

  const temps = useMemo(
    () => (state?.entries ?? []).filter((x): x is EntryOf<"temp"> => x.kind === "temp" && x.id !== e?.id),
    [state, e?.id]
  );
  const earlierVitals = useMemo(
    () => (state?.entries ?? []).filter((x): x is EntryOf<"vitals"> => x.kind === "vitals"),
    [state]
  );

  const [value, setValue] = useState<number | null>(() => {
    const c = e?.data.temp_c;
    if (c == null) return units === "metric" ? 37 : 98.6;
    return units === "metric" ? r1(c) : r1(cToF(c));
  });
  const [method, setMethod] = useState<TempMethod | undefined>(
    () => e?.data.method ?? (pstr(preset, "method") as TempMethod | undefined) ?? temps[0]?.data.method
  );
  const [when, setWhen] = useState<Date | null>(() => (e ? new Date(e.started_at) : presetStart(preset)));
  const [note, setNote] = useState(e?.note ?? pstr(preset, "note") ?? "");
  const [busy, setBusy] = useState(false);
  const checks = useNumberChecks();
  // Only a typed or stepped reading is re-sent on edit (°F ↔ °C display rounding would drift it).
  const { touched, touch } = useTouched();
  // Other readings (new entries only; they save as a separate vitals entry).
  const [heart, setHeart] = useState<number | null>(null);
  const [resp, setResp] = useState<number | null>(null);
  const [spo2, setSpo2] = useState<number | null>(null);

  const switchUnit = (u: "F" | "C") => {
    if (u === unit) return;
    if (value != null) setValue(u === "C" ? r1(fToC(value)) : r1(cToF(value)));
    setUnit(u);
  };

  const tempC = value == null ? null : unit === "C" ? value : fToC(value);
  // Only judge a finished-looking number (not "10" on the way to "100.4").
  const plausible = tempC != null && tempC >= 32 && tempC <= 43;
  const looksLikeC = unit === "F" && value != null && value >= 34 && value <= 43;
  const t = when ?? now();
  const prev = temps.find((x) => Date.parse(x.started_at) < t.getTime());
  const previous = prev ? { tempC: prev.data.temp_c, minutesBefore: (t.getTime() - Date.parse(prev.started_at)) / 60_000 } : null;
  const assessment = plausible ? assessTemperature(tempC!, method, ageMonths, previous) : null;

  const vitals = { heart_bpm: heart ?? undefined, resp_rate: resp ?? undefined, spo2: spo2 ?? undefined };
  const hasVitals = heart != null || resp != null || spo2 != null;
  // Each measure's baseline is the previous reading of that same measure (as in the vitals sheet).
  const vitalNotes = (["spo2", "resp_rate", "heart_bpm"] as const).flatMap((f) => {
    if (vitals[f] == null) return [];
    const p = earlierVitals.find((x) => Date.parse(x.started_at) < t.getTime() && x.data[f] != null);
    return assessVitals({ [f]: vitals[f] }, ageMonths, p ? { [f]: p.data[f], minutesBefore: (t.getTime() - Date.parse(p.started_at)) / 60_000 } : null);
  });

  const methods = TEMP_METHODS.filter((m) => m !== "ear" || earThermometerOk(ageMonths) || method === "ear");
  const savable = tempC != null && tempC >= 30 && tempC <= 45;

  const save = async () => {
    if (tempC == null) return;
    const temp_c = Math.round(tempC * 1000) / 1000;
    const data: Record<string, unknown> = { temp_c, method };
    const noteVal = note.trim() || null;
    const shown = `${formatTemp(temp_c, unit === "C" ? "metric" : "us")}${method ? ` · ${method}` : ""}`;
    if (e) {
      setBusy(true);
      const res = await update(
        e.id,
        {
          data: { ...(touched.reading ? { temp_c } : {}), method: method ?? null },
          started_at: when && when.getTime() !== Date.parse(e.started_at) ? when.toISOString() : undefined,
          note: noteVal,
        },
        { toast: `Updated · ${shown}` }
      );
      setBusy(false);
      if (res) onClose();
      return;
    }
    onClose();
    // Both at the same instant so they line up in the timeline.
    const at = (when ?? now()).toISOString();
    void log(
      { kind: "temp", started_at: at, data: method ? data : { temp_c }, note: noteVal },
      { toast: `Temperature ${shown} · ${clock(at)}`, emoji: "🌡️" }
    );
    if (hasVitals) {
      const clean = Object.fromEntries(Object.entries(vitals).filter(([, v]) => v != null));
      void log({ kind: "vitals", started_at: at, data: clean }, { toast: "Other readings saved", emoji: "💓" });
    }
  };

  const del = () => {
    if (!e) return;
    onClose();
    void remove(e.id, { toast: "Temperature deleted" });
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={e ? describeEntry(e).title : "Temperature"}
      emoji={e ? entryEmoji(e) : "🌡️"}
      footer={
        <SheetFooter
          onClose={onClose}
          onDelete={e ? del : undefined}
          onPrimary={() => void save()}
          label={e ? "Save" : "Log it"}
          busy={busy}
          disabled={checks.invalid || !savable || (!!e && e.id < 0)}
          hint={
            checks.invalid ? CHECK_NUMBER_HINT : !savable ? "Enter the reading." : e && e.id < 0 ? "Still syncing, so it can't be edited yet." : undefined
          }
        />
      }
    >
      {e && <LoggedBy entry={e} />}

      <div>
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <Label className="mb-0">Reading</Label>
          <Segmented<"F" | "C">
            value={unit}
            onChange={switchUnit}
            options={[
              { value: "F", label: "°F" },
              { value: "C", label: "°C" },
            ]}
            className="w-28"
          />
        </div>
        <Stepper
          value={value}
          onChange={(v) => {
            touch("reading");
            setValue(v);
          }}
          onInvalid={checks.watch("reading")}
          step={0.1}
          decimals={1}
          min={unit === "F" ? 90 : 32}
          max={unit === "F" ? 110 : 43}
          suffix={unit === "F" ? "°F" : "°C"}
          ariaLabel={`temperature in degrees ${unit === "F" ? "Fahrenheit" : "Celsius"}`}
        />
        {looksLikeC && (
          <button type="button" onClick={() => {
              // The number typed is already °C: relabel it, don't convert it.
              touch("reading");
              setUnit("C");
            }} className="mt-2 min-h-[40px] text-sm font-semibold text-[#1D4420] underline decoration-[#C49A3C] underline-offset-4 dark:text-[#E0C27A]">
            That looks like °C. Switch to °C?
          </button>
        )}
      </div>

      <div>
        <Label>How did you take it?</Label>
        <div className="flex flex-wrap gap-2">
          {methods.map((m) => (
            <Chip key={m} selected={method === m} onClick={() => setMethod(method === m ? undefined : m)}>
              {METHOD_LABEL[m]}
            </Chip>
          ))}
        </div>
        {!earThermometerOk(ageMonths) && <p className={cx(tone.muted, "mt-1.5 text-xs")}>Rectal is the most accurate at her age. Ear thermometers aren&apos;t reliable before 6 months.</p>}
      </div>

      {assessment && <AssessmentCard a={assessment} />}

      <WhenField value={when} onChange={setWhen} tz={tz} />
      <NoteField value={note} onChange={setNote} placeholder="How is she acting? Feeding, sleepy, fussy…" />

      {!e && (
        <MoreDetails label="Other readings" summary={hasVitals ? "saved as vitals" : "heart, breathing, oxygen"}>
          <div>
            <Label optional>Heart rate</Label>
            <Stepper value={heart} onChange={setHeart} onInvalid={checks.watch("heart")} step={5} min={30} max={260} suffix="bpm" ariaLabel="heart rate, beats per minute" />
          </div>
          <div>
            <Label optional>Breathing</Label>
            <Stepper value={resp} onChange={setResp} onInvalid={checks.watch("resp")} step={1} min={5} max={150} suffix="/min" ariaLabel="breaths per minute" />
            <p className={cx(tone.muted, "mt-1 text-xs")}>Count for a full minute while she&apos;s calm or asleep.</p>
          </div>
          <div>
            <Label optional>Oxygen (SpO₂)</Label>
            <Stepper value={spo2} onChange={setSpo2} onInvalid={checks.watch("spo2")} step={1} min={50} max={100} suffix="%" ariaLabel="oxygen saturation percent" />
          </div>
          {vitalNotes.map((a) => (
            <AssessmentCard key={a.title} a={a} />
          ))}
          <ContextNote emoji="🚑">{EMERGENCY_SIGNS}</ContextNote>
        </MoreDetails>
      )}
    </Sheet>
  );
}
