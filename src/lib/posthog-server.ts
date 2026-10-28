import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import { resolveAnalyticsActor, type AnalyticsActor } from "@/lib/analytics/identity";
import { analyticsTags } from "@/lib/analytics/config";
import { analyticsHost } from "@/lib/analytics/policy";

let client: PostHog | null = null;

export function getPostHogServer(): PostHog | null {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = analyticsHost(process.env.NEXT_PUBLIC_POSTHOG_HOST);
  if (!key || !host) return null;
  if (client) return client;
  client = new PostHog(key, {
    host,
    flushAt: 1,
    flushInterval: 0,
    requestTimeout: 1500,
    fetchRetryCount: 0,
    disableGeoip: true,
    enableExceptionAutocapture: false,
  });
  return client;
}

const ERROR_CLASSES = new Set([
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError",
  "AggregateError", "AbortError", "TimeoutError", "StoreUnavailable", "FetchError", "NeonDbError",
  "validation_error", "rate_limit_exceeded", "resend_error", "resend_no_id",
]);
const ERROR_CODES = new Set(["400", "401", "403", "404", "409", "422", "429", "500", "502", "503", "504",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "23502", "23503", "23505", "23514", "40001", "53300", "57P01"]);
const ERROR_LABELS = new Set(["care_error", "sync_request_failed", "sync_diagnostics_failed"]);
const API_PATHS = new Set([
  "/api/waitlist", "/api/maple/analytics/event", "/api/maple/analytics/open", "/api/maple/state",
  "/api/maple/entries", "/api/maple/entries/restore", "/api/maple/timer", "/api/maple/baby",
  "/api/maple/members", "/api/maple/invites", "/api/maple/tokens", "/api/maple/photo", "/api/maple/diagnostics",
  "/api/maple/upload", "/api/maple/export", "/api/maple/quick", "/api/maple/mcp",
  "/api/maple/chat", "/api/maple/chat/consent", "/api/maple/onboarding", "/api/maple/onboarding/chat",
  "/api/maple/admin/metrics", "/api/maple/usage-alerts", "/api/maple/push", "/api/maple/push/test",
  "/api/maple/push/tick", "/api/maple/push/receipt", "/api/maple/care/move", "/api/maple/care/mood",
  "/api/maple/care/meds", "/api/maple/care/person", "/api/maple/care/entries", "/api/maple/care/entries/restore",
  "/api/maple/auth/callback", "/api/maple/auth/native", "/api/maple/auth/password", "/api/maple/auth/me",
  "/api/maple/auth/join", "/api/maple/auth/email/start", "/api/maple/auth/email/verify",
  "/api/maple/auth/apple/start", "/api/maple/auth/apple/callback", "/api/maple/signup/start",
]);
const ROUTES = new Set([
  ...API_PATHS,
  ...[...API_PATHS].flatMap((path) => ["GET", "POST", "PATCH", "DELETE", "PUT"].map((method) => `${method} ${path}`)),
  "email start", "email verify", "apple start", "apple callback", "GET /api/maple/auth/callback (signup)",
  "/api/maple/mcp (copy)", "maple notify", "maple notify logged", "maple notify care", "maple notify nursing",
  "maple push", "maple push family", "maple push test", "maple push send", "maple push member",
  "maple push meds", "maple push retry", "maple push schedule", "maple push tick", "maple push wake",
  "maple push net", "maple usage alerts",
]);
const CONTEXT = {
  route: ROUTES,
  where: new Set(["api", "care", "email", "analytics", "lifetimeCounts.week"]),
  tool: new Set([
    "maple_status", "list_entries", "daily_summary", "log_feed", "log_pump", "log_diaper", "log_sleep",
    "log_temperature", "log_vitals", "log_growth", "log_note", "log_medicine", "log_activity", "log_moment",
    "log_many", "get_moments", "delete_entry", "undo_last", "fix_entry", "fix_nursing_time",
    "add_doctor_question", "list_doctor_questions", "mom_status", "fix_mom_entry", "add_mom_medicines",
  ]),
  kind: new Set(["database_unavailable", "server_error", "invite", "welcome", "usage_alert", "email_auth", "other"]),
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeContext(properties: Record<string, unknown>): Record<string, string | number> {
  const output: Record<string, string | number> = {};
  for (const [key, allowed] of Object.entries(CONTEXT)) {
    const value = properties[key];
    if (typeof value === "string" && allowed.has(value)) output[key] = value;
  }
  const status = properties.status;
  if (typeof status === "number" && Number.isInteger(status) && (status === 0 || (status >= 100 && status <= 599))) output.status = status;
  const requestId = properties.requestId;
  if (typeof requestId === "string" && requestId.length === 36 && UUID_V4.test(requestId)) output.requestId = requestId.toLowerCase();
  return output;
}

export function scrubError(error: unknown): Error {
  let name = "Error";
  let code: string | undefined;
  let fixedLabel: string | undefined;
  try {
    const value = error as { name?: unknown; code?: unknown; message?: unknown; constructor?: { name?: unknown } } | null;
    const candidate = value?.name === "Error" ? value?.constructor?.name : value?.name;
    if (typeof candidate === "string" && ERROR_CLASSES.has(candidate)) name = candidate;
    if (typeof value?.code === "string" && ERROR_CODES.has(value.code)) code = value.code;
    const message = value?.message;
    if (typeof message === "string" && ERROR_LABELS.has(message)) fixedLabel = message;
  } catch {}
  const label = fixedLabel ?? (code ? `${name} ${code}` : name);
  const scrubbed = Object.assign(new Error(label), { name, ...(code ? { code } : {}) });
  scrubbed.stack = `${name}: ${label}`;
  return scrubbed;
}

async function exceptionIdentity(actor?: AnalyticsActor) {
  try {
    const identity = actor ? await resolveAnalyticsActor(actor) : null;
    if (identity && UUID.test(identity.distinctId) && UUID.test(identity.familyGroupId)) return identity;
  } catch {}
  return null;
}

export async function captureServerException(
  error: unknown,
  properties: Record<string, unknown> = {},
  actor?: AnalyticsActor,
): Promise<void> {
  try {
    const ph = getPostHogServer();
    if (!ph) return;
    const identity = await exceptionIdentity(actor);
    const scrubbed = scrubError(error);
    await ph.captureExceptionImmediate(scrubbed, identity?.distinctId ?? `server:${randomUUID()}`, {
      ...safeContext(properties),
      ...analyticsTags(),
      $process_person_profile: !!identity,
      $geoip_disable: true,
      ...(identity ? { $groups: { family: identity.familyGroupId }, family_id: identity.familyGroupId } : {}),
      $exception_list: [{ type: scrubbed.name, value: scrubbed.message, mechanism: { type: "generic", handled: true } }],
    });
  } catch {
    console.error("Maple exception reporting failed");
  }
}
