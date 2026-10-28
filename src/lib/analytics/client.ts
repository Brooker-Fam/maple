"use client";

import { analyticsHost, initialAttribution, PUBLIC_EVENT_SCHEMA, sitePage, type SiteAnalyticsEvent } from "./policy";

const ENDPOINT = "/api/maple/analytics/event";
let queue = Promise.resolve();
let ready = false;
let needsReset = false;
let generation = 0;

function enabled(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY && analyticsHost(process.env.NEXT_PUBLIC_POSTHOG_HOST) && typeof window !== "undefined");
}

async function post(body: unknown, expectedGeneration: number): Promise<boolean> {
  const payload = JSON.stringify(body);
  for (let attempt = 0; attempt < 3 && generation === expectedGeneration; attempt++) {
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: payload,
        credentials: "same-origin", referrerPolicy: "no-referrer", keepalive: true,
        signal: AbortSignal.timeout(6000),
      });
      if (response.ok && (await response.json()).success === true) return true;
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) return false;
    } catch {}
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
  return false;
}

export function captureSiteEvent(event: SiteAnalyticsEvent, properties: Record<string, unknown> = {}): void {
  if (!enabled()) return;
  const pathname = properties.pathname ?? window.location.pathname;
  const initial = event === "client_error" ? {} : initialAttribution(window.location.href, document.referrer);
  const parsed = PUBLIC_EVENT_SCHEMA.safeParse({ event, event_id: crypto.randomUUID(), properties: event === "client_error" ? properties : { ...properties, pathname, initial } });
  if (!parsed.success) return;
  const expectedGeneration = generation;
  queue = queue.then(async () => {
    if (expectedGeneration !== generation) return;
    if (needsReset && !await finishReset(expectedGeneration)) return;
    if (!ready) ready = await post({ action: "context", initial }, expectedGeneration);
    if (ready) await post(parsed.data, expectedGeneration);
  }).catch(() => {});
}

export function captureSitePage(pathname: string): void {
  if (sitePage(pathname)) captureSiteEvent("$pageview", { pathname });
}

async function finishReset(expectedGeneration: number): Promise<boolean> {
  const success = await post({ action: "reset" }, expectedGeneration);
  if (success && generation === expectedGeneration) { needsReset = false; ready = false; }
  return success;
}

export async function resetAnalytics(): Promise<void> {
  generation++;
  ready = false;
  needsReset = true;
  if (typeof window === "undefined") return;
  const expectedGeneration = generation;
  queue = queue.then(async () => { await finishReset(expectedGeneration); }).catch(() => {});
  await queue;
}
