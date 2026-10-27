import { captureAppEventSoon } from "@/lib/analytics/server";
import { withMember } from "@/lib/maple/api";

export const POST = withMember("POST /api/maple/analytics/open", async (_request, _member, ctx) => {
  captureAppEventSoon(ctx.familyId, "app_opened");
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
});
