export const SYNC_EVENTS = [
  "write_succeeded",
  "write_failed",
  "refresh_applied_after_write",
  "stale_response_discarded",
  "refresh_failed",
  "refresh_recovered",
] as const;

export type SyncEvent = (typeof SYNC_EVENTS)[number];
export type SyncDiagnostic = {
  event: SyncEvent;
  requestId?: string;
  status?: number;
  elapsedMs?: number;
};
export type SyncDiagnosticDetails = Omit<SyncDiagnostic, "event">;

export const MAX_DIAGNOSTIC_BYTES = 2048;
export const MAX_DIAGNOSTIC_EVENTS = 8;
export const MAX_DIAGNOSTIC_ELAPSED_MS = 120_000;

export function syncRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

export function syncDiagnostic(event: unknown, details: SyncDiagnosticDetails = {}): SyncDiagnostic | null {
  if (!SYNC_EVENTS.includes(event as SyncEvent)) return null;
  const requestId = syncRequestId(details.requestId);
  const status = Number.isInteger(details.status) && (details.status === 0 || (details.status! >= 100 && details.status! <= 599)) ? details.status : undefined;
  const elapsedMs = typeof details.elapsedMs === "number" && Number.isFinite(details.elapsedMs)
    ? Math.round(Math.min(MAX_DIAGNOSTIC_ELAPSED_MS, Math.max(0, details.elapsedMs)))
    : undefined;
  return { event: event as SyncEvent, ...(requestId ? { requestId } : {}), ...(status !== undefined ? { status } : {}), ...(elapsedMs !== undefined ? { elapsedMs } : {}) };
}

export function parseSyncDiagnostics(value: unknown): SyncDiagnostic[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join() !== "events") return null;
  const events = (value as { events: unknown }).events;
  if (!Array.isArray(events) || !events.length || events.length > MAX_DIAGNOSTIC_EVENTS) return null;
  const parsed: SyncDiagnostic[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) return null;
    if (Object.keys(event).some((key) => !["event", "requestId", "status", "elapsedMs"].includes(key))) return null;
    if ("requestId" in event && !syncRequestId(event.requestId)) return null;
    if ("status" in event && (!Number.isInteger(event.status) || (event.status !== 0 && event.status < 100) || event.status > 599)) return null;
    if ("elapsedMs" in event && (!Number.isInteger(event.elapsedMs) || event.elapsedMs < 0 || event.elapsedMs > MAX_DIAGNOSTIC_ELAPSED_MS)) return null;
    const clean = syncDiagnostic(event.event, event);
    if (!clean) return null;
    parsed.push(clean);
  }
  return parsed;
}

const SYNC_ROUTES = new Set([
  "GET /api/maple/state",
  "POST /api/maple/timer",
  "POST /api/maple/entries",
  "PATCH /api/maple/entries",
  "DELETE /api/maple/entries",
  "POST /api/maple/entries/restore",
]);

export function syncRequestFor(route: string, request: Request): string | undefined {
  return SYNC_ROUTES.has(route) ? syncRequestId(request.headers.get("x-maple-request-id")) : undefined;
}

export function logSyncDiagnostic(diagnostic: SyncDiagnostic | ({ event: "api_response" } & SyncDiagnosticDetails)): void {
  try {
    const clean = syncDiagnostic(diagnostic.event === "api_response" ? "write_succeeded" : diagnostic.event, diagnostic);
    if (!clean) return;
    console.info("maple_sync", JSON.stringify({ ...clean, event: diagnostic.event }));
  } catch {}
}
