import { randomUUID } from "node:crypto";

export const SESSION_MAX_MS = 24 * 60 * 60 * 1000;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function analyticsSessionId(now = Date.now()): string {
  const timestamp = now.toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${randomUUID().slice(15)}`;
}

export function validAnalyticsSession(id: unknown, now = Date.now()): id is string {
  if (typeof id !== "string" || !UUID_V7.test(id)) return false;
  const start = parseInt(id.replaceAll("-", "").slice(0, 12), 16);
  return start <= now && now < start + SESSION_MAX_MS;
}
