import { query } from "@/lib/db";
import type { FamilyScope } from "../family";
import { StoreUnavailable } from "../store";
import type { ChatMessage } from "./types";
import { HISTORY_LOAD, STREAM_PAGE, streamPage, type StreamItem } from "./window";

/**
 * A member's one chat as the phone reads it: every thread they can open in
 * this family (a viewer, only those that ran as a viewer) as one stream,
 * newest thread last. Threads stay the server's unit: a new one starts when
 * her page closes to the chat (care_open), so nothing from the one before
 * reaches the model. Another family's threads read as none at all.
 */

type Fam = Pick<FamilyScope, "familyId">;

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
export async function loadRecentMessages(fam: Fam, threadId: string, limit = HISTORY_LOAD): Promise<ChatMessage[]> {
  const r = await rows(
    `SELECT id, role, parts FROM (SELECT id, role, parts, seq FROM maple_chat_messages WHERE thread_id = $1 AND family_id = $2 ORDER BY seq DESC LIMIT $3) m ORDER BY seq`,
    [threadId, fam.familyId, limit]
  );
  return r.map(messageOf);
}

export type ChatStream = {
  /** The thread new messages go to: their newest, or null to start one. `busy` while a turn is still running in it. */
  current: { id: string; busy: boolean } | null;
  items: StreamItem[];
  /** Older messages remain: ask again with `before` set to the first item's id. */
  more: boolean;
};

export async function chatStream(fam: Fam, member: string, viewer: boolean, before: string | null, size = STREAM_PAGE): Promise<ChatStream> {
  const visible = `t.family_id = $1 AND t.member = $2 AND (t.viewer_only OR NOT $3)`;
  const [head, page] = await Promise.all([
    rows(`SELECT t.id, COALESCE(t.busy_until > NOW(), FALSE) AS busy FROM maple_chat_threads t WHERE ${visible} ORDER BY busy DESC, t.updated_at DESC LIMIT 1`, [fam.familyId, member, viewer]),
    rows(
      `SELECT m.id, m.role, m.parts, m.thread_id FROM maple_chat_messages m JOIN maple_chat_threads t ON t.id = m.thread_id AND t.family_id = m.family_id
       WHERE ${visible} AND ($4::text IS NULL OR (m.created_at, m.seq) < (SELECT c.created_at, c.seq FROM maple_chat_messages c WHERE c.id = $4 AND c.family_id = $1 AND c.member = $2))
       ORDER BY m.created_at DESC, m.seq DESC LIMIT $5`,
      [fam.familyId, member, viewer, before, size + 1]
    ),
  ]);
  const { items, more } = streamPage(
    page.map((m) => ({ thread: String(m.thread_id), message: messageOf(m) })),
    size
  );
  return { current: head.length ? { id: String(head[0].id), busy: head[0].busy === true } : null, items, more };
}

/** Deletes every thread this member can open in this family, for good. Usage rows and the day's count stay. */
export async function deleteChats(fam: Fam, member: string, viewer: boolean): Promise<number> {
  // Keep only non-content delivery receipts so a lost acknowledgement cannot replay a write after deletion.
  // A running turn keeps its member lease until it finishes, even if its conversation is deleted.
  return (await rows(`WITH removed AS (
    DELETE FROM maple_chat_threads t WHERE t.family_id = $1 AND t.member = $2 AND (t.viewer_only OR NOT $3) RETURNING t.id
  ), detached AS (
    UPDATE maple_chat_deliveries SET thread_id = NULL WHERE family_id = $1 AND member = $2 AND thread_id IN (SELECT id FROM removed)
  ) SELECT id FROM removed`, [fam.familyId, member, viewer])).length;
}
