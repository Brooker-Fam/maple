import { createECDH, createHash, hkdfSync, randomBytes } from "node:crypto";
import webpush from "web-push";
import { query } from "@/lib/db";
import { captureServerException } from "@/lib/posthog-server";
import { careAccess, careTime, planActive, type CareViewer } from "./care";
import { ACCEPTED_MEMBERSHIP, FAMILY_ONE, familiesWithPhones, familyScope, resolveFamily, type FamilyCtx, type FamilyScope } from "./family";
import { memberName } from "./insights";
import {
  collectMoments,
  ensureSafetyNet,
  familyAdminAs,
  familyCarePerson,
  familyMembers,
  familyPlans,
  familySent,
  netMinutes,
  nextWake,
  remindKind,
  scheduleWake,
  scheduleWakeups,
  schedulerMode,
  type DueMoment,
  type PlanMoments,
  type SchedulerMode,
  type Via,
} from "./push-wake";
import type { CarePerson, CarePlan, Member, Source } from "./types";
import { MAPLE_ORIGIN } from "./origin";

/**
 * Notifications by Web Push.
 *
 * Phones turn them on one by one (on iPhone, from the Home Screen app only,
 * iOS 16.4+); each phone's settings live with its subscription
 * (maple_push_subs.prefs). What can be sent:
 *   - her medicines: "OK again" when an as-needed or every-few-hours
 *     medicine's gap and 24-hour limit have cleared, and each set time no
 *     dose or skip has filled (dueMoments in push-wake.ts), to every phone
 *     signed in as a family member (viewers get nothing of hers);
 *   - "Logged" (notify.ts): a dose or skip was saved, to the phones that got
 *     that medicine's reminder since its previous dose, plus phones that
 *     asked for every dose, never the phone that logged it;
 *   - the nursing timer on the lock screen (notify.ts), opt-in per phone;
 *   - "Send a test in 1 minute", through the same scheduled path.
 * Never a dose, never "take it now": the times are her own plan's.
 *
 * Nothing is queued: each tick works out what's due from the plans and
 * doses as they are, so a dose deleted or moved never leaves a stale
 * reminder. Every send is claimed once per phone (maple_push_sent, key
 * `s<sub>|<what>`); a send the push service refuses for now (429, 5xx, a
 * timeout) gives its claim back for up to 3 tries. A reminder more than 3
 * hours late isn't sent; past 10 minutes late it says how long it has been.
 *
 * Every notice about a medicine shares the tag med:<planId>, and the service
 * worker closes the older one before showing the newer (iOS ignores tag
 * replacement), so "Logged" replaces "OK again" instead of stacking. Each
 * payload carries a receipt token the worker posts back (/push/receipt), so
 * the sheet can say when a notice last reached this phone.
 *
 * Ticks: QStash wake-ups at the exact moments when it's set up (push-wake.ts),
 * the GitHub workflow as a backstop, writes (after()) and an open app's polls.
 *
 * Families: a phone belongs to one family (a phone in two has a row in
 * each), and every read and write here names it. A tick works one family at
 * a time, with that family's members, her page and timezone, so a family's
 * notices only ever reach its own phones. A family's own tick (its wakes,
 * its writes, its members' polls) touches only that family; the safety net,
 * the cron and outside callers walk every family in turn.
 */

export type PushPrefs = {
  /** Her medicines' reminders at all (default on); `ok` and `at` pick within it. */
  meds?: boolean;
  /** "OK again" for as-needed and every-few-hours medicines (default on). */
  ok?: boolean;
  /** Set-time reminders (default on). */
  at?: boolean;
  /** "Logged" after a reminder this phone got: the loop closing (default on). */
  closing?: boolean;
  /** Every dose of hers logged elsewhere, even with no reminder pending (default off). */
  logged?: boolean;
  /** "Maple's Log" on the lock screen instead of the medicine's name. */
  hide_names?: boolean;
  /** Plans this phone doesn't want notices for. */
  muted?: number[];
  /** The running nursing feed on the lock screen (default off). */
  nursing?: boolean;
};

export type PushSub = {
  id: number;
  family_id: number;
  member: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  prefs: PushPrefs;
  /** A label the phone gave ("iPhone"); never shown as a person. */
  device: string | null;
  /** The per-install id (device.ts), to skip the phone that did the action. */
  device_id: string | null;
  receipt_token: string | null;
  needs_resubscribe: boolean;
  last_sent_at: string | null;
  last_delivered_at: string | null;
  last_delivered_key: string | null;
  undelivered: number;
  test_due_at: string | null;
  test_sent_at: string | null;
  test_via: string | null;
  test_key: string | null;
};

type Row = Record<string, unknown>;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
/** A reminder more than this late (the clock was down) isn't sent. */
export const CUTOFF_MS = 3 * HOUR;
/** Past this, a reminder says how long it has been OK ("has been OK since 8:00 AM"). */
const LATE_MS = 10 * MIN;
/** A gap between ticks this long is kept for the health line. */
const GAP_MS = 45 * MIN;
const MAX_ATTEMPTS = 3;
const SUBJECT = `${MAPLE_ORIGIN}/maple`;

async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const rows = await query(sql, params);
  if (rows === null) throw new Error("No database");
  return rows as Row[];
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string | Date).toISOString());
const str = (v: unknown): string | null => (v == null ? null : String(v));
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let keys: { publicKey: string; privateKey: string } | null | undefined;

/**
 * The VAPID keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY when set, else a P-256
 * key derived from MCP_SECRET (or GOOGLE_CLIENT_SECRET), so there's nothing
 * new to configure. Rotating that secret means each phone turns notifications
 * on again (its subscription is tied to the old key).
 */
export function vapidKeys(): { publicKey: string; privateKey: string } | null {
  if (keys !== undefined) return keys;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (pub && priv) return (keys = { publicKey: pub, privateKey: priv });
  const seed = process.env.MCP_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  if (!seed) return (keys = null);
  const order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
  for (let i = 0; i < 8; i++) {
    const d = Buffer.from(hkdfSync("sha256", seed, "maple-push", `vapid-${i}`, 32));
    const k = BigInt(`0x${d.toString("hex")}`);
    if (k === BigInt(0) || k >= order) continue;
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(d);
    return (keys = { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(d) });
  }
  return (keys = null);
}

