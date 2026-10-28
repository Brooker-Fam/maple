/** Synthetic delivery/queue checks: real scoped Postgres queries and SDK model plumbing, no network model. */
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { listMembers } from "../../src/lib/maple/auth";
import { getBaby } from "../../src/lib/maple/store";
import { formatTime } from "../../src/lib/maple/time";
import { chatTools } from "../../src/lib/maple/chat/tools";
import type { ChatToolOutput } from "../../src/lib/maple/chat/types";
import { FAMILY_ONE_COPY } from "../../src/lib/maple/mcp-tools";
import { answerPost, type PostDeps } from "../../src/lib/maple/chat/post";
import { acceptDelivery, cancelDelivery, deliveryStatus, findDelivery } from "../../src/lib/maple/chat/delivery-store";
import { deleteChats, loadRecentMessages } from "../../src/lib/maple/chat/history";
import { chatStore, lockThread, releaseThread } from "../../src/lib/maple/chat/store";
import { priceFor } from "../../src/lib/maple/chat/prices";
import type { Member } from "../../src/lib/maple/types";
import { done, eq, freshDb, ok, seedFamilies, sql, test } from "./harness";

process.env.MAPLE_SESSION_SECRET = "synthetic-chat-delivery-key";
const MODEL = "zai/glm-5.3-flash";
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const sentAt = new Date(NOW.getTime() - 5 * 60_000).toISOString();
const A = { familyId: 1 };
const B = { familyId: 2 };
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const finish = (reason: string) => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage });
let modelCalls = 0;
let writes = 0;
let toolTime: string | undefined;
const waits: Promise<unknown>[] = [];
const errors: Error[] = [];
const model = new MockLanguageModelV4({ doStream: async () => {
  const saving = modelCalls++ % 2 === 0;
  const chunks = saving
    ? [{ type: "tool-call", toolCallId: `call_${modelCalls}`, toolName: "save_example", input: "{}" }, finish("tool-calls")]
    : [{ type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: "Saved the example." }, { type: "text-end", id: "text" }, finish("stop")];
  return { stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, ...chunks] as never[] }) };
} });

async function main() {
await freshDb({ migrations: 2 });
const { alpha, beta } = await seedFamilies();
const initialCount = Number((await sql(`SELECT COALESCE(SUM(messages), 0)::int AS n FROM maple_chat_daily WHERE family_id = 1 AND member = $1`, [alpha.owner]))[0].n);
const member = (email: string): Member => ({ email, display_name: "Example", role: "owner", emoji: null, color: null });
const deps = (familyId: number): PostDeps => ({
  store: { ...chatStore({ familyId }), consent: async () => ({ terms: true, care: false, self: false }) },
  household: async () => ({ familyId, baby: await getBaby({ familyId }), members: await listMembers({ familyId }), copy: FAMILY_ONE_COPY }),
  state: async () => ["The current synthetic log."],
  budget: async () => ({ day: BigInt(500_000), month: BigInt(5_000_000) }),
  model, modelKey: MODEL, price: priceFor(MODEL), now: NOW,
  tools: ({ submittedAt }) => {
    toolTime = submittedAt?.toISOString();
    return { save_example: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }), execute: async () => { writes++; return { ok: true, write: true, text: "Saved." }; } }) };
  },
  report: (error) => { errors.push(error); }, waitUntil: (p) => { waits.push(p); },
});
const body = (requestId: string, text = "Log a made-up note five minutes ago.", submittedAt = sentAt, threadId = "thread_delivery_a") => ({ threadId, requestId, submittedAt, message: { role: "user", parts: [{ type: "text", text }] } });
async function post(input: ReturnType<typeof body>, email = alpha.owner, familyId = 1) {
  const response = await answerPost(input, member(email), deps(familyId));
  const text = await response.text();
  await Promise.all(waits.splice(0));
  return { status: response.status, text };
}

