"use client";

import { useState } from "react";
import { careTime } from "@/lib/maple/care";
import { DEFAULT_TZ } from "@/lib/maple/time";
import type { DoseEntry } from "@/lib/maple/types";
import { RecordedTimeField } from "../TimeField";
import { Button, Sheet, cx, tone } from "../ui";
import { ApiError, useMaple, useNow } from "../useMaple";
import { Problem, errorText } from "./parts";
import { type UseCare, useCare } from "./useCare";

/** A timestamp correction is separate from logging a dose or changing its medicine. */
export default function DoseTimeSheet(props: { open: boolean; onClose: () => void; dose: DoseEntry }) {
  const care = useCare();
  if (!care || !care.access.write) return null;
  return <DoseTimeForm {...props} care={care} />;
}

function DoseTimeForm({ open, onClose, dose, care }: { open: boolean; onClose: () => void; dose: DoseEntry; care: UseCare }) {
  const { state, refresh } = useMaple();
  const now = useNow(30_000);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const [base, setBase] = useState(dose);
  const [when, setWhen] = useState(new Date(dose.at));
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const current = care.state.entries.find((entry): entry is DoseEntry => entry.id === dose.id && entry.kind === "dose");
  const changed = !!current && current.updated_at !== base.updated_at;
  const gone = !current;
  const dirty = when.getTime() !== Date.parse(base.at);
  const reset = () => {
    if (!current) return;
    setBase(current);
    setWhen(new Date(current.at));
    setInvalid(false);
    setProblem(null);
    setRefused(false);
  };
  const close = () => { if (!busy) onClose(); };
  const save = async () => {
    if (busy || invalid || changed || gone || refused || !dirty) return;
    setBusy(true);
    setProblem(null);
    try {
      const saved = await care.act.editDoseTime(base, when.toISOString());
      if (saved) onClose();
    } catch (e) {
      setProblem(errorText(e));
      if (e instanceof ApiError && e.status === 409) {
        setRefused(true);
        void refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={close} title="Edit dose time" subtitle={dose.data.name} calm footer={
      <div className="space-y-3">
        <Problem className="mt-0">{problem}</Problem>
        <div className="flex flex-wrap gap-3">
          <Button variant="soft" size="lg" onClick={close} disabled={busy}>Cancel</Button>
          <Button size="lg" className="min-w-[140px] flex-1" onClick={() => void save()} disabled={busy || invalid || changed || gone || refused || !dirty}>
            {busy ? "Saving…" : "Save time"}
          </Button>
        </div>
      </div>
    }>
      {(changed || refused) && !busy && (
        <div role="status" className={cx(tone.inset, "space-y-2 p-3 text-[15px]")}>
          <p>This dose changed while you were editing. Your change hasn&apos;t been saved.</p>
          {changed ? <Button variant="soft" onClick={reset}>Use latest time</Button> : <Button variant="soft" onClick={() => void refresh()}>Refresh latest dose</Button>}
        </div>
      )}
      {gone && <p role="status" className={cx(tone.muted, "text-[15px]")}>This dose is no longer in the log. Your change hasn&apos;t been saved.</p>}
      <fieldset disabled={busy} className="min-w-0">
        <RecordedTimeField label={base.data.skipped ? "Skipped at" : "Taken at"} value={when} onChange={setWhen} onInvalidChange={setInvalid} tz={tz} max={new Date(now.getTime() + 60_000)} />
      </fieldset>
      <p className={cx(tone.muted, "text-[14px] leading-relaxed tabular-nums")}>
        {dirty ? <>Change {careTime(base.at, now, tz)} to <strong className="font-medium text-mp-ink">{careTime(when.toISOString(), now, tz)}</strong>.</> : <>Recorded {careTime(base.at, now, tz)}.</>}
      </p>
    </Sheet>
  );
}