export const rowToSub = (r: Row): PushSub => ({
  id: Number(r.id),
  family_id: Number(r.family_id),
  member: String(r.member),
  endpoint: String(r.endpoint),
  p256dh: String(r.p256dh),
  auth: String(r.auth),
  prefs: (r.prefs ?? {}) as PushPrefs,
  device: str(r.device),
  device_id: str(r.device_id),
  receipt_token: str(r.receipt_token),
  needs_resubscribe: r.needs_resubscribe === true,
  last_sent_at: iso(r.last_sent_at),
  last_delivered_at: iso(r.last_delivered_at),
  last_delivered_key: str(r.last_delivered_key),
  undelivered: Number(r.undelivered ?? 0),
  test_due_at: iso(r.test_due_at),
  test_sent_at: iso(r.test_sent_at),
  test_via: str(r.test_via),
  test_key: str(r.test_key),
});

export function cleanPrefs(v: unknown): PushPrefs {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const out: PushPrefs = {};
  if (typeof o.meds === "boolean") out.meds = o.meds;
  if (typeof o.ok === "boolean") out.ok = o.ok;
  if (typeof o.at === "boolean") out.at = o.at;
  if (typeof o.closing === "boolean") out.closing = o.closing;
  if (typeof o.logged === "boolean") out.logged = o.logged;
  if (typeof o.hide_names === "boolean") out.hide_names = o.hide_names;
  if (typeof o.nursing === "boolean") out.nursing = o.nursing;
  if (Array.isArray(o.muted)) out.muted = o.muted.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 100);
  return out;
}

type Fam = Pick<FamilyScope, "familyId">;

/**
 * Save (or move to this member of the family) a phone's subscription.
 * `deviceId` is the per-install id from X-Maple-Device; a save without one
 * keeps the stored id. Saving again clears "needs resubscribe" and keeps the
 * phone's receipt token. The same phone in another family is that family's
 * row, never this one.
 */
export async function saveSub(
  fam: Fam,
  member: string,
  sub: { endpoint: string; p256dh: string; auth: string },
  prefs: PushPrefs,
  device: string | null,
  opts: { deviceId?: string | null } = {}
): Promise<PushSub> {
  const rows = await q(
    `INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, prefs, device, device_id, receipt_token)
     VALUES ($9, $1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     ON CONFLICT (family_id, endpoint) DO UPDATE SET member = $1, p256dh = $3, auth = $4, prefs = $5::jsonb, device = $6,
       device_id = COALESCE($7, maple_push_subs.device_id), receipt_token = COALESCE(maple_push_subs.receipt_token, $8),
       failures = 0, needs_resubscribe = FALSE, updated_at = NOW()
     RETURNING *`,
    [member, sub.endpoint, sub.p256dh, sub.auth, JSON.stringify(prefs), device, opts.deviceId ?? null, randomBytes(16).toString("hex"), fam.familyId]
  );
  return rowToSub(rows[0]);
}

/**
 * The browser replaced this phone's subscription (the worker's
 * pushsubscriptionchange, or turning a stopped phone back on): the new one
 * takes over the old one's settings, label, id and receipt token, and the
 * old row goes. `deviceId` fills in an id the old row never had. Null when
 * the old one isn't this member's in this family. The same person's row for
 * the old endpoint in their other families follows it, since the browser has
 * only one subscription.
 */
export async function moveSub(
  fam: Fam,
  member: string,
  oldEndpoint: string,
  sub: { endpoint: string; p256dh: string; auth: string },
  opts: { deviceId?: string | null } = {}
): Promise<PushSub | null> {
  const old = await subFor(fam, member, oldEndpoint);
  if (!old) return null;
  if (old.endpoint !== sub.endpoint) await q(`DELETE FROM maple_push_subs WHERE id = $1 AND family_id = $2`, [old.id, fam.familyId]);
  const rows = await q(
    `INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, prefs, device, device_id, receipt_token)
     VALUES ($9, $1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     ON CONFLICT (family_id, endpoint) DO UPDATE SET member = $1, p256dh = $3, auth = $4, prefs = $5::jsonb, device = $6,
       device_id = COALESCE($7, maple_push_subs.device_id), receipt_token = COALESCE($8, maple_push_subs.receipt_token),
       failures = 0, needs_resubscribe = FALSE, updated_at = NOW()
     RETURNING *`,
    [member, sub.endpoint, sub.p256dh, sub.auth, JSON.stringify(old.prefs), old.device, old.device_id ?? opts.deviceId ?? null, old.receipt_token ?? randomBytes(16).toString("hex"), fam.familyId]
  );
  if (old.endpoint !== sub.endpoint) {
    await q(
      `DELETE FROM maple_push_subs o WHERE o.member = $1 AND o.endpoint = $2 AND o.family_id <> $3 AND ${STILL_MEMBER("o")}
         AND EXISTS (SELECT 1 FROM maple_push_subs n WHERE n.family_id = o.family_id AND n.endpoint = $4)`,
      [member, old.endpoint, fam.familyId, sub.endpoint]
    );
  }
  await q(
    `UPDATE maple_push_subs o SET endpoint = $4, p256dh = $5, auth = $6, failures = 0, needs_resubscribe = FALSE, updated_at = NOW()
     WHERE o.member = $1 AND o.endpoint = $2 AND o.family_id <> $3 AND ${STILL_MEMBER("o")}`,
    [member, old.endpoint, fam.familyId, sub.endpoint, sub.p256dh, sub.auth]
  );
  return rowToSub(rows[0]);
}

const STILL_MEMBER = (sub: string) =>
  `EXISTS (SELECT 1 FROM maple_members m JOIN maple_families f ON f.id = m.family_id
     WHERE m.family_id = ${sub}.family_id AND m.email = ${sub}.member AND f.status <> 'deleting' AND ${ACCEPTED_MEMBERSHIP("m")})`;

/** A phone that was on before per-install ids existed: remember this one (only when it has none). */
export async function fillDeviceId(fam: Fam, subId: number, deviceId: string): Promise<void> {
  await q(`UPDATE maple_push_subs SET device_id = $2 WHERE id = $1 AND family_id = $3 AND device_id IS NULL`, [subId, deviceId, fam.familyId]);
}

