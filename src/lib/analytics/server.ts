import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { analyticsConfig } from "./config";
import { parseAnalyticsContext, type AnalyticsContext } from "./context";
import { reportAnalyticsFailure } from "./health";
import { claimAnalyticsVisitor, resolveAnalyticsActor, type AnalyticsActor, type AnalyticsIdentity } from "./identity";
import { APP_EVENTS, canonicalUrl, safeProperties, type AppAnalyticsEvent, type PublicAnalyticsEvent } from "./policy";
import { sendAnalyticsEvent } from "./transport";

export { readAnalyticsContext, ensureAnalyticsContext, clearAnalyticsContext, parseAnalyticsContext } from "./context";
export type { AnalyticsContext } from "./context";
export type { AnalyticsActor } from "./identity";

export function contextProperties(context?: AnalyticsContext): Record<string, unknown> {
  const ctx = parseAnalyticsContext(context);
  if (!ctx) return {};
  const { pathname, referrer_host, ...utm } = ctx.initial;
  const session = ctx.session ?? ctx.initial;
  return {
    $session_id: ctx.sessionId,
    ...(session.utm_source ? { utm_source: session.utm_source } : {}),
    ...(session.utm_medium ? { utm_medium: session.utm_medium } : {}),
    ...(session.utm_campaign ? { utm_campaign: session.utm_campaign } : {}),
    ...(session.referrer_host ? { $referring_domain: session.referrer_host } : {}),
    ...(pathname ? { $initial_current_url: canonicalUrl(pathname), $initial_pathname: pathname } : {}),
    ...(referrer_host ? { $initial_referring_domain: referrer_host } : {}),
    ...Object.fromEntries(Object.entries(utm).map(([key, value]) => [`$initial_${key}`, value])),
  };
}

function identifiedProperties(identity: AnalyticsIdentity, properties: Record<string, unknown>, context?: AnalyticsContext) {
  return { ...safeProperties(properties), ...contextProperties(context), $groups: { family: identity.familyGroupId }, family_id: identity.familyGroupId, $current_url: canonicalUrl("/maple"), $pathname: "/maple" };
}

async function captureIdentified(actor: AnalyticsActor, event: string, properties: Record<string, unknown> = {}, context?: AnalyticsContext): Promise<boolean> {
  if (!analyticsConfig()) return false;
  try {
    const identity = await resolveAnalyticsActor(actor);
    if (!identity) return false;
    return await sendAnalyticsEvent(identity.distinctId, event, identifiedProperties(identity, properties, context), identity,
      typeof properties.event_id === "string" ? properties.event_id : undefined);
  } catch { await reportAnalyticsFailure(); return false; }
}

export async function captureAppEvent(actor: AnalyticsActor, event: AppAnalyticsEvent, properties: Record<string, unknown> = {}, context?: AnalyticsContext): Promise<boolean> {
  if (!APP_EVENTS.includes(event)) return false;
  return captureIdentified(actor, event, properties, context);
}

function schedule(task: () => Promise<unknown>): void {
  if (!analyticsConfig()) return;
  const run = async () => { try { await task(); } catch { await reportAnalyticsFailure(); } };
  try { after(run); } catch { void run(); }
}

export function captureAppEventSoon(actor: AnalyticsActor, event: AppAnalyticsEvent, properties: Record<string, unknown> = {}, context?: AnalyticsContext): void {
  schedule(() => captureAppEvent(actor, event, properties, context));
}

async function captureAnonymous(event: string, context?: AnalyticsContext, properties: Record<string, unknown> = {}): Promise<boolean> {
  const ctx = parseAnalyticsContext(context);
  return sendAnalyticsEvent(ctx?.visitorId ?? randomUUID(), event, { ...safeProperties(properties), ...contextProperties(ctx) });
}

export async function captureSignupStarted(context?: AnalyticsContext, properties: Record<string, unknown> = {}): Promise<boolean> {
  return captureAnonymous("signup_started", context, properties);
}

export function captureSignupStartedSoon(context?: AnalyticsContext, properties: Record<string, unknown> = {}): void {
  schedule(() => captureSignupStarted(context, properties));
}

export function captureSignupFailedSoon(context?: AnalyticsContext, properties: Record<string, unknown> = {}): void {
  schedule(() => captureAnonymous("signup_failed", context, properties));
}

export function captureWaitlistJoinedSoon(context?: AnalyticsContext, properties: Record<string, unknown> = {}): void {
  schedule(() => captureAnonymous("waitlist_joined", context, properties));
}

export async function identifyAnalytics(actor: AnalyticsActor, context?: AnalyticsContext): Promise<boolean> {
  if (!analyticsConfig()) return false;
  try {
    const identity = await resolveAnalyticsActor(actor);
    if (!identity) return false;
    const ctx = parseAnalyticsContext(context);
    const link = ctx && await claimAnalyticsVisitor(ctx.visitorId, identity.distinctId);
    const properties = identifiedProperties(identity, {}, link ? ctx : undefined);
    const identified = await sendAnalyticsEvent(identity.distinctId, "$identify", {
      ...properties, ...(link ? { $anon_distinct_id: ctx.visitorId } : {}),
      $set_once: contextProperties(link ? ctx : undefined),
    }, identity, ctx?.visitorId);
    const grouped = await sendAnalyticsEvent(identity.distinctId, "$groupidentify", {
      ...properties, $group_type: "family", $group_key: identity.familyGroupId, $group_set: {},
    }, identity, identity.familyGroupId);
    return identified && grouped;
  } catch { await reportAnalyticsFailure(); return false; }
}

export function identifyAnalyticsSoon(actor: AnalyticsActor, context?: AnalyticsContext): void {
  schedule(() => identifyAnalytics(actor, context));
}

export async function captureSignupCompleted(actor: AnalyticsActor, context?: AnalyticsContext, properties: Record<string, unknown> = {}): Promise<boolean> {
  await identifyAnalytics(actor, context);
  return captureIdentified(actor, "signup_completed", properties, context);
}

export async function capturePublicEvent(event: PublicAnalyticsEvent, context: AnalyticsContext, actor?: AnalyticsActor): Promise<boolean> {
  const pathname = event.event === "client_error" ? undefined : event.properties.pathname;
  const properties: Record<string, unknown> = {
    ...contextProperties(context), ...(pathname ? { $current_url: canonicalUrl(pathname), $pathname: pathname } : {}),
    ...(pathname?.startsWith("/blog/") ? { blog_slug: pathname.slice(6) } : {}),
    ...(event.event === "signup_clicked" ? { placement: event.properties.placement } : {}),
  };
  if (event.event === "client_error") {
    properties.area = event.properties.area;
    properties.$exception_list = [{ type: event.properties.error_class, value: event.properties.error_class, mechanism: { type: "generic", handled: false } }];
  }
  try {
    const identity = actor ? await resolveAnalyticsActor(actor) : null;
    if (identity) {
      await claimAnalyticsVisitor(context.visitorId, identity.distinctId);
      properties.$groups = { family: identity.familyGroupId };
      properties.family_id = identity.familyGroupId;
    }
    return await sendAnalyticsEvent(identity?.distinctId ?? context.visitorId, event.event === "client_error" ? "$exception" : event.event, properties, identity ?? undefined, event.event_id);
  } catch { await reportAnalyticsFailure(); return false; }
}
