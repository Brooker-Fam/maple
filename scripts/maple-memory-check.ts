/**
 * pnpm check:maple-memory (with the tenancy suite `memories`): family
 * memories' rules on made-up records, no database. What a prompt carries and
 * in what order, when a memory applies, recall's matching, how input is
 * checked, and how the chat hides a forgotten past and memory ids.
 */
import assert from "node:assert/strict";
import { chatDisplayText } from "../src/lib/maple/chat/display";
import { userMessage } from "../src/lib/maple/chat/messages";
import { withMemoryLines } from "../src/lib/maple/chat/prompt";
import type { ChatMessage } from "../src/lib/maple/chat/types";
import { modelWindow } from "../src/lib/maple/chat/window";
import {
  fitMemories,
  memoryApplies,
  memoryLapsed,
  memoryPromptBlock,
  memoryRules,
  memoryStatusJson,
  promptRecord,
  queryTerms,
  recallMatches,
  recallRecord,
  reviewDue,
  type MemoryContext,
} from "../src/lib/maple/memory/policy";
import { cleanMemoryText, MemoryInputError, normalFact, parseMemoryRef, readMemoryInput, type MemoryRecord } from "../src/lib/maple/memory/types";
import { makeVoice } from "../src/lib/maple/voice";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

const TODAY = "2026-10-21";
let nextId = 1;
function made(fact: string, more: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: nextId++,
    kind: "feeding",
    fact,
    reason: null,
    status: "active",
    valid_from: null,
    valid_to: null,
    review_on: null,
    revision: 1,
    predecessor_id: null,
    said_by: "avery@example.com",
    via: "chat",
    source_text: null,
    source_words: false,
    stated_at: "2026-10-20T10:00:00.000Z",
    ended_at: null,
    ended_by: null,
    ended_via: null,
    updated_at: "2026-10-20T10:00:00.000Z",
    ...more,
  };
}
const names = (id: string | null) => (id === "avery@example.com" ? "Avery" : "Someone");
const ctx = (records: MemoryRecord[], state: Partial<MemoryContext["state"]> = {}): MemoryContext => ({
  state: { revision: 3, epoch: 1, capture: true, use: true, ...state },
  today: TODAY,
  tz: "America/Chicago",
  records,
});

check("a memory applies through its last day, whatever its first; a review date only asks", () => {
  assert(memoryApplies(made("a b"), TODAY));
  assert(memoryApplies(made("a b", { valid_to: TODAY }), TODAY), "its last day counts");
  assert(!memoryApplies(made("a b", { valid_to: "2026-10-20" }), TODAY));
  assert(memoryLapsed(made("a b", { valid_to: "2026-10-20" }), TODAY));
  assert(memoryApplies(made("a b", { valid_from: "2026-11-01" }), TODAY), "a plan ahead is known");
  assert(!memoryApplies(made("a b", { status: "resolved" }), TODAY));
  assert(reviewDue(made("a b", { review_on: TODAY }), TODAY));
  assert(!reviewDue(made("a b", { review_on: "2026-10-22" }), TODAY));
  assert(memoryApplies(made("a b", { review_on: "2026-01-01" }), TODAY), "a passed review date never ends one");
});

check("a prompt record leaves defaults out, in a fixed key order, with who said it where", () => {
  const m = made("June takes sensitive formula.", { id: 12, revision: 2, reason: "Gas", valid_to: "2026-12-01", review_on: "2026-10-01" });
  assert.deepEqual(Object.keys(promptRecord(m, TODAY, names)), ["id", "revision", "kind", "fact", "reason", "valid_to", "review_on", "review_due", "from", "saved"]);
  assert.deepEqual(promptRecord(m, TODAY, names), { id: "m12", revision: 2, kind: "feeding", fact: "June takes sensitive formula.", reason: "Gas", valid_to: "2026-12-01", review_on: "2026-10-01", review_due: true, from: "Avery in Maple chat", saved: "2026-10-20" });
  assert.deepEqual(Object.keys(promptRecord(made("x y"), TODAY, names)), ["id", "revision", "kind", "fact", "from", "saved"]);
});

