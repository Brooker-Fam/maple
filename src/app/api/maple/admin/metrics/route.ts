import { json } from "@/lib/maple/api";
import { withMetricsAdmin } from "@/lib/maple/admin/api";
import { readAdminMetrics } from "@/lib/maple/admin/metrics";

export const dynamic = "force-dynamic";

export const GET = withMetricsAdmin("GET /api/maple/admin/metrics", async () => {
  return json(await readAdminMetrics());
});
