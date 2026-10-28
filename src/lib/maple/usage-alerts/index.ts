import { deliver, deliveryDeps, type DeliveryDeps } from "./delivery";
import { thresholdAlerts } from "./policy";
import { reconcileMonth } from "./reconcile";
import { usageMetrics } from "./snapshot";
import { pending, recordRun } from "./store";
import { checkAnalyticsHealth } from "@/lib/analytics/health";

export async function runUsageAlerts(over: Partial<DeliveryDeps> = {}, fetcher: typeof fetch = fetch): Promise<boolean> {
  const deps = deliveryDeps(over);
  const alerts = new Map((await pending()).map((alert) => [alert.key, alert]));
  for (const alert of thresholdAlerts(await usageMetrics(deps.now, deps.env))) if (!alerts.has(alert.key)) alerts.set(alert.key, alert);
  let complete = true;
  for (const alert of alerts.values()) if (!(await deliver(alert, deps))) complete = false;
  if (!(await reconcileMonth(deps, fetcher))) complete = false;
  if (!(await checkAnalyticsHealth(deps.now))) complete = false;
  if ((await pending()).length) complete = false;
  if (complete) await recordRun(deps.now);
  return complete;
}
