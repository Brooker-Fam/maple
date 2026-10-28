import { json } from "@/lib/maple/api";
import { withMetricsAdmin } from "@/lib/maple/admin/api";
import { parseAdminDetailsOptions, readAdminDetails } from "@/lib/maple/admin/details";

export const dynamic = "force-dynamic";

export const GET = withMetricsAdmin("GET /api/maple/admin/details", async (request) => {
  return json(await readAdminDetails(parseAdminDetailsOptions(new URL(request.url).searchParams)));
});
