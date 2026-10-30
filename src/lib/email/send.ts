import { Resend } from "resend";
import { captureServerException, scrubError } from "@/lib/posthog-server";
import { normalizeEmail } from "@/lib/waitlist";

/** The same inbox as CONTACT_EMAIL in src/components/site/legal.tsx (pnpm check:email holds them together). */
export const REPLY_TO = "hello@maplebaby.app";

export type Email = {
  to: string;
  subject: string;
  text: string;
  html: string;
  kind: string;
  /** The same key within 24 hours sends once. Build it from ids, never from an address. */
  idempotencyKey?: string;
  /** Where a reply goes, when not REPLY_TO: only feedback sets it, to the person who sent it. */
  replyTo?: string;
};

/** `off`: no Resend key or domain here, so the caller shows the link to copy instead. */
export type EmailResult = { sent: true; id: string } | { sent: false; reason: "off" | "invalid" | "failed" };

export type EmailPayload = { from: string; to: string; replyTo: string; subject: string; text: string; html: string };

type TransportError = { name?: unknown; statusCode?: unknown; message?: unknown };

export type Transport = (
  payload: EmailPayload,
  options: { idempotencyKey?: string }
) => Promise<{ data: { id: string } | null; error: TransportError | null }>;

export type EmailDeps = {
  env: Record<string, string | undefined>;
  transport: (key: string) => Transport;
  report: (error: Error, properties: Record<string, unknown>) => unknown;
};

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const KEY_RE = /^[A-Za-z0-9_.:/-]{1,256}$/;
const KIND_RE = /^[a-z_-]{1,30}$/;

export function emailConfig(env: Record<string, string | undefined>): { key: string; from: string } | null {
  const key = env.RESEND_API_KEY?.trim();
  const domain = env.RESEND_EMAIL_DOMAIN?.trim().toLowerCase();
  if (!key || !domain || !DOMAIN_RE.test(domain)) return null;
  return { key, from: `Maple <hello@${domain}>` };
}

export function resendTransport(key: string): Transport {
  const client = new Resend(key);
  // Outside production the SDK prints Resend's error bodies to the console, and Maple never logs what it sends.
  Object.defineProperty(client, "logError", { value: () => {} });
  return (payload, options) => client.emails.send(payload, options);
}

const defaults: EmailDeps = {
  env: process.env,
  transport: resendTransport,
  report: (error, properties) => captureServerException(error, properties),
};

function failure(error: TransportError): Error {
  return scrubError({
    name: typeof error.name === "string" ? error.name : "resend_error",
    code: typeof error.statusCode === "number" ? String(error.statusCode) : undefined,
  });
}

async function quietly(report: EmailDeps["report"], error: Error, kind: string): Promise<void> {
  try {
    await report(error, { where: "email", kind });
  } catch {}
}

/** Sends one email from Maple, or says why not. Never throws, and never logs or reports the address, subject or body. */
export async function sendEmail(email: Email, deps: Partial<EmailDeps> = {}): Promise<EmailResult> {
  const { env, transport, report } = { ...defaults, ...deps };
  const kind = KIND_RE.test(email.kind) ? email.kind : "other";
  const config = emailConfig(env);
  if (!config) return { sent: false, reason: "off" };
  const to = normalizeEmail(email.to);
  const replyTo = email.replyTo === undefined ? REPLY_TO : normalizeEmail(email.replyTo);
  const key = email.idempotencyKey;
  if (!to || !replyTo || !email.subject || /[\r\n]/.test(email.subject) || !email.text || !email.html || (key !== undefined && !KEY_RE.test(key))) {
    return { sent: false, reason: "invalid" };
  }
  try {
    const { data, error } = await transport(config.key)(
      { from: config.from, to, replyTo, subject: email.subject, text: email.text, html: email.html },
      key ? { idempotencyKey: key } : {}
    );
    if (error || !data?.id) {
      await quietly(report, failure(error ?? { name: "resend_no_id" }), kind);
      return { sent: false, reason: "failed" };
    }
    return { sent: true, id: data.id };
  } catch (error) {
    await quietly(report, scrubError(error), kind);
    return { sent: false, reason: "failed" };
  }
}
