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

const TABS: { id: TabId; label: string; emoji: string }[] = [
  { id: "today", label: "Today", emoji: "🍁" },
  { id: "log", label: "Timeline", emoji: "📖" },
  { id: "patterns", label: "Patterns", emoji: "🌙" },
  { id: "moments", label: "Moments", emoji: "📸" },
  { id: "family", label: "Family", emoji: "🏡" },
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
        <button type="button" onClick={() => void refresh()} className="mt-3 min-h-[44px] rounded-full bg-[#1D4420] px-5 text-sm font-semibold text-[#FDF8F0]">
          Try again
        </button>
      </Splash>
    );
  }

  return (
    <div className="maple-app relative mx-auto min-h-[100dvh] w-full max-w-lg pb-[calc(88px+env(safe-area-inset-bottom))]">
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
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FDF8F0]/90 px-3 py-1.5 text-xs font-semibold text-[#5A3E12] shadow-sm ring-1 ring-[#C49A3C]/35 backdrop-blur-md dark:bg-[#12261A]/90 dark:text-[#F0DDB0] dark:ring-[#C49A3C]/30">
          <span aria-hidden>🍂</span>
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
      className="fixed inset-x-0 bottom-0 z-[70] border-t border-[#1D4420]/10 bg-[#FDF8F0]/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md dark:border-[#C49A3C]/15 dark:bg-[#0D1F0F]/90"
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
                "flex min-h-[64px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold tracking-wide transition",
                active ? "text-[#1D4420] dark:text-[#E0C27A]" : "text-[#1D4420]/50 dark:text-[#F5EDDF]/45"
              )}
            >
              <span className={cx("text-[22px] leading-none transition", active ? "scale-110" : "grayscale-[60%] opacity-80")} aria-hidden>
                {t.emoji}
              </span>
              {t.label}
              <span className={cx("mt-0.5 h-1 w-1 rounded-full", active ? "bg-[#C49A3C]" : "bg-transparent")} />
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
      <motion.div
        className="text-6xl"
        animate={{ rotate: [-8, 8, -8], y: [0, 6, 0] }}
        transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
        aria-hidden
      >
        🍁
      </motion.div>
      <p className={cx(tone.heading, "mt-3 text-2xl")}>Maple&apos;s Log</p>
      {children}
    </div>
  );
}
