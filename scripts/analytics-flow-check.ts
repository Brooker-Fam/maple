import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { workAsyncStorage, type WorkStore } from "next/dist/server/app-render/work-async-storage.external";
import { NextRequest, NextResponse } from "next/server";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { freshDb, seedFamilies, sql, test, done } from "./tenancy/harness";
import { SESSION_COOKIE, STATE_COOKIE, sealSession, createInvite } from "../src/lib/maple/auth";
import { GET as getOnboarding } from "../src/app/api/maple/onboarding/route";
import { POST as invite } from "../src/app/api/maple/invites/route";
import { POST as inviteEmail } from "../src/app/api/maple/members/route";
import { createEntryOnce } from "../src/lib/maple/store";
import { completeSignup, startSignup, openIntent } from "../src/lib/maple/family/signup";
import { answerStep, readView, finishOnboarding } from "../src/lib/maple/onboarding/store";
import { familyScope } from "../src/lib/maple/family";
import { memberFor } from "../src/lib/maple/auth";
import { familyPostDeps } from "../src/lib/maple/chat/family-deps";
import { answerPost } from "../src/lib/maple/chat/post";
import { ANALYTICS_COOKIE, ensureAnalyticsContext, readAnalyticsContext } from "../src/lib/analytics/context";
import { GET as startGoogle } from "../src/app/api/maple/auth/start/route";
import { GET as redeemNative } from "../src/app/api/maple/auth/native/route";
import { POST as signout } from "../src/app/api/maple/auth/signout/route";
import { POST as joinWaitlist } from "../src/app/api/waitlist/route";
import { handleMapleGoogleCallback } from "../src/lib/maple/google-callback";
import { nativeChallengeFor, openNativeTicket } from "../src/lib/maple/native-auth";
import { startEmail, finishEmail, EMAIL_STATE_COOKIE } from "../src/lib/maple/email-flow";
import { startEmailChallenge } from "../src/lib/maple/email-auth";
import { beginApple, finishApple, APPLE_STATE_COOKIE } from "../src/lib/maple/apple-flow";

process.env.MAPLE_SESSION_SECRET = "synthetic-flow-session-secret";
process.env.MCP_SECRET = "synthetic-flow-mcp-secret";
process.env.GOOGLE_CLIENT_SECRET = "synthetic-flow-google-secret";
process.env.GOOGLE_CLIENT_ID = "synthetic.apps.googleusercontent.com";
process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_synthetic_flow";
process.env.MAPLE_SIGNUP = "open";
process.env.MAPLE_ANALYTICS_TEST = "1";
delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_EMAIL_DOMAIN;
delete process.env.MAPLE_ALLOWED_EMAILS;

type Event = { uuid: string; event: string; properties: Record<string, unknown> };
const events: Event[] = [];
let deliverEmail = true;
let rejectedEvent: string | undefined;
let delayedEvent: string | undefined;
globalThis.fetch = async (url, init) => {
  if (String(url) === "https://api.resend.com/emails") return Response.json(deliverEmail ? { id: "synthetic-email" } : { name: "validation_error", message: "Synthetic failure" }, { status: deliverEmail ? 200 : 400 });
  if (String(url) === "https://us.i.posthog.com/batch/") return new Response("{}", { status: 200 });
  assert.ok(["https://us.i.posthog.com/capture/", "https://us.i.posthog.com/i/v0/e/"].includes(String(url)));
  const event = JSON.parse(String(init?.body)) as Event;
  events.push(event);
  if (event.event === delayedEvent) await new Promise((resolve) => setTimeout(resolve, 30));
  if (event.event === rejectedEvent) return new Response("{}", { status: 503 });
  return new Response("{}", { status: 200 });
};

async function run<T>(fn: () => Promise<T>): Promise<T> {
  const tasks: (() => Promise<unknown>)[] = [];
  const work = { afterContext: { after: (task: () => Promise<unknown>) => tasks.push(task) } } as unknown as WorkStore;
  const result = await workAsyncStorage.run(work, fn);
  for (const task of tasks) await task();
  return result;
}

