import { createHash } from "crypto";
import { query } from "@/lib/db";

// Generous on purpose: at the party most guests share one venue-WiFi / carrier
// IP, so this hourly cap is effectively collective. It only needs to stop a
// stranger scripting the endpoint — not a real crowd uploading their camera rolls.
const UPLOADS_PER_HOUR = 1500;

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

// Throttles upload-token minting per source. IPs are hashed (we never store the
// raw address). Fails open: a DB hiccup or missing DATABASE_URL must never block
// a real guest's upload — abuse prevention is not worth a broken party album.
export async function checkUploadRateLimit(
  req: Request
): Promise<{ allowed: boolean; count?: number }> {
  const ipHash = createHash("sha256").update(clientIp(req)).digest("hex");
  try {
    const rows = await query(
      `INSERT INTO upload_rate_limit (ip_hash, window_start, count)
       VALUES ($1, date_trunc('hour', NOW()), 1)
       ON CONFLICT (ip_hash, window_start)
       DO UPDATE SET count = upload_rate_limit.count + 1
       RETURNING count`,
      [ipHash]
    );
    if (!rows) return { allowed: true };
    const count = Number(rows[0].count);
    return { allowed: count <= UPLOADS_PER_HOUR, count };
  } catch {
    return { allowed: true };
  }
}
