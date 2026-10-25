"use client";

import { useMemo, useState } from "react";
import { normName, planNames } from "@/lib/maple/care";
import { describeEntry } from "@/lib/maple/describe";
import {
  BABY_FEVER_MED_NAMES,
  BABY_FEVER_MED_UNDER_3M_HINT,
  BABY_IBUPROFEN_NAMES,
  BABY_IBUPROFEN_UNDER_6M_HINT,
  VITAMIN_D_DEFAULT,
  VITAMIN_D_NOTE,
} from "@/lib/maple/guidelines";
import { isVitaminD } from "@/lib/maple/insights";
import type { CarePlan, EntryOf } from "@/lib/maple/types";
import { useCareNav } from "../care/CareNav";
import { useCare } from "../care/useCare";
import { Icon } from "../icons";
import { Chip, Sheet, WhenField, cx, tone } from "../ui";
import type { SheetProps } from "./index";
import { ContextNote, Label, LoggedBy, NoteField, SheetFooter, presetStart, pstr, useOpenCount, useSheetBase, withNulls } from "./parts";

/**
 * Vitamin D and any other medicine. The app never suggests a dose: the dose
 * box is free text, filled in only for vitamin D's standard 400 IU (and the
 * label wins if the drops say otherwise). Logging vitamin D twice in a day
 * gets a gentle heads-up so two caregivers don't double up.
 *
 * Mom's medicines live apart (§5.10): a name on her list says so here, with
 * a way over to her Dose sheet; the fever caution on any other name offers
 * her one-off sheet instead; and an existing entry can be moved across. The fever copy itself (AAP / Seattle Children's: no fever
 * medicine under 3 months, and no ibuprofen under 6 months, without the
 * doctor's OK) lives in guidelines.ts.
 */

/** One of her active, shared plans by this exact name or an Also called name (never vitamin D, which is Maple's every day). */
function herPlanNamed(name: string, plans: CarePlan[]): CarePlan | undefined {
  if (!name.trim() || isVitaminD(name)) return undefined;
  const n = normName(name);
  if (!n) return undefined;
  return plans.find((p) => planNames(p).includes(n));
}

export default function MedSheet(props: SheetProps) {
  const n = useOpenCount(props.open);
  return <MedForm key={n} {...props} />;
}

function MedForm({ open, onClose, entry, preset }: SheetProps) {
  const { tz, state, summary, log, update, remove, now, ageMonths, clock, memberName } = useSheetBase();
  const e = entry?.kind === "med" ? entry : undefined;
  const care = useCare();
  const careNav = useCareNav();

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
  const feverCaution = BABY_FEVER_MED_NAMES.test(name) && (ageMonths < 3 || (BABY_IBUPROFEN_NAMES.test(name) && ageMonths < 6));
  const herPlan = care ? herPlanNamed(name, care.plans.map((v) => v.plan)) : undefined;
  const careWrite = !!care?.access.write;
  const [moving, setMoving] = useState(false);
  const toCare = (fn: () => void) => {
    onClose();
    window.setTimeout(fn, 120);
  };
  // Closes first; useCare says "Moved to {Name}'s medicines" with Undo (or why it couldn't). Vitamin D is always Maple's.
  const move = () => {
    if (!e || !care || moving) return;
    setMoving(true);
    onClose();
    void care.act
      .moveFromMaple(e.id, herPlanNamed(e.data.name, care.plans.map((v) => v.plan))?.id)
      .catch(() => {})
      .finally(() => setMoving(false));
  };

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
        ? { toast: when ? `Vitamin D drops logged · ${clock(when)}` : "Vitamin D drops logged" }
        : { toast: `${n}${data.dose ? ` ${data.dose}` : ""} · ${clock(when ?? now())}` }
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
          <Chip selected={vitD} onClick={() => pickName(VITAMIN_D_DEFAULT.name)}>
            <Icon name="sun" size={16} />
            Vitamin D
          </Chip>
          {recent.map((r) => (
            <Chip key={r} selected={name.trim().toLowerCase() === r.toLowerCase()} onClick={() => pickName(r)}>
              <Icon name="pill" size={16} />
              {r}
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
        // A heads-up, not an alarm: two caregivers shouldn't both give the day's drops.
        <p className={cx(tone.inset, tone.body, "flex gap-2.5 px-3.5 py-3 text-sm leading-relaxed")}>
          <Icon name="circle-alert" size={18} className="mt-px shrink-0 text-mp-maple" />
          <span>
            Already logged today at {clock(givenToday.givenAt)}
            {givenToday.by ? ` by ${memberName(givenToday.by)}` : ""}. It&apos;s once a day, so check before giving another.
          </span>
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
        {!vitD && <p className={cx(tone.muted, "mt-1.5 text-xs")}>Follow the label or your pediatrician&apos;s instructions.</p>}
      </div>

      {herPlan && care && (
        <div role="status" className={cx(tone.inset, "px-4 py-3")}>
          <p className={cx(tone.body, "flex gap-2.5 text-sm leading-relaxed")}>
            <Icon name="pill" size={18} className="mt-px shrink-0 text-mp-ink-2" />
            <span>
              {care.self ? `You have ${herPlan.name} on your list.` : `${care.name} has ${herPlan.name} on her list.`} Logging it here is for{" "}
              {state ? (state.baby.nickname || state.baby.name).split(" ")[0] : "the baby"}.
            </span>
          </p>
          {careWrite && !e && (
            <button
              type="button"
              onClick={() => toCare(() => careNav.openDose(herPlan.id))}
              className="mt-1 -ml-1 min-h-[44px] rounded-lg px-1 text-sm font-semibold text-mp-accent-fg"
            >
              {care.self ? "Log it for yourself instead" : `Log it for ${care.name} instead`}
            </button>
          )}
        </div>
      )}

      {feverCaution && (
        <div role="status" className={cx(tone.body, "rounded-xl border-l-[3px] border-mp-maple bg-mp-maple/[0.08] px-4 py-3 text-sm leading-relaxed")}>
          <p className="flex gap-2.5">
            <Icon name="triangle-alert" size={18} className="mt-px shrink-0 text-mp-maple" />
            <span>{ageMonths < 3 ? BABY_FEVER_MED_UNDER_3M_HINT : BABY_IBUPROFEN_UNDER_6M_HINT}</span>
          </p>
          {careWrite && !herPlan && !e && care && (
            <button type="button" onClick={() => toCare(() => careNav.openOneOff(name.trim()))} className="mt-1 ml-[1.625rem] min-h-[44px] text-sm font-semibold text-mp-accent-fg">
              Is this for {care.self ? "you" : care.name}? Log it on {care.self ? "your" : "her"} medicines
            </button>
          )}
        </div>
      )}

      <WhenField value={when} onChange={setWhen} tz={tz} />
      <NoteField value={note} onChange={setNote} />
      {vitD && <ContextNote icon="sun">{VITAMIN_D_NOTE}</ContextNote>}
      {e && care && careWrite && !isVitaminD(e.data.name) && e.id > 0 && (
        <button
          type="button"
          disabled={moving}
          onClick={move}
          className={cx(tone.card, tone.row, "min-h-[52px] py-2.5 text-[15px] font-medium text-mp-accent-fg disabled:opacity-50")}
        >
          <Icon name="arrow-right" size={18} className="shrink-0" />
          {care.self ? "Move to my medicines" : `Move to ${care.name}'s medicines`}
        </button>
      )}
    </Sheet>
  );
}
