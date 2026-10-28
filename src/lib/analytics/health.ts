import { createHash } from "node:crypto";
import { CONTACT_EMAIL } from "@/components/site/legal";
import { MAPLE_ORIGIN } from "../maple/origin";
import { query } from "../db";
import { sendEmail } from "../email/send";
import { deliver, deliveryDeps, type DeliveryDeps } from "../maple/usage-alerts/delivery";
import { captureServerException } from "../posthog-server";
import { analyticsConfig, analyticsTags } from "./config";
import { pruneAnalytics } from "./schema";

let reporting = false;
const quietReport = () => { console.error("analytics_operator_email_failed"); };

export async function analyticsAlert(kind: "delivery" | "absence", now = new Date(), overrides: Partial<DeliveryDeps> = {}): Promise<boolean> {
  if (analyticsTags().is_test && !overrides.send) return true;
  const deps = deliveryDeps({
    now,
    send: (email) => sendEmail(email, { report: quietReport }),
    report: quietReport,
    ...overrides,
  });
  const alert = {
    key: `analytics/${kind}/${analyticsTags().environment}/${now.toISOString().slice(0, 10)}`,
    subject: kind === "delivery" ? "Maple analytics delivery failed" : "Maple analytics has no recent accepted delivery",
    body: kind === "delivery"
      ? "Analytics delivery exhausted its bounded retries. Check the analytics project configuration and delivery health. App operations continue. This notice contains no event contents or account identifiers."
      : "No accepted non-test analytics delivery was recorded in the last 36 hours. Check traffic, analytics configuration and delivery. This notice contains no event contents or account identifiers.",
  };
  alert.body += `\n\nHTTP acceptance does not confirm ingestion into PostHog. Verify the events in the project.\n${MAPLE_ORIGIN}/maple/admin`;
  try { return await deliver(alert, deps); }
  catch {
    const result = await deps.send({
      to: deps.env.MAPLE_ALERT_EMAIL?.trim() || CONTACT_EMAIL,
      subject: alert.subject, text: alert.body,
      html: `<p>${alert.body.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!).replace(/\n/g, "<br>")}</p>`,
      kind: "usage_alert", idempotencyKey: `usage/${createHash("sha256").update(alert.key).digest("hex")}`,
    });
    if (!result.sent) quietReport();
    return result.sent;
  }
}

export async function reportAnalyticsFailure(): Promise<void> {
  console.error("analytics_delivery_failed");
  if (reporting) return;
  reporting = true;
  try {
    await Promise.allSettled([
      captureServerException(new Error("analytics_delivery_failed"), { where: "analytics" }),
      analyticsAlert("delivery"),
    ]);
  } finally { reporting = false; }
}

export async function analyticsHealth(now = new Date()): Promise<{ enabled: boolean; healthy: boolean; lastDeliveredAt: string | null }> {
  if (!analyticsConfig()) return { enabled: false, healthy: true, lastDeliveredAt: null };
  try {
    const rows = await query(`SELECT MAX(delivered_at) AS last_delivery FROM maple_analytics_deliveries
      WHERE environment = $1 AND is_test = FALSE AND delivered_at <= $2`, [analyticsTags().environment, now.toISOString()]);
    const lastDeliveredAt = rows?.[0]?.last_delivery ? new Date(rows[0].last_delivery).toISOString() : null;
    return { enabled: true, healthy: lastDeliveredAt !== null && now.getTime() - Date.parse(lastDeliveredAt) <= 36 * 60 * 60 * 1000, lastDeliveredAt };
  } catch { return { enabled: true, healthy: false, lastDeliveredAt: null }; }
}

export async function checkAnalyticsHealth(now = new Date()): Promise<boolean> {
  const health = await analyticsHealth(now);
  if (!health.enabled) return true;
  try {
    if (!health.healthy) await analyticsAlert("absence", now);
    await pruneAnalytics();
  } catch { console.error("analytics_health_check_failed"); return false; }
  return health.healthy;
}
