"use client";

import { useMemo, useState } from "react";
import { describeEntry, entryEmoji } from "@/lib/maple/describe";
import { EMERGENCY_SIGNS, JAUNDICE_HOWTO, JAUNDICE_LABEL, assessJaundice, assessVitals } from "@/lib/maple/guidelines";
import { JAUNDICE_LEVELS, type EntryOf, type JaundiceLevel, type VitalsData } from "@/lib/maple/types";
import { Chip, Sheet, Stepper, WhenField, cx, tone } from "../ui";
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
  withNulls,
} from "./parts";

/**
 * Other readings: heart rate, breathing, oxygen, and the daylight skin check
 * for jaundice. Notes for the pediatrician, not monitoring: an odd first
 * reading asks for a recount, and the guidance says who to call.
 *
 * Opened as "Skin check" (preset { jaundice: "none" }) it leads with the skin
 * check and tucks the numbers away; otherwise the other way round.
 */

const H = 3_600_000;

export default function VitalsSheet(props: SheetProps) {
  const n = useOpenCount(props.open);
  return <VitalsForm key={n} {...props} />;
}

function VitalsForm({ open, onClose, entry, preset }: SheetProps) {
  const { tz, state, log, update, remove, now, ageMonths, bornAt, clock } = useSheetBase();
  const e = entry?.kind === "vitals" ? entry : undefined;
  const d: Partial<VitalsData> = e?.data ?? {};
  const presetLevel = pstr(preset, "jaundice") as JaundiceLevel | undefined;
  // Skin-check mode: asked for one, or editing an entry that's only a skin check.
  const skinMode = e ? d.jaundice != null && d.heart_bpm == null && d.resp_rate == null && d.spo2 == null : presetLevel !== undefined;

  const earlier = useMemo(
    () => (state?.entries ?? []).filter((x): x is EntryOf<"vitals"> => x.kind === "vitals" && x.id !== e?.id),
    [state, e?.id]
  );

  const [heart, setHeart] = useState<number | null>(d.heart_bpm ?? null);
  const [resp, setResp] = useState<number | null>(d.resp_rate ?? null);
  const [spo2, setSpo2] = useState<number | null>(d.spo2 ?? null);
  const [level, setLevel] = useState<JaundiceLevel | undefined>(() => d.jaundice ?? (JAUNDICE_LEVELS.includes(presetLevel as JaundiceLevel) ? presetLevel : undefined));
  const [when, setWhen] = useState<Date | null>(() => (e ? new Date(e.started_at) : presetStart(preset)));
  const [note, setNote] = useState(e?.note ?? pstr(preset, "note") ?? "");
  const [busy, setBusy] = useState(false);
  const checks = useNumberChecks();

  const t = when ?? now();
  const ago = (x: EntryOf<"vitals">) => (t.getTime() - Date.parse(x.started_at)) / 60_000;
  // Each measure's baseline is the previous reading of that same measure.
  const prevOf = (f: "heart_bpm" | "resp_rate" | "spo2") =>
    earlier.find((x) => Date.parse(x.started_at) < t.getTime() && x.data[f] != null);
  const prevJ = earlier.find((x) => Date.parse(x.started_at) < t.getTime() && x.data.jaundice != null);

  const vitals = { heart_bpm: heart ?? undefined, resp_rate: resp ?? undefined, spo2: spo2 ?? undefined };
  const vitalNotes = (["spo2", "resp_rate", "heart_bpm"] as const).flatMap((f) => {
    if (vitals[f] == null) return [];
    const prev = prevOf(f);
    return assessVitals({ [f]: vitals[f] }, ageMonths, prev ? { [f]: prev.data[f], minutesBefore: ago(prev) } : null);
  });
  // Without a birth time we can't tell her first day from her fifth, so skip that one rule.
  const ageHours = bornAt ? (t.getTime() - Date.parse(bornAt)) / H : 24;
  const skinNote = level ? assessJaundice(level, ageHours, prevJ ? { level: prevJ.data.jaundice!, minutesBefore: ago(prevJ) } : null) : null;

  const hasVitals = heart != null || resp != null || spo2 != null;
  const hasAny = hasVitals || level != null;
  const data = { ...vitals, jaundice: level };

  const save = async () => {
    const noteVal = note.trim() || null;
    const bits = [
      level && (level === "none" ? "no yellow" : `yellow: ${JAUNDICE_LABEL[level].toLowerCase()}`),
      heart != null && `heart ${heart}`,
      resp != null && `breathing ${resp}/min`,
      spo2 != null && `SpO₂ ${spo2}%`,
    ].filter(Boolean);
    const what = !hasVitals ? "Skin check" : "Vitals";
    if (e) {
      setBusy(true);
      const res = await update(
        e.id,
        {
          data: withNulls(data, ["heart_bpm", "resp_rate", "spo2", "jaundice"]),
          started_at: when && when.getTime() !== Date.parse(e.started_at) ? when.toISOString() : undefined,
          note: noteVal,
        },
        { toast: `${what} updated` }
      );
      setBusy(false);
      if (res) onClose();
      return;
    }
    onClose();
    void log(
      { kind: "vitals", started_at: when?.toISOString(), data: Object.fromEntries(Object.entries(data).filter(([, v]) => v != null)), note: noteVal },
      { toast: `${what} · ${bits.join(" · ")} · ${clock(t)}`, emoji: !hasVitals ? "🌼" : "💓" }
    );
  };

  const del = () => {
    if (!e) return;
    onClose();
    void remove(e.id, { toast: "Reading deleted" });
  };

  const numbers = (
    <>
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
    </>
  );

  const skin = (
    <>
      <div>
        <ContextNote emoji="☀️" className="mb-2.5">
          {JAUNDICE_HOWTO}
        </ContextNote>
        <Label>Any yellow?</Label>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="How far the yellow has spread">
          {JAUNDICE_LEVELS.map((l) => (
            <Chip key={l} selected={level === l} onClick={() => setLevel(level === l ? undefined : l)}>
              {JAUNDICE_LABEL[l]}
            </Chip>
          ))}
        </div>
      </div>
      {skinNote && <AssessmentCard a={skinNote} />}
      {!bornAt && level && level !== "none" && (
        <ContextNote emoji="🌱">Add her birth time so the app can tell whether this is her first day (yellow in the first 24 hours needs a call right away).</ContextNote>
      )}
    </>
  );

  const levelSummary = level ? JAUNDICE_LABEL[level] : undefined;
  const numberSummary = [heart != null && `${heart} bpm`, resp != null && `${resp}/min`, spo2 != null && `${spo2}%`].filter(Boolean).join(", ") || undefined;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={e ? (skinMode ? "Skin check" : describeEntry(e).title) : skinMode ? "Skin check" : "Vitals"}
      emoji={e && !skinMode ? entryEmoji(e) : skinMode ? "🌼" : "💓"}
      footer={
        <SheetFooter
          onClose={onClose}
          onDelete={e ? del : undefined}
          onPrimary={() => void save()}
          label={e ? "Save" : "Log it"}
          busy={busy}
          disabled={checks.invalid || !hasAny || (!!e && e.id < 0)}
          hint={checks.invalid ? CHECK_NUMBER_HINT : !hasAny ? (skinMode ? "Pick what you see." : "Add a reading.") : undefined}
        />
      }
    >
      {e && <LoggedBy entry={e} />}
      {skinMode ? (
        <>
          {skin}
          <MoreDetails label="Other readings" summary={numberSummary ?? "heart, breathing, oxygen"}>
            {numbers}
          </MoreDetails>
        </>
      ) : (
        <>
          {numbers}
          <MoreDetails label="Skin check" summary={levelSummary ?? "jaundice"}>
            {skin}
          </MoreDetails>
        </>
      )}
      <WhenField value={when} onChange={setWhen} tz={tz} />
      <NoteField value={note} onChange={setNote} placeholder="How is she acting?" />
      <p className={cx(tone.muted, "rounded-2xl border border-[#B5452B]/20 px-3.5 py-2.5 text-[13px] leading-relaxed dark:border-[#E07A5F]/25")}>
        <span aria-hidden>🚑 </span>
        {EMERGENCY_SIGNS}
      </p>
    </Sheet>
  );
}
