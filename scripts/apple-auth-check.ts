import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { appleAuthorizeUrl, appleIdentityFromCode, isAppleConfigured, verifyAppleIdToken, type AppleSigningKey } from "../src/lib/maple/apple";

const NOW = Date.UTC(2026, 9, 28, 12);
const SEC = Math.floor(NOW / 1000);
const SITE = "https://maple.example";
const AUD = "app.maple.web";
const NONCE = "random-browser-bound-nonce";
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const env = {
  APPLE_CLIENT_ID: AUD,
  APPLE_TEAM_ID: "EXAMPLE123",
  APPLE_KEY_ID: "KEY1234567",
  APPLE_PRIVATE_KEY: ec.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
};
const jwk: AppleSigningKey = { ...rsa.publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const base = { iss: "https://appleid.apple.com", aud: AUD, sub: "001.example.subject", iat: SEC, exp: SEC + 300, nonce: NONCE, email: "Parent@Example.com", email_verified: true };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(claims: Record<string, unknown> = base, header: Record<string, unknown> = { alg: "RS256", kid: jwk.kid }, key = rsa.privateKey): string {
  const input = `${encode(header)}.${encode(claims)}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
}
const checkToken = (jwt: string, keys = [jwk]) => verifyAppleIdToken(jwt, { audience: AUD, nonce: NONCE, keys, now: NOW });
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok ${name}`);
}

