"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Entry, EntryKind } from "@/lib/maple/types";
import ActivitySheet from "./ActivitySheet";
import DiaperSheet from "./DiaperSheet";
import FeedSheet from "./FeedSheet";
import FixTimesSheet from "./FixTimesSheet";
import GrowthSheet from "./GrowthSheet";
import MedSheet from "./MedSheet";
import MomentSheet from "./MomentSheet";
import NoteSheet from "./NoteSheet";
import PumpSheet from "./PumpSheet";
import SleepSheet from "./SleepSheet";
import TempSheet from "./TempSheet";
import VitalsSheet from "./VitalsSheet";

/**
 * One place to open the log/edit form for any kind, from any tab:
 *   const { open } = useSheets();
 *   open({ kind: "diaper" })                      // log a new one
 *   open({ kind: "diaper", preset: { poop: true } })
 *   open({ kind: e.kind, entry: e })              // edit an existing entry
 *   open({ kind: e.kind, entry: e, preset: fixPreset("current") })  // Fix times (../FeedParts)
 *
 * Every sheet component takes SheetProps and renders a <Sheet> from ../ui.
 */

export type SheetTarget = {
  kind: EntryKind;
  /** Edit this entry instead of logging a new one. */
  entry?: Entry;
  /** Initial values for a new entry (kind-specific data fields, e.g. { method: "bottle" }). */
  preset?: Record<string, unknown>;
};

export type SheetProps = {
  open: boolean;
  onClose: () => void;
  kind: EntryKind;
  entry?: Entry;
  preset?: Record<string, unknown>;
};

const SHEETS: Record<EntryKind, (p: SheetProps) => ReactNode> = {
  feed: FeedSheet,
  pump: PumpSheet,
  diaper: DiaperSheet,
  sleep: SleepSheet,
  growth: GrowthSheet,
  temp: TempSheet,
  vitals: VitalsSheet,
  med: MedSheet,
  tummy: ActivitySheet,
  bath: ActivitySheet,
  moment: MomentSheet,
  note: NoteSheet,
};

type Ctx = { open: (t: SheetTarget) => void; close: () => void; current: SheetTarget | null };
const SheetContext = createContext<Ctx | null>(null);

export function useSheets(): Ctx {
  const ctx = useContext(SheetContext);
  if (!ctx) throw new Error("useSheets must be used inside <SheetProvider>");
  return ctx;
}

export function SheetProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<SheetTarget | null>(null);
  // Keep the last target mounted while the close animation runs.
  const [last, setLast] = useState<SheetTarget | null>(null);
  const open = useCallback((t: SheetTarget) => {
    setLast(t);
    setCurrent(t);
  }, []);
  const close = useCallback(() => setCurrent(null), []);
  const value = useMemo(() => ({ open, close, current }), [open, close, current]);
  const shown = current ?? last;
  // A preset with `fix` opens Fix times for that entry instead of its form.
  const fix = !!shown?.entry && !!shown.preset?.fix;
  const Comp = shown ? (fix ? FixTimesSheet : SHEETS[shown.kind]) : null;
  return (
    <SheetContext.Provider value={value}>
      {children}
      {Comp && shown && (
        <Comp
          key={fix ? `fix-${shown.entry!.id}` : `${shown.kind}-${shown.entry?.id ?? "new"}`}
          open={!!current}
          onClose={close}
          kind={shown.kind}
          entry={shown.entry}
          preset={shown.preset}
        />
      )}
    </SheetContext.Provider>
  );
}
