"use client";

import { useDraftChanged } from "../useDraftChanged";

import { useState } from "react";
import { describeEntry } from "@/lib/maple/describe";
import { formatDuration } from "@/lib/maple/time";
import { formatVolume, mlToOz, ozToMl } from "@/lib/maple/units";
import { Segmented, Sheet, TimeRange } from "../ui";
import type { SheetProps } from "./index";
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

/**
 * Log or edit a pumping session: Left and Right amounts (or just the total,
 * for a double pump into one bottle) and when it started and ended.
 */

const MIN = 60_000;

export default function PumpSheet(props: SheetProps) {
  const n = useOpenCount(props.open);
  return <PumpForm key={n} {...props} />;
}

function PumpForm({ open, onClose, entry, preset }: SheetProps) {
  const { tz, units, log, update, remove, now } = useSheetBase();
  const e = entry?.kind === "pump" ? entry : undefined;
  const running = !!e?.active;
  const metric = units === "metric";
  const toDisplay = (ml: number | undefined) => (ml == null ? null : metric ? Math.round(ml / 5) * 5 : Math.round(mlToOz(ml) * 4) / 4);
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
  const [totalAmount, setTotalAmount] = useState(() => ({ ml: originalTotal, shown: toDisplay(originalTotal) }));
  const { ml: totalMl, shown: total } = totalAmount;
  const [range, setRange] = useState<[Date, Date]>(() => {
    if (e) {
      const s = new Date(e.started_at);
      return [s, e.ended_at ? new Date(e.ended_at) : running ? now() : s];
    }
    const presetEnd = pstr(preset, "ended_at");
    const end = presetEnd && Number.isFinite(Date.parse(presetEnd)) ? new Date(presetEnd) : now();
    const s = presetStart(preset);
    return s && s <= end ? [s, end] : [new Date(end.getTime() - 15 * MIN), end];
  });
  const [note, setNote] = useState(e?.note ?? pstr(preset, "note") ?? "");
  const [busy, setBusy] = useState(false);
  const checks = useNumberChecks();
  const dirty = useDraftChanged({ mode, left, right, totalMl, range, note, invalid: checks.invalid });
  const { touched, touch } = useTouched();
  const [start, end] = range;

  const data =
    mode === "sides"
      ? { left_ml: touched.left_ml ? toMl(left) : initialLeft, right_ml: touched.right_ml ? toMl(right) : initialRight, total_ml: undefined }
      : { left_ml: undefined, right_ml: undefined, total_ml: totalMl };
  const sum = mode === "sides" ? (data.left_ml ?? 0) + (data.right_ml ?? 0) : (data.total_ml ?? 0);
  const step = metric ? 5 : 0.25;
  const edit = (key: "left_ml" | "right_ml" | "total_ml", set: (v: number | null) => void) => (v: number | null) => {
    touch(key);
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
    setTotalAmount({ ml, shown: v });
  };
  const chooseMode = (next: "sides" | "total") => {
    if (next === mode) return;
    if (next === "total") {
      const l = touched.left_ml ? toMl(left) : initialLeft;
      const r = touched.right_ml ? toMl(right) : initialRight;
      // A combined bottle can use the measured sum. An unchanged total
      // keeps those entries; an edited total cannot tell us their split.
      if (l != null || r != null) {
        const ml = (l ?? 0) + (r ?? 0);
        setTotalAmount({ ml, shown: toDisplay(ml) });
        touch("total_ml");
      }
    }
    setMode(next);
  };
  const needsSplit = mode === "sides" && totalMl != null && left == null && right == null;

  const save = async () => {
    const noteVal = note.trim() || null;
    if (e) {
      setBusy(true);
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
        ? { note: noteVal }
        : {
            started_at: start.getTime() !== Date.parse(e.started_at) ? start.toISOString() : undefined,
            ended_at: end.getTime() !== (e.ended_at ? Date.parse(e.ended_at) : NaN) ? end.toISOString() : undefined,
            data: Object.keys(changed).length ? changed : undefined,
            note: noteVal,
          };
      const res = await update(e.id, patch, { toast: "Pump updated" });
      setBusy(false);
      if (res) onClose();
      return;
    }
    onClose();
    const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v != null));
    const mins = formatDuration((end.getTime() - start.getTime()) / 1000);
    void log(
      { kind: "pump", started_at: start.toISOString(), ended_at: end.toISOString(), data: clean, note: noteVal },
      { toast: `Pumped ${sum > 0 ? `${formatVolume(sum, units)} · ` : ""}${mins}` }
    );
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
      onClose={onClose}
      title={e ? describeEntry(e).title : "Pump"}
      footer={
        <SheetFooter
          onClose={onClose}
          onDelete={e ? del : undefined}
          onPrimary={() => void save()}
          label={e ? "Save" : "Log it"}
          busy={busy}
          disabled={(!!e && e.id < 0) || (!running && (checks.invalid || needsSplit))}
          hint={!running && checks.invalid ? CHECK_NUMBER_HINT : !running && needsSplit ? "Enter each side's amount, or choose Total to keep the combined amount." : e && e.id < 0 ? "Still syncing, so it can't be edited yet." : undefined}
        />
      }
    >
      {e && <LoggedBy entry={e} />}
      {running && <RunningNote kind="pump" />}
      {!running && (
        <>
          <Segmented
            value={mode}
            onChange={chooseMode}
            options={[
              { value: "sides", label: "Each side" },
              { value: "total", label: "Total" },
            ]}
          />
          {mode === "sides" ? (
            <div className="grid grid-cols-2 gap-3">
              <MiniStepper key="left" label={<SideLabel side="L" />} unit={unit} ariaLabel={`left, ${unit}`} value={left} onChange={edit("left_ml", setLeft)} onInvalid={checks.watch("left")} step={step} decimals={metric ? 0 : 2} max={metric ? 600 : 20} />
              <MiniStepper key="right" label={<SideLabel side="R" />} unit={unit} ariaLabel={`right, ${unit}`} value={right} onChange={edit("right_ml", setRight)} onInvalid={checks.watch("right")} step={step} decimals={metric ? 0 : 2} max={metric ? 600 : 20} />
            </div>
          ) : (
            <MiniStepper key="total" label="Total" unit={unit} ariaLabel={`total, ${unit}`} value={total} onChange={editTotal} onInvalid={checks.watch("total")} step={step} decimals={metric ? 0 : 2} max={metric ? 1200 : 40} />
          )}
          <TimeRange start={start} end={end} tz={tz} durations={[10, 15, 20, 30, 45]} onChange={(s, en) => setRange([s, en])} />
        </>
      )}
      <NoteField value={note} onChange={setNote} />
    </Sheet>
  );
}
