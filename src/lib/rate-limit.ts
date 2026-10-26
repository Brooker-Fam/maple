import { createHmac } from "crypto";
import { query } from "@/lib/db";

// Generous on purpose: at the party most guests share one venue-WiFi / carrier
// IP, so this hourly cap is effectively collective. It only needs to stop a
// stranger scripting the endpoint — not a real crowd uploading their camera rolls.
const UPLOADS_PER_HOUR = 1500;
const WAITLIST_PER_HOUR = 10;

function clientIp(req: Request): string {
  // Prefer x-real-ip: Vercel sets it to the actual connecting client and
  // overwrites any client-supplied value, so (unlike the left-most
  // x-forwarded-for hop) it can't be spoofed to mint a fresh bucket per request.
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return "unknown";
}

// Keyed with a server secret: a plain hash of an IPv4 address is undone by hashing all 2^32 of them.
function ipKey(req: Request, bucket: string): string {
  const secret = process.env.MCP_SECRET || process.env.GOOGLE_CLIENT_SECRET || process.env.ADMIN_PASS || "";
  return createHmac("sha256", `maple-rate:${secret}`).update(`${bucket}:${clientIp(req)}`).digest("hex");
}

// Fails open: a DB hiccup or missing DATABASE_URL must never block a real
// family member's sign-in or upload. The privacy page promises windows are
// gone after a day.
async function countHit(req: Request, bucket: string, perHour: number): Promise<{ allowed: boolean; count?: number }> {
  try {
    const rows = await query(
      `WITH expired AS (DELETE FROM upload_rate_limit WHERE window_start < NOW() - INTERVAL '1 day')
       INSERT INTO upload_rate_limit (ip_hash, window_start, count)
       VALUES ($1, date_trunc('hour', NOW()), 1)
       ON CONFLICT (ip_hash, window_start)
       DO UPDATE SET count = upload_rate_limit.count + 1
       RETURNING count`,
      [ipKey(req, bucket)]
    );
    if (!rows) return { allowed: true };
    const count = Number(rows[0].count);
    return { allowed: count <= perHour, count };
  } catch {
    return { allowed: true };
  }
}

/** Sign-in, invite, OAuth and upload attempts per connection per hour. */
export const checkUploadRateLimit = (req: Request) => countHit(req, "upload", UPLOADS_PER_HOUR);

export const checkWaitlistRateLimit = (req: Request) => countHit(req, "waitlist", WAITLIST_PER_HOUR);
