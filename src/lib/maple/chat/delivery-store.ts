import { createHmac } from "node:crypto";
import { query } from "@/lib/db";
import type { FamilyScope } from "../family";
import { StoreUnavailable } from "../store";
import type { ChatDelivery, ChatDeliveryStatus } from "./delivery";
import type { ChatMessage } from "./types";

type Fam = Pick<FamilyScope, "familyId">;
async function rows(sql: string, params: unknown[]) {
  const result = await query(sql, params);
  if (!result) throw new StoreUnavailable();
  return result;
}

function fingerprintKeys(): string[] {
  const own = process.env.MAPLE_SESSION_SECRET?.trim();
  const current = own || process.env.GOOGLE_CLIENT_SECRET || process.env.ADMIN_PASS;
  if (!current) throw new Error("Chat delivery key is unavailable");
  return [current, ...(own && process.env.MAPLE_SESSION_SECRET_PREV?.trim() ? [process.env.MAPLE_SESSION_SECRET_PREV.trim()] : [])];
}
const fingerprintWith = (key: string, delivery: ChatDelivery, text: string) => `h1:${createHmac("sha256", key).update(JSON.stringify(["maple-chat-delivery", delivery.requestId, delivery.submittedAt, text])).digest("hex")}`;
export const deliveryFingerprint = (delivery: ChatDelivery, text: string) => fingerprintWith(fingerprintKeys()[0], delivery, text);
export const matchesDeliveryFingerprint = (fingerprint: string, delivery: ChatDelivery, text: string) => fingerprintKeys().some((key) => fingerprintWith(key, delivery, text) === fingerprint);
export type DeliveryReceipt = { fingerprint: string; threadId: string | null; completed: boolean; cancelled: boolean };

/** Private receipt lookup; never exposes the fingerprint to a client or another member. */
export async function findDelivery(fam: Fam, member: string, requestId: string): Promise<DeliveryReceipt | null> {
  const r = await rows(`SELECT fingerprint, thread_id, completed_at IS NOT NULL AS completed, cancelled_at IS NOT NULL AS cancelled FROM maple_chat_deliveries
    WHERE family_id = $1 AND member = $2 AND request_id = $3`, [fam.familyId, member, requestId]);
  return r.length ? { fingerprint: String(r[0].fingerprint), threadId: r[0].thread_id == null ? null : String(r[0].thread_id), completed: r[0].completed === true, cancelled: r[0].cancelled === true } : null;
}

/** A requested receipt is readable after its conversation page or entire history has been removed. */
export async function deliveryStatus(fam: Fam, member: string, viewer: boolean, requestId: string): Promise<ChatDeliveryStatus> {
  const r = await rows(`SELECT d.completed_at IS NOT NULL AS completed, d.cancelled_at IS NOT NULL AS cancelled, t.id AS thread_id,
      EXISTS (SELECT 1 FROM maple_chat_member_locks l WHERE l.family_id = d.family_id AND l.member = d.member AND l.thread_id = d.thread_id AND l.busy_until > NOW()) AS busy
    FROM maple_chat_deliveries d LEFT JOIN maple_chat_threads t
      ON t.id = d.thread_id AND t.family_id = d.family_id AND t.member = d.member AND (t.viewer_only OR NOT $4)
    WHERE d.family_id = $1 AND d.member = $2 AND d.request_id = $3`, [fam.familyId, member, requestId, viewer]);
  return { requestId, state: !r.length ? "missing" : r[0].cancelled === true ? "cancelled" : r[0].completed === true ? "completed" : "received", threadId: r[0]?.thread_id == null ? null : String(r[0].thread_id), busy: r[0]?.busy === true };
}

/** Race acceptance on the same key. This only cancels an unaccepted request; an active write is never interrupted. */
export async function cancelDelivery(fam: Fam, member: string, viewer: boolean, delivery: ChatDelivery): Promise<ChatDeliveryStatus | null> {
  const existing = await deliveryStatus(fam, member, viewer, delivery.requestId);
  if (existing.state !== "missing") return existing;
  // Reserve the bounded attempt before touching the receipt key. Holding the quota row while
  // waiting for acceptance's receipt key would invert acceptance's lock order and could deadlock.
  const quota = await rows(`INSERT INTO maple_chat_daily (family_id, member, day, messages, cancellations) VALUES ($1, $2, (NOW() AT TIME ZONE 'UTC')::date, 0, 1)
      ON CONFLICT (family_id, member, day) DO UPDATE SET cancellations = maple_chat_daily.cancellations + 1
        WHERE maple_chat_daily.cancellations < 50 RETURNING member`, [fam.familyId, member]);
  if (quota.length) await rows(`INSERT INTO maple_chat_deliveries
      (family_id, member, request_id, fingerprint, submitted_at, message_id, cancelled_at, completed_at)
    VALUES ($1, $2, $3, 'cancelled', $4, '', NOW(), NOW())
    ON CONFLICT (family_id, member, request_id) DO NOTHING`, [fam.familyId, member, delivery.requestId, delivery.submittedAt]);
  const status = await deliveryStatus(fam, member, viewer, delivery.requestId);
  return status.state === "missing" ? null : status;
}

/** Receipt, canonical user message and daily count are one atomic acceptance, before any model/tool work. */
export async function acceptDelivery(fam: Fam, member: string, threadId: string, delivery: ChatDelivery, text: string, message: ChatMessage, day: string): Promise<boolean> {
  const r = await rows(`WITH expired AS (
      DELETE FROM maple_chat_deliveries WHERE (family_id, member, request_id) IN
        (SELECT family_id, member, request_id FROM maple_chat_deliveries WHERE family_id = $1 AND member = $2 AND accepted_at < NOW() - INTERVAL '8 days' ORDER BY accepted_at LIMIT 200)
    ), accepted AS (
      INSERT INTO maple_chat_deliveries (family_id, member, request_id, fingerprint, submitted_at, thread_id, message_id)
      SELECT $1, $2, $3, $4, $5, $6, $7 WHERE EXISTS (SELECT 1 FROM maple_chat_threads WHERE id = $6 AND family_id = $1 AND member = $2)
      ON CONFLICT (family_id, member, request_id) DO NOTHING RETURNING request_id
    ), saved AS (
      INSERT INTO maple_chat_messages (family_id, id, thread_id, member, seq, role, parts)
      SELECT $1, $7, $6, $2, COALESCE(MAX(seq), 0) + 1, 'user', $8::jsonb FROM maple_chat_messages WHERE thread_id = $6 AND family_id = $1
      HAVING EXISTS (SELECT 1 FROM accepted) RETURNING id
    ), counted AS (
      INSERT INTO maple_chat_daily (family_id, member, day, messages)
      SELECT $1, $2, $9::date, 1 WHERE EXISTS (SELECT 1 FROM saved)
      ON CONFLICT (family_id, member, day) DO UPDATE SET messages = maple_chat_daily.messages + 1 RETURNING member
    ) SELECT request_id FROM accepted`, [fam.familyId, member, delivery.requestId, deliveryFingerprint(delivery, text), delivery.submittedAt, threadId, message.id, JSON.stringify(message.parts), day]);
  return r.length === 1;
}

export async function completeDelivery(fam: Fam, member: string, requestId: string): Promise<void> {
  await rows(`UPDATE maple_chat_deliveries SET completed_at = COALESCE(completed_at, NOW()) WHERE family_id = $1 AND member = $2 AND request_id = $3`, [fam.familyId, member, requestId]);
}
