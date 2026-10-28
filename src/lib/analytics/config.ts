import { analyticsHost, SCHEMA_VERSION } from "./policy";

export function analyticsConfig(): { key: string; host: string } | null {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  const host = analyticsHost(process.env.NEXT_PUBLIC_POSTHOG_HOST);
  return key && host && process.env.DATABASE_URL ? { key, host } : null;
}

export function analyticsTags() {
  const environment = process.env.VERCEL_ENV === "production" ? "production" : process.env.VERCEL_ENV === "preview" ? "preview" : "development";
  return { environment, schema_version: SCHEMA_VERSION, is_test: process.env.MAPLE_ANALYTICS_TEST === "1" };
}
