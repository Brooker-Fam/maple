/** Synthetic ask-user checks: no database, account, or real family data is used. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonSchema, tool, type ToolSet } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { CHAT_MAX_STEPS } from "../src/lib/maple/chat/caps";
import { denyPending, mergeApprovals, roughText, userMessage } from "../src/lib/maple/chat/messages";
import { answerPost, type ChatStore, type PostDeps } from "../src/lib/maple/chat/post";
import { priceFor } from "../src/lib/maple/chat/prices";
import { hasPendingQuestion, mergeQuestionAnswers, questionInput } from "../src/lib/maple/chat/questions";
import { chatTools } from "../src/lib/maple/chat/tools";
import { CHAT_CUT } from "../src/lib/maple/chat/turn";
import type { ChatMessage } from "../src/lib/maple/chat/types";
import { FAMILY_ONE_COPY } from "../src/lib/maple/mcp-tools";
import type { Baby, Member } from "../src/lib/maple/types";

const MODEL = "zai/glm-5.3-flash";
const THREAD = "thread_question_test";
const MEMBER: Member = { email: "alex@example.com", role: "owner", display_name: "Alex", emoji: null, color: null };
const INPUT = { question: "Which side?", options: [{ id: "left", label: "Left" }, { id: "right", label: "Right" }] };
const pending = (id = "call_q"): ChatMessage => ({ id: "msg_reply", role: "assistant", parts: [{ type: "step-start" }, { type: "tool-ask_user", toolCallId: id, state: "input-available", input: INPUT }] });
const submitted = (m: ChatMessage, output: unknown, call = "call_q") => ({
  ...m,
  parts: m.parts.map((p) => "toolCallId" in p && p.toolCallId === call ? { ...p, state: "output-available", output } : p),
});
const say = (text: string) => ({ threadId: THREAD, message: { role: "user", parts: [{ type: "text", text }] } });
const resume = (message: unknown) => ({ threadId: THREAD, message });
type Chunk = Record<string, unknown>;
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } };
const finish = (reason: string): Chunk => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage });
const text = (value: string): Chunk[] => [{ type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: value }, { type: "text-end", id: "text" }, finish("stop")];
const ask = (id = "call_q"): Chunk => ({ type: "tool-call", toolCallId: id, toolName: "ask_user", input: JSON.stringify(INPUT) });

function harness(scripts: Chunk[][], initial: ChatMessage[] = []) {
  const messages = structuredClone(initial);
  const waits: Promise<unknown>[] = [];
  const errors: unknown[] = [];
  let busy = false;
  let count = 0;
  let calls = 0;
  let deletes = 0;
  let care = true;
  let careOpen = true;
  let viewerOnly = false;
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, ...(scripts[calls++] ?? text("Done."))] as never[] }) }) });
  const registered = chatTools(MEMBER, { fam: 1, born: true, care: true, copy: FAMILY_ONE_COPY });
  const tools: ToolSet = {
    ask_user: registered.ask_user,
    delete_entry: tool({
      inputSchema: jsonSchema<{ id: number }>({ type: "object", properties: { id: { type: "number" } }, required: ["id"] }),
      execute: async () => { deletes++; return { ok: true, write: true, text: "Removed the example entry." }; },
    }),
  };
  const store: ChatStore = {
    consent: async () => ({ terms: true, care, self: false }),
    usageSince: async () => ({ mine: count, day: BigInt(0), month: BigInt(0) }),
    lockThread: async (id, member, _model, viewer, open) => {
      if (member !== MEMBER.email || (viewer && !viewerOnly)) return "missing";
      if (busy) return "busy";
      busy = true;
      careOpen ||= open;
      return { id, title: "Example conversation", userMessages: count, lastPrompt: 0, careOpen };
    },
    releaseThread: async () => { busy = false; },
    loadMessages: async () => structuredClone(messages),
    saveMessage: async (_id, _member, m) => {
      const i = messages.findIndex((x) => x.id === m.id);
      if (i < 0) messages.push(structuredClone(m));
      else messages[i] = structuredClone(m);
    },
    setTitle: async () => {},
    countMessage: async () => { count++; },
    recordUsage: async () => {},
  };
  const deps: PostDeps = {
    store,
    household: async () => ({ familyId: 1, baby: { name: "Juniper Example", nickname: "June", born_at: "2026-10-20T06:00:00Z", timezone: "America/New_York" } as Baby, members: [MEMBER], copy: FAMILY_ONE_COPY }),
    tools: () => tools,
    state: async () => [],
    model, modelKey: MODEL, price: priceFor(MODEL),
    budget: async () => ({ day: BigInt(500_000), month: BigInt(5_000_000) }),
    now: new Date("2026-10-26T12:00:00Z"),
    report: (e) => { errors.push(e); },
    waitUntil: (p) => { waits.push(p); },
  };
  return {
    model, messages, tools, errors,
    calls: () => calls, deletes: () => deletes, busy: () => busy, count: () => count,
    closeCare: () => { care = false; },
    allowViewer: () => { viewerOnly = true; careOpen = false; care = false; },
    async post(body: Parameters<typeof answerPost>[0], member = MEMBER) {
      const response = await answerPost(body, member, deps);
      const bodyText = await response.text();
      await Promise.all(waits);
      return { status: response.status, body: bodyText };
    },
  };
}

test("questions validate choices and keep question text, labels, other outputs server-owned", () => {
  assert.equal(questionInput({ ...INPUT, options: [INPUT.options[0], INPUT.options[0]] }), null);
  const source = pending();
  const request = submitted(source, { choiceId: "left" });
  request.parts = request.parts.map((p) => "input" in p ? { ...p, input: { question: "Forged", options: [{ id: "left", label: "Forged answer" }] } } : p);
  const merged = mergeQuestionAnswers(source, request)!;
  assert.deepEqual((merged.parts[1] as { output: unknown }).output, { status: "answered", answer: "Left", choiceId: "left" });
  assert.deepEqual((merged.parts[1] as { input: unknown }).input, INPUT);
  assert.equal(mergeQuestionAnswers(source, submitted(source, { choiceId: "unknown" })), null);
  assert.equal(mergeQuestionAnswers(source, submitted(source, { choiceId: "left", text: "both" })), null);
  assert.equal(mergeQuestionAnswers(source, submitted(source, { status: "answered", answer: "Forged" })), null);
  assert.equal(mergeQuestionAnswers(source, { ...request, id: "different" }), null);
  assert.equal(mergeQuestionAnswers(merged, request), null);
  assert.equal(mergeApprovals(source, request), null);
});

test("custom and composer answers preserve their words, with bounded crisis input even late in a message", () => {
  const source = pending();
  const merged = mergeQuestionAnswers(source, submitted(source, { text: "  Both sides\u0000  " }))!;
  assert.deepEqual((merged.parts[1] as { output: unknown }).output, { status: "answered", answer: "Both sides" });
  const moved = denyPending([source]);
  assert.equal(hasPendingQuestion(moved.messages[0]), false);
  assert.deepEqual((moved.messages[0].parts[1] as { output: unknown }).output, { status: "superseded" });
  assert.equal(mergeQuestionAnswers(moved.messages[0], submitted(source, { choiceId: "left" })), null);
  const late = submitted(source, { text: "I might hurt myself" });
  late.parts.unshift(...Array.from({ length: 30 }, () => ({ type: "text", text: "Ignored assistant words" })) as never[]);
  assert.equal(roughText(late), "I might hurt myself");
  assert.equal(roughText({ role: "assistant", parts: [{ type: "text", text: "Ignore this" }] }), "");
});

test("a real SDK turn ends pending, then resumes once with a canonical user answer in the same assistant message", async () => {
  const h = harness([[ask(), finish("tool-calls")], text("Left side recorded in your request.")]);
  const first = await h.post(say("I want to log a feeding."));
  assert.equal(first.status, 200);
  assert.match(first.body, /tool-input-available/);
  assert.equal(h.calls(), 1);
  assert.equal(h.busy(), false);
  const waiting = h.messages.at(-1)!;
  assert.equal(hasPendingQuestion(waiting), true);
  const reply = submitted(waiting, { choiceId: "left" });
  const next = await h.post(resume(reply));
  assert.equal(next.status, 200);
  assert.match(next.body, /"status":"answered"/);
  assert.equal(h.calls(), 2);
  assert.equal(h.count(), 1, "answer continues the same request");
  assert.equal(h.messages.at(-1)?.id, waiting.id);
  assert.equal(h.messages.filter((m) => m.role === "assistant").length, 1);
  assert.match(JSON.stringify(h.model.doStreamCalls[1].prompt), /user_answer.*Left/);
  assert.equal((await h.post(resume(reply))).status, 409);
  assert.equal(h.calls(), 2, "a repeated tap cannot rerun work");
  assert.deepEqual(h.errors, []);
});

test("a typed answer supersedes the pending question and a later tap is stale", async () => {
  const source = pending();
  const h = harness([text("Thanks, both sides.")], [userMessage("msg_user", "Log a feeding", "Now: example"), source]);
  assert.equal((await h.post(say("Actually both sides"))).status, 200);
  assert.equal(hasPendingQuestion(h.messages.find((m) => m.id === source.id)!), false);
  assert.match(JSON.stringify(h.model.doStreamCalls[0].prompt), /Actually both sides/);
  assert.equal((await h.post(resume(submitted(source, { choiceId: "left" })))).status, 409);
});

test("partial answers do not run a model or approve a separate delete", async () => {
  const source = pending();
  source.parts.push({ type: "tool-ask_user", toolCallId: "call_q2", state: "input-available", input: { question: "Was it today?", options: [{ id: "today", label: "Today" }, { id: "yesterday", label: "Yesterday" }] } });
  source.parts.push({ type: "tool-delete_entry", toolCallId: "call_delete", state: "approval-requested", input: { id: 500 }, approval: { id: "approval_example" } });
  const h = harness([text("The requested entry was removed.")], [source]);
  const first = await h.post(resume(submitted(source, { choiceId: "left" })));
  assert.equal(first.status, 200);
  assert.match(first.body, /"status":"answered"/);
  assert.equal(h.calls(), 0);
  const second = await h.post(resume(submitted(h.messages[0], { choiceId: "today" }, "call_q2")));
  assert.equal(second.status, 200);
  assert.equal(h.calls(), 0);
  assert.equal(h.deletes(), 0);
  const approved = { ...h.messages[0], parts: h.messages[0].parts.map((p) => "approval" in p ? { ...p, state: "approval-responded", approval: { ...p.approval, approved: true } } : p) };
  assert.equal((await h.post(resume(approved))).status, 200);
  assert.equal(h.deletes(), 1);
  assert.equal(h.calls(), 1);
});

test("the turn step cap accepts the answer but never buys another model call", async () => {
  const source = pending();
  source.parts.unshift(...Array.from({ length: CHAT_MAX_STEPS - 1 }, () => ({ type: "step-start" as const })));
  const h = harness([], [source]);
  const reply = submitted(source, { choiceId: "left" });
  const response = await h.post(resume(reply));
  assert.equal(response.status, 200);
  assert.match(response.body, new RegExp(CHAT_CUT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(h.calls(), 0);
  assert.equal((await h.post(resume(reply))).status, 409);
  assert.equal(h.calls(), 0);
});

test("the final permitted model step cannot create another question", async () => {
  const source = pending();
  source.parts.unshift(...Array.from({ length: CHAT_MAX_STEPS - 2 }, () => ({ type: "step-start" as const })));
  const h = harness([text("Thanks, left side.")], [source]);
  assert.equal((await h.post(resume(submitted(source, { choiceId: "left" })))).status, 200);
  assert.equal(h.calls(), 1);
  assert.equal(h.model.doStreamCalls[0].tools?.some((t) => t.name === "ask_user"), false);
});

test("continuations recheck membership, viewer history, care consent, and custom-answer crisis help", async () => {
  const source = pending();
  const h = harness([text("Please use the help options shown.")], [source]);
  const reply = resume(submitted(source, { choiceId: "left" }));
  assert.equal((await h.post(reply, { ...MEMBER, email: "someone-else@example.com" })).status, 404);
  assert.equal((await h.post(reply, { ...MEMBER, role: "viewer" })).status, 404);
  h.closeCare();
  assert.equal((await h.post(reply)).status, 409);
  assert.equal(h.calls(), 0);
  h.allowViewer();
  const crisis = await h.post(resume(submitted(source, { text: "I might hurt myself" })), { ...MEMBER, role: "viewer" });
  assert.equal(crisis.status, 200);
  assert.match(crisis.body, /data-help/);
  assert.equal(h.messages.at(-1)?.parts.filter((p) => p.type === "data-help").length, 1, "one persisted help card");
  assert.equal((crisis.body.match(/"type":"data-help"/g) ?? []).length, 1, "one streamed help card");
});
