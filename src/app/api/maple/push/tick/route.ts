import { NextRequest } from "next/server";
import { captureServerException } from "@/lib/posthog-server";
import { errCode, runPushTick } from "@/lib/maple/push";
import { schedulerMode, verifyQstash, type Via } from "@/lib/maple/push-wake";

/**
 * Send whatever notifications are due (src/lib/maple/push.ts), then re-arm
 * the exact-time wake-ups (push-wake.ts).
 *
 * Who calls it:
 *   - QStash, at the exact moments (a signed request, X-Maple-Via: wake,
 *     retry or test) and on its safety-net schedule (net);
 *   - a cron with Authorization: Bearer $CRON_SECRET (via=daily);
 *   - the GitHub workflow (.github/workflows/maple-reminders.yml, via=gh), a
 *     best-effort backstop every 5 minutes; once QStash is the clock, only
 *     its runs near :04 and :34 (the safety net's minutes) do anything;
 *   - anyone else. That's safe: it only sends what's due, each once, and an
 *     unsigned call runs at most once per 20 seconds.
 * A signed or cron call skips the 20-second gate. Everyone gets 204 and no
 * body (a count would tell an outsider when her medicines come up); a
 * trusted call that fails gets 500, so QStash retries it.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TRUSTED_VIAS: Via[] = ["wake", "net", "daily", "retry", "test"];

/** A bad signature is reported once per 10 minutes per instance: anyone can send one. */
let lastRejected = 0;
const REJECT_REPORT_MS = 10 * 60_000;

/** The GitHub backstop's runs that do something once QStash is the clock (its safety net's minutes, :04 and :34). */
function ghUseful(now: Date): boolean {
  if (schedulerMode() !== "qstash") return true;
  const m = now.getUTCMinutes() % 30;
  return m >= 4 && m < 9;
}

async function handle(request: NextRequest): Promise<Response> {
  const raw = request.method === "POST" ? await request.text().catch(() => "") : "";
  const signature = request.headers.get("upstash-signature");
  const signed = verifyQstash(signature, raw);
  if (signature && !signed && Date.now() - lastRejected > REJECT_REPORT_MS) {
    lastRejected = Date.now();
    void captureServerException(new Error("qstash signature rejected"), { route: "/api/maple/push/tick" });
  }
  const secret = process.env.CRON_SECRET;
  const cron = !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
  const trusted = signed || cron;
  const asked = (request.headers.get("x-maple-via") ?? new URL(request.url).searchParams.get("via") ?? "").toLowerCase() as Via;
  const via: Via = trusted ? (TRUSTED_VIAS.includes(asked) ? asked : signed ? "wake" : "daily") : asked === "gh" ? "gh" : "ext";
  // Every 5 minutes without QStash, as before; with it, only beside the safety net, so the database can sleep.
  if (via === "gh" && !ghUseful(new Date())) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  try {
    await runPushTick(new Date(), { via, trusted, schedule: true });
  } catch (err) {
    void captureServerException(new Error(errCode(err)), { route: "/api/maple/push/tick" });
    if (trusted) return new Response(null, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

export { handle as GET, handle as POST };
