import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { PostHog } from "posthog-node";
import type { NextRequest } from "next/server";
import type { AnalyticsActor } from "../src/lib/analytics/identity";
import { syncRequestFor } from "../src/lib/maple/diagnostics";

const PRIVATE = "synthetic_private_token";
const ACTOR = { member: "synthetic-parent@example.test", familyId: 701, role: "owner" };
const ID = "00000000-0000-4000-8000-000000000001";
const GROUP = "00000000-0000-4000-8000-000000000002";
let passed = 0;
let failed = 0;

function load<T>(path: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const source = readFileSync(path, "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const exports = {};
  runInNewContext(js, {
    exports, performance, Error, TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError, AggregateError,
    console: { error() {} }, process: { env: { NEXT_PUBLIC_POSTHOG_KEY: "phc_synthetic_check" } },
    require: (name: string) => {
      assert(name in mocks, `Unexpected dependency: ${name}`);
      return mocks[name];
    },
    ...globals,
  });
  return exports as T;
}

async function check(name: string, test: () => unknown | Promise<unknown>) {
  try { await test(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

function server(options: { failure?: "construct" | "capture" | "flush" | "identity"; identity?: unknown; realSdk?: boolean } = {}) {
  const captures: { error: Error; id?: string; properties: Record<string, unknown> }[] = [];
  const actors: unknown[] = [];
  const api = load<typeof import("../src/lib/posthog-server")>("src/lib/posthog-server.ts", {
    "node:crypto": { randomUUID },
    "posthog-node": { PostHog: options.realSdk ? PostHog : class {
      constructor() { if (options.failure === "construct") throw new Error(PRIVATE); }
      captureException(error: Error, id: string, properties: Record<string, unknown>) {
        if (options.failure === "capture") throw new Error(PRIVATE);
        captures.push({ error, id, properties });
      }
      async captureExceptionImmediate(error: Error, id: string, properties: Record<string, unknown>) {
        this.captureException(error, id, properties);
        await this.flush();
      }
      async flush() { if (options.failure === "flush") throw new Error(PRIVATE); }
    } },
    "@/lib/analytics/identity": { resolveAnalyticsActor: async (actor: unknown) => {
      actors.push(actor);
      if (options.failure === "identity") throw new Error(PRIVATE);
      return options.identity === undefined ? { distinctId: ID, familyGroupId: GROUP } : options.identity;
    } },
    "@/lib/analytics/config": { analyticsTags: () => ({ environment: "development", is_test: true, schema_version: 2 }) },
    "@/lib/analytics/policy": { analyticsHost: () => "https://us.i.posthog.com" },
  });
  return { ...api, captures, actors };
}

class StoreUnavailable extends Error {}
class NotFound extends Error {}
class Conflict extends Error {}
class CareConflict extends Error {}
class CareForbidden extends Error {}
class OnlyHers extends Error {}
class FeedEditError extends Error {}
class AnswerError extends Error {}

function api(failure?: "capture" | "delivery" | "auth") {
  const reports: unknown[][] = [];
  const diagnostics: { event: string; requestId: string; status: number }[] = [];
  const alerts: { key: string; subject: string; body: string }[] = [];
  const emails: { idempotencyKey?: string; text: string }[] = [];
  const tasks: (() => Promise<void>)[] = [];
  const loaded = load<typeof import("../src/lib/maple/api")>("src/lib/maple/api.ts", {
    "node:crypto": { createHash },
    "@/components/site/legal": { CONTACT_EMAIL: "operator@example.test" },
    "@/lib/email/send": { sendEmail: async (email: { idempotencyKey?: string; text: string }) => { emails.push(email); return { sent: true, id: "synthetic-email-id" }; } },
    "@/lib/analytics/config": { analyticsTags: () => ({ environment: "production", is_test: false, schema_version: 2 }) },
    "next/server": { NextResponse: { json: (body: unknown, init: ResponseInit) => Response.json(body, init) }, after: (task: () => Promise<void>) => tasks.push(task) },
    "@/lib/posthog-server": {
      scrubError: () => new Error("Error"),
      captureServerException: async (...args: unknown[]) => { reports.push(args); if (failure === "capture") throw new Error(PRIVATE); },
    },
    "./diagnostics": { syncRequestFor, logSyncDiagnostic: (event: { event: string; requestId: string; status: number }) => diagnostics.push(event) },
    "./auth": { listMembers: async () => [], sessionContext: async () => {
      if (failure === "auth") throw new StoreUnavailable(PRIVATE);
      return { member: { id: ACTOR.member, role: "owner" }, ctx: { ...ACTOR, status: "active", tz: "UTC", babyId: 801 } };
    } },
    "./care-store": { CareConflict, CareForbidden, viewerFor: () => ({}), careSession: async () => ({ person: {}, access: { read: true, write: true } }) },
    "./feed": { FeedEditError }, "./family": { FAMILY_ONE: 1, parseFamilyId: Number },
    "./store": { StoreUnavailable, NotFound, Conflict, getBaby: async () => null, toClientEntry: (v: unknown) => v },
    "./time": { DEFAULT_TZ: "UTC" }, "./validate": { OnlyHers }, "./voice": {}, "./onboarding/steps": { AnswerError },
    "./usage-alerts/delivery": {
      deliveryDeps: (over: object) => ({ now: new Date("2026-10-28T12:00:00Z"), env: {}, ...over }),
      deliver: async (alert: { key: string; subject: string; body: string }, deps: { report: (error: Error) => unknown }) => {
        alerts.push(alert);
        if (failure === "delivery") { await deps.report(new Error(PRIVATE)); throw new Error(PRIVATE); }
        return true;
      },
    },
    "./origin": { MAPLE_ORIGIN: "https://synthetic.example.test" },
  });
  return { ...loaded, reports, diagnostics, alerts, emails, drain: async () => { for (const task of tasks.splice(0)) await task(); } };
}

async function checkServer() {
  await check("exception scrubbing drops arbitrary tokens, nested causes and raw stack URLs", () => {
    const s = server();
    for (const input of [new Error(PRIVATE), { name: PRIVATE, message: PRIVATE, code: PRIVATE }, Object.assign(new TypeError(PRIVATE), { code: PRIVATE, cause: new Error(PRIVATE), stack: `TypeError: ${PRIVATE}\n    at handler (https://synthetic.example.test/${PRIVATE}?token=${PRIVATE}:1:2)` })]) {
      const clean = s.scrubError(input);
      assert(!`${clean.name} ${clean.message} ${clean.stack} ${JSON.stringify(clean)}`.includes(PRIVATE));
      assert.equal(clean.cause, undefined);
    }
    assert.equal(s.scrubError(new TypeError(PRIVATE)).name, "TypeError");
  });
  await check("exception context permits only static fields and creates no server person profile", async () => {
    const s = server();
    await s.captureServerException(new TypeError(PRIVATE), { route: "POST /api/maple/entries", where: "email", tool: "list_entries", kind: "invite", content: PRIVATE, $set: { email: PRIVATE }, $groups: { family: 701 } });
    await s.captureServerException(new Error(PRIVATE), { route: `/api/maple/${PRIVATE}`, where: PRIVATE, tool: PRIVATE, kind: PRIVATE });
    const first = s.captures[0];
    assert.equal(first.properties.route, "POST /api/maple/entries");
    assert.equal(first.properties.where, "email");
    assert.equal(first.properties.tool, "list_entries");
    assert.equal(first.properties.kind, "invite");
    for (const capture of s.captures) {
      assert.equal(capture.properties.$process_person_profile, false);
      assert.equal(capture.properties.$geoip_disable, true);
      assert.notEqual(capture.id, "server");
      assert(!JSON.stringify(capture).includes(PRIVATE));
      assert.equal(capture.properties.$groups, undefined);
    }
  });
  await check("installed PostHog SDK emits sanitized $exception wire payloads without a server person", async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    const s = server({ realSdk: true });
    globalThis.fetch = async (_input, init) => {
      const body = Buffer.from(await new Response(init?.body).arrayBuffer());
      requests.push((body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body).toString("utf8"));
      return new Response("{}", { status: 200 });
    };
    try {
      await s.captureServerException(Object.assign(new TypeError(PRIVATE), { stack: `TypeError: ${PRIVATE}\n    at fetch (https://synthetic.example.test/${PRIVATE}:1:2)` }), { route: "GET /api/maple/state", content: PRIVATE });
      assert.equal(requests.length, 1);
      const event = JSON.parse(requests[0]).batch[0];
      assert.equal(event.event, "$exception");
      assert.equal(event.properties.$process_person_profile, false);
      assert.equal(event.properties.$geoip_disable, true);
      assert.equal(event.properties.environment, "development");
      assert.equal(event.properties.schema_version, 2);
      assert.equal(event.properties.is_test, true);
      assert.equal(event.properties.$exception_list[0].type, "TypeError");
      assert.equal(event.properties.$exception_list[0].stacktrace, undefined);
      assert(!requests[0].includes(PRIVATE));
    } finally {
      await s.getPostHogServer()?.shutdown();
      globalThis.fetch = originalFetch;
    }
  });
  await check("authenticated exception uses opaque actor and family group only", async () => {
    const s = server();
    await s.captureServerException(new Error(PRIVATE), { route: "GET /api/maple/state" }, ACTOR as AnalyticsActor);
    assert.equal(s.actors.length, 1);
    assert.equal(s.captures[0].id, ID);
    assert.equal(s.captures[0].properties.$process_person_profile, true);
    assert.equal((s.captures[0].properties.$groups as { family: string }).family, GROUP);
    assert(!JSON.stringify(s.captures).includes(ACTOR.member));
  });
  await check("constructor, capture, flush and identity failures cannot escape; missing identity still reports", async () => {
    for (const failure of ["construct", "capture", "flush", "identity"] as const) {
      const s = server({ failure });
      await s.captureServerException(new Error(PRIVATE), {}, ACTOR as AnalyticsActor);
      if (failure === "identity") {
        assert.equal(s.captures.length, 1);
        assert.equal(s.captures[0].properties.$process_person_profile, false);
      }
    }
  });
}

async function checkDiagnostics() {
  await check("sync diagnostic exceptions preserve only the two exact labels", async () => {
    const s = server();
    for (const label of ["sync_request_failed", "sync_diagnostics_failed"]) {
      await s.captureServerException(new Error(label));
      const capture = s.captures.at(-1)!;
      assert.equal(capture.error.message, label);
      assert.equal((capture.properties.$exception_list as { value: string }[])[0].value, label);
      assert.equal(s.scrubError(capture.error).message, label);
    }
    let messageReads = 0;
    const changing = { get message() { return ++messageReads < 3 ? "sync_request_failed" : PRIVATE; } };
    assert(!s.scrubError(changing).message.includes(PRIVATE));
    for (const message of ["sync_request_failed_private", "SYNC_REQUEST_FAILED", `sync_diagnostics_failed: ${PRIVATE}`]) {
      const clean = s.scrubError(Object.assign(new Error(message), { name: PRIVATE }));
      assert.equal(clean.name, "Error");
      assert.equal(clean.message, "Error");
      assert.equal(clean.stack, "Error: Error");
    }
  });
  await check("diagnostic status accepts integer zero or HTTP range only", async () => {
    const s = server();
    for (const status of [0, 100, 200, 400, 503, 599]) {
      await s.captureServerException(new Error("sync_request_failed"), { status });
      assert.equal(s.captures.at(-1)!.properties.status, status);
    }
    for (const status of [undefined, null, -1, 1, 99, 600, 100.5, NaN, Infinity, "503", [], {}]) {
      await s.captureServerException(new Error("sync_request_failed"), { status });
      assert.equal(s.captures.at(-1)!.properties.status, undefined);
    }
  });
  await check("diagnostic request IDs accept only UUIDv4 and normalize case", async () => {
    const s = server();
    const id = "abcdef12-3456-4789-8abc-def012345678";
    for (const requestId of [id, id.toUpperCase()]) {
      await s.captureServerException(new Error("sync_request_failed"), { requestId });
      assert.equal(s.captures.at(-1)!.properties.requestId, id);
    }
    for (const requestId of [undefined, null, 701, [id], { id }, id.replace("-4789-", "-1789-"), id.replace("-4789-", "-5789-"),
      id.replace("-8abc-", "-7abc-"), `${id}\n`, ` ${id}`, `${id}/${PRIVATE}`, PRIVATE]) {
      await s.captureServerException(new Error("sync_request_failed"), { requestId });
      assert.equal(s.captures.at(-1)!.properties.requestId, undefined);
    }
  });
  await check("diagnostics route accepts only its static path and method", async () => {
    const s = server();
    for (const route of ["/api/maple/diagnostics", "POST /api/maple/diagnostics"]) {
      await s.captureServerException(new Error("sync_diagnostics_failed"), { route });
      assert.equal(s.captures.at(-1)!.properties.route, route);
    }
    for (const route of [`/api/maple/diagnostics?token=${PRIVATE}`, `/api/maple/diagnostics/${PRIVATE}`, `POST /api/maple/diagnostics ${PRIVATE}`]) {
      await s.captureServerException(new Error("sync_diagnostics_failed"), { route });
      assert.equal(s.captures.at(-1)!.properties.route, undefined);
    }
  });
}

async function checkSyncIntegration() {
  await check("sync finish avoids duplicate 500/503 reports and preserves direct failure diagnostics", async () => {
    const requestId = "abcdef12-3456-4789-8abc-def012345678";
    const request = { headers: new Headers({ "x-maple-request-id": requestId.toUpperCase() }) } as NextRequest;
    for (const [error, status] of [[new StoreUnavailable(PRIVATE), 503], [new TypeError(PRIVATE), 500]] as const) {
      const a = api();
      const response = await a.withMember("GET /api/maple/state", async () => { throw error; })(request);
      assert.equal(response.status, status);
      assert.equal(a.reports.length, 1, `HTTP ${status} must be reported once`);
      assert.equal((a.reports[0][2] as AnalyticsActor).member, ACTOR.member);
      assert.equal(a.diagnostics.length, 1);
      assert.equal(a.diagnostics[0].requestId, requestId);
      assert.equal(a.diagnostics[0].status, status);
      await a.drain();
      assert.equal(a.alerts.length, 1);
    }
    for (const status of [400, 503]) {
      const a = api();
      const response = await a.withMember("GET /api/maple/state", async () => {
        if (status === 400) throw new a.BadRequest(PRIVATE);
        return Response.json({ error: PRIVATE }, { status });
      })(request);
      assert.equal(response.status, status);
      assert.equal(a.reports.length, 1);
      const s = server();
      await s.captureServerException(a.reports[0][0], a.reports[0][1] as Record<string, unknown>);
      assert.equal(s.captures[0].error.message, "sync_request_failed");
      assert.equal(s.captures[0].properties.status, status);
      assert.equal(s.captures[0].properties.requestId, requestId);
      assert(!JSON.stringify(s.captures).includes(PRIVATE));
    }
  });
}

async function checkApi() {
  await check("both API database 503 paths report and queue static daily category alerts", async () => {
    const a = api();
    assert.equal((await a.errorResponse("GET /api/maple/state", new StoreUnavailable(PRIVATE))).status, 503);
    assert.equal((await a.careErrorResponse("GET /api/maple/care/entries", new StoreUnavailable(PRIVATE))).status, 503);
    assert.equal(a.reports.length, 2);
    await a.drain();
    assert.equal(a.alerts.length, 2);
    assert.equal(a.alerts[0].key, a.alerts[1].key);
    assert.match(a.alerts[0].key, /2026-10-28/);
    assert(a.alerts[0].body.includes("https://synthetic.example.test/maple/admin"));
    assert(!JSON.stringify(a.alerts).includes(PRIVATE));
  });
  await check("database alert claim failure still emails with the normal delivery idempotency key", async () => {
    const a = api("delivery");
    for (let i = 0; i < 2; i++) {
      assert.equal((await a.errorResponse("GET /api/maple/state", new StoreUnavailable(PRIVATE))).status, 503);
    }
    await a.drain();
    assert.equal(a.emails.length, 2);
    const key = `usage/${createHash("sha256").update(a.alerts[0].key).digest("hex")}`;
    assert.equal(a.emails[0].idempotencyKey, key);
    assert.equal(a.emails[1].idempotencyKey, key);
    assert(a.emails[0].text.includes("https://synthetic.example.test/maple/admin"));
    assert(!JSON.stringify(a.emails).includes(PRIVATE));
    assert.equal(a.reports.length, 2);
  });
  await check("member and care wrappers attach authenticated actor to errors and report pre-auth failures anonymously", async () => {
    const a = api();
    const request = { headers: new Headers() } as Parameters<ReturnType<typeof a.withMember>>[0];
    for (const wrap of [a.withMember, a.withCare]) {
      const result = await wrap("GET /api/maple/state", async () => { throw new TypeError(PRIVATE); })(request);
      assert.equal(result.status, 500);
    }
    assert.equal(a.reports.length, 2);
    for (const report of a.reports) assert.equal((report[2] as AnalyticsActor).member, ACTOR.member);
    const broken = api("auth");
    assert.equal((await broken.withMember("GET /api/maple/state", async () => Response.json({})) (request)).status, 503);
    assert.equal(broken.reports.length, 1);
    assert.equal(broken.reports[0][2], undefined);
  });
  await check("API error response survives reporter/alert failures with no reporting recursion or validation alerts", async () => {
    for (const failure of ["capture", "delivery"] as const) {
      const a = api(failure);
      assert.equal((await a.errorResponse("GET /api/maple/state", new TypeError(PRIVATE))).status, 500);
      assert.equal((await a.careErrorResponse("GET /api/maple/care/entries", new TypeError(PRIVATE))).status, 500);
      assert.equal((await a.errorResponse("GET /api/maple/state", new a.BadRequest("Synthetic invalid input"))).status, 400);
      await a.drain();
      assert.equal(a.reports.length, 2);
      assert.equal(a.alerts.length, 2);
    }
  });
}

async function checkClient() {
  await check("browser errors send class and static area only, throttle repeats, skip offline and remove listeners", async () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const signals: unknown[][] = [];
    let cleanup: (() => void) | undefined;
    let now = 0;
    const navigator = { onLine: true };
    const client = load<{ default: () => null }>("src/components/analytics/ClientErrors.tsx", {
      react: { useEffect: (effect: () => (() => void)) => { cleanup = effect(); } },
      "@/lib/analytics/client": { captureSiteEvent: (...args: unknown[]) => { signals.push(args); return Promise.reject(new Error(PRIVATE)); } },
    }, {
      navigator, Date: { now: () => now },
      window: {
        addEventListener: (name: string, listener: (event: Record<string, unknown>) => void) => listeners.set(name, listener),
        removeEventListener: (name: string) => listeners.delete(name),
      },
    });
    client.default();
    const fire = (name: string, error: unknown) => listeners.get(name)?.({ error, reason: error, message: PRIVATE, filename: `https://synthetic.example.test/${PRIVATE}` });
    for (let i = 0; i < 20; i++) fire("error", new TypeError(PRIVATE));
    assert.equal(signals.length, 1);
    assert.equal(JSON.stringify(signals[0]), JSON.stringify(["client_error", { error_class: "TypeError", area: "window" }]));
    fire("unhandledrejection", PRIVATE);
    assert.equal(JSON.stringify(signals[1]), JSON.stringify(["client_error", { error_class: "UnhandledRejection", area: "unhandledrejection" }]));
    navigator.onLine = false;
    now += 60_001;
    fire("error", new TypeError(PRIVATE));
    assert.equal(signals.length, 2);
    navigator.onLine = true;
    fire("error", new TypeError(PRIVATE));
    assert.equal(signals.length, 3);
    for (const ctor of [Error, RangeError, ReferenceError, SyntaxError, URIError, EvalError]) fire("error", new ctor(PRIVATE));
    assert(signals.length <= 7, "global burst cap");
    assert(!JSON.stringify(signals).includes(PRIVATE));
    await new Promise((resolve) => setImmediate(resolve));
    cleanup?.();
    assert.equal(listeners.size, 0);
  });
}

async function main() {
  await checkServer();
  await checkDiagnostics();
  await checkSyncIntegration();
  await checkApi();
  await checkClient();
  console.log(`Analytics errors: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
void main();
