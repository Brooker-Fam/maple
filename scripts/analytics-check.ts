import assert from "node:assert/strict";
import type { CaptureResult, PostHogConfig } from "posthog-js";
import { analyticsHost, APP_EVENTS, siteConfig, sitePage } from "../src/lib/analytics/policy";
import { captureAppEvent, captureSignupCompleted, captureSignupStarted, familyAnalyticsId } from "../src/lib/analytics/server";

const KEY = "phc_synthetic_check";
const ID = "00000000-0000-4000-8000-000000000001";
const SECRET = "synthetic-analytics-check-secret";
const PRIVATE = "Synthetic Parent private@example.test synthetic-health-value synthetic-token";
let passed = 0;
let failed = 0;

async function check(name: string, run: () => void | Promise<void>) {
  try {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function checkSite() {
  const config = siteConfig(KEY, ID);
  const filter = config.before_send as (event: CaptureResult) => CaptureResult | null;
  const event = (name: string, path = "/") => ({
    uuid: ID,
    event: name,
    properties: {
      $pathname: path, distinct_id: PRIVATE, $current_url: `https://example.test/signup?${PRIVATE}#${PRIVATE}`,
      $referrer: PRIVATE, $browser: PRIVATE, $device_id: PRIVATE, $session_id: PRIVATE,
      name: PRIVATE, email: PRIVATE, kind: PRIVATE, contents: PRIVATE, $set: { name: PRIVATE },
    },
    $set: { name: PRIVATE }, $set_once: { email: PRIVATE }, $unset: [PRIVATE],
  });

  await check("site disables automatic collection, persistence and remote configuration", () => {
    const off = ["autocapture", "rageclick", "capture_dead_clicks", "capture_pageview", "capture_pageleave", "capture_performance", "capture_exceptions", "capture_heatmaps", "save_campaign_params", "save_referrer", "ip", "request_batching", "debug"];
    const on = ["disable_persistence", "disable_session_recording", "disable_surveys", "disable_product_tours", "disable_conversations", "disable_web_experiments", "disable_external_dependency_loading", "advanced_disable_flags", "advanced_disable_feature_flags", "advanced_disable_feature_flags_on_first_load", "disable_scroll_properties"];
    for (const key of off) assert.equal(config[key as keyof PostHogConfig], false, key);
    for (const key of on) assert.equal(config[key as keyof PostHogConfig], true, key);
    assert.equal(config.persistence, "memory");
    assert.equal(config.person_profiles, "never");
    assert.equal(config.api_transport, "fetch");
  });

  await check("site transport payload removes identities, health data, URL secrets and enrichment", () => {
    for (const name of ["$pageview"]) {
      const output = filter(event(name));
      assert(output);
      assert.deepEqual(Object.keys(output).sort(), ["event", "properties", "timestamp", "uuid"]);
      assert.deepEqual(output.properties, {
        token: KEY, distinct_id: `site:${ID}`, $process_person_profile: false, $geoip_disable: true,
        ...(name === "$pageview" ? { $pathname: "/" } : {}),
      });
      assert(!JSON.stringify(output).includes(PRIVATE));
    }
    assert.equal(siteConfig(KEY, PRIVATE).before_send instanceof Function &&
      (siteConfig(KEY, PRIVATE).before_send as typeof filter)(event("$pageview")), null);
    assert.equal(filter({ ...event("$pageview"), uuid: PRIVATE }), null);
  });

  await check("only public page categories are allowed in browser events", () => {
    for (const path of ["/maple", "/maple/join", "/signup/families", "/signup?token=synthetic", "/signup#synthetic", "/unknown"]) {
      assert.equal(sitePage(path), null, path);
      assert.equal(filter(event("$pageview", path)), null, path);
    }
    assert.equal(sitePage("/blog/private@example.test"), "/blog/article");
    assert.equal(sitePage("/privacy"), "/privacy");
    for (const name of ["$autocapture", "$snapshot", "$identify", "$set", "$pageleave", "$exception", "$feature_flag_called", "entry_logged", "signup_started", "signup_completed", PRIVATE]) {
      assert.equal(filter(event(name)), null, name);
    }
  });

}

async function checkServer() {
  const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    return new Response(null, { status: 200 });
  };
  const names = ["NEXT_PUBLIC_POSTHOG_KEY", "NEXT_PUBLIC_POSTHOG_HOST", "MAPLE_SESSION_SECRET", "GOOGLE_CLIENT_SECRET"] as const;
  const originalEnv = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.NEXT_PUBLIC_POSTHOG_KEY = KEY;
  process.env.MAPLE_SESSION_SECRET = SECRET;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
  try {
    await check("family identity is a domain-separated HMAC, never an ID or member", () => {
      const id = familyAnalyticsId(701);
      assert.match(id ?? "", /^family:[a-f0-9]{64}$/);
      assert.equal(id, familyAnalyticsId(701));
      assert.notEqual(id, familyAnalyticsId(702));
      process.env.MAPLE_SESSION_SECRET = `${SECRET}-other`;
      assert.notEqual(id, familyAnalyticsId(701));
      process.env.MAPLE_SESSION_SECRET = SECRET;
      for (const invalid of [NaN, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(familyAnalyticsId(invalid), null);
    });

    await check("server events carry only a family HMAC or anonymous signup ID and privacy flags", async () => {
      requests.length = 0;
      for (const name of APP_EVENTS) await captureAppEvent(701, name);
      await captureSignupCompleted(701);
      await captureSignupStarted();
      assert.equal(requests.length, 8);
      assert.deepEqual(requests.map((r) => r.body.event), [...APP_EVENTS, "signup_completed", "signup_started"]);
      for (const request of requests) {
        assert.equal(request.url, "https://us.i.posthog.com/capture/");
        assert.equal(request.init.credentials, "omit");
        assert.equal(request.init.referrerPolicy, "no-referrer");
        const properties = request.body.properties as Record<string, unknown>;
        const id = request.body.event === "signup_started" ? properties.distinct_id : familyAnalyticsId(701);
        if (request.body.event === "signup_started") assert.match(String(id), /^site:[a-f0-9-]{36}$/);
        assert.deepEqual(request.body, {
          api_key: KEY, event: request.body.event,
          properties: { distinct_id: id, $process_person_profile: false, $geoip_disable: true },
        });
        assert(!JSON.stringify(request.body).includes(SECRET));
      }
    });

    await check("missing credentials, invalid identity, unapproved event or host sends nothing", async () => {
      requests.length = 0;
      delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
      await captureAppEvent(701, "app_opened");
      await captureSignupCompleted(701);
      await captureSignupStarted();
      process.env.NEXT_PUBLIC_POSTHOG_KEY = KEY;
      delete process.env.MAPLE_SESSION_SECRET;
      await captureAppEvent(701, "app_opened");
      process.env.MAPLE_SESSION_SECRET = SECRET;
      await captureAppEvent(-1, "app_opened");
      await captureAppEvent(701, PRIVATE as (typeof APP_EVENTS)[number]);
      process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://unapproved.example.test";
      await captureAppEvent(701, "app_opened");
      assert.equal(analyticsHost(process.env.NEXT_PUBLIC_POSTHOG_HOST), null);
      delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
      assert.equal(requests.length, 0);
    });

    await check("an analytics transport failure never fails the app operation", async () => {
      globalThis.fetch = async () => { throw new Error(PRIVATE); };
      await captureAppEvent(701, "entry_logged");
      await captureSignupCompleted(701);
      await captureSignupStarted();
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  }
}

async function main() {
  await checkSite();
  await checkServer();
  console.log(`Analytics: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

void main();
