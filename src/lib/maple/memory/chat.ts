import type { FamilyScope } from "../family";
import { memberName } from "../insights";
import type { Member } from "../types";
import type { ChatMemories } from "../chat/post";
import { memoryPromptBlock } from "./policy";
import { forgottenMessageIds, memoryContext } from "./store";

/**
 * What one chat turn reads of the family's memories: the block after its
 * instructions (as of now, in the family's clock), the epoch its memory
 * writes are checked against, and this thread's messages from before the
 * last Forget, which the model doesn't read again.
 */
export async function chatMemories(
  fam: Pick<FamilyScope, "familyId">,
  opts: { threadId: string; viewer: boolean; members: Member[]; now: Date; tz: string }
): Promise<ChatMemories> {
  const [ctx, forgotten] = await Promise.all([memoryContext(fam, { now: opts.now, tz: opts.tz }), forgottenMessageIds(fam, opts.threadId)]);
  return {
    block: memoryPromptBlock(ctx, (id) => memberName(id, opts.members), { viewer: opts.viewer }),
    epoch: ctx.state.epoch,
    forgotten,
  };
}