await test("a queued request is accepted once with its original time, user message and daily count", async () => {
  const result = await post(body("delivery_example_1"));
  eq(result.status, 200);
  eq([modelCalls, writes, toolTime], [2, 1, sentAt]);
  const messages = await loadRecentMessages(A, "thread_delivery_a");
  const delivery = messages[0].parts.find((part) => part.type === "data-delivery");
  eq(delivery?.type, "data-delivery");
  if (delivery?.type === "data-delivery") eq([delivery.data.requestId, delivery.data.submittedAt], ["delivery_example_1", sentAt]);
  const context = messages[0].parts.find((part) => part.type === "data-context");
  ok(context?.type === "data-context" && context.data.state?.some((line) => line.includes(sentAt)), "model sees original submission separately from current log");
  eq(await deliveryStatus(A, alpha.owner, false, "delivery_example_1"), { requestId: "delivery_example_1", state: "completed", threadId: "thread_delivery_a", busy: false });
  eq((await sql(`SELECT SUM(messages)::int AS n FROM maple_chat_daily WHERE family_id = 1 AND member = $1`, [alpha.owner]))[0].n, initialCount + 1);
});

await test("retries including another thread do not run the model, write or count again", async () => {
  const result = await post(body("delivery_example_1", undefined, undefined, "thread_new_phone"));
  eq(result.status, 409);
  eq(JSON.parse(result.text).code, "received");
  eq(JSON.parse(result.text).threadId, "thread_delivery_a");
  eq([modelCalls, writes], [2, 1]);
  eq((await sql(`SELECT SUM(messages)::int AS n FROM maple_chat_daily WHERE family_id = 1 AND member = $1`, [alpha.owner]))[0].n, initialCount + 1);
  eq(await sql(`SELECT id FROM maple_chat_threads WHERE id = 'thread_new_phone'`), []);
});

await test("a changed body or original time cannot reuse an accepted request id", async () => {
  eq(JSON.parse((await post(body("delivery_example_1", "A different made-up note."))).text).code, "stale");
  eq(JSON.parse((await post(body("delivery_example_1", undefined, NOW.toISOString()))).text).code, "stale");
  eq([modelCalls, writes], [2, 1]);
});

await test("delivery references are private to one member of one family", async () => {
  eq((await deliveryStatus(A, alpha.member, false, "delivery_example_1")).state, "missing");
  eq((await deliveryStatus(B, alpha.owner, false, "delivery_example_1")).state, "missing");
  eq((await post(body("delivery_example_1", "Another family's note.", sentAt, "thread_delivery_b"), beta.owner, 2)).status, 200);
  eq([modelCalls, writes], [4, 2]);
});

await test("a future or expired queued message is rejected before it can write", async () => {
  eq((await post(body("delivery_future_1", undefined, new Date(NOW.getTime() + 3 * 60_000).toISOString()))).status, 400);
  eq((await post(body("delivery_old_1", undefined, new Date(NOW.getTime() - 8 * 86400_000).toISOString()))).status, 400);
  eq([modelCalls, writes], [4, 2]);
});

await test("acceptance rolls back its receipt and count if the canonical user message cannot be saved", async () => {
  let failed = false;
  try {
    await acceptDelivery(A, alpha.owner, "thread_delivery_a", { requestId: "delivery_collision", submittedAt: sentAt }, "Synthetic", { id: alpha.messageId, role: "user", parts: [{ type: "text", text: "Synthetic" }] }, "2026-10-28");
  } catch { failed = true; }
  ok(failed, "a message key collision fails atomically");
  eq(await findDelivery(A, alpha.owner, "delivery_collision"), null);
  eq((await sql(`SELECT SUM(messages)::int AS n FROM maple_chat_daily WHERE family_id = 1 AND member = $1`, [alpha.owner]))[0].n, initialCount + 1);
});

await test("deleting history leaves a non-content receipt so an uncertain send cannot replay", async () => {
  await deleteChats(A, alpha.owner, false);
  eq((await deliveryStatus(A, alpha.owner, false, "delivery_example_1")).threadId, null);
  const result = await post(body("delivery_example_1"));
  eq(JSON.parse(result.text).code, "received");
  eq([modelCalls, writes], [4, 2]);
  const receipt = await sql(`SELECT fingerprint FROM maple_chat_deliveries WHERE family_id = 1 AND request_id = 'delivery_example_1'`);
  ok(String(receipt[0].fingerprint).startsWith("h1:"), "receipt stores a keyed fingerprint, no original text");
});

