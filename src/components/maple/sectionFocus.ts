"use client";

import { useEffect } from "react";
import { useAppNav } from "./AppNav";

/** One requested section survives the tab transition, then is consumed on mount. */
export type AppSection = "baby-details" | "doctor-contacts" | "phone-preferences" | "mom-medicines";
const EVENT = "maple-section-focus";
let pending: AppSection | null = null;

export function requestSection(section: AppSection): void {
  pending = section;
  window.dispatchEvent(new Event(EVENT));
}

export function useSectionFocus(page: "family" | "care", view?: string | null): void {
  const { tab } = useAppNav();
  useEffect(() => {
    let frame = 0;
    const focus = () => {
      const section = pending;
      if (tab !== page || !section || (section === "mom-medicines") !== (page === "care")) return;
      const target = document.getElementById(section);
      if (!target || target.closest("[hidden]")) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (pending !== section || !target.isConnected || target.closest("[hidden]")) return;
        pending = null;
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "start", behavior: "instant" });
      });
    };
    focus();
    window.addEventListener(EVENT, focus);
    return () => { cancelAnimationFrame(frame); window.removeEventListener(EVENT, focus); };
  }, [page, tab, view]);
}
