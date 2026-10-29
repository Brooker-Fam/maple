"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { feedCtx, feedParts, isTracked, other } from "@/lib/maple/feed";
import { formatTime } from "@/lib/maple/time";
import { TAP_LOOKBACK_MS } from "@/lib/maple/timer-limits";
import type { Entry, Side } from "@/lib/maple/types";
import { SIDE_NAME, Spinner, TimeChip } from "../FeedParts";
import { RecordedTimeField } from "../TimeField";
import { useMaple, useNow, type TimerFailure } from "../useMaple";
import { useTimerActions } from "../useTimerActions";

const MINUTE = 60_000;
const currentSide = (entry: Entry, now: Date) => {
  const part = entry.kind === "feed" && entry.active ? feedParts(entry.data, feedCtx(entry, now)).at(-1) : null;
  return part?.kind === "side" && part.end === null && isTracked(part.side) ? part : null;
};

export default function SwitchEarlier({ start, live, onClose, tz, actionsContainer, onCommitting, onDirtyChange, onEditorActionsChange, onKnownEntry }: {
  start: Entry; live: Entry | null; onClose: () => void; tz: string;
  actionsContainer: HTMLElement | null; onCommitting: (value: boolean) => void; onDirtyChange: (value: boolean) => void;
  onEditorActionsChange: (value: boolean) => void; onKnownEntry: (entry: Entry) => void;
}) {
  const { now, readOnly, timerBusy } = useMaple();
  useNow();
  const currentTime = now();
  const actions = useTimerActions();
  const [base, setBase] = useState(() => ({ entry: start, openedAt: now() }));
  const [chosen, setChosen] = useState<Date | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [fieldVersion, setFieldVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<TimerFailure | null>(null);
  const lock = useRef(false);
  const failedEntry = failure?.entry;
  const latest = failedEntry && (!live || Date.parse(failedEntry.updated_at) > Date.parse(live.updated_at)) ? failedEntry : live;
  const changed = !!latest && latest.updated_at !== base.entry.updated_at;
  const gone = !live || failure?.kind === "gone";
  const part = currentSide(base.entry, base.openedAt);
  const side = part && isTracked(part.side) ? other(part.side) : null;
  const earliest = currentTime.getTime() - TAP_LOOKBACK_MS + MINUTE;
  const sideStart = part ? Date.parse(part.start) + MINUTE : base.openedAt.getTime();
  const minimum = new Date(Math.max(sideStart, earliest));
  const disabled = busy || readOnly || timerBusy(base.entry.id) || gone || changed || !side;
  useEffect(() => { onEditorActionsChange(!readOnly); }, [onEditorActionsChange, readOnly]);
  useLayoutEffect(() => { onDirtyChange(!!chosen || invalid); }, [chosen, invalid, onDirtyChange]);

  const choose = (value: Date) => {
    setChosen(value);
    setInvalid(false);
    setFieldVersion((version) => version + 1);
  };
  const useLatest = () => {
    if (!latest) return;
    setBase({ entry: latest, openedAt: now() });
    setChosen(null);
    setInvalid(false);
    setFailure(null);
    setFieldVersion((version) => version + 1);
  };
  const save = async () => {
    if (lock.current || disabled || invalid || !chosen || !side) return;
    if (chosen.getTime() < now().getTime() - TAP_LOOKBACK_MS + MINUTE) return setInvalid(true);
    lock.current = true;
    setBusy(true);
    onCommitting(true);
    setFailure(null);
    try {
      const result = await actions.switchEarlier(base.entry, side, chosen, { onError: (error) => {
        setFailure(error);
        if (error.entry) onKnownEntry(error.entry);
      } });
      if (result && !result.noop) onClose();
      else if (result?.noop) setFailure({ kind: "changed", message: "This side is already running. Review the latest feed before changing its time.", who: null, entry: result.entry });
    } finally {
      lock.current = false;
      setBusy(false);
      onCommitting(false);
    }
  };
  const footer = <SwitchFooter side={side} chosen={invalid ? null : chosen} tz={tz} busy={busy} disabled={disabled || invalid || !chosen} onClose={onClose} onSave={() => void save()} />;
  return <div className="space-y-4">
    {gone ? <p role="alert" className="text-[15px] text-mp-ink-2">This feed is no longer available. Nothing was saved.</p> : changed ? <div role="alert" className="space-y-2 rounded-xl bg-mp-sunken p-3">
      <p className="text-[15px] text-mp-ink">This feed changed on another device. Your time is still here; review the latest feed before saving.</p>
      <button type="button" disabled={busy} onClick={useLatest} className="min-h-[44px] rounded-xl bg-mp-surface px-4 text-[15px] font-semibold text-mp-accent-fg">Use latest</button>
    </div> : failure && <p role="alert" className="text-[15px] text-mp-danger">{failure.message}</p>}
    {side && part ? <>
      <div>
        <p className="text-[17px] font-semibold text-mp-ink">When did you switch to {SIDE_NAME[side]}?</p>
        <p className="mt-1 text-[13px] text-mp-ink-2">The log still shows {SIDE_NAME[part.side]} since {formatTime(part.start, tz)}.</p>
        {earliest > sideStart && <p className="mt-1 text-[13px] text-mp-ink-2">Switches can only be recorded within the last 4 hours.</p>}
      </div>
      <SwitchTimeChoices currentTime={currentTime} initialTime={base.openedAt} minimum={minimum} chosen={chosen} invalid={invalid} fieldVersion={fieldVersion} tz={tz} disabled={disabled} onChoose={(minutes) => choose(new Date(now().getTime() - minutes * MINUTE))} onChange={setChosen} onInvalidChange={setInvalid} />
    </> : <p className="text-[15px] text-mp-ink-2">This feed is not running on one side. Close this sheet and check the current timer.</p>}
    {!readOnly && (actionsContainer ? createPortal(footer, actionsContainer) : footer)}
  </div>;
}

function SwitchTimeChoices({ currentTime, initialTime, minimum, chosen, invalid, fieldVersion, tz, disabled, onChoose, onChange, onInvalidChange }: {
  currentTime: Date; initialTime: Date; minimum: Date; chosen: Date | null; invalid: boolean; fieldVersion: number; tz: string; disabled: boolean;
  onChoose: (minutes: number) => void; onChange: (value: Date) => void; onInvalidChange: (invalid: boolean) => void;
}) {
  return <fieldset disabled={disabled} className="space-y-3">
    <div role="group" aria-label="Earlier switch times" className="grid grid-cols-3 gap-2">
      {[1, 5, 10, 15, 20, 30].filter((minutes) => currentTime.getTime() - minutes * MINUTE >= minimum.getTime()).map((minutes) => {
        const at = new Date(currentTime.getTime() - minutes * MINUTE);
        return <TimeChip key={minutes} line1={`${minutes} min ago`} line2={formatTime(at, tz)} ariaLabel={`${minutes} min ago, ${formatTime(at, tz)}`} ring={!invalid && !!chosen && Math.floor(chosen.getTime() / MINUTE) === Math.floor(at.getTime() / MINUTE)} onClick={() => onChoose(minutes)} />;
      })}
    </div>
    <RecordedTimeField key={fieldVersion} label="Switched at" value={chosen ?? initialTime} onChange={onChange} tz={tz} min={minimum} max={currentTime} onInvalidChange={onInvalidChange} />
  </fieldset>;
}

function SwitchFooter({ side, chosen, tz, busy, disabled, onClose, onSave }: {
  side: Side | null; chosen: Date | null; tz: string; busy: boolean; disabled: boolean; onClose: () => void; onSave: () => void;
}) {
  return <div className="space-y-2">
    {chosen && side && <p className="text-[13px] text-mp-ink-2" aria-live="polite">{SIDE_NAME[side]} from {formatTime(chosen, tz)} · keeps running</p>}
    <div className="flex gap-2">
      <button type="button" disabled={busy} onClick={onClose} className="min-h-[48px] rounded-[14px] bg-mp-sunken px-5 text-[15px] font-semibold text-mp-ink disabled:opacity-45">Cancel</button>
      <button type="button" disabled={disabled} onClick={onSave} className="inline-flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-[14px] bg-mp-accent px-5 text-[15px] font-semibold text-mp-on-accent disabled:opacity-45">{busy ? <><Spinner />Saving…</> : "Save switch"}</button>
    </div>
  </div>;
}
