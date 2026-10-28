import { json, withMember } from "@/lib/maple/api";
import { isMetricsAdmin, isMetricsAdminSession } from "@/lib/maple/admin/auth";
import { readAdminMetrics } from "@/lib/maple/admin/metrics";

export const dynamic = "force-dynamic";

export const GET = withMember("GET /api/maple/admin/metrics", async (request, member) => {
  if (!isMetricsAdmin(member.email)) return json({ error: "Not allowed" }, 403);
  if (!isMetricsAdminSession(request, member.email)) return json({ error: "Sign in again to view site metrics.", code: "metrics_reauth" }, 403);
  return json(await readAdminMetrics());
}, { setup: true });
