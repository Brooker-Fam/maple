import { createHmac } from "crypto";
import { query } from "@/lib/db";

/**
 * Abuse limits for creating families. Unlike the sign-in limits in
 * src/lib/rate-limit.ts these fail closed: a database hiccup can delay a new
 * family, never let one through uncounted. Counters live in
 * upload_rate_limit (global, cleared after a day) under an HMAC of the
 * connection, so no address is stored.
 */

export const SIGNUP_LIMITS = {
  /** Sign-up starts and code checks per connection per hour (slows code guessing). */
  attemptsPerHour: 20,
  /** Families created from one connection in 24 hours. */
  familiesPerIpPerDay: 3,
  /** Families created by one Google account in 24 hours. */
  familiesPerAccountPerDay: 1,
} as const;

/** New families across everyone in 24 hours (MAPLE_SIGNUP_DAILY_MAX, default 25). */
export function familiesPerDay(raw: string | undefined = process.env.MAPLE_SIGNUP_DAILY_MAX): number {
  const n = raw && /^\d{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return Number.isSafeInteger(n) ? n : 25;
}

function clientIp(req: Request): string {
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return networkOf(realIp.trim());
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return networkOf(xff.split(",")[0].trim());
  return "unknown";
}

/**
 * One IPv6 connection usually holds a whole /64 and can hop between its
 * addresses at will, so sign-up counts the /64 as one connection. IPv4
 * addresses (and IPv4-mapped ones) count as themselves.
 */
export function networkOf(ip: string): string {
  if (!ip.includes(":") || /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) return ip.replace(/^::ffff:/i, "");
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

// Same keying as rate-limit.ts, so a bucket name is the only difference between counters.
export function connectionKey(req: Request, bucket: string): string {
  const secret = process.env.MCP_SECRET || process.env.GOOGLE_CLIENT_SECRET || process.env.ADMIN_PASS || "";
  return createHmac("sha256", `maple-rate:${secret}`).update(`${bucket}:${clientIp(req)}`).digest("hex");
}

export const ATTEMPT_BUCKET = "signup-attempt";
export const FAMILY_BUCKET = "signup-family";

/** Counts one attempt from this connection; false when over the hourly limit or the count can't be kept. */
export async function allowAttempt(req: Request): Promise<boolean> {
  try {
    const rows = await query(
      `WITH expired AS (DELETE FROM upload_rate_limit WHERE window_start < NOW() - INTERVAL '1 day')
       INSERT INTO upload_rate_limit (ip_hash, window_start, count)
       VALUES ($1, date_trunc('hour', NOW()), 1)
       ON CONFLICT (ip_hash, window_start) DO UPDATE SET count = upload_rate_limit.count + 1
       RETURNING count`,
      [connectionKey(req, ATTEMPT_BUCKET)]
    );
    return !!rows?.length && Number(rows[0].count) <= SIGNUP_LIMITS.attemptsPerHour;
  } catch {
    return false;
  }
}
