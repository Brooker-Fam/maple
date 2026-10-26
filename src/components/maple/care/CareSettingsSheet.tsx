"use client";

import { useState, type InputHTMLAttributes } from "react";
import { EARLY_GRACE_CHOICES, EARLY_GRACE_DEFAULT_MIN } from "@/lib/maple/guidelines";
import type { CareSettings } from "@/lib/maple/types";
import { SheetFooter, useOpenCount } from "../sheets/parts";
import { Segmented, Sheet, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { ConfirmSheet, Footnote, GROUP, Problem, SwitchRow, errorText } from "./parts";
import type { UseCare } from "./useCare";

/**
 * "Settings for this page": the care team (her therapist too), the next OB
 * visit, nursing, early doses, check-in suggestions, and deleting the whole page.
 */
type Feeding = "unset" | "yes" | "no";

/** "Early doses" (earlyGraceMin in care.ts): the choices as the row shows them, and in words for its line. */
const graceLabel = (min: number) => (min === 0 ? "Off" : min < 60 ? `${min} min` : min === 60 ? "1 hour" : `${min / 60} hours`);
const graceWords = (min: number) => (min < 60 ? `${min} minutes` : min === 60 ? "an hour" : `${min / 60} hours`);
const GRACE_OPTIONS = EARLY_GRACE_CHOICES.map((m) => ({ value: String(m), label: graceLabel(m) }));
const graceOf = (v: number | null | undefined) => String(typeof v === "number" && (EARLY_GRACE_CHOICES as readonly number[]).includes(v) ? v : EARLY_GRACE_DEFAULT_MIN);

/** `onDeleted` (her screen only) adds "Delete this page"; opened from Support or warning signs it's just the settings. */
export default function CareSettingsSheet(props: { open: boolean; onClose: () => void; care: UseCare; onDeleted?: () => void }) {
  const n = useOpenCount(props.open);
  return <SettingsForm key={n} {...props} />;
}

function SettingsForm({ open, onClose, care, onDeleted }: { open: boolean; onClose: () => void; care: UseCare; onDeleted?: () => void }) {
  const { api, refresh } = useMaple();
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const s = care.state.settings;
  const team = s.care_team ?? {};
  const her = care.access.therapist;
  const [ob, setOb] = useState(team.ob ?? "");
  const [after, setAfter] = useState(team.after_hours ?? "");
  const [pharmacy, setPharmacy] = useState(team.pharmacy ?? "");
  const [therapist, setTherapist] = useState(team.therapist ?? "");
  const [visit, setVisit] = useState(s.next_visit ?? "");
  const [feeding, setFeeding] = useState<Feeding>(s.feeding ?? "unset");
  const [grace, setGrace] = useState(graceOf(s.early_grace_min));
  const [suggest, setSuggest] = useState(s.checkin_suggestions !== false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setProblem(null);
    const v = (x: string) => x.trim() || null;
    // A cleared field is sent as null (removed); a key left out is left alone.
    const care_team = { ob: v(ob), after_hours: v(after), pharmacy: v(pharmacy), ...(her ? { therapist: v(therapist) } : {}) } as CareSettings["care_team"];
    const settings: CareSettings = {
      care_team,
      next_visit: visit || null,
      feeding: feeding === "unset" ? null : feeding,
      // The default is stored as no setting, so it follows the default.
      early_grace_min: Number(grace) === EARLY_GRACE_DEFAULT_MIN ? null : Number(grace),
      ...(care.access.mood ? { checkin_suggestions: suggest } : {}),
    };
    try {
      await care.act.patchPerson({ settings });
      onClose();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteAll = async () => {
    setDeleting(true);
    try {
      await api("care/person", { method: "DELETE", body: JSON.stringify({ confirm: true }) });
      setConfirm(false);
      onDeleted?.();
      await refresh();
    } catch (e) {
      setConfirm(false);
      setProblem(errorText(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Sheet
        open={open && !confirm}
        onClose={onClose}
        title="Settings for this page"
        footer={
          <div>
            <Problem className="mt-0 mb-2 text-center">{problem}</Problem>
            <SheetFooter onClose={onClose} onPrimary={() => void save()} label="Save" busy={busy} />
          </div>
        }
      >
        <section>
          <h3 className={cx(tone.label, "mb-1.5 px-1")}>Care team</h3>
          <div className={GROUP}>
            <PhoneRow label="OB or midwife" value={ob} onChange={setOb} />
            <PhoneRow label="After-hours or labor and delivery line" value={after} onChange={setAfter} />
            <PhoneRow label="Pharmacy" value={pharmacy} onChange={setPharmacy} />
            {her && <PhoneRow label="Therapist" value={therapist} onChange={setTherapist} />}
          </div>
        </section>

        <section>
          <div className={GROUP}>
            <label className="flex min-h-[52px] items-center gap-3 px-4 py-1">
              <span className={cx(tone.body, "shrink-0 text-[15px]")}>Next OB visit</span>
              <input
                type="date"
                value={visit}
                onChange={(e) => setVisit(e.target.value)}
                aria-label="Next OB visit"
                className="ml-auto min-h-[44px] min-w-0 bg-transparent py-2 text-right text-base text-mp-ink outline-none"
              />
            </label>
          </div>
        </section>

        <section>
          <h3 className={cx(tone.label, "mb-1.5 px-1")}>Nursing or pumping</h3>
          <Segmented
            aria-label="Nursing or pumping"
            value={feeding}
            onChange={setFeeding}
            options={[
              { value: "unset", label: "Not set" },
              { value: "yes", label: "Yes" },
              { value: "no", label: "No" },
            ]}
          />
          <Footnote>While it&apos;s not set, the notes about nursing still show.</Footnote>
        </section>

        <section>
          <h3 className={cx(tone.label, "mb-1.5 px-1")}>Early doses</h3>
          <Segmented aria-label="Early doses" value={grace} onChange={setGrace} options={GRACE_OPTIONS} />
          <Footnote>
            {grace === "0"
              ? "Any dose logged before its OK time gets an early note. The 24-hour limit is always checked too."
              : `Doses logged a little before their OK time don't get an early note, up to ${graceWords(Number(grace))} early in all over a day (or an eighth of the time between doses, if that's less). Opioids are always checked exactly, and so is the 24-hour limit.`}
          </Footnote>
        </section>

        {care.access.mood && (
          <div className={GROUP}>
            <SwitchRow label="Check-in suggestions" note="Suggest a fuller check-in now and then." checked={suggest} onChange={setSuggest} />
          </div>
        )}

        {onDeleted && (
          <div className={GROUP}>
            <button type="button" onClick={() => setConfirm(true)} className={cx(tone.row, "min-h-[52px] py-2.5 text-[15px] font-medium text-mp-danger")}>
              Delete this page and everything on it
            </button>
          </div>
        )}
      </Sheet>
      <ConfirmSheet
        open={open && confirm}
        onClose={() => setConfirm(false)}
        title="Delete everything here for good?"
        body="Her medicines, readings, check-ins and questions will be deleted. This can't be undone."
        confirm="Delete for good"
        danger
        busy={deleting}
        onConfirm={() => void deleteAll()}
      />
    </>
  );
}

/** A phone field as a row: the label on the left, the number typed on the right (16px, so iOS doesn't zoom). */
function PhoneRow({ label, value, onChange, ...rest }: { label: string; value: string; onChange: (v: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, "onChange">) {
  return (
    <label className="flex min-h-[52px] items-center gap-3 px-4 py-1 transition focus-within:bg-mp-ink/[0.03]">
      <span className={cx(tone.body, "min-w-0 flex-1 text-[15px] leading-snug")}>{label}</span>
      <input
        {...rest}
        type="tel"
        inputMode="tel"
        autoComplete="off"
        maxLength={30}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        placeholder="Add"
        className="min-h-[44px] w-[9.5rem] shrink-0 bg-transparent py-2 text-right text-base text-mp-ink tabular-nums outline-none placeholder:text-mp-ink-3"
      />
    </label>
  );
}