/** This member's subscription for an endpoint in this family (another member's or family's phone reads as none). */
export async function subFor(fam: Fam, member: string, endpoint: string): Promise<PushSub | null> {
  const rows = await q(`SELECT * FROM maple_push_subs WHERE endpoint = $1 AND member = $2 AND family_id = $3`, [endpoint, member, fam.familyId]);
  return rows.length ? rowToSub(rows[0]) : null;
}

export async function patchPrefs(fam: Fam, member: string, endpoint: string, prefs: PushPrefs): Promise<PushSub | null> {
  const rows = await q(`UPDATE maple_push_subs SET prefs = $3::jsonb, updated_at = NOW() WHERE endpoint = $1 AND member = $2 AND family_id = $4 RETURNING *`, [
    endpoint,
    member,
    JSON.stringify(prefs),
    fam.familyId,
  ]);
  return rows.length ? rowToSub(rows[0]) : null;
}

/** `everywhere` (sign-out): the same person's row for this phone in each of their other families goes too. */
export async function deleteSub(fam: Fam, member: string, endpoint: string, opts: { everywhere?: boolean } = {}): Promise<void> {
  await q(`DELETE FROM maple_push_subs WHERE endpoint = $1 AND member = $2 AND family_id = $3`, [endpoint, member, fam.familyId]);
  if (opts.everywhere) await q(`DELETE FROM maple_push_subs o WHERE o.endpoint = $1 AND o.member = $2 AND ${STILL_MEMBER("o")}`, [endpoint, member]);
}

/** This member's phones in this family. */
export async function subsOf(fam: Fam, member: string): Promise<PushSub[]> {
  return (await q(`SELECT * FROM maple_push_subs WHERE member = $1 AND family_id = $2 ORDER BY id`, [member, fam.familyId])).map(rowToSub);
}

/** The family's phones that can get something (a phone whose keys stopped matching waits until it turns notifications on again). */
export async function liveSubs(fam: Fam): Promise<PushSub[]> {
  return (await q(`SELECT s.* FROM maple_push_subs s JOIN maple_members m ON m.family_id = s.family_id AND m.email = s.member
    WHERE s.family_id = $1 AND NOT s.needs_resubscribe AND m.role <> 'photos' AND ${ACCEPTED_MEMBERSHIP("m")} ORDER BY s.id`, [fam.familyId])).map(rowToSub);
}

/**
 * The family a push route acts in: the one the request resolved, or, for a
 * caller that passes none, family 1 for a family-1 member (a carrier without
 * a family) and nothing for anyone else.
 */
export async function pushFamily(me: Member, ctx?: FamilyCtx | null): Promise<FamilyCtx | null> {
  if (ctx) return ctx.member === me.email ? ctx : null;
  return resolveFamily(me.email, undefined);
}

// ── sending ───────────────────────────────────────────────────────────

/** What the worker gets: the words, the tag it replaces, where a tap goes, and what it's about. */
export type Notice = {
  title: string;
  body: string;
  tag: string;
  url: string;
  /** Shown without a sound or buzz (the nursing timer). */
  silent?: boolean;
  data: { kind: "ok" | "at" | "logged" | "test" | "hello" | "nurse"; plan?: number; entry?: number; ts?: number };
};

/** The old name of a Notice, for callers that only send words. */
export type PushMessage = Notice;

export type Outcome = "sent" | "failed" | "gone" | "stopped";

/** A push service's 403 that means this phone's subscription belongs to other keys (it must subscribe again). */
const keyMismatch = (body: unknown) => /VapidPkHashMismatch|BadJwtToken|InvalidProviderToken|does not correspond|mismatch|vapid/i.test(String(body ?? ""));

/** Topic: an undelivered notice is replaced by a newer one with the same tag for the same phone (RFC 8030). */
const topicFor = (subId: number, tag: string) => createHash("sha256").update(`${subId}:${tag}`).digest("base64url").slice(0, 32);

/**
 * Send one notice to one phone. `key` rides along for the receipt. A phone
 * that's gone (404/410) or whose keys stopped matching (a 403 about keys) is
 * marked for turning on again, keeping its settings for when it does (rows
 * left that way for 30 days go); anything else counts a failure (and the
 * claim is given back).
 */
export async function deliver(sub: PushSub, n: Notice, opts: { key: string; ttlS: number; urgency?: "high" | "normal" }): Promise<Outcome> {
  const member = await resolveFamily(sub.member, sub.family_id);
  if (!member || member.role === "photos") return "stopped";
  const k = vapidKeys();
  if (!k) return "failed";
  const payload = {
    title: n.title,
    body: n.body,
    tag: n.tag,
    url: n.url,
    ...(n.silent ? { silent: true } : {}),
    data: { ...n.data, sent: Date.now() },
    ...(sub.receipt_token ? { r: sub.receipt_token, k: opts.key.slice(0, 120) } : {}),
  };
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), {
      vapidDetails: { subject: SUBJECT, publicKey: k.publicKey, privateKey: k.privateKey },
      TTL: Math.max(60, Math.round(opts.ttlS)),
      urgency: opts.urgency ?? "high",
      topic: topicFor(sub.id, n.tag),
      timeout: 10_000,
    });
  } catch (err) {
    return refused(sub, err);
  }
  // Sent: bookkeeping that fails must not turn it into a retry (that would send it twice).
  await q(`UPDATE maple_push_subs SET failures = 0, last_sent_at = NOW(), undelivered = undelivered + 1 WHERE id = $1 AND family_id = $2`, [sub.id, sub.family_id]).catch(() => null);
  return "sent";
}