await test("two new thread ids for one member cannot execute at the same time", async () => {
  const results = await Promise.all([
    lockThread(A, "thread_race_one", alpha.member, MODEL, false, false),
    lockThread(A, "thread_race_two", alpha.member, MODEL, false, false),
  ]);
  eq(results.filter((result) => result === "busy").length, 1);
  const locked = results.find((result) => typeof result === "object");
  ok(locked && typeof locked === "object", "one lease acquired");
  if (!locked || typeof locked !== "object") return;
  await releaseThread(A, locked.id, "wrong_lease");
  eq(await lockThread(A, "thread_race_three", alpha.member, MODEL, false, false), "busy", "old or unrelated release cannot unlock another lease");
  await releaseThread(A, locked.id, locked.leaseId);
  const after = await lockThread(A, "thread_race_three", alpha.member, MODEL, false, false);
  ok(typeof after === "object", "next turn proceeds once previous releases");
  if (typeof after === "object") await releaseThread(A, after.id, after.leaseId);
});

await test("a cancellation wins against a delayed original POST without a model call or log write", async () => {
  const before = [modelCalls, writes];
  const delivery = { requestId: "delivery_cancel_first", submittedAt: sentAt };
  eq((await cancelDelivery(A, alpha.owner, false, delivery))?.state, "cancelled");
  const result = await post(body(delivery.requestId));
  eq(JSON.parse(result.text).code, "cancelled");
  eq([modelCalls, writes], before);
  eq((await deliveryStatus(A, alpha.member, false, delivery.requestId)).state, "missing");
  eq((await deliveryStatus(B, alpha.owner, false, delivery.requestId)).state, "missing");
});

await test("an accepted request cannot be cancelled or changed into another request", async () => {
  eq((await cancelDelivery(B, beta.owner, false, { requestId: "delivery_example_1", submittedAt: sentAt }))?.state, "completed");
  eq((await findDelivery(B, beta.owner, "delivery_example_1"))?.cancelled, false);
});

await test("acceptance racing cancellation has exactly one winner and cannot cancel an accepted turn", async () => {
  const locked = await lockThread(A, "thread_cancel_race", alpha.member, MODEL, false, false);
  ok(typeof locked === "object", "turn acquired a lease");
  if (typeof locked !== "object") return;
  const delivery = { requestId: "delivery_accept_cancel_race", submittedAt: sentAt };
  const [cancelled, accepted] = await Promise.all([
    cancelDelivery(A, alpha.member, false, delivery),
    acceptDelivery(A, alpha.member, locked.id, delivery, "A synthetic race", { id: "msg_delivery_race", role: "user", parts: [{ type: "text", text: "A synthetic race" }] }, NOW.toISOString().slice(0, 10)),
  ]);
  eq(accepted, cancelled?.state !== "cancelled", "only one operation owns the delivery reference");
  const receipt = await deliveryStatus(A, alpha.member, false, delivery.requestId);
  if (accepted) {
    eq([receipt.state, receipt.busy], ["received", true]);
    eq((await cancelDelivery(A, alpha.member, false, delivery))?.state, "received", "accepted but unfinished turn is not cancellable");
  } else eq(receipt.state, "cancelled");
  await releaseThread(A, locked.id, locked.leaseId);
});

await test("an earlier signing key still recognizes a receipt after rotation", async () => {
  process.env.MAPLE_SESSION_SECRET_PREV = process.env.MAPLE_SESSION_SECRET;
  process.env.MAPLE_SESSION_SECRET = "synthetic-chat-delivery-key-rotated";
  const result = await post(body("delivery_example_1"));
  eq(JSON.parse(result.text).code, "received");
  process.env.MAPLE_SESSION_SECRET = process.env.MAPLE_SESSION_SECRET_PREV;
  delete process.env.MAPLE_SESSION_SECRET_PREV;
});

await test("old receipts are cleaned in bounded caller-scoped batches, and old submissions still cannot replay", async () => {
  const old = new Date(NOW.getTime() - 9 * 86400_000).toISOString();
  await sql(`INSERT INTO maple_chat_deliveries (family_id, member, request_id, fingerprint, submitted_at, message_id, accepted_at)
    VALUES (1, $1, 'delivery_old_cleanup', 'test', $3, '', $3), (2, $2, 'delivery_old_cleanup', 'test', $3, '', $3)`, [alpha.owner, beta.owner, old]);
  eq((await post(body("delivery_cleanup_trigger", "New synthetic note.", sentAt, "thread_delivery_cleanup"))).status, 200);
  eq(await findDelivery(A, alpha.owner, "delivery_old_cleanup"), null);
  ok(await findDelivery(B, beta.owner, "delivery_old_cleanup"), "the other family's metadata is untouched");
  const before = [modelCalls, writes];
  eq((await post(body("delivery_old_cleanup", undefined, old))).status, 400);
  eq([modelCalls, writes], before);
});

