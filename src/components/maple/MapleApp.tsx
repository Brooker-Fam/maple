"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { WelcomeHost } from "./BirthSheet";
import FamilyTab from "./FamilyTab";
import LogTab from "./LogTab";
import MomentsTab from "./MomentsTab";
import PatternsTab from "./PatternsTab";
import SignIn from "./SignIn";
import TodayTab from "./TodayTab";
import { MAPLE_LEAF_PATH } from "./Hero";
import { Icon, type IconName } from "./icons";
import { THEME_COLORS, setNightActive, useNightPref } from "./nightLook";
import { SheetProvider } from "./sheets";
import { ToastHost, cx, tone } from "./ui";
import { MapleProvider, useMaple } from "./useMaple";

/**
 * Maple's Log app shell: provider, sign-in gate, and the bottom tab bar.
 * Logging never waits on the birth form: before she's born, Today shows the
 * waiting hero ("She's here!") above the same logging dock.
 *
 * The shell also owns the night look (html.maple-night, styled in
 * src/app/maple/maple.css), the browser theme-color, the sync chip, and the
 * birth welcome celebration.
 */

export type TabId = "today" | "log" | "patterns" | "moments" | "family";

const TABS: { id: TabId; label: string; icon: IconName }[] = [
  { id: "today", label: "Today", icon: "house" },
  { id: "log", label: "Timeline", icon: "list" },
  { id: "patterns", label: "Patterns", icon: "chart-column" },
  { id: "moments", label: "Moments", icon: "image" },
  { id: "family", label: "Family", icon: "users" },
];

const TAB_KEY = "maple-tab";

export default function MapleApp() {
  return (
    <MapleProvider>
      <SheetProvider>
        <Shell />
      </SheetProvider>
    </MapleProvider>
  );
}

function Shell() {
  return (
    <>
      <NightLook />
      <Screens />
    </>
  );
}

function Screens() {
  const { status, state, error, refresh } = useMaple();
  const [tab, setTab] = useState<TabId>("today");

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(TAB_KEY) as TabId | null;
      if (saved && TABS.some((t) => t.id === saved)) setTab(saved);
    } catch {
      // storage blocked
    }
  }, []);

  const go = (t: TabId) => {
    setTab(t);
    window.scrollTo({ top: 0 });
    try {
      sessionStorage.setItem(TAB_KEY, t);
    } catch {
      // storage blocked
    }
  };

  if (status === "loading") return <Splash />;
  if (status === "signedOut") return <SignIn />;
  if (status === "error" || !state) {
    return (
      <Splash>
        <p className={cx(tone.muted, "mt-4 text-sm")}>{error ?? "Couldn't reach Maple's log."}</p>
        <button type="button" onClick={() => void refresh()} className="mt-4 min-h-[44px] rounded-xl bg-mp-accent px-5 text-sm font-semibold text-mp-on-accent">
          Try again
        </button>
      </Splash>
    );
  }

  return (
    <div className="maple-app relative mx-auto min-h-[100dvh] w-full max-w-lg pb-[calc(80px+env(safe-area-inset-bottom))]">
      <SyncChip />
      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.18 }}
        >
          {tab === "today" && <TodayTab onNavigate={go} />}
          {tab === "log" && <LogTab />}
          {tab === "patterns" && <PatternsTab onNavigate={go} />}
          {tab === "moments" && <MomentsTab />}
          {tab === "family" && <FamilyTab />}
        </motion.div>
      </AnimatePresence>
      <TabBar tab={tab} onChange={go} />
      <ToastHost />
      <WelcomeHost />
    </div>
  );
}