/** What a push service's refusal means for this phone. */
async function refused(sub: PushSub, err: unknown): Promise<Outcome> {
  const e = err as { statusCode?: number; body?: unknown };
  const status = e.statusCode;
  if (status === 404 || status === 410) {
    // Kept, not deleted: turning the phone back on carries over its settings (hidden names, muted medicines).
    await q(`UPDATE maple_push_subs SET needs_resubscribe = TRUE, updated_at = NOW() WHERE id = $1 AND family_id = $2`, [sub.id, sub.family_id]);
    return "gone";
  }
  if (status === 403 && keyMismatch(e.body)) {
    await q(`UPDATE maple_push_subs SET needs_resubscribe = TRUE, failures = failures + 1, updated_at = NOW() WHERE id = $1 AND family_id = $2`, [sub.id, sub.family_id]);
    void captureServerException(new Error("push send 403 keys"), { route: "maple push" });
    return "stopped";
  }
  await q(`UPDATE maple_push_subs SET failures = failures + 1 WHERE id = $1 AND family_id = $2`, [sub.id, sub.family_id]);
  await q(`DELETE FROM maple_push_subs WHERE id = $1 AND family_id = $2 AND failures >= 10`, [sub.id, sub.family_id]);
  // A code only: the push service's message can carry the phone's endpoint.
  void captureServerException(new Error(`push send failed${status ? ` ${status}` : ""}`), { route: "maple push" });
  return "failed";
}

/** Send now, no claim (the sheet's "Send one now"). */
export async function sendPush(sub: PushSub, n: Notice): Promise<boolean> {
  return (await deliver(sub, n, { key: `hello:${sub.id}:${Date.now()}`, ttlS: 300 })) === "sent";
}

/**
 * Claim `key` for one phone, once: a claim that failed (or got stuck
 * sending) can be claimed again after 50 seconds, up to 3 attempts. Returns
 * the claim's row key, or null when it's taken. The claim is filed under the
 * phone's family.
 */
export async function claim(sub: Pick<PushSub, "id" | "family_id">, key: string, ref: string | null): Promise<string | null> {
  const k = `s${sub.id}|${key}`;
  const rows = await q(
    `INSERT INTO maple_push_sent (key, sent_at, state, attempts, sub_id, ref, family_id) VALUES ($1, NOW(), 'sending', 1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET state = 'sending', attempts = maple_push_sent.attempts + 1, sent_at = NOW()
     WHERE maple_push_sent.attempts < ${MAX_ATTEMPTS} AND (
       (maple_push_sent.state = 'failed' AND maple_push_sent.sent_at < NOW() - INTERVAL '50 seconds')
       OR (maple_push_sent.state = 'sending' AND maple_push_sent.sent_at < NOW() - INTERVAL '2 minutes'))
     RETURNING key`,
    [k, sub.id, ref, sub.family_id]
  );
  return rows.length ? k : null;
}

/** Record how a claimed send went: sent (or the phone is gone) stays claimed; a failure can be claimed again. */
export async function settle(claimKey: string, outcome: Outcome): Promise<void> {
  await q(`UPDATE maple_push_sent SET state = $2 WHERE key = $1`, [claimKey, outcome === "sent" || outcome === "gone" ? "sent" : "failed"]);
}

/** Claim, send, settle. */
export async function sendOnce(sub: PushSub, key: string, ref: string | null, n: Notice, opts: { ttlS: number; urgency?: "high" | "normal" }): Promise<Outcome | null> {
  const k = await claim(sub, key, ref);
  if (!k) return null;
  let outcome: Outcome = "failed";
  try {
    outcome = await deliver(sub, n, { key, ...opts });
  } finally {
    await settle(k, outcome);
  }
  return outcome;
}

// ── the words ─────────────────────────────────────────────────────────

/** Who's reading: her own phone (signed in as herself) reads "your", any other "for Brittany". No one else is ever named. */
export type Voice = { self: boolean; her: string; tz: string; now: Date };

/** One family's readers of her page, read once per tick from its own rows. */
export type Audience = { scope: FamilyScope; members: Member[]; person: CarePerson | null; adminAs: string | null };

export async function audienceOf(scope: FamilyScope, person?: CarePerson | null): Promise<Audience> {
  const [members, found, adminAs] = await Promise.all([
    familyMembers(scope.familyId),
    person !== undefined ? Promise.resolve(person) : familyCarePerson(scope.familyId),
    familyAdminAs(scope),
  ]);
  return { scope, members, person: found, adminAs };
}

/** The reader behind a member id, after the admin login's admin_as swap (viewerFor's rule). */
function readerOf(member: Member, a: Audience): CareViewer {
  if (member.email !== "admin") return { id: member.email, role: member.role, viaAdmin: false, channel: "app" };
  const as = a.members.find((m) => m.email === a.adminAs && m.email !== "admin" && m.role !== "viewer" && m.role !== "photos");
  return { id: as?.email ?? "admin", role: as?.role ?? "owner", viaAdmin: true, channel: "app" };
}

/** How her notices read on this member's phones, or null when the member can't read her page (viewers, no page, not in the family). */
export function voiceFor(a: Audience, memberId: string, now: Date): Voice | null {
  const member = a.members.find((m) => m.email === memberId);
  if (!member || !a.person) return null;
  const access = careAccess(readerOf(member, a), a.person, a.members);
  if (!access.read) return null;
  return { self: access.self, her: memberName(a.person.member, a.members), tz: a.scope.tz, now };
}
export const whose = (v: Voice) => (v.self ? "your" : "her");
export const forHer = (v: Voice) => (v.self ? "" : ` for ${v.her}`);
export const when = (v: Voice, at: string | number) => careTime(at, v.now, v.tz);

/** ", with Siri" / ", from Claude" after "Last taken 8:10 PM" (the app adds nothing: phones aren't people). */
function viaWords(source: Source): string {
  if (source === "shortcut") return ", with Siri";
  if (source === "chatgpt") return ", from ChatGPT";
  if (source === "muse") return ", from Muse";
  if (source === "grok") return ", from Grok";
  if (source === "chat") return ", from Maple chat";
  if (source === "claude" || source === "mcp") return ", from Claude";
  return "";
}

