import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import { query } from "../src/lib/db";
import { scrubError } from "../src/lib/posthog-server";
import { StoreUnavailable } from "../src/lib/maple/store";
import * as diagnostics from "../src/lib/maple/diagnostics";

process.env.DATABASE_URL = "pglite:sync-diagnostics-check";
process.env.MAPLE_SESSION_SECRET = "synthetic-diagnostic-secret";
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;

const ID = "00000000-0000-4000-8000-000000000001";
const PRIVATE = "Synthetic Parent private@example.test synthetic-health-value";
const root = resolve(__dirname, "..");
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
let passed = 0;
let failed = 0;

function load<T>(file: string, mocks: Record<string, unknown> = {}, globals: Record<string, unknown> = {}): T {
  const path = resolve(root, file);
  const source = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const actual = createRequire(path);
  const module = { exports: {} };
  const names = Object.keys(globals);
  const run = new Function("require", "module", "exports", ...names, source);
  run((name: string) => name in mocks ? mocks[name] : actual(name), module, module.exports, ...Object.values(globals));
  return module.exports as T;
}

async function check(name: string, run: () => void | Promise<void>) {
  try {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function browser(hang = false) {
  let now = 1_000_000;
  let id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const sent: { url: unknown; init: RequestInit; events: diagnostics.SyncDiagnostic[] }[] = [];
  const crypto = { randomUUID };
  const client = load<typeof import("../src/lib/maple/diagnostics-client")>("src/lib/maple/diagnostics-client.ts", { "./diagnostics": diagnostics }, {
    window: {},
    globalThis: { crypto },
    Date: class extends Date { static now() { return now; } },
    setTimeout: (callback: () => void, delay: number) => { timers.set(++id, { at: now + delay, callback }); return id; },
    clearTimeout: (key: number) => timers.delete(key),
    fetch: async (url: unknown, init: RequestInit) => {
      sent.push({ url, init, events: JSON.parse(String(init.body)).events });
      if (hang) await new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error(PRIVATE))));
      return new Response(null, { status: 204 });
    },
  });
  const advance = async (duration: number) => {
    now += duration;
    for (const [key, timer] of timers) {
      if (timer.at <= now) { timers.delete(key); timer.callback(); }
    }
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { client, sent, advance, timers, crypto };
}

