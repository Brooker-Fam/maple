import "next/dist/server/node-environment-baseline";
import { workAsyncStorage, type WorkStore } from "next/dist/server/app-render/work-async-storage.external";
import { NextRequest } from "next/server";
import { done, eq, freshDb, ok, seedFamilies, sql, test, type Seed } from "./harness";
import { familyAnalyticsId } from "../../src/lib/analytics/server";
import { SESSION_COOKIE, sealSession } from "../../src/lib/maple/auth";
import { POST as logEntry } from "../../src/app/api/maple/entries/route";
import { POST as invite } from "../../src/app/api/maple/invites/route";
import { POST as appOpened } from "../../src/app/api/maple/analytics/open/route";
import { POST as onboarding } from "../../src/app/api/maple/onboarding/route";
import { startSignup } from "../../src/lib/maple/family/signup";

process.env.MAPLE_SESSION_SECRET = "synthetic-analytics-session-secret";
process.env.MCP_SECRET = "synthetic-analytics-mcp-secret";
process.env.GOOGLE_CLIENT_SECRET = "synthetic-analytics-google-secret";
process.env.GOOGLE_CLIENT_ID = "synthetic-client.apps.googleusercontent.com";
delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_EMAIL_DOMAIN;
delete process.env.MAPLE_READ_ONLY;
delete process.env.MAPLE_SIGNUP;

type Event = { event: string; properties: Record<string, unknown> };
const events: Event[] = [];
globalThis.fetch = async (url, init) => {
  eq(String(url), "https://us.i.posthog.com/capture/", "only stubbed analytics transport");
  events.push(JSON.parse(String(init?.body)));
  return new Response(null, { status: 200 });
};

function request(path: string, family: Seed["beta"], body?: unknown, headerFamily = family.familyId) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "POST",
    headers: {
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealSession(family.owner, family.familyId))}`,
      "content-type": "application/json",
      "X-Maple-Family": String(headerFamily),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function responseThenEvents(run: () => Promise<Response>) {
  const tasks: (() => Promise<void>)[] = [];
  const before = events.length;
  const store = { afterContext: { after: (task: () => Promise<void>) => tasks.push(task) } } as unknown as WorkStore;
  const response = await workAsyncStorage.run(store, run);
  eq(events.length, before, "no analytics before the response");
  for (const task of tasks) await task();
  return response;
}

function expectEvents(names: string[], familyId: number) {
  eq(events.map((event) => event.event), names);
  for (const event of events) eq(event.properties, { distinct_id: familyAnalyticsId(familyId), $process_person_profile: false, $geoip_disable: true });
}

async function checkEntries(s: Seed, shape: string) {
  await test(`${shape}: a new baby entry emits once after response and never sends its contents`, async () => {
    events.length = 0;
    const body = { kind: "note", data: { text: "Synthetic private health detail" }, note: "Synthetic Parent private@example.test", client_id: "b2437840-62ef-4a79-9c54-d2c6a377c350" };
    eq((await responseThenEvents(() => logEntry(request("/api/maple/entries", s.beta, body)))).status, 201);
    eq((await responseThenEvents(() => logEntry(request("/api/maple/entries", s.beta, body)))).status, 200);
    expectEvents(["entry_logged"], s.beta.familyId);
  });
}

async function checkInvitesAndOpen(s: Seed, shape: string) {
  await test(`${shape}: an invite records no invitee name or token`, async () => {
    events.length = 0;
    const response = await responseThenEvents(() => invite(request("/api/maple/invites", s.beta, { display_name: "Synthetic Invitee", role: "viewer" })));
    eq(response.status, 201);
    expectEvents(["invite_sent"], s.beta.familyId);
    ok(!JSON.stringify(events).includes(String((await response.json()).url)), "no invite link");
  });
  await test(`${shape}: app open uses authenticated family and rejects a stale family or missing session`, async () => {
    events.length = 0;
    eq((await responseThenEvents(() => appOpened(request("/api/maple/analytics/open?token=synthetic-private", s.beta)))).status, 204);
    eq((await responseThenEvents(() => appOpened(request("/api/maple/analytics/open", s.beta, undefined, s.alpha.familyId)))).status, 409);
    eq((await responseThenEvents(() => appOpened(new NextRequest("http://localhost:3000/api/maple/analytics/open", { method: "POST" })))).status, 401);
    expectEvents(["app_opened"], s.beta.familyId);
  });
}

async function checkOnboarding(s: Seed, shape: string) {
  await test(`${shape}: onboarding completion is emitted only for the first successful transition`, async () => {
    await sql(`UPDATE maple_families SET status = 'onboarding', onboarding = $2 WHERE id = $1`, [s.beta.familyId, { done: { welcome: "answered", you: "answered", timezone: "answered", birth: "answered" } }]);
    events.length = 0;
    const finish = () => onboarding(request("/api/maple/onboarding", s.beta, { finish: true }));
    eq((await responseThenEvents(finish)).status, 200);
    eq((await responseThenEvents(finish)).status, 409);
    expectEvents(["onboarding_completed"], s.beta.familyId);
  });
}

async function checkSignupStart() {
  await test("accepted signup start records an anonymous event; invite joins and missing terms do not", async () => {
    process.env.MAPLE_SIGNUP = "open";
    events.length = 0;
    const start = (fields: Record<string, string>) => startSignup(new NextRequest("http://localhost:3000/api/maple/signup/start", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-real-ip": "198.51.100.61" },
      body: new URLSearchParams({ site: "http://localhost:3000", ...fields }).toString(),
    }));
    const accepted = await responseThenEvents(() => start({ terms: "yes" }));
    eq(accepted.status, 303);
    ok(new URL(accepted.headers.get("location")!).hostname === "accounts.google.com", "accepted signup redirects to Google");
    await responseThenEvents(() => start({}));
    await responseThenEvents(() => start({ invite: "synthetic_invite_token_1234567890" }));
    eq(events.map((event) => event.event), ["signup_started"]);
    const id = String(events[0].properties.distinct_id);
    ok(/^site:[a-f0-9-]{36}$/.test(id), "anonymous random ID");
    eq(events[0].properties, { distinct_id: id, $process_person_profile: false, $geoip_disable: true });
    delete process.env.MAPLE_SIGNUP;
  });
}

async function main() {
  for (const shape of ["production", "final"] as const) {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    await freshDb({ shape });
    const s = await seedFamilies();
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_synthetic_integration_check";
    await checkEntries(s, shape);
    await checkInvitesAndOpen(s, shape);
    await checkOnboarding(s, shape);
    if (shape === "final") await checkSignupStart();
  }
  done("analytics.check.ts");
}

void main().catch((error) => { console.error(error); process.exit(1); });
