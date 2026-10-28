import { z } from "zod";
import { ensureAnalyticsContext } from "@/lib/analytics/context";
import { reportAnalyticsFailure } from "@/lib/analytics/health";
import { UUID } from "@/lib/analytics/policy";
import { analyticsJson, analyticsRateLimit, analyticsResponse, analyticsSameOrigin } from "@/lib/analytics/request";
import { captureAppEvent } from "@/lib/analytics/server";
import { withMember } from "@/lib/maple/api";

const schema = z.object({ event_id: z.string().regex(UUID) }).strict();

export const POST = withMember("POST /api/maple/analytics/open", async (request, member, ctx) => {
  if (!analyticsSameOrigin(request)) return analyticsResponse(false, 403);
  const body = schema.safeParse(await analyticsJson(request));
  if (!body.success) return analyticsResponse(false, 400);
  try {
    if (!await analyticsRateLimit(request)) return analyticsResponse(false, 429);
    const response = analyticsResponse(true);
    const context = ensureAnalyticsContext(request, response);
    const success = await captureAppEvent({ familyId: ctx.familyId, member: member.email, role: member.role }, "app_opened", { event_id: body.data.event_id }, context);
    if (success) return response;
    const failure = analyticsResponse(false);
    const cookie = response.headers.get("set-cookie");
    if (cookie) failure.headers.set("set-cookie", cookie);
    return failure;
  } catch { await reportAnalyticsFailure(); return analyticsResponse(false); }
}, { setup: true });
