import { createHmac, randomUUID } from "node:crypto";
import { after } from "next/server";
import { analyticsHost, APP_EVENTS, type AppAnalyticsEvent } from "./policy";

export function familyAnalyticsId(familyId: number): string | null {
  const secret = process.env.MAPLE_SESSION_SECRET?.trim() || process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!secret || !Number.isSafeInteger(familyId) || familyId < 1) return null;
  return `family:${createHmac("sha256", secret).update(`maple-analytics:family:${familyId}`).digest("hex")}`;
}

async function sendEvent(distinctId: string, event: AppAnalyticsEvent | "signup_started" | "signup_completed"): Promise<void> {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = analyticsHost(process.env.NEXT_PUBLIC_POSTHOG_HOST);
  if (!key || !host) return;
  try {
    await fetch(`${host}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(1500),
      body: JSON.stringify({
        api_key: key,
        event,
        properties: { distinct_id: distinctId, $process_person_profile: false, $geoip_disable: true },
      }),
    });
  } catch {}
}

async function captureFamilyEvent(familyId: number, event: AppAnalyticsEvent | "signup_completed"): Promise<void> {
  const distinctId = familyAnalyticsId(familyId);
  if (distinctId) await sendEvent(distinctId, event);
}

export async function captureAppEvent(familyId: number, event: AppAnalyticsEvent): Promise<void> {
  if (!APP_EVENTS.includes(event)) return;
  await captureFamilyEvent(familyId, event);
}

function schedule(task: () => Promise<void>): void {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
  try {
    after(task);
  } catch {}
}

export function captureAppEventSoon(familyId: number, event: AppAnalyticsEvent): void {
  schedule(() => captureAppEvent(familyId, event));
}

export async function captureSignupStarted(): Promise<void> {
  await sendEvent(`site:${randomUUID()}`, "signup_started");
}

export function captureSignupStartedSoon(): void {
  schedule(captureSignupStarted);
}

export async function captureSignupCompleted(familyId: number): Promise<void> {
  await captureFamilyEvent(familyId, "signup_completed");
}
