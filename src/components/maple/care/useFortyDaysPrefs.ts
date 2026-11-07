"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useMaple } from "../useMaple";

/**
 * The forty days card's two choices, kept on this phone for this person (like
 * the daily discoveries): hidden for one local day, or off. Nothing reaches
 * the server, so they never change what anyone else sees.
 */
type Prefs = { off: boolean; hiddenDay: string | null };
const DEFAULTS: Prefs = { off: false, hiddenDay: null };
const DEFAULT_JSON = JSON.stringify(DEFAULTS);
const EVENT = "maple-forty-days-prefs";
const memory = new Map<string, string>();
const serverSnapshot = () => null;

function read(key: string): string {
  const temporary = memory.get(key);
  if (temporary !== undefined) return temporary;
  try {
    return localStorage.getItem(key) ?? DEFAULT_JSON;
  } catch {
    return DEFAULT_JSON;
  }
}

function parse(raw: string | null): Prefs {
  try {
    const value = JSON.parse(raw ?? DEFAULT_JSON);
    if (!value || typeof value !== "object") return DEFAULTS;
    return {
      off: value.off === true,
      hiddenDay: typeof value.hiddenDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.hiddenDay) ? value.hiddenDay : null,
    };
  } catch {
    return DEFAULTS;
  }
}

export function useFortyDaysPrefs() {
  const { state } = useMaple();
  const key = state ? `maple-forty-days-v1:${state.family?.id ?? 1}:${state.baby.id}:${encodeURIComponent(state.me.email)}` : "";
  const subscribe = useCallback((notify: () => void) => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) {
        memory.delete(key);
        notify();
      }
    };
    window.addEventListener(EVENT, notify);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, notify);
      window.removeEventListener("storage", onStorage);
    };
  }, [key]);
  const snapshot = useCallback(() => (key ? read(key) : null), [key]);
  const raw = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const prefs = useMemo(() => parse(raw), [raw]);
  const update = useCallback((patch: Partial<Prefs>) => {
    if (!key) return;
    const next = JSON.stringify({ ...parse(read(key)), ...patch });
    // Private windows and full storage still keep the choice until the page reloads.
    memory.set(key, next);
    try {
      localStorage.setItem(key, next);
      memory.delete(key);
    } catch {}
    window.dispatchEvent(new Event(EVENT));
  }, [key]);
  // Null only before this phone's choice is read, so a card that's off never flashes in.
  return { prefs, update, ready: raw !== null };
}
