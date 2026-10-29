import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET as authorize } from "../src/app/oauth/authorize/route";
import { GET as discovery } from "../src/app/.well-known/oauth-authorization-server/route";

delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.DATABASE_URL;

const CLIENT = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const ORIGIN = "https://maple.example.test";
const originalFetch = globalThis.fetch;
const failures: string[] = [];
let calls = 0;
let metadata: Record<string, unknown> = {};
let fetchFails = false;

globalThis.fetch = async (input) => {
  calls++;
  assert.equal(String(input), CLIENT, "only the allowlisted identity may be fetched");
  if (fetchFails) throw new Error("Synthetic metadata outage");
  return Response.json(metadata, { headers: { "Cache-Control": "no-store" } });
};

function request(overrides: Record<string, string> = {}) {
  const params = new URLSearchParams({
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
    resource: `${ORIGIN}/api/maple/mcp`,
    ...overrides,
  });
  return new NextRequest(`${ORIGIN}/oauth/authorize?${params}`);
}

async function test(name: string, run: () => Promise<void>) {
  calls = 0;
  fetchFails = false;
  metadata = { client_id: CLIENT, client_name: "Synthetic connector", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" };
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

async function localError(req: NextRequest, status: number) {
  const response = await authorize(req);
  assert.equal(response.status, status);
  assert.equal(response.headers.get("location"), null, "unverified clients never receive a redirect");
  assert.equal(response.headers.get("cache-control"), "no-store");
}

async function main() {
  await test("discovery enables CIMD and advertises only enforced PKCE", async () => {
    const response = await discovery(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
    const data = await response.json();
    assert.equal(data.client_id_metadata_document_supported, true);
    assert.deepEqual(data.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(data.token_endpoint_auth_methods_supported, ["none"]);
    assert.equal(data.registration_endpoint, `${ORIGIN}/oauth/register`);
  });
  await test("authorization uses the fetched client identity", async () => {
    const response = await authorize(request());
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Synthetic connector/);
    assert.equal(calls, 1);
  });
  await test("discovery advertises issuer-bound callbacks", async () => {
    const response = await discovery(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
    assert.equal((await response.json()).authorization_response_iss_parameter_supported, true);
  });
  await test("every redirected authorization error identifies its issuer", async () => {
    const cases: Record<string, string>[] = [{ response_type: "token" }, { code_challenge_method: "plain" }, { resource: `${ORIGIN}/other` }];
    for (const overrides of cases) {
      const response = await authorize(request(overrides));
      assert.equal(response.status, 302);
      const callback = new URL(response.headers.get("location")!);
      assert.equal(callback.searchParams.get("iss"), ORIGIN);
      assert.ok(callback.searchParams.get("error"));
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    }
  });
  await test("unregistered callback fails before redirecting a protocol error", async () => {
    await localError(request({ redirect_uri: "https://claude.ai/not-registered", response_type: "token" }), 400);
    assert.equal(calls, 1);
  });
  await test("mismatched metadata identity fails locally", async () => {
    metadata.client_id = "https://other.example.test/client";
    await localError(request(), 400);
  });
  await test("unavailable metadata fails closed and can be retried", async () => {
    fetchFails = true;
    await localError(request(), 503);
    fetchFails = false;
    const retry = await authorize(request());
    assert.equal(retry.status, 200);
    assert.equal(calls, 2);
  });
  await test("unknown URL identities never become legacy clients", async () => {
    await localError(request({ client_id: "https://other.example.test/client" }), 400);
    assert.equal(calls, 0);
  });
  globalThis.fetch = originalFetch;
  if (failures.length) throw new Error(`${failures.length} OAuth route checks failed`);
}

main().catch(error => {
  globalThis.fetch = originalFetch;
  console.error(error);
  process.exitCode = 1;
});
