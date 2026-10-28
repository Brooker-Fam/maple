import { z } from "zod";
import { NextRequest } from "next/server";
import { sessionContext } from "@/lib/maple/auth";
import { analyticsConfig } from "@/lib/analytics/config";
import { clearAnalyticsContext, ensureAnalyticsContext } from "@/lib/analytics/context";
import { reportAnalyticsFailure } from "@/lib/analytics/health";
import { ATTRIBUTION_SCHEMA, PUBLIC_EVENT_SCHEMA } from "@/lib/analytics/policy";
import { analyticsJson, analyticsRateLimit, analyticsResponse, analyticsSameOrigin } from "@/lib/analytics/request";
import { capturePublicEvent } from "@/lib/analytics/server";

const actionSchema = z.object({ action: z.enum(["context", "reset"]), initial: ATTRIBUTION_SCHEMA.optional() }).strict();

export async function POST(request: Request): Promise<Response> {
  if (!analyticsSameOrigin(request)) return analyticsResponse(false, 403);
  const body = await analyticsJson(request);
  const action = actionSchema.safeParse(body);
  if (action.success && action.data.action === "reset") {
    const response = analyticsResponse(true);
    clearAnalyticsContext(response);
    return response;
  }
  const event = PUBLIC_EVENT_SCHEMA.safeParse(body);
  if (!action.success && !event.success) return analyticsResponse(false, 400);
  if (!analyticsConfig()) return analyticsResponse(false);
  try {
    if (!await analyticsRateLimit(request, event.success && event.data.event === "client_error")) return analyticsResponse(false, 429);
    const response = analyticsResponse(true);
    const context = ensureAnalyticsContext(request, response, action.success ? action.data.initial : event.success && event.data.event !== "client_error" ? event.data.properties.initial : undefined);
    if (!context) return analyticsResponse(false);
    const signedIn = event.success ? await sessionContext(new NextRequest(request.url, { headers: request.headers })) : null;
    const actor = signedIn ? { familyId: signedIn.ctx.familyId, member: signedIn.member.email, role: signedIn.member.role } : undefined;
    if (event.success && !await capturePublicEvent(event.data, context, actor)) {
      const failure = analyticsResponse(false);
      const cookie = response.headers.get("set-cookie");
      if (cookie) failure.headers.set("set-cookie", cookie);
      return failure;
    }
    return response;
  } catch {
    await reportAnalyticsFailure();
    return analyticsResponse(false);
  }
}
