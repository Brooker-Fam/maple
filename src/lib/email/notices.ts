import type { FamilyScope } from "@/lib/maple/family";
import { getBaby } from "@/lib/maple/store";
import { voiceFor } from "@/lib/maple/voice";
import { captureServerException, scrubError } from "@/lib/posthog-server";
import { allowInviteEmail } from "./limit";
import { emailConfig, sendEmail, type EmailDeps, type EmailResult } from "./send";
import { inviteEmail, welcomeEmail } from "./templates";

export const EMAIL_WAIT_MS = 4000;

export type NoticeDeps = Partial<EmailDeps> & {
  allow?: (sender: string) => Promise<boolean>;
  waitMs?: number;
};

/** `work`, or `fallback` once `ms` pass first: a slow provider never holds the person who's waiting. */
export function within<T>(ms: number, work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

async function reportQuietly(deps: Partial<EmailDeps>, error: unknown, kind: string): Promise<void> {
  try {
    await (deps.report ?? captureServerException)(scrubError(error), { where: "email", kind });
  } catch {}
}

export async function babyNameFor(fam: Pick<FamilyScope, "familyId">): Promise<string | null> {
  try {
    const voice = voiceFor(fam.familyId, await getBaby(fam));
    return voice.named ? voice.name : null;
  } catch {
    return null;
  }
}

export type InviteNotice = {
  inviteId: number;
  to: string;
  sender: string;
  inviter: string | null;
  baby: string | null;
  link: string;
  expiresAt: string | Date;
  timeZone: string;
  origin: string;
};

export async function emailInvite(n: InviteNotice, deps: NoticeDeps = {}): Promise<boolean> {
  const { allow = allowInviteEmail, waitMs = EMAIL_WAIT_MS, ...send } = deps;
  try {
    if (!emailConfig(send.env ?? process.env)) return false;
    const rendered = inviteEmail({
      inviter: n.inviter,
      baby: n.baby,
      link: n.link,
      expiresAt: new Date(n.expiresAt),
      timeZone: n.timeZone,
      origin: n.origin,
    });
    if (!(await allow(n.sender))) return false;
    const result = await within<EmailResult>(
      waitMs,
      sendEmail({ ...rendered, to: n.to, kind: "invite", idempotencyKey: `invite/${n.inviteId}` }, send),
      { sent: false, reason: "failed" }
    );
    return result.sent;
  } catch (error) {
    await reportQuietly(send, error, "invite");
    return false;
  }
}

export type WelcomeNotice = { familyId: number; to: string; name: string | null; origin: string };

export async function emailWelcome(n: WelcomeNotice, deps: Partial<EmailDeps> = {}): Promise<EmailResult> {
  try {
    const first = n.name?.trim().split(/\s+/)[0] || null;
    const rendered = welcomeEmail({ name: first, baby: null, origin: n.origin });
    return await sendEmail({ ...rendered, to: n.to, kind: "welcome", idempotencyKey: `welcome/${n.familyId}` }, deps);
  } catch (error) {
    await reportQuietly(deps, error, "welcome");
    return { sent: false, reason: "failed" };
  }
}
