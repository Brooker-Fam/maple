import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const fixture = mkdtempSync(join(tmpdir(), "maple-analytics-mutations-"));
type Mutation = { name: string; file: string; from: string; to: string; script?: string; test?: string };
const mutations: Mutation[] = [
  { name: "session-v4-generation", file: "session", from: 'return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${randomUUID().slice(15)}`;', to: "return randomUUID();", test: "session-v7" },
  { name: "session-legacy-not-rotated", file: "context", from: " || !validAnalyticsSession(previous.sessionId, now)", to: "", test: "session-legacy" },
  { name: "session-max-age-removed", file: "session", from: "start <= now && now < start + SESSION_MAX_MS", to: "start <= now", test: "session-limits" },
  { name: "session-future-accepted", file: "session", from: "start <= now && now < start + SESSION_MAX_MS", to: "now < start + SESSION_MAX_MS", test: "session-limits" },
  { name: "session-wire-validation-removed", file: "transport", from: "validAnalyticsSession(properties.$session_id, now) ?", to: "true ?", test: "session-wire-bounds" },
  { name: "session-retry-binding-removed", file: "transport", from: "$session_id: rows[0].session_id ?? undefined", to: "$session_id: properties.$session_id", test: "session-retry" },
  { name: "session-utm-removed", file: "server", from: '...(session.utm_source ? { utm_source: session.utm_source } : {}),', to: "", test: "session-attribution" },
  { name: "session-referrer-removed", file: "server", from: '...(session.referrer_host ? { $referring_domain: session.referrer_host } : {}),', to: "", test: "session-attribution" },
  { name: "session-attribution-not-renewed", file: "context", from: "session: renewSession ? attribution : previous.session ?? previous.initial", to: "session: previous.session ?? previous.initial", test: "session-attribution" },
  { name: "analytics-tenant-default-added", file: "schema", from: "family_id BIGINT PRIMARY KEY", to: "family_id BIGINT DEFAULT 1 PRIMARY KEY", script: "scripts/tenancy/schema.check.ts" },
  { name: "anonymous-reset-generation-removed", file: "context", from: "if (!envelope || envelope.generationBinding !== generationBinding(request, key)) return;", to: "if (!envelope) return;", test: "anonymous-cycle-replay" },
  { name: "waitlist-context-scope-broken", file: "context", from: "if (carriesAuthCookie(request) && envelope.authBinding !== authBinding(request, key)) return;", to: "if (envelope.authBinding !== authBinding(request, key)) return;", test: "waitlist-context" },
  { name: "nextresponse-cookie-cache-bypassed", file: "context", from: "if (response instanceof NextResponse)", to: "if (false)", test: "cookies" },
  { name: "late-cookie-auth-binding-removed", file: "context", from: "if (carriesAuthCookie(request) && envelope.authBinding !== authBinding(request, key)) return;", to: "", test: "auth-cookie-binding" },
  { name: "browser-error-actor-removed", file: "server", from: "const identity = actor ? await resolveAnalyticsActor(actor) : null;", to: "const identity = null;", test: "authenticated-public-event" },
  { name: "family-as-person", file: "identity", from: "distinctId: String(row.person_id)", to: "distinctId: String(row.group_id)", test: "identity" },
  { name: "secret-derived-identity", file: "identity", from: "distinctId: String(row.person_id)", to: "distinctId: process.env.MAPLE_SESSION_SECRET === 'synthetic-core-secret-rotated' ? '00000000-0000-4000-8000-000000000001' : String(row.person_id)", test: "identity" },
  { name: "signature-check-removed", file: "context", from: "if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return;", to: "if (false) return;", test: "cookies" },
  { name: "empty-pageview", file: "server", from: "$current_url: canonicalUrl(pathname), $pathname: pathname", to: "$pathname: pathname", test: "privacy" },
  { name: "missing-session", file: "server", from: "$session_id: ctx.sessionId,", to: "", test: "privacy" },
  { name: "missing-anonymous-stitch", file: "server", from: "...(link ? { $anon_distinct_id: ctx.visitorId } : {})", to: "...{}", test: "stitching" },
  { name: "http-failure-ignored", file: "transport", from: "if (response.ok)", to: "if (true)", test: "delivery" },
  { name: "timestamp-regenerated", file: "transport", from: "timestamp: new Date(rows[0].occurred_at).toISOString()", to: "timestamp: new Date().toISOString()", test: "delivery" },
  { name: "origin-check-removed", file: "request", from: "return origin ? origin === new URL(request.url).origin : site === \"same-origin\";", to: "return true;", test: "endpoints" },
  { name: "visitor-tombstone-removed", file: "schema", from: "member_id UUID REFERENCES maple_analytics_members(analytics_id) ON DELETE SET NULL", to: "member_id UUID REFERENCES maple_analytics_members(analytics_id) ON DELETE CASCADE", test: "cleanup" },
  { name: "test-events-mark-health-green", file: "health", from: "AND is_test = FALSE AND delivered_at", to: "AND delivered_at", test: "health" },
  { name: "browser-retry-uuid-regenerated", file: "client", from: "body: payload,", to: "body: JSON.stringify({ ...JSON.parse(payload), event_id: crypto.randomUUID() }),", script: "scripts/analytics-client-check.ts", test: "client-retries" },
  { name: "reset-barrier-removed", file: "client", from: "queue = queue.then(async () => { await finishReset(expectedGeneration); }).catch(() => {});", to: "await finishReset(expectedGeneration);", script: "scripts/analytics-client-check.ts", test: "reset-barrier" },
  { name: "failed-reset-reused", file: "client", from: "if (needsReset && !await finishReset(expectedGeneration)) return;", to: "", script: "scripts/analytics-client-check.ts", test: "reset-failure" },
  { name: "error-browser-metadata-added", file: "client", from: "await post(parsed.data, expectedGeneration)", to: "await post({ ...parsed.data, properties: { ...parsed.data.properties, pathname: window.location.pathname } }, expectedGeneration)", script: "scripts/analytics-client-check.ts", test: "client-error" },
  { name: "tenancy-anonymous-event-name", file: "server", from: "return sendAnalyticsEvent(ctx?.visitorId ?? randomUUID(), event,", to: "return sendAnalyticsEvent(ctx?.visitorId ?? randomUUID(), \"retired_signup_started\",", script: "scripts/tenancy/analytics.check.ts" },
  { name: "tenancy-person-collapsed", file: "identity", from: "distinctId: String(row.person_id)", to: "distinctId: String(row.group_id)", script: "scripts/tenancy/analytics.check.ts" },
];
const selected = process.env.ANALYTICS_MUTATION ? mutations.filter((mutation) => mutation.name.startsWith(process.env.ANALYTICS_MUTATION!)) : mutations;
assert(selected.length > 0);
let failed = 0;
try {
  for (const folder of ["src", "scripts", "content"]) cpSync(join(root, folder), join(fixture, folder), { recursive: true });
  for (const file of ["package.json", "tsconfig.json"]) cpSync(join(root, file), join(fixture, file));
  symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
  for (const mutation of selected) {
    const path = join(fixture, "src/lib/analytics", `${mutation.file}.ts`);
    const fixed = readFileSync(path, "utf8");
    assert(fixed.includes(mutation.from), `mutation source not found: ${mutation.name}`);
    try {
      writeFileSync(path, fixed.replace(mutation.from, mutation.to));
      const script = mutation.script ?? "scripts/analytics-check.ts";
      const result = spawnSync(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), script], {
        cwd: fixture, encoding: "utf8", timeout: 60000,
        env: { ...process.env, ANALYTICS_CHECK_CASE: mutation.script ? "" : mutation.test, ANALYTICS_CLIENT_CASE: mutation.script?.includes("client") ? mutation.test : "" },
      });
      const output = `${result.stdout}\n${result.stderr}`;
      const rejected = result.status !== 0 && output.includes("FAIL ") && !output.includes("Transform failed");
      if (!rejected) { failed++; console.error(`FAIL mutation ${mutation.name}: ${output.slice(-1600)}`); }
      else console.log(`PASS mutation ${mutation.name}`);
    } finally { writeFileSync(path, fixed); }
  }
} finally { rmSync(fixture, { recursive: true, force: true }); }
console.log(`Analytics mutation proof: ${selected.length - failed} rejected, ${failed} escaped`);
process.exitCode = failed ? 1 : 0;
