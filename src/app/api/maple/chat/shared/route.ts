import { BadRequest, json, readJson, withMember } from "@/lib/maple/api";
import { listMembers } from "@/lib/maple/auth";
import { chatModel } from "@/lib/maple/chat/caps";
import { addSharedPeople, createSharedChat, leaveSharedChat, listSharedChats, SharedChatError } from "@/lib/maple/chat/shared";
import { CHAT_TERMS_NEEDED, THREAD_ID_RE } from "@/lib/maple/chat/types";
import { chatConsent } from "@/lib/maple/consent";

export const dynamic = "force-dynamic";

/**
 * Shared chats (chat/shared.ts): GET lists the ones this member is in and can
 * open; POST { action: "create", people, name? } starts one with the people
 * they picked, { action: "add", id, people } adds people to one they're in,
 * and { action: "leave", id } leaves one (the last one out deletes it).
 * Starting one or adding people needs the chat's terms; anyone the chat is
 * on for can be in one. Its messages are read with GET /api/maple/chat?thread=.
 */

const idOf = (raw: unknown): string => {
  if (typeof raw !== "string" || !THREAD_ID_RE.test(raw)) throw new BadRequest("id must be a shared chat's id");
  return raw;
};

export const GET = withMember("GET /api/maple/chat/shared", async (_request, member, fam) => json({ chats: await listSharedChats(fam, member) }), { part: ["chat", "view"] });

export const POST = withMember("POST /api/maple/chat/shared", async (request, member, fam) => {
  const body = await readJson(request);
  try {
    if (body.action === "leave") {
      await leaveSharedChat(fam, member, idOf(body.id));
      return json({ ok: true });
    }
    if (body.action !== "create" && body.action !== "add") throw new BadRequest("action must be create, add or leave");
    if (!(await chatConsent(fam, member)).terms) return json({ error: CHAT_TERMS_NEEDED, code: "terms" }, 403);
    const members = await listMembers(fam);
    if (body.action === "create") {
      return json({ chat: await createSharedChat(fam, member, { people: body.people, name: body.name, model: chatModel(), members }) }, 201);
    }
    return json({ chat: await addSharedPeople(fam, member, idOf(body.id), { people: body.people, members }) });
  } catch (error) {
    if (error instanceof SharedChatError) return json({ error: error.message }, error.status);
    throw error;
  }
}, { part: ["chat", "view"] });
