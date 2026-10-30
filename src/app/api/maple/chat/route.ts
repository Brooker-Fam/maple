import { after, type NextRequest } from "next/server";
import { BadRequest, json, readJson, withMember } from "@/lib/maple/api";
import { deviceOf } from "@/lib/maple/device";
import type { FamilyCtx } from "@/lib/maple/family";
import type { Member } from "@/lib/maple/types";
import { chatModel } from "@/lib/maple/chat/caps";
import { answerPost, type PostBody } from "@/lib/maple/chat/post";
import { familyPostDeps } from "@/lib/maple/chat/family-deps";
import { chatStream, deleteChats } from "@/lib/maple/chat/history";
import { CHAT_REQUEST_ID_RE } from "@/lib/maple/chat/delivery";
import { deliveryStatus } from "@/lib/maple/chat/delivery-store";
import { forgetChatWords } from "@/lib/maple/memory/store";
import { captureServerException } from "@/lib/posthog-server";

/**
 * The in-app chat: Maple's MCP tools, run by the model as the signed-in
 * member ("via Maple chat"), in the family their session names. POST streams
 * one turn; GET reads this member's one chat in this family a page at a time,
 * newest first (`before`: the oldest message shown); DELETE removes all of it
 * for good. Another family's threads read as none at all.
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

export const GET = withMember("GET /api/maple/chat", async (request, member, fam) => {
  const params = new URL(request.url).searchParams;
  const before = params.get("before");
  const requestId = params.get("requestId");
  if (before != null && !MESSAGE_ID_RE.test(before)) throw new BadRequest("before is not a message");
  if (requestId != null && !CHAT_REQUEST_ID_RE.test(requestId)) throw new BadRequest("requestId is not a delivery reference");
  const [stream, delivery] = await Promise.all([
    chatStream(fam, member.email, member.role === "viewer", before),
    requestId ? deliveryStatus(fam, member.email, member.role === "viewer", requestId) : null,
  ]);
  return json({ ...stream, ...(delivery ? { delivery } : {}) });
});

export const DELETE = withMember("DELETE /api/maple/chat", async (_request, member, fam) => {
  await deleteChats(fam, member.email, member.role === "viewer");
  // Their words quoted with the family's memories came from this chat, so they go with it; the memories stay.
  await forgetChatWords(fam, member.email);
  return json({ ok: true });
});

export const POST = withMember("POST /api/maple/chat", async (request: NextRequest, member: Member, fam: FamilyCtx) => {
  const body = await readJson<PostBody>(request);
  const model = chatModel();
  const response = await answerPost(
    body,
    member,
    familyPostDeps(fam, member, { model, modelKey: model, device: deviceOf(request), now: new Date(), report, waitUntil: (p) => after(() => p) })
  );
  return response;
});
