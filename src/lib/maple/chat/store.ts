import { query } from "@/lib/db";
import { StoreUnavailable } from "../store";
import type { Usage } from "./caps";
import type { StepTokens } from "./prices";
import type { ChatMessage, ChatThread } from "./types";

/**
 * The chat's tables (src/lib/migrate.ts). A thread belongs to one member and
 * every query is filtered by them; a viewer reaches only threads that ran as
 * a viewer throughout (`viewer_only`), and a thread that ever ran with her
 * page open says so (`care_open`). Messages are append-only UIMessages; only
 * an assistant message is ever rewritten: by its own continuation after an
 * approval, or when a new message turns its unanswered request into a no.
 * Usage rows hold counts and cost, never content, and like the daily message
 * count they outlive a deleted thread.
 */

async function rows(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const r = await query(sql, params);
  if (r === null) throw new StoreUnavailable();
  return r as Record<string, unknown>[];
}

const iso = (v: unknown) => new Date(v as string).toISOString();

const threadOf = (r: Record<string, unknown>): ChatThread => ({ id: String(r.id), title: (r.title as string | null) ?? null, updated_at: iso(r.updated_at) });

export async function listThreads(member: string, viewer: boolean): Promise<ChatThread[]> {
  const r = await rows(`SELECT id, title, updated_at FROM maple_chat_threads WHERE member = $1 AND (viewer_only OR NOT $2) ORDER BY updated_at DESC LIMIT 20`, [member, viewer]);
  return r.map(threadOf);
}

export async function getThread(id: string, member: string, viewer: boolean): Promise<ChatThread | null> {
  const r = await rows(
    `SELECT id, title, updated_at, COALESCE(busy_until > NOW(), FALSE) AS busy FROM maple_chat_threads WHERE id = $1 AND member = $2 AND (viewer_only OR NOT $3)`,
    [id, member, viewer]
  );
  return r.length ? { ...threadOf(r[0]), busy: r[0].busy === true } : null;
}

export async function deleteThread(id: string, member: string): Promise<boolean> {
  return (await rows(`DELETE FROM maple_chat_threads WHERE id = $1 AND member = $2 RETURNING id`, [id, member])).length > 0;
}

/** `careOpen`: some turn in it, this one included, ran with her page open to the chat (`care_open`). */
export type LockedThread = { id: string; title: string | null; userMessages: number; lastPrompt: number; careOpen: boolean };

/**
 * One turn at a time per thread: claims it (making it on first use) for 70
 * seconds, longer than a turn can run. "busy" while another turn has it;
 * "missing" for another member's thread, said the same as one that isn't there.
 * `care`: this turn runs with her page open to the chat.
 */
export async function lockThread(id: string, member: string, model: string, viewer: boolean, care: boolean): Promise<LockedThread | "busy" | "missing"> {
  await rows(`INSERT INTO maple_chat_threads (id, member, model, viewer_only, care_open) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`, [id, member, model, viewer, care]);
  const r = await rows(
    `UPDATE maple_chat_threads t SET busy_until = NOW() + INTERVAL '70 seconds', viewer_only = $3, care_open = t.care_open OR $4
     WHERE t.id = $1 AND t.member = $2 AND (t.viewer_only OR NOT $3) AND (t.busy_until IS NULL OR t.busy_until < NOW())
     RETURNING t.id, t.title, t.care_open,
       (SELECT COUNT(*) FROM maple_chat_messages m WHERE m.thread_id = t.id AND m.role = 'user') AS user_messages,
       (SELECT u.input_tokens + u.cache_read_tokens + u.cache_write_tokens FROM maple_ai_usage u WHERE u.thread_id = t.id ORDER BY u.id DESC LIMIT 1) AS last_prompt`,
    [id, member, viewer, care]
  );
  if (r.length) {
    return {
      id: String(r[0].id),
      title: (r[0].title as string | null) ?? null,
      userMessages: Number(r[0].user_messages ?? 0),
      lastPrompt: Number(r[0].last_prompt ?? 0),
      careOpen: r[0].care_open !== false,
    };
  }
  const owner = await rows(`SELECT member, viewer_only FROM maple_chat_threads WHERE id = $1`, [id]);
  return owner.length && owner[0].member === member && (owner[0].viewer_only === true || !viewer) ? "busy" : "missing";
}

