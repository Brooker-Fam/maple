import { isToolUIPart } from "ai";
import type { OnboardingMessage, Proposal, StepId } from "@/lib/maple/onboarding/steps";

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

