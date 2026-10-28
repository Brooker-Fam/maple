import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import { query, transaction } from "@/lib/db";
import { emailConfig, sendEmail, type EmailResult } from "@/lib/email/send";
import { encryptSecret, openSecret } from "@/lib/secret-box";
import { normalizeEmail } from "@/lib/waitlist";
import { connectionKey } from "./family/limits";

export const EMAIL_CODE_TTL_SECONDS = 10 * 60;
export const EMAIL_CODE_ATTEMPTS = 5;
export const EMAIL_RESEND_SECONDS = 60;
export const EMAIL_CODES_PER_ADDRESS_HOUR = 5;
export const EMAIL_CODES_PER_CONNECTION_HOUR = 20;
const SEND_WAIT_MS = 10_000;
const EMAIL_LOCK = 72_620_263;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^\d{6}$/;
const PAYLOAD_KIND = "maple-email-code";

type Failure = { ok: false; error: string; status: number };
export type EmailStart = { ok: true; token: string } | Failure;
export type EmailVerified = { ok: true; email: string; context: unknown } | Failure;

const unavailable = (): Failure => ({ ok: false, error: "Email sign-in is unavailable for a moment. Please try again shortly.", status: 503 });
const invalid = (): Failure => ({ ok: false, error: "That code did not work or has expired. Check it, or request a new code.", status: 400 });

function sessionSecret(): string | null {
  return process.env.MAPLE_SESSION_SECRET?.trim() || process.env.GOOGLE_CLIENT_SECRET?.trim() || null;
}

export function isEmailConfigured(): boolean {
  return !!(emailConfig(process.env) && sessionSecret());
}

/** A ceiling even when a sender rotates addresses and connections. Zero pauses new codes. */
export function emailCodesPerDay(): number {
  const raw = process.env.MAPLE_EMAIL_AUTH_DAILY_MAX?.trim();
  return raw && /^\d{1,6}$/.test(raw) ? Number(raw) : 1_000;
}

function keyed(value: string): string {
  const secret = sessionSecret();
  if (!secret) throw new Error("email_auth_unconfigured");
  return createHmac("sha256", `maple-email-auth:${secret}`).update(value).digest("hex");
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * The lock serializes code issuance, including the address/global counters.
 * Connection attempts are charged even when an address is cooling down.
 * Only accepted sends consume address/global quotas; failed deliveries still
 * consume them so a provider failure cannot turn into a retry storm.
 */
const RESERVE = `
WITH added AS (
  INSERT INTO maple_auth_challenges (token_hash, email_key, code_hash, sealed_payload, expires_at)
  SELECT $1::text, $2::text, $3::text, $4::text, NOW() + INTERVAL '10 minutes'
  WHERE (SELECT COALESCE(SUM(count), 0) FROM upload_rate_limit WHERE ip_hash = $5
    AND window_start >= date_trunc('minute', NOW() - INTERVAL '1 hour')) <= $7
    AND (SELECT COALESCE(SUM(count), 0) FROM upload_rate_limit WHERE ip_hash = $2
      AND window_start >= date_trunc('minute', NOW() - INTERVAL '1 hour')) < $8
    AND (SELECT COALESCE(SUM(count), 0) FROM upload_rate_limit WHERE ip_hash = $6
      AND window_start >= date_trunc('minute', NOW() - INTERVAL '1 day')) < $9
    AND NOT EXISTS (SELECT 1 FROM maple_auth_challenges WHERE email_key = $2
      AND created_at > NOW() - INTERVAL '60 seconds')
  RETURNING token_hash
), address_count AS (
  INSERT INTO upload_rate_limit (ip_hash, window_start, count)
  SELECT $2, date_trunc('minute', NOW()), 1 FROM added
  ON CONFLICT (ip_hash, window_start) DO UPDATE SET count = upload_rate_limit.count + 1
), global_count AS (
  INSERT INTO upload_rate_limit (ip_hash, window_start, count)
  SELECT $6, date_trunc('minute', NOW()), 1 FROM added
  ON CONFLICT (ip_hash, window_start) DO UPDATE SET count = upload_rate_limit.count + 1
)
SELECT token_hash FROM added`;

async function within<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), SEND_WAIT_MS); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Issue a code without revealing whether the address belongs to a family.
 * The caller keeps token in an HttpOnly, same-site cookie; it never goes in
 * the URL or the email. Context must already be validated by the route.
 */
