import assert from "node:assert/strict";
import { GROK_CALLBACK, MUSE_CALLBACK, trustedRedirect } from "../src/lib/mcp/auth";
import { createOAuthClientResolver, OAuthClientError } from "../src/lib/mcp/clients";

const HOSTED = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const LOCAL = "https://claude.ai/oauth/claude-code-client-metadata";
const CHATGPT = "https://chatgpt.com/oauth/client.json";
const CALLBACK = "https://claude.ai/synthetic-callback?fixture=one";
const LOCAL_CALLBACK = "http://localhost/synthetic-callback?fixture=two";
const CHATGPT_CALLBACK = "https://chatgpt.com/synthetic-callback?fixture=three";

function metadata(clientId = HOSTED, redirectUris = [CALLBACK]) {
  return {
    client_id: clientId,
    client_name: "Synthetic Connector",
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

function documentResponse(body: unknown = metadata(), headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });
}

function setup(response: () => Response | Promise<Response> = () => documentResponse(), timeoutMs = 50) {
  let now = 10_000;
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return response();
  };
  return { resolve: createOAuthClientResolver({ fetch: fetcher, now: () => now, timeoutMs }), calls, advance: (ms: number) => { now += ms; } };
}

async function rejected(promise: Promise<unknown>, code: OAuthClientError["code"]) {
  await assert.rejects(promise, error => error instanceof OAuthClientError && error.code === code);
}