/** "OK again" or a set time, as this phone reads it. */
export function medNotice(m: DueMoment, plan: CarePlan, v: Voice, prefs: PushPrefs): Notice {
  const tag = `med:${plan.id}`;
  const url = `/maple?care=1&plan=${plan.id}`;
  const data = { kind: m.kind, plan: plan.id } as const;
  if (prefs.hide_names) {
    const body =
      m.kind === "ok"
        ? v.self
          ? "One of your medicines is OK again, by your schedule."
          : `One of ${v.her}'s medicines is OK again, by her schedule.`
        : v.self
          ? "One of your set times."
          : `One of ${v.her}'s set times.`;
    return { title: "Maple's Log", body, tag, url, data };
  }
  if (m.kind === "ok") {
    const last = m.dose ? ` Last taken ${when(v, m.dose.at)}${viaWords(m.dose.source)}.` : "";
    if (v.now.getTime() - m.at <= LATE_MS) {
      return { title: `${plan.name} is OK again${forHer(v)}`, body: `OK since ${when(v, m.at)}, by ${whose(v)} schedule.${last}`, tag, url, data };
    }
    return { title: `${plan.name} has been OK${forHer(v)} since ${when(v, m.at)}`, body: `By ${whose(v)} schedule.${last}`, tag, url, data };
  }
  return {
    title: `${plan.name} · ${when(v, m.at)}${forHer(v)}`,
    body: v.self ? "One of your set times. Tap to log it once you've taken it." : `One of ${v.her}'s set times. Tap to log it once she's taken it.`,
    tag,
    url,
    data,
  };
}

export const TEST_NOTICE: Notice = {
  title: "Test reminder",
  body: "This phone gets reminders, even when it's locked.",
  tag: "test",
  url: "/maple",
  data: { kind: "test" },
};

export const HELLO_NOTICE: Notice = {
  title: "Notifications are on",
  body: "Maple's notifications will show up on this phone like this one.",
  tag: "test",
  url: "/maple",
  data: { kind: "hello" },
};

// ── the tick ──────────────────────────────────────────────────────────

/** Ticks that show the server's clock is running (not an open app's poll or a write). */
const CLOCK_VIAS: Via[] = ["wake", "net", "daily", "gh", "ext", "retry", "test"];

/** The runs that walk every family: their tick rows (`tick:<via>`, no family) are every family's clock. */
const SWEEP_TICKS = `family_id IS NULL AND key IN (${(["net", "daily", "gh", "ext"] as Via[]).map((v) => `'tick:${v}'`).join(", ")})`;

/**
 * Family `$n`'s own tick rows. Family 1's include those without a family
 * that aren't the every-family runs': only it (and the code from before
 * families) ever wrote them.
 */
const ownTicks = (n: number) => `key LIKE 'tick:%' AND ${familySent(n)} AND NOT (${SWEEP_TICKS})`;

/** The tick rows family `$n` may read: the every-family runs' and its own, never another family's. */
const familyTicks = (n: number) => `key LIKE 'tick:%' AND (${familySent(n)} OR ${SWEEP_TICKS})`;

async function newestTick(where: string, params: unknown[] = []): Promise<number | null> {
  const rows = await q(`SELECT MAX(sent_at) AS at FROM maple_push_sent WHERE ${where}`, params);
  return rows[0]?.at ? new Date(rows[0].at as string).getTime() : null;
}

/** Record this run: under its family for a one-family run (family 1 keeps its key from before families), else for everyone. */
async function recordTick(via: Via, now: Date, familyId?: number): Promise<void> {
  const key = familyId === undefined || familyId === FAMILY_ONE ? `tick:${via}` : `tick:${familyId}:${via}`;
  await q(
    `INSERT INTO maple_push_sent (key, sent_at, family_id) VALUES ($1, $2::timestamptz, $3)
     ON CONFLICT (key) DO UPDATE SET sent_at = GREATEST(maple_push_sent.sent_at, $2::timestamptz), family_id = $3`,
    [key, now.toISOString(), familyId ?? null]
  );
}

/** A long gap before this run on the family's own health line. */
async function noteGap(familyId: number, before: number | null, now: Date): Promise<void> {
  if (before === null || now.getTime() - before <= GAP_MS) return;
  const iso = new Date(before).toISOString();
  await q(`INSERT INTO maple_push_sent (key, sent_at, family_id) VALUES ($1, $2::timestamptz, $3) ON CONFLICT (key) DO NOTHING`, [
    familyId === FAMILY_ONE ? `gap:${iso}` : `gap:${familyId}:${iso}`,
    now.toISOString(),
    familyId,
  ]);
}

/** Reminders due before this version went live were claimed under the old keys. */
async function floorTime(): Promise<number> {
  const rows = await q(`SELECT sent_at FROM maple_push_sent WHERE key = 'floor:v2'`);
  return rows[0]?.sent_at ? new Date(rows[0].sent_at as string).getTime() : 0;
}

/** A test may go out on this tick: always, except an open app's poll while QStash is the clock (so the result says whether the clock works). */
const mayTest = (via: Via, dueAt: number, now: number) => via !== "poll" || schedulerMode() === "fallback" || now - dueAt > 2 * MIN;

/**
 * The 20-second gate for untrusted runs. Family 1's polls keep the key from
 * before families, which brooker-wedding's copy still shares; a run for every
 * family (the GitHub backstop, outside callers) has its own, so an open app's
 * polls never hold it back.
 */
export const gateKey = (familyId?: number) => (familyId === undefined ? "gate:all" : familyId === FAMILY_ONE ? "tick" : `gate:${familyId}`);

/** A sweep runs this many families at once, and starts none after this long (the function has 60 s). */
export const SWEEP_CONCURRENCY = 4;
export const SWEEP_BUDGET_MS = 40_000;

/** A moment the clock missed, kept for the health line: family 1's key is the one from before families. */
const missKey = (familyId: number, momentKey: string) => (familyId === FAMILY_ONE ? `miss:${momentKey}` : `miss:${familyId}:${momentKey}`);

/**
 * Send whatever is due, for one family (`familyId`: its wakes, writes and
 * members' polls) or for every family in turn (the safety net, the cron,
 * outside callers). One run at a time from untrusted callers (a 20-second
 * gate in maple_push_sent), so a burst of polls never doubles up; a trusted
 * caller (QStash's signature, the cron secret, a write) skips the gate: the
 * per-phone claims already make every send happen once. `schedule`: re-arm
 * the wake-ups afterwards (writes and scheduled ticks, never polls).
 */
