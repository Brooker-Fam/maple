import { deepStrictEqual as eq, rejects } from "node:assert";
import { NextRequest, NextResponse } from "next/server";
import { POST as previewRoute } from "../../src/app/api/maple/admin/waitlist/preview/route";
import { POST as sendRoute } from "../../src/app/api/maple/admin/waitlist/send/route";
import { grantMetricsAccess } from "../../src/lib/maple/admin/auth";
import { sealAdminRef } from "../../src/lib/maple/admin/refs";
import { previewWaitlistEmail, sendWaitlistEmail, WaitlistEmailError, type WaitlistEmailDeps } from "../../src/lib/maple/admin/waitlist-email";
import { SESSION_COOKIE, sealSession } from "../../src/lib/maple/auth";
import type { EmailPayload, Transport } from "../../src/lib/email/send";
import { encryptSecret, openSecret } from "../../src/lib/secret-box";
import { done, freshDb, ok, seedFamilies, sql, test } from "./harness";

process.env.MAPLE_SESSION_SECRET = "synthetic-waitlist-current-key";
process.env.MCP_SECRET = "synthetic-waitlist-mcp-key";
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_EMAIL_DOMAIN;

const ENV = { RESEND_API_KEY: "synthetic-resend-key", RESEND_EMAIL_DOMAIN: "example.test" };
const NOW = new Date("2026-10-28T15:00:00Z");
let sequence = 0;

function delivery() {
  const sent: Array<{ payload: EmailPayload; options: { idempotencyKey?: string } }> = [];
  const transport: Transport = async (payload, options) => {
    sent.push({ payload, options });
    return { data: { id: `synthetic-provider-${sent.length}` }, error: null };
  };
  const deps: WaitlistEmailDeps = { email: { env: ENV, transport: () => transport, report: () => {} }, signupMode: async () => "open", now: () => NOW };
  return { sent, deps };
}

async function waiting(email = `waiting-${++sequence}@example.test`) {
  const [row] = await sql(`INSERT INTO maple_waitlist (email) VALUES ($1) RETURNING id`, [email]);
  const id = Number(row.id);
  return { id, email, ref: sealAdminRef({ kind: "waitlist", id }) };
}

async function expectCode(work: Promise<unknown>, code: string) {
  await rejects(work, (error: unknown) => error instanceof WaitlistEmailError && error.code === code);
}

