import { NextRequest } from "next/server";
import { captureServerException } from "@/lib/posthog-server";
import { errCode, runPushTick } from "@/lib/maple/push";
import { verifyQstash, type Via } from "@/lib/maple/push-wake";

/**
 * Send whatever notifications are due (src/lib/maple/push.ts), then re-arm
 * the exact-time wake-ups (push-wake.ts).
 *
 * Who calls it:
 *   - QStash, at the exact moments (a signed request, X-Maple-Via: wake,
 *     retry or test) and on its safety-net schedule (net);
 *   - a cron with Authorization: Bearer $CRON_SECRET (via=daily);
 *   - the GitHub workflow (.github/workflows/maple-reminders.yml, via=gh), a
 *     best-effort backstop;
 *   - anyone else. That's safe: it only sends what's due, each once, and an
 *     unsigned call runs at most once per 20 seconds.
 * A signed or cron call skips the 20-second gate. Everyone gets 204 and no
 * body (a count would tell an outsider when her medicines come up); a
 * trusted call that fails gets 500, so QStash retries it.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TRUSTED_VIAS: Via[] = ["wake", "net", "daily", "retry", "test"];

async function handle(request: NextRequest): Promise<Response> {
  const raw = request.method === "POST" ? await request.text().catch(() => "") : "";
  const signature = request.headers.get("upstash-signature");
  const signed = verifyQstash(signature, raw);
  if (signature && !signed) void captureServerException(new Error("qstash signature rejected"), { route: "/api/maple/push/tick" });
  const secret = process.env.CRON_SECRET;
  const cron = !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
  const trusted = signed || cron;
  const asked = (request.headers.get("x-maple-via") ?? new URL(request.url).searchParams.get("via") ?? "").toLowerCase() as Via;
  const via: Via = trusted ? (TRUSTED_VIAS.includes(asked) ? asked : signed ? "wake" : "daily") : asked === "gh" ? "gh" : "ext";
  try {
    await runPushTick(new Date(), { via, trusted, schedule: true });
  } catch (err) {
    void captureServerException(new Error(errCode(err)), { route: "/api/maple/push/tick" });
    if (trusted) return new Response(null, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

export { handle as GET, handle as POST };
