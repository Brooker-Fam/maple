"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type TabId = "today" | "care" | "history" | "moments" | "chat" | "family";
export type HistorySeg = "timeline" | "patterns";
export type SettingsTarget = "family/baby" | "family/doctor" | "family/today" | "family/appearance" | "family/medical-records" | "family/people" | "family/memories";
export type NavTarget = TabId | "log" | "patterns" | SettingsTarget;

export type AppNav = {
  tab: TabId;
  seg: HistorySeg;
  go(t: NavTarget): boolean;
  setSeg(s: HistorySeg): void;
};

const TAB_KEY = "maple-tab";
const SEG_KEY = "maple-history-seg";
const NONE: AppNav = { tab: "today", seg: "timeline", go: () => false, setSeg: () => {} };
const AppNavContext = createContext<AppNav | null>(null);

export function useAppNav(): AppNav {
  return useContext(AppNavContext) ?? NONE;
}

function resolve(t: NavTarget): { tab: TabId; seg?: HistorySeg; settings?: SettingsTarget } {
  if (t === "log") return { tab: "history", seg: "timeline" };
  if (t === "patterns") return { tab: "history", seg: "patterns" };
  if (t === "family/baby" || t === "family/doctor" || t === "family/today" || t === "family/appearance" || t === "family/medical-records" || t === "family/people" || t === "family/memories") return { tab: "family", settings: t };
  return { tab: t };
}

const isTarget = (s: string | null): s is NavTarget =>
  s === "today" || s === "care" || s === "history" || s === "moments" || s === "chat" || s === "family" || s === "log" || s === "patterns";

function readHash(): { tab: TabId; seg?: HistorySeg } | null {
  const [target, segment] = window.location.hash.slice(1).split("/");
  if (!isTarget(target)) return null;
  const result = resolve(target);
  if (result.tab === "history" && (segment === "timeline" || segment === "patterns")) result.seg = segment;
  return result;
}

function save(key: string, value: string) {
  try { sessionStorage.setItem(key, value); } catch {}
}

function canNavigate(from: TabId, to: TabId): boolean {
  return from === to || window.dispatchEvent(new CustomEvent("maple-before-navigate", { cancelable: true, detail: { tab: to } }));
}

export function AppNavProvider({ children }: { children: ReactNode }) {
  const [tab, setTab] = useState<TabId>("today");
  const [seg, setSegState] = useState<HistorySeg>("timeline");
  const current = useRef({ tab, seg, url: "" });

  useEffect(() => {
    let initial = readHash();
    let initialSeg: HistorySeg = "timeline";
    try {
      const saved = sessionStorage.getItem(TAB_KEY);
      const savedSeg = sessionStorage.getItem(SEG_KEY);
      if (savedSeg === "timeline" || savedSeg === "patterns") initialSeg = savedSeg;
      if (!initial && isTarget(saved)) initial = resolve(saved);
    } catch {}
    const first = { tab: initial?.tab ?? "today", seg: initial?.seg ?? initialSeg };
    if (!readHash()) window.history.replaceState(window.history.state, "", `#${first.tab}${first.tab === "history" ? `/${first.seg}` : ""}`);
    current.current = { ...first, url: window.location.href };
    setTab(first.tab);
    setSegState(first.seg);
    const sync = () => {
      const next = readHash() ?? { tab: "today" as const };
      if (!canNavigate(current.current.tab, next.tab)) {
        window.history.pushState(window.history.state, "", current.current.url);
        return;
      }
      const nextSeg = next.seg ?? current.current.seg;
      current.current = { tab: next.tab, seg: nextSeg, url: window.location.href };
      setTab(next.tab);
      setSegState(nextSeg);
      save(TAB_KEY, next.tab);
      save(SEG_KEY, nextSeg);
    };
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  const setSeg = useCallback((nextSeg: HistorySeg) => {
    setSegState(nextSeg);
    current.current.seg = nextSeg;
    save(SEG_KEY, nextSeg);
    if (current.current.tab === "history") window.location.assign(`#history/${nextSeg}`);
  }, []);

  const go = useCallback((target: NavTarget) => {
    const next = resolve(target);
    if (!canNavigate(current.current.tab, next.tab)) return false;
    const nextSeg = next.seg ?? current.current.seg;
    const hash = next.settings ? `#${next.settings}` : `#${next.tab}${next.tab === "history" ? `/${nextSeg}` : ""}`;
    current.current = { tab: next.tab, seg: nextSeg, url: new URL(hash, window.location.href).href };
    setTab(next.tab);
    setSegState(nextSeg);
    save(TAB_KEY, next.tab);
    save(SEG_KEY, nextSeg);
    if (window.location.hash !== hash) window.location.assign(hash);
    window.scrollTo({ top: 0 });
    return true;
  }, []);

  const value = useMemo<AppNav>(() => ({ tab, seg, go, setSeg }), [tab, seg, go, setSeg]);
  return <AppNavContext.Provider value={value}>{children}</AppNavContext.Provider>;
}
