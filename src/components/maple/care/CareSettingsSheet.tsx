"use client";

import { useState, type InputHTMLAttributes } from "react";
import type { CareSettings } from "@/lib/maple/types";
import { SheetFooter, useOpenCount } from "../sheets/parts";
import { Segmented, Sheet, cx, tone } from "../ui";
import { Footnote, GROUP, Problem, SwitchRow, errorText } from "./parts";
import type { UseCare } from "./useCare";

const CHECKINS_LIVE = false;

/**
 * "Settings for this page" (§11.3, step 1). Her and the people she shares
 * with set the care team, the next OB visit and nursing; only she sets her
 * therapist and the check-in suggestions. A shared reader's save carries only
 * the keys they can see, so her therapist's number is never touched by it.
 */
type Feeding = "unset" | "yes" | "no";

export default function CareSettingsSheet(props: { open: boolean; onClose: () => void; care: UseCare }) {
  const n = useOpenCount(props.open);
  return <SettingsForm key={n} {...props} />;
}

function SettingsForm({ open, onClose, care }: { open: boolean; onClose: () => void; care: UseCare }) {
  const s = care.state.settings;
  const team = s.care_team ?? {};
  const her = care.access.therapist;
  const [ob, setOb] = useState(team.ob ?? "");
  const [after, setAfter] = useState(team.after_hours ?? "");
  const [pharmacy, setPharmacy] = useState(team.pharmacy ?? "");
  const [therapist, setTherapist] = useState(team.therapist ?? "");
  const [visit, setVisit] = useState(s.next_visit ?? "");
  const [feeding, setFeeding] = useState<Feeding>(s.feeding ?? "unset");
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

  return (
    <Sheet
      open={open}
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
        {her && <Footnote>Only you see your therapist&apos;s number. It never goes to anyone else or to any assistant.</Footnote>}
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

      {/* Check-ins land in the next step: no switch for them until then. */}
      {CHECKINS_LIVE && care.access.mood && (
        <div className={GROUP}>
          {<SwitchRow label="Check-in suggestions" note="Suggest a fuller check-in now and then. Only you see these." checked={suggest} onChange={setSuggest} />}
        </div>
      )}
    </Sheet>
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
