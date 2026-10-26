import { after, type NextRequest } from "next/server";
import { listMembers } from "@/lib/maple/auth";
import { BadRequest, json, readJson, withMember } from "@/lib/maple/api";
import { deviceOf } from "@/lib/maple/device";
import { getBaby } from "@/lib/maple/store";
import type { Member } from "@/lib/maple/types";
import { budgets, chatModel } from "@/lib/maple/chat/caps";
import { answerPost, type PostBody } from "@/lib/maple/chat/post";
import { priceFor } from "@/lib/maple/chat/prices";
import { countMessage, deleteThread, getThread, listThreads, loadMessages, lockThread, recordUsage, releaseThread, saveMessage, setTitle, usageSince } from "@/lib/maple/chat/store";
import { chatTools } from "@/lib/maple/chat/tools";
import { THREAD_ID_RE } from "@/lib/maple/chat/types";
import { captureServerException } from "@/lib/posthog-server";

/**
 * The in-app chat: Maple's MCP tools, run by the model as the signed-in
 * member ("via Maple chat"). POST streams one turn; GET lists this member's
 * threads (or one thread's messages); DELETE removes a thread for good.
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

export const GET = withMember("GET /api/maple/chat", async (request, member) => {
  const raw = new URL(request.url).searchParams.get("thread");
  const viewer = member.role === "viewer";
  if (raw == null) return json({ threads: await listThreads(member.email, viewer) });
  const thread = await getThread(threadParam(raw), member.email, viewer);
  if (!thread) return json({ error: "Not found" }, 404);
  return json({ thread, messages: await loadMessages(thread.id) });
});

export const DELETE = withMember("DELETE /api/maple/chat", async (request, member) => {
  const id = threadParam(new URL(request.url).searchParams.get("thread"));
  if (!(await deleteThread(id, member.email))) return json({ error: "Not found" }, 404);
  return json({ ok: true });
});

export const POST = withMember("POST /api/maple/chat", async (request: NextRequest, member: Member) => {
  const body = await readJson<PostBody>(request);
  const model = chatModel();
  return answerPost(body, member, {
    store: { usageSince, lockThread, releaseThread, loadMessages, saveMessage, setTitle, countMessage, recordUsage },
    household: async () => {
      const [baby, members] = await Promise.all([getBaby(), listMembers()]);
      return { baby, members };
    },
    model,
    modelKey: model,
    price: priceFor(model),
    tools: (opts) => chatTools(member, { ...opts, device: deviceOf(request) }),
    budget: budgets(),
    now: new Date(),
    report,
    waitUntil: (p) => after(() => p),
  });
});
