"use client";

import { useEffect, useRef } from "react";
import { useMaple } from "./useMaple";

export default function AppAnalytics() {
  const { state, status } = useMaple();
  const opened = useRef(new Set<number>());
  const familyId = state?.family?.id;

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY || status !== "ready" || !familyId || opened.current.has(familyId)) return;
    opened.current.add(familyId);
    void fetch("/api/maple/analytics/open", {
      method: "POST",
      headers: { "X-Maple-Family": String(familyId) },
      credentials: "same-origin",
    }).catch(() => {});
  }, [familyId, status]);

  return null;
}
