import { createIdGenerator } from "ai";
import { after, type NextRequest } from "next/server";
import { json, withMember } from "@/lib/maple/api";
import { chatModel } from "@/lib/maple/chat/caps";
import type { FamilyCtx } from "@/lib/maple/family";
import { answerOnboardingChat, familyChatDeps } from "@/lib/maple/onboarding/chat";
import type { Member } from "@/lib/maple/types";
import { captureServerException } from "@/lib/posthog-server";

/**
 * The onboarding chat: the in-app chat's model, ZDR options, crisis check,
 * terms, caps and usage rows, with onboarding's own prompt and proposal-only
 * tools (src/lib/maple/onboarding/). Message text never reaches logs or
 * PostHog; errors are reported as their class and status only.
 */

export const maxDuration = 60;

const ROUTE = "/api/maple/onboarding/chat";
const newId = createIdGenerator({ prefix: "msg", size: 16 });

export const POST = withMember(`POST ${ROUTE}`, async (request: NextRequest, member: Member, ctx: FamilyCtx) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected a message" }, 400);
  }
  const model = chatModel();
  return answerOnboardingChat(
    body,
    member,
    familyChatDeps(ctx, member, {
      model,
      modelKey: model,
      now: new Date(),
      newId,
      report: (scrubbed) => {
        console.error(`${ROUTE} error: ${scrubbed.message}`);
        void captureServerException(scrubbed, { route: ROUTE });
      },
      waitUntil: (p) => after(() => p),
    })
  );
}, { setup: true });
