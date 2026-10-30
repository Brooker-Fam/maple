import { query } from "@/lib/db";
import { CONTACT_EMAIL } from "@/components/site/legal";
import { EMAIL_WAIT_MS, within } from "@/lib/email/notices";
import { sendEmail, type Email, type EmailResult } from "@/lib/email/send";
import { normalizeEmail } from "@/lib/waitlist";
import { ADMIN_ID, familyOf, type Fam } from "../auth";
import { FAMILY_ONE } from "../family";
import { MAPLE_ORIGIN } from "../origin";
import { StoreUnavailable } from "../store";
import type { Member, Role } from "../types";
import {
  FEEDBACK_MAX_CHARS,
  FEEDBACK_QUESTION,
  FEEDBACK_RATINGS,
  FEEDBACK_TOPICS,
  RATING_LABEL,
  replyableMember,
  TOPIC_LABEL,
  VIA_LABEL,
  type FeedbackAsk,
  type FeedbackRating,
  type FeedbackTopic,
  type FeedbackVia,
} from "./types";

/**
 * Feedback for the person who makes Maple (feedback/schema.ts): saved with
 * the family, then emailed to CONTACT_EMAIL, where feedback sent by email
 * already goes, with the sender's address as its reply-to when there is one.
 * The saved copy is the record: a failed or capped email leaves it on the
 * admin page. Nothing about it goes to PostHog.
 *
 * Today's question (feedbackAsk) goes to owners and members outside family 1
 * once their family is set up, they joined at least ASK_AFTER_DAYS ago, and
 * the log has ASK_MIN_ENTRIES entries; never again once they answer it, and
 * not after MAX_SNOOZES "Not now"s, each holding it off for SNOOZE_DAYS.
 */

export const FEEDBACK_PER_DAY = 5;
export const FEEDBACK_EMAILS_PER_DAY = 100;
export const ASK_AFTER_DAYS = 3;
export const ASK_MIN_ENTRIES = 10;
export const SNOOZE_DAYS = 14;
export const MAX_SNOOZES = 2;
/** Someone who sent feedback this recently isn't asked Today's question. */
const ASKED_ENOUGH_DAYS = 30;

export type FeedbackRefusal = "empty" | "too_long" | "invalid" | "limit";

export class FeedbackRefused extends Error {
  constructor(readonly code: FeedbackRefusal, message: string) {
    super(message);
    this.name = "FeedbackRefused";
  }
}

export type FeedbackInput = { via: FeedbackVia; message: string | null; topic: FeedbackTopic | null; rating: FeedbackRating | null };

export type SavedFeedback = FeedbackInput & { id: number; familyId: number; member: string; role: Role; createdAt: string };

// C0 controls but tab and newline, DEL, and the bidi overrides and isolates.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g;

/** The message as typed, without control characters, runs of blank lines or the space around it; null when nothing is left. */
export function cleanMessage(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") throw new FeedbackRefused("invalid", "Feedback has to be text.");
  const text = raw.replace(/\r\n?/g, "\n").replace(CONTROLS, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return null;
  if (text.length > FEEDBACK_MAX_CHARS) throw new FeedbackRefused("too_long", `Keep it under ${FEEDBACK_MAX_CHARS.toLocaleString("en-US")} characters.`);
  return text;
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], what: string): T | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "string" && (allowed as readonly string[]).includes(raw)) return raw as T;
  throw new FeedbackRefused("invalid", `That ${what} isn't one Maple knows.`);
}

/** A request's feedback, checked. Only Today's question carries a rating; everything needs a message or a rating. */
export function parseFeedback(raw: { message?: unknown; topic?: unknown; rating?: unknown }, via: FeedbackVia): FeedbackInput {
  const message = cleanMessage(raw.message);
  const topic = oneOf(raw.topic, FEEDBACK_TOPICS, "topic");
  const rating = oneOf(raw.rating, FEEDBACK_RATINGS, "answer");
  if (rating && via !== "prompt") throw new FeedbackRefused("invalid", "Only Today's question takes an answer like that.");
  if (!message && !rating) throw new FeedbackRefused("empty", "Write something first.");
  return { via, message, topic, rating };
}

