import { captureServerException, scrubError } from "@/lib/posthog-server";
import { runUsageAlerts } from "@/lib/maple/usage-alerts";
import { healthy } from "@/lib/maple/usage-alerts/store";
import { authorized } from "@/lib/maple/usage-alerts/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const health = new URL(request.url).searchParams.get("health") === "1";
  if (!authorized(request, process.env.CRON_SECRET) && !(health && authorized(request, process.env.MAPLE_USAGE_MONITOR_SECRET))) {
    await captureServerException(new Error("usage_alerts_unauthorized"), { route: "GET /api/maple/usage-alerts" });
    return new Response(null, { status: 401, headers });
  }
  try {
    if (health) {
      if (!(await healthy(new Date()))) throw new Error("usage_alerts_stale");
      return new Response(null, { status: 204, headers });
    }
    const complete = await runUsageAlerts({ env: { ...process.env, VERCEL_OIDC_TOKEN: request.headers.get("x-vercel-oidc-token") ?? process.env.VERCEL_OIDC_TOKEN } });
    if (!complete) throw new Error("usage_alerts_incomplete");
    return new Response(null, { status: 204, headers });
  } catch (error) {
    await captureServerException(scrubError(error), { route: "GET /api/maple/usage-alerts" });
    return new Response(null, { status: 503, headers });
  }
}
