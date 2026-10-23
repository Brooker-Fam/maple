"use client";

import { useState } from "react";
import { TUMMY_NOTE, tummyGoalMinutes } from "@/lib/maple/guidelines";
import { formatDuration } from "@/lib/maple/time";
import { KIND_COLOR } from "../palette";
import { Chip, Sheet, TimeRange, WhenField, cx, tone } from "../ui";
import type { SheetProps } from "./index";
import { ContextNote, Label, LoggedBy, NoteField, RunningNote, SheetFooter, presetStart, pstr, useOpenCount, useSheetBase } from "./parts";

/**
 * Tummy time (start and end, with her daily goal for context) and baths
 * (when, plus an optional length).
 */

const MIN = 60_000;
const BATH_MINUTES = [5, 10, 15, 20, 30];

export default function ActivitySheet(props: SheetProps) {
  const n = useOpenCount(props.open);
  return props.kind === "bath" ? <BathForm key={n} {...props} /> : <TummyForm key={n} {...props} />;
}

function TummyForm({ open, onClose, entry, preset }: SheetProps) {
  const { tz, summary, log, update, remove, now, ageDays, age } = useSheetBase();
  const e = entry?.kind === "tummy" ? entry : undefined;
  const running = !!e?.active;
  const [range, setRange] = useState<[Date, Date]>(() => {
    if (e) {
      const s = new Date(e.started_at);
      return [s, e.ended_at ? new Date(e.ended_at) : running ? now() : s];
    }
    const end = now();
    const s = presetStart(preset);
    return s && s < end ? [s, end] : [new Date(end.getTime() - 5 * MIN), end];
  });
  const [note, setNote] = useState(e?.note ?? pstr(preset, "note") ?? "");
  const [busy, setBusy] = useState(false);
  const [start, end] = range;
  const goal = summary?.targets?.tummyMin ?? tummyGoalMinutes(ageDays);
  const soFar = Math.round((summary?.today.tummySec ?? 0) / 60);

  const save = async () => {
    const noteVal = note.trim() || null;
    if (e) {
      setBusy(true);
      const patch = running
        ? { note: noteVal }
        : {
            started_at: start.getTime() !== Date.parse(e.started_at) ? start.toISOString() : undefined,
            ended_at: end.getTime() !== (e.ended_at ? Date.parse(e.ended_at) : NaN) ? end.toISOString() : undefined,
            note: noteVal,
          };
      const res = await update(e.id, patch, { toast: "Tummy time updated" });
      setBusy(false);
      if (res) onClose();
      return;
    }
    onClose();
    void log(
      { kind: "tummy", started_at: start.toISOString(), ended_at: end.toISOString(), data: {}, note: noteVal },
      { toast: `Tummy time ${formatDuration((end.getTime() - start.getTime()) / 1000)}` }
    );
  };

  const del = () => {
    if (!e) return;
    onClose();
    void remove(e.id, { toast: "Tummy time deleted" });
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Tummy time"
      footer={
        <SheetFooter
          onClose={onClose}
          onDelete={e ? del : undefined}
          onPrimary={() => void save()}
          label={e ? "Save" : "Log it"}
          busy={busy}
          disabled={!!e && e.id < 0}
          hint={e && e.id < 0 ? "Still syncing, so it can't be edited yet." : undefined}
        />
      }
    >
      {e && <LoggedBy entry={e} />}
      {running ? (
        <RunningNote kind="tummy" />
      ) : (
        <TimeRange start={start} end={end} tz={tz} durations={[3, 5, 10, 15, 20, 30]} onChange={(s, en) => setRange([s, en])} />
      )}
      <NoteField value={note} onChange={setNote} />
      {age && <TummyProgress soFar={soFar} goal={goal} />}
      <ContextNote>{TUMMY_NOTE}</ContextNote>
    </Sheet>
  );
}

function BathForm({ open, onClose, entry, preset }: SheetProps) {
  const { tz, log, update, remove, now, clock } = useSheetBase();
  const e = entry?.kind === "bath" ? entry : undefined;
  const [when, setWhen] = useState<Date | null>(() => (e ? new Date(e.started_at) : presetStart(preset)));
  const [minutes, setMinutes] = useState<number | null>(() =>
    e?.ended_at ? Math.round((Date.parse(e.ended_at) - Date.parse(e.started_at)) / MIN) || null : null
  );
  const [note, setNote] = useState(e?.note ?? pstr(preset, "note") ?? "");
  const [busy, setBusy] = useState(false);

  /** A bath that "just" happened with a length ends now, so it started that long ago. */
  const times = () => {
    let s = (when ?? now()).getTime();
    if (!minutes) return { start: new Date(s), end: null };
    const cap = now().getTime();
    if (s + minutes * MIN > cap) s = cap - minutes * MIN;
    return { start: new Date(s), end: new Date(s + minutes * MIN) };
  };
  const { start, end } = times();

  const save = async () => {
    const noteVal = note.trim() || null;
    if (e) {
      setBusy(true);
      const res = await update(
        e.id,
        { started_at: start.getTime() !== Date.parse(e.started_at) ? start.toISOString() : undefined, ended_at: end ? end.toISOString() : null, note: noteVal },
        { toast: "Bath updated" }
      );
      setBusy(false);
      if (res) onClose();
      return;
    }
    onClose();
    void log(
      { kind: "bath", started_at: start.toISOString(), ended_at: end?.toISOString(), data: {}, note: noteVal },
      { toast: `Bath${minutes ? ` ${minutes}m` : ""} · ${clock(start)}` }
    );
  };

  const del = () => {
    if (!e) return;
    onClose();
    void remove(e.id, { toast: "Bath deleted" });
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Bath"
      footer={
        <SheetFooter
          onClose={onClose}
          onDelete={e ? del : undefined}
          onPrimary={() => void save()}
          label={e ? "Save" : "Log it"}
          busy={busy}
          disabled={!!e && e.id < 0}
          hint={e && e.id < 0 ? "Still syncing, so it can't be edited yet." : undefined}
        />
      }
    >
      {e && <LoggedBy entry={e} />}
      <WhenField value={when} onChange={setWhen} tz={tz} offsets={[15, 30, 60, 120]} />
      <div>
        <Label optional>How long</Label>
        <div className="flex flex-wrap gap-2">
          {BATH_MINUTES.map((m) => (
            <Chip key={m} selected={minutes === m} onClick={() => setMinutes(minutes === m ? null : m)}>
              {m}m
            </Chip>
          ))}
        </div>
        {end && (
          <p className={cx(tone.muted, "mt-1.5 text-xs tabular-nums")}>
            {clock(start)} – {clock(end)}
          </p>
        )}
      </div>
      <NoteField value={note} onChange={setNote} placeholder="Sponge bath, first tub bath, hair wash…" />
    </Sheet>
  );
}

/** Today's tummy time against her daily goal: a plain sentence over a thin bar in the kind's color. */
function TummyProgress({ soFar, goal }: { soFar: number; goal: number }) {
  const pct = goal > 0 ? Math.min(100, (soFar / goal) * 100) : 0;
  return (
    <div>
      <p className={cx(tone.body, "text-[15px]")}>
        Today so far: <span className="font-semibold tabular-nums">{soFar} min</span>
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-mp-sunken" aria-hidden>
        <div className="mp-kind-fill h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: KIND_COLOR.tummy }} />
      </div>
      <p className={cx(tone.muted, "mt-1.5 text-[13px]")}>Goal about {goal} min a day at her age</p>
    </div>
  );
}
