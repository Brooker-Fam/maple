"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { DEVELOPMENT_TOPICS, type DevelopmentTopic } from "@/lib/maple/guidelines/development";
import { useMaple } from "../useMaple";

type Preferences = { enabled: boolean; topics: DevelopmentTopic[]; hiddenDay: string | null };
const DEFAULTS: Preferences = { enabled: true, topics: [], hiddenDay: null };
const DEFAULT_JSON = JSON.stringify(DEFAULTS);
const EVENT = "maple-discovery-preferences";
const memory = new Map<string, string>();
const serverSnapshot = () => null;

function read(key: string): string {
  const temporary = memory.get(key);
  if (temporary !== undefined) return temporary;
  try {
    return localStorage.getItem(key) ?? DEFAULT_JSON;
  } catch {
    return memory.get(key) ?? DEFAULT_JSON;
  }
}

function parse(raw: string | null): Preferences {
  try {
    const value = JSON.parse(raw ?? DEFAULT_JSON);
    if (!value || typeof value !== "object") return DEFAULTS;
    return {
      enabled: value.enabled !== false,
      topics: DEVELOPMENT_TOPICS.filter((topic) => Array.isArray(value.topics) && value.topics.includes(topic.id)).map((topic) => topic.id),
      hiddenDay: typeof value.hiddenDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.hiddenDay) ? value.hiddenDay : null,
    };
  } catch {
    return DEFAULTS;
  }
}

export function useDiscoveryPreferences() {
  const { state } = useMaple();
  const key = state ? `maple-discoveries-v1:${state.family?.id ?? 1}:${state.baby.id}:${encodeURIComponent(state.me.email)}` : "";
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
  const snapshot = useCallback(() => key ? read(key) : null, [key]);
  const raw = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const preferences = useMemo(() => parse(raw), [raw]);
  const update = useCallback((patch: Partial<Preferences>) => {
    if (!key) return;
    const next = JSON.stringify({ ...parse(read(key)), ...patch });
    try {
      localStorage.setItem(key, next);
      memory.delete(key);
    } catch {
      memory.set(key, next);
    }
    window.dispatchEvent(new Event(EVENT));
  }, [key]);
  return { preferences, update, ready: raw !== null };
}
