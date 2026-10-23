"use client";

import { useState } from "react";
import { describeEntry } from "@/lib/maple/describe";
import { SAFE_SLEEP_TIPS, SLEEP_TOTAL_NOTE } from "@/lib/maple/guidelines";
import { formatDuration } from "@/lib/maple/time";
import { SLEEP_PLACES, type SleepPlace } from "@/lib/maple/types";
import { Chip, Sheet, TimeRange } from "../ui";
import type { SheetProps } from "./index";
import {
  ContextNote,
  Label,
  LoggedBy,
  MoreDetails,
  NoteField,
  RunningNote,
  SheetFooter,
  presetStart,
  pstr,
  useOpenCount,
  useSheetBase,
  withNulls,
} from "./parts";

/**
 * Log a sleep after the fact (the dock's Sleep button runs the live timer),
 * or fix one: fell asleep / woke up, and where. Places are logged without
 * judgment; the few that aren't her bassinet get one soft safe-sleep line.
 * No "longest stretch" anything: at this age long sleeps aren't a goal.
 */

const PLACE: Record<SleepPlace, string> = {
  bassinet: "Bassinet",
  crib: "Crib",
  arms: "In arms",
  carrier: "Carrier",
  stroller: "Stroller",
  car: "Car seat",
  bed: "Grown-up bed",
};

const H = 3_600_000;

export default function SleepSheet(props: SheetProps) {
  const n = useOpenCount(props.open);
  return <SleepForm key={n} {...props} />;
}

function SleepForm({ open, onClose, entry, preset }: SheetProps) {
  const { tz, log, update, remove, now } = useSheetBase();
  const e = entry?.kind === "sleep" ? entry : undefined;
  const running = !!e?.active;

  const [range, setRange] = useState<[Date, Date]>(() => {
    if (e) {
      const s = new Date(e.started_at);
      return [s, e.ended_at ? new Date(e.ended_at) : running ? now() : s];
    }
    const end = now();
    const s = presetStart(preset);
    return s && s.getTime() < end.getTime() ? [s, end] : [new Date(end.getTime() - H), end];
  });
  const [place, setPlace] = useState<SleepPlace | undefined>(() => e?.data.place ?? (pstr(preset, "place") as SleepPlace | undefined));
  const [note, setNote] = useState(e?.note ?? pstr(preset, "note") ?? "");
  const [busy, setBusy] = useState(false);

  const [start, end] = range;
  const tip = place ? SAFE_SLEEP_TIPS[place] : undefined;

  const save = async () => {
    const noteVal = note.trim() || null;
    if (e) {
      setBusy(true);
      const patch = running
        ? { note: noteVal }
        : {
            started_at: start.getTime() !== Date.parse(e.started_at) ? start.toISOString() : undefined,
            ended_at: end.getTime() !== (e.ended_at ? Date.parse(e.ended_at) : NaN) ? end.toISOString() : undefined,
            data: withNulls({ place }, ["place"]),
            note: noteVal,
          };
      const res = await update(e.id, patch, { toast: "Sleep updated" });
      setBusy(false);
      if (res) onClose();
      return;
    }
    onClose();
    void log(
      { kind: "sleep", started_at: start.toISOString(), ended_at: end.toISOString(), data: place ? { place } : {}, note: noteVal },
      { toast: `Slept ${formatDuration((end.getTime() - start.getTime()) / 1000)}` }
    );
  };

  const del = () => {
    if (!e) return;
    onClose();
    void remove(e.id, { toast: "Sleep deleted" });
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={e ? describeEntry(e).title : "Sleep"}
      footer={
        <SheetFooter
          onClose={onClose}
          onDelete={e ? del : undefined}
          onPrimary={() => void save()}
          label={e ? "Save" : "Log it"}
          busy={busy}
          disabled={(!!e && e.id < 0) || (!running && end.getTime() < start.getTime())}
          hint={e && e.id < 0 ? "Still syncing, so it can't be edited yet." : undefined}
        />
      }
    >
      {e && <LoggedBy entry={e} />}
      {running ? (
        <RunningNote kind="sleep" />
      ) : (
        <TimeRange start={start} end={end} tz={tz} labels={["Fell asleep", "Woke up"]} onChange={(s, en) => setRange([s, en])} />
      )}

      {!running && (
        <MoreDetails summary={place ? PLACE[place] : undefined}>
          <div>
            <Label>Where</Label>
            <div className="flex flex-wrap gap-2">
              {SLEEP_PLACES.map((p) => (
                <Chip key={p} selected={place === p} onClick={() => setPlace(place === p ? undefined : p)}>
                  {PLACE[p]}
                </Chip>
              ))}
            </div>
            {tip && (
              <ContextNote icon="moon" className="mt-3">
                {tip}
              </ContextNote>
            )}
          </div>
        </MoreDetails>
      )}

      <NoteField value={note} onChange={setNote} />
      <ContextNote>{SLEEP_TOTAL_NOTE}</ContextNote>
    </Sheet>
  );
}
