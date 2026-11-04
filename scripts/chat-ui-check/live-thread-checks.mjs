import assert from "node:assert/strict";

const THREAD = "synthetic-thread";
const QUESTION = { type: "tool-ask_user", toolCallId: "call_first", state: "input-available", input: { question: "Was this the same feeding?", options: [{ id: "same", label: "Same feeding" }, { id: "separate", label: "A separate feeding" }] } };
const SECOND = { type: "tool-ask_user", toolCallId: "call_second", state: "input-available", input: { question: "Which side was it?", options: [{ id: "left", label: "Left side" }, { id: "right", label: "Right side" }] } };
const APPROVAL = { type: "tool-delete_entry", toolCallId: "call_delete", state: "approval-requested", input: { id: 902 }, approval: { id: "approval_delete" } };
// The server's own lines (CHAT_NO_ANSWER in chat/types.ts, DROPPED in chat/stopped.ts), as the phone shows them.
const NO_ANSWER = "That answer didn't finish, and nothing was saved, so it's safe to send again.";
const DROPPED = "The connection dropped, so the answer may be cut off. It fills in here once it's saved; check Today before trying again.";
const FIRST_SENT = "2026-10-28T15:55:00.000Z";
const FEED = "Log a right side feed from 2:10 AM until 2:25 AM";
const LOGGED = "Logged the right side, 2:10 to 2:25 AM.";
const NIGHT = "The night went fine: two feeds and one long sleep.";
const SSE = { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1", "cache-control": "no-store" };
/** New messages, not answers to a card: a reply that said nothing was saved, one cut off on the way, one that never comes. */
const FRESH = new Set(["unanswered", "cutoff", "stall"]);

/** A bounded synthetic HTTP boundary, not an implementation of real authorization. */
export function liveServer() {
  let messages = [];
  let calls = [];
  let reads = 0;
  let completed = 0;
  let mode = "two";
  let accepted = new Set();
  let hung = [];
  const reset = (kind) => {
    mode = kind;
    calls = []; reads = 0; completed = 0; accepted = new Set(); hung = [];
    if (FRESH.has(kind)) {
      messages = kind === "unanswered"
        ? [
            { id: "msg_first", role: "user", parts: [{ type: "data-delivery", data: { requestId: "req_first_example", submittedAt: FIRST_SENT } }, { type: "text", text: FEED }] },
            { id: "msg_unanswered", role: "assistant", parts: [{ type: "text", text: NO_ANSWER }] },
          ]
        : [
            { id: "msg_before", role: "user", parts: [{ type: "text", text: "An earlier example question." }] },
            { id: "msg_before_reply", role: "assistant", parts: [{ type: "text", text: "An earlier example answer." }] },
          ];
      return;
    }
    messages = [
      { id: "msg_live_user", role: "user", parts: [{ type: "text", text: "Please help with this example." }] },
      { id: "msg_live_assistant", role: "assistant", parts: [{ type: "step-start" }, structuredClone(QUESTION), structuredClone(kind === "two" ? SECOND : APPROVAL)] },
    ];
    if (kind === "recovery") messages = messages.slice(0, 1);
  };
  const serve = async (route) => {
    if (route.request().method() === "GET") {
      reads++;
      if (mode === "recovery" && reads === 2) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic connection failure" }) });
        return;
      }
      if (mode === "recovery" && reads === 3) messages.push({ id: "msg_recovered", role: "assistant", parts: [{ type: "text", text: "Your earlier reply is ready." }] });
      // A message the server took: its receipt says its reply is saved.
      const requestId = new URL(route.request().url()).searchParams.get("requestId");
      const delivery = requestId && accepted.has(requestId) ? { requestId, state: "completed", threadId: THREAD, busy: false } : null;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ current: { id: THREAD, busy: mode === "recovery" && reads === 1 }, items: messages.map((message) => ({ thread: THREAD, message })), more: false, ...(delivery ? { delivery } : {}) }) });
      return;
    }
    const body = route.request().postDataJSON();
    calls.push(body);
    assert.equal(body.threadId, THREAD);
    if (FRESH.has(mode)) {
      assert.equal(body.message.role, "user", "Only a new message goes up");
      accepted.add(body.requestId);
      const reply = mode === "unanswered" ? LOGGED : NIGHT;
      const id = `msg_reply_${calls.length}`;
      // The server saves the whole reply, whatever reaches the phone.
      messages.push(
        { id: `msg_sent_${calls.length}`, role: "user", parts: [{ type: "data-delivery", data: { requestId: body.requestId, submittedAt: body.submittedAt } }, ...body.message.parts] },
        { id, role: "assistant", parts: [{ type: "step-start" }, { type: "text", text: reply }] },
      );
      if (mode === "stall") return void hung.push(route);
      const chunks = [{ type: "start", messageId: id }, { type: "start-step" }, { type: "text-start", id: "live_reply" }];
      // Cut off on the way: the first words, and no finish.
      if (mode === "cutoff") chunks.push({ type: "text-delta", id: "live_reply", delta: "The night" });
      else chunks.push({ type: "text-delta", id: "live_reply", delta: reply }, { type: "text-end", id: "live_reply" }, { type: "finish-step" }, { type: "finish", finishReason: "stop" });
      await route.fulfill({ status: 200, headers: SSE, body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + (mode === "cutoff" ? "" : "data: [DONE]\n\n") });
      return;
    }
    const last = messages.at(-1);
    assert.equal(body.message.id, last.id, "A reply belongs to the stored pending assistant message");
    let changed = 0;
    last.parts = last.parts.map((part) => {
      const incoming = body.message.parts.find((p) => p.toolCallId === part.toolCallId);
      if (part.type === "tool-ask_user" && part.state === "input-available" && incoming?.state === "output-available") {
        const answer = incoming.output;
        const choice = part.input.options.find((o) => o.id === answer?.choiceId);
        assert(choice || typeof answer?.text === "string", "The test response must contain a choice or typed answer");
        changed++;
        return { ...part, state: "output-available", output: choice ? { status: "answered", choiceId: choice.id, answer: choice.label } : { status: "answered", answer: answer.text } };
      }
      if (part.type === "tool-delete_entry" && part.state === "approval-requested" && incoming?.state === "approval-responded") {
        assert.equal(incoming.approval.id, part.approval.id);
        changed++;
        return { ...part, state: "approval-responded", approval: { ...part.approval, approved: incoming.approval.approved } };
      }
      return part;
    });
    assert(changed > 0, `A completed answer must not automatically replay itself (${calls.length} requests; ${last.parts.map((p) => `${p.type}:${p.state}`).join(", ")})`);
    const waiting = last.parts.some((p) => (p.type === "tool-ask_user" && p.state === "input-available") || p.state === "approval-requested");
    const chunks = [{ type: "start", messageId: last.id }];
    for (const p of last.parts) if (p.type === "tool-ask_user" && p.state === "output-available") chunks.push({ type: "tool-output-available", toolCallId: p.toolCallId, output: p.output });
    if (!waiting) {
      completed++;
      const text = "Thanks, your answers are recorded.";
      last.parts.push({ type: "text", text });
      chunks.push({ type: "start-step" }, { type: "text-start", id: "live_answer" }, { type: "text-delta", id: "live_answer", delta: text }, { type: "text-end", id: "live_answer" }, { type: "finish-step" });
    }
    chunks.push({ type: "finish", finishReason: "stop" });
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1", "cache-control": "no-store" }, body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n" });
  };
  /** Lets go of requests left hanging (stall), whatever the page did with them. */
  const release = async () => { for (const route of hung.splice(0)) await route.abort().catch(() => {}); };
  return { reset, serve, release, snapshot: () => ({ messages, calls, reads, completed }) };
}

