import { after, type NextRequest } from "next/server";
import { listMembers } from "@/lib/maple/auth";
import { BadRequest, json, readJson, withMember } from "@/lib/maple/api";
import { deviceOf } from "@/lib/maple/device";
import { getBaby } from "@/lib/maple/store";
import type { Member } from "@/lib/maple/types";
import { budgets, chatModel } from "@/lib/maple/chat/caps";
import { answerPost, type PostBody } from "@/lib/maple/chat/post";
import { priceFor } from "@/lib/maple/chat/prices";
import { chatStream, deleteChats, loadRecentMessages } from "@/lib/maple/chat/history";
import { countMessage, lockThread, recordUsage, releaseThread, saveMessage, setTitle, usageSince } from "@/lib/maple/chat/store";
import { chatLogState, chatTools } from "@/lib/maple/chat/tools";
import { chatConsent } from "@/lib/maple/consent";
import { captureServerException } from "@/lib/posthog-server";

/**
 * The in-app chat: Maple's MCP tools, run by the model as the signed-in
 * member ("via Maple chat"). POST streams one turn; GET reads this member's
 * one chat a page at a time, newest first (`before`: the oldest message
 * shown); DELETE removes all of it for good.
 *
 * Privacy: message text never reaches logs or PostHog. A POST's errors, in
 * the stream or before it, are logged and reported as their class name and
 * status only (`scrub` in chat/post.ts).
 */

export const maxDuration = 60;

const ROUTE = "/api/maple/chat";

const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function report(scrubbed: Error) {
  console.error(`${ROUTE} error: ${scrubbed.message}`);
  void captureServerException(scrubbed, { route: ROUTE });
}

export const GET = withMember("GET /api/maple/chat", async (request, member) => {
  const before = new URL(request.url).searchParams.get("before");
  if (before != null && !MESSAGE_ID_RE.test(before)) throw new BadRequest("before is not a message");
  return json(await chatStream(member.email, member.role === "viewer", before));
});

export const DELETE = withMember("DELETE /api/maple/chat", async (_request, member) => {
  await deleteChats(member.email, member.role === "viewer");
  return json({ ok: true });
});

export const POST = withMember("POST /api/maple/chat", async (request: NextRequest, member: Member) => {
  const body = await readJson<PostBody>(request);
  const model = chatModel();
  const now = new Date();
  return answerPost(body, member, {
    store: { consent: chatConsent, usageSince, lockThread, releaseThread, loadMessages: loadRecentMessages, saveMessage, setTitle, countMessage, recordUsage },
    household: async () => {
      const [baby, members] = await Promise.all([getBaby(), listMembers()]);
      return { baby, members };
    },
    model,
    modelKey: model,
    price: priceFor(model),
    tools: (opts) => chatTools(member, { ...opts, device: deviceOf(request) }),
    state: ({ care }) => chatLogState(member, { care, now }),
    budget: budgets(),
    now,
    report,
    waitUntil: (p) => after(() => p),
  });
});