const iso = (value: unknown) => new Date(value as string).toISOString();

/**
 * Saves one message, at most FEEDBACK_PER_DAY a person in a family in any 24
 * hours. An answer to Today's question also marks that question answered.
 */
export async function saveFeedback(fam: Fam, member: Pick<Member, "email" | "role">, input: FeedbackInput): Promise<SavedFeedback> {
  const familyId = familyOf(fam);
  const rows = await query(
    `WITH recent AS (
       SELECT COUNT(*)::int AS n FROM maple_feedback
       WHERE family_id = $1::bigint AND member = $2::text AND created_at > NOW() - INTERVAL '24 hours'
     ), saved AS (
       INSERT INTO maple_feedback (family_id, member, role, via, topic, rating, message)
       SELECT $1::bigint, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text FROM recent WHERE n < $8::int
       RETURNING id, created_at
     ), answered AS (
       INSERT INTO maple_feedback_asks (family_id, member, answered_at, updated_at)
       SELECT $1::bigint, $2::text, NOW(), NOW() FROM saved WHERE $4::text = 'prompt'
       ON CONFLICT (family_id, member) DO UPDATE SET answered_at = NOW(), updated_at = NOW()
     )
     SELECT id, created_at FROM saved`,
    [familyId, member.email, member.role, input.via, input.topic, input.rating, input.message, FEEDBACK_PER_DAY]
  );
  if (!rows) throw new StoreUnavailable();
  if (!rows[0]) throw new FeedbackRefused("limit", `That's as much feedback as one person can send in a day. Email ${CONTACT_EMAIL} for anything more.`);
  return { ...input, id: Number(rows[0].id), familyId, member: member.email, role: member.role, createdAt: iso(rows[0].created_at) };
}

const ROLE_WORD: Record<Role, string> = { owner: "an owner", member: "a member", viewer: "a view-only guest", photos: "a photos-only guest" };

/** The sender's address for a reply, when their member id is one. */
export function replyAddress(member: string): string | null {
  return replyableMember(member) ? normalizeEmail(member) : null;
}