/** The site's own theme choice (mirrors ThemeProvider), for when night ends. */
function siteWantsDark(): boolean {
  let t: string | null = null;
  try {
    t = localStorage.getItem("theme");
  } catch {
    // storage blocked: system theme
  }
  return t === "dark" || (t !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

/**
 * Night look: Auto (8pm–7am, baby's timezone), Always, or Off, per device.
 * While on, <html> carries .maple-night and .dark (held even if the site
 * theme flips underneath). Pure class toggles: no filter or transform on any
 * ancestor, so position:fixed sheets, dock and tab bar keep working.
 */
function NightLook() {
  const { isNight } = useMaple();
  const [pref] = useNightPref();
  const [, setTick] = useState(0);
  // Re-check the clock every minute so Auto flips at 8pm and 7am on its own.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const on = pref === "always" || (pref === "auto" && isNight());

  useEffect(() => {
    if (!on) return;
    const root = document.documentElement;
    root.classList.add("maple-night", "dark");
    setNightActive(true);
    const hold = new MutationObserver(() => {
      if (!root.classList.contains("dark")) root.classList.add("dark");
    });
    hold.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => {
      hold.disconnect();
      root.classList.remove("maple-night");
      root.classList.toggle("dark", siteWantsDark());
      setNightActive(false);
    };
  }, [on]);

  // Keep the status bar / browser chrome in step: cream by day, forest in
  // dark mode, near-black at night (so iOS doesn't flash a light bar at 3am).
  useEffect(() => {
    const root = document.documentElement;
    const metas = () => Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
    const originals = metas().map((m) => [m, m.content] as const);
    const apply = () => {
      const color = root.classList.contains("maple-night")
        ? THEME_COLORS.night
        : root.classList.contains("dark")
          ? THEME_COLORS.dark
          : THEME_COLORS.day;
      const list = metas();
      if (!list.length) {
        const m = document.createElement("meta");
        m.name = "theme-color";
        document.head.appendChild(m);
        list.push(m);
      }
      for (const m of list) if (m.content !== color) m.content = color;
    };
    apply();
    const watch = new MutationObserver(apply);
    watch.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => {
      watch.disconnect();
      for (const [m, c] of originals) m.content = c;
    };
  }, []);

  return null;
}

/** Shown only when something is waiting in the outbox or we're offline. */
function SyncChip() {
  const { pending, online, refresh } = useMaple();
  if (pending === 0 && online) return null;
  const text = online
    ? `${pending} waiting to sync`
    : pending
      ? `Offline · ${pending} saved on this phone`
      : "Offline";
  return (
    <div className="pointer-events-none sticky top-0 z-[65] flex justify-center px-4 pt-[env(safe-area-inset-top)]">
      <button
        type="button"
        onClick={() => void refresh()}
        aria-live="polite"
        aria-label={`${text}. Tap to try syncing now.`}
        className="pointer-events-auto flex min-h-[44px] items-center"
      >
        <span className="inline-flex items-center gap-1.5 rounded-full bg-mp-surface/95 px-3 py-1.5 text-xs font-semibold text-mp-ink-2 shadow-sm ring-1 ring-mp-line backdrop-blur-md">
          <Icon name={online ? "refresh-cw" : "cloud-off"} size={14} />
          {text}
        </span>
      </button>
    </div>
  );
}

function TabBar({ tab, onChange }: { tab: TabId; onChange: (t: TabId) => void }) {
  return (
    <nav
      aria-label="Maple's Log"
      className="fixed inset-x-0 bottom-0 z-[70] border-t border-mp-line bg-mp-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl"
    >
      <div className="mx-auto flex max-w-lg">
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id)}
              aria-current={active ? "page" : undefined}
              className={cx(
                "flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium transition",
                active ? "text-mp-accent-fg" : "text-mp-ink-3"
              )}
            >
              <Icon name={t.icon} size={24} strokeWidth={active ? 2.1 : 1.75} />
              {t.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function Splash({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6 text-center">
      <motion.svg
        viewBox="-11 -11 22 22"
        className="h-10 w-10 text-mp-maple"
        animate={{ opacity: [0.45, 1, 0.45] }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        aria-hidden
      >
        <path d={MAPLE_LEAF_PATH} fill="currentColor" />
      </motion.svg>
      <p className={cx(tone.display, "mt-3 text-[28px]")}>Maple&apos;s Log</p>
      {children}
    </div>
  );
}