export async function startEmailChallenge(
  req: Request,
  rawEmail: string,
  context: unknown,
  deps: { send?: typeof sendEmail } = {}
): Promise<EmailStart> {
  if (!isEmailConfigured()) return unavailable();
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, error: "Enter an email address like name@example.com.", status: 400 };
  let hash: string | undefined;
  try {
    const payload = JSON.stringify({ kind: PAYLOAD_KIND, email, context });
    if (payload.length > 12_000) return { ok: false, error: "Start email sign-in again from Maple.", status: 400 };
    const token = randomBytes(32).toString("base64url");
    hash = tokenHash(token);
    const code = randomInt(1_000_000).toString().padStart(6, "0");
    const addressKey = keyed(`address:${email}`);
    // Also key with this flow's session secret: email-only deployments may
    // have neither the Google nor MCP secret used by connectionKey.
    const ipKey = keyed(`connection:${connectionKey(req, "email-auth-start")}`);
    const out = await transaction([
      { sql: `SELECT pg_advisory_xact_lock(${EMAIL_LOCK})` },
      { sql: `DELETE FROM maple_auth_challenges WHERE expires_at <= NOW()` },
      { sql: `DELETE FROM upload_rate_limit WHERE window_start < NOW() - INTERVAL '1 day'` },
      {
        sql: `INSERT INTO upload_rate_limit (ip_hash, window_start, count)
          VALUES ($1, date_trunc('minute', NOW()), 1)
          ON CONFLICT (ip_hash, window_start) DO UPDATE SET count = upload_rate_limit.count + 1`,
        params: [ipKey],
      },
      {
        sql: RESERVE,
        params: [hash, addressKey, keyed(`code:${hash}:${code}`), encryptSecret(payload), ipKey, keyed("global"),
          EMAIL_CODES_PER_CONNECTION_HOUR, EMAIL_CODES_PER_ADDRESS_HOUR, emailCodesPerDay()],
      },
    ]);
    if (!out) return unavailable();
    if (!out[out.length - 1]?.length) {
      return { ok: false, error: "Please wait a minute before requesting another code. If you have tried several times, try again later.", status: 429 };
    }
    const text = `Your Maple sign-in code is:\n\n${code}\n\nEnter it on the screen where you requested it. It expires in 10 minutes and works once.\n\nDo not share this code. If you did not ask for it, you can ignore this email.\n`;
    const result = await within<EmailResult>((deps.send ?? sendEmail)({
      to: email,
      subject: "Your Maple sign-in code",
      text,
      html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Your Maple sign-in code</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;font-size:16px;line-height:1.5;padding:24px"><p>Your Maple sign-in code is:</p><p style="font-size:32px;font-weight:600;letter-spacing:6px">${code}</p><p>Enter it on the screen where you requested it. It expires in 10 minutes and works once.</p><p>Do not share this code. If you did not ask for it, you can ignore this email.</p></body></html>`,
      kind: "signin",
      idempotencyKey: `email-auth/${hash}`,
    }), { sent: false, reason: "failed" });
    if (!result.sent) {
      await query(`UPDATE maple_auth_challenges SET consumed_at = NOW(), sealed_payload = '' WHERE token_hash = $1`, [hash]);
      return unavailable();
    }
    return { ok: true, token };
  } catch {
    // Database/provider failures must never become an uncounted sign-in.
    // Do not report the error body: SQL errors can quote an email or code.
    if (hash) {
      try { await query(`UPDATE maple_auth_challenges SET consumed_at = NOW(), sealed_payload = '' WHERE token_hash = $1`, [hash]); } catch {}
    }
    return unavailable();
  }
}

/**
 * One UPDATE both charges an attempt and consumes a correct code. Its row
 * lock and predicate are rechecked after concurrent updates, so only one
 * request can win and five guesses exhaust the challenge across servers.
 */
export async function verifyEmailChallenge(token: string, code: string): Promise<EmailVerified> {
  if (!TOKEN.test(token) || !CODE.test(code)) return invalid();
  if (!sessionSecret()) return unavailable();
  try {
    const hash = tokenHash(token);
    const rows = await query(
      `UPDATE maple_auth_challenges SET attempts = attempts + 1,
        consumed_at = CASE WHEN code_hash = $2 THEN NOW() ELSE consumed_at END
       WHERE token_hash = $1 AND expires_at > NOW() AND consumed_at IS NULL AND attempts < $3
       RETURNING CASE WHEN code_hash = $2 THEN sealed_payload ELSE NULL END AS payload`,
      [hash, keyed(`code:${hash}:${code}`), EMAIL_CODE_ATTEMPTS]
    );
    if (!rows) return unavailable();
    const payload = rows[0]?.payload;
    if (typeof payload !== "string" || !payload) return invalid();
    const opened = openSecret(payload);
    if (opened.prev) return invalid();
    const parsed = JSON.parse(opened.text);
    const email = normalizeEmail(parsed?.email);
    if (parsed?.kind !== PAYLOAD_KIND || !email) return invalid();
    return { ok: true, email, context: parsed.context };
  } catch {
    return unavailable();
  }
}
