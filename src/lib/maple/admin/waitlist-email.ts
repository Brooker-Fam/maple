import { createHash } from "node:crypto";
import { query } from "@/lib/db";
import { emailConfig, REPLY_TO, sendEmail, type EmailDeps, type EmailResult } from "@/lib/email/send";
import { escapeHtml, type Rendered } from "@/lib/email/templates";
import { encryptSecret, openSecret } from "@/lib/secret-box";
import { normalizeEmail } from "@/lib/waitlist";
import { ACCEPTED_MEMBERSHIP, effectiveSignupMode } from "../family";
import { MAPLE_ORIGIN } from "../origin";
import { StoreUnavailable } from "../store";
import { maskAdminEmail, openAdminRef } from "./refs";
import type { AdminWaitlistPreview, AdminWaitlistSendResult, WaitlistEmailReason } from "./waitlist-email-types";

// A campaign is sent once per waitlist row, even after the provider's own
// 24-hour idempotency window has passed. A template edit must not reset it.
const CAMPAIGN = "maple-launch-v1";
const TOKEN_KIND = "maple-waitlist-send";
const TOKEN_TTL_MS = 10 * 60_000;
const SEND_WAIT_MS = 8_000;

export class WaitlistEmailError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}

export type WaitlistEmailDeps = {
  email?: Partial<EmailDeps>;
  signupMode?: typeof effectiveSignupMode;
  now?: () => Date;
  waitMs?: number;
};

type Recipient = { id: number; email: string; status: string | null; sentAt: string | null; attemptedAt: string | null; signedUp: boolean };
type SendIntent = { kind: typeof TOKEN_KIND; id: number; email: string; digest: string; issuedAt: number; expiresAt: number };

const SIGNED_UP = `EXISTS (
  SELECT 1 FROM maple_members m JOIN maple_families f ON f.id = m.family_id
  WHERE ${ACCEPTED_MEMBERSHIP("m")} AND (
    m.email = w.email OR EXISTS (
      SELECT 1 FROM maple_auth_identities a
      WHERE a.provider = 'email' AND a.subject = w.email AND a.member_id = m.email
    )
  )
)`;

function iso(value: unknown): string | null { return value == null ? null : new Date(String(value)).toISOString(); }

async function recipient(id: number): Promise<Recipient> {
  const rows = await query(`SELECT w.id, w.email, o.status, o.sent_at, o.attempted_at, ${SIGNED_UP} AS signed_up
    FROM maple_waitlist w LEFT JOIN maple_waitlist_outreach o ON o.waitlist_id = w.id AND o.campaign = $2
    WHERE w.id = $1`, [id, CAMPAIGN]);
  if (rows === null) throw new StoreUnavailable();
  if (!rows.length) throw new WaitlistEmailError("recipient_missing", "This waitlist entry is no longer available.", 404);
  const row = rows[0];
  const email = normalizeEmail(row.email);
  if (!email) throw new WaitlistEmailError("recipient_invalid", "This waitlist address cannot receive an invitation.");
  return { id: Number(row.id), email, status: row.status == null ? null : String(row.status), sentAt: iso(row.sent_at), attemptedAt: iso(row.attempted_at), signedUp: row.signed_up === true };
}

/** The same immutable words are previewed and delivered. No tracking links or pixels. */
export function waitlistLaunchEmail(): Rendered {
  const subject = "Maple is ready for your family";
  const url = new URL("/signup", MAPLE_ORIGIN).href;
  const paragraphs = [
    "You joined Maple’s waitlist to hear when signups opened. Maple is now ready for new families.",
    "Start a private family log for feeds, diapers, sleep and little moments, and invite the people helping you care for your baby.",
    "Start your family’s log:",
    url,
    "Reply to this email if you have a question or need a hand getting started. It reaches the person who makes Maple.",
    `You received this one-time invitation because this address joined Maple’s waitlist. To have your waitlist address removed, reply to this email or write to ${REPLY_TO}.`,
    "Maple is a tracker, not medical advice.",
  ];
  return {
    subject,
    text: `${paragraphs.join("\n\n")}\n`,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;line-height:1.6;color:#1c2619"><div style="max-width:480px;margin:0 auto">${paragraphs.map((p) => `<p style="margin:0 0 18px">${p === url ? `<a href="${escapeHtml(url)}" style="color:#1d4420">${escapeHtml(url)}</a>` : escapeHtml(p)}</p>`).join("")}</div></body></html>`,
  };
}

function rendered(deps: WaitlistEmailDeps) {
  const config = emailConfig(deps.email?.env ?? process.env);
  const message = waitlistLaunchEmail();
  const from = config?.from ?? "Maple";
  const digest = createHash("sha256").update(JSON.stringify({ campaign: CAMPAIGN, from, replyTo: REPLY_TO, ...message })).digest("hex");
  return { config, message, from, digest };
}

function deliveryReason(row: Recipient, now: Date): WaitlistEmailReason | null {
  if (row.status === "sent") return "already_sent";
  if (row.status === "uncertain") return "delivery_unknown";
  // A server can stop after claiming or after the provider accepts. An old
  // unfinished claim is ambiguous and must never be retried automatically.
  if (row.status === "sending") return row.attemptedAt && now.getTime() - Date.parse(row.attemptedAt) < 60_000 ? "send_pending" : "delivery_unknown";
  if (row.signedUp) return "already_signed_up";
  return null;
}