async function actions() {
  await freshDb({ shape: "final", migrations: 2 });
  const { beta } = await seedFamilies();

  await test("preview has masked recipient and exact immutable message, and creates no send claim", async () => {
    const entry = await waiting();
    const { deps, sent } = delivery();
    const preview = await previewWaitlistEmail(entry.ref, deps);
    eq(preview.canSend, true);
    eq(preview.reason, null);
    eq(preview.from, "Maple <hello@example.test>");
    eq(preview.subject, "Maple is ready for your family");
    ok(preview.text.includes("https://maplebaby.app/signup"), "public signup link");
    ok(preview.text.includes("waitlist") && preview.text.includes("removed") && preview.text.includes("hello@maplebaby.app"), "why recipient hears and removal contact");
    ok(!JSON.stringify(preview).includes(entry.email), "no plaintext recipient in response");
    eq(sent.length, 0);
    eq(Number((await sql(`SELECT COUNT(*) AS n FROM maple_waitlist_outreach`))[0].n), 0);
  });

  await test("explicit send delivers exactly the preview and repeats do not send again", async () => {
    const entry = await waiting();
    const { deps, sent } = delivery();
    const preview = await previewWaitlistEmail(entry.ref, deps);
    const result = await sendWaitlistEmail(preview.sendToken, deps);
    eq(result, { status: "sent", sentAt: NOW.toISOString() });
    eq(sent.length, 1);
    eq(sent[0].payload.to, entry.email);
    eq(sent[0].payload.subject, preview.subject);
    eq(sent[0].payload.text, preview.text);
    eq(sent[0].payload.from, preview.from);
    eq(sent[0].payload.replyTo, preview.replyTo);
    ok(!sent[0].payload.html.includes("<img") && !sent[0].payload.html.includes(entry.email), "no tracking or email in HTML");
    eq(sent[0].options.idempotencyKey, `maple-launch-v1/${entry.id}`);
    eq(await sendWaitlistEmail(preview.sendToken, deps), { status: "already_sent", sentAt: NOW.toISOString() });
    eq(sent.length, 1);
    eq((await previewWaitlistEmail(entry.ref, deps)).reason, "already_sent");
  });

  await test("concurrent sends share a durable claim and call the provider once", async () => {
    const entry = await waiting();
    const { deps, sent } = delivery();
    const preview = await previewWaitlistEmail(entry.ref, deps);
    const results = await Promise.all([sendWaitlistEmail(preview.sendToken, deps), sendWaitlistEmail(preview.sendToken, deps)]);
    eq(sent.length, 1);
    eq(results.filter((r) => r.status === "sent").length, 1);
    ok(results.some((r) => r.status === "already_sent" || r.status === "send_pending"), "second request is not another send");
  });

  await test("a changed recipient, deleted recipient, changed sender or expired preview never sends", async () => {
    const { deps, sent } = delivery();
    const changed = await waiting();
    const changedPreview = await previewWaitlistEmail(changed.ref, deps);
    await sql(`UPDATE maple_waitlist SET email = 'changed-address@example.test' WHERE id = $1`, [changed.id]);
    await expectCode(sendWaitlistEmail(changedPreview.sendToken, deps), "recipient_changed");
    const gone = await waiting();
    const gonePreview = await previewWaitlistEmail(gone.ref, deps);
    await sql(`DELETE FROM maple_waitlist WHERE id = $1`, [gone.id]);
    await expectCode(sendWaitlistEmail(gonePreview.sendToken, deps), "recipient_missing");
    const stale = await waiting();
    const preview = await previewWaitlistEmail(stale.ref, deps);
    await expectCode(sendWaitlistEmail(preview.sendToken, { ...deps, email: { ...deps.email, env: { ...ENV, RESEND_EMAIL_DOMAIN: "other.test" } } }), "preview_expired");
    await expectCode(sendWaitlistEmail(preview.sendToken, { ...deps, now: () => new Date(NOW.getTime() + 600_001) }), "preview_expired");
    await expectCode(sendWaitlistEmail("tampered", deps), "preview_expired");
    eq(sent.length, 0);
  });

  await test("wrong-purpose and previous-key send tokens cannot authorize delivery", async () => {
    const entry = await waiting();
    const { deps, sent } = delivery();
    await expectCode(sendWaitlistEmail(entry.ref, deps), "preview_expired");
    const preview = await previewWaitlistEmail(entry.ref, deps);
    const intent = JSON.parse(openSecret(preview.sendToken!).text);
    const current = process.env.MAPLE_SESSION_SECRET!;
    let previousToken: string;
    try {
      process.env.MAPLE_SESSION_SECRET = "synthetic-previous-key";
      previousToken = encryptSecret(JSON.stringify(intent));
    } finally { process.env.MAPLE_SESSION_SECRET = current; }
    process.env.MAPLE_SESSION_SECRET_PREV = "synthetic-previous-key";
    try { await expectCode(sendWaitlistEmail(previousToken, deps), "preview_expired"); }
    finally { delete process.env.MAPLE_SESSION_SECRET_PREV; }
    eq(sent.length, 0);
  });

  await test("current signup and mail configuration are checked again when sending", async () => {
    const entry = await waiting();
    const { deps, sent } = delivery();
    const preview = await previewWaitlistEmail(entry.ref, deps);
    const closed: WaitlistEmailDeps = { ...deps, signupMode: async () => "invite" };
    eq((await previewWaitlistEmail(entry.ref, closed)).reason, "signup_closed");
    await expectCode(sendWaitlistEmail(preview.sendToken, closed), "signup_closed");
    const off = { ...deps, email: { ...deps.email, env: {} } };
    eq((await previewWaitlistEmail(entry.ref, off)).reason, "email_unavailable");
    await expectCode(sendWaitlistEmail(preview.sendToken, off), "email_unavailable");
    eq(sent.length, 0);
  });

  await test("existing accepted members and their verified aliases do not get a launch invite", async () => {
    const { deps, sent } = delivery();
    const member = await waiting(beta.owner);
    eq((await previewWaitlistEmail(member.ref, deps)).reason, "already_signed_up");
    const alias = await waiting();
    const preview = await previewWaitlistEmail(alias.ref, deps);
    await sql(`INSERT INTO maple_auth_identities (provider, subject, member_id) VALUES ('email', $1, $2)`, [alias.email, beta.owner]);
    eq((await previewWaitlistEmail(alias.ref, deps)).reason, "already_signed_up");
    await expectCode(sendWaitlistEmail(preview.sendToken, deps), "already_signed_up");
    eq(sent.length, 0);
  });

  await test("provider failure remains uncertain and cannot be resent after the idempotency window", async () => {
    const entry = await waiting();
    let calls = 0;
    const { deps } = delivery();
    deps.email!.transport = () => async () => { calls++; throw new Error("synthetic transport failure"); };
    const preview = await previewWaitlistEmail(entry.ref, deps);
    eq(await sendWaitlistEmail(preview.sendToken, deps), { status: "delivery_unknown", sentAt: null });
    eq(await sendWaitlistEmail(preview.sendToken, deps), { status: "delivery_unknown", sentAt: null });
    const later = { ...deps, now: () => new Date(NOW.getTime() + 2 * 86400_000) };
    const fresh = await previewWaitlistEmail(entry.ref, later);
    eq(fresh.reason, "delivery_unknown");
    eq(fresh.sendToken, null);
    eq(calls, 1);
  });

  await test("a provider timeout is uncertain and a stale in-flight claim is never retried", async () => {
    const entry = await waiting();
    const { deps } = delivery();
    deps.email!.transport = () => () => new Promise(() => {});
    deps.waitMs = 1;
    const preview = await previewWaitlistEmail(entry.ref, deps);
    eq((await sendWaitlistEmail(preview.sendToken, deps)).status, "delivery_unknown");
    await sql(`UPDATE maple_waitlist_outreach SET status = 'sending' WHERE waitlist_id = $1`, [entry.id]);
    eq((await previewWaitlistEmail(entry.ref, deps)).reason, "send_pending");
    eq((await previewWaitlistEmail(entry.ref, { ...deps, now: () => new Date(NOW.getTime() + 61_000) })).reason, "delivery_unknown");
  });

  await test("deleting a waitlist entry also removes its outreach tracking", async () => {
    const entry = await waiting();
    const { deps } = delivery();
    const preview = await previewWaitlistEmail(entry.ref, deps);
    await sendWaitlistEmail(preview.sendToken, deps);
    await sql(`DELETE FROM maple_waitlist WHERE id = $1`, [entry.id]);
    eq((await sql(`SELECT * FROM maple_waitlist_outreach WHERE waitlist_id = $1`, [entry.id])).length, 0);
  });
}

