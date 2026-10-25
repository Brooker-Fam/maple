import { createECDH, hkdfSync } from "node:crypto";
import webpush from "web-push";
import { query } from "@/lib/db";
import { captureServerException } from "@/lib/posthog-server";
import { listMembers } from "./auth";
import { careTime, planActive, planStatus } from "./care";
import { careSession, getCarePerson, listCareEntries, planDoses, viewerFor, visiblePlans, type CareSession } from "./care-store";
import { memberName } from "./insights";
import { getBaby } from "./store";
import { localParts, zonedTimeToUtc } from "./time";
import type { CarePlan, DoseEntry, Member } from "./types";

/**
 * Pill reminders by Web Push, for her medicines (the maple_care_* plans).
 *
 * Phones subscribe from her screen ("Reminders on this phone"); on iPhone
 * that works from the Home Screen app only (iOS 16.4+). Nothing is queued:
 * every tick works out what's due from the plans and doses as they are now,
 * so a dose deleted or moved never leaves a stale reminder behind, and each
 * reminder is sent once (maple_push_sent) however many ticks see it.
 *
 * What's sent, to every phone signed in as a family member (careAccess;
 * viewers get nothing):
 *   - "OK again": an as-needed or every-few-hours medicine's next-OK time
 *     (her gap and 24-hour limit, from planStatus), once it arrives;
 *   - set times: an "At set times" medicine at each of its times, unless a
 *     dose was logged in the hour before;
 *   - optional, per phone: someone else logged one of her doses.
 * Never a dose, never "take now": the times are her own plan's.
 *
 * Ticks: /api/maple/push/tick (a scheduled GitHub Action every 5 minutes, or
 * any cron) and, best effort, every state poll from an open app.
 */

export type PushPrefs = {
  /** Her medicines' OK-again and set-time reminders (default on). */
  meds?: boolean;
  /** Someone else logged one of her doses (default off). */
  logged?: boolean;
  /** "A medicine reminder" on the lock screen instead of the medicine's name. */
  hide_names?: boolean;
  /** Plans this phone doesn't want reminders for. */
  muted?: number[];
};

export type PushSub = { id: number; member: string; endpoint: string; p256dh: string; auth: string; prefs: PushPrefs };

type Row = Record<string, unknown>;
const MIN = 60_000;
/** A reminder more than this late (the tick was down) isn't sent: it would only confuse. */
const STALE_MS = 45 * MIN;
const SUBJECT = "https://brooker.family/maple";

async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const rows = await query(sql, params);
  if (rows === null) throw new Error("No database");
  return rows as Row[];
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let keys: { publicKey: string; privateKey: string } | null | undefined;

/**
 * The VAPID keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY when set, else a P-256
 * key derived from MCP_SECRET (or GOOGLE_CLIENT_SECRET), so there's nothing
 * new to configure. Rotating that secret means each phone turns reminders on
 * again (its subscription is tied to the old key).
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

const rowToSub = (r: Row): PushSub => ({
  id: Number(r.id),
  member: String(r.member),
  endpoint: String(r.endpoint),
  p256dh: String(r.p256dh),
  auth: String(r.auth),
  prefs: (r.prefs ?? {}) as PushPrefs,
});

export function cleanPrefs(v: unknown): PushPrefs {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const out: PushPrefs = {};
  if (typeof o.meds === "boolean") out.meds = o.meds;
  if (typeof o.logged === "boolean") out.logged = o.logged;
  if (typeof o.hide_names === "boolean") out.hide_names = o.hide_names;
  if (Array.isArray(o.muted)) out.muted = o.muted.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 100);
  return out;
}

/** Save (or move to this member) a phone's subscription. */
export async function saveSub(member: string, sub: { endpoint: string; p256dh: string; auth: string }, prefs: PushPrefs, device: string | null): Promise<PushSub> {
  const rows = await q(
    `INSERT INTO maple_push_subs (member, endpoint, p256dh, auth, prefs, device)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (endpoint) DO UPDATE SET member = $1, p256dh = $3, auth = $4, prefs = $5::jsonb, device = $6, failures = 0, updated_at = NOW()
     RETURNING *`,
    [member, sub.endpoint, sub.p256dh, sub.auth, JSON.stringify(prefs), device]
  );
  return rowToSub(rows[0]);
}

/** This member's subscription for an endpoint (another member's phone reads as none). */
export async function subFor(member: string, endpoint: string): Promise<PushSub | null> {
  const rows = await q(`SELECT * FROM maple_push_subs WHERE endpoint = $1 AND member = $2`, [endpoint, member]);
  return rows.length ? rowToSub(rows[0]) : null;
}

