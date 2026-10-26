import { after, type NextRequest } from "next/server";
import { createIdGenerator } from "ai";
import { listMembers } from "@/lib/maple/auth";
import { BadRequest, json, readJson, withMember } from "@/lib/maple/api";
import { memberName } from "@/lib/maple/insights";
import { getBaby } from "@/lib/maple/store";
import { dayBounds, dayKey, DEFAULT_TZ, startOfDay } from "@/lib/maple/time";
import type { Member } from "@/lib/maple/types";
import { budgets, capsVerdict, chatModel, threadFull } from "@/lib/maple/chat/caps";
import { mentionsCrisis } from "@/lib/maple/chat/crisis";
import { ChatInputError, denyPending, mergeApprovals, readIncoming, titleFrom, userMessage } from "@/lib/maple/chat/messages";
import { priceFor } from "@/lib/maple/chat/prices";
import { contextLine } from "@/lib/maple/chat/prompt";
import { deleteThread, getThread, listThreads, loadMessages, lockThread, recordUsage, releaseThread, saveMessage, setTitle, usageSince } from "@/lib/maple/chat/store";
import { chatTools } from "@/lib/maple/chat/tools";
import { CHAT_OFF, chatTurn } from "@/lib/maple/chat/turn";
import { THREAD_ID_RE, type ChatMessage, type ChatRefusal } from "@/lib/maple/chat/types";
import { captureServerException } from "@/lib/posthog-server";

/**
 * The in-app chat: Maple's MCP tools, run by the model as the signed-in
 * member ("via Maple chat"). POST streams one turn; GET lists this member's
 * threads (or one thread's messages); DELETE removes a thread for good.
 *
 * Privacy: message text never reaches logs or PostHog. Errors are reported
 * as their class name and status only.
 */

export const maxDuration = 60;

const ROUTE = "/api/maple/chat";
const newMessageId = createIdGenerator({ prefix: "msg", size: 16 });

const BUSY = "One message at a time: the last answer is still coming.";
const FULL = "This chat is long, so a new one starts here.";
const STALE = "That question has moved on. Ask again if you still want it.";

const refuse = (body: ChatRefusal, status: number) => json(body, status);

function threadParam(raw: unknown): string {
  if (typeof raw !== "string" || !THREAD_ID_RE.test(raw)) throw new BadRequest("thread is required");
  return raw;
}

/** An error's class and status, never its message: provider errors can quote the request. */
function scrub(error: unknown): Error {
  const e = error as { name?: unknown; statusCode?: unknown } | null;
  const name = typeof e?.name === "string" && /^[A-Za-z0-9_]{1,60}$/.test(e.name) ? e.name : "chat_error";
  return new Error(typeof e?.statusCode === "number" ? `${name} ${e.statusCode}` : name);
}

function report(error: unknown) {
  void captureServerException(scrub(error), { route: ROUTE });
}

export const GET = withMember("GET /api/maple/chat", async (request, member) => {
  const raw = new URL(request.url).searchParams.get("thread");
  if (raw == null) return json({ threads: await listThreads(member.email) });
  const thread = await getThread(threadParam(raw), member.email);
  if (!thread) return json({ error: "Not found" }, 404);
  return json({ thread, messages: await loadMessages(thread.id) });
});

export const DELETE = withMember("DELETE /api/maple/chat", async (request, member) => {
  const id = threadParam(new URL(request.url).searchParams.get("thread"));
  if (!(await deleteThread(id, member.email))) return json({ error: "Not found" }, 404);
  return json({ ok: true });
});

export const POST = withMember("POST /api/maple/chat", async (request: NextRequest, member: Member) => {
  const body = await readJson<{ threadId?: unknown; message?: unknown }>(request);
  const threadId = threadParam(body.threadId);
  let incoming;
  try {
    incoming = readIncoming(body.message);
  } catch (e) {
    if (e instanceof ChatInputError) return json({ error: e.message }, 400);
    throw e;
  }

  const model = chatModel();
  const price = priceFor(model);
  if (!price) {
    void captureServerException(new Error("chat_model_unpriced"), { route: ROUTE });
    return refuse({ error: CHAT_OFF, code: "off" }, 503);
  }

  const [baby, members] = await Promise.all([getBaby(), listMembers()]);
  const tz = baby.timezone || DEFAULT_TZ;
  const now = new Date();
  const today = dayKey(now, tz);
  const usage = await usageSince(member.email, dayBounds(today, tz), startOfDay(`${today.slice(0, 8)}01`, tz));
  const limit = capsVerdict(usage, { role: member.role, newMessage: incoming.kind === "user", budget: budgets() });
  if (limit) return refuse({ error: limit, code: "limit" }, 429);

  const thread = await lockThread(threadId, member.email, model);
  if (thread === "busy") return refuse({ error: BUSY, code: "busy" }, 409);
  if (thread === "missing") return json({ error: "Not found" }, 404);

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await releaseThread(thread.id).catch(report);
  };

  try {
    const history = await loadMessages(thread.id);
    let messages: ChatMessage[];
    let responseId: string;
    let crisis = false;
    if (incoming.kind === "user") {
      if (threadFull(thread)) {
        await release();
        return refuse({ error: FULL, code: "new_chat" }, 409);
      }
      const line = contextLine({ now, baby, name: memberName(member.email, members), role: member.role });
      const stored = userMessage(newMessageId(), incoming.text, line);
      const prior = denyPending(history);
      for (const m of prior.changed) await saveMessage(thread.id, member.email, m);
      await saveMessage(thread.id, member.email, stored);
      if (!thread.title) await setTitle(thread.id, titleFrom(incoming.text));
      messages = [...prior.messages, stored];
      responseId = newMessageId();
      crisis = mentionsCrisis(incoming.text);
    } else {
      const last = history[history.length - 1];
      const merged = last ? mergeApprovals(last, incoming.message) : null;
      if (!merged) {
        await release();
        return refuse({ error: STALE, code: "stale" }, 409);
      }
      messages = [...history.slice(0, -1), merged];
      responseId = merged.id;
    }
    return await chatTurn({
      model,
      modelKey: model,
      price,
      tools: chatTools(member, { born: !!baby.born_at }),
      viewer: member.role === "viewer",
      messages,
      responseId,
      crisis,
      deps: {
        save: (m) => saveMessage(thread.id, member.email, m),
        record: (u) => recordUsage({ ...u, member: member.email, threadId: thread.id, messageId: responseId, model }),
        release,
        report,
        waitUntil: (p) => after(() => p),
      },
    });
  } catch (e) {
    await release();
    throw e;
  }
});