export async function runPushTick(
  now = new Date(),
  opts: { via?: Via; trusted?: boolean; schedule?: boolean; familyId?: number } = {}
): Promise<{ sent: number; failed?: number; skipped?: string }> {
  const via = opts.via ?? "ext";
  if (!vapidKeys()) return { sent: 0, skipped: "no keys" };
  if (!opts.trusted) {
    const gate = await q(
      `INSERT INTO maple_push_sent (key, sent_at) VALUES ($1, NOW())
       ON CONFLICT (key) DO UPDATE SET sent_at = NOW() WHERE maple_push_sent.sent_at < NOW() - INTERVAL '20 seconds'
       RETURNING key`,
      [gateKey(opts.familyId)]
    );
    if (!gate.length) return { sent: 0, skipped: "recent" };
  }
  const only = opts.familyId === undefined ? null : await familyScope(opts.familyId);
  if (opts.familyId !== undefined && !only) return { sent: 0 };
  const before = only ? await newestTick(familyTicks(1), [only.familyId]) : await newestTick(SWEEP_TICKS);
  await recordTick(via, now, only?.familyId);
  const floor = await floorTime();
  const run: FamilyRun = { via, floor, schedule: opts.schedule === true, before, sweep: !only };
  let sent = 0;
  let failed = 0;
  const one = async (scope: FamilyScope) => {
    try {
      const r = await tickFamily(scope, now, run);
      sent += r.sent;
      failed += r.failed;
    } catch (err) {
      // One family's trouble never stops the others.
      void captureServerException(new Error(errCode(err)), { route: "maple push family" });
    }
  };
  if (only) {
    await one(only);
  } else {
    const scopes = await familiesWithPhones();
    await sweep(scopes, now, run, one);
    // With no phone on anywhere, no family's tick re-arms the shared safety net, so turn it off here.
    if (run.schedule && !scopes.length) await ensureSafetyNet(false, now).catch(() => {});
    for (const r of await q(`SELECT DISTINCT family_id FROM maple_push_subs WHERE needs_resubscribe AND updated_at < NOW() - INTERVAL '30 days'`)) {
      await q(`DELETE FROM maple_push_subs WHERE family_id = $1 AND needs_resubscribe AND updated_at < NOW() - INTERVAL '30 days'`, [r.family_id]);
    }
  }
  // Keep the log short (the gate, tick times, the net and the floor stay). By age only: nothing older than
  // 3 days is read by any family (the cutoff is 3 hours, "Logged" looks back 12).
  await q(
    `DELETE FROM maple_push_sent WHERE key <> 'tick' AND key NOT LIKE 'tick:%' AND key NOT LIKE 'net:%' AND key NOT LIKE 'floor:%'
       AND sent_at < NOW() - INTERVAL '3 days'`
  );
  return failed ? { sent, failed } : { sent };
}

/** `before`: the newest tick before this run, the every-family runs' only for a sweep (each family adds its own). */
type FamilyRun = { via: Via; floor: number; schedule: boolean; before: number | null; sweep: boolean };

/**
 * A run for every family: only those with a phone on, family 1 first, the
 * rest from a starting point that moves each minute, so a slow or numerous
 * set of families never starves the same ones. With QStash as the clock, the
 * safety net and the cron hand every family but the Brookers its own signed
 * wake (its own invocation and time limit); otherwise, and for any wake that
 * couldn't be published, a few families run at once and none starts after
 * SWEEP_BUDGET_MS.
 */
async function sweep(scopes: FamilyScope[], now: Date, run: FamilyRun, one: (scope: FamilyScope) => Promise<void>): Promise<void> {
  const first = scopes.filter((s) => s.familyId === FAMILY_ONE);
  const rest = scopes.filter((s) => s.familyId !== FAMILY_ONE);
  const turn = rest.length ? Math.floor(now.getTime() / MIN) % rest.length : 0;
  let queue = [...rest.slice(turn), ...rest.slice(0, turn)];
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  if (schedulerMode() === "qstash" && (run.via === "net" || run.via === "daily")) {
    const left: FamilyScope[] = [];
    for (const scope of queue) {
      if (Date.now() > deadline || !(await scheduleWake(scope.familyId, now.getTime(), "wake", 0).catch(() => false))) left.push(scope);
    }
    queue = left;
  }
  queue = [...first, ...queue];
  const worker = async () => {
    for (let scope = queue.shift(); scope; scope = queue.shift()) {
      if (Date.now() > deadline) return;
      await one(scope);
    }
  };
  const workers = Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, queue.length) }, worker));
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A send that hangs past the budget is left to finish on its own; the tick answers in time either way.
  await Promise.race([workers, new Promise((resolve) => (timer = setTimeout(resolve, Math.max(0, deadline - Date.now()) + 10_000)))]);
  clearTimeout(timer);
}