const checks: [string, () => Promise<void>][] = [
  ["clients may advertise additional grants and responses alongside Maple's supported capabilities", async () => {
    const body = {
      ...metadata(),
      grant_types: ["authorization_code", "refresh_token", "urn:example:synthetic-grant"],
      response_types: ["code", "synthetic-response"],
    };
    const fixture = setup(() => documentResponse(body));
    assert.deepEqual(await fixture.resolve(HOSTED, CALLBACK), { name: "Synthetic Connector", host: "claude.ai", metadataUrl: HOSTED });
  }],
  ["ChatGPT metadata negotiates public authentication and keeps redirect and cache restrictions", async () => {
    const body = {
      ...metadata(CHATGPT, [CHATGPT_CALLBACK]),
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    };
    const fixture = setup(() => documentResponse(body, { "cache-control": "max-age=2" }));
    assert.deepEqual(await fixture.resolve(CHATGPT, CHATGPT_CALLBACK), { name: "Synthetic Connector", host: "chatgpt.com", metadataUrl: CHATGPT });
    await rejected(fixture.resolve(CHATGPT, "https://chatgpt.com/another-callback?fixture=three"), "invalid_redirect");
    await rejected(fixture.resolve(CHATGPT, `${CHATGPT_CALLBACK}&other=1`), "invalid_redirect");
    await fixture.resolve(CHATGPT, CHATGPT_CALLBACK);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].input, CHATGPT);
    fixture.advance(2_000);
    await fixture.resolve(CHATGPT, CHATGPT_CALLBACK);
    assert.equal(fixture.calls.length, 2);
    await rejected(fixture.resolve(`${CHATGPT}?other=1`, CHATGPT_CALLBACK), "invalid_client");
    assert.equal(fixture.calls.length, 2);
  }],
  ["authentication metadata cannot omit public support or contain malformed method lists", async () => {
    for (const methods of [null, [], "none", ["private_key_jwt"], ["none", 7], ["none", ""], [" none "]]) {
      const fixture = setup(() => documentResponse({ ...metadata(), token_endpoint_auth_methods_supported: methods }));
      await rejected(fixture.resolve(HOSTED, CALLBACK), "invalid_client");
    }
    await rejected(setup(() => documentResponse({ ...metadata(), token_endpoint_auth_method: "private_key_jwt" })).resolve(HOSTED, CALLBACK), "invalid_client");
  }],
  ["verified metadata supplies consent identity while legacy clients retain their redirects", async () => {
    const fixture = setup();
    assert.deepEqual(await fixture.resolve(HOSTED, CALLBACK), { name: "Synthetic Connector", host: "claude.ai", metadataUrl: HOSTED });
    assert.deepEqual(await fixture.resolve("mcp-synthetic-legacy", "https://chatgpt.com/synthetic-callback"), { name: "ChatGPT", host: "chatgpt.com" });
    assert.deepEqual(await fixture.resolve("mcp-synthetic-local", "http://localhost:4321/legacy-callback"), { name: "this app", host: "localhost:4321" });
    assert.deepEqual(await fixture.resolve("mcp-synthetic-muse", MUSE_CALLBACK), { name: "Muse", host: "agent.meta.ai" });
    assert.deepEqual(await fixture.resolve("mcp-synthetic-grok", GROK_CALLBACK), { name: "Grok", host: "grok.com" });
    await rejected(fixture.resolve("mcp-synthetic-legacy", "https://untrusted.example.test/callback"), "invalid_redirect");
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].input, HOSTED);
    assert.equal(fixture.calls[0].init?.credentials, "omit");
    assert.equal(fixture.calls[0].init?.redirect, "error");
    assert.equal(fixture.calls[0].init?.cache, "no-store");
    assert.equal(new Headers(fixture.calls[0].init?.headers).get("accept"), "application/json");
  }],
  ["Muse is trusted at its exact callback only", async () => {
    assert.equal(trustedRedirect(MUSE_CALLBACK), true, "Muse's codes get refresh tokens");
    const fixture = setup();
    for (const redirect of [`${MUSE_CALLBACK}?other=1`, `${MUSE_CALLBACK}/`, `${MUSE_CALLBACK}#fragment`, "https://agent.meta.ai/api/hatch/oauth/another-callback", "https://agent.meta.ai/api/hatch/oauth/../oauth/callback", "https://agent.meta.ai/", "http://agent.meta.ai/api/hatch/oauth/callback", "https://AGENT.meta.ai/api/hatch/oauth/callback", "https://agent.meta.ai:443/api/hatch/oauth/callback", "https://user@agent.meta.ai/api/hatch/oauth/callback", "https://meta.ai/api/hatch/oauth/callback", "https://agent.meta.ai.attacker.example.test/api/hatch/oauth/callback"]) {
      assert.equal(trustedRedirect(redirect), false, redirect);
      await rejected(fixture.resolve("mcp-synthetic-muse", redirect), "invalid_redirect");
    }
    assert.equal(fixture.calls.length, 0);
  }],
  ["Grok is trusted at its exact callback only", async () => {
    assert.equal(trustedRedirect(GROK_CALLBACK), true, "Grok's codes get refresh tokens");
    const fixture = setup();
    for (const redirect of ["https://grok.com/connectors-oauth-exchange-code", `${GROK_CALLBACK}?other=1`, `${GROK_CALLBACK}#fragment`, `${GROK_CALLBACK}extra`, "https://grok.com/connectors/oauth/callback", "https://grok.com/", "http://grok.com/connectors-oauth-exchange-code/", "https://GROK.com/connectors-oauth-exchange-code/", "https://grok.com:443/connectors-oauth-exchange-code/", "https://user@grok.com/connectors-oauth-exchange-code/", "https://www.grok.com/connectors-oauth-exchange-code/", "https://grok.com.attacker.example.test/connectors-oauth-exchange-code/", "https://x.ai/connectors-oauth-exchange-code/"]) {
      assert.equal(trustedRedirect(redirect), false, redirect);
      await rejected(fixture.resolve("mcp-synthetic-grok", redirect), "invalid_redirect");
    }
    assert.equal(fixture.calls.length, 0);
  }],
  ["URL client identifiers outside the exact allowlist never fetch", async () => {
    const fixture = setup();
    for (const clientId of ["", "https://127.0.0.1/metadata", "https://169.254.169.254/latest", "https://attacker.example.test/client", `${HOSTED}?other=1`, `${HOSTED}#fragment`, "https://user@claude.ai/oauth/mcp-oauth-client-metadata", "http://claude.ai/oauth/mcp-oauth-client-metadata", "file:///tmp/client.json", "//attacker.example.test/client", ` ${HOSTED}`, `ht\ttps://claude.ai/oauth/mcp-oauth-client-metadata`, "https://", " //attacker.example.test/client"]) {
      await rejected(fixture.resolve(clientId, CALLBACK), "invalid_client");
    }
    assert.equal(fixture.calls.length, 0);
  }],
  ["malformed and unsupported metadata cannot authorize a redirect", async () => {
    const invalid = [null, [], {}, { ...metadata(), client_id: LOCAL }, { ...metadata(), redirect_uris: [] }, { ...metadata(), redirect_uris: CALLBACK }, { ...metadata(), redirect_uris: [CALLBACK, 3] }, { ...metadata(), redirect_uris: ["https://claude.ai/callback#fragment"] }, { ...metadata(), redirect_uris: ["http://attacker.example.test/callback"] }, { ...metadata(), token_endpoint_auth_method: "client_secret_basic" }, { ...metadata(), grant_types: ["refresh_token"] }, { ...metadata(), grant_types: ["authorization_code", 3] }, { ...metadata(), grant_types: ["authorization_code", " "] }, { ...metadata(), response_types: ["token"] }, { ...metadata(), response_types: ["code", ""] }, { ...metadata(), response_types: "code" }, { ...metadata(), client_name: 1 }];
    for (const body of invalid) await rejected(setup(() => documentResponse(body)).resolve(HOSTED, CALLBACK), "invalid_client");
  }],
  ["only registered redirect strings pass, without normalization bypasses", async () => {
    const fixture = setup();
    for (const redirect of ["https://claude.ai/another-callback", "https://claude.ai/synthetic-callback?fixture=two", "https://claude.ai:443/synthetic-callback?fixture=one", "https://claude.ai/path/../synthetic-callback?fixture=one", `${CALLBACK}#fragment`, "https://user:pass@claude.ai/synthetic-callback?fixture=one", "https://attacker.example.test/synthetic-callback?fixture=one"]) {
      await rejected(fixture.resolve(HOSTED, redirect), "invalid_redirect");
    }
    assert.equal(fixture.calls.length, 1);
  }],
  ["loopback clients may vary only a registered localhost or IPv4 port", async () => {
    const fixture = setup(() => documentResponse(metadata(LOCAL, [LOCAL_CALLBACK, "http://127.0.0.1/synthetic-callback"])));
    assert.deepEqual(await fixture.resolve(LOCAL, "http://localhost:43821/synthetic-callback?fixture=two"), { name: "Synthetic Connector", host: "claude.ai", metadataUrl: LOCAL });
    await fixture.resolve(LOCAL, "http://127.0.0.1:49382/synthetic-callback");
    for (const redirect of ["http://localhost:43821/another-callback?fixture=two", "http://localhost:43821/synthetic-callback?fixture=three", "http://localhost:43821/path/../synthetic-callback?fixture=two", "http://LOCALHOST:43821/synthetic-callback?fixture=two", "http://127.0.0.2:49382/synthetic-callback", "http://[::1]:49382/synthetic-callback", "http://localhost.attacker.example.test:43821/synthetic-callback?fixture=two", "http://localhost:99999/synthetic-callback?fixture=two"]) await rejected(fixture.resolve(LOCAL, redirect), "invalid_redirect");
  }],
  ["metadata must be JSON and fit the byte limit, even when streamed", async () => {
    const responses = [() => new Response("not-json", { headers: { "content-type": "application/json" } }), () => new Response(JSON.stringify(metadata()), { headers: { "content-type": "text/html" } }), () => documentResponse(metadata(), { "content-length": "5121" }), () => documentResponse({ ...metadata(), extra: "x".repeat(5120) }), () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(metadata()))); controller.enqueue(new Uint8Array(5120)); controller.close(); } }), { headers: { "content-type": "application/json" } })];
    for (const response of responses) await rejected(setup(response).resolve(HOSTED, CALLBACK), "invalid_client");
  }],
  ["network failures and rejected HTTP responses remain retryable and uncached", async () => {
    for (const failure of [() => Promise.reject(new Error("synthetic network failure")), () => new Response("unavailable", { status: 503 }), () => new Response(null, { status: 302, headers: { location: "https://attacker.example.test/metadata" } })]) {
      let attempts = 0;
      const fixture = setup(() => ++attempts === 1 ? failure() : documentResponse());
      await rejected(fixture.resolve(HOSTED, CALLBACK), "unavailable");
      await fixture.resolve(HOSTED, CALLBACK);
      assert.equal(fixture.calls.length, 2);
    }
  }],
  ["invalid metadata is not cached after a successful retry", async () => {
    let attempts = 0;
    const fixture = setup(() => documentResponse(++attempts === 1 ? { ...metadata(), client_id: LOCAL } : metadata()));
    await rejected(fixture.resolve(HOSTED, CALLBACK), "invalid_client");
    await fixture.resolve(HOSTED, CALLBACK);
    assert.equal(fixture.calls.length, 2);
  }],
  ["a failed body transfer is retryable instead of invalid client metadata", async () => {
    const response = () => new Response(new ReadableStream({ pull(controller) { controller.error(new TypeError("synthetic interrupted transfer")); } }), { headers: { "content-type": "application/json" } });
    await rejected(setup(response).resolve(HOSTED, CALLBACK), "unavailable");
  }],
  ["both response headers and body reads have a bounded timeout", async () => {
    const never = () => new Promise<Response>(() => {});
    const stalledBody = () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { headers: { "content-type": "application/json" } });
    for (const response of [never, stalledBody]) {
      const fixture = setup(response, 10);
      await rejected(fixture.resolve(HOSTED, CALLBACK), "unavailable");
      assert.equal(fixture.calls[0].init?.signal?.aborted, true);
    }
  }],
  ["no-store, no-cache and zero max-age force a fresh metadata check", async () => {
    for (const control of ["no-store", "public, no-cache", "max-age=0", "MAX-AGE=60, NO-STORE", "no-cache=\"client_name\""]) {
      const fixture = setup(() => documentResponse(metadata(), { "cache-control": control }));
      await fixture.resolve(HOSTED, CALLBACK);
      await fixture.resolve(HOSTED, CALLBACK);
      assert.equal(fixture.calls.length, 2, control);
    }
  }],
  ["cached metadata expires at max-age and honors its upstream age", async () => {
    for (const control of ["public, max-age=2", 'max-age="2"']) {
      const fixture = setup(() => documentResponse(metadata(), { "cache-control": control, age: "1" }));
      await fixture.resolve(HOSTED, CALLBACK);
      fixture.advance(999);
      await fixture.resolve(HOSTED, CALLBACK);
      assert.equal(fixture.calls.length, 1);
      fixture.advance(1);
      await fixture.resolve(HOSTED, CALLBACK);
      assert.equal(fixture.calls.length, 2);
    }
  }],
  ["long-lived metadata cannot outlive the local cache cap", async () => {
    const fixture = setup(() => documentResponse(metadata(), { "cache-control": "max-age=31536000" }));
    await fixture.resolve(HOSTED, CALLBACK);
    fixture.advance(300_000);
    await fixture.resolve(HOSTED, CALLBACK);
    assert.equal(fixture.calls.length, 2);
  }],
  ["malformed or ambiguous cache headers never hold metadata", async () => {
    for (const control of ['max-age="60', "max-age=60, max-age=1"]) {
      const fixture = setup(() => documentResponse(metadata(), { "cache-control": control }));
      await fixture.resolve(HOSTED, CALLBACK);
      await fixture.resolve(HOSTED, CALLBACK);
      assert.equal(fixture.calls.length, 2, control);
    }
  }],
];

async function main() {
  let failed = 0;
  for (const [name, run] of checks) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${name}:`, error instanceof Error ? error.message : error);
    }
  }
  console.log(`${checks.length - failed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

void main();
