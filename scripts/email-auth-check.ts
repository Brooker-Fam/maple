/** Email authentication checks use only an isolated in-memory database and a fake sender. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { query } from "../src/lib/db";
import type { Email } from "../src/lib/email/send";
import { migrateAuth } from "../src/lib/maple/auth-schema";
import { isEmailConfigured, startEmailChallenge, verifyEmailChallenge } from "../src/lib/maple/email-auth";

process.env.DATABASE_URL = "pglite:email-auth-check";
process.env.MAPLE_SESSION_SECRET = "email-auth-check-session-secret";
process.env.MCP_SECRET = "email-auth-check-rate-secret";
process.env.RESEND_API_KEY = "re_check_not_a_key";
process.env.RESEND_EMAIL_DOMAIN = "example.com";
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.MAPLE_EMAIL_AUTH_DAILY_MAX;

const messages: Email[] = [];
const send = async (message: Email) => { messages.push(message); return { sent: true as const, id: "test-message" }; };
const request = (ip = "192.0.2.1") => new Request("https://example.com/api/maple/auth/email/start", { headers: { "x-real-ip": ip } });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const wrong = (code: string) => code === "000000" ? "111111" : "000000";
let passed = 0;

async function check(name: string, test: () => unknown | Promise<unknown>) {
  await query("TRUNCATE maple_auth_challenges, upload_rate_limit");
  messages.length = 0;
  delete process.env.MAPLE_EMAIL_AUTH_DAILY_MAX;
  await test();
  passed++;
  console.log(`PASS ${name}`);
}

async function issue(email = "parent@example.com", context: unknown = { mode: "signin" }, ip = "192.0.2.1") {
  const out = await startEmailChallenge(request(ip), email, context, { send });
  assert.equal(out.ok, true, "challenge starts");
  if (!out.ok) throw new Error("challenge did not start");
  const code = messages[messages.length - 1].text.match(/\b\d{6}\b/)?.[0];
  assert.ok(code, "email contains a six-digit code");
  return { token: out.token, code };
}

async function main() {
  await query(`CREATE TABLE upload_rate_limit (ip_hash VARCHAR(64) NOT NULL, window_start TIMESTAMP NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ip_hash, window_start))`);
  await migrateAuth();
  await migrateAuth();

  await check("configuration needs an email transport and a session secret", () => {
    assert.equal(isEmailConfigured(), true);
    const key = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    assert.equal(isEmailConfigured(), false);
    process.env.RESEND_API_KEY = key;
    const session = process.env.MAPLE_SESSION_SECRET;
    const google = process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.MAPLE_SESSION_SECRET;
    delete process.env.GOOGLE_CLIENT_SECRET;
    assert.equal(isEmailConfigured(), false);
    process.env.MAPLE_SESSION_SECRET = session;
    if (google) process.env.GOOGLE_CLIENT_SECRET = google;
  });

  await check("codes prove normalized email possession and preserve only sealed context", async () => {
    const context = { mode: "signup", invitation: "example-only-token", terms: "test" };
    const { token, code } = await issue(" Parent@Example.com ", context);
    const rows = await query("SELECT * FROM maple_auth_challenges");
    assert.equal(rows?.length, 1);
    const stored = JSON.stringify(rows);
    assert.ok(!stored.includes("parent@example.com"), "no plaintext address in challenges");
    assert.ok(!stored.includes(token), "no raw browser token in challenges");
    assert.notEqual(rows?.[0]?.code_hash, code, "not a plaintext code");
    assert.ok(!stored.includes("example-only-token"), "no plaintext intent");
    assert.deepEqual(await verifyEmailChallenge(token, code), { ok: true, email: "parent@example.com", context });
    assert.equal((await verifyEmailChallenge(token, code)).ok, false, "code works once");
  });

  await check("a code is bound to its browser challenge", async () => {
    const first = await issue();
    const second = await issue("other@example.com");
    // A coincidental equal code is possible; bind the second stored digest to an impossible value.
    await query("UPDATE maple_auth_challenges SET code_hash = $2 WHERE token_hash = $1", [sha(second.token), "f".repeat(64)]);
    assert.equal((await verifyEmailChallenge(second.token, first.code)).ok, false);
    assert.equal((await verifyEmailChallenge(first.token, first.code)).ok, true);
  });

  await check("expired challenges and invalid tokens fail closed", async () => {
    const { token, code } = await issue();
    await query("UPDATE maple_auth_challenges SET expires_at = NOW() - INTERVAL '1 second'");
    assert.equal((await verifyEmailChallenge(token, code)).ok, false);
    assert.equal((await verifyEmailChallenge("not-a-token", code)).ok, false);
    assert.equal((await verifyEmailChallenge(token, "12345")).ok, false);
  });

  await check("five wrong attempts exhaust the code", async () => {
    const { token, code } = await issue();
    for (let i = 0; i < 5; i++) assert.equal((await verifyEmailChallenge(token, wrong(code))).ok, false);
    assert.equal((await verifyEmailChallenge(token, code)).ok, false);
    const rows = await query("SELECT attempts FROM maple_auth_challenges");
    assert.equal(rows?.[0]?.attempts, 5);
  });

  await check("a correct fifth attempt works and is consumed", async () => {
    const { token, code } = await issue();
    for (let i = 0; i < 4; i++) await verifyEmailChallenge(token, wrong(code));
    assert.equal((await verifyEmailChallenge(token, code)).ok, true);
    assert.equal((await verifyEmailChallenge(token, code)).ok, false);
  });

  await check("concurrent attempts cannot exceed the limit", async () => {
    const { token, code } = await issue();
    const attempts = await Promise.all(Array.from({ length: 10 }, () => verifyEmailChallenge(token, wrong(code))));
    assert.equal(attempts.some((result) => result.ok), false);
    assert.equal((await query("SELECT attempts FROM maple_auth_challenges"))?.[0]?.attempts, 5);
    assert.equal((await verifyEmailChallenge(token, code)).ok, false);
  });

  await check("concurrent correct requests have exactly one winner", async () => {
    const { token, code } = await issue();
    const attempts = await Promise.all(Array.from({ length: 8 }, () => verifyEmailChallenge(token, code)));
    assert.equal(attempts.filter((result) => result.ok).length, 1);
  });

  await check("resends cool down without invalidating a delivered code", async () => {
    const { token, code } = await issue();
    const retry = await startEmailChallenge(request("192.0.2.2"), "parent@example.com", {}, { send });
    assert.equal(retry.ok, false);
    if (!retry.ok) assert.equal(retry.status, 429);
    assert.equal(messages.length, 1);
    assert.equal((await verifyEmailChallenge(token, code)).ok, true);
  });

  await check("concurrent starts for one address send only one email", async () => {
    const starts = await Promise.all(Array.from({ length: 4 }, (_, i) => startEmailChallenge(request(`192.0.2.${i + 1}`), "parent@example.com", {}, { send })));
    assert.equal(starts.filter((out) => out.ok).length, 1);
    assert.equal(messages.length, 1);
  });

  await check("the hourly address cap survives code expiration and connection changes", async () => {
    for (let i = 0; i < 5; i++) {
      await issue("parent@example.com", {}, `192.0.2.${i + 1}`);
      await query("UPDATE maple_auth_challenges SET created_at = NOW() - INTERVAL '11 minutes', expires_at = NOW() - INTERVAL '1 minute'");
    }
    const next = await startEmailChallenge(request("192.0.2.77"), "parent@example.com", {}, { send });
    assert.equal(next.ok, false);
    assert.equal(messages.length, 5);
  });

  await check("the connection cap bounds attempts across addresses", async () => {
    for (let i = 0; i < 20; i++) await issue(`parent${i}@example.com`);
    const next = await startEmailChallenge(request(), "new@example.com", {}, { send });
    assert.equal(next.ok, false);
    assert.equal(messages.length, 20);
  });

  await check("the daily ceiling bounds sends across addresses and connections", async () => {
    process.env.MAPLE_EMAIL_AUTH_DAILY_MAX = "2";
    await issue("one@example.com", {}, "192.0.2.1");
    await issue("two@example.com", {}, "192.0.2.2");
    const next = await startEmailChallenge(request("192.0.2.3"), "three@example.com", {}, { send });
    assert.equal(next.ok, false);
    assert.equal(messages.length, 2);
  });

  await check("a delivery failure invalidates the challenge", async () => {
    const out = await startEmailChallenge(request(), "parent@example.com", {}, { send: async () => ({ sent: false as const, reason: "failed" as const }) });
    assert.equal(out.ok, false);
    const rows = await query("SELECT consumed_at, sealed_payload FROM maple_auth_challenges");
    assert.ok(rows?.[0]?.consumed_at);
    assert.equal(rows?.[0]?.sealed_payload, "");
  });

  await check("a thrown sender error cannot leave an active challenge", async () => {
    const out = await startEmailChallenge(request(), "parent@example.com", {}, { send: async () => { throw new Error("mock provider failure"); } });
    assert.equal(out.ok, false);
    assert.ok((await query("SELECT consumed_at FROM maple_auth_challenges"))?.[0]?.consumed_at);
  });

  await check("a missing database never sends a code or verifies one", async () => {
    const { token, code } = await issue();
    const url = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      assert.equal((await startEmailChallenge(request(), "other@example.com", {}, { send })).ok, false);
      assert.equal((await verifyEmailChallenge(token, code)).ok, false);
      assert.equal(messages.length, 1);
    } finally {
      process.env.DATABASE_URL = url;
    }
  });

  await check("invalid addresses never send email", async () => {
    for (const email of ["not-email", "admin", "invite:123", "parent@example.com\r\nBcc:other@example.com"]) {
      assert.equal((await startEmailChallenge(request(), email, {}, { send })).ok, false);
    }
    assert.equal(messages.length, 0);
  });

  console.log(`\nEmail auth: ${passed} checks passed.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Email auth check failed");
  process.exitCode = 1;
});
