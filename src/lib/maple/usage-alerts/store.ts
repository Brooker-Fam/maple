import { randomUUID } from "node:crypto";
import { query, type Row } from "@/lib/db";
import type { Alert } from "./policy";

export async function rows(sql: string, params: unknown[] = []): Promise<Row[]> {
  const out = await query(sql, params);
  if (out === null) throw new Error("usage_alerts_database_unavailable");
  return out;
}

export async function claim(alert: Alert, now: Date): Promise<(Alert & { token: string }) | null> {
  const token = randomUUID();
  const result = await rows(
    `INSERT INTO maple_usage_alerts (key, subject, body, claim_token, claim_until)
     VALUES ($1, $2, $3, $4, $5::timestamptz + INTERVAL '5 minutes')
     ON CONFLICT (key) DO UPDATE SET claim_token = EXCLUDED.claim_token, claim_until = EXCLUDED.claim_until
       WHERE maple_usage_alerts.sent_at IS NULL AND (maple_usage_alerts.claim_until IS NULL OR maple_usage_alerts.claim_until <= $5)
     RETURNING subject, body`,
    [alert.key, alert.subject, alert.body, token, now.toISOString()]
  );
  return result.length ? { key: alert.key, subject: String(result[0].subject), body: String(result[0].body), token } : null;
}

export async function settle(key: string, token: string, sent: boolean, now: Date): Promise<void> {
  await rows(
    `UPDATE maple_usage_alerts SET sent_at = $3::timestamptz, claim_until = NULL, claim_token = NULL WHERE key = $1 AND claim_token = $2`,
    [key, token, sent ? now.toISOString() : null]
  );
}

export async function pending(): Promise<Alert[]> {
  return (await rows(`SELECT key, subject, body FROM maple_usage_alerts WHERE sent_at IS NULL ORDER BY created_at LIMIT 100`))
    .map((row) => ({ key: String(row.key), subject: String(row.subject), body: String(row.body) }));
}

export async function sent(key: string): Promise<boolean> {
  return (await rows(`SELECT 1 FROM maple_usage_alerts WHERE key = $1 AND sent_at IS NOT NULL`, [key])).length > 0;
}

export async function recordRun(now: Date): Promise<void> {
  await rows(
    `INSERT INTO maple_usage_alerts (key, subject, body, sent_at) VALUES ('last-successful-check', '', '', $1)
     ON CONFLICT (key) DO UPDATE SET sent_at = EXCLUDED.sent_at`, [now.toISOString()]
  );
}

export async function healthy(now: Date): Promise<boolean> {
  return (await rows(`SELECT 1 FROM maple_usage_alerts WHERE key = 'last-successful-check' AND sent_at >= $1::timestamptz - INTERVAL '36 hours' AND sent_at <= $1`, [now.toISOString()])).length > 0;
}
