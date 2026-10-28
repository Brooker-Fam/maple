import { createHmac } from "node:crypto";
import { query } from "../db";

export function analyticsSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  return origin ? origin === new URL(request.url).origin : site === "same-origin";
}

export async function analyticsRateLimit(request: Request, errors = false): Promise<boolean> {
  const secret = process.env.MAPLE_ANALYTICS_SECRET || process.env.MAPLE_SESSION_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  if (!secret) return false;
  const ip = request.headers.get("x-real-ip")?.trim() || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const key = createHmac("sha256", secret).update(`analytics:${errors ? "error" : "event"}:${ip}`).digest("hex");
  const rows = await query(`WITH expired AS (DELETE FROM upload_rate_limit WHERE window_start < NOW() - INTERVAL '1 day')
    INSERT INTO upload_rate_limit (ip_hash, window_start, count) VALUES ($1, date_trunc('hour', NOW()), 1)
    ON CONFLICT (ip_hash, window_start) DO UPDATE SET count = upload_rate_limit.count + 1 RETURNING count`, [key]);
  return Boolean(rows?.[0] && Number(rows[0].count) <= (errors ? 30 : 180));
}

export async function analyticsJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) return;
  const reader = request.body?.getReader();
  if (!reader) return;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 4096) { await reader.cancel(); return; }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return; }
}

export function analyticsResponse(success: boolean, status = success ? 200 : 503): Response {
  return Response.json({ success }, { status, headers: { "Cache-Control": "no-store", ...(status === 429 || status === 503 ? { "Retry-After": "5" } : {}) } });
}