export async function checkLiveThread({ page, server, url }) {
  const answer = async (label) => {
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/maple/chat") && response.request().method() === "POST", { timeout: 10_000 }),
      page.getByRole("button", { name: label, exact: true }).click(),
    ]);
  };
  server.reset("two");
  await page.goto(`${url}/live.html`);
  await answer("Same feeding");
  await page.waitForFunction(() => document.body.textContent.includes("Same feeding") && ![...document.querySelectorAll("button")].some((button) => button.textContent === "Same feeding"));
  await page.getByRole("button", { name: "Left side", exact: true }).waitFor({ state: "visible" });
  assert.equal(server.snapshot().calls.length, 1, "First of two questions is sent immediately");
  assert.equal(server.snapshot().completed, 0, "The assistant waits for the other answer");
  assert.equal(server.snapshot().messages.at(-1).parts.find((p) => p.toolCallId === "call_first").output.status, "answered");
  await page.reload();
  await page.getByRole("button", { name: "Left side", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Same feeding", exact: true }).count(), 0, "An acknowledged answer survives reload");
  await answer("Left side");
  await page.getByText("Thanks, your answers are recorded.", { exact: true }).waitFor();
  assert.equal(server.snapshot().calls.length, 2, "Exactly one POST per question answer");
  assert.equal(server.snapshot().completed, 1, "The last answer resumes the turn once");
  console.log("PASS real chat hook: partial answers persist independently, reload safely, and resume once");

  for (const questionFirst of [true, false]) {
    server.reset("mixed");
    await page.goto(`${url}/live.html`);
    const first = questionFirst ? "Same feeding" : "Keep";
    const second = questionFirst ? "Keep" : "Same feeding";
    await answer(first);
    await page.getByRole("button", { name: second, exact: true }).waitFor();
    await page.waitForFunction(() => !document.body.textContent.includes("Finishing your reply…") && !document.body.textContent.includes("Updating the log…"));
    assert.equal(server.snapshot().calls.length, 1, "Question and approval each persist without waiting on the other");
    assert.equal(server.snapshot().completed, 0);
    await answer(second);
    await page.getByText("Thanks, your answers are recorded.", { exact: true }).waitFor();
    assert.equal(server.snapshot().calls.length, 2);
    assert.equal(server.snapshot().completed, 1);
    assert.equal(server.snapshot().messages.at(-1).parts.find((p) => p.type === "tool-delete_entry").approval.approved, false, "Answering a question never approves deletion");
  }
  console.log("PASS real chat hook: question and delete approval remain separate in either answer order");

  server.reset("recovery");
  await page.goto(`${url}/live.html`);
  await page.getByText("Finishing your previous reply…", { exact: true }).waitFor();
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("A draft that must survive recovery.");
  await page.getByText("Waiting to reconnect…", { exact: true }).waitFor();
  assert(await page.getByRole("button", { name: "Queue message", exact: true }).isEnabled(), "An unresolved reply allows queueing but cannot start another request");
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await page.getByText("Your earlier reply is ready.", { exact: true }).waitFor();
  assert.equal(await draft.inputValue(), "A draft that must survive recovery.");
  assert.equal(server.snapshot().calls.length, 0, "Recovery only reads and never replays a write");
  assert(await page.getByRole("button", { name: "Send", exact: true }).isEnabled());
  console.log("PASS real chat hook: interrupted recovery blocks writes, checks again, and preserves the draft");
}

/** Replies that stopped: one that says nothing was saved offers Send again; one cut off on the way fills in from the saved reply. */
export async function checkStoppedReplies({ page, server, url }) {
  server.reset("unanswered");
  await page.goto(`${url}/live.html`);
  const again = page.getByRole("button", { name: "Send again", exact: true });
  await again.waitFor();
  const box = await again.boundingBox();
  assert(box && box.height >= 44, "Send again is a full-size tap target");
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/maple/chat") && response.request().method() === "POST", { timeout: 10_000 }),
    again.click(),
  ]);
  await page.getByText(LOGGED, { exact: true }).waitFor();
  const { calls } = server.snapshot();
  assert.equal(calls.length, 1, "Send again sends once");
  assert.deepEqual(calls[0].message.parts, [{ type: "text", text: FEED }], "the same words");
  assert.equal(calls[0].submittedAt, FIRST_SENT, "with the time they were first sent, so relative times keep their meaning");
  assert.notEqual(calls[0].requestId, "req_first_example", "as a new message, never a replay of the first");
  assert.equal(await again.count(), 0, "the offer goes once an answer is in");
  console.log("PASS real chat hook: a reply that saved nothing offers Send again, once, with the first words and time");

  server.reset("cutoff");
  await page.goto(`${url}/live.html`);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("How did the night go?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText(DROPPED, { exact: true }).waitFor();
  await page.getByText(NIGHT, { exact: true }).waitFor();
  await page.waitForFunction((line) => !document.body.textContent.includes(line), DROPPED);
  assert.equal(server.snapshot().calls.length, 1, "Reading the saved reply never sends again");
  console.log("PASS real chat hook: an answer cut off on the way says so, then fills in from the saved reply");
}

/** An answer that never comes (a connection that died quietly) is stopped after the watchdog's limit and read from the saved reply. `page` has its own clock. */
export async function checkStall({ page, server, url }) {
  server.reset("stall");
  await page.clock.install();
  await page.goto(`${url}/live.html`);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("How did the night go?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Thinking…", { exact: true }).waitFor();
  await page.clock.fastForward(20_000);
  await page.getByText("Taking longer than usual…", { exact: true }).waitFor();
  await page.clock.fastForward(40_000);
  assert.equal(await page.getByText(DROPPED, { exact: true }).count(), 0, "A minute is still within a turn");
  await page.clock.fastForward(35_000);
  await page.getByText(DROPPED, { exact: true }).waitFor();
  await page.getByText(NIGHT, { exact: true }).waitFor();
  assert.equal(server.snapshot().calls.length, 1, "Nothing is sent twice");
  await server.release();
  console.log("PASS real chat hook: a quiet answer says it's taking longer; with no news past a turn's limit it's stopped and read from the saved reply");
}
