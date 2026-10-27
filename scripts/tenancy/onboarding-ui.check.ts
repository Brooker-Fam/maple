import assert from "node:assert/strict";
import { test } from "node:test";
import { finishSetup, openSetupWhenReady } from "../../src/components/maple/onboarding/actions";
import { latestProposals, proposalState } from "../../src/components/maple/onboarding/proposals";
import { birthFields } from "../../src/components/maple/onboarding/describe";
import type { OnboardingMessage, OnboardingView } from "../../src/lib/maple/onboarding/steps";

const message = (id: string, role: string): OnboardingMessage => ({ id, role: "assistant", parts: [{ type: "tool-propose_you", toolCallId: id, state: "output-available", input: {}, output: { ok: true, kind: "answer", step: "you", value: { name: "Avery", role_word: role }, text: role } }] });

test("a correction retires the earlier confirmation, including an earlier saved chip", () => {
  const latest = latestProposals([message("old", "Parent"), message("new", "Papa")]);
  assert.equal(proposalState("old", latest.you, 0, 0, false), "replaced");
  assert.equal(proposalState("old", latest.you, 0, 0, true), "replaced");
  assert.equal(proposalState("new", latest.you, 0, 0, false), "pending");
});

test("a correction retires an unconfirmed answer even when the model returns no new chip", () => {
  const correction: OnboardingMessage = { id: "correction", role: "user", parts: [{ type: "text", text: "Papa instead" }] };
  const latest = latestProposals([message("old", "Parent"), correction]);
  assert.equal(proposalState("old", latest.you, 0, 0, false), "replaced");
  assert.equal(proposalState("old", latest.you, 0, 1, true), "saved");
});

test("saving the question card retires its outstanding chat proposal", () => {
  assert.equal(proposalState("proposal", "proposal", 0, 1, false), "replaced");
  assert.equal(proposalState("proposal", "proposal", 0, 1, true), "saved");
  assert.equal(proposalState("proposal", "proposal", 0, 2, true), "replaced");
});

test("notification setup waits for successful completion and loaded app state", async () => {
  const calls: boolean[] = [];
  await finishSetup(async () => false, (requested) => calls.push(requested), true);
  assert.equal(calls.length, 0);
  await finishSetup(async () => true, (requested) => calls.push(requested), true);
  assert.deepEqual(calls, [true]);
  let opens = 0;
  const open = () => { opens++; };
  assert.equal(openSetupWhenReady(calls[0], false, open), false);
  assert.equal(opens, 0);
  assert.equal(openSetupWhenReady(calls[0], true, open), true);
  assert.equal(opens, 1);
  assert.equal(openSetupWhenReady(false, true, open), false);
  assert.equal(opens, 1);
});

test("editing birth preserves the saved local time and an explicitly unknown time", () => {
  const view = { values: { timezone: { timezone: "America/New_York", units: "us" }, baby: { born_at: "2026-10-22T07:10:00.000Z", birth_time_known: true } } } as OnboardingView;
  assert.deepEqual(birthFields(view), { date: "2026-10-22", time: "03:10", unknownTime: false });
  view.values.baby!.birth_time_known = false;
  assert.deepEqual(birthFields(view), { date: "2026-10-22", time: "", unknownTime: true });
});