check("what keeps the baby safe goes first, and a memory that doesn't fit is skipped whole and counted", () => {
  const records = [
    made("Background one.", { kind: "background" }),
    made("Allergic to amoxicillin.", { kind: "health" }),
    made("Bath on Sundays.", { kind: "routine" }),
    made("Ended one.", { kind: "health", valid_to: "2026-10-01" }),
  ];
  const all = fitMemories(records, TODAY, names);
  assert.deepEqual(all.shown.map((r) => r.kind), ["health", "routine", "background"]);
  assert.equal(all.omitted, 0);
  const tight = fitMemories([...records, made("y".repeat(400), { kind: "background" })], TODAY, names, 600);
  assert.equal(tight.shown[0].kind, "health", "health stays when room is short");
  assert(tight.omitted > 0);
  assert(tight.shown.every((r) => !String(r.fact).startsWith("yyy")), "never cut");
});

check("the chat's block: records as data, the switches spelled out, nothing when use is off", () => {
  const block = memoryPromptBlock(ctx([made("June takes sensitive formula.", { id: 5 })]), names, { viewer: false });
  assert(block.startsWith(`Family memories, as of ${TODAY} (America/Chicago).`));
  assert(block.includes('<family_memories>[{"id":"m5"'));
  assert(memoryPromptBlock(ctx([]), names, { viewer: false }).includes("No family memories are saved yet."));
  const off = memoryPromptBlock(ctx([made("Secret formula plan.")], { use: false }), names, { viewer: false });
  assert(!off.includes("Secret formula") && off.startsWith("Family memories are turned off"));
  assert(memoryPromptBlock(ctx([made("x y")], { capture: false }), names, { viewer: false }).includes("Saving memories from chats is turned off"));
  assert(memoryPromptBlock(ctx([made("x y")]), names, { viewer: true }).includes("can read the family's memories but not change them"));
  const status = memoryStatusJson(ctx([made("x y")], { use: false }), names, { viewer: false });
  assert.deepEqual(status, { off: true, note: "Family memories are turned off in Settings → Memories." });
});

