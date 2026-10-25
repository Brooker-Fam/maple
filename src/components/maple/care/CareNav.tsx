"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { OneTapAsk } from "@/lib/maple/types";
import { useMaple } from "../useMaple";
import CareScreen from "./CareScreen";
import DoseSheet from "./DoseSheet";
import PlanPicker from "./PlanPicker";
import SupportScreen from "./SupportScreen";
import WarningSignsSheet from "./WarningSigns";

/**
 * One place to open mom's full-height sheets from anywhere (Today, the
 * Lantern, More, Family, her own screen): her screen, Support, warning
 * signs, the plan picker and the Dose sheet. CareNavProvider is
 * mounted once in MapleApp, around SheetProvider (so Maple's MedSheet can
 * reach it too), and holds the sheets themselves.
 */
export type CareNav = {
  openCare(): void;
  openSupport(): void;
  openSigns(): void;
  openPicker(): void;
  /** No planId: the one-off "Another medicine". `ask`: why "Took it" stopped to ask. */
  openDose(planId?: number, ask?: OneTapAsk): void;
  /** "Another medicine", with the name filled in when it's known (Maple's medicine sheet). */
  openOneOff(name?: string): void;
};

// Outside a provider (a stray render in a test, say) every open does nothing.
const NONE: CareNav = {
  openCare: () => {},
  openSupport: () => {},
  openSigns: () => {},
  openPicker: () => {},
  openDose: () => {},
  openOneOff: () => {},
};

const CareNavContext = createContext<CareNav | null>(null);

export function useCareNav(): CareNav {
  return useContext(CareNavContext) ?? NONE;
}

type Simple = "care" | "support" | "signs" | "picker";

/**
 * The sheets are siblings after the app, in stacking order: what opens from
 * another sits after it (warning signs and Support open from her screen,
 * the signs from Support, the Dose sheet from her plan cards), so the newer
 * one is on top and the one under it goes inert while it's open. Launchers
 * (More, the picker, Maple's MedSheet) close themselves before opening one.
 *
 * Each Dose sheet open gets its own key: "Took it" asking from a card, then
 * the server finding the other phone's dose, are two different questions,
 * and the second must not keep the first one's plan or answers.
 */
export function CareNavProvider({ children }: { children: ReactNode }) {
  const { state } = useMaple();
  const [open, setOpen] = useState<Record<Simple, boolean>>({ care: false, support: false, signs: false, picker: false });
  // The last Dose target stays mounted while its sheet slides away.
  const [dose, setDose] = useState<{ planId?: number; ask?: OneTapAsk; name?: string; seq: number } | null>(null);
  const [doseOpen, setDoseOpen] = useState(false);

  const show = useCallback((k: Simple) => setOpen((o) => ({ ...o, [k]: true })), []);
  const hide = useCallback((k: Simple) => setOpen((o) => ({ ...o, [k]: false })), []);
  const openDose = useCallback((planId?: number, ask?: OneTapAsk, name?: string) => {
    setDose((d) => ({ planId, ask, name, seq: (d?.seq ?? 0) + 1 }));
    setDoseOpen(true);
  }, []);

  const nav = useMemo<CareNav>(
    () => ({
      openCare: () => show("care"),
      openSupport: () => show("support"),
      openSigns: () => show("signs"),
      openPicker: () => show("picker"),
      openDose,
      openOneOff: (name?: string) => openDose(undefined, undefined, name),
    }),
    [openDose, show]
  );

  // A reminder's tap opens /maple?care=1 (push.ts): her screen, once her page has loaded for this reader.
  const hasCare = !!state?.care;
  useEffect(() => {
    if (!hasCare) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("care") !== "1") return;
    url.searchParams.delete("care");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    show("care");
  }, [hasCare, show]);

  const closeCare = useCallback(() => hide("care"), [hide]);
  const closeSupport = useCallback(() => hide("support"), [hide]);
  const closeSigns = useCallback(() => hide("signs"), [hide]);
  const closePicker = useCallback(() => hide("picker"), [hide]);
  const closeDose = useCallback(() => setDoseOpen(false), []);

  return (
    <CareNavContext.Provider value={nav}>
      {children}
      {/* Signed in only: before that there's nobody to show anything to. */}
      {state && (
        <>
          <CareScreen open={open.care} onClose={closeCare} />
          <SupportScreen open={open.support} onClose={closeSupport} />
          <WarningSignsSheet open={open.signs} onClose={closeSigns} />
          <PlanPicker open={open.picker} onClose={closePicker} />
          {dose && <DoseSheet key={dose.seq} open={doseOpen} onClose={closeDose} planId={dose.planId} ask={dose.ask} name={dose.name} />}
        </>
      )}
    </CareNavContext.Provider>
  );
}
