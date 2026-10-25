"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * Which tab is showing, lifted out of the shell so anything can switch it:
 * her strip's picker ("Brittany's page"), a reminder's deep link, More, the
 * help and doctor sheets. AppNavProvider sits outside CareNavProvider (which
 * opens her tab) and the shell (which draws the tab bar).
 *
 * Tabs: Today, hers ("care", hidden without access), History (Timeline |
 * Patterns), Moments and Family. "log" and "patterns" are still good targets:
 * they open History on that segment, and a tab saved by an older version of
 * the app ("log", "patterns") lands there too.
 */

export type TabId = "today" | "care" | "history" | "moments" | "family";
export type HistorySeg = "timeline" | "patterns";
/** A tab, or a History segment by its old tab name. */
export type NavTarget = TabId | "log" | "patterns";

export type AppNav = {
  tab: TabId;
  seg: HistorySeg;
  /** Switch tab (scrolled to the top). "log" / "patterns" open History on that segment. */
  go(t: NavTarget): void;
  /** The History segment, without leaving the tab. */
  setSeg(s: HistorySeg): void;
};

const TAB_KEY = "maple-tab";
const SEG_KEY = "maple-history-seg";

const NONE: AppNav = { tab: "today", seg: "timeline", go: () => {}, setSeg: () => {} };
const AppNavContext = createContext<AppNav | null>(null);

export function useAppNav(): AppNav {
  return useContext(AppNavContext) ?? NONE;
}

/** Where a target lands: its tab, and the History segment it picks (if any). */
function resolve(t: NavTarget): { tab: TabId; seg?: HistorySeg } {
  if (t === "log") return { tab: "history", seg: "timeline" };
  if (t === "patterns") return { tab: "history", seg: "patterns" };
  return { tab: t };
}

const isTarget = (s: string | null): s is NavTarget =>
  s === "today" || s === "care" || s === "history" || s === "moments" || s === "family" || s === "log" || s === "patterns";

function save(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // storage blocked: this tab only
  }
}

export function AppNavProvider({ children }: { children: ReactNode }) {
  const [tab, setTab] = useState<TabId>("today");
  const [seg, setSegState] = useState<HistorySeg>("timeline");

  // The tab this browser tab was on (sessionStorage), after hydration.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(TAB_KEY);
      const savedSeg = sessionStorage.getItem(SEG_KEY);
      if (savedSeg === "timeline" || savedSeg === "patterns") setSegState(savedSeg);
      if (isTarget(saved)) {
        const r = resolve(saved);
        setTab(r.tab);
        if (r.seg) setSegState(r.seg);
      }
    } catch {
      // storage blocked
    }
  }, []);

  const setSeg = useCallback((s: HistorySeg) => {
    setSegState(s);
    save(SEG_KEY, s);
  }, []);

  const go = useCallback(
    (t: NavTarget) => {
      const r = resolve(t);
      setTab(r.tab);
      if (r.seg) setSeg(r.seg);
      window.scrollTo({ top: 0 });
      save(TAB_KEY, r.tab);
    },
    [setSeg]
  );

  const value = useMemo<AppNav>(() => ({ tab, seg, go, setSeg }), [tab, seg, go, setSeg]);
  return <AppNavContext.Provider value={value}>{children}</AppNavContext.Provider>;
}