check("the rules speak in the family's words and never name another family", () => {
  const vo = makeVoice({ name: "Ro", pronoun: "he", mom: null });
  const rules = memoryRules(vo, "mcp");
  assert(rules.includes("Ro's feeding plan") && rules.includes("his mom's own health"));
  assert(rules.includes("maple_status returns the current ones as family_memories"));
  assert(memoryRules(vo, "chat").includes("The newest message's [App] lines list the current ones as family_memories"));
  assert(!/\bMaple\b(?!'s Log| chat)/.test(rules), "the app's name never reads as a baby's");
});

check("recall: words with the same meaning match, history only when asked, best first, eight at most", () => {
  assert(queryTerms("what about her bottles?").includes("formula"), "bottle finds formula");
  assert(!queryTerms("what about the").length, "stop words alone search nothing");
  const records = [
    made("June takes sensitive formula.", { stated_at: "2026-10-01T00:00:00.000Z" }),
    made("June sleeps in the bassinet.", { kind: "sleep" }),
    made("Paced bottle feeding.", { status: "resolved" }),
  ];
  const now = recallMatches(records, { query: "bottle", kinds: [], history: false, today: TODAY });
  assert.deepEqual(now.matches.map((m) => m.fact), ["June takes sensitive formula."]);
  const all = recallMatches(records, { query: "bottle", kinds: [], history: true, today: TODAY });
  assert.deepEqual(all.matches.map((m) => m.fact), ["June takes sensitive formula.", "Paced bottle feeding."], "a current one first on a tie");
  assert.equal(recallMatches(records, { query: "", kinds: ["sleep"], history: false, today: TODAY }).total, 1);
  const many = Array.from({ length: 12 }, (_, i) => made(`Formula note ${i}.`));
  const page = recallMatches(many, { query: "formula", kinds: [], history: false, today: TODAY });
  assert.deepEqual([page.matches.length, page.total], [8, 12]);
  const ended = recallRecord(made("Wake to feed.", { valid_to: "2026-10-01", source_text: "wake her every 3 hours", source_words: true }), TODAY, names);
  assert.equal(ended.status, "ended");
  assert.equal(ended.their_words, "wake her every 3 hours");
});

check("input: placeholders and single words from a model are refused, dates are real days, text is one clean line", () => {
  const ok = readMemoryInput({ kind: "Care team", fact: "  Lactation\u0000 consultant\n visits Thursdays. ", reason: "none", valid_to: "2026-11-30", review_on: "null" }, { assistant: true });
  assert.deepEqual(ok, { kind: "care_team", fact: "Lactation consultant visits Thursdays.", reason: null, valid_from: null, valid_to: "2026-11-30", review_on: null });
  for (const fact of ["null", "N/A", "Yes"]) assert.throws(() => readMemoryInput({ kind: "routine", fact }, { assistant: true }), MemoryInputError, fact);
  assert.equal(readMemoryInput({ kind: "preference", fact: "Vegetarian" }, { assistant: false }).fact, "Vegetarian", "a person may write one word");
  assert.throws(() => readMemoryInput({ kind: "sleep", fact: "x y", valid_to: "2026-02-30" }, { assistant: false }), /date like/);
  assert.throws(() => readMemoryInput({ kind: "sleep", fact: "x y", valid_from: "2026-11-02", valid_to: "2026-11-01" }, { assistant: false }), /on or after/);
  assert.throws(() => readMemoryInput({ kind: "diary", fact: "x y" }, { assistant: false }), /kind must be/);
  assert.equal(cleanMemoryText("a\uD800b​c"), "a b​c");
  assert.equal(normalFact("June takes  FORMULA."), normalFact("june takes formula"));
  assert.deepEqual(["m12", "M12", "12", 12, "#12", "m0", "m-1", "x12", ""].map(parseMemoryRef), [12, 12, 12, 12, 12, null, null, null, null]);
});

check("after a Forget, the window drops the messages from before it but keeps whole exchanges and the newest one", () => {
  const LINE = "Now: made-up";
  const reply = (id: string, text: string): ChatMessage => ({ id, role: "assistant", parts: [{ type: "text", text }] });
  const thread = [userMessage("u1", "Remember she naps in the stroller", LINE), reply("a1", "Saved."), userMessage("u2", "Thanks", LINE), reply("a2", "Sure."), userMessage("u3", "And now?", LINE), reply("a3", "Here.")];
  assert.deepEqual(modelWindow(thread).map((m) => m.id), ["u1", "a1", "u2", "a2", "u3", "a3"]);
  assert.deepEqual(modelWindow(thread, new Set(["u1", "a1"])).map((m) => m.id), ["u2", "a2", "u3", "a3"]);
  assert.deepEqual(modelWindow(thread, new Set(["u1"])).map((m) => m.id), ["u2", "a2", "u3", "a3"], "an exchange cut through goes whole");
  assert.deepEqual(modelWindow(thread, new Set(["u1", "a1", "u2", "a2", "u3", "a3"])).map((m) => m.id), ["u3", "a3"], "the newest exchange always goes");
});

check("the memories ride on the newest user message as [App] lines, after its own, and nowhere else", () => {
  const LINE = "Now: made-up";
  const older = userMessage("u1", "Earlier words", LINE);
  const newest = userMessage("u2", "Newest words", LINE, ["The log as it stands."]);
  const out = withMemoryLines([older, { id: "a1", role: "assistant", parts: [{ type: "text", text: "Reply." }] }, newest], "Family memories, as of today.\n<family_memories>[]</family_memories>");
  assert.deepEqual(out[0], older, "older messages untouched");
  assert.deepEqual(out[2].parts.map((p) => p.type), ["data-context", "text", "text"]);
  assert.equal((out[2].parts[1] as { text: string }).text, "[App] Family memories, as of today.\n[App] <family_memories>[]</family_memories>");
  assert.equal((out[2].parts[2] as { text: string }).text, "Newest words", "the person's words still come last");
  assert.equal(newest.parts.length, 2, "the stored message isn't changed");
  assert.equal(withMemoryLines([newest], null)[0], newest, "no block, nothing added");
});

check("the chat never shows a memory id", () => {
  assert.equal(chatDisplayText("I saved that (m12)."), "I saved that.");
  assert.equal(chatDisplayText("Updated m12 to say so."), "Updated to say so.");
  assert.equal(chatDisplayText("Sleep from 5m to 2h"), "Sleep from 5m to 2h", "minutes stay");
});

console.log(`\n${passed} memory checks passed`);
