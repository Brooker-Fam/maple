"use client";

import { useMemo, useState } from "react";
import { describeEntry, entryEmoji } from "@/lib/maple/describe";
import { VITAMIN_D_DEFAULT, VITAMIN_D_NOTE } from "@/lib/maple/guidelines";
import { isVitaminD } from "@/lib/maple/insights";
import type { EntryOf } from "@/lib/maple/types";
import { Chip, Sheet, WhenField, cx, tone } from "../ui";
import type { SheetProps } from "./index";
import { ContextNote, Label, LoggedBy, NoteField, SheetFooter, presetStart, pstr, useOpenCount, useSheetBase, withNulls } from "./parts";

/**
 * Vitamin D and any other medicine. The app never suggests a dose: the dose
 * box is free text, filled in only for vitamin D's standard 400 IU (and the
 * label wins if the drops say otherwise). Logging vitamin D twice in a day
 * gets a gentle heads-up so two caregivers don't double up.
 */

// Copy from the pediatric research (AAP / Seattle Children's): no fever medicine
// under 3 months, and no ibuprofen under 6 months, without the doctor's OK.
const FEVER_MED = /acetaminophen|paracetamol|tylenol|ibuprofen|motrin|advil/i;
const IBUPROFEN = /ibuprofen|motrin|advil/i;

export default function MedSheet(props: SheetProps) {
  const n = useOpenCount(props.open);
  return <MedForm key={n} {...props} />;
}

