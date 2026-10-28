import { randomUUID } from "node:crypto";
import { query } from "@/lib/db";
import { FAMILY_ONE, type FamilyScope } from "../family";
import { StoreUnavailable } from "../store";
import { familyBudgets, globalMonthlyCeiling, type Usage } from "./caps";
import { loadRecentMessages } from "./history";
import type { StepTokens } from "./prices";
import type { ChatMessage } from "./types";
import { acceptDelivery, completeDelivery, findDelivery } from "./delivery-store";
import type { ChatDelivery } from "./delivery";

/**
 * The chat's tables (src/lib/migrate.ts). A thread belongs to one member of
 * one family and every query is filtered by both; another family's thread
 * reads exactly like one that isn't there. A viewer reaches only threads that
 * ran as a viewer throughout (`viewer_only`), and a thread that ever ran with
 * her page open says so (`care_open`). Messages are append-only UIMessages;
 * only an assistant message is ever rewritten: by its own continuation after
 * an approval, or when a new message turns its unanswered request into a no.
 * Usage rows hold counts and cost, never content, and like the daily message
 * count they outlive a deleted thread. Spend and counts are per family.
 */

type Fam = Pick<FamilyScope, "familyId">;

async function rows(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const r = await query(sql, params);
  if (r === null) throw new StoreUnavailable();
  return r as Record<string, unknown>[];
}

/** `careOpen`: some turn in it, this one included, ran with her page open to the chat (`care_open`). */
export type LockedThread = { id: string; title: string | null; userMessages: number; lastPrompt: number; careOpen: boolean; leaseId?: string };

/**
 * Cost rows that count for family `fam`. One without a family (written by
 * the code from before families, during a build or after a rollback) is
 * family 1's while no other family exists, as the migration's backfill has it.
 */
const costOf = (fam: string, col = "family_id") =>
  `(${col} = ${fam} OR (${col} IS NULL AND ${fam} = ${FAMILY_ONE} AND NOT EXISTS (SELECT 1 FROM maple_families WHERE id <> ${FAMILY_ONE})))`;

/**
 * One turn at a time per thread: claims it (making it on first use) for 70
 * seconds, longer than a turn can run. "busy" while another turn has it;
 * "missing" for another member's or another family's thread, said the same
 * as one that isn't there. `care`: this turn runs with her page open to the chat.
 */
export async function lockThread(fam: Fam, id: string, member: string, model: string, viewer: boolean, care: boolean): Promise<LockedThread | "busy" | "missing"> {
  // Serialize this member even when two freshly opened phones proposed different first-thread ids.
  const leaseId = randomUUID();
  const lease = await rows(`INSERT INTO maple_chat_member_locks (family_id, member, thread_id, lease_id, busy_until)
    VALUES ($1, $2, $3, $4, NOW() + INTERVAL '70 seconds')
    ON CONFLICT (family_id, member) DO UPDATE SET thread_id = EXCLUDED.thread_id, lease_id = EXCLUDED.lease_id, busy_until = EXCLUDED.busy_until
      WHERE maple_chat_member_locks.busy_until < NOW() RETURNING lease_id`, [fam.familyId, member, id, leaseId]);
  if (!lease.length) return "busy";
  try {
    const result = await lockOneThread(fam, id, member, model, viewer, care);
    if (typeof result === "object") return { ...result, leaseId };
    await rows(`DELETE FROM maple_chat_member_locks WHERE family_id = $1 AND member = $2 AND lease_id = $3`, [fam.familyId, member, leaseId]);
    return result;
  } catch (error) {
    await rows(`DELETE FROM maple_chat_member_locks WHERE family_id = $1 AND member = $2 AND lease_id = $3`, [fam.familyId, member, leaseId]).catch(() => {});
    throw error;
  }
}