export async function releaseThread(id: string): Promise<void> {
  await rows(`UPDATE maple_chat_threads SET busy_until = NULL, updated_at = NOW() WHERE id = $1`, [id]);
}

export async function setTitle(id: string, title: string): Promise<void> {
  await rows(`UPDATE maple_chat_threads SET title = COALESCE(title, $2) WHERE id = $1`, [id, title]);
}

export async function loadMessages(threadId: string): Promise<ChatMessage[]> {
  const r = await rows(`SELECT id, role, parts FROM maple_chat_messages WHERE thread_id = $1 ORDER BY seq`, [threadId]);
  return r.map((m) => ({ id: String(m.id), role: m.role as "user" | "assistant", parts: Array.isArray(m.parts) ? (m.parts as ChatMessage["parts"]) : [] }));
}

/** Adds a message at the end of the thread, or replaces the parts of the one with its id (an assistant reply carried on). */
export async function saveMessage(threadId: string, member: string, m: ChatMessage): Promise<void> {
  await rows(
    `INSERT INTO maple_chat_messages (id, thread_id, member, seq, role, parts)
     SELECT $1, $2, $3, COALESCE(MAX(seq), 0) + 1, $4, $5::jsonb FROM maple_chat_messages WHERE thread_id = $2
     ON CONFLICT (id) DO UPDATE SET parts = EXCLUDED.parts, updated_at = NOW()
       WHERE maple_chat_messages.thread_id = EXCLUDED.thread_id AND maple_chat_messages.member = EXCLUDED.member`,
    [m.id, threadId, member, m.role, JSON.stringify(m.parts)]
  );
}

/** Today's (and this month's) chat so far: this member's messages on `day` (a family day key) and the family's spend. */
export async function usageSince(member: string, day: string, dayStart: Date, monthStart: Date): Promise<Usage> {
  const r = await rows(
    `SELECT
       (SELECT COALESCE(MAX(messages), 0) FROM maple_chat_daily WHERE member = $1 AND day = $2::date) AS mine,
       (SELECT COALESCE(SUM(cost_micro_usd), 0) FROM maple_ai_usage WHERE created_at >= $3) AS day,
       (SELECT COALESCE(SUM(cost_micro_usd), 0) FROM maple_ai_usage WHERE created_at >= $4) AS month`,
    [member, day, dayStart.toISOString(), monthStart.toISOString()]
  );
  const u = r[0] ?? {};
  return { mine: Number(u.mine ?? 0), day: BigInt(String(u.day ?? 0)), month: BigInt(String(u.month ?? 0)) };
}

/** One more message from this member on `day`. Kept apart from the messages, so deleting a chat doesn't give the day's messages back. */
export async function countMessage(member: string, day: string): Promise<void> {
  await rows(
    `INSERT INTO maple_chat_daily (member, day, messages) VALUES ($1, $2::date, 1)
     ON CONFLICT (member, day) DO UPDATE SET messages = maple_chat_daily.messages + 1`,
    [member, day]
  );
}

export type UsageRow = {
  member: string;
  threadId: string;
  messageId: string;
  step: number;
  model: string;
  tokens: StepTokens;
  costMicro: bigint;
  priceKey: string;
  finishReason: string | null;
  generationId: string | null;
};

export async function recordUsage(u: UsageRow): Promise<void> {
  await rows(
    `INSERT INTO maple_ai_usage
       (member, thread_id, message_id, step, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, cost_micro_usd, price_key, finish_reason, generation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::bigint, $12, $13, $14)`,
    [
      u.member,
      u.threadId,
      u.messageId,
      u.step,
      u.model,
      u.tokens.fresh,
      u.tokens.cacheRead,
      u.tokens.cacheWrite,
      u.tokens.output,
      u.tokens.reasoning,
      u.costMicro.toString(),
      u.priceKey,
      u.finishReason,
      u.generationId,
    ]
  );
}
