import type { CaptureResult, PostHogConfig } from "posthog-js";

export const APP_EVENTS = ["signed_up", "onboarding_completed", "invite_sent", "chat_used", "entry_logged", "app_opened"] as const;
export type AppAnalyticsEvent = (typeof APP_EVENTS)[number];
export const SITE_EVENTS = ["$pageview", "signup_started", "signup_completed"] as const;

const SITE_PATHS = new Set(["/", "/about", "/faq", "/pricing", "/privacy", "/terms", "/waitlist", "/signup", "/blog", "/blog/article"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ANALYTICS_HOST = "https://us.i.posthog.com";

export function analyticsHost(value?: string): string | null {
  return !value || value === ANALYTICS_HOST ? ANALYTICS_HOST : null;
}

export function sitePage(pathname: string): string | null {
  if (SITE_PATHS.has(pathname)) return pathname;
  return /^\/blog\/[^/?#]+$/.test(pathname) ? "/blog/article" : null;
}

export function siteConfig(key: string, distinctId: string): Partial<PostHogConfig> {
  return {
    api_host: ANALYTICS_HOST,
    api_transport: "fetch",
    persistence: "memory",
    disable_persistence: true,
    autocapture: false,
    rageclick: false,
    capture_dead_clicks: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_performance: false,
    capture_exceptions: false,
    capture_heatmaps: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    disable_external_dependency_loading: true,
    advanced_disable_flags: true,
    advanced_disable_feature_flags: true,
    advanced_disable_feature_flags_on_first_load: true,
    save_campaign_params: false,
    save_referrer: false,
    disable_scroll_properties: true,
    person_profiles: "never",
    ip: false,
    request_batching: false,
    debug: false,
    get_current_url: () => ANALYTICS_HOST,
    before_send: (event): CaptureResult | null => {
      if (!UUID.test(distinctId) || !UUID.test(event.uuid)) return null;
      const page = event.event === "$pageview" ? sitePage(event.properties.$pathname) : null;
      if (!page) return null;
      return {
        uuid: event.uuid,
        event: event.event,
        timestamp: new Date(),
        properties: {
          token: key,
          distinct_id: `site:${distinctId}`,
          $process_person_profile: false,
          $geoip_disable: true,
          ...(page ? { $pathname: page } : {}),
        },
      };
    },
  };
}