async function main() {
  await check("valid signatures return normalized verified identity", () => {
    assert.deepEqual(checkToken(token()), { subject: base.sub, email: "parent@example.com", name: null });
    assert.deepEqual(checkToken(token({ ...base, email_verified: "true" })), { subject: base.sub, email: "parent@example.com", name: null });
  });
  await check("a later sign-in without email still returns the stable subject", () => {
    const { email: _email, email_verified: _verified, ...claims } = base;
    assert.deepEqual(checkToken(token(claims)), { subject: base.sub, email: null, name: null });
  });
  await check("unverified or malformed email cannot become an account identifier", () => {
    for (const value of [false, "false", undefined, 1]) assert.equal(checkToken(token({ ...base, email_verified: value })), null);
    for (const email of ["", null, 123, "admin", "x\n@example.com"]) assert.equal(checkToken(token({ ...base, email })), null);
  });
  await check("issuer, audience, expiry, issued-at, not-before and nonce are enforced", () => {
    for (const claims of [
      { iss: "https://evil.example" }, { aud: "different-client" }, { aud: [AUD, "other"] },
      { exp: SEC }, { exp: SEC - 1 }, { exp: String(SEC + 10) }, { exp: undefined },
      { iat: SEC + 61 }, { iat: undefined }, { iat: SEC + 301 },
      { nbf: SEC + 61 }, { nonce: "wrong" }, { nonce: undefined }, { nonce: NONCE + "a" },
      { sub: "" }, { sub: undefined }, { sub: 123 },
    ]) assert.equal(checkToken(token({ ...base, ...claims })), null, JSON.stringify(claims));
  });
  await check("wrong signatures, tampering, missing keys and algorithm confusion fail closed", () => {
    assert.equal(checkToken(token(base, undefined, other.privateKey)), null);
    assert.equal(checkToken(token().replace(encode(base), encode({ ...base, sub: "attacker" }))), null);
    assert.equal(checkToken(token(), []), null);
    assert.equal(checkToken(token(), [jwk, jwk]), null);
    for (const header of [{ alg: "none", kid: jwk.kid }, { alg: "HS256", kid: jwk.kid }, { alg: "RS256", kid: "missing" }, { alg: "RS256", kid: jwk.kid, crit: ["b64"] }]) {
      assert.equal(checkToken(token(base, header)), null);
    }
    assert.equal(checkToken(token(), [{ ...jwk, use: "enc" }]), null);
    assert.equal(checkToken(token(), [{ ...jwk, alg: "RS512" }]), null);
  });
  await check("malformed and oversized tokens never throw", () => {
    for (const jwt of ["", "a.b.c", "e30.e30.", "a".repeat(20_000), token() + ".extra", token() + "="]) assert.equal(checkToken(jwt), null);
  });
  await check("Apple config is complete and contains a P-256 signing key", () => {
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    try {
      Object.assign(process.env, env);
      assert.equal(isAppleConfigured(), true);
      process.env.APPLE_PRIVATE_KEY = env.APPLE_PRIVATE_KEY.replace(/\n/g, "\\n");
      assert.equal(isAppleConfigured(), true);
      const url = new URL(appleAuthorizeUrl("random-state", NONCE, SITE));
      assert.equal(url.origin, "https://appleid.apple.com");
      assert.equal(url.pathname, "/auth/authorize");
      assert.equal(url.searchParams.get("client_id"), AUD);
      assert.equal(url.searchParams.get("nonce"), NONCE);
      assert.equal(url.searchParams.get("state"), "random-state");
      assert.equal(url.searchParams.get("scope"), "name email");
      assert.equal(url.searchParams.get("response_type"), "code");
      assert.equal(url.searchParams.get("response_mode"), "form_post");
      assert.equal(url.searchParams.get("redirect_uri"), `${SITE}/api/maple/auth/apple/callback`);
      assert.throws(() => appleAuthorizeUrl("state", NONCE, `${SITE}/unexpected`));
      process.env.APPLE_PRIVATE_KEY = rsa.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      assert.equal(isAppleConfigured(), false);
      process.env.APPLE_PRIVATE_KEY = "malformed";
      assert.equal(isAppleConfigured(), false);
      delete process.env.APPLE_KEY_ID;
      assert.equal(isAppleConfigured(), false);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  await check("code exchange sends a valid short-lived ES256 client secret and verifies Apple's key", async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push(url);
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      assert.ok(init?.signal);
      if (url.endsWith("/auth/token")) {
        assert.equal(init?.method, "POST");
        const form = new URLSearchParams(String(init?.body));
        assert.equal(form.get("code"), "one-time-code");
        assert.equal(form.get("grant_type"), "authorization_code");
        assert.equal(form.get("client_id"), AUD);
        assert.equal(form.get("redirect_uri"), `${SITE}/api/maple/auth/apple/callback`);
        const secret = form.get("client_secret")!.split(".");
        assert.deepEqual(JSON.parse(Buffer.from(secret[0], "base64url").toString()), { alg: "ES256", kid: env.APPLE_KEY_ID });
        assert.deepEqual(JSON.parse(Buffer.from(secret[1], "base64url").toString()), { iss: env.APPLE_TEAM_ID, iat: SEC, exp: SEC + 300, aud: "https://appleid.apple.com", sub: AUD });
        assert.equal(verify("sha256", Buffer.from(secret.slice(0, 2).join(".")), { key: ec.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(secret[2], "base64url")), true);
        return Response.json({ id_token: token(), access_token: "unused", refresh_token: "unused" });
      }
      assert.equal(url, "https://appleid.apple.com/auth/keys");
      return Response.json({ keys: [jwk] });
    };
    assert.deepEqual(await appleIdentityFromCode("one-time-code", NONCE, SITE, { env, fetch: fetcher, now: () => NOW }), { subject: base.sub, email: "parent@example.com", name: null });
    assert.deepEqual(requests, ["https://appleid.apple.com/auth/token", "https://appleid.apple.com/auth/keys"]);
  });
  await check("provider errors, missing tokens, malformed JSON and oversized responses return null", async () => {
    const responses = [
      new Response("error", { status: 400 }), Response.json({ error: "invalid_grant" }),
      new Response("not json"), Response.json({ id_token: "a.b.c" }),
      new Response("x".repeat(140_000)),
    ];
    for (const response of responses) {
      assert.equal(await appleIdentityFromCode("code", NONCE, SITE, { env, now: () => NOW, fetch: async () => response }), null);
    }
    assert.equal(await appleIdentityFromCode("code", NONCE, SITE, { env, fetch: async () => { throw new Error("provider_unavailable"); } }), null);
    assert.equal(await appleIdentityFromCode("code", NONCE, SITE, { env: {} }), null);
    assert.equal(await appleIdentityFromCode("", NONCE, SITE, { env }), null);
  });
  console.log(`\n${passed} Apple auth checks passed`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