export async function patchPrefs(member: string, endpoint: string, prefs: PushPrefs): Promise<PushSub | null> {
  const rows = await q(`UPDATE maple_push_subs SET prefs = $3::jsonb, updated_at = NOW() WHERE endpoint = $1 AND member = $2 RETURNING *`, [
    endpoint,
    member,
    JSON.stringify(prefs),
  ]);
  return rows.length ? rowToSub(rows[0]) : null;
}

export async function deleteSub(member: string, endpoint: string): Promise<void> {
  await q(`DELETE FROM maple_push_subs WHERE endpoint = $1 AND member = $2`, [endpoint, member]);
}

export type PushMessage = { title: string; body: string; tag: string; url: string };

/** Send one message to one phone. A phone that's gone (404/410) is forgotten; others count failures. */
export async function sendPush(sub: PushSub, msg: PushMessage): Promise<boolean> {
  const k = vapidKeys();
  if (!k) return false;
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(msg), {
      vapidDetails: { subject: SUBJECT, publicKey: k.publicKey, privateKey: k.privateKey },
      TTL: 60 * 60,
      urgency: "high",
    });
    await q(`UPDATE maple_push_subs SET failures = 0, last_sent_at = NOW() WHERE id = $1`, [sub.id]);
    return true;
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) await q(`DELETE FROM maple_push_subs WHERE id = $1`, [sub.id]);
    else {
      await q(`UPDATE maple_push_subs SET failures = failures + 1 WHERE id = $1`, [sub.id]);
      await q(`DELETE FROM maple_push_subs WHERE id = $1 AND failures >= 10`, [sub.id]);
      // A code only: the push service's message can carry the phone's endpoint.
      void captureServerException(new Error(`push send failed${status ? ` ${status}` : ""}`), { route: "maple push" });
    }
    return false;
  }
}

/** Claim a reminder key once; false when another tick already sent it. */
async function claim(key: string): Promise<boolean> {
  const rows = await q(`INSERT INTO maple_push_sent (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key`, [key]);
  return rows.length > 0;
}

type Due = { key: string; plan: CarePlan; kind: "ok" | "at" | "logged"; at: number; dose?: DoseEntry; by?: string | null };

/** "HH:MM" set times of a plan as instants, yesterday's and today's (a time just before midnight still counts after it). */
function setTimes(plan: CarePlan, now: Date, tz: string): number[] {
  if (plan.schedule.type !== "times") return [];
  const out: number[] = [];
  for (const back of [1, 0]) {
    const p = localParts(now.getTime() - back * 24 * 60 * MIN, tz);
    for (const hm of plan.schedule.times) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
      if (!m) continue;
      out.push(zonedTimeToUtc(p.year, p.month, p.day, Number(m[1]), Number(m[2]), tz).getTime());
    }
  }
  return out;
}

