import { isToolUIPart } from "ai";
import type { OnboardingMessage, Proposal, StepId } from "@/lib/maple/onboarding/steps";

export function missingConfirmation(message: OnboardingMessage): boolean {
  if (message.role !== "assistant") return false;
  const hasProposal = message.parts.some((part) => isToolUIPart(part) && part.state === "output-available" && (part.output as Proposal).ok);
  const text = message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
  return !hasProposal && /\b(?:tap|click|press)\b[^.!?\n]{0,100}\b(?:confirm|chip)\b/i.test(text);
}

export function latestProposals(messages: OnboardingMessage[]): Partial<Record<StepId, string>> {
  let latest: Partial<Record<StepId, string>> = {};
  for (const message of messages) {
    if (message.role === "user") latest = {};
    for (const part of message.parts) {
      if (!isToolUIPart(part) || part.state !== "output-available") continue;
      const proposal = part.output as Proposal;
      if (proposal.ok && (proposal.kind === "answer" || proposal.kind === "skip")) latest[proposal.step] = part.toolCallId;
    }
  }
  return latest;
}

export function proposalState(id: string, latest: string | undefined, issuedVersion: number, currentVersion: number, saved: boolean): "pending" | "saved" | "replaced" {
  if ((id !== latest && (!saved || latest !== undefined)) || currentVersion !== issuedVersion + (saved ? 1 : 0)) return "replaced";
  return saved ? "saved" : "pending";
}

