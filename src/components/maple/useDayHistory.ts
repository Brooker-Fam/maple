"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { addDays } from "@/lib/maple/time";
import type { Entry } from "@/lib/maple/types";
import { fetchRange, mergeLive } from "./LogTab";
import { useMaple } from "./useMaple";

type Snapshot = {
  scope: string;
  day: string;
  entries: Entry[];
  partialDays: string[];
};

/**
 * The clock's selected historical day, plus the preceding day for spans that
 * cross midnight. Pass null when live state covers the selected window.
 *
 * Historical entries can change without appearing in the 72-hour snapshot.
 * Every server revision therefore refreshes this small, selected range. A
 * cancelled request never replaces a newer day, revision or family. The last
 * successful same-day copy remains available while refreshing or retrying;
 * callers must show the returned refresh/error state alongside that copy.
 */
export function useDayHistory(day: string | null) {
  const { api, state } = useMaple();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const scope = state ? JSON.stringify([state.family?.id ?? 1, state.baby.id, state.baby.timezone, state.me.email]) : "";
  const revision = state?.rev ?? "";
  const requestKey = day && scope ? JSON.stringify([scope, day, revision, attempt]) : null;

  useEffect(() => {
    if (!day || !requestKey) return;
    let cancelled = false;
    void fetchRange(api, addDays(day, -1), day).then(
      (result) => {
        if (cancelled) return;
        setSnapshot({ scope, day, ...result });
        setFailedKey(null);
        setSettledKey(requestKey);
      },
      () => {
        if (cancelled) return;
        setFailedKey(requestKey);
        setSettledKey(requestKey);
      }
    );
    return () => { cancelled = true; };
  }, [api, day, requestKey, scope]);

  const current = snapshot?.scope === scope && snapshot.day === day ? snapshot : null;
  const entries = useMemo(() => current && state ? mergeLive(current.entries, state) : [], [current, state]);
  const pending = requestKey !== null && settledKey !== requestKey;
  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  return {
    entries,
    loaded: current !== null,
    loading: pending && current === null,
    refreshing: pending && current !== null,
    error: requestKey !== null && failedKey === requestKey,
    partialDays: current?.partialDays ?? [],
    reload,
  };
}