async function routes() {
  await freshDb({ shape: "final" });
  const { alpha } = await seedFamilies();
  const routeRequest = (path: string, cookie = "", origin = "http://localhost:3000", body: unknown = {}) => new NextRequest(`http://localhost:3000/api/maple/admin/waitlist/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify(body) });
  await test("preview and send routes refuse signed-out and ordinary family-owner requests", async () => {
    for (const [path, route] of [["preview", previewRoute], ["send", sendRoute]] as const) {
      eq((await route(routeRequest(path))).status, 401);
      const cookie = `${SESSION_COOKIE}=${encodeURIComponent(sealSession(alpha.owner, 1))}`;
      const response = await route(routeRequest(path, cookie));
      eq(response.status, 403);
      eq(response.headers.get("cache-control"), "no-store");
    }
  });

  const operator = process.env.MAPLE_METRICS_TEST_ACCOUNT;
  if (operator) await test("verified operator POST actions reject cross-origin and invalid content before reading or sending", async () => {
    await sql(`INSERT INTO maple_members (family_id, email, role, accepted_at) VALUES (1, $1, 'owner', NOW())`, [operator]);
    const res = NextResponse.json({});
    grantMetricsAccess(res, operator, operator);
    const proof = res.headers.get("set-cookie")!.split(";")[0];
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(sealSession(operator, 1))}; ${proof}`;
    for (const [path, route] of [["preview", previewRoute], ["send", sendRoute]] as const) {
      eq((await route(routeRequest(path, cookie, "https://elsewhere.example"))).status, 403);
      const invalid = routeRequest(path, cookie);
      invalid.headers.set("content-type", "text/plain");
      eq((await route(invalid)).status, 400);
    }
  });
}

async function main() { await actions(); await routes(); done("admin-email.check.ts"); }
void main().catch((error) => { console.error(error); process.exit(1); });