function names() { return events.filter((e) => !e.event.startsWith("$")).map((e) => e.event); }

function cookie(response: Response, name: string): string {
  return response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`))?.split(";")[0] ?? "";
}

function visitor() {
  const response = NextResponse.json({});
  const context = ensureAnalyticsContext(new Request("http://localhost:3000/signup"), response)!;
  assert.ok(context);
  return { context: JSON.parse(JSON.stringify(context)) as typeof context, cookie: cookie(response, ANALYTICS_COOKIE) };
}

function cleared(response: Response) {
  assert.ok(response.headers.getSetCookie().some((line) => line.startsWith(`${ANALYTICS_COOKIE}=;`) && line.includes("Max-Age=0")));
}

function linked(visitorId: string) {
  assert.ok(events.some((event) => event.event === "$identify" && event.properties.$anon_distinct_id === visitorId));
}

async function checkAuth(owner: string) {
  await test("Google signup preserves visitor context in its sealed intent and reports a bounded failure", async () => {
    events.length = 0;
    const anonymous = visitor();
    const start = await run(() => startSignup(new NextRequest("http://localhost:3000/api/maple/signup/start", {
      method: "POST", headers: { cookie: anonymous.cookie, "content-type": "application/x-www-form-urlencoded" }, body: "terms=yes",
    })));
    const state = JSON.parse(decodeURIComponent(cookie(start, STATE_COOKIE).split("=").slice(1).join("=")));
    assert.deepEqual(openIntent(state.signup)?.analytics, anonymous.context);
    const started = events.find((event) => event.event === "signup_started")!;
    assert.equal(started.properties.distinct_id, anonymous.context.visitorId);
    assert.equal(started.properties.provider, "google");
    await run(() => handleMapleGoogleCallback(new NextRequest(`http://localhost:3000/api/maple/auth/callback?state=${state.state}&error=synthetic-private-error`, { headers: { cookie: cookie(start, STATE_COOKIE) } })));
    const failed = events.find((event) => event.event === "signup_failed")!;
    assert.equal(failed.properties.reason, "denied");
    assert.equal(failed.properties.distinct_id, anonymous.context.visitorId);
    assert.ok(!JSON.stringify(events).includes("synthetic-private-error"));
  });
  for (const native of [false, true]) {
    await test(`Google ${native ? "native" : "web"} auth identifies the earlier visitor and clears it`, async () => {
      events.length = 0;
      const anonymous = visitor();
      const verifier = "v".repeat(43);
      const query = native ? `?native=ios&challenge=${nativeChallengeFor(verifier)}` : "";
      const start = await startGoogle(new NextRequest(`http://localhost:3000/api/maple/auth/start${query}`, { headers: { cookie: anonymous.cookie } }));
      const state = new URL(start.headers.get("location")!).searchParams.get("state");
      const completed = await run(() => handleMapleGoogleCallback(new NextRequest(`http://localhost:3000/api/maple/auth/callback?state=${state}&code=synthetic`, { headers: { cookie: cookie(start, STATE_COOKIE) } }), { identify: async () => ({ email: owner, name: null }) }));
      cleared(completed);
      if (native) {
        const ticket = new URL(completed.headers.get("location")!).searchParams.get("ticket")!;
        assert.deepEqual(openNativeTicket(ticket)?.analytics, anonymous.context);
        const redeemed = await run(() => redeemNative(new NextRequest(`http://localhost:3000/api/maple/auth/native?ticket=${ticket}`, { headers: { "x-maple-verifier": verifier } })));
        cleared(redeemed);
      }
      linked(anonymous.context.visitorId);
    });
  }
  await test("email signup carries encrypted visitor context through code verification", async () => {
    events.length = 0;
    const anonymous = visitor();
    let code = "";
    process.env.RESEND_API_KEY = "re_synthetic";
    process.env.RESEND_EMAIL_DOMAIN = "example.test";
    try {
      const start = await run(() => startEmail(new NextRequest("http://localhost:3000/api/maple/auth/email/start", {
        method: "POST", headers: { cookie: anonymous.cookie, "content-type": "application/json", "x-real-ip": "198.51.100.84" }, body: JSON.stringify({ mode: "signup", email: "synthetic-email-parent@example.test", terms: "yes" }),
      }), (req, email, ctx) => startEmailChallenge(req, email, ctx, { send: async (message) => { code = message.text.match(/\b\d{6}\b/)![0]; return { sent: true, id: "synthetic" }; } })));
      assert.equal(start.status, 200);
      const completed = await run(() => finishEmail(new NextRequest("http://localhost:3000/api/maple/auth/email/verify", {
        method: "POST", headers: { cookie: cookie(start, EMAIL_STATE_COOKIE), "content-type": "application/json", "x-real-ip": "198.51.100.84" }, body: JSON.stringify({ code }),
      })));
      assert.equal(completed.status, 200);
      cleared(completed);
      linked(anonymous.context.visitorId);
      assert.deepEqual(names(), ["signup_started", "signup_completed"]);
      assert.ok(events.filter((e) => e.event.startsWith("signup_")).every((e) => e.properties.provider === "email"));
    } finally { delete process.env.RESEND_API_KEY; delete process.env.RESEND_EMAIL_DOMAIN; }
  });
  await test("Apple callback preserves visitor context without a first-party callback cookie", async () => {
    events.length = 0;
    const anonymous = visitor();
    process.env.APPLE_CLIENT_ID = "app.synthetic.maple";
    process.env.APPLE_TEAM_ID = "TESTTEAM01";
    process.env.APPLE_KEY_ID = "TESTKEY001";
    process.env.APPLE_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const start = await beginApple(new NextRequest("http://localhost:3000/api/maple/auth/apple/start", { headers: { cookie: anonymous.cookie } }), { mode: "signin", site: "https://maple.example.test", back: "/maple" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const completed = await run(() => finishApple(new NextRequest("http://localhost:3000/api/maple/auth/apple/callback", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(start, APPLE_STATE_COOKIE) }, body: new URLSearchParams({ state, code: "synthetic-code" }).toString(),
    }), async () => ({ subject: "synthetic-apple-subject", email: owner, name: null })));
    cleared(completed);
    linked(anonymous.context.visitorId);
  });
  await test("signout clears the visitor cookie", async () => cleared(await signout()));
}


