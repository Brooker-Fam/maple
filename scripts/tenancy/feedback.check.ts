/** Feedback for the person who makes Maple against synthetic Postgres: the store, its caps, Today's question, the email, the route and the chat's tool. */
import { NextRequest } from "next/server";
import { GET, POST } from "../../src/app/api/maple/feedback/route";
import { leaveFamily, removeMember, sealSession, SESSION_COOKIE } from "../../src/lib/maple/auth";
import { feedbackTool, FEEDBACK_SENT } from "../../src/lib/maple/chat/feedback-tools";
import { chatTools, TOOL_APPROVAL } from "../../src/lib/maple/chat/tools";
import type { ChatToolOutput } from "../../src/lib/maple/chat/types";
import {
  ASK_MIN_ENTRIES,
  cleanMessage,
  emailFeedback,
  FEEDBACK_EMAILS_PER_DAY,
  FEEDBACK_PER_DAY,
  feedbackAsk,
  feedbackEmail,
  FeedbackRefused,
  parseFeedback,
  saveFeedback,
  sendFeedback,
  snoozeFeedbackAsk,
} from "../../src/lib/maple/feedback/store";
import { FEEDBACK_MAX_CHARS, feedbackDestination, replyableMember } from "../../src/lib/maple/feedback/types";
import { FAMILY_ONE_COPY } from "../../src/lib/maple/mcp-tools";
import type { Email, EmailResult } from "../../src/lib/email/send";
import { done, eq, freshDb, ok, seedFamilies, sql, test, type FamilySeed } from "./harness";

process.env.MCP_SECRET = "made-up-feedback-mcp-secret";
process.env.MAPLE_SESSION_SECRET = "made-up-feedback-session-secret";
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.RESEND_API_KEY;

function refusal(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof FeedbackRefused ? error.code : `threw ${String(error)}`;
  }
}

async function refusedAsync(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof FeedbackRefused ? error.code : `threw ${String(error)}`;
  }
}

/** A stand-in Resend: records what would have gone out. */
function outbox(result: EmailResult = { sent: true, id: "made-up-email-id" }) {
  const sent: Email[] = [];
  return { sent, send: async (email: Email) => { sent.push(email); return result; } };
}