function MedForm({ open, onClose, entry, preset }: SheetProps) {
  const { tz, state, summary, log, update, remove, now, ageMonths, clock, memberName } = useSheetBase();
  const e = entry?.kind === "med" ? entry : undefined;

  const [name, setName] = useState(() => e?.data.name ?? pstr(preset, "name") ?? VITAMIN_D_DEFAULT.name);
  const [dose, setDose] = useState(() => e?.data.dose ?? pstr(preset, "dose") ?? (isVitaminD(pstr(preset, "name") ?? VITAMIN_D_DEFAULT.name) ? VITAMIN_D_DEFAULT.dose : ""));
  const [when, setWhen] = useState<Date | null>(() => (e ? new Date(e.started_at) : presetStart(preset)));
  const [note, setNote] = useState(e?.note ?? pstr(preset, "note") ?? "");
  const [busy, setBusy] = useState(false);

  // Other medicines they've logged lately, as one-tap names (never their doses).
  const recent = useMemo(() => {
    const seen = new Map<string, string>();
    for (const x of state?.entries ?? []) {
      if (x.kind !== "med" || isVitaminD((x as EntryOf<"med">).data.name)) continue;
      const n = (x as EntryOf<"med">).data.name.trim();
      if (n && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
      if (seen.size >= 3) break;
    }
    return [...seen.values()];
  }, [state]);

  const vitD = isVitaminD(name);
  const pickName = (n: string) => {
    // Vitamin D's standard dose comes along; switching away clears it rather than carrying it over.
    if (isVitaminD(n) && !dose.trim()) setDose(VITAMIN_D_DEFAULT.dose);
    if (!isVitaminD(n) && dose === VITAMIN_D_DEFAULT.dose) setDose("");
    setName(n);
  };

  const givenToday = !e && vitD ? summary?.vitaminD : null;
  const feverCaution = FEVER_MED.test(name) && (ageMonths < 3 || (IBUPROFEN.test(name) && ageMonths < 6));

  const save = async () => {
    const n = name.trim();
    if (!n) return;
    const noteVal = note.trim() || null;
    const data = { name: n, dose: dose.trim() || undefined };
    if (e) {
      setBusy(true);
      const res = await update(
        e.id,
        {
          data: withNulls(data, ["dose"]),
          started_at: when && when.getTime() !== Date.parse(e.started_at) ? when.toISOString() : undefined,
          note: noteVal,
        },
        { toast: `${n} updated` }
      );
      setBusy(false);
      if (res) onClose();
      return;
    }
    onClose();
    void log(
      { kind: "med", started_at: when?.toISOString(), data: data.dose ? data : { name: n }, note: noteVal },
      isVitaminD(n)
        ? { toast: when ? `Vitamin D drops ✓ · ${clock(when)}` : "Vitamin D drops ✓", emoji: "☀️" }
        : { toast: `${n}${data.dose ? ` ${data.dose}` : ""} · ${clock(when ?? now())}`, emoji: "💊" }
    );
  };

  const del = () => {
    if (!e) return;
    onClose();
    void remove(e.id, { toast: `${e.data.name} deleted` });
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={e ? describeEntry(e).title : vitD ? "Vitamin D" : "Medicine"}
      emoji={e ? entryEmoji(e) : vitD ? "☀️" : "💊"}
      footer={
        <SheetFooter
          onClose={onClose}
          onDelete={e ? del : undefined}
          onPrimary={() => void save()}
          label={e ? "Save" : "Log it"}
          busy={busy}
          disabled={!name.trim() || (!!e && e.id < 0)}
          hint={!name.trim() ? "What was it?" : undefined}
        />
      }
    >
      {e && <LoggedBy entry={e} />}

      <div>
        <Label>What</Label>
        <div className="flex flex-wrap gap-2">
          <Chip selected={vitD} onClick={() => pickName(VITAMIN_D_DEFAULT.name)} className="min-h-[52px] py-1.5">
            <span aria-hidden className="text-lg">
              ☀️
            </span>
            <span className="flex flex-col items-start leading-tight">
              <span className="font-semibold">Vitamin D</span>
              <span className="text-[11px] font-normal opacity-80">sunshine drops</span>
            </span>
          </Chip>
          {recent.map((r) => (
            <Chip key={r} selected={name.trim().toLowerCase() === r.toLowerCase()} onClick={() => pickName(r)} className="min-h-[52px]">
              <span aria-hidden>💊</span> {r}
            </Chip>
          ))}
        </div>
        <input
          value={name}
          maxLength={80}
          onChange={(ev) => pickName(ev.target.value)}
          placeholder="Or type a name"
          aria-label="Medicine name"
          className={cx(tone.input, "mt-2.5")}
        />
      </div>

      {givenToday && (
        <p className="rounded-2xl bg-[#C49A3C]/15 px-3.5 py-2.5 text-sm leading-relaxed text-[#4A3A12] dark:bg-[#C49A3C]/15 dark:text-[#EFE0B8]">
          <span aria-hidden>☀️ </span>
          Already logged today at {clock(givenToday.givenAt)}
          {givenToday.by ? ` by ${memberName(givenToday.by)}` : ""}. It&apos;s once a day, so check before giving another.
        </p>
      )}

      <div>
        <Label optional>Dose</Label>
        <input
          value={dose}
          maxLength={80}
          onChange={(ev) => setDose(ev.target.value)}
          placeholder="As on the label"
          aria-label="Dose"
          className={tone.input}
        />
        {!vitD && <p className={cx(tone.muted, "mt-1 text-xs")}>Follow the label or your pediatrician&apos;s instructions.</p>}
      </div>

      {feverCaution && (
        <p className="rounded-2xl border-l-4 border-[#D9772B] bg-[#D9772B]/10 px-3.5 py-2.5 text-sm leading-relaxed text-[#5A3210] dark:bg-[#D9772B]/15 dark:text-[#F6DDBF]">
          {ageMonths < 3
            ? "At her age, fever medicine only if her pediatrician says so. If she has a fever, call them first."
            : "Ibuprofen isn't recommended under 6 months without your pediatrician's OK."}
        </p>
      )}

      <WhenField value={when} onChange={setWhen} tz={tz} />
      <NoteField value={note} onChange={setNote} />
      {vitD && <ContextNote emoji="☀️">{VITAMIN_D_NOTE}</ContextNote>}
    </Sheet>
  );
}
