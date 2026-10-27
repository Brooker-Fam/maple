import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { monitor } from "./usage-health-monitor.mjs";

const env = { MAPLE_USAGE_MONITOR_SECRET: "synthetic-monitor-secret", MAPLE_USAGE_MONITOR_RESEND_KEY: "synthetic-sending-key" };
const now = new Date("2026-10-27T12:45:00Z");
const health = "https://maplebaby.app/api/maple/usage-alerts?health=1";
const resend = "https://api.resend.com/emails";
const response = (status) => ({ status, get body() { throw new Error("Response content must not be read"); }, json() { throw new Error("Response content must not be read"); }, text() { throw new Error("Response content must not be read"); } });

test("a healthy daily job sends no email and exposes no response content", async () => {
  const calls = [];
  const reports = [];
  const code = await monitor({ env, now, report: (line) => reports.push(line), fetcher: async (url, init) => {
    calls.push(url);
    assert.equal(url, health);
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, `Bearer ${env.MAPLE_USAGE_MONITOR_SECRET}`);
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, "error");
    return response(204);
  } });
  assert.equal(code, 0);
  assert.deepEqual(calls, [health]);
  assert.deepEqual(reports, []);
});

test("unhealthy retries use one stable daily email and always fail the check", async () => {
  const deliveries = new Map();
  const requests = [];
  let healthStatus = 503;
  const fetcher = async (url, init) => {
    if (url === health) return response(healthStatus);
    assert.equal(url, resend);
    assert.equal(init.headers.Authorization, `Bearer ${env.MAPLE_USAGE_MONITOR_RESEND_KEY}`);
    const key = init.headers["Idempotency-Key"];
    requests.push({ key, body: init.body });
    if (deliveries.has(key)) assert.equal(deliveries.get(key), init.body);
    else deliveries.set(key, init.body);
    return response(200);
  };
  for (const [at, status] of [["2026-10-27T12:45:00Z", 503], ["2026-10-27T21:59:59Z", 401], ["2026-10-27T23:59:59Z", 200]]) {
    healthStatus = status;
    assert.equal(await monitor({ env, now: new Date(at), fetcher, report: () => {} }), 1);
  }
  assert.equal(requests.length, 3);
  assert.equal(deliveries.size, 1);
  assert.equal(requests[0].key, "maple-usage-health/2026-10-27");
  const payload = JSON.parse(requests[0].body);
  assert.deepEqual(payload.to, ["hello@maplebaby.app"]);
  assert.equal(requests[0].body.includes(env.MAPLE_USAGE_MONITOR_SECRET), false);
  assert.equal(requests[0].body.includes(env.MAPLE_USAGE_MONITOR_RESEND_KEY), false);
  assert.equal(await monitor({ env, now: new Date("2026-10-28T00:00:00Z"), fetcher, report: () => {} }), 1);
  assert.equal(deliveries.size, 2);
});

test("a timed-out health request alerts the configured operator without leaking its error", { timeout: 1000 }, async () => {
  const reports = [];
  const sends = [];
  const fetcher = async (url, init) => {
    if (url === health) return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("Synthetic private failure")), { once: true }));
    assert.equal(url, resend);
    sends.push(JSON.parse(init.body));
    return response(200);
  };
  assert.equal(await monitor({ env: { ...env, MAPLE_ALERT_EMAIL: "operator@example.test" }, now, fetcher, timeoutMs: 5, report: (line) => reports.push(line) }), 1);
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].to, ["operator@example.test"]);
  assert.deepEqual(reports, ["Maple usage health check failed; operator email accepted."]);
});

test("the executable fails after an unhealthy response even when the email succeeds", () => {
  const directory = mkdtempSync(join(tmpdir(), "maple-usage-health-"));
  try {
    const preload = join(directory, "synthetic-fetch.mjs");
    writeFileSync(preload, `globalThis.fetch = async (url) => ({ status: url === ${JSON.stringify(health)} ? 503 : 200 });`);
    const result = spawnSync(process.execPath, ["--import", preload, "scripts/usage-health-monitor.mjs"], { encoding: "utf8", env: { ...env, MAPLE_ALERT_EMAIL: "operator@example.test" } });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Maple usage health check failed; operator email accepted.\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