async function route(method: "GET" | "POST", email: string, familyId: number, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const request = new NextRequest("http://localhost:3000/api/maple/feedback", {
    method,
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealSession(email, familyId))}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await (method === "GET" ? GET(request) : POST(request));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** Enough log, and members who joined long enough ago, for Today's question. */
async function settle(family: FamilySeed) {
  await sql(`UPDATE maple_members SET accepted_at = NOW() - INTERVAL '5 days' WHERE family_id = $1`, [family.familyId]);
  await sql(
    `INSERT INTO maple_entries (family_id, baby_id, kind, started_at, data, created_by)
     SELECT $1, $2, 'diaper', NOW() - n * INTERVAL '1 hour', '{"pee":true}', $3 FROM generate_series(1, $4) AS n`,
    [family.familyId, family.babyId, family.owner, ASK_MIN_ENTRIES]
  );
}

async function main() {
  await test("messages are cleaned, bounded and checked; only Today's question takes a rating", () => {
    eq(cleanMessage("  The timer\r\nreset\u0007 itself.\n\n\n\nTwice.‮  "), "The timer\nreset itself.\n\nTwice.");
    eq(cleanMessage("   \n "), null);
    eq(cleanMessage(null), null);
    eq(refusal(() => cleanMessage(42)), "invalid");
    eq(refusal(() => cleanMessage("x".repeat(FEEDBACK_MAX_CHARS + 1))), "too_long");
    eq(cleanMessage("x".repeat(FEEDBACK_MAX_CHARS))?.length, FEEDBACK_MAX_CHARS);
    eq(parseFeedback({ message: "Love the night look", topic: "praise" }, "app"), { via: "app", message: "Love the night look", topic: "praise", rating: null });
    eq(parseFeedback({ rating: "okay" }, "prompt"), { via: "prompt", message: null, topic: null, rating: "okay" });
    eq(refusal(() => parseFeedback({ message: "  " }, "app")), "empty");
    eq(refusal(() => parseFeedback({ rating: "well" }, "app")), "invalid");
    eq(refusal(() => parseFeedback({ message: "hi", topic: "rant" }, "chat")), "invalid");
    eq(refusal(() => parseFeedback({ rating: "great" }, "prompt")), "invalid");
  });

  await test("who can be replied to: real addresses, never the shared admin login or invite-link guests", () => {
    eq([replyableMember("emery.beta@example.com"), replyableMember("admin"), replyableMember("invite:12"), replyableMember("no-at-sign")], [true, false, false, false]);
    ok(feedbackDestination(true).includes("email address") && !feedbackDestination(false).includes("email"), "the card says whether the address goes");
  });

  await freshDb();
  const { alpha, beta } = await seedFamilies();

  await test("schema: family-keyed tables that go with their family", async () => {
    const cols = await sql(`SELECT table_name, is_nullable FROM information_schema.columns WHERE column_name = 'family_id' AND table_name IN ('maple_feedback', 'maple_feedback_asks') ORDER BY 1`);
    eq(cols, [{ table_name: "maple_feedback", is_nullable: "NO" }, { table_name: "maple_feedback_asks", is_nullable: "NO" }]);
  });

  await test("saving keeps who sent it, their role and where from, and never more than the day's cap per person", async () => {
    const saved = await saveFeedback({ familyId: beta.familyId }, { email: beta.member, role: "member" }, parseFeedback({ message: "The diaper button is hard to find", topic: "problem" }, "app"));
    eq([saved.familyId, saved.member, saved.role, saved.via, saved.topic, saved.message], [beta.familyId, beta.member, "member", "app", "problem", "The diaper button is hard to find"]);
    for (let i = 1; i < FEEDBACK_PER_DAY; i++) await saveFeedback({ familyId: beta.familyId }, { email: beta.member, role: "member" }, parseFeedback({ message: `Note ${i}` }, "app"));
    eq(await refusedAsync(() => saveFeedback({ familyId: beta.familyId }, { email: beta.member, role: "member" }, parseFeedback({ message: "One too many" }, "app"))), "limit");
    // Another person, or the same person in another family, has their own day.
    await saveFeedback({ familyId: beta.familyId }, { email: beta.owner, role: "owner" }, parseFeedback({ message: "Works well" }, "chat"));
    await saveFeedback({ familyId: alpha.familyId }, { email: beta.member, role: "member" }, parseFeedback({ message: "From the other log" }, "app"));
    eq(Number((await sql(`SELECT COUNT(*)::int AS n FROM maple_feedback WHERE family_id = $1 AND member = $2`, [beta.familyId, beta.member]))[0].n), FEEDBACK_PER_DAY);
    // A day later the cap has room again.
    await sql(`UPDATE maple_feedback SET created_at = created_at - INTERVAL '25 hours' WHERE member = $1`, [beta.member]);
    await saveFeedback({ familyId: beta.familyId }, { email: beta.member, role: "member" }, parseFeedback({ message: "Next day" }, "app"));
  });

  await sql(`DELETE FROM maple_feedback`);

  await test("the email: to the operator inbox, reply-to the sender, keyed by the row, with no names", async () => {
    const saved = await saveFeedback({ familyId: beta.familyId }, { email: beta.owner, role: "owner" }, parseFeedback({ message: "Could the chat\nremember my\npump times?", topic: "idea" }, "chat"));
    const email = feedbackEmail(saved);
    eq([email.to, email.replyTo, email.kind, email.idempotencyKey], ["hello@maplebaby.app", beta.owner, "feedback", `feedback/${saved.id}`]);
    eq(email.subject, `Maple feedback from family ${beta.familyId}: idea`);
    ok(email.text.includes("Could the chat\nremember my\npump times?") && email.text.includes("an owner of family 2") && email.text.includes("the chat"), email.text);
    ok(email.html.includes("Could the chat<br>remember my<br>pump times?"), "html keeps the lines");
    for (const word of [beta.babyName, "Rowan", "Emery", "Family Beta"]) ok(!email.text.includes(word) && !email.subject.includes(word), `no ${word}`);
    const escaped = feedbackEmail({ ...saved, message: "<b>bold</b> & \"quoted\"" });
    ok(escaped.html.includes("&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;") && !escaped.html.includes("<b>bold"), "html escapes the message");
    const admin = feedbackEmail({ ...saved, member: "admin" });
    ok(!("replyTo" in admin) && admin.text.includes("no email address to reply to"), "the shared admin login has no reply-to");
    const rated = feedbackEmail({ ...saved, via: "prompt", topic: null, rating: "not_well", message: null });
    ok(rated.subject.endsWith(": not well") && rated.text.includes("How is Maple working for you? Not well.") && rated.text.includes("No message"), rated.text);
  });

  await test("sending saves first, then marks it emailed only when Resend accepted it", async () => {
    const box = outbox();
    const { feedback, emailed } = await sendFeedback({ familyId: beta.familyId }, { email: beta.member, role: "member" }, parseFeedback({ message: "Thanks for building this", topic: "praise" }, "app"), { send: box.send });
    eq([emailed, box.sent.length, box.sent[0]?.replyTo], [true, 1, beta.member]);
    ok((await sql(`SELECT emailed_at FROM maple_feedback WHERE id = $1`, [feedback.id]))[0].emailed_at != null, "emailed_at set");
    const failing = outbox({ sent: false, reason: "failed" });
    const second = await sendFeedback({ familyId: beta.familyId }, { email: beta.member, role: "member" }, parseFeedback({ message: "Second" }, "app"), { send: failing.send });
    eq(second.emailed, false);
    eq((await sql(`SELECT emailed_at, message FROM maple_feedback WHERE id = $1`, [second.feedback.id]))[0], { emailed_at: null, message: "Second" });
    const thrown = await sendFeedback({ familyId: beta.familyId }, { email: beta.member, role: "member" }, parseFeedback({ message: "Third" }, "app"), { send: async () => { throw new Error("network"); } });
    eq(thrown.emailed, false, "a throwing sender still leaves it saved");
    let finish: (r: EmailResult) => void = () => {};
    const slow = await sendFeedback({ familyId: beta.familyId }, { email: beta.member, role: "member" }, parseFeedback({ message: "Slow provider" }, "app"), { send: () => new Promise<EmailResult>((resolve) => { finish = resolve; }), waitMs: 20 });
    eq(slow.emailed, false, "a slow send doesn't hold the person waiting");
    finish({ sent: true, id: "made-up-late-id" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    ok((await sql(`SELECT emailed_at FROM maple_feedback WHERE id = $1`, [slow.feedback.id]))[0].emailed_at != null, "a late acceptance is still recorded");
  });

  await test("no more than the day's emails across Maple; the rest wait on the admin page", async () => {
    await sql(
      `INSERT INTO maple_feedback (family_id, member, role, via, message, emailed_at) SELECT $1, 'filler@example.com', 'member', 'app', 'filler', NOW() FROM generate_series(1, $2)`,
      [beta.familyId, FEEDBACK_EMAILS_PER_DAY]
    );
    const box = outbox();
    const saved = await saveFeedback({ familyId: beta.familyId }, { email: beta.owner, role: "owner" }, parseFeedback({ message: "Over the cap" }, "app"));
    eq(await emailFeedback(saved, { send: box.send }), false);
    eq(box.sent.length, 0);
    await sql(`DELETE FROM maple_feedback WHERE member = 'filler@example.com'`);
  });

  await sql(`DELETE FROM maple_feedback`);

  await test("Today's question: owners and members of a set-up family that has used Maple for a while, outside family 1", async () => {
    const owner = { email: beta.owner, role: "owner" as const };
    eq((await feedbackAsk({ familyId: beta.familyId }, owner)).ask, false, "too new and too little logged");
    await settle(beta);
    eq(await feedbackAsk({ familyId: beta.familyId }, owner), { ask: true, replyable: true });
    eq((await feedbackAsk({ familyId: beta.familyId }, { email: beta.member, role: "member" })).ask, true, "a member too");
    eq((await feedbackAsk({ familyId: beta.familyId }, { email: beta.viewer, role: "viewer" })).ask, false, "never a viewer");
    await settle(alpha);
    eq((await feedbackAsk({ familyId: alpha.familyId }, { email: alpha.owner, role: "owner" })).ask, false, "never family 1");
    await sql(`UPDATE maple_families SET status = 'deleting' WHERE id = $1`, [beta.familyId]);
    eq((await feedbackAsk({ familyId: beta.familyId }, owner)).ask, false, "not a family being deleted");
    await sql(`UPDATE maple_families SET status = 'active' WHERE id = $1`, [beta.familyId]);
  });

  await test("Not now holds it off for a while, twice is the end, and answering ends it", async () => {
    const owner = { email: beta.owner, role: "owner" as const };
    await snoozeFeedbackAsk({ familyId: beta.familyId }, beta.owner);
    eq((await feedbackAsk({ familyId: beta.familyId }, owner)).ask, false, "snoozed");
    await sql(`UPDATE maple_feedback_asks SET ask_after = NOW() - INTERVAL '1 minute' WHERE member = $1`, [beta.owner]);
    eq((await feedbackAsk({ familyId: beta.familyId }, owner)).ask, true, "back after the snooze");
    await snoozeFeedbackAsk({ familyId: beta.familyId }, beta.owner);
    await sql(`UPDATE maple_feedback_asks SET ask_after = NOW() - INTERVAL '1 minute' WHERE member = $1`, [beta.owner]);
    eq((await feedbackAsk({ familyId: beta.familyId }, owner)).ask, false, "not after the second Not now");
    const member = { email: beta.member, role: "member" as const };
    await saveFeedback({ familyId: beta.familyId }, member, parseFeedback({ rating: "well" }, "prompt"));
    eq((await feedbackAsk({ familyId: beta.familyId }, member)).ask, false, "answered");
    ok((await sql(`SELECT answered_at FROM maple_feedback_asks WHERE family_id = $1 AND member = $2`, [beta.familyId, beta.member]))[0].answered_at != null, "answered_at set");
    await sql(`DELETE FROM maple_feedback_asks WHERE member = $1`, [beta.member]);
    eq((await feedbackAsk({ familyId: beta.familyId }, member)).ask, false, "not asked within a month of sending feedback");
    await sql(`UPDATE maple_feedback SET created_at = NOW() - INTERVAL '31 days' WHERE member = $1`, [beta.member]);
    eq((await feedbackAsk({ familyId: beta.familyId }, member)).ask, true, "asked again once that month has passed");
  });

  await sql(`DELETE FROM maple_feedback`);
  await sql(`DELETE FROM maple_feedback_asks`);

  await test("route: anyone signed in sends; the session's family and member are the sender", async () => {
    const sent = await route("POST", beta.viewer, beta.familyId, { via: "app", message: "Could viewers get a bigger font?", topic: "idea" });
    eq([sent.status, sent.json.ok, sent.json.emailed], [200, true, false], "no Resend here, so not emailed");
    eq(await sql(`SELECT family_id, member, role, via, topic FROM maple_feedback`), [{ family_id: String(beta.familyId), member: beta.viewer, role: "viewer", via: "app", topic: "idea" }]);
    await sql(`UPDATE maple_members SET role = 'photos' WHERE family_id = $1 AND email = $2`, [beta.familyId, beta.viewer]);
    eq((await route("POST", beta.viewer, beta.familyId, { via: "app", message: "Photos only, still glad to help" })).status, 200, "photos-only guests too");
    eq((await route("GET", beta.viewer, beta.familyId)).json, { ask: false, replyable: true });
    await sql(`UPDATE maple_members SET role = 'viewer' WHERE family_id = $1 AND email = $2`, [beta.familyId, beta.viewer]);
  });

  await test("route: refusals, Not now, and no session", async () => {
    eq((await route("POST", beta.owner, beta.familyId, { via: "app", message: "   " })).status, 400);
    eq((await route("POST", beta.owner, beta.familyId, { via: "elsewhere", message: "hi" })).status, 400);
    eq((await route("POST", beta.owner, beta.familyId, { via: "app", rating: "well" })).status, 400);
    for (let i = 0; i < FEEDBACK_PER_DAY; i++) eq((await route("POST", beta.owner, beta.familyId, { via: "app", message: `Idea ${i}` })).status, 200);
    const capped = await route("POST", beta.owner, beta.familyId, { via: "app", message: "One more" });
    eq([capped.status, capped.json.code], [429, "limit"]);
    eq((await route("POST", beta.member, beta.familyId, { later: true })).status, 200);
    eq(Number((await sql(`SELECT snoozes FROM maple_feedback_asks WHERE family_id = $1 AND member = $2`, [beta.familyId, beta.member]))[0].snoozes), 1);
    const anonymous = await POST(new NextRequest("http://localhost:3000/api/maple/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ via: "app", message: "hi" }) }));
    eq(anonymous.status, 401);
    eq((await route("POST", beta.owner, alpha.familyId, { via: "app", message: "Not my family" })).status, 401, "a session for a family they aren't in");
  });

  await sql(`DELETE FROM maple_feedback`);

  await test("chat: send_feedback waits for a tap, then saves as the chat's member with via chat", async () => {
    eq(TOOL_APPROVAL.send_feedback, "user-approval");
    const tools = chatTools({ email: beta.viewer, role: "viewer" }, { fam: beta.familyId, copy: FAMILY_ONE_COPY, born: true, care: false });
    ok("send_feedback" in tools, "viewers can send feedback too");
    const tool = feedbackTool({ email: beta.member, role: "member" }, { familyId: beta.familyId });
    const run = (input: { message: string; topic: "problem" | "idea" | "praise" | "other" }) =>
      (tool.execute as (i: typeof input, o: unknown) => Promise<ChatToolOutput>)(input, { toolCallId: "call-1", messages: [] });
    const out = await run({ message: "The sleep timer kept running after I stopped it.", topic: "problem" });
    eq([out.ok, out.write, out.text, out.feedback], [true, true, FEEDBACK_SENT, { sent: true, note: "Sent to the person who makes Maple." }]);
    ok(!/\bMaple\b(?!'s Log)/.test(`${tool.description} ${out.text}`), "what the model reads says Maple's Log, never a bare Maple (family 1's baby)");
    eq(await sql(`SELECT member, role, via, topic, message FROM maple_feedback`), [{ member: beta.member, role: "member", via: "chat", topic: "problem", message: "The sleep timer kept running after I stopped it." }]);
    for (let i = 1; i < FEEDBACK_PER_DAY; i++) await run({ message: `More ${i}`, topic: "other" });
    const capped = await run({ message: "Over", topic: "other" });
    ok(!capped.ok && capped.feedback?.sent === false && capped.feedback.note.startsWith("Not sent.") && capped.text.startsWith("Not sent:"), JSON.stringify(capped));
  });

  await test("leaving or being removed clears that person's question state; their feedback stays with the family", async () => {
    await snoozeFeedbackAsk({ familyId: beta.familyId }, beta.viewer);
    ok(await removeMember({ familyId: beta.familyId }, beta.viewer, beta.owner), "removed");
    eq((await sql(`SELECT COUNT(*)::int AS n FROM maple_feedback_asks WHERE member = $1`, [beta.viewer]))[0].n, 0);
    await snoozeFeedbackAsk({ familyId: beta.familyId }, beta.member);
    eq(await leaveFamily({ familyId: beta.familyId }, beta.member), null);
    eq((await sql(`SELECT COUNT(*)::int AS n FROM maple_feedback_asks WHERE member = $1`, [beta.member]))[0].n, 0);
    ok(Number((await sql(`SELECT COUNT(*)::int AS n FROM maple_feedback WHERE member = $1`, [beta.member]))[0].n) > 0, "their feedback stays");
  });

  await test("deleting a family deletes its feedback and question state", async () => {
    await snoozeFeedbackAsk({ familyId: beta.familyId }, beta.owner);
    for (const table of ["maple_chat_messages", "maple_chat_threads", "maple_chat_daily", "maple_consents", "maple_push_subs", "maple_tokens", "maple_invites", "maple_removed", "maple_entries", "maple_babies", "maple_members"]) {
      await sql(`DELETE FROM ${table} WHERE family_id = $1`, [beta.familyId]);
    }
    await sql(`DELETE FROM maple_ai_usage WHERE family_id = $1`, [beta.familyId]);
    await sql(`DELETE FROM maple_families WHERE id = $1`, [beta.familyId]);
    eq((await sql(`SELECT (SELECT COUNT(*)::int FROM maple_feedback WHERE family_id = $1) AS f, (SELECT COUNT(*)::int FROM maple_feedback_asks WHERE family_id = $1) AS a`, [beta.familyId]))[0], { f: 0, a: 0 });
  });

  done("feedback.check.ts");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