/** The email the person who makes Maple gets for one message: the words, who sent them by family and role, never a name. */
export function feedbackEmail(f: SavedFeedback): Email {
  const replyTo = replyAddress(f.member);
  const lines = [
    `From ${ROLE_WORD[f.role]} of family ${f.familyId}, sent from ${VIA_LABEL[f.via]}.`,
    ...(f.rating ? [`${FEEDBACK_QUESTION} ${RATING_LABEL[f.rating]}.`] : []),
    ...(f.topic ? [`Topic: ${TOPIC_LABEL[f.topic]}.`] : []),
    "",
    f.message ?? "No message, just the answer above.",
    "",
    replyTo ? "Reply to this email to answer them." : "Their account has no email address to reply to.",
    `All feedback is on the admin page: ${MAPLE_ORIGIN}/maple/admin`,
  ];
  const text = lines.join("\n");
  const html = lines.map((line) => (line ? `<p>${escapeHtml(line).replace(/\n/g, "<br>")}</p>` : "")).join("");
  return {
    to: CONTACT_EMAIL,
    subject: `Maple feedback from family ${f.familyId}${f.topic ? `: ${TOPIC_LABEL[f.topic].toLowerCase()}` : f.rating ? `: ${RATING_LABEL[f.rating].toLowerCase()}` : ""}`,
    text,
    html,
    kind: "feedback",
    idempotencyKey: `feedback/${f.id}`,
    ...(replyTo ? { replyTo } : {}),
  };
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type FeedbackEmailDeps = { send: (email: Email) => Promise<EmailResult>; waitMs: number };

/**
 * Emails one saved message, at most FEEDBACK_EMAILS_PER_DAY across Maple a
 * day, and records when Resend accepted it. Waits at most EMAIL_WAIT_MS, as
 * invites do; a send that finishes later is still recorded when it does.
 */
export async function emailFeedback(f: SavedFeedback, deps: Partial<FeedbackEmailDeps> = {}): Promise<boolean> {
  const { send, waitMs } = { send: sendEmail, waitMs: EMAIL_WAIT_MS, ...deps };
  const sent = await query(`SELECT COUNT(*)::int AS n FROM maple_feedback WHERE emailed_at > NOW() - INTERVAL '24 hours'`);
  if (!sent || Number(sent[0]?.n) >= FEEDBACK_EMAILS_PER_DAY) return false;
  const delivered = (async () => {
    const result = await send(feedbackEmail(f));
    if (!result.sent) return false;
    await query(`UPDATE maple_feedback SET emailed_at = NOW() WHERE id = $1 AND family_id = $2`, [f.id, f.familyId]);
    return true;
  })().catch(() => false);
  return within(waitMs, delivered, false);
}

/** Saves it, then emails it; the email never decides whether it was saved. */
export async function sendFeedback(fam: Fam, member: Pick<Member, "email" | "role">, input: FeedbackInput, deps: Partial<FeedbackEmailDeps> = {}): Promise<{ feedback: SavedFeedback; emailed: boolean }> {
  const feedback = await saveFeedback(fam, member, input);
  const emailed = await emailFeedback(feedback, deps).catch(() => false);
  return { feedback, emailed };
}

/** Whether Today asks this person its question now (see the rules above). */
export async function feedbackAsk(fam: Fam, member: Pick<Member, "email" | "role">): Promise<FeedbackAsk> {
  const familyId = familyOf(fam);
  const replyable = replyAddress(member.email) !== null;
  if (familyId === FAMILY_ONE || member.email === ADMIN_ID || (member.role !== "owner" && member.role !== "member")) return { ask: false, replyable };
  const rows = await query(
    `SELECT (
       f.status = 'active'
       AND m.accepted_at IS NOT NULL AND m.accepted_at <= NOW() - $3::int * INTERVAL '1 day'
       AND (SELECT COUNT(*)::int FROM (SELECT 1 FROM maple_entries e WHERE e.family_id = f.id AND e.deleted_at IS NULL LIMIT $4::int) x) >= $4::int
       AND a.answered_at IS NULL
       AND COALESCE(a.snoozes, 0) < $5
       AND (a.ask_after IS NULL OR a.ask_after <= NOW())
       AND NOT EXISTS (SELECT 1 FROM maple_feedback fb WHERE fb.family_id = f.id AND fb.member = m.email AND fb.created_at > NOW() - $6::int * INTERVAL '1 day')
     ) AS ask
     FROM maple_families f
     JOIN maple_members m ON m.family_id = f.id AND m.email = $2
     LEFT JOIN maple_feedback_asks a ON a.family_id = f.id AND a.member = m.email
     WHERE f.id = $1`,
    [familyId, member.email, ASK_AFTER_DAYS, ASK_MIN_ENTRIES, MAX_SNOOZES, ASKED_ENOUGH_DAYS]
  );
  if (!rows) throw new StoreUnavailable();
  return { ask: rows[0]?.ask === true, replyable };
}

/** "Not now" on Today's question: asked again after SNOOZE_DAYS, until MAX_SNOOZES. */
export async function snoozeFeedbackAsk(fam: Fam, member: string): Promise<void> {
  const rows = await query(
    `INSERT INTO maple_feedback_asks (family_id, member, snoozes, ask_after, updated_at)
     VALUES ($1, $2, 1, NOW() + $3::int * INTERVAL '1 day', NOW())
     ON CONFLICT (family_id, member) DO UPDATE SET snoozes = maple_feedback_asks.snoozes + 1, ask_after = EXCLUDED.ask_after, updated_at = NOW()`,
    [familyOf(fam), member, SNOOZE_DAYS]
  );
  if (!rows) throw new StoreUnavailable();
}
