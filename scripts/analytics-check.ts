import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { freshDb, seedFamilies, sql } from "./tenancy/harness";
import { analyticsTags } from "../src/lib/analytics/config";
import { ANALYTICS_COOKIE, clearAnalyticsContext, ensureAnalyticsContext, parseAnalyticsContext, readAnalyticsContext, SESSION_IDLE_MS, VISITOR_LIFETIME_MS, type AnalyticsContext } from "../src/lib/analytics/context";
import { analyticsAlert, analyticsHealth } from "../src/lib/analytics/health";
import { resolveAnalyticsActor, type AnalyticsActor } from "../src/lib/analytics/identity";
import { BLOG_SLUGS, canonicalUrl, initialAttribution, PUBLIC_EVENT_SCHEMA, sitePage, UUID } from "../src/lib/analytics/policy";
import { migrateAnalytics, pruneAnalytics } from "../src/lib/analytics/schema";
import { captureAppEvent, capturePublicEvent, identifyAnalytics } from "../src/lib/analytics/server";
import { POST as publicEvent } from "../src/app/api/maple/analytics/event/route";
import { POST as appOpen } from "../src/app/api/maple/analytics/open/route";
import { sealSession, SESSION_COOKIE } from "../src/lib/maple/auth";

process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_synthetic_core_check";
process.env.MAPLE_SESSION_SECRET = "synthetic-core-secret";
process.env.MCP_SECRET = "synthetic-core-mcp-secret";
process.env.MAPLE_ANALYTICS_TEST = "1";
delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_EMAIL_DOMAIN;
delete process.env.MAPLE_READ_ONLY;
const PRIVATE = "synthetic-private@example.test synthetic-health-contents token=synthetic-secret";
type Event = { uuid: string; timestamp: string; distinct_id: string; event: string; properties: Record<string, unknown> };
const events: Event[] = [];
let responseStatus = 200;
let failed = 0;
let passed = 0;
const endpoint = "https://us.i.posthog.com/i/v0/e/";
globalThis.fetch = async (url, init) => {
  if (String(url) === endpoint) {
    events.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: responseStatus });
  }
  assert.match(String(url), /^https:\/\/us\.i\.posthog\.com\//);
  return Response.json({ status: 1 });
};

function req(body: unknown, cookie = "", origin = "http://localhost:3000", path = "/api/maple/analytics/event"): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "POST", headers: { origin, "content-type": "application/json", cookie, "x-real-ip": "198.51.100.77" }, body: JSON.stringify(body),
  });
}
const cookieFrom = (response: Response) => response.headers.get("set-cookie")!.split(";")[0];
const DAY_MS = 24 * 60 * 60 * 1000;
function sessionFixture(timestamp: number): string {
  const millis = timestamp.toString(16).padStart(12, "0");
  return `${millis.slice(0, 8)}-${millis.slice(8)}-7${randomUUID().slice(15)}`;
}
function validSession(event: Event): void {
  const id = String(event.properties.$session_id);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const start = parseInt(id.replaceAll("-", "").slice(0, 12), 16);
  const occurred = Date.parse(event.timestamp);
  assert.ok(start <= occurred, "session cannot start after its event");
  assert.ok(occurred < start + DAY_MS, "session must end before 24 hours");
}
function signedContext(context: AnalyticsContext): string {
  const binding = createHmac("sha256", process.env.MAPLE_SESSION_SECRET!).update("maple-analytics:auth:").digest("hex");
  const generation = createHmac("sha256", process.env.MAPLE_SESSION_SECRET!).update("maple-analytics:generation:initial").digest("hex");
  const payload = Buffer.from(JSON.stringify({ context, authBinding: binding, generationBinding: generation })).toString("base64url");
  const sig = createHmac("sha256", process.env.MAPLE_SESSION_SECRET!).update(`maple-analytics:v1:${payload}`).digest("base64url");
  return `${ANALYTICS_COOKIE}=${payload}.${sig}`;
}
function context(): AnalyticsContext {
  const response = new Response();
  const result = ensureAnalyticsContext(req({}), response, { pathname: "/pricing", utm_source: "google", utm_medium: "cpc" });
  assert(result);
  return result;
}
async function check(name: string, fn: () => Promise<void> | void) {
  if (process.env.ANALYTICS_CHECK_CASE && process.env.ANALYTICS_CHECK_CASE !== name) return;
  events.length = 0;
  responseStatus = 200;
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}

