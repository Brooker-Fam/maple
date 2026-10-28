import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_synthetic_client";
delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { pathname: "/pricing", href: "https://example.test/pricing?token=synthetic-private&utm_source=google" } } });
Object.defineProperty(globalThis, "document", { configurable: true, value: { referrer: "https://google.com/search?q=synthetic-private" } });
const calls: { body: Record<string, unknown>; init: RequestInit }[] = [];
let respond: (body: Record<string, unknown>) => Promise<Response> = async () => Response.json({ success: true });
globalThis.fetch = async (url, init = {}) => {
  assert.equal(url, "/api/maple/analytics/event");
  const body = JSON.parse(String(init.body));
  calls.push({ body, init });
  return respond(body);
};
const delay = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean) {
  for (let i = 0; i < 400 && !test(); i++) await delay();
  assert.ok(test(), "expected browser request");
}
let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  if (process.env.ANALYTICS_CLIENT_CASE && process.env.ANALYTICS_CLIENT_CASE !== name) return;
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}`, error); }
}
async function main() {
  const client = await import("../src/lib/analytics/client");
  await check("client-retries", async () => {
    let attempts = 0;
    respond = async (body) => body.event && ++attempts < 3 ? new Response(null, { status: 503 }) : Response.json({ success: true });
    client.captureSitePage("/pricing");
    await until(() => attempts === 3);
    const retries = calls.filter((c) => c.body.event === "$pageview");
    assert.equal(retries.length, 3);
    assert.deepEqual(retries[0].body, retries[1].body);
    assert.deepEqual(retries[1].body, retries[2].body);
    assert.ok(!JSON.stringify(calls).includes("synthetic-private"));
    assert.equal(retries[0].init.credentials, "same-origin");
    await client.resetAnalytics();
  });
  await check("reset-barrier", async () => {
    const releases: (() => void)[] = [];
    let resetSeen = false;
    respond = async (body) => {
      if (body.action === "reset") {
        resetSeen = true;
        await new Promise<void>((resolve) => { releases.push(resolve); });
      }
      return Response.json({ success: true });
    };
    const resetting = client.resetAnalytics();
    await until(() => resetSeen);
    const count = calls.length;
    client.captureSiteEvent("signup_clicked", { placement: "hero" });
    await delay(50);
    const waited = calls.length === count;
    for (const release of releases) release();
    await resetting;
    assert.equal(waited, true, "new visitor requests must wait for reset acknowledgement");
    await until(() => calls.some((c) => c.body.event === "signup_clicked"));
  });
  await check("reset-failure", async () => {
    respond = async (body) => body.action === "reset" ? new Response(null, { status: 503 }) : Response.json({ success: true });
    await client.resetAnalytics();
    const count = calls.length;
    client.captureSitePage("/pricing");
    await delay(1100);
    assert.equal(calls.slice(count).some((c) => c.body.event || c.body.action === "context"), false, "failed reset must not reuse an old visitor");
    respond = async () => Response.json({ success: true });
    await client.resetAnalytics();
  });
  await check("client-error", async () => {
    calls.length = 0;
    respond = async () => Response.json({ success: true });
    client.captureSiteEvent("client_error", { error_class: "TypeError", area: "window" });
    await until(() => calls.some((c) => c.body.event === "client_error"));
    const body = calls.find((c) => c.body.event === "client_error")!.body;
    assert.deepEqual(body.properties, { error_class: "TypeError", area: "window" });
    assert.equal(typeof body.event_id, "string");
    assert.notEqual(body.event_id, randomUUID());
    assert.ok(!JSON.stringify(calls).includes("pricing"));
  });
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else Reflect.deleteProperty(globalThis, "document");
  console.log(`Analytics browser: ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
