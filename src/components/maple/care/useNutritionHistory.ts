"use client";

import { useCallback, useEffect, useState } from "react";
import { dayKey, DEFAULT_TZ } from "@/lib/maple/time";
import type { CareNutritionEntry } from "@/lib/maple/types";
import { useMaple } from "../useMaple";
import { errorText } from "./parts";

export function useNutritionHistory(day: string, today: string) {
  const { state, api } = useMaple();
  const family = state?.family?.id;
  const member = state?.me.email;
  const person = state?.care?.person.member;
  const allowed = !!state?.care?.access.read;
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const entryVersion = state?.care?.entries.filter((entry) => (entry.kind === "food" || entry.kind === "drink") && dayKey(new Date(entry.at), tz) === day)
    .map((entry) => `${entry.id}:${entry.updated_at}`).join(",") ?? "";
  const stateVersion = state?.rev;
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ key: string; entries: CareNutritionEntry[]; loaded: boolean; loading: boolean; error: string | null } | null>(null);
  const key = `${family}:${member}:${person}:${day}`;
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (day === today || !family || !allowed) return;
    let active = true;
    const controller = new AbortController();
    setResult((previous) => ({ key, entries: previous?.key === key ? previous.entries : [], loaded: previous?.key === key && previous.loaded, loading: true, error: null }));
    const query = new URLSearchParams({ from: day, to: day, kind: "food,drink" });
    api<{ entries: CareNutritionEntry[] }>(`/api/maple/care/entries?${query}`, { signal: controller.signal, headers: { "X-Maple-Family": String(family) } })
      .then((response) => {
        if (active) setResult({ key, entries: response.entries, loaded: true, loading: false, error: null });
      }).catch((error) => {
        if (active) setResult((previous) => ({ key, entries: previous?.key === key ? previous.entries : [], loaded: previous?.key === key && previous.loaded, loading: false, error: errorText(error) }));
      });
    return () => { active = false; controller.abort(); };
  }, [api, allowed, day, entryVersion, family, key, revision, stateVersion, today]);
  return {
    entries: result?.key === key && allowed ? result.entries : [],
    loaded: result?.key === key && result.loaded,
    loading: day !== today && allowed && (result?.key !== key || result.loading),
    error: result?.key === key ? result.error : null,
    reload,
  };
}
