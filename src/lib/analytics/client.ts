"use client";

import type { PostHog } from "posthog-js";
import { analyticsHost, siteConfig, sitePage } from "./policy";

let client: Promise<PostHog | null> | null = null;

function siteClient(): Promise<PostHog | null> {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key || !analyticsHost(process.env.NEXT_PUBLIC_POSTHOG_HOST) || typeof window === "undefined") return Promise.resolve(null);
  client ??= import("posthog-js/no-external").then(({ default: posthog }) => {
    posthog.init(key, siteConfig(key, crypto.randomUUID()));
    return posthog;
  }).catch(() => null);
  return client;
}

export function captureSitePage(pathname: string): void {
  const page = sitePage(pathname);
  if (page) void siteClient().then((ph) => ph?.capture("$pageview", { $pathname: page }));
}
