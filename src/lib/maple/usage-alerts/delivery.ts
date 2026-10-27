import { createHash } from "node:crypto";
import { CONTACT_EMAIL } from "@/components/site/legal";
import { sendEmail, type Email, type EmailResult } from "@/lib/email/send";
import { captureServerException, scrubError } from "@/lib/posthog-server";
import type { Alert } from "./policy";
import { claim, sent, settle } from "./store";

export type DeliveryDeps = {
  now: Date;
  env: Record<string, string | undefined>;
  send: (email: Email) => Promise<EmailResult>;
  report: (error: Error) => Promise<unknown> | unknown;
};

export function deliveryDeps(over: Partial<DeliveryDeps> = {}): DeliveryDeps {
  return { now: new Date(), env: process.env, send: sendEmail, report: (error) => captureServerException(scrubError(error), { route: "maple usage alerts" }), ...over };
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function deliver(alert: Alert, deps: DeliveryDeps): Promise<boolean> {
  const owned = await claim(alert, deps.now);
  if (!owned) return sent(alert.key);
  let accepted = false;
  try {
    const result = await deps.send({
      to: deps.env.MAPLE_ALERT_EMAIL?.trim() || CONTACT_EMAIL,
      subject: owned.subject,
      text: owned.body,
      html: `<p>${escape(owned.body).replace(/\n/g, "<br>")}</p>`,
      kind: "usage_alert",
      idempotencyKey: `usage/${createHash("sha256").update(owned.key).digest("hex")}`,
    });
    accepted = result.sent;
    if (!accepted) await deps.report(new Error("usage_alert_email_failed"));
    return accepted;
  } catch {
    await deps.report(new Error("usage_alert_email_failed"));
    return false;
  } finally {
    await settle(owned.key, owned.token, accepted, deps.now);
  }
}