async function lockOneThread(fam: Fam, id: string, member: string, model: string, viewer: boolean, care: boolean): Promise<LockedThread | "busy" | "missing"> {
  await rows(
    `INSERT INTO maple_chat_threads (family_id, id, member, model, viewer_only, care_open) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
    [fam.familyId, id, member, model, viewer, care]
  );
  const r = await rows(
    `UPDATE maple_chat_threads t SET busy_until = NOW() + INTERVAL '70 seconds', viewer_only = $4, care_open = t.care_open OR $5
     WHERE t.id = $1 AND t.family_id = $2 AND t.member = $3 AND (t.viewer_only OR NOT $4) AND (t.busy_until IS NULL OR t.busy_until < NOW())
     RETURNING t.id, t.title, t.care_open,
       (SELECT COUNT(*) FROM maple_chat_messages m WHERE m.thread_id = t.id AND m.family_id = t.family_id AND m.role = 'user') AS user_messages,
       (SELECT u.input_tokens + u.cache_read_tokens + u.cache_write_tokens FROM maple_ai_usage u
         WHERE u.thread_id = t.id AND ${costOf("t.family_id", "u.family_id")} ORDER BY u.id DESC LIMIT 1) AS last_prompt`,
    [id, fam.familyId, member, viewer, care]
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
  const owner = await rows(`SELECT member, viewer_only FROM maple_chat_threads WHERE id = $1 AND family_id = $2`, [id, fam.familyId]);
  return owner.length && owner[0].member === member && (owner[0].viewer_only === true || !viewer) ? "busy" : "missing";
}

export async function releaseThread(fam: Fam, id: string, leaseId?: string): Promise<void> {
  await rows(`WITH released AS (
    DELETE FROM maple_chat_member_locks WHERE thread_id = $1 AND family_id = $2 AND ($3::text IS NULL OR lease_id = $3) RETURNING lease_id
  ) UPDATE maple_chat_threads SET busy_until = NULL, updated_at = NOW()
    WHERE id = $1 AND family_id = $2 AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM released))`, [id, fam.familyId, leaseId ?? null]);
}

export async function setTitle(fam: Fam, id: string, title: string): Promise<void> {
  await rows(`UPDATE maple_chat_threads SET title = COALESCE(title, $3) WHERE id = $1 AND family_id = $2`, [id, fam.familyId, title]);
}

/** Adds a message at the end of the thread, or replaces the parts of the one with its id (an assistant reply carried on). */
export async function saveMessage(fam: Fam, threadId: string, member: string, m: ChatMessage): Promise<void> {
  await rows(
    `INSERT INTO maple_chat_messages (family_id, id, thread_id, member, seq, role, parts)
     SELECT $1, $2, $3, $4, COALESCE(MAX(seq), 0) + 1, $5, $6::jsonb FROM maple_chat_messages WHERE thread_id = $3 AND family_id = $1
     HAVING EXISTS (SELECT 1 FROM maple_chat_threads WHERE id = $3 AND family_id = $1)
     ON CONFLICT (id) DO UPDATE SET parts = EXCLUDED.parts, updated_at = NOW()
       WHERE maple_chat_messages.thread_id = EXCLUDED.thread_id AND maple_chat_messages.member = EXCLUDED.member
         AND maple_chat_messages.family_id = EXCLUDED.family_id`,
    [fam.familyId, m.id, threadId, member, m.role, JSON.stringify(m.parts)]
  );
}

/** Today's (and this month's) chat so far: this member's messages on `day` (a family day key) and the family's spend. */
export async function usageSince(fam: Fam, member: string, day: string, dayStart: Date, monthStart: Date): Promise<Usage> {
  const r = await rows(
    `SELECT
       (SELECT COALESCE(MAX(messages), 0) FROM maple_chat_daily WHERE family_id = $1 AND member = $2 AND day = $3::date) AS mine,
       (SELECT COALESCE(SUM(cost_micro_usd), 0) FROM maple_ai_usage WHERE ${costOf("$1::bigint")} AND created_at >= $4) AS day,
       (SELECT COALESCE(SUM(cost_micro_usd), 0) FROM maple_ai_usage WHERE ${costOf("$1::bigint")} AND created_at >= $5) AS month`,
    [fam.familyId, member, day, dayStart.toISOString(), monthStart.toISOString()]
  );
  const u = r[0] ?? {};
  return { mine: Number(u.mine ?? 0), day: BigInt(String(u.day ?? 0)), month: BigInt(String(u.month ?? 0)) };
}

/** One more message from this member on `day`. Kept apart from the messages, so deleting a chat doesn't give the day's messages back. */
export async function countMessage(fam: Fam, member: string, day: string): Promise<void> {
  await rows(
    `INSERT INTO maple_chat_daily (family_id, member, day, messages) VALUES ($1, $2, $3::date, 1)
     ON CONFLICT (family_id, member, day) DO UPDATE SET messages = maple_chat_daily.messages + 1`,
    [fam.familyId, member, day]
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

export async function recordUsage(fam: Fam, u: UsageRow): Promise<void> {
  await rows(
    `INSERT INTO maple_ai_usage
       (family_id, member, thread_id, message_id, step, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, cost_micro_usd, price_key, finish_reason, generation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::bigint, $13, $14, $15)`,
    [
      fam.familyId,
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

/** The family's own chat budget in micro-dollars, where one is set (null columns take the default). */
export async function familyBudget(fam: Fam): Promise<{ day: bigint | null; month: bigint | null }> {
  const r = await rows(`SELECT ai_daily_micro, ai_monthly_micro FROM maple_families WHERE id = $1`, [fam.familyId]);
  const big = (v: unknown) => (v == null ? null : BigInt(String(v)));
  return { day: big(r[0]?.ai_daily_micro), month: big(r[0]?.ai_monthly_micro) };
}

/**
 * What this family's chats may spend: its own budget (familyBudgets), or
 * nothing at all when the operator paused its chat (settings.chat_paused) or
 * every family but the Brookers together reached this month's ceiling
 * (MAPLE_CHAT_GLOBAL_MONTHLY_MICRO). Fails closed: a read that fails throws.
 * Read before every turn of the chat and of the onboarding chat.
 */
export async function chatBudget(fam: Fam, now: Date, env: Record<string, string | undefined> = process.env): Promise<{ day: bigint; month: bigint }> {
  const familyOne = fam.familyId === FAMILY_ONE;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const r = await rows(
    `SELECT ai_daily_micro, ai_monthly_micro, COALESCE(settings->'chat_paused' = 'true'::jsonb, FALSE) AS paused,
       CASE WHEN $2 THEN 0 ELSE (SELECT COALESCE(SUM(cost_micro_usd), 0) FROM maple_ai_usage
         WHERE created_at >= $3 AND (family_id IS NULL OR family_id <> ${FAMILY_ONE})) END AS others
     FROM maple_families WHERE id = $1`,
    [fam.familyId, familyOne, monthStart.toISOString()]
  );
  const none = { day: BigInt(0), month: BigInt(0) };
  if (!r.length) return none;
  const big = (v: unknown) => (v == null ? null : BigInt(String(v)));
  if (r[0].paused === true) return none;
  if (!familyOne && BigInt(String(r[0].others ?? 0)) >= globalMonthlyCeiling(env)) return none;
  return familyBudgets({ day: big(r[0].ai_daily_micro), month: big(r[0].ai_monthly_micro) }, { familyOne }, env);
}

/** The chat route's store for one family: every call above, bound to it. */
export function chatStore(fam: Fam) {
  return {
    usageSince: (member: string, day: string, dayStart: Date, monthStart: Date) => usageSince(fam, member, day, dayStart, monthStart),
    lockThread: (id: string, member: string, model: string, viewer: boolean, care: boolean) => lockThread(fam, id, member, model, viewer, care),
    releaseThread: (id: string, leaseId?: string) => releaseThread(fam, id, leaseId),
    loadMessages: (threadId: string) => loadRecentMessages(fam, threadId),
    saveMessage: (threadId: string, member: string, m: ChatMessage) => saveMessage(fam, threadId, member, m),
    setTitle: (id: string, title: string) => setTitle(fam, id, title),
    countMessage: (member: string, day: string) => countMessage(fam, member, day),
    recordUsage: (u: UsageRow) => recordUsage(fam, u),
    deliveries: {
      find: (member: string, requestId: string) => findDelivery(fam, member, requestId),
      accept: (member: string, threadId: string, delivery: ChatDelivery, text: string, message: ChatMessage, day: string) => acceptDelivery(fam, member, threadId, delivery, text, message, day),
      complete: (member: string, requestId: string) => completeDelivery(fam, member, requestId),
    },
  };
}
