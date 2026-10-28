import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const now = new Date("2026-10-28T12:04:00Z");
const source = ts.transpileModule(readFileSync("src/lib/maple/usage-alerts/index.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function run(healthy: boolean) {
  let checks = 0;
  let records = 0;
  const dependencies: Record<string, unknown> = {
    "./delivery": { deliveryDeps: () => ({ now }), deliver: async () => true },
    "./policy": { thresholdAlerts: () => [] },
    "./reconcile": { reconcileMonth: async () => true },
    "./snapshot": { usageMetrics: async () => [] },
    "./store": { pending: async () => [], recordRun: async () => { records++; } },
    "@/lib/analytics/health": { checkAnalyticsHealth: async (date: Date) => {
      assert.equal(date, now);
      checks++;
      return healthy;
    } },
  };
  const exports: { runUsageAlerts?: () => Promise<boolean> } = {};
  runInNewContext(source, { exports, fetch: () => { throw new Error("Unexpected network"); }, require: (name: string) => {
    assert(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  assert.equal(await exports.runUsageAlerts!(), healthy);
  assert.equal(checks, 1);
  assert.equal(records, healthy ? 1 : 0);
}

void (async () => {
  await run(false);
  await run(true);
  console.log("Analytics monitor: scheduled check and stale-output failure passed");
})();
