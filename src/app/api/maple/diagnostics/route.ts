import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";
import { query } from "@/lib/db";
import { captureServerException } from "@/lib/posthog-server";
import { json, withMember } from "@/lib/maple/api";
import { sameOriginRequest } from "@/lib/maple/auth-request";
import { logSyncDiagnostic, MAX_DIAGNOSTIC_BYTES, parseSyncDiagnostics } from "@/lib/maple/diagnostics";

export const dynamic = "force-dynamic";

async function allowed(member: string): Promise<boolean> {
  const secret = process.env.MAPLE_SESSION_SECRET || process.env.GOOGLE_CLIENT_SECRET || process.env.ADMIN_PASS;
  if (!secret) return false;
  const key = createHmac("sha256", secret).update(`maple-sync-diagnostics:${member}`).digest("hex");
  const rows = await query(
    `WITH expired AS (DELETE FROM upload_rate_limit WHERE window_start < NOW() - INTERVAL '1 day')
     INSERT INTO upload_rate_limit (ip_hash, window_start, count)
     VALUES ($1, date_trunc('hour', NOW()), 1)
     ON CONFLICT (ip_hash, window_start)
     DO UPDATE SET count = upload_rate_limit.count + 1
     WHERE upload_rate_limit.count < 120
     RETURNING count`,
    [key],
  );
  return Boolean(rows?.length);
}

async function readEvents(request: Request) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_DIAGNOSTIC_BYTES);
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (length + part.value.byteLength > bytes.byteLength) {
        void reader.cancel().catch(() => {});
        return null;
      }
      bytes.set(part.value, length);
      length += part.value.byteLength;
    }
    return parseSyncDiagnostics(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

const receive = withMember("POST /api/maple/diagnostics", async (request, member) => {
  try {
    if (!(await allowed(member.email))) return json({ error: "Diagnostics unavailable" }, 429);
    const events = await readEvents(request);
    if (!events) return json({ error: "Invalid diagnostics" }, 400);
    events.forEach(logSyncDiagnostic);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch {
    return json({ error: "Diagnostics unavailable" }, 503);
  }
});

async function responseFor(request: NextRequest): Promise<Response> {
  if (!sameOriginRequest(request) || request.headers.get("origin") !== new URL(request.url).origin) {
    return json({ error: "Not allowed" }, 403);
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return json({ error: "Expected JSON" }, 415);
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_DIAGNOSTIC_BYTES)) {
    return json({ error: "Invalid diagnostics" }, 413);
  }
  return receive(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  const response = await responseFor(request);
  if (response.status >= 400 && response.status !== 500) {
    await captureServerException(new Error("sync_diagnostics_failed"), { status: response.status }).catch(() => {});
  }
  return response;
}
