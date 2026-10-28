import { z } from "zod";
import { MAPLE_ORIGIN } from "../maple/origin";

export const ANALYTICS_HOST = "https://us.i.posthog.com";
export const SCHEMA_VERSION = 2;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const APP_EVENTS = ["onboarding_started", "onboarding_step_completed", "onboarding_completed", "invite_created", "invite_sent", "invite_accepted", "chat_started", "chat_completed", "chat_failed", "entry_logged", "app_opened"] as const;
export type AppAnalyticsEvent = (typeof APP_EVENTS)[number];
export const SITE_EVENTS = ["$pageview", "signup_clicked", "client_error"] as const;
export type SiteAnalyticsEvent = (typeof SITE_EVENTS)[number];
export const ERROR_CLASSES = ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError", "UnhandledRejection"] as const;
export const BLOG_SLUGS = ["logging-hands-free-with-siri", "connect-maple-to-claude-or-chatgpt", "maples-first-week", "what-maple-sends-to-an-ai-model", "how-maple-counts-a-feed", "diaper-colors-in-maple"] as const;
const SITE_PATHS = new Set(["/", "/about", "/faq", "/pricing", "/privacy", "/terms", "/waitlist", "/signup", "/blog", ...BLOG_SLUGS.map((slug) => `/blog/${slug}`)]);
export const ATTRIBUTION_SCHEMA = z.object({
  pathname: z.string().refine((path) => sitePage(path) !== null).optional(),
  utm_source: z.enum(["google", "bing", "duckduckgo", "facebook", "instagram", "reddit", "newsletter", "email", "direct", "referral", "other"]).optional(),
  utm_medium: z.enum(["organic", "paid", "cpc", "social", "email", "referral", "none"]).optional(),
  utm_campaign: z.enum(["launch", "maple_launch", "blog", "newsletter", "organic"]).optional(),
  referrer_host: z.enum(["google.com", "www.google.com", "bing.com", "www.bing.com", "duckduckgo.com", "facebook.com", "www.facebook.com", "instagram.com", "www.instagram.com", "reddit.com", "www.reddit.com", "t.co", "other"]).optional(),
}).strict();
export type AnalyticsAttribution = z.infer<typeof ATTRIBUTION_SCHEMA>;
export const PLACEMENTS = ["header", "hero", "footer", "pricing", "other"] as const;
const pathname = z.string().max(160).refine((path) => sitePage(path) !== null);
export const PUBLIC_EVENT_SCHEMA = z.discriminatedUnion("event", [
  z.object({ event: z.literal("$pageview"), event_id: z.string().regex(UUID), properties: z.object({ pathname, initial: ATTRIBUTION_SCHEMA.optional() }).strict() }).strict(),
  z.object({ event: z.literal("signup_clicked"), event_id: z.string().regex(UUID), properties: z.object({ pathname, placement: z.enum(PLACEMENTS), initial: ATTRIBUTION_SCHEMA.optional() }).strict() }).strict(),
  z.object({ event: z.literal("client_error"), event_id: z.string().regex(UUID), properties: z.object({ error_class: z.enum(ERROR_CLASSES), area: z.enum(["window", "unhandledrejection"]) }).strict() }).strict(),
]);
export type PublicAnalyticsEvent = z.infer<typeof PUBLIC_EVENT_SCHEMA>;

export function analyticsHost(value?: string): string | null {
  return !value || value === ANALYTICS_HOST ? ANALYTICS_HOST : null;
}

export function sitePage(pathname: string): string | null {
  return SITE_PATHS.has(pathname) ? pathname : null;
}

export function canonicalUrl(pathname: string): string {
  return `${MAPLE_ORIGIN}${sitePage(pathname) ?? "/maple"}`;
}

export function initialAttribution(url: string, referrer = ""): AnalyticsAttribution {
  const out: AnalyticsAttribution = {};
  try {
    const parsed = new URL(url);
    if (sitePage(parsed.pathname)) out.pathname = parsed.pathname;
    for (const key of ["utm_source", "utm_medium", "utm_campaign"] as const) {
      const value = parsed.searchParams.get(key)?.toLowerCase();
      const result = ATTRIBUTION_SCHEMA.safeParse({ [key]: value });
      if (result.success && value !== undefined) Object.assign(out, result.data);
    }
    if (referrer) {
      const host = new URL(referrer).hostname.toLowerCase();
      if (host !== new URL(MAPLE_ORIGIN).hostname) {
        const result = ATTRIBUTION_SCHEMA.shape.referrer_host.safeParse(host);
        out.referrer_host = result.success ? result.data : "other";
      }
    }
  } catch {}
  return out;
}

const PROPERTY_SCHEMAS = {
  provider: z.enum(["google", "apple", "email"]),
  step: z.enum(["step_1", "step_2", "step_3", "step_4", "step_5", "step_6", "step_7", "step_8", "step_9", "step_10", "step_11"]),
  reason: z.enum(["invalid", "denied", "expired", "rate_limited", "unavailable", "failed", "cancelled", "budget", "timeout"]),
  source: z.enum(["ui", "chat", "mcp", "quick"]),
};

export function safeProperties(properties: Record<string, unknown> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(PROPERTY_SCHEMAS) as (keyof typeof PROPERTY_SCHEMAS)[]) {
    const result = PROPERTY_SCHEMAS[key].safeParse(properties[key]);
    if (result.success) out[key] = result.data;
  }
  return out;
}
