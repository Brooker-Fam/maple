import { query } from "@/lib/db";
import { StoreUnavailable } from "../store";
import type { ChatMessage } from "./types";
import { HISTORY_LOAD, STREAM_PAGE, streamPage, type StreamItem } from "./window";

/**
 * A member's one chat as the phone reads it: every thread they can open
 * (a viewer, only those that ran as a viewer) as one stream, newest thread
 * last. Threads stay the server's unit: a new one starts when her page closes
 * to the chat (care_open), so nothing from the one before reaches the model.
 */

async function rows(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const r = await query(sql, params);
  if (r === null) throw new StoreUnavailable();
  return r as Record<string, unknown>[];
}

const messageOf = (m: Record<string, unknown>): ChatMessage => ({
  id: String(m.id),
  role: m.role as "user" | "assistant",
  parts: Array.isArray(m.parts) ? (m.parts as ChatMessage["parts"]) : [],
});

/** The newest messages of one thread, oldest first: the most a turn reads. */
export async function loadRecentMessages(threadId: string, limit = HISTORY_LOAD): Promise<ChatMessage[]> {
  const r = await rows(`SELECT id, role, parts FROM (SELECT id, role, parts, seq FROM maple_chat_messages WHERE thread_id = $1 ORDER BY seq DESC LIMIT $2) m ORDER BY seq`, [threadId, limit]);
  return r.map(messageOf);
}

export type ChatStream = {
  /** The thread new messages go to: their newest, or null to start one. `busy` while a turn is still running in it. */
  current: { id: string; busy: boolean } | null;
  items: StreamItem[];
  /** Older messages remain: ask again with `before` set to the first item's id. */
  more: boolean;
};

export async function chatStream(member: string, viewer: boolean, before: string | null, size = STREAM_PAGE): Promise<ChatStream> {
  const visible = `t.member = $1 AND (t.viewer_only OR NOT $2)`;
  const [head, page] = await Promise.all([
    rows(`SELECT t.id, COALESCE(t.busy_until > NOW(), FALSE) AS busy FROM maple_chat_threads t WHERE ${visible} ORDER BY t.updated_at DESC LIMIT 1`, [member, viewer]),
    rows(
      `SELECT m.id, m.role, m.parts, m.thread_id FROM maple_chat_messages m JOIN maple_chat_threads t ON t.id = m.thread_id
       WHERE ${visible} AND ($3::text IS NULL OR (m.created_at, m.seq) < (SELECT c.created_at, c.seq FROM maple_chat_messages c WHERE c.id = $3 AND c.member = $1))
       ORDER BY m.created_at DESC, m.seq DESC LIMIT $4`,
      [member, viewer, before, size + 1]
    ),
  ]);
  const { items, more } = streamPage(
    page.map((m) => ({ thread: String(m.thread_id), message: messageOf(m) })),
    size
  );
  return { current: head.length ? { id: String(head[0].id), busy: head[0].busy === true } : null, items, more };
}

/** Deletes every thread this member can open, for good. Usage rows and the day's count stay. */
export async function deleteChats(member: string, viewer: boolean): Promise<number> {
  return (await rows(`DELETE FROM maple_chat_threads t WHERE t.member = $1 AND (t.viewer_only OR NOT $2) RETURNING t.id`, [member, viewer])).length;
}
