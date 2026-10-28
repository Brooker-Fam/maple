import assert from "node:assert/strict";

const THREAD = "synthetic-queue-thread";
const question = { type: "tool-ask_user", toolCallId: "synthetic-question", state: "input-available", input: { question: "Which side was it?", options: [{ id: "left", label: "Left side" }, { id: "right", label: "Right side" }] } };
const chart = { version: 1, kind: "activity", asOf: "2026-10-28T16:00:00Z", timezone: "America/New_York", from: "2026-10-28", to: "2026-10-28", range: 7, metric: "feeds", days: [{ date: "2026-10-28", partial: true, feeds: 3, sleepHours: 2, wet: 2, dirty: 1 }] };

/** Real hook and SDK, with a receipt-aware synthetic server. No live account or model. */
export async function checkQueue({ page, url }) {
  let mode = "hold";
  let history = [];
  let posts = [];
  let reads = 0;
  let held = [];
  let receipts = new Map();
  let cancellations = [];
  const reset = (next) => {
    mode = next; posts = []; reads = 0; held = []; receipts = new Map(); cancellations = [];
    history = [{ id: "synthetic-old-user", role: "user", parts: [{ type: "text", text: "An earlier example." }] }, { id: "synthetic-old-reply", role: "assistant", parts: [{ type: "text", text: "Earlier reply." }] }];
    if (next === "chart") history[1].parts = [{ type: "tool-show_chart", toolCallId: "synthetic-chart", state: "output-available", input: {}, output: { ok: true, write: false, text: "Activity chart", chart } }];
  };
  const stream = async (route, message, parts) => {
    const chunks = [{ type: "start", messageId: message.id }, { type: "start-step" }];
    for (const part of parts) {
      if (part.type === "text") chunks.push({ type: "text-start", id: "synthetic-text" }, { type: "text-delta", id: "synthetic-text", delta: part.text }, { type: "text-end", id: "synthetic-text" });
      else if (part.type === "tool-ask_user" && part.state === "input-available") chunks.push({ type: "tool-input-available", toolCallId: part.toolCallId, toolName: "ask_user", input: part.input });
      else if (part.type === "tool-ask_user") chunks.push({ type: "tool-output-available", toolCallId: part.toolCallId, output: part.output });
    }
    chunks.push({ type: "finish-step" }, { type: "finish", finishReason: parts.some((p) => p.state === "input-available") ? "tool-calls" : "stop" });
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" }, body: chunks.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") + "data: [DONE]\n\n" }).catch(() => {});
  };
  const finish = async (index, ask = false) => {
    const pending = held[index];
    assert(pending, `Expected held message ${index}`);
    const parts = ask ? [structuredClone(question)] : [{ type: "text", text: `Finished synthetic reply ${index + 1}.` }];
    const message = { id: `synthetic-reply-${index}`, role: "assistant", parts: [{ type: "step-start" }, ...parts] };
    history.push(message);
    receipts.set(pending.body.requestId, { requestId: pending.body.requestId, state: "completed", threadId: THREAD, busy: false });
    await stream(pending.route, message, parts);
    pending.resolve();
  };
  const serve = async (route) => {
    if (route.request().method() === "GET") {
      reads++;
      const requestId = new URL(route.request().url()).searchParams.get("requestId");
      const delivery = requestId ? receipts.get(requestId) ?? { requestId, state: "missing", threadId: null, busy: false } : undefined;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ current: { id: THREAD, busy: [...receipts.values()].some((x) => x.busy) }, items: history.map((message) => ({ thread: THREAD, message })), more: false, ...(delivery ? { delivery } : {}) }) });
    }
    const body = route.request().postDataJSON();
    if (new URL(route.request().url()).pathname.endsWith("/delivery")) {
      cancellations.push(body);
      assert.equal(body.action, "cancel");
      assert.equal(body.requestId, posts[0].requestId);
      const delivery = { requestId: body.requestId, state: mode === "cancel-loses" ? "received" : "cancelled", threadId: mode === "cancel-loses" ? THREAD : null, busy: false };
      receipts.set(body.requestId, delivery);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ delivery }) });
    }
    posts.push(body);
    if (body.message.role === "assistant") {
      assert.equal(body.requestId, undefined, "A question answer is not a replay of its user request");
      const last = history.at(-1);
      const answered = body.message.parts.find((p) => p.type === "tool-ask_user");
      last.parts = [{ ...question, state: "output-available", output: { status: "answered", choiceId: answered.output.choiceId, answer: "Left side" } }, { type: "text", text: "Thanks for answering." }];
      return stream(route, last, last.parts);
    }
    assert.equal(typeof body.requestId, "string", `User POST needs delivery identity: ${JSON.stringify(body)}`);
    assert(Number.isFinite(Date.parse(body.submittedAt)));
    if (["reject-first", "cancel-edit", "cancel-loses"].includes(mode) && posts.length === 1) return route.abort("internetdisconnected");
    assert(!receipts.has(body.requestId), "An accepted message must never replay");
    receipts.set(body.requestId, { requestId: body.requestId, state: "received", threadId: THREAD, busy: true });
    history.push({ ...body.message, parts: [...body.message.parts, { type: "data-delivery", data: { requestId: body.requestId, submittedAt: body.submittedAt } }] });
    return new Promise((resolve) => held.push({ route, body, resolve }));
  };
  const boundary = /\/api\/maple\/chat(?:[/?].*)?$/;
  await page.route(boundary, serve);
  const fresh = async (next) => {
    reset(next);
    await page.goto(`${url}/live.html`);
    await page.evaluate(() => { for (let i = localStorage.length - 1; i >= 0; i--) { const key = localStorage.key(i); if (key?.startsWith("maple-chat-drafts-v1:")) localStorage.removeItem(key); } });
    await page.reload();
    await page.waitForFunction(() => !document.body.textContent.includes("Loading your conversation…") && !document.body.textContent.includes("Updating your conversation…"));
  };
  const draft = () => page.getByRole("textbox", { name: "Message", exact: true });
  const send = async (text) => { await draft().fill(text); await page.getByRole("button", { name: /^(Send|Queue message)$/ }).click(); };
  const waitPosts = async (count) => { for (let i = 0; i < 100 && posts.length < count; i++) await page.waitForTimeout(50); assert.equal(posts.length, count); };
  try {
    await fresh("reject-first");
    await send("A synthetic note that must not disappear.");
    await page.getByText("No receipt found yet. Retry safely with the same message.", { exact: true }).waitFor();
    assert.equal(posts.length, 1, "Recovery reads, without replaying the failed POST");
    assert(reads >= 3);
    const queue = page.getByRole("region", { name: "Message queue" });
    assert((await queue.innerText()).includes("A synthetic note that must not disappear."));
    await draft().fill("A separate draft to preserve.");
    await queue.getByRole("button", { name: "Retry", exact: true }).click();
    await waitPosts(2);
    assert.equal(posts[1].requestId, posts[0].requestId, "An explicit retry keeps its idempotency key");
    assert.equal(posts[1].submittedAt, posts[0].submittedAt, "An explicit retry keeps the original event time");
    await finish(0);
    await page.getByText("Finished synthetic reply 1.", { exact: true }).waitFor();
    assert.equal(await draft().inputValue(), "A separate draft to preserve.");
    console.log("PASS real chat queue: unreceived sends remain visible; retry preserves identity, time and newer draft");

    await fresh("hold");
    await send("First synthetic instruction.");
    await waitPosts(1);
    await send("Second synthetic instruction.");
    await send("Third synthetic instruction.");
    assert.equal(posts.length, 1, "Only one request can be in flight");
    await page.getByRole("region", { name: "Message queue" }).getByRole("button", { name: "Discard", exact: true }).last().click();
    await page.getByRole("region", { name: "Message queue" }).getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("textbox", { name: "Edit queued message" }).fill("Second instruction, corrected.");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await finish(0, true);
    await page.getByRole("button", { name: "Left side", exact: true }).waitFor();
    assert.equal(posts.length, 1, "A question pauses queued instructions");
    await page.getByRole("button", { name: "Left side", exact: true }).click();
    await waitPosts(3);
    assert.equal(posts[2].message.parts[0].text, "Second instruction, corrected.");
    await finish(1);
    await page.getByText("Finished synthetic reply 2.", { exact: true }).waitFor();
    assert.equal(posts.length, 3, "One original request, one answer, one edited queued request");
    console.log("PASS real chat queue: sequential sends, edit/discard and pause until a question is answered");

    await fresh("hold");
    await send("Already accepted synthetic instruction.");
    await waitPosts(1);
    await send("Wait until I resume after reload.");
    await draft().fill("A draft survives reload.");
    await page.reload();
    await page.getByRole("region", { name: "Message queue" }).waitFor();
    assert.equal(await draft().inputValue(), "A draft survives reload.");
    assert.equal(posts.length, 1, "Reload checks the existing receipt, never resends it");
    await finish(0);
    await page.getByText("Finished synthetic reply 1.", { exact: true }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
    assert.equal(posts.length, 1, "Restored queued text waits for explicit resume");
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await waitPosts(2);
    await finish(1);
    await page.getByText("Finished synthetic reply 2.", { exact: true }).waitFor();
    console.log("PASS real chat queue: reload preserves draft, recovers accepted writes and requires resume");

    await fresh("cancel-edit");
    await send("An attempted instruction to correct.");
    await page.getByText("No receipt found yet. Retry safely with the same message.", { exact: true }).waitFor();
    await page.getByRole("region", { name: "Message queue" }).getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("textbox", { name: "Edit queued message" }).fill("A corrected instruction after safe cancellation.");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByRole("textbox", { name: "Edit queued message" }).waitFor({ state: "hidden" });
    await page.getByRole("region", { name: "Message queue" }).getByText("A corrected instruction after safe cancellation.", { exact: true }).waitFor();
    assert.equal(cancellations.length, 1, "An attempted message is cancelled on the server before its identity changes");
    assert.equal(receipts.get(posts[0].requestId).state, "cancelled");
    assert.equal(posts.length, 1, "Editing does not silently send a replacement");
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await waitPosts(2);
    assert.notEqual(posts[1].requestId, posts[0].requestId);
    await finish(0);
    await page.getByText("Finished synthetic reply 1.", { exact: true }).waitFor();

    await fresh("cancel-loses");
    await send("An instruction the server may already have received.");
    await page.getByText("No receipt found yet. Retry safely with the same message.", { exact: true }).waitFor();
    await page.getByRole("region", { name: "Message queue" }).getByRole("button", { name: "Discard", exact: true }).click();
    await page.getByText("This message was received, but its reply didn't finish. Check the log before continuing.", { exact: true }).waitFor();
    assert.equal(posts.length, 1);
    assert.equal(cancellations.length, 1);
    assert((await page.getByRole("region", { name: "Message queue" }).innerText()).includes("An instruction the server may already have received."));
    assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).count(), 0, "Accepted incomplete work cannot replay");
    console.log("PASS real chat queue: attempted edits require server cancellation; accepted work cannot be discarded or replayed");

    await fresh("hold");
    await page.evaluate(() => window.__chatLiveFixture.setOnline(false));
    for (let i = 0; i < 10; i++) await send(`Offline synthetic instruction ${i + 1}.`);
    await draft().fill("An eleventh instruction stays a draft.");
    assert(await page.getByRole("button", { name: "Queue message", exact: true }).isDisabled(), "Queue is bounded at ten items");
    assert.equal(posts.length, 0, "Offline queueing does not attempt network writes");
    await page.evaluate(() => window.__chatLiveFixture.setOnline(true));
    await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
    assert.equal(posts.length, 0, "Reconnection alone does not send old queued instructions");
    for (let i = 0; i < 9; i++) await page.getByRole("region", { name: "Message queue" }).getByRole("button", { name: "Discard", exact: true }).last().click();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await waitPosts(1);
    await finish(0);
    await page.getByText("Finished synthetic reply 1.", { exact: true }).waitFor();
    assert.equal(await draft().inputValue(), "An eleventh instruction stays a draft.");
    console.log("PASS real chat queue: bounded offline queue waits for explicit reconnect resume and preserves overflow draft");

    await fresh("chart");
    await page.getByRole("button", { name: "Refresh chart", exact: true }).waitFor();
    await draft().fill("An unfinished message while refreshing a chart.");
    await page.getByRole("button", { name: "Refresh chart", exact: true }).click();
    await waitPosts(1);
    assert.equal(await draft().inputValue(), "An unfinished message while refreshing a chart.");
    await finish(0);
    await page.getByText("Finished synthetic reply 1.", { exact: true }).waitFor();
    assert.equal(await draft().inputValue(), "An unfinished message while refreshing a chart.");
    console.log("PASS real chat queue: chart refresh preserves the composer draft");
  } finally {
    await page.unroute(boundary, serve);
    await page.evaluate(() => { for (let i = localStorage.length - 1; i >= 0; i--) { const key = localStorage.key(i); if (key?.startsWith("maple-chat-drafts-v1:")) localStorage.removeItem(key); } });
  }
}