async function main() {
  await freshDb({ shape: "final", migrations: 2 });
  const { alpha, beta } = await seedFamilies();
  const actor: AnalyticsActor = { familyId: beta.familyId, member: beta.owner, role: "owner" };
  await check("identity", async () => {
    const first = await resolveAnalyticsActor(actor);
    assert(first);
    assert.match(first.distinctId, UUID);
    assert.match(first.familyGroupId, UUID);
    assert.notEqual(first.distinctId, first.familyGroupId);
    process.env.MAPLE_SESSION_SECRET = "synthetic-core-secret-rotated";
    process.env.GOOGLE_CLIENT_SECRET = "synthetic-core-google-rotated";
    assert.deepEqual(await resolveAnalyticsActor(actor), first);
    process.env.MAPLE_SESSION_SECRET = "synthetic-core-secret";
    assert.notEqual((await resolveAnalyticsActor({ ...actor, member: beta.member }))?.distinctId, first.distinctId);
    assert.equal((await resolveAnalyticsActor({ ...actor, member: beta.member }))?.familyGroupId, first.familyGroupId);
    await sql(`INSERT INTO maple_members (family_id,email,role,accepted_at) VALUES ($1,$2,'member',NOW())`, [alpha.familyId, beta.owner]);
    const other = await resolveAnalyticsActor({ ...actor, familyId: alpha.familyId });
    assert.equal(other?.distinctId, first.distinctId);
    assert.notEqual(other?.familyGroupId, first.familyGroupId);
    assert.equal(await resolveAnalyticsActor({ ...actor, member: "admin" }), null);
    assert.equal(await resolveAnalyticsActor({ ...actor, familyId: 999999 }), null);
    assert.equal(await resolveAnalyticsActor({ ...actor, member: "unaccepted@example.test" }), null);
    await sql(`INSERT INTO maple_members (family_id,email,role) VALUES ($1,'unaccepted@example.test','member')`, [beta.familyId]);
    assert.equal(await resolveAnalyticsActor({ ...actor, member: "unaccepted@example.test" }), null);
  });
  await check("cookies", () => {
    const response = new Response();
    const ctx = ensureAnalyticsContext(req({}), response, { pathname: "/pricing" })!;
    assert.match(response.headers.get("set-cookie")!, /HttpOnly; SameSite=Lax; Max-Age=2592000/);
    assert.deepEqual(readAnalyticsContext(req({}, cookieFrom(response))), ctx);
    const tampered = cookieFrom(response).replace(/.$/, "!");
    assert.equal(readAnalyticsContext(req({}, tampered)), undefined);
    assert.equal(parseAnalyticsContext({ ...ctx, member: PRIVATE }), undefined);
    assert.equal(parseAnalyticsContext({ ...ctx, issuedAt: Date.now() - VISITOR_LIFETIME_MS - 1 }), undefined);
    const again = ensureAnalyticsContext(req({}, cookieFrom(response)), new Response())!;
    assert.equal(again.visitorId, ctx.visitorId);
    assert.equal(again.sessionId, ctx.sessionId);
    const expired = { ...ctx, issuedAt: Date.now() - SESSION_IDLE_MS - 10, lastSeenAt: Date.now() - SESSION_IDLE_MS - 10 };
    const renewed = ensureAnalyticsContext(req({}, signedContext(expired)), new Response())!;
    assert.equal(renewed.visitorId, ctx.visitorId);
    assert.notEqual(renewed.sessionId, ctx.sessionId);
    const clear = new Response();
    clearAnalyticsContext(clear);
    assert.match(clear.headers.get("set-cookie")!, /Max-Age=0/);
    const secure = new Response();
    ensureAnalyticsContext(new Request("https://example.test/"), secure);
    assert.match(secure.headers.get("set-cookie")!, /; Secure$/);
    const redirect = NextResponse.redirect("http://localhost:3000/maple");
    ensureAnalyticsContext(req({}), redirect);
    redirect.cookies.set("synthetic_oauth_state", "synthetic_state");
    assert.match(redirect.headers.get("set-cookie")!, /maple_analytics=/, "analytics cookie must survive the later OAuth-state cookie write");
  });
  await check("privacy", async () => {
    assert.equal(sitePage("/blog/private-person"), null);
    assert.equal(sitePage("/signup?token=secret"), null);
    assert.equal(sitePage("/maple"), null);
    for (const slug of BLOG_SLUGS) assert.equal(sitePage(`/blog/${slug}`), `/blog/${slug}`);
    const attrs = initialAttribution(`https://example.test/pricing?utm_source=google&utm_medium=cpc&utm_campaign=${PRIVATE}&token=secret`, `https://google.com/search?q=${PRIVATE}`);
    assert.deepEqual(JSON.parse(JSON.stringify(attrs)), { pathname: "/pricing", utm_source: "google", utm_medium: "cpc", referrer_host: "google.com" });
    const event = PUBLIC_EVENT_SCHEMA.parse({ event: "$pageview", event_id: randomUUID(), properties: { pathname: "/pricing" } });
    const ctx = context();
    assert.equal(await capturePublicEvent(event, ctx), true);
    assert.equal(events[0].properties.$current_url, canonicalUrl("/pricing"));
    assert.equal(events[0].properties.$session_id, ctx.sessionId);
    assert.equal(events[0].properties.$process_person_profile, false);
    assert.equal(events[0].properties.is_test, true);
    assert.equal(events[0].properties.schema_version, 2);
    assert.equal(events[0].properties.$initial_utm_source, "google");
    await captureAppEvent(actor, "entry_logged", { email: PRIVATE, kind: PRIVATE, source: "ui", is_test: false, schema_version: 999, event_id: randomUUID() });
    assert.equal(events[1].properties.$process_person_profile, true);
    assert.equal(events[1].properties.source, "ui");
    assert.equal(events[1].properties.is_test, true);
    assert.equal(events[1].properties.schema_version, 2);
    assert.ok(!JSON.stringify(events).includes(PRIVATE));
    assert.ok(!JSON.stringify(events).includes(actor.member));
    for (const key of ["email", "actor", "is_test", "environment", "$current_url"]) {
      assert.equal(PUBLIC_EVENT_SCHEMA.safeParse({ ...event, properties: { ...event.properties, [key]: PRIVATE } }).success, false);
    }
  });
  await check("session-v7", async () => {
    const ctx = context();
    await capturePublicEvent(PUBLIC_EVENT_SCHEMA.parse({ event: "$pageview", event_id: randomUUID(), properties: { pathname: "/pricing" } }), ctx);
    validSession(events[0]);
    assert.equal(events[0].properties.$session_id, ctx.sessionId);
  });
  await check("session-legacy", () => {
    const old = { ...context(), sessionId: randomUUID() };
    const renewed = ensureAnalyticsContext(req({}, signedContext(old)), new Response())!;
    assert.notEqual(renewed.sessionId, old.sessionId, "legacy UUIDv4 cookie session must rotate");
    assert.equal(renewed.visitorId, old.visitorId);
    assert.match(renewed.sessionId, /^[0-9a-f-]{14}7/);
  });
  await check("session-limits", () => {
    const now = Date.now();
    for (const start of [now - DAY_MS, now + 60_000]) {
      const old = { ...context(), sessionId: sessionFixture(start) };
      const renewed = ensureAnalyticsContext(req({}, signedContext(old)), new Response())!;
      assert.notEqual(renewed.sessionId, old.sessionId, "active sessions must rotate at 24h or after clock rollback");
      assert.equal(renewed.visitorId, old.visitorId);
    }
  });
  await check("session-wire-bounds", async () => {
    for (const sessionId of [randomUUID(), sessionFixture(Date.now() + 60_000), sessionFixture(Date.now() - DAY_MS)]) {
      await capturePublicEvent(PUBLIC_EVENT_SCHEMA.parse({ event: "$pageview", event_id: randomUUID(), properties: { pathname: "/pricing" } }), { ...context(), sessionId });
      validSession(events.at(-1)!);
    }
  });
  await check("session-retry", async () => {
    const ctx = { ...context(), sessionId: sessionFixture(Date.now() - 1000) };
    const event = PUBLIC_EVENT_SCHEMA.parse({ event: "$pageview", event_id: randomUUID(), properties: { pathname: "/pricing" } });
    responseStatus = 503;
    assert.equal(await capturePublicEvent(event, ctx), false);
    responseStatus = 200;
    assert.equal(await capturePublicEvent(event, { ...ctx, sessionId: sessionFixture(Date.now()) }), true);
    assert.deepEqual(events[3], events[0], "retry after cookie rotation must retain the session and timestamp");
    validSession(events[3]);
  });
  await check("session-attribution", async () => {
    const initial = initialAttribution("https://example.test/pricing?utm_source=google&utm_medium=cpc&utm_campaign=launch&token=synthetic-private", "https://google.com/search?q=synthetic-private");
    const ctx = ensureAnalyticsContext(req({}), new Response(), initial)!;
    const event = PUBLIC_EVENT_SCHEMA.parse({ event: "$pageview", event_id: randomUUID(), properties: { pathname: "/pricing" } });
    await capturePublicEvent(event, ctx);
    assert.equal(events[0].properties.utm_source, "google");
    assert.equal(events[0].properties.utm_medium, "cpc");
    assert.equal(events[0].properties.utm_campaign, "launch");
    assert.equal(events[0].properties.$referring_domain, "google.com");
    const old = { ...ctx, issuedAt: Date.now() - SESSION_IDLE_MS - 100, lastSeenAt: Date.now() - SESSION_IDLE_MS - 100 };
    const next = ensureAnalyticsContext(req({}, signedContext(old)), new Response(), { pathname: "/blog", utm_source: "newsletter", utm_medium: "email", utm_campaign: "newsletter" })!;
    await capturePublicEvent({ ...event, event_id: randomUUID() }, next);
    assert.equal(events[1].properties.$initial_utm_source, "google");
    assert.equal(events[1].properties.utm_source, "newsletter");
    assert.equal(events[1].properties.$referring_domain, undefined);
    assert.ok(!JSON.stringify(events).includes("synthetic-private"));
  });
  await check("stitching", async () => {
    const ctx = context();
    assert.equal(await identifyAnalytics(actor, ctx), true);
    const identity = await resolveAnalyticsActor(actor);
    const identified = events.find((e) => e.event === "$identify")!;
    const grouped = events.find((e) => e.event === "$groupidentify")!;
    assert.equal(identified.distinct_id, identity?.distinctId);
    assert.equal(identified.properties.$anon_distinct_id, ctx.visitorId);
    assert.deepEqual(identified.properties.$groups, { family: identity?.familyGroupId });
    assert.equal(identified.properties.family_id, identity?.familyGroupId);
    assert.equal(grouped.properties.$group_key, identity?.familyGroupId);
    assert.notEqual(grouped.distinct_id, grouped.properties.$group_key);
    events.length = 0;
    await identifyAnalytics({ ...actor, member: beta.member }, ctx);
    assert.equal(events.find((e) => e.event === "$identify")?.properties.$anon_distinct_id, undefined);
    assert.ok(!JSON.stringify(events).includes(ctx.visitorId));
  });
  await check("delivery", async () => {
    const id = randomUUID();
    responseStatus = 500;
    assert.equal(await captureAppEvent(actor, "app_opened", { event_id: id }), false);
    assert.equal(events.length, 3);
    assert.deepEqual(events[0], events[1]);
    assert.deepEqual(events[1], events[2]);
    const failedEvent = events[0];
    responseStatus = 200;
    assert.equal(await captureAppEvent(actor, "app_opened", { event_id: id }), true);
    assert.deepEqual(events[3], failedEvent);
    assert.equal(await captureAppEvent(actor, "app_opened", { event_id: id }), true);
    assert.equal(events.length, 4);
    responseStatus = 400;
    assert.equal(await captureAppEvent(actor, "app_opened", { event_id: randomUUID() }), false);
    assert.equal(events.length, 5);
    const before = events.length;
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    assert.equal(await captureAppEvent(actor, "app_opened"), false);
    assert.equal(events.length, before);
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_synthetic_core_check";
  });
  await check("endpoints", async () => {
    const body = { event: "$pageview", event_id: randomUUID(), properties: { pathname: "/pricing" } };
    assert.equal((await publicEvent(req(body, "", "https://attacker.example.test"))).status, 403);
    assert.equal((await publicEvent(req({ ...body, actor }))).status, 400);
    assert.equal((await publicEvent(req({ ...body, properties: { pathname: "/maple", email: PRIVATE } }))).status, 400);
    const response = await publicEvent(req(body));
    assert.equal(response.status, 200);
    const cookie = cookieFrom(response);
    const ctx = readAnalyticsContext(req({}, cookie))!;
    assert.equal(events[0].distinct_id, ctx.visitorId);
    assert.equal((await publicEvent(req(body, cookie))).status, 200);
    assert.equal(events.length, 1);
    const sessionCookie = `${cookie}; ${SESSION_COOKIE}=${encodeURIComponent(sealSession(beta.owner, beta.familyId))}`;
    const openBody = { event_id: randomUUID() };
    assert.equal((await appOpen(req(openBody, sessionCookie, undefined, "/api/maple/analytics/open"))).status, 200);
    assert.equal(events[1].distinct_id, (await resolveAnalyticsActor(actor))?.distinctId);
    assert.equal((await appOpen(req({ ...openBody, member: beta.member }, sessionCookie, undefined, "/api/maple/analytics/open"))).status, 400);
    assert.equal((await appOpen(req(openBody, "", undefined, "/api/maple/analytics/open"))).status, 401);
    responseStatus = 503;
    const failedResponse = await appOpen(req({ event_id: randomUUID() }, sessionCookie, undefined, "/api/maple/analytics/open"));
    assert.equal(failedResponse.status, 503);
    assert.deepEqual(await failedResponse.json(), { success: false });
    responseStatus = 200;
    const error = { event: "client_error", event_id: randomUUID(), properties: { error_class: "TypeError", area: "window" } };
    assert.equal((await publicEvent(req(error, cookie))).status, 200);
    const exception = events.at(-1)!;
    assert.equal(exception.event, "$exception");
    assert.deepEqual(exception.properties.$exception_list, [{ type: "TypeError", value: "TypeError", mechanism: { type: "generic", handled: false } }]);
    assert.equal((await publicEvent(req({ ...error, properties: { ...error.properties, message: PRIVATE } }, cookie))).status, 400);
    await sql(`UPDATE upload_rate_limit SET count=1000`);
    assert.equal((await publicEvent(req({ ...body, event_id: randomUUID() }, cookie))).status, 429);
    await sql(`DELETE FROM upload_rate_limit`);
    const reset = await publicEvent(req({ action: "reset" }, cookie));
    assert.equal(reset.status, 200);
    assert.match(reset.headers.get("set-cookie")!, /Max-Age=0/);
  });
  await check("auth-cookie-binding", () => {
    const auth = `${SESSION_COOKIE}=${encodeURIComponent(sealSession(beta.owner, beta.familyId))}`;
    const lateResponse = new Response();
    const oldContext = ensureAnalyticsContext(req({}, auth), lateResponse)!;
    const lateCookie = cookieFrom(lateResponse);
    assert.deepEqual(readAnalyticsContext(req({}, `${auth}; ${lateCookie}`)), oldContext);
    assert.equal(readAnalyticsContext(req({}, lateCookie)), undefined, "late authenticated response must not restore a visitor after logout");
    const otherAuth = `${SESSION_COOKIE}=${encodeURIComponent(sealSession(beta.member, beta.familyId))}`;
    assert.equal(readAnalyticsContext(req({}, `${otherAuth}; ${lateCookie}`)), undefined);
    const renewed = ensureAnalyticsContext(req({}, lateCookie), new Response())!;
    assert.notEqual(renewed.visitorId, oldContext.visitorId);
  });
  await check("anonymous-cycle-replay", async () => {
    const anonymousResponse = new Response();
    const previous = ensureAnalyticsContext(req({}), anonymousResponse)!;
    const lateCookie = cookieFrom(anonymousResponse);
    const completedSignin = new Response();
    clearAnalyticsContext(completedSignin);
    const signedOut = new Response();
    clearAnalyticsContext(signedOut);
    const resetCookies = signedOut.headers.getSetCookie().map((header) => header.split(";")[0]).filter((cookie) => !cookie.startsWith(`${ANALYTICS_COOKIE}=`)).join("; ");
    assert.equal(readAnalyticsContext(req({}, `${resetCookies}; ${lateCookie}`)), undefined, "late anonymous response must not revive a previous anonymous period");
    const renewed = ensureAnalyticsContext(req({}, `${resetCookies}; ${lateCookie}`), new Response())!;
    assert.notEqual(renewed.visitorId, previous.visitorId);
  });
  await check("waitlist-context", () => {
    const auth = `${SESSION_COOKIE}=${encodeURIComponent(sealSession(beta.owner, beta.familyId))}`;
    const response = new Response();
    const expected = ensureAnalyticsContext(req({}, auth), response)!;
    const cookie = cookieFrom(response);
    assert.deepEqual(readAnalyticsContext(req({}, cookie, undefined, "/api/waitlist")), expected, "root analytics context must survive auth-cookie path scoping");
    assert.equal(readAnalyticsContext(req({}, cookie)), undefined, "analytics API still rejects a mismatched auth session");
  });
  await check("authenticated-public-event", async () => {
    const auth = `${SESSION_COOKIE}=${encodeURIComponent(sealSession(beta.owner, beta.familyId))}`;
    const response = new Response();
    const ctx = ensureAnalyticsContext(req({}, auth), response)!;
    const cookie = `${auth}; ${cookieFrom(response)}`;
    const error = { event: "client_error", event_id: randomUUID(), properties: { error_class: "TypeError", area: "window" } };
    assert.equal((await publicEvent(req(error, cookie))).status, 200);
    const identity = await resolveAnalyticsActor(actor);
    assert.equal(events[0].distinct_id, identity?.distinctId, "authenticated browser exceptions must identify the canonical member");
    assert.equal(events[0].properties.family_id, identity?.familyGroupId);
    assert.deepEqual(events[0].properties.$groups, { family: identity?.familyGroupId });
    assert.equal(events[0].properties.$process_person_profile, true);
    assert.equal(events[0].properties.$session_id, ctx.sessionId);
    assert.ok(!JSON.stringify(events).includes(beta.owner));
    assert.equal((await publicEvent(req({ ...error, actor: { ...actor, member: beta.member } }, cookie))).status, 400);
    events.length = 0;
    await identifyAnalytics({ ...actor, member: beta.member }, ctx);
    assert.equal(events.find((event) => event.event === "$identify")?.properties.$anon_distinct_id, undefined, "signed-in visitor cannot link to another adult");
  });
  await check("cleanup", async () => {
    const member = "synthetic-cleanup@example.test";
    const a = Number((await sql(`INSERT INTO maple_families (timezone,status) VALUES ('UTC','active') RETURNING id`))[0].id);
    const b = Number((await sql(`INSERT INTO maple_families (timezone,status) VALUES ('UTC','active') RETURNING id`))[0].id);
    for (const family of [a, b]) await sql(`INSERT INTO maple_members (family_id,email,role,accepted_at) VALUES ($1,$2,'member',NOW())`, [family, member]);
    const cleanupActor = { familyId: a, member };
    const identity = await resolveAnalyticsActor(cleanupActor);
    assert(identity);
    const consumedContext = context();
    await identifyAnalytics(cleanupActor, consumedContext);
    await captureAppEvent(cleanupActor, "app_opened");
    await sql(`DELETE FROM maple_members WHERE family_id=$1 AND email=$2`, [a, member]);
    assert.equal((await resolveAnalyticsActor({ familyId: b, member }))?.distinctId, identity.distinctId);
    await sql(`DELETE FROM maple_members WHERE family_id=$1 AND email=$2`, [b, member]);
    assert.equal((await sql(`SELECT 1 FROM maple_analytics_members WHERE member=$1`, [member])).length, 0);
    assert.equal((await sql(`SELECT 1 FROM maple_analytics_links WHERE member_id=$1`, [identity.distinctId])).length, 0);
    assert.equal((await sql(`SELECT 1 FROM maple_analytics_deliveries WHERE member_id=$1`, [identity.distinctId])).length, 0);
    events.length = 0;
    await identifyAnalytics(actor, consumedContext);
    assert.equal(events.find((e) => e.event === "$identify")?.properties.$anon_distinct_id, undefined, "deleted adult must not release its visitor for another account");
    await sql(`DELETE FROM maple_families WHERE id=$1`, [a]);
    assert.equal((await sql(`SELECT 1 FROM maple_analytics_families WHERE family_id=$1`, [a])).length, 0);
    await sql(`INSERT INTO maple_analytics_members(member) VALUES ('synthetic-orphan@example.test')`);
    await pruneAnalytics();
    assert.equal((await sql(`SELECT 1 FROM maple_analytics_members WHERE member='synthetic-orphan@example.test'`)).length, 0);
    await migrateAnalytics();
  });
  await check("health", async () => {
    await sql(`DELETE FROM maple_analytics_deliveries`);
    assert.equal((await analyticsHealth()).healthy, false);
    await captureAppEvent(actor, "app_opened");
    assert.equal((await analyticsHealth()).healthy, false);
    process.env.MAPLE_ANALYTICS_TEST = "0";
    await captureAppEvent(actor, "app_opened");
    assert.equal((await analyticsHealth()).healthy, true);
    assert.equal((await analyticsHealth(new Date(Date.now() + 37 * 60 * 60 * 1000))).healthy, false);
    assert.equal(analyticsTags().is_test, false);
    process.env.MAPLE_ANALYTICS_TEST = "1";
    const messages: unknown[] = [];
    const deps = { send: async (email: unknown) => { messages.push(email); return { sent: true as const, id: "synthetic-delivery" }; }, report: () => {} };
    const now = new Date("2026-11-02T12:00:00Z");
    assert.equal(await analyticsAlert("absence", now, deps), true);
    assert.equal(await analyticsAlert("absence", now, deps), true);
    assert.equal(messages.length, 1);
    assert.ok(!JSON.stringify(messages).includes(actor.member));
    assert.ok(!JSON.stringify(messages).includes(PRIVATE));
  });
  console.log(`Analytics core: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
