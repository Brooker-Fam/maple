import { captureAppEvent } from "@/lib/analytics/server";
import type { LanguageModel } from "ai";
import { listMembers } from "../auth";
import { chatConsent } from "../consent";
import type { FamilyCtx } from "../family";
import { copyForFamily } from "../mcp-tools";
import { getBaby } from "../store";
import type { Member } from "../types";
import type { PostDeps } from "./post";
import { priceFor } from "./prices";
import { chatBudget, chatStore } from "./store";
import { chatLogState, chatTools } from "./tools";
import { resolveChatImages, validateChatImages } from "./image-store";
import { chatMemories } from "../memory/chat";

/**
 * Everything one chat POST reads, bound to the signed-in member's family:
 * its store, baby, people, words (copyForFamily) and budget. The route
 * passes the Gateway's model; a check passes a stand-in, so it runs the same
 * wiring the route does.
 */
export function familyPostDeps(
  fam: FamilyCtx,
  member: Member,
  opts: { model: LanguageModel; modelKey: string; device: string | null; now: Date } & Pick<PostDeps, "report" | "waitUntil">
): PostDeps {
  return {
    store: { consent: (m) => chatConsent(fam, m), ...chatStore(fam) },
    household: async () => {
      const [baby, members, copy] = await Promise.all([getBaby(fam), listMembers(fam), copyForFamily(fam)]);
      return { familyId: fam.familyId, baby, members, copy };
    },
    crisisNames: async () => {
      const baby = await getBaby(fam);
      return [baby.name, baby.nickname];
    },
    model: opts.model,
    modelKey: opts.modelKey,
    price: priceFor(opts.modelKey),
    images: {
      validate: (images) => validateChatImages(fam, member, images),
      resolve: (messages) => resolveChatImages(fam, member, messages),
    },
    tools: (t) => chatTools(member, { ...t, fam: fam.familyId, device: opts.device }),
    memories: (m) => chatMemories(fam, { threadId: m.threadId, viewer: m.viewer, members: m.members, now: opts.now, tz: fam.tz }),
    state: ({ care }) => chatLogState(member, { fam: fam.familyId, care, now: opts.now }),
    budget: () => chatBudget(fam, opts.now),
    now: opts.now,
    report: opts.report,
    waitUntil: opts.waitUntil,
    lifecycle: (event) => opts.waitUntil(captureAppEvent({ familyId: fam.familyId, member: member.email, role: member.role }, event)),
  };
}
