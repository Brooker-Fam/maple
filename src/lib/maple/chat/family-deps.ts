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
import { chatTools } from "./tools";

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
    tools: (t) => chatTools(member, { ...t, fam: fam.familyId, device: opts.device }),
    budget: () => chatBudget(fam, opts.now),
    now: opts.now,
    report: opts.report,
    waitUntil: opts.waitUntil,
  };
}
