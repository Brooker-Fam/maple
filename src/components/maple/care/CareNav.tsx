"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { OneTapAsk } from "@/lib/maple/types";
import { useAppNav } from "../AppNav";
import DoctorSheet from "../DoctorSheet";
import HelpSheet from "../HelpSheet";
import { MAPLE_OPEN_EVENT, type MapleOpenEvent } from "../notify";
import { useMaple } from "../useMaple";
import DoseSheet from "./DoseSheet";
import { MomTempSheet } from "./MomTempSheet";
import PlanPicker from "./PlanPicker";
import { requestQuestion } from "./Questions";
import SupportScreen from "./SupportScreen";
import WarningSignsSheet from "./WarningSigns";
import { useCare } from "./useCare";

/**
 * One place to open mom's page and sheets from anywhere (Today's strip, the
 * Lantern, More, Family, her own tab, a reminder's link): her tab, Support,
 * warning signs, the plan picker, the Dose sheet and her temperature; plus
 * the two shared sheets, Help and For the doctor. CareNavProvider is mounted
 * once in MapleApp, around SheetProvider (so Maple's MedSheet can reach it
 * too), and holds the sheets themselves. Her page is a tab (AppNav), not a
 * sheet: openCare() switches to it.
 */
export type CareNav = {
  /** Her tab. */
  openCare(): void;
  openSupport(): void;
  openSigns(): void;
  openPicker(): void;
  /** No planId: the one-off "Another medicine". `ask`: why "Took it" stopped to ask. */
  openDose(planId?: number, ask?: OneTapAsk, name?: string, start?: { at?: string; dose?: string }): void;
  /** "Another medicine", with what's already known filled in (Maple's medicine sheet: the name, time and dose). */
  openOneOff(name?: string, start?: { at?: string; dose?: string }): void;
  /** Her temperature sheet, straight away. */
  openTemp(): void;
  /** Her tab, at the "Questions for her OB" field (with `text` typed in, from Maple's note sheet). */
  openQuestion(text?: string): void;
  /** One Help sheet: Maple's emergency signs and numbers, her warning signs and help lines. */
  openHelp(): void;
  /** "For the doctor" (Maple's): questions to ask, the visit summary, her doctor's numbers. `ask` focuses the add field. */
  openDoctor(opts?: { ask?: boolean }): void;
};

// Outside a provider (a stray render in a test, say) every open does nothing.
const NONE: CareNav = {
  openCare: () => {},
  openSupport: () => {},
  openSigns: () => {},
  openPicker: () => {},
  openDose: () => {},
  openOneOff: () => {},
  openTemp: () => {},
  openQuestion: () => {},
  openHelp: () => {},
  openDoctor: () => {},
};

const CareNavContext = createContext<CareNav | null>(null);

export function useCareNav(): CareNav {
  return useContext(CareNavContext) ?? NONE;
}

type Simple = "support" | "signs" | "picker" | "temp" | "help" | "doctor";

/** A reminder's link: /maple?care=1 (her tab), with &plan=<id> for that medicine's Dose sheet. */
type Link = { plan: number | null };

function readLink(href: string): Link | null {
  try {
    const url = new URL(href, window.location.origin);
    if (url.searchParams.get("care") !== "1") return null;
    const id = Number(url.searchParams.get("plan"));
    return { plan: Number.isInteger(id) && id > 0 ? id : null };
  } catch {
    return null;
  }
}

/**
 * The sheets are siblings after the app, in stacking order: what opens from
 * another sits after it (warning signs and Support open from her tab and from
 * Help, the signs from Support, the Dose sheet from her rows), so the newer
 * one is on top and the one under it goes inert while it's open. Launchers
 * (More, the picker, Help, Maple's MedSheet) close themselves before opening
 * one.
 *
 * Each Dose sheet open gets its own key: "Took it" asking from a row, then
 * the server finding the other phone's dose, are two different questions,
 * and the second must not keep the first one's plan or answers.
 */