/** One family's part of a tick: its tests, her medicines to its own phones, its retries and wakes. */
async function tickFamily(scope: FamilyScope, now: Date, run: FamilyRun): Promise<{ sent: number; failed: number }> {
  const t = now.getTime();
  const own = run.sweep ? await newestTick(ownTicks(1), [scope.familyId]) : null;
  const prevTick = own === null ? run.before : Math.max(own, run.before ?? own);
  await noteGap(scope.familyId, prevTick, now);
  const subs = await liveSubs(scope);
  let sent = 0;
  let failed = 0;
  const count = (o: Outcome | null) => {
    if (o === "sent") sent++;
    else if (o === "failed") failed++;
  };

  // "Send a test in 1 minute": claimed by clearing test_due_at, so it goes once.
  for (const sub of subs) {
    if (!sub.test_due_at) continue;
    const due = Date.parse(sub.test_due_at);
    if (due > t || !mayTest(run.via, due, t)) continue;
    try {
      const key = `test:${sub.id}:${Math.round(due / SEC)}`;
      const got = await q(
        `UPDATE maple_push_subs SET test_due_at = NULL, test_sent_at = $2::timestamptz, test_via = $3, test_key = $4
         WHERE id = $1 AND family_id = $5 AND test_due_at IS NOT NULL AND test_due_at <= $2::timestamptz RETURNING id`,
        [sub.id, now.toISOString(), run.via, key, scope.familyId]
      );
      if (!got.length) continue;
      const o = await deliver(sub, TEST_NOTICE, { key, ttlS: 300 });
      if (o !== "sent") await q(`UPDATE maple_push_subs SET test_via = 'failed' WHERE id = $1 AND family_id = $2`, [sub.id, scope.familyId]);
      count(o);
    } catch (err) {
      void captureServerException(new Error(errCode(err)), { route: "maple push test" });
    }
  }

  let pre: { plans: PlanMoments[] } | null = null;
  if (subs.some((s) => s.prefs.meds !== false)) {
    try {
      const { person, plans } = await collectMoments(scope, now);
      pre = { plans };
      const audience = await audienceOf(scope, person);
      const byMember = new Map<string, PushSub[]>();
      for (const sub of subs) byMember.set(sub.member, [...(byMember.get(sub.member) ?? []), sub]);
      for (const [email, phones] of byMember) {
        try {
          const v = voiceFor(audience, email, now);
          if (!v) continue;
          for (const { plan, moments } of plans) {
            if (!planActive(plan, now, scope.tz)) continue;
            for (const m of moments) {
              if (m.at > t || t - m.at >= CUTOFF_MS || m.at < run.floor) continue;
              for (const phone of phones) {
                const pr = phone.prefs;
                if (pr.meds === false || pr[m.kind] === false || pr.muted?.includes(plan.id)) continue;
                try {
                  count(await sendOnce(phone, m.key, `med:${plan.id}`, medNotice(m, plan, v, phone.prefs), { ttlS: (CUTOFF_MS - (t - m.at)) / SEC }));
                } catch (err) {
                  void captureServerException(new Error(errCode(err)), { route: "maple push send" });
                }
              }
            }
          }
        } catch (err) {
          // One member's trouble never stops the others.
          void captureServerException(new Error(errCode(err)), { route: "maple push member" });
        }
      }
      // Moments the clock missed altogether (a gap longer than the cutoff), once each, for the health line.
      if (prevTick !== null) {
        for (const { plan, moments } of plans) {
          for (const m of moments) {
            if (m.at > prevTick && t - m.at >= CUTOFF_MS && m.at >= run.floor) {
              await q(`INSERT INTO maple_push_sent (key, sent_at, ref, family_id) VALUES ($1, $2::timestamptz, $3, $4) ON CONFLICT (key) DO NOTHING`, [
                missKey(scope.familyId, m.key),
                new Date(m.at).toISOString(),
                `med:${plan.id}`,
                scope.familyId,
              ]);
            }
          }
        }
      }
    } catch (err) {
      void captureServerException(new Error(errCode(err)), { route: "maple push meds" });
    }
  }

  // "Logged" and nursing notices aren't worked out from the plans, so one the push service refused gets sent again from here.
  try {
    const again = await retryWriteNotices(scope);
    sent += again.sent;
    failed += again.failed;
  } catch (err) {
    void captureServerException(new Error(errCode(err)), { route: "maple push retry" });
  }

  if (run.schedule) {
    try {
      await scheduleWakeups(scope, now, pre);
    } catch (err) {
      void captureServerException(new Error(errCode(err)), { route: "maple push schedule" });
    }
  }
  // A send the push service refused for now: try again in a minute (the claim was given back). Timed from
  // the end of the run, so every claim it made is past claim()'s 50 seconds by then.
  if (failed) await retrySoon(scope.familyId);
  // Let go of this family's phones stopped for a month.
  await q(`DELETE FROM maple_push_subs WHERE family_id = $1 AND needs_resubscribe AND updated_at < NOW() - INTERVAL '30 days'`, [scope.familyId]);
  return { sent, failed };
}

/** Publish a retry wake for the family a minute from now (QStash only; otherwise the next tick of any kind retries). */
export async function retrySoon(familyId: number): Promise<void> {
  await scheduleWake(familyId, Date.now() + MIN, "retry", 0).catch(() => false);
}

/** The family's "Logged" and nursing sends that failed and still have tries left: send them again as the dose or feed is now. */
async function retryWriteNotices(scope: FamilyScope): Promise<{ sent: number; failed: number }> {
  const rows = await q(
    `SELECT key FROM maple_push_sent WHERE state = 'failed' AND attempts < ${MAX_ATTEMPTS} AND sent_at > NOW() - INTERVAL '1 hour'
       AND (key LIKE 's%|log:%' OR key LIKE 's%|nurse:%') AND ${familySent(1)}`,
    [scope.familyId]
  );
  const doses = new Set<number>();
  const feeds = new Set<number>();
  for (const r of rows) {
    const what = String(r.key).split("|")[1] ?? "";
    const log = /^log:(\d+)$/.exec(what);
    const nurse = /^nurse:(\d+):/.exec(what);
    if (log) doses.add(Number(log[1]));
    else if (nurse) feeds.add(Number(nurse[1]));
  }
  if (!doses.size && !feeds.size) return { sent: 0, failed: 0 };
  const { notifyDoseLogged, notifyNursing } = await import("./notify");
  const out = { sent: 0, failed: 0 };
  for (const id of doses) {
    const r = await notifyDoseLogged(scope, id, null, new Date(), { retry: false });
    out.sent += r.sent;
    out.failed += r.failed;
  }
  for (const id of feeds) {
    const r = await notifyNursing(scope, id, new Date(), { retry: false });
    out.sent += r.sent;
    out.failed += r.failed;
  }
  return out;
}

/** A Postgres code or the error's name, never its message (which can hold row data). */
export const errCode = (err: unknown) => String((err as { code?: unknown })?.code ?? (err instanceof Error ? err.name : "error"));

const lastLocal = new Map<number, number>();

/**
 * A tick that never throws, for an open app's state polls (after answering):
 * the polling member's family only, one per 20 s per family per server
 * instance before it even asks the database. Polls never publish wake-ups.
 */
export async function pushTickQuietly(familyId: number): Promise<void> {
  if (Date.now() - (lastLocal.get(familyId) ?? 0) < 20_000) return;
  lastLocal.set(familyId, Date.now());
  try {
    await runPushTick(new Date(), { via: "poll", familyId });
  } catch (err) {
    void captureServerException(new Error(errCode(err)), { route: "maple push tick" });
  }
}

// ── tests, receipts and health ────────────────────────────────────────

/**
 * "Send a test in 1 minute": due in `seconds`, sent by whichever tick runs
 * first after that (a QStash wake when it's set up), so it proves the path a
 * 3am reminder takes. Returns when it's due.
 */