async function checkUninitializedSignup(owner: string) {
  for (const provider of ["google", "email", "apple", "apple-native"] as const) {
    await test(`${provider} signup without browser initialization creates and links one visitor`, async () => {
      events.length = 0;
      const ip = `198.51.100.${90 + ["google", "email", "apple", "apple-native"].indexOf(provider)}`;
      const email = `synthetic-uninitialized-${provider}@example.test`;
      const headers = { "content-type": "application/x-www-form-urlencoded", "x-real-ip": ip };
      const req = new NextRequest("http://localhost:3000/api/maple/signup/start", { method: "POST", headers, body: `terms=yes&provider=${provider === "apple-native" ? "apple" : provider}` });
      let code = "";
      let start: Response;
      if (provider === "email") {
        process.env.RESEND_API_KEY = "re_synthetic";
        process.env.RESEND_EMAIL_DOMAIN = "example.test";
        try {
          start = await run(() => startEmail(new NextRequest("http://localhost:3000/api/maple/auth/email/start", {
            method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ mode: "signup", email, terms: "yes" }),
          }), (request, address, ctx) => startEmailChallenge(request, address, ctx, { send: async (message) => { code = message.text.match(/\b\d{6}\b/)![0]; return { sent: true, id: "synthetic" }; } })));
        } finally { delete process.env.RESEND_API_KEY; delete process.env.RESEND_EMAIL_DOMAIN; }
      } else if (provider === "apple-native") {
        start = await run(() => beginApple(req, { mode: "signup", site: "http://localhost:3000", back: "/maple", native: "ios", challenge: nativeChallengeFor("v".repeat(43)), signup: { kind: "create", code: null, tz: "America/Chicago", terms: "synthetic" } }));
      } else start = await run(() => startSignup(req));
      assert.equal(start.status, provider === "email" ? 200 : 303);
      const context = readAnalyticsContext(new Request(req.url, { headers: { cookie: cookie(start, ANALYTICS_COOKIE) } }));
      assert.ok(context, "accepted signup must return a valid visitor cookie before browser initialization");
      assert.equal(events.find((event) => event.event === "signup_started")?.properties.distinct_id, context.visitorId);
      let completed: Response;
      if (provider === "google") {
        const state = JSON.parse(decodeURIComponent(cookie(start, STATE_COOKIE).split("=").slice(1).join("=")));
        assert.deepEqual(openIntent(state.signup)?.analytics, context);
        completed = await run(() => handleMapleGoogleCallback(new NextRequest(`http://localhost:3000/api/maple/auth/callback?state=${state.state}&code=synthetic`, { headers: { ...headers, cookie: cookie(start, STATE_COOKIE) } }), { identify: async () => ({ email, name: null }) }));
      } else if (provider === "email") {
        completed = await run(() => finishEmail(new NextRequest("http://localhost:3000/api/maple/auth/email/verify", { method: "POST", headers: { ...headers, "content-type": "application/json", cookie: cookie(start, EMAIL_STATE_COOKIE) }, body: JSON.stringify({ code }) })));
      } else {
        const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
        completed = await run(() => finishApple(new NextRequest("http://localhost:3000/api/maple/auth/apple/callback", { method: "POST", headers: { ...headers, cookie: cookie(start, APPLE_STATE_COOKIE) }, body: new URLSearchParams({ state, code: "synthetic" }).toString() }), async () => ({ subject: `synthetic-${provider}`, email, name: null })));
        if (provider === "apple-native") {
          const ticket = new URL(completed.headers.get("location")!).searchParams.get("ticket")!;
          assert.equal(openNativeTicket(ticket)?.analytics?.visitorId, context.visitorId);
          completed = await run(() => redeemNative(new NextRequest(`http://localhost:3000/api/maple/auth/native?ticket=${ticket}`, { headers: { "x-maple-verifier": "v".repeat(43) } })));
        }
      }
      cleared(completed);
      linked(context.visitorId);
      assert.deepEqual(names(), ["signup_started", "signup_completed"]);
      const identity = events.find((event) => event.event === "$identify")!;
      assert.equal(events.find((event) => event.event === "signup_completed")?.properties.distinct_id, identity.properties.distinct_id);
    });
  }
  await test("native Google auth without browser initialization preserves its new visitor through redemption", async () => {
    events.length = 0;
    const verifier = "v".repeat(43);
    const start = await startGoogle(new NextRequest(`http://localhost:3000/api/maple/auth/start?native=ios&challenge=${nativeChallengeFor(verifier)}`));
    const context = readAnalyticsContext(new Request("http://localhost:3000", { headers: { cookie: cookie(start, ANALYTICS_COOKIE) } }));
    assert.ok(context, "accepted native auth must return a visitor cookie");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const completed = await run(() => handleMapleGoogleCallback(new NextRequest(`http://localhost:3000/api/maple/auth/callback?state=${state}&code=synthetic`, { headers: { cookie: cookie(start, STATE_COOKIE) } }), { identify: async () => ({ email: owner, name: null }) }));
    const ticket = new URL(completed.headers.get("location")!).searchParams.get("ticket")!;
    assert.equal(openNativeTicket(ticket)?.analytics?.visitorId, context.visitorId);
    const redeemed = await run(() => redeemNative(new NextRequest(`http://localhost:3000/api/maple/auth/native?ticket=${ticket}`, { headers: { "x-maple-verifier": verifier } })));
    cleared(redeemed);
    linked(context.visitorId);
  });
}

