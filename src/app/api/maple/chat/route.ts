import { after, type NextRequest } from "next/server";
import { BadRequest, json, readJson, withMember } from "@/lib/maple/api";
import { deviceOf } from "@/lib/maple/device";
import type { FamilyCtx } from "@/lib/maple/family";
import type { Member } from "@/lib/maple/types";
import { chatModel } from "@/lib/maple/chat/caps";
import { answerPost, type PostBody } from "@/lib/maple/chat/post";
import { familyPostDeps } from "@/lib/maple/chat/family-deps";
import { deleteThread, getThread, listThreads, loadMessages } from "@/lib/maple/chat/store";
import { THREAD_ID_RE } from "@/lib/maple/chat/types";
import { captureServerException } from "@/lib/posthog-server";

/**
 * The in-app chat: Maple's MCP tools, run by the model as the signed-in
 * member ("via Maple chat"), in the family their session names. POST streams
 * one turn; GET lists this member's threads in this family (or one thread's
 * messages); DELETE removes a thread for good. Another family's thread
 * answers 404, like one that isn't there.
 *
 * Privacy: message text never reaches logs or PostHog. A POST's errors, in
 * the stream or before it, are logged and reported as their class name and
 * status only (`scrub` in chat/post.ts).
 */

export const maxDuration = 60;

const ROUTE = "/api/maple/chat";

function threadParam(raw: unknown): string {
  if (typeof raw !== "string" || !THREAD_ID_RE.test(raw)) throw new BadRequest("thread is required");
  return raw;
}

function report(scrubbed: Error) {
  console.error(`${ROUTE} error: ${scrubbed.message}`);
  void captureServerException(scrubbed, { route: ROUTE });
}

export const GET = withMember("GET /api/maple/chat", async (request, member, fam) => {
  const raw = new URL(request.url).searchParams.get("thread");
  const viewer = member.role === "viewer";
  if (raw == null) return json({ threads: await listThreads(fam, member.email, viewer) });
  const thread = await getThread(fam, threadParam(raw), member.email, viewer);
  if (!thread) return json({ error: "Not found" }, 404);
  return json({ thread, messages: await loadMessages(fam, thread.id) });
});

export const DELETE = withMember("DELETE /api/maple/chat", async (request, member, fam) => {
  const id = threadParam(new URL(request.url).searchParams.get("thread"));
  if (!(await deleteThread(fam, id, member.email))) return json({ error: "Not found" }, 404);
  return json({ ok: true });
});

export const POST = withMember("POST /api/maple/chat", async (request: NextRequest, member: Member, fam: FamilyCtx) => {
  const body = await readJson<PostBody>(request);
  const model = chatModel();
  return answerPost(
    body,
    member,
    familyPostDeps(fam, member, { model, modelKey: model, device: deviceOf(request), now: new Date(), report, waitUntil: (p) => after(() => p) })
  );
});
