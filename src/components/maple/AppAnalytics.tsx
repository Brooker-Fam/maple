"use client";

import { useEffect, useRef } from "react";
import { useMaple } from "./useMaple";
import { appOpenTracker, OPEN_IDLE_MS } from "./analytics-lifecycle";

async function sendOpen(familyId: number, eventId: string): Promise<boolean> {
  const response = await fetch("/api/maple/analytics/open", {
    method: "POST",
    headers: { "X-Maple-Family": String(familyId), "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ event_id: eventId }),
    signal: AbortSignal.timeout(10_000),
  });
  return response.ok;
}

export default function AppAnalytics() {
  const { state, status } = useMaple();
  const tracker = useRef(appOpenTracker(sendOpen));
  const familyId = state?.family?.id;
  const member = state?.me.email;

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY || status !== "ready" || !familyId || !member) return;
    let stopped = false;
    let hiddenAt: number | null = document.hidden ? Date.now() : null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const record = async (newSession = false) => {
      if (stopped || document.hidden || !navigator.onLine) return;
      clearTimeout(retry);
      const ok = await tracker.current.open(familyId, member, newSession);
      if (!stopped && !ok && ++attempts < 3) retry = setTimeout(() => void record(), 5000);
    };
    const visible = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        clearTimeout(retry);
      } else {
        const newSession = hiddenAt !== null && Date.now() - hiddenAt >= OPEN_IDLE_MS;
        hiddenAt = null;
        attempts = 0;
        void record(newSession);
      }
    };
    const online = () => { attempts = 0; void record(); };
    void record();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", online);
    return () => {
      stopped = true;
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", online);
    };
  }, [familyId, member, status]);

  return null;
}
