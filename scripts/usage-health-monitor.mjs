import { pathToFileURL } from "node:url";

const HEALTH_URL = "https://maplebaby.app/api/maple/usage-alerts?health=1";
const EMAIL_URL = "https://api.resend.com/emails";

async function requestStatus(url, init, fetcher, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal, redirect: "error" });
    return response.status;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

export async function monitor({ env = process.env, fetcher = fetch, now = new Date(), timeoutMs = 10_000, report = console.error } = {}) {
  const secret = env.MAPLE_USAGE_MONITOR_SECRET?.trim();
  if (secret) {
    try {
      const status = await requestStatus(HEALTH_URL, { method: "GET", headers: { Authorization: `Bearer ${secret}` }, cache: "no-store" }, fetcher, timeoutMs);
      if (status === 204) return 0;
    } catch {}
  }

  const key = env.MAPLE_USAGE_MONITOR_RESEND_KEY?.trim();
  let sent = false;
  if (key) {
    try {
      const day = now.toISOString().slice(0, 10);
      const status = await requestStatus(EMAIL_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `maple-usage-health/${day}` },
        body: JSON.stringify({
          from: "Maple <hello@maplebaby.app>",
          to: [env.MAPLE_ALERT_EMAIL?.trim() || "hello@maplebaby.app"],
          subject: "Maple's usage alerts need attention",
          text: `The independent check on ${day} could not confirm a successful Maple usage check within the last 36 hours.\n\nCheck the Maple usage health workflow and the daily usage job before relying on usage alerts.\n\nhttps://github.com/Brooker-Fam/maple/actions/workflows/maple-usage-health.yml`,
        }),
      }, fetcher, timeoutMs);
      sent = status >= 200 && status < 300;
    } catch {}
  }
  report(sent ? "Maple usage health check failed; operator email accepted." : "Maple usage health check failed; operator email was not accepted.");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await monitor();
