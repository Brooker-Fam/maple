import assert from "node:assert/strict";
import { authorized } from "../src/lib/maple/usage-alerts/auth";
import { isCreditRefusal } from "../src/lib/maple/usage-alerts/gateway";
import { decimalMicro, money, thresholdAlerts } from "../src/lib/maple/usage-alerts/policy";
import { previousMonth, providerSpend, reportMicro } from "../src/lib/maple/usage-alerts/reconcile";

let passed = 0;
let failed = 0;
async function test(name: string, run: () => unknown | Promise<unknown>) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

async function main() {
  await test("thresholds use integer arithmetic at 50, 80 and 100 percent", () => {
    const metric = { key: "chat/others", label: "Other families' chat", period: "2026-10", limit: BigInt(25_000_000), money: true };
    for (const [used, levels] of [[12_499_999, []], [12_500_000, [50]], [20_000_000, [50, 80]], [25_000_000, [50, 80, 100]]] as const) {
      const alerts = thresholdAlerts([{ ...metric, used: BigInt(used) }]);
      assert.deepEqual(alerts.map((a) => Number(a.key.split("/").at(-1))), levels);
      assert.ok(alerts.every((a) => a.body.includes("$25.000000")));
    }
    assert.equal(thresholdAlerts([{ ...metric, limit: BigInt(0), used: BigInt(0) }]).length, 0);
    assert.equal(money(BigInt(-1)), "-$0.000001");
  });
  await test("cron authorization requires the exact bearer secret and rejects missing configuration", () => {
    const req = (value: string) => new Request("https://synthetic.example/usage", { headers: { authorization: value } });
    assert.equal(authorized(req("Bearer made-up-secret"), "made-up-secret"), true);
    for (const value of ["", "made-up-secret", "Bearer wrong-secret", "Bearer made-up-secret-more"]) assert.equal(authorized(req(value), "made-up-secret"), false);
    assert.equal(authorized(req("Bearer undefined"), undefined), false);
  });
  await test("credit refusal detects Gateway codes in SDK causes without matching message contents", () => {
    assert.equal(isCreditRefusal({ statusCode: 402, cause: { responseBody: JSON.stringify({ error: { type: "insufficient_funds", message: "Synthetic private sentence" } }) } }), true);
    assert.equal(isCreditRefusal({ lastError: { statusCode: 402, data: { error: { code: "insufficient_funds" } } } }), true);
    for (const e of [{ statusCode: 402, type: "quota_for_entity_exceeded" }, { statusCode: 402, message: "insufficient_funds" }, { statusCode: 429, type: "insufficient_funds" }]) assert.equal(isCreditRefusal(e), false);
    const loop: { cause?: unknown } = {}; loop.cause = loop;
    assert.equal(isCreditRefusal(loop), false);
  });
  await test("Gateway cost decimals retain precision above the safe float range", () => {
    assert.deepEqual(reportMicro('{"results":[{"total_cost":9007199254740993.000001,"request_count":2},{"total_cost":0.0000006,"request_count":1}]}'), { cost: BigInt("9007199254740993000002"), requests: BigInt(3) });
    assert.equal(decimalMicro("1.23456789e-2"), BigInt(12346));
    assert.throws(() => reportMicro('{"results":[{"total_cost":-1,"request_count":1}]}'));
    assert.throws(() => reportMicro('{"results":[{"request_count":1}]}'));
  });
  await test("monthly reconciliation uses complete inclusive UTC months", () => {
    assert.deepEqual(previousMonth(new Date("2024-03-01T00:01:00Z")), { period: "2024-02", start: "2024-02-01", end: "2024-02-29", until: "2024-03-01T00:00:00.000Z" });
    assert.equal(previousMonth(new Date("2026-01-30T22:00:00Z")).period, "2025-12");
  });
  await test("the Gateway report sends only dates, the Maple tag and authentication", async () => {
    let called = false;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin + url.pathname, "https://ai-gateway.vercel.sh/v1/report");
      assert.deepEqual(Object.fromEntries(url.searchParams), { start_date: "2026-09-01", end_date: "2026-09-30", group_by: "day", tags: "maple-chat" });
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-oidc");
      assert.equal(init?.body, undefined);
      called = true;
      return new Response('{"results":[{"total_cost":1.000001,"request_count":4}]}');
    };
    assert.deepEqual(await providerSpend(previousMonth(new Date("2026-10-27T00:00:00Z")), { VERCEL_OIDC_TOKEN: "synthetic-oidc" }, fetcher), { cost: BigInt(1000001), requests: BigInt(4) });
    assert.ok(called);
    await assert.rejects(providerSpend(previousMonth(new Date()), {}, fetcher), /gateway_report_auth_missing/);
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
void main();
