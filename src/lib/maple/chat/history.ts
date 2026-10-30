import { query, transaction } from "@/lib/db";
import { careLevelOf } from "../access";
import type { FamilyScope } from "../family";
import { StoreUnavailable } from "../store";
import type { Member } from "../types";
import type { ChatMessage } from "./types";
import { HISTORY_LOAD, STREAM_PAGE, streamPage, type StreamItem } from "./window";

/**
 * A member's one chat as the phone reads it: every thread they can open in
 * this family (a viewer, only those that ran as a viewer; someone her page
 * is hidden from, only those that never ran with it open) as one stream,
 * newest thread last. Threads stay the server's unit: a new one starts when
 * her page closes to the chat (care_open), so nothing from the one before
 * reaches the model. Another family's threads read as none at all.
 */

type Fam = Pick<FamilyScope, "familyId">;

/**
 * Which of their threads a member can open now: `viewer`, only those that ran
 * as a viewer throughout; `careHidden` (an owner set her page to none for
 * them), only those that never ran with her page open, since those can quote
 * her medicines. A thread that ran as a viewer throughout never had her page
 * open (the chat never opens it to a viewer), whatever `care_open` says: older
 * threads all read as open. A bare boolean is the viewer flag alone.
 */
export type ThreadAccess = { viewer: boolean; careHidden: boolean };

export const threadAccess = (member: Pick<Member, "role" | "care">): ThreadAccess => ({ viewer: member.role === "viewer", careHidden: careLevelOf(member) === "none" });

export const asThreadAccess = (open: boolean | ThreadAccess): ThreadAccess => (typeof open === "boolean" ? { viewer: open, careHidden: false } : open);

/** The SQL test for a thread `t` this member can open: `v` is the viewer flag's parameter, `h` careHidden's. */
export const openable = (t: string, v: string, h: string) => `(${t}.viewer_only OR NOT ${v}) AND (${t}.viewer_only OR NOT ${t}.care_open OR NOT ${h})`;

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

export async function chatStream(fam: Fam, member: string, open: boolean | ThreadAccess, before: string | null, size = STREAM_PAGE): Promise<ChatStream> {
  const { viewer, careHidden } = asThreadAccess(open);
  const visible = `t.family_id = $1 AND t.member = $2 AND ${openable("t", "$3", "$4")}`;
  const [head, page] = await Promise.all([
    rows(`SELECT t.id, COALESCE(t.busy_until > NOW(), FALSE) AS busy FROM maple_chat_threads t WHERE ${visible} ORDER BY busy DESC, t.updated_at DESC LIMIT 1`, [fam.familyId, member, viewer, careHidden]),
    rows(
      `SELECT m.id, m.role, m.parts, m.thread_id FROM maple_chat_messages m JOIN maple_chat_threads t ON t.id = m.thread_id AND t.family_id = m.family_id
       WHERE ${visible} AND ($5::text IS NULL OR (m.created_at, m.seq) < (SELECT c.created_at, c.seq FROM maple_chat_messages c WHERE c.id = $5 AND c.family_id = $1 AND c.member = $2))
       ORDER BY m.created_at DESC, m.seq DESC LIMIT $6`,
      [fam.familyId, member, viewer, careHidden, before, size + 1]
    ),
  ]);
  const { items, more } = streamPage(
    page.map((m) => ({ thread: String(m.thread_id), message: messageOf(m) })),
    size
  );
  return { current: head.length ? { id: String(head[0].id), busy: head[0].busy === true } : null, items, more };
}

/** Deletes every thread this member can open in this family, for good. Usage rows and the day's count stay. */
export async function deleteChats(fam: Fam, member: string, open: boolean | ThreadAccess): Promise<number> {
  // Keep only non-content delivery receipts so a lost acknowledgement cannot replay a write after deletion.
  // A running turn keeps its member lease until it finishes, even if its conversation is deleted.
  const { viewer, careHidden } = asThreadAccess(open);
  const params = [fam.familyId, member, viewer, careHidden];
  const result = await transaction([{
    sql: `INSERT INTO maple_chat_image_generations (family_id, member, generation) VALUES ($1, $2, 1)
      ON CONFLICT (family_id, member) DO UPDATE SET generation = maple_chat_image_generations.generation + 1`,
    params: params.slice(0, 2),
  }, { sql: `WITH removed AS (
    DELETE FROM maple_chat_threads t WHERE t.family_id = $1 AND t.member = $2 AND ${openable("t", "$3", "$4")} RETURNING t.id
  ), detached AS (
    UPDATE maple_chat_deliveries SET thread_id = NULL WHERE family_id = $1 AND member = $2 AND thread_id IN (SELECT id FROM removed)
  ), removed_images AS (
    DELETE FROM maple_chat_images i WHERE i.family_id = $1 AND i.member = $2 AND (i.viewer_only OR NOT $3)
    AND NOT EXISTS (
      SELECT 1 FROM maple_chat_messages m JOIN maple_chat_threads t ON t.id = m.thread_id AND t.family_id = m.family_id
      WHERE m.family_id = i.family_id AND m.member = i.member AND NOT (${openable("t", "$3", "$4")})
      AND m.parts @> jsonb_build_array(jsonb_build_object('type', 'file', 'url', '/api/maple/chat/images?id=' || i.id))
    )
  ) SELECT id FROM removed`, params }]);
  if (result === null) throw new StoreUnavailable();
  return result[1].length;
}