async function main() {
  await freshDb({ shape: "final" });
  const { beta } = await seedFamilies();
  const request = (path: string, body: unknown) => new NextRequest(`http://localhost:3000${path}`, {
    method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealSession(beta.owner, beta.familyId))}` }, body: JSON.stringify(body),
  });
  const ctx = { ...(await familyScope(beta.familyId))!, member: beta.owner, role: "owner" as const, status: "active" as const };
  const member = (await memberFor(ctx, beta.owner))!;

  await checkAuth(beta.owner);
  await checkUninitializedSignup(beta.owner);
  await test("waitlist counts only a newly inserted address", async () => {
    events.length = 0;
    const anonymous = visitor();
    const send = (body: unknown) => joinWaitlist(new Request("http://localhost:3000/api/waitlist", { method: "POST", headers: { "content-type": "application/json", cookie: anonymous.cookie }, body: JSON.stringify(body) }));
    for (let i = 0; i < 2; i++) assert.equal((await run(() => send({ email: "synthetic-waitlist@example.test" }))).status, 204);
    assert.equal((await run(() => send({ email: "synthetic-bot@example.test", website: "synthetic bot" }))).status, 204);
    assert.deepEqual(names(), ["waitlist_joined"]);
    assert.equal(events[0].properties.distinct_id, anonymous.context.visitorId);
    assert.ok(!JSON.stringify(events).includes("synthetic-waitlist"));
  });

  await test("link-only invites are created, never sent", async () => {
    events.length = 0;
    assert.equal((await run(() => invite(request("/api/maple/invites", { display_name: "Synthetic Invitee" })))).status, 201);
    assert.deepEqual(names(), ["invite_created"]);
  });
  await test("an addressed invite with delivery disabled is created, never sent", async () => {
    events.length = 0;
    assert.equal((await run(() => inviteEmail(request("/api/maple/members", { email: "synthetic-invite@example.test" })))).status, 201);
    assert.deepEqual(names(), ["invite_created"]);
  });
  await test("invite sent requires sender API acceptance", async () => {
    events.length = 0;
    process.env.RESEND_API_KEY = "re_synthetic";
    process.env.RESEND_EMAIL_DOMAIN = "example.test";
    try {
      deliverEmail = true;
      const response = await run(() => inviteEmail(request("/api/maple/members", { email: "synthetic-delivered@example.test" })));
      assert.equal((await response.json()).emailed, true);
      assert.deepEqual(names(), ["invite_created", "invite_sent"]);
    } finally { delete process.env.RESEND_API_KEY; delete process.env.RESEND_EMAIL_DOMAIN; }
  });
  await test("invite accepted counts only an inserted membership", async () => {
    events.length = 0;
    const who = { email: "synthetic-joined@example.test", name: null };
    const first = await createInvite(ctx, { role: "member", displayName: null, emoji: null, createdBy: beta.owner, email: who.email });
    const req = request("/api/maple/auth/callback", {});
    assert.ok("familyId" in await run(() => completeSignup(req, who, { kind: "join", invite: first.token })));
    const already = await createInvite(ctx, { role: "member", displayName: null, emoji: null, createdBy: beta.owner, email: who.email });
    assert.ok("familyId" in await run(() => completeSignup(req, who, { kind: "join", invite: already.token })));
    assert.deepEqual(names(), ["invite_accepted"]);
  });
  await test("new entries preserve dedup and identify their individual creators", async () => {
    events.length = 0;
    const entry = { babyId: beta.babyId, kind: "note" as const, data: { text: "Synthetic private content" }, startedAt: new Date(), source: "web" as const, createdBy: beta.owner, clientId: "07476296-9446-49ee-a4f9-1c3772d58aa1" };
    await run(() => createEntryOnce(ctx, entry));
    await run(() => createEntryOnce(ctx, entry));
    await run(() => createEntryOnce(ctx, { ...entry, clientId: "1e11f67f-0c6a-4acd-ac92-8c31cf1f3fce", createdBy: beta.member }));
    assert.deepEqual(names(), ["entry_logged", "entry_logged"]);
    assert.notEqual(events[0].properties.distinct_id, events[1].properties.distinct_id);
    assert.deepEqual(events[0].properties.$groups, events[1].properties.$groups);
    assert.ok(events[0].properties.$groups);
    assert.ok(!JSON.stringify(events).includes("Synthetic private content"));
  });
  await test("a new family has exactly one signup completion event", async () => {
    events.length = 0;
    const who = { email: "synthetic-new-family@example.test", name: "Synthetic Parent" };
    const intent = { kind: "create" as const, code: null, tz: "America/Chicago", terms: "synthetic-terms" };
    const req = request("/api/maple/auth/callback", {});
    assert.ok("familyId" in await run(() => completeSignup(req, who, intent)));
    assert.ok("familyId" in await run(() => completeSignup(req, who, intent)));
    assert.deepEqual(names(), ["signup_completed"]);
  });
  await test("onboarding emits start and safe step completion only on first transition", async () => {
    events.length = 0;
    await sql("UPDATE maple_families SET status = 'onboarding', onboarding = '{}' WHERE id = $1", [beta.familyId]);
    const onboarding = { ...ctx, status: "onboarding" as const };
    await run(() => answerStep(onboarding, member, "you", { name: "Synthetic Parent", role_word: "parent" }));
    await run(() => answerStep(onboarding, member, "you", { name: "Synthetic Parent", role_word: "parent" }));
    assert.deepEqual(names(), ["onboarding_started", "onboarding_step_completed"]);
    assert.ok(!JSON.stringify(events).includes("Synthetic Parent"));
    await sql("UPDATE maple_families SET status = 'active' WHERE id = $1", [beta.familyId]);
  });
  for (const eventName of ["onboarding_started", "onboarding_step_completed"]) {
    await test(`${eventName} retries rejected delivery with one stable event id and concurrent claims`, async () => {
      events.length = 0;
      await sql("UPDATE maple_families SET status = 'onboarding', onboarding = '{}' WHERE id = $1", [beta.familyId]);
      const onboarding = { ...ctx, status: "onboarding" as const };
      const answer = () => answerStep(onboarding, member, "you", { name: "Synthetic Parent", role_word: "parent" });
      rejectedEvent = eventName;
      try {
        await run(answer);
        const failed = events.filter((event) => event.event === eventName);
        assert.ok(failed.length >= 3);
        const state = (await sql("SELECT onboarding FROM maple_families WHERE id = $1", [beta.familyId]))[0].onboarding;
        assert.notEqual(state.analytics_events?.[eventName === "onboarding_started" ? "started" : "step_2"]?.sent, true);
        rejectedEvent = undefined;
        delayedEvent = eventName;
        await Promise.all([run(answer), run(answer)]);
        delayedEvent = undefined;
        const retried = events.filter((event) => event.event === eventName);
        assert.equal(retried.length, failed.length + 1, "a repeated answer must retry failed delivery, with only one concurrent sender");
        assert.equal(new Set(retried.map((event) => event.uuid)).size, 1, "delivery retries must preserve the event UUID");
        await run(answer);
        assert.equal(events.filter((event) => event.event === eventName).length, failed.length + 1);
      } finally {
        rejectedEvent = undefined;
        delayedEvent = undefined;
        await sql("UPDATE maple_families SET status = 'active' WHERE id = $1", [beta.familyId]);
      }
    });
  }
  for (const trigger of ["reload", "next answer", "completion", "finished reload"]) {
    await test(`pending onboarding step retries on ${trigger}`, async () => {
      events.length = 0;
      await sql("UPDATE maple_families SET status = 'onboarding', onboarding = '{}' WHERE id = $1", [beta.familyId]);
      const onboarding = { ...ctx, status: "onboarding" as const };
      rejectedEvent = "onboarding_step_completed";
      const reloadFinished = async () => {
        const response = await run(() => getOnboarding(new NextRequest("http://localhost:3000/api/maple/onboarding", {
          headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealSession(beta.owner, beta.familyId))}` },
        })));
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { needed: false });
      };
      try {
        await run(() => answerStep(onboarding, member, "you", { name: "Synthetic Parent", role_word: "parent" }));
        let before = events.filter((event) => event.event === "onboarding_step_completed");
        assert.ok(before.length >= 3);
        if (trigger === "finished reload") {
          await sql("UPDATE maple_families SET onboarding = onboarding || '{\"done\":{\"welcome\":\"answered\",\"you\":\"answered\",\"timezone\":\"answered\",\"birth\":\"answered\"}}'::jsonb WHERE id = $1", [beta.familyId]);
          await run(() => finishOnboarding(onboarding, member));
          before = events.filter((event) => event.event === "onboarding_step_completed");
        }
        rejectedEvent = undefined;
        if (trigger === "completion") {
          await sql("UPDATE maple_families SET onboarding = onboarding || '{\"done\":{\"welcome\":\"answered\",\"you\":\"answered\",\"timezone\":\"answered\",\"birth\":\"answered\"}}'::jsonb WHERE id = $1", [beta.familyId]);
          await run(() => finishOnboarding(onboarding, member));
        } else if (trigger === "next answer") {
          await run(() => answerStep(onboarding, member, "timezone", { timezone: "UTC", units: "us" }));
        } else {
          if (trigger === "finished reload") await reloadFinished();
          else await run(() => readView(onboarding));
        }
        const retried = events.filter((event) => event.event === "onboarding_step_completed" && event.properties.step === "step_2");
        assert.equal(retried.length, before.length + 1, "pending saved steps must retry even when the answer is never repeated");
        assert.equal(new Set(retried.map((event) => event.uuid)).size, 1);
        if (trigger === "finished reload") await reloadFinished();
        else await run(() => readView(onboarding));
        assert.equal(events.filter((event) => event.event === "onboarding_step_completed" && event.properties.step === "step_2").length, retried.length);
      } finally {
        rejectedEvent = undefined;
        await sql("UPDATE maple_families SET status = 'active' WHERE id = $1", [beta.familyId]);
      }
    });
  }
  await sql("UPDATE maple_chat_threads SET care_open = false WHERE family_id = $1", [beta.familyId]);
  for (const fails of [false, true]) {
    await test(`stream ${fails ? "failure" : "completion"} emits the terminal outcome after streaming`, async () => {
      events.length = 0;
      const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
      const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: fails ? [{ type: "error" as const, error: new Error("Synthetic private failure") }] : [
        { type: "text-start" as const, id: "synthetic" }, { type: "text-delta" as const, id: "synthetic", delta: "Synthetic private answer" }, { type: "text-end" as const, id: "synthetic" },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage },
      ] as never[] }) }) });
      await run(async () => {
        const response = await answerPost({ threadId: beta.threadId, message: { role: "user", parts: [{ type: "text", text: "Synthetic question" }] } }, member,
          familyPostDeps(ctx, member, { model, modelKey: "zai/glm-5.3-flash", device: null, now: new Date(), report: () => {}, waitUntil: (p) => { pending.push(p); } }));
        assert.equal(response.status, 200);
        await response.text();
        await Promise.all(pending);
      });
      assert.deepEqual(names(), ["chat_started", fails ? "chat_failed" : "chat_completed"]);
      assert.ok(!JSON.stringify(events).includes("Synthetic"));
    });
  }
  done("analytics-flow-check.ts");
}
const pending: Promise<unknown>[] = [];
void main().catch((e) => { console.error(e); process.exitCode = 1; });