/** What's due for one member right now, from the plans they can see. */
async function dueFor(s: CareSession, prefs: PushPrefs[], now: Date): Promise<Due[]> {
  const t = now.getTime();
  const wantMeds = prefs.some((p) => p.meds !== false);
  const wantLogged = prefs.some((p) => p.logged === true);
  const out: Due[] = [];
  const plans = (await visiblePlans(s)).filter((p) => planActive(p, now, s.tz));
  if (wantMeds) {
    for (const plan of plans) {
      const doses = await planDoses(plan.id, new Date(t - 26 * 60 * MIN));
      if (plan.schedule.type === "as_needed" || plan.schedule.type === "every") {
        const st = planStatus(plan, doses, now, s.tz);
        const ok = st.nextOkAt ? Date.parse(st.nextOkAt) : null;
        if (st.last && ok !== null && ok <= t && t - ok < STALE_MS) out.push({ key: `ok:${plan.id}:${st.nextOkAt}`, plan, kind: "ok", at: ok, dose: st.last });
      }
      for (const at of setTimes(plan, now, s.tz)) {
        if (at > t || t - at >= STALE_MS) continue;
        // Already taken (or marked skipped) for this time: nothing to remind.
        if (doses.some((d) => Math.abs(Date.parse(d.at) - at) <= 60 * MIN)) continue;
        out.push({ key: `at:${plan.id}:${new Date(at).toISOString()}`, plan, kind: "at", at });
      }
    }
  }
  if (wantLogged) {
    const visible = new Set(plans.map((p) => p.id));
    const recent = (await listCareEntries(s, { from: new Date(t - 6 * 60 * MIN), kinds: ["dose"] })) as DoseEntry[];
    for (const d of recent) {
      if (d.data.skipped || !d.med_id || !visible.has(d.med_id) || d.created_by === s.viewer.id) continue;
      if (t - Date.parse(d.created_at) > 10 * MIN) continue;
      out.push({ key: `log:${d.id}`, plan: plans.find((p) => p.id === d.med_id)!, kind: "logged", at: Date.parse(d.at), dose: d, by: d.created_by });
    }
  }
  return out;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The words on the lock screen (her own phone, or "For Brittany: …"; no name at all when the phone hides names). */
function message(d: Due, s: CareSession, prefs: PushPrefs, members: Member[], now: Date): PushMessage {
  const self = s.access.self;
  const her = s.name;
  const url = "/maple?care=1";
  const tag = d.key.slice(0, 60);
  const when = (at: number) => careTime(at, now, s.tz);
  if (prefs.hide_names) {
    return { title: "Maple's Log", body: self ? "A medicine reminder" : `A medicine reminder for ${her}`, tag, url };
  }
  const name = d.plan.name;
  const lead = self ? name : `For ${her}: ${lower(name)}`;
  if (d.kind === "ok") {
    const by = d.dose?.created_by && d.dose.created_by !== s.viewer.id ? ` (logged by ${memberName(d.dose.created_by, members)})` : "";
    return { title: `${lead} is OK again`, body: `Last taken ${when(Date.parse(d.dose!.at))}${by}.`, tag, url };
  }
  if (d.kind === "at") {
    return { title: `${lead} · ${when(d.at)}`, body: self ? "One of your set times. Tap to log it once you've taken it." : `One of ${her}'s set times.`, tag, url };
  }
  const who = d.by === s.person?.member ? her : memberName(d.by, members);
  return { title: who === her ? `${her} took ${lower(name)}` : `${who} logged ${her}'s ${lower(name)}`, body: `At ${when(d.at)}.`, tag, url };
}

/**
 * Send every reminder that's due. One run at a time (a 20-second gate in
 * maple_push_sent), so a burst of polls and the cron never double up.
 */
export async function runPushTick(now = new Date()): Promise<{ sent: number; skipped?: string }> {
  if (!vapidKeys()) return { sent: 0, skipped: "no keys" };
  const gate = await q(
    `INSERT INTO maple_push_sent (key, sent_at) VALUES ('tick', NOW())
     ON CONFLICT (key) DO UPDATE SET sent_at = NOW() WHERE maple_push_sent.sent_at < NOW() - INTERVAL '20 seconds'
     RETURNING key`
  );
  if (!gate.length) return { sent: 0, skipped: "recent" };
  const subs = (await q(`SELECT * FROM maple_push_subs`)).map(rowToSub);
  if (!subs.length) return { sent: 0 };
  const person = await getCarePerson();
  const [baby, members] = await Promise.all([getBaby(), listMembers()]);
  let sent = 0;
  const byMember = new Map<string, PushSub[]>();
  for (const sub of subs) byMember.set(sub.member, [...(byMember.get(sub.member) ?? []), sub]);
  for (const [email, phones] of byMember) {
    const member = members.find((m) => m.email === email);
    if (!member) continue;
    const s = await careSession(viewerFor(member, baby, members), { members, baby, person });
    if (!s.access.read) continue;
    for (const d of await dueFor(s, phones.map((p) => p.prefs), now)) {
      // Once per member per reminder; each of their phones that wants it gets it.
      if (!(await claim(`${email}|${d.key}`))) continue;
      for (const phone of phones) {
        const p = phone.prefs;
        if (d.kind === "logged" ? p.logged !== true : p.meds === false || p.muted?.includes(d.plan.id)) continue;
        if (await sendPush(phone, message(d, s, p, members, now))) sent++;
      }
    }
  }
  // Keep the sent log short.
  await q(`DELETE FROM maple_push_sent WHERE key <> 'tick' AND sent_at < NOW() - INTERVAL '3 days'`);
  return { sent };
}

/** A Postgres code or the error's name, never its message (which can hold row data). */
export const errCode = (err: unknown) => String((err as { code?: unknown })?.code ?? (err instanceof Error ? err.name : "error"));

let lastLocal = 0;

/** A tick that never throws (the state route calls it after answering); one per 20 s per server instance before it even asks the database. */
export async function pushTickQuietly(): Promise<void> {
  if (Date.now() - lastLocal < 20_000) return;
  lastLocal = Date.now();
  try {
    await runPushTick();
  } catch (err) {
    void captureServerException(new Error(errCode(err)), { route: "maple push tick" });
  }
}
