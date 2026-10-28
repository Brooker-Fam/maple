"use client";

import { useEffect } from "react";
import { captureSiteEvent } from "@/lib/analytics/client";

const CLASSES = new Set([
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError",
]);
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;

function errorClass(error: unknown, fallback: string): string {
  try {
    const name = (error as { name?: unknown } | null)?.name;
    return typeof name === "string" && CLASSES.has(name) ? name : fallback;
  } catch {
    return fallback;
  }
}

export default function ClientErrors() {
  useEffect(() => {
    const lastSent = new Map<string, number>();
    let windowStart = Date.now();
    let count = 0;
    const report = (error: unknown, area: "window" | "unhandledrejection") => {
      if (navigator.onLine === false) return;
      const now = Date.now();
      if (now - windowStart >= WINDOW_MS) {
        windowStart = now;
        count = 0;
      }
      const error_class = errorClass(error, area === "window" ? "Error" : "UnhandledRejection");
      const key = `${area}:${error_class}`;
      const previous = lastSent.get(key);
      if (count >= MAX_PER_WINDOW || (previous !== undefined && now - previous < WINDOW_MS)) return;
      lastSent.set(key, now);
      count++;
      try {
        void Promise.resolve(captureSiteEvent("client_error", { error_class, area })).catch(() => {});
      } catch {}
    };
    const onError = (event: ErrorEvent) => report(event.error, "window");
    const onRejection = (event: PromiseRejectionEvent) => report(event.reason, "unhandledrejection");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
