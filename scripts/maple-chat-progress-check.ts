import assert from "node:assert/strict";
import { chatActivity, hasQuestionAnswer, visibleRevision } from "../src/components/maple/chat/progress";
import type { ChatMessage } from "../src/lib/maple/chat/types";

const message = (parts: unknown[], role = "assistant") => ({ id: "synthetic-chat-message", role, parts }) as ChatMessage;
const tool = (name: string, state = "input-available", extra: Record<string, unknown> = {}) => ({ type: `tool-${name}`, toolCallId: `${name}-test`, state, input: {}, ...extra });
const busy = { busy: true, recovering: false, recoveryPaused: false };

assert.equal(chatActivity([message([{ type: "text", text: "A made-up question" }], "user")], busy), "Thinking…");
const hidden = message([{ type: "reasoning", text: "Synthetic hidden reasoning", state: "streaming" }]);
assert.equal(chatActivity([hidden], busy), "Thinking…", "hidden assistant parts keep an activity indicator");
assert.equal(visibleRevision(hidden), "", "reasoning does not force scroll updates");
assert.equal(chatActivity([message([tool("maple_status")])], busy), "Checking the log…");
assert.equal(chatActivity([message([tool("maple_status", "output-available", { output: { ok: true, write: false, text: "Synthetic log" } })])], busy), "Finishing your reply…", "read-only output stays visibly busy until the reply finishes");
assert.equal(chatActivity([message([tool("log_feed")])], busy), "Saving…");
assert.equal(chatActivity([message([tool("show_chart")])], busy), "Preparing your chart…");
assert.equal(chatActivity([message([tool("ask_user")])], { ...busy, busy: false }), null, "a ready question waits for the person without a spinner");
assert.equal(chatActivity([], { ...busy, recovering: true }), "Finishing your previous reply…");
assert.equal(chatActivity([], { ...busy, recovering: true, recoveryPaused: true }), "Waiting to reconnect…");

const answered = tool("ask_user", "output-available", { output: { choiceId: "left" } });
assert.equal(hasQuestionAnswer({ messages: [message([tool("log_feed", "output-available", { output: { ok: true } })])] }), false, "ordinary server tools never trigger another turn");
assert.equal(hasQuestionAnswer({ messages: [message([answered])] }), true);
assert.equal(hasQuestionAnswer({ messages: [message([answered, { ...tool("ask_user"), toolCallId: "second-question" }])] }), true, "persist a first answer while a second question is pending");
assert.equal(hasQuestionAnswer({ messages: [message([answered, tool("delete_entry", "approval-requested", { approval: { id: "synthetic-approval" } })])] }), true, "persist an answer while an approval is pending");
assert.equal(hasQuestionAnswer({ messages: [message([tool("ask_user", "output-available", { output: { status: "answered", answer: "Left", choiceId: "left" } })])] }), false, "server acknowledgement cannot auto-resume again");
assert.equal(hasQuestionAnswer({ messages: [message([answered, { type: "step-start" }, { type: "text", text: "Finished" }])] }), false, "an answer from an earlier step cannot retrigger");
assert.equal(hasQuestionAnswer({ messages: [message([tool("ask_user", "output-available", { output: { text: "A synthetic custom answer" } })])] }), true);

console.log("PASS chat progress: hidden work, recovery, scroll revisions and question continuation");