function openIntent(raw: unknown, now: Date): SendIntent | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  try {
    const opened = openSecret(raw);
    if (opened.prev) return null;
    const v = JSON.parse(opened.text);
    if (v?.kind !== TOKEN_KIND || !Number.isSafeInteger(v.id) || v.id < 1 || typeof v.email !== "string" || normalizeEmail(v.email) !== v.email
      || typeof v.digest !== "string" || !/^[a-f0-9]{64}$/.test(v.digest)
      || !Number.isSafeInteger(v.issuedAt) || v.issuedAt > now.getTime()
      || v.expiresAt !== v.issuedAt + TOKEN_TTL_MS || v.expiresAt <= now.getTime()) return null;
    return v as SendIntent;
  } catch { return null; }
}

export async function previewWaitlistEmail(ref: unknown, deps: WaitlistEmailDeps = {}): Promise<AdminWaitlistPreview> {
  const target = openAdminRef(ref);
  if (target?.kind !== "waitlist") throw new WaitlistEmailError("preview_expired", "Open the waitlist entry again to preview its invitation.");
  const now = (deps.now ?? (() => new Date()))();
  const row = await recipient(target.id);
  const { config, message, from, digest } = rendered(deps);
  const reason = deliveryReason(row, now) ?? (!config ? "email_unavailable" : await (deps.signupMode ?? effectiveSignupMode)() !== "open" ? "signup_closed" : null);
  const intent: SendIntent = { kind: TOKEN_KIND, id: row.id, email: row.email, digest, issuedAt: now.getTime(), expiresAt: now.getTime() + TOKEN_TTL_MS };
  return { subject: message.subject, text: message.text, from, replyTo: REPLY_TO, toMasked: maskAdminEmail(row.email), sendToken: reason ? null : encryptSecret(JSON.stringify(intent)), canSend: reason === null, reason, sentAt: row.sentAt };
}

function statusResult(row: Recipient, now: Date): AdminWaitlistSendResult | null {
  const reason = deliveryReason(row, now);
  return reason === "already_sent" || reason === "send_pending" || reason === "delivery_unknown" ? { status: reason, sentAt: row.sentAt } : null;
}

async function providerWithin(work: Promise<EmailResult>, waitMs: number): Promise<EmailResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<EmailResult>((resolve) => { timer = setTimeout(() => resolve({ sent: false, reason: "failed" }), waitMs); })]);
  } finally { clearTimeout(timer); }
}

/** Explicit operator action only. Neither a preview nor a repeated send can deliver another email. */
export async function sendWaitlistEmail(raw: unknown, deps: WaitlistEmailDeps = {}): Promise<AdminWaitlistSendResult> {
  const now = (deps.now ?? (() => new Date()))();
  const intent = openIntent(raw, now);
  if (!intent) throw new WaitlistEmailError("preview_expired", "This preview has expired. Preview the invitation again before sending.");
  const row = await recipient(intent.id);
  if (row.email !== intent.email) throw new WaitlistEmailError("recipient_changed", "This recipient changed. Open a fresh preview before sending.");
  const existing = statusResult(row, now);
  if (existing) return existing;
  if (row.signedUp) throw new WaitlistEmailError("already_signed_up", "This person already has a Maple account.");
  const { config, message, digest } = rendered(deps);
  if (!config) throw new WaitlistEmailError("email_unavailable", "Email sending is not configured right now.");
  if (intent.digest !== digest) throw new WaitlistEmailError("preview_expired", "The invitation changed. Preview it again before sending.");
  if (await (deps.signupMode ?? effectiveSignupMode)() !== "open") throw new WaitlistEmailError("signup_closed", "New-family signup is not open right now.");

  const claimed = await query(`INSERT INTO maple_waitlist_outreach (waitlist_id, campaign, status, attempted_at)
    SELECT w.id, $2, 'sending', $4::timestamptz FROM maple_waitlist w
    WHERE w.id = $1 AND w.email = $3 AND NOT ${SIGNED_UP}
    ON CONFLICT (waitlist_id, campaign) DO NOTHING RETURNING waitlist_id`, [row.id, CAMPAIGN, row.email, now.toISOString()]);
  if (claimed === null) throw new StoreUnavailable();
  if (!claimed.length) {
    const current = await recipient(row.id);
    const already = statusResult(current, now);
    if (already) return already;
    throw new WaitlistEmailError("recipient_changed", "This waitlist entry changed. Open a fresh preview before sending.");
  }

  const result = await providerWithin(sendEmail({ ...message, to: row.email, kind: "waitlist_launch", idempotencyKey: `${CAMPAIGN}/${row.id}` }, deps.email), deps.waitMs ?? SEND_WAIT_MS);
  if (!result.sent) {
    try {
      await query(`UPDATE maple_waitlist_outreach SET status = 'uncertain' WHERE waitlist_id = $1 AND campaign = $2 AND status = 'sending'`, [row.id, CAMPAIGN]);
    } catch { /* The preexisting claim still prevents a duplicate send. */ }
    return { status: "delivery_unknown", sentAt: null };
  }
  const sentAt = (deps.now ?? (() => new Date()))().toISOString();
  try {
    const saved = await query(`UPDATE maple_waitlist_outreach SET status = 'sent', sent_at = $3::timestamptz, provider_id = $4
      WHERE waitlist_id = $1 AND campaign = $2 AND status = 'sending' RETURNING waitlist_id`, [row.id, CAMPAIGN, sentAt, result.id]);
    // If tracking cannot be finalized, the durable claim still blocks another
    // send. Show uncertainty rather than implying a safely retryable failure.
    if (!saved?.length) return { status: "delivery_unknown", sentAt: null };
  } catch { return { status: "delivery_unknown", sentAt: null }; }
  return { status: "sent", sentAt };
}
