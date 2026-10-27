import type { Email } from "../../src/lib/email/send";
import { deliveryDeps, deliver } from "../../src/lib/maple/usage-alerts/delivery";
import { alertGatewayCredit } from "../../src/lib/maple/usage-alerts/gateway";
import { usageMetrics } from "../../src/lib/maple/usage-alerts/snapshot";
import { pending, recordRun, healthy, rows } from "../../src/lib/maple/usage-alerts/store";
import { reconcileMonth } from "../../src/lib/maple/usage-alerts/reconcile";
import { done, eq, freshDb, ok, seedFamilies, sql, test } from "./harness";

delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_EMAIL_DOMAIN;
const now = new Date("2026-10-27T12:04:00Z");

async function main() {
  await freshDb({ shape: "final" });
  const seed = await seedFamilies();
  await sql(`DELETE FROM maple_ai_usage`);
  await sql(`UPDATE maple_families SET created_at = '2026-10-26T15:00:00Z'`);
  await sql(`INSERT INTO maple_families (timezone, status, created_at) SELECT 'UTC', 'onboarding', '2026-10-26T15:00:00Z' FROM generate_series(1, 12)`);
  for (const [family, cost, at] of [[1, "2500000", "2026-10-03T00:00:00Z"], [1, "9000000", "2026-10-01T02:00:00Z"], [2, "12000000", "2026-10-03T00:00:00Z"], [null, "500000", "2026-10-03T00:00:00Z"], [1, "1000000", "2026-09-15T00:00:00Z"], [1, "2500000", "2026-10-31T20:00:00Z"], [2, "12500000", "2026-10-31T20:00:00Z"]]) {
    await sql(`INSERT INTO maple_ai_usage (family_id, member, step, model, cost_micro_usd, price_key, created_at) VALUES ($1, 'synthetic@example.com', 0, 'synthetic/model', $2, 'synthetic', $3)`, [family, cost, at]);
  }
  await sql(`INSERT INTO maple_upload_counts (family_id, day, tokens) VALUES (2, '2026-10-27', 30), (2, '2026-10-26', 645), (3, '2026-10-27', 30), (3, '2026-10-26', 645)`);
  await sql(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, data, deleted_at) VALUES (2, $1, 'moment', $2, $3::jsonb, $2)`, [seed.beta.babyId, now.toISOString(), JSON.stringify({ photos: Array.from({ length: 749 }, () => ({ url: "maple/f2/moments/synthetic.jpg" })) })]);

  await test("usage metrics aggregate other-family uploads and inspect yesterday's daily and rolling signup peaks", async () => {
    const metrics = await usageMetrics(now, {});
    const got = (key: string) => metrics.filter((m) => m.key === key).map((m) => [String(m.used), String(m.limit), m.period]);
    eq(got("chat/others"), [["0", "25000000", "2026-09"], ["12500000", "25000000", "2026-10"]]);
    eq(got("chat/family-1"), [["10000000", "5000000", "2026-09"], ["2500000", "5000000", "2026-10"]]);
    eq(got("signup"), [["13", "25", "2026-10-26"], ["0", "25", "2026-10-27"]]);
    eq(got("uploads/others/daily"), [["1290", "120", "2026-10-26"], ["60", "120", "2026-10-27"]]);
    eq(got("uploads/others/total"), [["1350", "2700", "lifetime"]]);
    eq(got("photos/2"), [["750", "1500", "lifetime"]]);
    eq(metrics.filter((m) => m.key.startsWith("uploads/1/")).length, 0);
    const rollover = await usageMetrics(new Date("2026-11-01T12:04:00Z"), {});
    eq(rollover.filter((m) => m.key.startsWith("chat/")).map((m) => [m.key, m.period, String(m.used)]), [["chat/others", "2026-10", "25000000"], ["chat/others", "2026-11", "0"], ["chat/family-1", "2026-10", "5000000"], ["chat/family-1", "2026-11", "0"]]);
  });

  const sent: Email[] = [];
  const reports: string[] = [];
  const deps = deliveryDeps({ now, env: { MAPLE_ALERT_EMAIL: "operator@example.com" }, send: async (email) => { sent.push(email); return { sent: true, id: "synthetic-email" }; }, report: (error) => { reports.push(error.message); } });
  await test("persistent claims send each threshold once and retry failed sends with stable content and keys", async () => {
    const alert = { key: "synthetic/daily/50", subject: "Synthetic threshold", body: "Only counts: 50 of 100." };
    await Promise.all([deliver(alert, deps), deliver(alert, deps)]);
    eq(sent.length, 1);
    eq(sent[0].to, "operator@example.com");
    ok(sent[0].idempotencyKey?.startsWith("usage/") && !sent[0].idempotencyKey.includes("@"), "idempotency key has no address");
    const retry = { ...alert, key: "synthetic/daily/80" };
    eq(await deliver(retry, { ...deps, send: async () => ({ sent: false, reason: "failed" }) }), false);
    eq((await pending()).map((a) => a.key), [retry.key]);
    await deliver({ ...retry, body: "Changed after the failed send" }, deps);
    eq(sent[1].text, alert.body, "a retry preserves the first request body");
    eq((await pending()).length, 0);
    eq(reports, ["usage_alert_email_failed"]);
  });

  await test("the first insufficient-credit refusal sends once without private error text", async () => {
    const before = sent.length;
    const error = { statusCode: 402, cause: { responseBody: '{"error":{"type":"insufficient_funds","message":"Synthetic private note"}}' } };
    await Promise.all([alertGatewayCredit(error, deps), alertGatewayCredit(error, deps)]);
    eq(sent.length, before + 1);
    ok(!JSON.stringify(sent.at(-1)).includes("Synthetic private note"), "error content stays out");
    await alertGatewayCredit({ statusCode: 402, type: "quota_for_entity_exceeded" }, deps);
    eq(sent.length, before + 1);
  });

  await test("monthly reconciliation compares stored micro-dollars with Gateway charges and sends once", async () => {
    let fetched = 0;
    const fetcher: typeof fetch = async () => { fetched++; return new Response('{"results":[{"total_cost":1.20,"request_count":1}]}'); };
    const monthly = { ...deps, env: { ...deps.env, VERCEL_OIDC_TOKEN: "synthetic-token" } };
    eq(await reconcileMonth(monthly, fetcher), true);
    eq(await reconcileMonth(monthly, fetcher), true);
    eq(fetched, 1);
    const email = sent.at(-1)!;
    ok(email.text.includes("$1.000000") && email.text.includes("$1.200000") && email.text.includes("$0.200000"), "both totals and their difference");
    ok(!email.text.includes("synthetic@example.com"), "no member identity in the summary");
  });

  await test("health reports missing or stale checks and recovers after a successful run", async () => {
    eq(await healthy(now), false);
    await recordRun(now);
    eq(await healthy(now), true);
    eq(await healthy(new Date(now.getTime() + 37 * 3_600_000)), false);
    await recordRun(new Date(now.getTime() + 37 * 3_600_000));
    eq(await healthy(new Date(now.getTime() + 37 * 3_600_000)), true);
  });

  await test("the authenticated cron executes the full check and records output; failed email remains retryable", async () => {
    await freshDb({ shape: "final" });
    await seedFamilies();
    process.env.CRON_SECRET = "synthetic-cron-secret";
    process.env.MAPLE_USAGE_MONITOR_SECRET = "synthetic-monitor-secret";
    process.env.RESEND_API_KEY = "re_synthetic_key";
    process.env.RESEND_EMAIL_DOMAIN = "example.com";
    process.env.MAPLE_ALERT_EMAIL = "synthetic-operator@example.com";
    process.env.VERCEL_OIDC_TOKEN = "synthetic-oidc";
    const original = globalThis.fetch;
    let emails = 0;
    let fail = true;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://ai-gateway.vercel.sh/v1/report?")) return new Response('{"results":[]}');
      if (url === "https://api.resend.com/emails") { emails++; return fail ? new Response('{"name":"synthetic_outage","message":"Synthetic failure"}', { status: 500 }) : new Response('{"id":"synthetic-sent"}'); }
      throw new Error("unexpected_test_fetch");
    }) as typeof fetch;
    try {
      const { GET } = await import("../../src/app/api/maple/usage-alerts/route");
      const req = (authorized: boolean, health = false) => new Request(`https://synthetic.example/api/maple/usage-alerts${health ? "?health=1" : ""}`, { headers: authorized ? { authorization: "Bearer synthetic-cron-secret" } : {} });
      eq((await GET(req(false))).status, 401);
      eq((await GET(req(true, true))).status, 503);
      eq((await GET(req(true))).status, 503);
      ok((await pending()).length > 0, "failed email stays pending");
      fail = false;
      eq((await GET(req(true))).status, 204);
      eq((await GET(req(true, true))).status, 204);
      eq(emails, 2);
      eq((await rows(`SELECT 1 FROM maple_usage_alerts WHERE key = 'last-successful-check' AND sent_at IS NOT NULL`)).length, 1);
      const monitor = (health: boolean) => new Request(`https://synthetic.example/api/maple/usage-alerts${health ? "?health=1" : ""}`, { headers: { authorization: "Bearer synthetic-monitor-secret" } });
      eq((await GET(monitor(true))).status, 204, "the monitor can read health");
      eq((await GET(monitor(false))).status, 401, "the monitor cannot run usage checks");
      await sql(`INSERT INTO maple_usage_alerts (key, subject, body) SELECT 'synthetic-backlog/' || n, 'Synthetic threshold', 'Synthetic counts only' FROM generate_series(1, 101) AS n`);
      eq((await GET(req(true))).status, 503, "a partial backlog is not a successful check");
      eq((await pending()).length, 1);
      eq((await GET(req(true))).status, 204);
      eq((await pending()).length, 0);
    } finally { globalThis.fetch = original; }
  });

  for (const path of ["chat", "onboarding"] as const) await test(`${path} stream failures schedule the credit alert without delaying the response`, async () => {
    await freshDb({ shape: "final" });
    const streamSeed = await seedFamilies();
    const { MockLanguageModelV4 } = await import("ai/test");
    const { chatTurn } = await import("../../src/lib/maple/chat/turn");
    const { answerOnboardingChat, familyChatDeps } = await import("../../src/lib/maple/onboarding/chat");
    const { priceFor } = await import("../../src/lib/maple/chat/prices");
    const { FAMILY_ONE_COPY } = await import("../../src/lib/maple/mcp-tools");
    const { resolveFamily } = await import("../../src/lib/maple/family");
    const { memberFor } = await import("../../src/lib/maple/auth");
    const model = new MockLanguageModelV4({ doStream: async () => { throw Object.assign(new Error("Synthetic private prompt"), { statusCode: 402, cause: { responseBody: '{"error":{"type":"insufficient_funds"}}' } }); } });
    const modelKey = "zai/glm-5.3-flash";
    const waits: Promise<unknown>[] = [];
    const original = globalThis.fetch;
    const payloads: string[] = [];
    process.env.RESEND_API_KEY = "re_synthetic_key";
    process.env.RESEND_EMAIL_DOMAIN = "example.com";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      eq(String(input), "https://api.resend.com/emails");
      payloads.push(String(init?.body));
      return new Response('{"id":"synthetic-credit-email"}');
    }) as typeof fetch;
    try {
      let response: Response;
      if (path === "chat") {
        response = await chatTurn({ model, modelKey, price: priceFor(modelKey)!, tools: {}, viewer: false, care: false, copy: FAMILY_ONE_COPY, messages: [{ id: "synthetic-question", role: "user", parts: [{ type: "text", text: "A synthetic question" }] }], responseId: "synthetic-response", crisis: false, deps: { save: async () => {}, record: async () => {}, release: async () => {}, report: () => {}, waitUntil: (p) => { waits.push(p); } } });
      } else {
        await sql(`UPDATE maple_families SET status = 'onboarding' WHERE id = 2`);
        const ctx = await resolveFamily(streamSeed.beta.owner, 2);
        const member = await memberFor({ familyId: 2 }, streamSeed.beta.owner);
        if (!ctx || !member) throw new Error("synthetic_member_missing");
        response = await answerOnboardingChat({ messages: [{ role: "user", text: "A synthetic question" }] }, member, familyChatDeps(ctx, member, { model, modelKey, now: new Date(), newId: () => "synthetic-response", report: () => {}, waitUntil: (p) => { waits.push(p); } }));
      }
      const body = await response.text();
      await Promise.all(waits);
      eq(response.status, 200);
      eq(payloads.length, 1);
      ok(!payloads[0].includes("Synthetic private prompt") && !body.includes("Synthetic private prompt"), "private prompt is absent");
      eq((await rows(`SELECT 1 FROM maple_usage_alerts WHERE key = 'gateway-credit/lifetime' AND sent_at IS NOT NULL`)).length, 1);
    } finally { globalThis.fetch = original; }
  });
}
void main().then(() => done("usage-alerts.check.ts")).catch((error) => { console.error(error); process.exit(1); });