export async function scheduleTest(sub: PushSub, seconds: number, now = new Date()): Promise<{ due_at: string; mode: SchedulerMode }> {
  const due = new Date(now.getTime() + Math.min(Math.max(seconds, 10), 600) * SEC);
  await q(`UPDATE maple_push_subs SET test_due_at = $2::timestamptz, test_sent_at = NULL, test_via = NULL, test_key = NULL WHERE id = $1 AND family_id = $3`, [
    sub.id,
    due.toISOString(),
    sub.family_id,
  ]);
  await scheduleWake(sub.family_id, due.getTime(), "test", 2);
  return { due_at: due.toISOString(), mode: schedulerMode() };
}

/** The worker's receipt: this phone showed the notice `key`. The token is the proof (no session), and it names one phone in one family. */
export async function recordReceipt(token: unknown, key: unknown): Promise<void> {
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) return;
  const k = typeof key === "string" ? key.slice(0, 120) : null;
  await q(`UPDATE maple_push_subs SET last_delivered_at = NOW(), last_delivered_key = $2, undelivered = 0 WHERE receipt_token = $1`, [token, k]);
}

export type PushHealth = {
  /** "qstash": exact-time wake-ups; "fallback": the GitHub backstop and open apps only. */
  mode: SchedulerMode;
  /** The safety net's minutes (0: off). */
  net_min: number;
  /** The newest tick of any kind. */
  checked_at: string | null;
  /** The newest tick that wasn't an open app's poll or a write: the server's own clock. */
  clock_at: string | null;
  /** "late" when the server's clock hasn't run when it should have. */
  clock: "on_time" | "late";
  next_wake_at: string | null;
  /** This phone: */
  last_sent_at: string | null;
  last_delivered_at: string | null;
  /** Notices sent since the last receipt (two or more: they aren't arriving). */
  undelivered: number;
  needs_resubscribe: boolean;
  /** This phone's latest test: due (pending), sent (by which tick), and when it arrived (receipt). */
  test: { due_at: string | null; sent_at: string | null; via: string | null; arrived_at: string | null } | null;
  /** Long gaps in the server's checks in the last 12 hours, and reminders they made impossible to send. */
  gaps: { from: string; to: string }[];
  missed: { at: string; plan_id: number }[];
  /** This member's phones (labels only, never endpoints). */
  phones: { device: string | null; last_delivered_at: string | null; this: boolean }[];
};

/**
 * The Notifications sheet's health line for `member` on the phone `endpoint`
 * (null: not on), in this family. The server's clock is the every-family
 * runs' plus the family's own; gaps, phones, missed reminders and the next
 * wake are the family's. Nothing on it comes from another family.
 */
export async function pushHealth(fam: Fam, member: string, endpoint: string | null, now = new Date()): Promise<PushHealth> {
  const [ticks, mine, events, wake] = await Promise.all([
    q(`SELECT key, sent_at FROM maple_push_sent WHERE ${familyTicks(1)}`, [fam.familyId]),
    q(`SELECT * FROM maple_push_subs WHERE member = $1 AND family_id = $2 ORDER BY id`, [member, fam.familyId]),
    q(
      `SELECT key, sent_at, ref FROM maple_push_sent WHERE (key LIKE 'gap:%' OR key LIKE 'miss:%') AND ${familySent(2)} AND sent_at > $1::timestamptz ORDER BY sent_at`,
      [new Date(now.getTime() - 12 * HOUR).toISOString(), fam.familyId]
    ),
    nextWake(fam.familyId, now),
  ]);
  const times = ticks.map((r) => ({ via: String(r.key).split(":").pop() as Via, at: new Date(r.sent_at as string).getTime() }));
  const newest = (xs: { at: number }[]) => (xs.length ? Math.max(...xs.map((x) => x.at)) : null);
  const checked = newest(times);
  const clockAt = newest(times.filter((x) => CLOCK_VIAS.includes(x.via)));
  const mode = schedulerMode();
  const net = netMinutes();
  const allowed = mode === "qstash" ? (net > 0 ? net + 10 : null) : 40;
  const clock = allowed === null || (clockAt !== null && now.getTime() - clockAt <= allowed * MIN) ? "on_time" : "late";
  const subs = mine.map(rowToSub);
  const sub = endpoint ? subs.find((s) => s.endpoint === endpoint) ?? null : null;
  const arrived = sub?.test_key && sub.last_delivered_key === sub.test_key ? sub.last_delivered_at : null;
  return {
    mode,
    net_min: net,
    checked_at: checked === null ? null : new Date(checked).toISOString(),
    clock_at: clockAt === null ? null : new Date(clockAt).toISOString(),
    clock,
    next_wake_at: wake,
    last_sent_at: sub?.last_sent_at ?? null,
    last_delivered_at: sub?.last_delivered_at ?? null,
    undelivered: sub?.undelivered ?? 0,
    needs_resubscribe: sub?.needs_resubscribe ?? false,
    test: sub && (sub.test_due_at || sub.test_sent_at) ? { due_at: sub.test_due_at, sent_at: sub.test_sent_at, via: sub.test_via, arrived_at: arrived } : null,
    gaps: events
      .filter((r) => String(r.key).startsWith("gap:"))
      .map((r) => ({ from: String(r.key).replace(/^gap:(?:\d+:(?=\d{4}-))?/, ""), to: new Date(r.sent_at as string).toISOString() })),
    missed: events
      .filter((r) => String(r.key).startsWith("miss:") && typeof r.ref === "string")
      .map((r) => ({ at: new Date(r.sent_at as string).toISOString(), plan_id: Number(String(r.ref).slice(4)) })),
    phones: subs.map((s) => ({ device: s.device, last_delivered_at: s.last_delivered_at, this: s.endpoint === endpoint })),
  };
}

/**
 * What each of her current medicines can notify about, so the sheet never
 * shows a switch that can't fire: "ok" (OK again), "at" (set times), or
 * null with why ("daily": N times a day has no times; "no_gap": as needed
 * with no gap or limit). Null for anyone in the family who can't see her
 * medicines, and for a family without her page.
 */
export async function reminderFacts(scope: FamilyScope, member: string): Promise<{ plan_id: number; kind: "ok" | "at" | null; why?: "daily" | "no_gap" }[] | null> {
  const audience = await audienceOf(scope);
  const now = new Date();
  if (!audience.person || !voiceFor(audience, member, now)) return null;
  return (await familyPlans(scope.familyId, audience.person.member)).filter((p) => planActive(p, now, scope.tz)).map((p) => ({ plan_id: p.id, ...remindKind(p) }));
}