await test("cancellation budget stays bounded even when requests arrive concurrently", async () => {
  await sql(`INSERT INTO maple_chat_daily (family_id, member, day, messages, cancellations) VALUES (1, $1, (NOW() AT TIME ZONE 'UTC')::date, 0, 49)
    ON CONFLICT (family_id, member, day) DO UPDATE SET cancellations = 49`, [alpha.viewer]);
  const results = await Promise.all(Array.from({ length: 4 }, (_, index) => cancelDelivery(A, alpha.viewer, true, { requestId: `delivery_cancel_race_${index}`, submittedAt: sentAt })));
  eq(results.filter((result) => result?.state === "cancelled").length, 1);
  eq((await sql(`SELECT cancellations FROM maple_chat_daily WHERE family_id = 1 AND member = $1 AND day = (NOW() AT TIME ZONE 'UTC')::date`, [alpha.viewer]))[0].cancellations, 50);
  const accepted = results.find((result) => result?.state === "cancelled")!;
  eq((await cancelDelivery(A, alpha.viewer, true, { requestId: accepted.requestId, submittedAt: sentAt }))?.state, "cancelled", "an existing receipt is readable after the cap");
});

const timedTools = chatTools(member(alpha.owner), { fam: 1, born: true, care: true, copy: FAMILY_ONE_COPY, submittedAt: new Date(sentAt) });
async function execute(name: string, input: Record<string, unknown>): Promise<ChatToolOutput> {
  const tool = timedTools[name];
  if (!tool?.execute) throw new Error(`Missing synthetic tool ${name}`);
  const output = await tool.execute(input, { toolCallId: `test_${name}`, messages: [], context: undefined }) as ChatToolOutput;
  ok(output.ok, `${name} succeeded: ${output.text}`);
  return output;
}

await test("actual chat write adapters anchor now and minutes_ago to the queued message", async () => {
  await execute("log_diaper", { diaper: "dry", note: "Synthetic queued time, now", client_ref: "timed_delivery_now", allow_duplicate: true });
  await execute("log_diaper", { diaper: "wet", minutes_ago: 3, note: "Synthetic queued time, earlier", client_ref: "timed_delivery_earlier", allow_duplicate: true });
  const nowRow = (await sql(`SELECT started_at FROM maple_entries WHERE family_id = 1 AND note = 'Synthetic queued time, now'`))[0];
  const earlierRow = (await sql(`SELECT started_at FROM maple_entries WHERE family_id = 1 AND note = 'Synthetic queued time, earlier'`))[0];
  eq(new Date(String(nowRow.started_at)).toISOString(), sentAt);
  eq(new Date(String(earlierRow.started_at)).toISOString(), new Date(Date.parse(sentAt) - 3 * 60_000).toISOString());
});

await test("actual read tools still use the current clock instead of the queued event time", async () => {
  const before = new Date();
  const output = await execute("maple_status", {});
  const after = new Date();
  ok([before, after].some((date) => output.text.startsWith(`It's ${formatTime(date, alpha.tz)}`)), "status reports the current local clock");
  ok(!output.text.startsWith(`It's ${formatTime(sentAt, alpha.tz)}`), "read is not backdated to enqueue time");
});

await test("actual mom temperature writes preserve the original queued event clock", async () => {
  await execute("log_mom_temperature", { temp_c: 36.6, minutes_ago: 2, client_ref: "timed_delivery_care_temp" });
  const row = (await sql(`SELECT at FROM maple_care_entries WHERE family_id = 1 AND kind = 'temp' ORDER BY id DESC LIMIT 1`))[0];
  eq(new Date(String(row.at)).toISOString(), new Date(Date.parse(sentAt) - 2 * 60_000).toISOString());
});

await test("the queue additions produced no reported server errors", () => eq(errors, []));
done("chat-delivery.check.ts");

}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
