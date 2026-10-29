"use client";

import { useDraftChanged } from "../useDraftChanged";

import { useState } from "react";
import { describeEntry } from "@/lib/maple/describe";
import { formatDuration } from "@/lib/maple/time";
import { formatVolume, mlToOz, ozToMl } from "@/lib/maple/units";
import { Segmented, Sheet, TimeRange, WhenField } from "../ui";
import type { SheetProps } from "./index";
import { useSavedEntryConflict } from "./useSavedEntryConflict";
import {
  CHECK_NUMBER_HINT,
  LoggedBy,
  MiniStepper,
  NoteField,
  RunningNote,
  SheetFooter,
  SideLabel,
  presetStart,
  pnum,
  pstr,
  useNumberChecks,
  useOpenCount,
  useSheetBase,
  useTouched,
} from "./parts";

export default function PumpSheet(props: SheetProps) {
  const n = useOpenCount(props.open);
  return <PumpForm key={`${n}-${props.entry?.updated_at ?? "new"}`} {...props} />;
}

function PumpForm({ open, onClose, entry, preset }: SheetProps) {
  const { tz, units, log, update, remove, now } = useSheetBase();
  const e = entry?.kind === "pump" ? entry : undefined;
  const { changed: entryChanged, onConflict, notice } = useSavedEntryConflict(e);
  const running = !!e?.active;
  const metric = units === "metric";
  const toDisplay = (ml: number | undefined) => {
    if (ml == null) return null;
    if (metric) return ml;
    const oz = mlToOz(ml);
    return Number(oz > 0 && oz < 0.01 ? oz.toPrecision(3) : oz.toFixed(2));
  };
  const toMl = (v: number | null) => (v == null ? undefined : Math.round((metric ? v : ozToMl(v)) * 10) / 10);

  const initialLeft = e?.data.left_ml ?? pnum(preset, "left_ml");
  const initialRight = e?.data.right_ml ?? pnum(preset, "right_ml");
  const initialTotal = e?.data.total_ml ?? pnum(preset, "total_ml");
  const originalMode = initialLeft != null || initialRight != null ? "sides" : initialTotal != null ? "total" : "sides";
  const originalTotal = initialTotal ?? (initialLeft != null || initialRight != null ? (initialLeft ?? 0) + (initialRight ?? 0) : undefined);
  const [mode, setMode] = useState<"sides" | "total">(originalMode);
  const [left, setLeft] = useState<number | null>(() => toDisplay(initialLeft));
  const [right, setRight] = useState<number | null>(() => toDisplay(initialRight));
  // Keep the combined amount in ml so switching modes never re-rounds an
  // untouched recorded amount through the display unit.
  const [totalAmount, setTotalAmount] = useState(() => ({ ml: originalTotal, shown: toDisplay(originalTotal), entered: false }));
  const { ml: totalMl, shown: total } = totalAmount;
  const [range, setRange] = useState<[Date, Date]>(() => {
    if (e) {
      const s = new Date(e.started_at);
      return [s, e.ended_at ? new Date(e.ended_at) : running ? now() : s];
    }
    const presetEnd = pstr(preset, "ended_at");
    const end = presetEnd && Number.isFinite(Date.parse(presetEnd)) ? new Date(presetEnd) : now();
    const s = presetStart(preset);
    return s && s <= end ? [s, presetEnd ? end : s] : [end, end];
  });
  const [includeDuration, setIncludeDuration] = useState(() => !!e?.ended_at || (!e && range[1].getTime() > range[0].getTime()));
  const [note, setNote] = useState(e?.note ?? pstr(preset, "note") ?? "");
  const [busy, setBusy] = useState(false);
  const [timeInvalid, setTimeInvalid] = useState(false);
  const checks = useNumberChecks();
  const dirty = useDraftChanged({ timeInvalid, mode, left, right, totalMl, range, includeDuration, note, invalid: checks.invalid });
  const { touched, touch } = useTouched();
  const [start, end] = range;
  const durationInvalid = includeDuration && end.getTime() <= start.getTime();

  const data =
    mode === "sides"
      ? { left_ml: touched.left_ml ? toMl(left) : initialLeft, right_ml: touched.right_ml ? toMl(right) : initialRight, total_ml: undefined }
      : { left_ml: undefined, right_ml: undefined, total_ml: totalMl };
  const sum = mode === "sides" ? (data.left_ml ?? 0) + (data.right_ml ?? 0) : (data.total_ml ?? 0);
  const maxAmount = (ml: number | undefined, shown: number | null, entered: boolean | undefined, limit: number) =>
    metric ? limit : Math.max(Math.floor(mlToOz(limit) * 1000) / 1000, !entered && ml != null && ml <= limit ? shown ?? 0 : 0);
  const limitLabel = (limit: number) => metric ? `${limit} ml` : `${Math.floor(mlToOz(limit) * 1000) / 1000} oz (${limit} ml)`;
  const overLimit = (shown: number | null, entered: boolean | undefined, limit: number) =>
    !!entered && shown != null && (metric ? shown : ozToMl(shown)) > limit;
  const amountOverLimit = mode === "sides"
    ? overLimit(left, touched.left_ml, 600) || overLimit(right, touched.right_ml, 600)
    : overLimit(total, totalAmount.entered, 1200);
  const amountInvalid = checks.invalid || amountOverLimit;
  const step = metric ? 5 : 0.25;
  const edit = (key: "left_ml" | "right_ml", set: (v: number | null) => void) => (v: number | null) => {
    const l = key === "left_ml" ? toMl(v) : data.left_ml;
    const r = key === "right_ml" ? toMl(v) : data.right_ml;
    const ml = l != null || r != null ? (l ?? 0) + (r ?? 0) : undefined;
    touch(key);
    touch("total_ml");
    setTotalAmount({ ml, shown: toDisplay(ml), entered: false });
    set(v);
  };
  const unit = metric ? "ml" : "oz";
  const editTotal = (v: number | null) => {
    const ml = toMl(v);
    if (ml !== totalMl) {
      // Once the measured total changes, the previous side amounts no
      // longer describe it. Keep the new total until a split is entered.
      setLeft(null);
      setRight(null);
      touch("left_ml");
      touch("right_ml");
    }
    touch("total_ml");
    setTotalAmount({ ml, shown: v, entered: true });
  };
  const chooseMode = (next: "sides" | "total") => {
    if (next === mode || amountInvalid) return;
    if (next === "total") {
      const l = touched.left_ml ? toMl(left) : initialLeft;
      const r = touched.right_ml ? toMl(right) : initialRight;
      // A combined bottle can use the measured sum. An unchanged total
      // keeps those entries; an edited total cannot tell us their split.
      if (l != null || r != null) {
        const ml = (l ?? 0) + (r ?? 0);
        setTotalAmount({ ml, shown: toDisplay(ml), entered: false });
        touch("total_ml");
      }
    }
    setMode(next);
  };
  const needsSplit = mode === "sides" && totalMl != null && left == null && right == null;

  const save = async () => {
    if (busy || entryChanged || timeInvalid || durationInvalid || (!running && (amountInvalid || needsSplit))) return;
    setBusy(true);
    try {
      const noteVal = note.trim() || null;
      if (e) {
        const notePatch = noteVal !== (e.note?.trim() || null) ? { note: noteVal } : {};
        const changed: Record<string, unknown> = {};
        const fields = mode === "sides" ? (["left_ml", "right_ml"] as const) : (["total_ml"] as const);
        for (const k of fields) if (touched[k]) changed[k] = data[k] ?? null;
        if (mode !== originalMode || Object.keys(changed).length) {
          if (mode === "sides") changed.total_ml = null;
          else {
            changed.left_ml = null;
            changed.right_ml = null;
            if (!touched.total_ml) changed.total_ml = totalMl ?? null;
          }
        }
        const patch = running
          ? notePatch
          : {
              started_at: start.getTime() !== Date.parse(e.started_at) ? start.toISOString() : undefined,
              ended_at: (includeDuration ? end.toISOString() : null) !== e.ended_at ? includeDuration ? end.toISOString() : null : undefined,
              data: Object.keys(changed).length ? changed : undefined,
              ...notePatch,
            };
        const res = await update(e.id, { ...patch, expect_updated_at: e.updated_at }, { toast: "Pump updated", onConflict });
        if (res) onClose();
        return;
      }
      const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v != null));
      const details = [sum > 0 ? formatVolume(sum, units) : null, includeDuration ? formatDuration((end.getTime() - start.getTime()) / 1000) : null].filter(Boolean);
      const saved = await log(
        { kind: "pump", started_at: start.toISOString(), ended_at: includeDuration ? end.toISOString() : null, data: clean, note: noteVal },
        { toast: `Pumped${details.length ? ` ${details.join(" · ")}` : ""}` }
      );
      if (saved) onClose();
    } finally {
      setBusy(false);
    }
  };

  const del = () => {
    if (!e) return;
    onClose();
    void remove(e.id, { toast: "Pump deleted" });
  };

  return (
    <Sheet
      open={open}
      dirty={dirty}
      locked={busy}
      onClose={onClose}
      title={e ? describeEntry(e).title : "Pump"}
      footer={
        <fieldset disabled={busy} className="min-w-0">
          <SheetFooter
            onClose={onClose}
            onDelete={e ? del : undefined}
            onPrimary={() => void save()}
            label={e ? "Save" : "Log it"}
            busy={busy}
            disabled={entryChanged || timeInvalid || (!!e && e.id < 0) || (!running && (amountInvalid || needsSplit || durationInvalid))}
            hint={!running && amountInvalid ? CHECK_NUMBER_HINT : !running && needsSplit ? "Enter each side's amount, or choose Total to keep the combined amount." : !running && durationInvalid ? "Choose a duration, or turn off Include duration to leave it unrecorded." : e && e.id < 0 ? "Still syncing, so it can't be edited yet." : undefined}
          />
        </fieldset>
      }
    >
      <fieldset disabled={busy} aria-busy={busy} className="min-w-0 space-y-5">
        {e && <LoggedBy entry={e} />}
        {notice}
        {running && <RunningNote kind="pump" />}
        {!running && (
          <>
            <div>
              <fieldset disabled={amountInvalid} className="min-w-0">
                <Segmented
                  aria-label="Pumped amounts"
                  value={mode}
                  onChange={chooseMode}
                  options={[
                    { value: "sides", label: "Each side" },
                    { value: "total", label: "Total" },
                  ]}
                />
              </fieldset>
              {amountInvalid && <p className="mt-1.5 text-xs text-mp-danger">Correct the number before changing how amounts are entered.</p>}
            </div>
            {mode === "sides" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <MiniStepper key="left" label={<SideLabel side="L" />} unit={unit} ariaLabel={`left, ${unit}`} value={left} onChange={edit("left_ml", setLeft)} onInvalid={checks.watch("left")} step={step} decimals={metric ? 1 : 3} max={maxAmount(initialLeft, left, touched.left_ml, 600)} />
                <MiniStepper key="right" label={<SideLabel side="R" />} unit={unit} ariaLabel={`right, ${unit}`} value={right} onChange={edit("right_ml", setRight)} onInvalid={checks.watch("right")} step={step} decimals={metric ? 1 : 3} max={maxAmount(initialRight, right, touched.right_ml, 600)} />
              </div>
            ) : (
              <MiniStepper key="total" label="Total" unit={unit} ariaLabel={`total, ${unit}`} value={total} onChange={editTotal} onInvalid={checks.watch("total")} step={step} decimals={metric ? 1 : 3} max={maxAmount(totalMl, total, totalAmount.entered, 1200)} />
            )}
            {amountInvalid && <p role="alert" className="text-[13px] text-mp-danger">{mode === "sides" ? `Each side can be up to ${limitLabel(600)}.` : `The total can be up to ${limitLabel(1200)}.`} Correct the amount, or leave it blank if unknown.</p>}
            <label className="flex min-h-[44px] items-center gap-3 text-sm text-mp-ink">
              <input type="checkbox" checked={includeDuration} onChange={(event) => { setIncludeDuration(event.target.checked); setTimeInvalid(false); }} className="size-5 accent-mp-accent" />
              Include duration
            </label>
            {includeDuration ? (
              <TimeRange start={start} end={end} onInvalidChange={setTimeInvalid} tz={tz} durations={[10, 15, 20, 30, 45]} onChange={(s, en) => setRange([s, en])} />
            ) : (
              <WhenField value={start} onChange={(value) => { const at = value ?? now(); setRange([at, at]); }} onInvalidChange={setTimeInvalid} tz={tz} />
            )}
          </>
        )}
        <NoteField value={note} onChange={setNote} />
      </fieldset>
    </Sheet>
  );
}
