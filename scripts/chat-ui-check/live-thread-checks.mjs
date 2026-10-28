import assert from "node:assert/strict";

const THREAD = "synthetic-thread";
const QUESTION = { type: "tool-ask_user", toolCallId: "call_first", state: "input-available", input: { question: "Was this the same feeding?", options: [{ id: "same", label: "Same feeding" }, { id: "separate", label: "A separate feeding" }] } };
const SECOND = { type: "tool-ask_user", toolCallId: "call_second", state: "input-available", input: { question: "Which side was it?", options: [{ id: "left", label: "Left side" }, { id: "right", label: "Right side" }] } };
const APPROVAL = { type: "tool-delete_entry", toolCallId: "call_delete", state: "approval-requested", input: { id: 902 }, approval: { id: "approval_delete" } };

/** A bounded synthetic HTTP boundary, not an implementation of real authorization. */
export function liveServer() {
  let messages = [];
  let calls = [];
  let reads = 0;
  let completed = 0;
  let mode = "two";
  const reset = (kind) => {
    mode = kind;
    calls = []; reads = 0; completed = 0;
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
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ current: { id: THREAD, busy: mode === "recovery" && reads === 1 }, items: messages.map((message) => ({ thread: THREAD, message })), more: false }) });
      return;
    }
    const body = route.request().postDataJSON();
    calls.push(body);
    assert.equal(body.threadId, THREAD);
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
  return { reset, serve, snapshot: () => ({ messages, calls, reads, completed }) };
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
  assert(await page.getByRole("button", { name: "Waiting for the current reply", exact: true }).isDisabled(), "An unresolved previous turn blocks another send");
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await page.getByText("Your earlier reply is ready.", { exact: true }).waitFor();
  assert.equal(await draft.inputValue(), "A draft that must survive recovery.");
  assert.equal(server.snapshot().calls.length, 0, "Recovery only reads and never replays a write");
  assert(await page.getByRole("button", { name: "Send", exact: true }).isEnabled());
  console.log("PASS real chat hook: interrupted recovery blocks writes, checks again, and preserves the draft");
}