async function main() {
  await check("diagnostic schema accepts safe events and rejects private, invalid and oversized inputs", () => {
    const clean = diagnostics.syncDiagnostic("write_succeeded", { requestId: ID, status: 201, elapsedMs: 10.5, private: PRIVATE } as diagnostics.SyncDiagnosticDetails);
    assert.deepEqual(clean, { event: "write_succeeded", requestId: ID, status: 201, elapsedMs: 11 });
    assert.deepEqual(diagnostics.parseSyncDiagnostics({ events: [clean] }), [clean]);
    for (const key of ["entryId", "kind", "action", "familyId", "email", "name", "rev", "timestamp", "url", "message"]) {
      assert.equal(diagnostics.parseSyncDiagnostics({ events: [{ ...clean, [key]: PRIVATE }] }), null, key);
    }
    for (const extra of [{ event: PRIVATE }, { requestId: PRIVATE }, { status: -1 }, { status: 600 }, { elapsedMs: -1 }, { elapsedMs: 1.5 }, { elapsedMs: 120001 }]) {
      assert.equal(diagnostics.parseSyncDiagnostics({ events: [{ ...clean, ...extra }] }), null);
    }
    assert.equal(diagnostics.parseSyncDiagnostics({ events: [clean], extra: PRIVATE }), null);
    assert.equal(diagnostics.parseSyncDiagnostics({ events: Array(9).fill(clean) }), null);
    assert.equal(diagnostics.parseSyncDiagnostics({ events: [] }), null);
    assert.deepEqual(diagnostics.syncDiagnostic("refresh_failed", { requestId: PRIVATE, status: 0, elapsedMs: Infinity }), { event: "refresh_failed", status: 0 });
    assert.deepEqual(diagnostics.parseSyncDiagnostics({ events: [{ event: "refresh_failed", status: 0 }] }), [{ event: "refresh_failed", status: 0 }]);
    assert.equal(diagnostics.syncDiagnostic("refresh_failed", { elapsedMs: 500000 })?.elapsedMs, 120000);
    assert.equal(diagnostics.syncDiagnostic("api_response"), null);
  });

  await check("browser batches only allowlisted metadata without blocking, persistence or identifiers", async () => {
    const b = browser();
    const first = b.client.newSyncRequestId();
    const second = b.client.newSyncRequestId();
    assert.ok(diagnostics.syncRequestId(first));
    assert.notEqual(first, second);
    assert.equal(b.client.recordSyncDiagnostic("write_succeeded", { requestId: ID, status: 201, elapsedMs: 17, private: PRIVATE } as diagnostics.SyncDiagnosticDetails), undefined);
    assert.equal(b.sent.length, 0);
    await b.advance(250);
    assert.equal(b.sent.length, 1);
    assert.deepEqual(b.sent[0].events, [{ event: "write_succeeded", requestId: ID, status: 201, elapsedMs: 17 }]);
    assert.equal(b.sent[0].url, "/api/maple/diagnostics");
    assert.equal(b.sent[0].init.credentials, "same-origin");
    assert.equal(b.sent[0].init.mode, "same-origin");
    assert.equal(b.sent[0].init.referrerPolicy, "strict-origin");
    assert.equal(b.sent[0].init.redirect, "error");
    assert(!String(b.sent[0].init.body).includes(PRIVATE));
    b.crypto.randomUUID = () => { throw new Error(PRIVATE); };
    assert.equal(b.client.newSyncRequestId(), undefined);
    assert.doesNotThrow(() => b.client.recordSyncDiagnostic("write_failed", new Proxy({}, { get() { throw new Error(PRIVATE); } })));
  });

  await check("browser queue, event budget and transport timeout remain bounded after failure", async () => {
    const b = browser();
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 50; i++) b.client.recordSyncDiagnostic("stale_response_discarded", { requestId: ID });
      await b.advance(250);
    }
    assert.equal(b.sent.flatMap((request) => request.events).length, 30);
    assert(b.sent.every((request) => request.events.length <= 8));
    await b.advance(60_000);
    b.client.recordSyncDiagnostic("refresh_recovered");
    await b.advance(250);
    assert.equal(b.sent.at(-1)?.events[0].event, "refresh_recovered");
    const hanging = browser(true);
    hanging.client.recordSyncDiagnostic("refresh_failed");
    await hanging.advance(250);
    hanging.client.recordSyncDiagnostic("refresh_recovered");
    await hanging.advance(4000);
    assert.equal(hanging.sent[0].init.signal?.aborted, true);
    await hanging.advance(250);
    assert.equal(hanging.sent.length, 2);
    assert.equal(hanging.sent[1].events[0].event, "refresh_recovered");
    await hanging.advance(4000);
    assert.equal(hanging.timers.size, 0);
  });

  const logged: unknown[][] = [];
  const captured: { error: unknown; props: Record<string, unknown> }[] = [];
  let signedIn = true;
  let sessionFailure: Error | undefined;
  const logger = load<typeof diagnostics>("src/lib/maple/diagnostics.ts", {}, { console: { info: (...args: unknown[]) => logged.push(args) } });
  const captureServerException = async (error: unknown, props: Record<string, unknown> = {}) => { captured.push({ error: scrubError(error), props }); };
  const api = load<typeof import("../src/lib/maple/api")>("src/lib/maple/api.ts", {
    "next/server": { NextResponse, after: () => {} },
    "@/lib/analytics/config": { analyticsTags: () => ({ environment: "development", is_test: true }) },
    "@/lib/email/send": {},
    "./usage-alerts/delivery": {},
    "./auth": { sessionContext: async () => {
      if (sessionFailure) throw sessionFailure;
      return signedIn ? { member: { email: "synthetic-parent@example.test", role: "owner" }, ctx: { familyId: 701, status: "active" } } : null;
    } },
    "./diagnostics": logger,
    "@/lib/posthog-server": { captureServerException, scrubError },
  }, { console: { error: () => {} } });
  const req = (path = "state", id: string | null = ID) => new NextRequest(`https://synthetic.example.test/api/maple/${path}?private=${PRIVATE}`, { headers: id ? { "x-maple-request-id": id } : {} });

  await check("API correlation logs responses without body or URL and omits ordinary polls", async () => {
    logged.length = 0;
    const handler = api.withMember("GET /api/maple/state", async () => api.json({ private: PRIVATE }));
    assert.equal((await handler(req())).status, 200);
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], "maple_sync");
    const event = JSON.parse(String(logged[0][1]));
    assert.deepEqual(Object.keys(event).sort(), ["elapsedMs", "event", "requestId", "status"]);
    assert.equal(event.event, "api_response");
    assert.equal(event.requestId, ID);
    assert(!JSON.stringify(logged).includes(PRIVATE));
    await handler(req("state", null));
    await handler(req("state", "invalid"));
    await api.withMember("GET /api/maple/other", async () => api.json({}))(req());
    assert.equal(logged.length, 1);
  });

  await check("API captures safe expected errors and unavailable writes without duplicating unexpected errors", async () => {
    captured.length = 0;
    const run = (handler: () => Promise<Response>) => api.withMember("POST /api/maple/timer", handler)(req("timer"));
    assert.equal((await run(async () => api.json({ error: PRIVATE }, 409))).status, 409);
    assert.equal((await run(async () => { throw new StoreUnavailable(); })).status, 503);
    assert.equal((await run(async () => { throw Object.assign(new Error(PRIVATE), { code: "ECONNRESET" }); })).status, 500);
    signedIn = false;
    assert.equal((await run(async () => api.json({}))).status, 401);
    signedIn = true;
    assert.equal(captured.length, 4);
    for (const entry of [captured[0], captured[3]]) {
      assert.equal((entry.error as Error).message, "sync_request_failed");
      assert.deepEqual(Object.keys(entry.props).sort(), ["requestId", "status"]);
      assert(!JSON.stringify(entry).includes(PRIVATE));
    }
    assert.deepEqual([captured[0].props.status, captured[3].props.status], [409, 401]);
    assert.equal((captured[1].error as Error).name, "StoreUnavailable");
    assert.deepEqual(captured[1].props, { route: "POST /api/maple/timer", where: "api", kind: "database_unavailable" });
    assert.deepEqual(captured[2].props, { route: "POST /api/maple/timer", where: "api", kind: "server_error" });
    for (const { error, props } of captured) {
      assert(!JSON.stringify({ message: (error as Error).message, stack: (error as Error).stack, props }).includes(PRIVATE));
    }
  });

  await query(`CREATE TABLE upload_rate_limit (ip_hash VARCHAR(64) NOT NULL, window_start TIMESTAMP NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ip_hash, window_start))`);
  const route = load<typeof import("../src/app/api/maple/diagnostics/route")>("src/app/api/maple/diagnostics/route.ts", {
    "@/lib/db": { query }, "@/lib/maple/api": api, "@/lib/maple/diagnostics": logger, "@/lib/posthog-server": { captureServerException },
  });
  const body = { events: [{ event: "refresh_applied_after_write", requestId: ID, status: 200, elapsedMs: 15 }] };
  const post = (value: unknown = body, headers: Record<string, string> = {}) => new NextRequest("https://synthetic.example.test/api/maple/diagnostics", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://synthetic.example.test", "sec-fetch-site": "same-origin", ...headers },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });

  await check("diagnostics route requires authentication and same origin and rejects unsafe bodies before logging", async () => {
    logged.length = 0;
    assert.equal((await route.POST(post())).status, 204);
    assert.equal(logged.length, 1);
    assert.deepEqual(JSON.parse(String(logged[0][1])), body.events[0]);
    signedIn = false;
    assert.equal((await route.POST(post())).status, 401);
    signedIn = true;
    assert.equal((await route.POST(post(body, { origin: "https://other.example.test" }))).status, 403);
    assert.equal((await route.POST(post(body, { "sec-fetch-site": "same-site" }))).status, 403);
    assert.equal((await route.POST(post(body, { origin: "" }))).status, 403);
    assert.equal((await route.POST(post(body, { "content-type": "text/plain" }))).status, 415);
    assert.equal((await route.POST(post(body, { "content-length": "2049" }))).status, 413);
    assert.equal((await route.POST(post(" ".repeat(2049)))).status, 400);
    assert.equal((await route.POST(post({ events: [{ ...body.events[0], private: PRIVATE }] }))).status, 400);
    assert.equal((await route.POST(post(PRIVATE))).status, 400);
    assert.equal(logged.length, 1);
  });

  await check("diagnostics rate limit is durable, atomic, hashed and closed when its database fails", async () => {
    await query("UPDATE upload_rate_limit SET count = 119");
    const responses = await Promise.all(Array.from({ length: 4 }, () => route.POST(post())));
    assert.deepEqual(responses.map((response) => response.status).sort(), [204, 429, 429, 429]);
    const rows = await query("SELECT * FROM upload_rate_limit");
    assert.equal(rows?.length, 1);
    assert.match(String(rows![0].ip_hash), /^[a-f0-9]{64}$/);
    assert.equal(rows![0].count, 120);
    assert(!JSON.stringify(rows).includes("synthetic-parent@example.test"));
    await query("UPDATE upload_rate_limit SET window_start = NOW() - INTERVAL '2 days'");
    assert.equal((await route.POST(post())).status, 204);
    assert.equal((await query("SELECT * FROM upload_rate_limit"))?.length, 1);
    const oldDatabase = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    assert.equal((await route.POST(post())).status, 429);
    process.env.DATABASE_URL = oldDatabase;
    const broken = load<typeof route>("src/app/api/maple/diagnostics/route.ts", {
      "@/lib/db": { query: async () => { throw new Error(PRIVATE); } }, "@/lib/maple/api": api,
      "@/lib/maple/diagnostics": logger, "@/lib/posthog-server": { captureServerException },
    });
    assert.equal((await broken.POST(post())).status, 503);
    assert.equal((captured.at(-1)?.error as Error).message, "sync_diagnostics_failed");
  });

  await check("every diagnostics endpoint failure reports once without forwarding its input", async () => {
    await query("TRUNCATE upload_rate_limit");
    const outcomes: { status: number; reports: typeof captured }[] = [];
    const observe = async (request: NextRequest, endpoint = route.POST) => {
      captured.length = 0;
      const response = await endpoint(request);
      outcomes.push({ status: response.status, reports: [...captured] });
    };
    await observe(post(PRIVATE));
    signedIn = false;
    try { await observe(post()); } finally { signedIn = true; }
    await observe(post(body, { origin: "https://other.example.test" }));
    await observe(post(body, { "x-maple-family": "702" }));
    await observe(post(body, { "content-length": "2049" }));
    await observe(post(body, { "content-type": "text/plain" }));
    await query("UPDATE upload_rate_limit SET count = 120");
    await observe(post());
    const broken = load<typeof route>("src/app/api/maple/diagnostics/route.ts", {
      "@/lib/db": { query: async () => { throw new Error(PRIVATE); } }, "@/lib/maple/api": api,
      "@/lib/maple/diagnostics": logger, "@/lib/posthog-server": { captureServerException },
    });
    await observe(post(), broken.POST);
    sessionFailure = new TypeError(PRIVATE);
    try { await observe(post()); } finally { sessionFailure = undefined; }
    assert.deepEqual(outcomes.map(({ status, reports }) => [status, reports.length]), [
      [400, 1], [401, 1], [403, 1], [409, 1], [413, 1], [415, 1], [429, 1], [503, 1], [500, 1],
    ]);
    for (const { status, reports } of outcomes.filter(({ status }) => status !== 500)) {
      assert.equal((reports[0].error as Error).message, "sync_diagnostics_failed");
      assert.deepEqual(reports[0].props, { status });
      assert(!JSON.stringify(reports).includes(PRIVATE));
    }
  });
  console.log(`Sync diagnostics: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
