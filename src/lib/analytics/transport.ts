import { createHash, randomUUID } from "node:crypto";
import { query } from "../db";
import { analyticsConfig, analyticsTags } from "./config";
import { reportAnalyticsFailure } from "./health";
import type { AnalyticsIdentity } from "./identity";
import { UUID } from "./policy";
import { analyticsSessionId, validAnalyticsSession } from "./session";

export function analyticsEventId(distinctId: string, event: string, retryId?: string): string {
  if (!retryId || !UUID.test(retryId)) return randomUUID();
  const bytes = createHash("sha256").update(`maple:analytics:v2:${distinctId}:${event}:${retryId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function sendAnalyticsEvent(distinctId: string, event: string, properties: Record<string, unknown>, identity?: AnalyticsIdentity, retryId?: string): Promise<boolean> {
  const config = analyticsConfig();
  if (!config || !UUID.test(distinctId)) return false;
  const eventId = analyticsEventId(distinctId, event, retryId);
  const tags = analyticsTags();
  try {
    const now = Date.now();
    const sessionId = properties.$session_id === undefined ? null
      : validAnalyticsSession(properties.$session_id, now) ? properties.$session_id : analyticsSessionId(now);
    const rows = await query(`INSERT INTO maple_analytics_deliveries (event_id, distinct_id, event, member_id, family_id, environment, is_test, occurred_at, session_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (event_id) DO UPDATE SET event_id = EXCLUDED.event_id
      RETURNING occurred_at, delivered_at, session_id`, [eventId, distinctId, event, identity?.distinctId ?? null, identity?.familyGroupId ?? null, tags.environment, tags.is_test, new Date(now).toISOString(), sessionId]);
    if (!rows?.[0]) throw new Error("analytics_receipt_unavailable");
    if (rows[0].delivered_at) return true;
    const body = JSON.stringify({
      api_key: config.key, event, uuid: eventId, distinct_id: distinctId,
      timestamp: new Date(rows[0].occurred_at).toISOString(),
      properties: { ...properties, $session_id: rows[0].session_id ?? undefined, distinct_id: distinctId, $process_person_profile: Boolean(identity), $geoip_disable: true, ...tags },
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      let retry = true;
      try {
        const response = await fetch(`${config.host}/i/v0/e/`, {
          method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit", referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(1500), body,
        });
        if (response.ok) {
          await query(`UPDATE maple_analytics_deliveries SET delivered_at = NOW() WHERE event_id = $1`, [eventId]);
          return true;
        }
        retry = response.status === 408 || response.status === 429 || response.status >= 500;
      } catch {}
      if (!retry) break;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  } catch {}
  await reportAnalyticsFailure();
  return false;
}
