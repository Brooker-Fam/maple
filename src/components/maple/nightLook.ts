"use client";

import { useSyncExternalStore } from "react";

/**
 * The night look: a dim amber-on-black skin for 3am feeds, layered over the
 * site's dark theme. Per device (localStorage "maple-night"):
 *   auto   — 8pm–7am in the baby's timezone (the default)
 *   always — every time the app is open
 *   off    — follow the site theme only
 *
 * The shell (MapleApp) decides when it's on and sets html.maple-night; any
 * component can read the result with useNightActive() to skip motion
 * (leaf-falls, fireflies) and whimsy at night.
 */

export type NightPref = "auto" | "always" | "off";

export const NIGHT_KEY = "maple-night";
const PREF_EVENT = "maple-night-pref";

// Used when storage is blocked, so the toggle still works for this visit.
let memoryPref: NightPref = "auto";

export function readNightPref(): NightPref {
  try {
    const v = localStorage.getItem(NIGHT_KEY);
    return v === "always" || v === "off" ? v : "auto";
  } catch {
    return memoryPref;
  }
}

export function writeNightPref(pref: NightPref) {
  memoryPref = pref;
  try {
    if (pref === "auto") localStorage.removeItem(NIGHT_KEY);
    else localStorage.setItem(NIGHT_KEY, pref);
  } catch {
    // storage blocked: memoryPref carries it
  }
  window.dispatchEvent(new Event(PREF_EVENT));
}

function subscribePref(cb: () => void) {
  const onStorage = (e: StorageEvent) => e.key === NIGHT_KEY && cb();
  window.addEventListener(PREF_EVENT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(PREF_EVENT, cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function useNightPref(): [NightPref, (p: NightPref) => void] {
  const pref = useSyncExternalStore(subscribePref, readNightPref, () => "auto" as NightPref);
  return [pref, writeNightPref];
}

// ── Is the night look on right now? (set by the shell) ─────────────────

let active = false;
const listeners = new Set<() => void>();

export function setNightActive(on: boolean) {
  if (on === active) return;
  active = on;
  for (const l of listeners) l();
}

function subscribeActive(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useNightActive(): boolean {
  return useSyncExternalStore(subscribeActive, () => active, () => false);
}

// ── Theme color (iOS status bar / Android toolbar) ─────────────────────

export const THEME_COLORS = { day: "#FDF8F0", dark: "#0D1F0F", night: "#0B0F0A" } as const;