export function CareNavProvider({ children }: { children: ReactNode }) {
  const { state, toast } = useMaple();
  const care = useCare();
  const app = useAppNav();
  const [open, setOpen] = useState<Record<Simple, boolean>>({ support: false, signs: false, picker: false, temp: false, help: false, doctor: false });
  const [askDoctor, setAskDoctor] = useState(0);
  // The last Dose target stays mounted while its sheet slides away.
  const [dose, setDose] = useState<{ planId?: number; ask?: OneTapAsk; name?: string; start?: { at?: string; dose?: string }; seq: number } | null>(null);
  const [doseOpen, setDoseOpen] = useState(false);

  const show = useCallback((k: Simple) => setOpen((o) => ({ ...o, [k]: true })), []);
  const hide = useCallback((k: Simple) => setOpen((o) => ({ ...o, [k]: false })), []);
  const openDose = useCallback((planId?: number, ask?: OneTapAsk, name?: string, start?: { at?: string; dose?: string }) => {
    setDose((d) => ({ planId, ask, name, start, seq: (d?.seq ?? 0) + 1 }));
    setDoseOpen(true);
  }, []);
  const go = app.go;

  const nav = useMemo<CareNav>(
    () => ({
      openCare: () => go("care"),
      openSupport: () => show("support"),
      openSigns: () => show("signs"),
      openPicker: () => show("picker"),
      openDose,
      openOneOff: (name?: string, start?: { at?: string; dose?: string }) => openDose(undefined, undefined, name, start),
      openTemp: () => show("temp"),
      openQuestion: (text?: string) => {
        requestQuestion(text);
        go("care");
      },
      openHelp: () => show("help"),
      openDoctor: (opts?: { ask?: boolean }) => {
        setAskDoctor((n) => (opts?.ask ? n + 1 : 0));
        show("doctor");
      },
    }),
    [go, openDose, show]
  );

  // A reminder's tap opens /maple?care=1&plan=<id> (push.ts): her tab, and that medicine's Dose sheet while it's still
  // on her list (stopped or deleted since: her tab with a word). Old notices carry only care=1. Waits for her page.
  const hasCare = !!care;
  const route = useCallback(
    (link: Link) => {
      go("care");
      if (link.plan == null) return;
      const on = care?.plans.some((v) => v.plan.id === link.plan);
      if (on) openDose(link.plan);
      else toast("That medicine isn't on her list anymore.", { tone: "info" });
    },
    [care, go, openDose, toast]
  );
  useEffect(() => {
    if (!hasCare) return;
    const link = readLink(window.location.href);
    if (!link) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("care");
    url.searchParams.delete("plan");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    route(link);
    // Only on arrival: route changes with every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasCare]);

  // A tap on a notice while the app is already open: the notifications provider hands its URL over (MAPLE_OPEN_EVENT)
  // instead of letting the worker reload the page, so a half-filled sheet isn't lost. Handled here: say so.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const url = (e as MapleOpenEvent).detail?.url;
      const link = typeof url === "string" ? readLink(url) : null;
      // Not hers, or her page isn't readable here: the worker loads the page as asked.
      if (!link || !care) return;
      e.preventDefault();
      route(link);
    };
    window.addEventListener(MAPLE_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(MAPLE_OPEN_EVENT, onOpen);
  }, [care, route]);

  const closeSupport = useCallback(() => hide("support"), [hide]);
  const closeSigns = useCallback(() => hide("signs"), [hide]);
  const closePicker = useCallback(() => hide("picker"), [hide]);
  const closeTemp = useCallback(() => hide("temp"), [hide]);
  const closeHelp = useCallback(() => hide("help"), [hide]);
  const closeDoctor = useCallback(() => hide("doctor"), [hide]);
  const closeDose = useCallback(() => setDoseOpen(false), []);

  return (
    <CareNavContext.Provider value={nav}>
      {children}
      {/* Signed in only: before that there's nobody to show anything to. */}
      {state && (
        <>
          <HelpSheet open={open.help} onClose={closeHelp} />
          <DoctorSheet open={open.doctor} onClose={closeDoctor} ask={askDoctor} />
          <SupportScreen open={open.support} onClose={closeSupport} />
          <WarningSignsSheet open={open.signs} onClose={closeSigns} />
          <PlanPicker open={open.picker} onClose={closePicker} />
          {care && <MomTempSheet open={open.temp} onClose={closeTemp} care={care} />}
          {dose && <DoseSheet key={dose.seq} open={doseOpen} onClose={closeDose} planId={dose.planId} ask={dose.ask} name={dose.name} start={dose.start} />}
        </>
      )}
    </CareNavContext.Provider>
  );
}
