import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

async function main() {
  assert.equal(process.env.MAPLE_ANALYTICS_SMOKE, "1", "Set MAPLE_ANALYTICS_SMOKE=1 to send synthetic events");
  assert.ok(process.env.NEXT_PUBLIC_POSTHOG_KEY, "A PostHog project token is required");
  process.env.DATABASE_URL = `pglite:${randomUUID()}`;
  process.env.MAPLE_ANALYTICS_TEST = "1";
  process.env.VERCEL_ENV = "development";
  process.env.MAPLE_SESSION_SECRET = randomUUID();
  delete process.env.RESEND_API_KEY;
  const { freshDb, sql } = await import("./tenancy/harness");
  const { resolveAnalyticsActor } = await import("../src/lib/analytics/identity");
  const { captureAppEvent, captureSignupStarted, captureSignupCompleted } = await import("../src/lib/analytics/server");
  const { readAnalyticsContext } = await import("../src/lib/analytics/context");
  const { POST } = await import("../src/app/api/maple/analytics/event/route");
  await freshDb();
  await sql(`INSERT INTO maple_members (family_id, email, role, accepted_at) VALUES
    (1, 'synthetic-owner@example.test', 'owner', NOW()), (1, 'synthetic-partner@example.test', 'member', NOW())`);
  const owner = { familyId: 1, member: "synthetic-owner@example.test", role: "owner" };
  const partner = { familyId: 1, member: "synthetic-partner@example.test", role: "member" };
  const liveFetch = globalThis.fetch;
  const events: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://us.i.posthog.com/i/v0/e/");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.properties.is_test, true);
    assert.equal(body.properties.environment, "development");
    assert.equal(body.properties.schema_version, 2);
    assert.equal(body.properties.$geoip_disable, true);
    assert.ok(!JSON.stringify(body).includes("@example.test"));
    assert.ok(!JSON.stringify(body).includes("synthetic-private-value"));
    events.push(body.event);
    return liveFetch(input, init);
  };
  const cookies = new Map<string, string>();
  const request = (body: unknown) => new Request("https://maplebaby.app/api/maple/analytics/event", {
    method: "POST", headers: { origin: "https://maplebaby.app", "content-type": "application/json", cookie: [...cookies.values()].join("; ") }, body: JSON.stringify(body),
  });
  const send = async (body: unknown) => {
    const response = await POST(request(body));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true });
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";")[0];
      cookies.set(pair.split("=")[0], pair);
    }
  };
  try {
    await send({ action: "context", initial: { pathname: "/pricing", utm_source: "newsletter", utm_medium: "email", utm_campaign: "launch" } });
    await send({ event: "$pageview", event_id: randomUUID(), properties: { pathname: "/pricing" } });
    await send({ event: "signup_clicked", event_id: randomUUID(), properties: { pathname: "/pricing", placement: "pricing" } });
    const context = readAnalyticsContext(request({}));
    assert.ok(context);
    assert.equal(await captureSignupStarted(context, { provider: "email" }), true);
    assert.equal(await captureSignupCompleted(owner, context, { provider: "email" }), true);
    for (const event of ["onboarding_started", "onboarding_completed", "entry_logged", "app_opened", "chat_started", "chat_completed", "chat_started", "chat_failed"] as const) {
      assert.equal(await captureAppEvent(owner, event, { source: "ui", note: "synthetic-private-value" }, context), true);
    }
    assert.equal(await captureAppEvent(partner, "app_opened"), true);
    const a = await resolveAnalyticsActor(owner);
    const b = await resolveAnalyticsActor(partner);
    assert.ok(a && b);
    assert.notEqual(a.distinctId, b.distinctId);
    assert.equal(a.familyGroupId, b.familyGroupId);
    console.log(JSON.stringify({ events, owner: a.distinctId, partner: b.distinctId, family: a.familyGroupId, visitor: context.visitorId, is_test: true }));
  } finally { globalThis.fetch = liveFetch; }
}

void main().catch((error) => {
  const locations = error instanceof Error ? error.stack?.split("\n").filter((line) => /^\s+at /.test(line)).slice(0, 4) : undefined;
  console.error("Synthetic analytics smoke failed", error instanceof Error ? error.name : "unknown", locations?.join("\n") ?? "before capture");
  process.exitCode = 1;
});
