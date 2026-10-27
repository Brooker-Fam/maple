import { createHmac } from "crypto";
import { query } from "@/lib/db";

export const INVITE_EMAILS_PER_DAY = 20;

type Run = (sql: string, params: unknown[]) => Promise<unknown[] | null>;

// Same keying as rate-limit.ts, over the sender's member id instead of a connection, so no address is stored.
export function senderKey(sender: string): string {
  const secret = process.env.MCP_SECRET || process.env.GOOGLE_CLIENT_SECRET || process.env.ADMIN_PASS || "";
  return createHmac("sha256", `maple-rate:${secret}`).update(`invite-email:${sender.trim().toLowerCase()}`).digest("hex");
}

/** Counts this send in the hour's window only while the last 24 hours are under the cap, and returns the count before it. */
export const INVITE_EMAIL_HIT = `WITH expired AS (DELETE FROM upload_rate_limit WHERE window_start < NOW() - INTERVAL '1 day'),
  sent AS (SELECT COALESCE(SUM(count), 0)::int AS n FROM upload_rate_limit WHERE ip_hash = $1 AND window_start > NOW() - INTERVAL '1 day'),
  counted AS (
    INSERT INTO upload_rate_limit (ip_hash, window_start, count)
    SELECT $1, date_trunc('hour', NOW()), 1 FROM sent WHERE n < $2
    ON CONFLICT (ip_hash, window_start) DO UPDATE SET count = upload_rate_limit.count + 1
  )
SELECT n FROM sent`;

/**
 * Whether this sender may email one more invite, counting it if so. Fails closed: with no database, or on an
 * error, the answer is no and the invite falls back to its link.
 */
export async function allowInviteEmail(sender: string, run: Run = query): Promise<boolean> {
  try {
    const rows = await run(INVITE_EMAIL_HIT, [senderKey(sender), INVITE_EMAILS_PER_DAY]);
    const n = Number((rows?.[0] as { n?: unknown } | undefined)?.n);
    return Number.isInteger(n) && n < INVITE_EMAILS_PER_DAY;
  } catch {
    return false;
  }
}
