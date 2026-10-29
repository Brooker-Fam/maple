import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "../src/app/oauth/token/route";
import { mintAuthCode, mintRefreshToken, verifyAccessToken, verifyRefreshToken } from "../src/lib/mcp/auth";

process.env.MCP_SECRET = "synthetic-oauth-token-check-signing-key";
process.env.ADMIN_PASS = "synthetic-oauth-token-check-password";
delete process.env.MCP_SECRET_PREV;
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.DATABASE_URL;

const ORIGIN = "https://maple.example.test";
const CLIENT = "https://chatgpt.com/oauth/client.json";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const VERIFIER = "synthetic-public-client-verifier-for-oauth-checks";
const GRANT = { sub: "admin", fam: 1, scope: "calendar", client_id: CLIENT, resource: `${ORIGIN}/api/mcp` };
const originalFetch = globalThis.fetch;
const failures: string[] = [];
let externalCalls = 0;

globalThis.fetch = async () => {
  externalCalls++;
  throw new Error("External requests are forbidden in OAuth token checks");
};

type GrantType = "authorization_code" | "refresh_token";
type TokenCase = {
  name: string;
  fields?: [string, string][];
  authorization?: string;
  json?: boolean;
};

const cases: TokenCase[] = [
  { name: "client assertion", fields: [["client_assertion", "synthetic.assertion.signature"]] },
  { name: "empty client assertion", fields: [["client_assertion", ""]] },
  { name: "assertion type", fields: [["client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"]] },
  { name: "empty assertion type", fields: [["client_assertion_type", ""]] },
  { name: "client secret", fields: [["client_secret", "synthetic-client-secret"]] },
  { name: "duplicate client secret", fields: [["client_secret", ""], ["client_secret", "synthetic-client-secret"]] },
  { name: "Basic authorization", authorization: `Basic ${Buffer.from("synthetic-client:synthetic-secret").toString("base64")}` },
  { name: "Bearer authorization", authorization: "Bearer synthetic-client-credential" },
  { name: "JSON client assertion", fields: [["client_assertion", "synthetic.assertion.signature"]], json: true },
  { name: "JSON client secret", fields: [["client_secret", "synthetic-client-secret"]], json: true },
];

function request(grantType: GrantType, test: TokenCase) {
  const params = new URLSearchParams({ grant_type: grantType, client_id: CLIENT, resource: GRANT.resource });
  if (grantType === "authorization_code") {
    params.set("code", mintAuthCode({
      ...GRANT,
      redirect_uri: REDIRECT,
      code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
      code_challenge_method: "S256",
    }));
    params.set("redirect_uri", REDIRECT);
    params.set("code_verifier", VERIFIER);
  } else {
    params.set("refresh_token", mintRefreshToken(GRANT));
  }
  for (const [key, value] of test.fields ?? []) params.append(key, value);
  return new NextRequest(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": test.json ? "application/json" : "application/x-www-form-urlencoded",
      ...(test.authorization ? { authorization: test.authorization } : {}),
    },
    body: test.json ? JSON.stringify(Object.fromEntries(params)) : params.toString(),
  });
}

async function check(grantType: GrantType, test: TokenCase) {
  const name = `${grantType} rejects ${test.name}`;
  try {
    for (const fields of [[], [["client_secret", ""]]] as [string, string][][]) {
      const valid = await POST(request(grantType, { name: "public client", fields, json: test.json }));
      assert.equal(valid.status, 200, "public clients may omit credentials or send an empty secret");
      const tokens = await valid.json();
      assert.equal(verifyAccessToken(tokens.access_token)?.client_id, CLIENT);
      assert.equal(verifyRefreshToken(tokens.refresh_token)?.client_id, CLIENT);
    }

    const rejected = await POST(request(grantType, test));
    assert.equal(rejected.status, 400, "unsupported client authentication must not issue tokens");
    assert.equal(rejected.headers.get("cache-control"), "no-store");
    const error = await rejected.json();
    assert.equal(error.error, "invalid_request");
    assert.equal(error.access_token, undefined);
    assert.equal(error.refresh_token, undefined);
    assert.equal(externalCalls, 0);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

async function main() {
  try {
    for (const grant of ["authorization_code", "refresh_token"] as const) {
      for (const test of cases) await check(grant, test);
    }
    if (failures.length) throw new Error(`${failures.length} OAuth token checks failed`);
    console.log(`${cases.length * 2} OAuth token checks passed`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
