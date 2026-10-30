import assert from "node:assert/strict";
import path from "node:path";
import { environment, origin, screenshots } from "./environment.mjs";

/** Settings → Memories on made-up records: what shows, in what order, what a member and a viewer can do. */
const env = await environment();
const open = async (f) => {
  await f.page.goto(`${origin}/#family/memories`);
  await f.page.getByRole("heading", { level: 1, name: "Memories", exact: true }).waitFor();
  await f.page.getByText("Sam does the 2am feed on weeknights.").waitFor();
};
/** What the page sent to /api/maple/memories, in order. */
const sent = (f) => f.controls.requests.filter((r) => r.path === "/api/maple/memories").map((r) => r.body);

const cases = [
  ["A member reaches Memories from Settings and sees current memories, health first, with their dates and sources", async () => {
    const f = await env.visit({ hash: "family" });
    try {
      await f.page.getByRole("button", { name: /^Memories/ }).click();
      await f.page.getByRole("heading", { level: 1, name: "Memories", exact: true }).waitFor();
      await f.page.getByText("Sam does the 2am feed on weeknights.").waitFor();
      const current = await f.page.getByRole("list").first().locator(":scope > li").allTextContents();
      assert.equal(current.length, 3, "an ended memory isn't current");
      assert.match(current[0], /^Health · Until Tue, Nov 3River's pediatrician/);
      assert.match(current[1], /^Feeding · Check again Sun, Nov 15River takes a sensitive formula/);
      assert.match(current[1], /Why: Gas and fussiness after feeds“the sensitive one works way better for her”Sam in Maple chat · Thu, Oct 22/);
      assert.match(current[0], /Note: Saved because .*Sam in Claude/);
      await f.page.screenshot({ path: path.join(screenshots, "memories-member.png"), fullPage: true });
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Add saves a memory with its kind and dates, and an edit from an old revision shows the newer words", async () => {
    const f = await env.visit({ hash: "family" });
    try {
      await open(f);
      await f.page.getByRole("button", { name: "Add", exact: true }).click();
      await f.page.getByRole("group", { name: "What it's about" }).getByRole("button", { name: "Care team", exact: true }).click();
      await f.page.getByLabel("What to remember").fill("Our lactation consultant visits on Thursdays.");
      await f.page.getByLabel("Last day").fill("2026-12-31");
      await f.page.screenshot({ path: path.join(screenshots, "memories-add.png"), fullPage: true });
      await f.page.getByRole("button", { name: "Save", exact: true }).click();
      await f.page.getByText("Our lactation consultant visits on Thursdays.").waitFor();
      const saved = sent(f).find((b) => b.action === "save").memory;
      assert.deepEqual(saved, { kind: "care_team", fact: "Our lactation consultant visits on Thursdays.", reason: null, valid_from: null, valid_to: "2026-12-31", review_on: null });
      f.controls.memoryConflict = true;
      const card = f.page.getByRole("listitem").filter({ hasText: "Sam does the 2am feed" });
      await card.getByRole("button", { name: "Edit", exact: true }).click();
      await f.page.getByLabel("What to remember").fill("Sam does the 2am and 5am feeds.");
      await f.page.getByRole("button", { name: "Save", exact: true }).click();
      await f.page.getByText("Someone else's newer words.").waitFor();
      await f.page.getByText("Someone changed that memory just now.").first().waitFor();
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Forget asks first, then sends only that memory", async () => {
    const f = await env.visit({ hash: "family" });
    try {
      await open(f);
      const card = f.page.getByRole("listitem").filter({ hasText: "Sam does the 2am feed" });
      await card.getByRole("button", { name: "Forget", exact: true }).click();
      await card.getByText("Forget it, with its earlier versions?").waitFor();
      assert.equal(sent(f).length, 0, "nothing sent yet");
      await card.getByRole("button", { name: "Forget", exact: true }).click();
      await f.page.getByText("Sam does the 2am feed on weeknights.").waitFor({ state: "detached" });
      assert.deepEqual(sent(f), [{ action: "forget", id: 1 }]);
      await f.page.getByRole("button", { name: /^Earlier memories/ }).click();
      await f.page.getByText("River takes regular formula.").waitFor();
      await f.page.getByText(/Replaced Thu, Oct 22 by Sam/).waitFor();
      await f.page.getByText(/Ended Sun, Oct 25/).waitFor();
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["A viewer reads memories with no way to change them", async () => {
    const f = await env.visit({ hash: "family", role: "viewer", theme: "dark" });
    try {
      await open(f);
      for (const name of ["Add", "Edit", "Mark resolved", "Archive", "Forget", "Forget all memories"]) assert.equal(await f.page.getByRole("button", { name, exact: true }).count(), 0, name);
      assert.equal(await f.page.getByRole("switch", { name: "Let chats save memories" }).isDisabled(), true);
      await f.page.getByText(/You can read them; Sam can change them\./).waitFor();
      await f.page.screenshot({ path: path.join(screenshots, "memories-viewer-dark.png"), fullPage: true });
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["The switches send one change each and read back", async () => {
    const f = await env.visit({ hash: "family", theme: "night" });
    try {
      await open(f);
      await f.page.getByRole("switch", { name: "Let chats save memories" }).click();
      await f.page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Let chats save memories"]')?.getAttribute("aria-checked") === "false");
      assert.deepEqual(sent(f), [{ action: "switches", capture: false }]);
      await f.page.screenshot({ path: path.join(screenshots, "memories-night.png"), fullPage: true });
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["A memory the chat saved shows as a card that opens Memories", async () => {
    const f = await env.visit();
    try {
      const thread = "synthetic-memory-thread";
      const user = { id: "msg_user_1", role: "user", parts: [{ type: "data-context", data: { line: "Now: made-up" } }, { type: "text", text: "Remember she does better on the sensitive formula" }] };
      const output = { ok: true, write: true, text: 'Remembered m9 for the family: "River takes a sensitive formula." Everyone in the family can see it in Settings → Memories.', memory: { status: "saved", kind: "feeding", fact: "River takes a sensitive formula." } };
      const reply = { id: "msg_reply_1", role: "assistant", parts: [{ type: "tool-save_memory", toolCallId: "call_memory_1", state: "output-available", input: { kind: "feeding", fact: "River takes a sensitive formula." }, output }, { type: "text", text: "Saved that for the family (m9)." }] };
      f.controls.chatStream = { current: { id: thread, busy: false }, items: [{ thread, message: user }, { thread, message: reply }], more: false };
      await f.page.goto(`${origin}/#chat`);
      const card = f.page.getByRole("region", { name: "Remembered for the family" });
      await card.getByText("River takes a sensitive formula.").waitFor();
      assert.equal(await f.page.getByText("(m9)").count(), 0, "the id never shows");
      await f.page.getByText("Saved that for the family.").waitFor();
      await f.page.screenshot({ path: path.join(screenshots, "memories-chat-card.png") });
      await card.getByRole("button", { name: /Everyone in the family can see it in Memories/ }).click();
      await f.page.getByRole("heading", { level: 1, name: "Memories", exact: true }).waitFor();
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Photos-only guests have no Memories row", async () => {
    const f = await env.visit({ hash: "family", role: "photos" });
    try {
      await f.page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
      assert.equal(await f.page.getByRole("button", { name: /^Memories/ }).count(), 0);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
];

let failed = 0;
for (const [name, run] of cases) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`);
  }
}
await env.close();
if (failed) process.exit(1);
