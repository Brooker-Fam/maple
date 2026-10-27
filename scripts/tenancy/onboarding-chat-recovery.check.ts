import assert from "node:assert/strict";
import { test } from "node:test";
import { missingConfirmation } from "../../src/components/maple/onboarding/proposals";
import type { OnboardingMessage } from "../../src/lib/maple/onboarding/steps";

const reply = (text: string): OnboardingMessage => ({ id: "synthetic-reply", role: "assistant", parts: [{ type: "text", text }] });

test("a promised confirmation without a proposal offers recovery while questions and valid proposals do not", () => {
  const missing = reply("Got it, nursing and pumping, no formula. Tap the chip to confirm.");
  assert.equal(missingConfirmation(missing), true);
  assert.equal(missingConfirmation(reply("I've got Synthetic Star Pediatrics at 202-555-0142. Tap the chip to confirm.")), true);
  assert.equal(missingConfirmation(reply("What time was Quinn born? It's fine if you don't know.")), false);
  assert.equal(missingConfirmation(reply("Are you nursing, pumping, using formula, or a mix?")), false);
  assert.equal(missingConfirmation(reply("Nothing is saved yet. Which name would you like?")), false);
  const proposal: OnboardingMessage = {
    ...missing,
    parts: [...missing.parts, { type: "tool-propose_feeding", toolCallId: "synthetic-feeding", state: "output-available", input: {}, output: { ok: true, kind: "answer", step: "feeding", value: { nursing: true, pumping: true, formula: false }, text: "Tap to confirm." } }],
  };
  assert.equal(missingConfirmation(proposal), false);
});
