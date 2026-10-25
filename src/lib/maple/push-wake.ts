import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { query } from "@/lib/db";
import { captureServerException } from "@/lib/posthog-server";
import { planStatus } from "./care";
import { getCarePerson, listCarePlans, rowToCareEntry } from "./care-store";
import { addDays, dayKey, parseDayKey, zonedTimeToUtc } from "./time";
import type { CarePerson, CarePlan, DoseEntry } from "./types";

/**
 * The clock for notifications (src/lib/maple/push.ts sends them).
 *
 * When: dueMoments() is the only place that decides when one of her
 * medicines' notices can go out ("OK again" at her gap and 24-hour limit,
 * each unfilled set time). The tick and the scheduler both read it, so they
 * never disagree.
 *
 * Waking up on time: with Upstash QStash configured (QSTASH_TOKEN, and its
 * signing keys), every write and every scheduled tick publishes a delayed
 * message for the next few moments (Upstash-Not-Before), so the tick runs
 * within seconds of each one. A moment already published is recorded as a
 * `wake:<epoch-second>` row and never published twice, so an open app's
 * polls never publish anything. Nothing is cancelled: a wake for a moment
 * that moved just finds nothing to send. A QStash schedule (the safety net,
 * every MAPLE_TICK_NET_MIN minutes, default 30) runs the tick too, while any
 * phone has notifications on. QStash requests are signed (Upstash-Signature,
 * HS256 with QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY).
 *
 * Without QStash env vars nothing here does anything: the GitHub workflow
 * and an open app's polls drive the tick, as before.
 */

type Row = Record<string, unknown>;
const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 24 * 60 * MIN;
/** Wake a little after the moment, so it's surely due when the tick looks. */
const WAKE_SLACK_S = 10;
/** At most this many wakes are published per call (writes are bursty). */
const WAKES_PER_CALL = 3;
/** QStash's longest delay on the free plan. */
const MAX_AHEAD_MS = 7 * DAY;
/** Doses this far back are enough for every gap, limit and slot. */
export const DOSE_LOOKBACK_MS = 3 * DAY;

async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const rows = await query(sql, params);
  if (rows === null) throw new Error("No database");
  return rows as Row[];
}

// ── when ──────────────────────────────────────────────────────────────

/**
 * A moment one of her medicines' notices can go out. `ok`: the gap and the
 * 24-hour limit have both cleared since `dose` (key ok:<plan>:<dose>, so
 * correcting the dose's time doesn't send it again). `at`: a set time no
 * dose or skip has filled (key at:<plan>:<slot ISO>).
 */
export type DueMoment = { key: string; kind: "ok" | "at"; at: number; planId: number; dose?: DoseEntry };

/** Noon of a local day: always exists, whatever daylight saving does that night. */
function noonOf(key: string, tz: string): Date {
  const { year, month, day } = parseDayKey(key);
  return zonedTimeToUtc(year, month, day, 12, 0, tz);
}

/**
 * Every moment a plan's notices are for, past and future (callers pick by
 * time): its next OK-again, and the unfilled set times of yesterday, today
 * and tomorrow (the slots planStatus fills, so a dose an hour early counts
 * for its slot exactly as her card shows it). "N times a day" and "as
 * needed" with no gap and no limit have none: there's no time to remind at.
 * A set time before the plan was added, outside its course, or on a stopped
 * plan has none either.
 */
export function dueMoments(plan: CarePlan, doses: DoseEntry[], now: Date, tz: string): DueMoment[] {
  if (plan.stopped_at) return [];
  const s = plan.schedule;
  const out: DueMoment[] = [];
  if (s.type === "as_needed" || s.type === "every") {
    const st = planStatus(plan, doses, now, tz);
    if (st.last && st.nextOkAt) {
      const at = Date.parse(st.nextOkAt);
      if (!plan.course_end || dayKey(at, tz) <= plan.course_end) out.push({ key: `ok:${plan.id}:${st.last.id}`, kind: "ok", at, planId: plan.id, dose: st.last });
    }
    return out;
  }
  if (s.type !== "times") return out;
  const today = dayKey(now, tz);
  const startKey = plan.course_start ?? dayKey(new Date(plan.created_at), tz);
  const added = Date.parse(plan.created_at);
  for (const off of [-1, 0, 1]) {
    const key = addDays(today, off);
    if (key < startKey || (plan.course_end && key > plan.course_end)) continue;
    for (const slot of planStatus(plan, doses, noonOf(key, tz), tz).slots ?? []) {
      const at = Date.parse(slot.at);
      if (slot.filled_by !== null || at < added) continue;
      out.push({ key: `at:${plan.id}:${slot.at}`, kind: "at", at, planId: plan.id });
    }
  }
  return out;
}

/** What a plan can remind about, for the Notifications sheet (so it never shows a switch that can't fire). */
export function remindKind(plan: CarePlan): { kind: "ok" | "at" | null; why?: "daily" | "no_gap" } {
  const s = plan.schedule;
  if (s.type === "times") return { kind: "at" };
  if (s.type === "daily") return { kind: null, why: "daily" };
  if (s.type === "every") return { kind: "ok" };
  return s.min_gap_min || plan.max_24h != null ? { kind: "ok" } : { kind: null, why: "no_gap" };
}

export type PlanMoments = { plan: CarePlan; doses: DoseEntry[]; moments: DueMoment[] };

/**
 * Her active plans (private ones included: a wake only starts a tick, and the
 * tick still applies what each phone may see), their doses of the last three
 * days in one query, and each plan's moments.
 */
export async function collectMoments(now: Date, tz: string): Promise<{ person: CarePerson; plans: PlanMoments[] }> {
  const person = await getCarePerson();
  const plans = (await listCarePlans(person.member)).filter((p) => !p.stopped_at);
  if (!plans.length) return { person, plans: [] };
  const rows = await q(
    `SELECT * FROM maple_care_entries WHERE med_id = ANY($1::bigint[]) AND kind = 'dose' AND deleted_at IS NULL AND at >= $2::timestamptz ORDER BY at`,
    [plans.map((p) => p.id), new Date(now.getTime() - DOSE_LOOKBACK_MS).toISOString()]
  );
  const doses = rows.map(rowToCareEntry) as DoseEntry[];
  return {
    person,
    plans: plans.map((plan) => {
      const mine = doses.filter((d) => d.med_id === plan.id);
      return { plan, doses: mine, moments: dueMoments(plan, mine, now, tz) };
    }),
  };
}

// ── QStash ────────────────────────────────────────────────────────────

export type SchedulerMode = "qstash" | "fallback";

/** "qstash" when a token is set; otherwise the GitHub workflow and open apps are the clock. */
export const schedulerMode = (): SchedulerMode => (process.env.QSTASH_TOKEN ? "qstash" : "fallback");

/** The safety net's interval in minutes (MAPLE_TICK_NET_MIN, default 30; 0 turns it off). */
export function netMinutes(): number {
  const raw = process.env.MAPLE_TICK_NET_MIN;
  if (raw === undefined || raw.trim() === "") return 30;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 60 ? n : 30;
}

const qstashBase = () => (process.env.QSTASH_URL || "https://qstash.upstash.io").replace(/\/+$/, "");

/** The production tick URL QStash calls (a preview deploy's wakes still go to production, where QStash is set up). */
export function tickUrl(): string {
  const base =
    process.env.MAPLE_PUBLIC_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "https://brooker.family");
  return `${base.replace(/\/+$/, "")}/api/maple/push/tick`;
}

/** The ways the tick is run; QStash passes it as X-Maple-Via (Upstash-Forward-X-Maple-Via). */
export type Via = "wake" | "net" | "daily" | "gh" | "ext" | "poll" | "write" | "retry" | "test";

async function qstash(path: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<Response> {
  return fetch(`${qstashBase()}${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${process.env.QSTASH_TOKEN}`, ...(init.headers ?? {}) },
    body: init.body,
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
}

/**
 * Publish one wake for `atMs` (plus a few seconds), once: the `wake:<second>`
 * row is claimed first and given back if the publish fails, so a later
 * write or tick tries again. False when there's no QStash, it was already
 * published, or the publish failed.
 */
export async function scheduleWake(atMs: number, via: Via, slackS = WAKE_SLACK_S): Promise<boolean> {
  if (schedulerMode() !== "qstash") return false;
  const sec = Math.ceil(atMs / SEC) + slackS;
  const key = `wake:${sec}`;
  const claimed = await q(
    `INSERT INTO maple_push_sent (key, sent_at, state) VALUES ($1, to_timestamp($2::double precision), 'sent') ON CONFLICT (key) DO NOTHING RETURNING key`,
    [key, sec]
  );
  if (!claimed.length) return false;
  let ok = false;
  try {
    const res = await qstash(`/v2/publish/${tickUrl()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Upstash-Not-Before": String(sec),
        "Upstash-Retries": "3",
        "Upstash-Deduplication-Id": `maple-wake-${sec}`,
        "Upstash-Forward-X-Maple-Via": via,
      },
      body: JSON.stringify({ via, at: sec }),
    });
    ok = res.ok;
    if (!ok) void captureServerException(new Error(`qstash publish ${res.status}`), { route: "maple push wake" });
  } catch (err) {
    void captureServerException(new Error(`qstash publish ${err instanceof Error ? err.name : "error"}`), { route: "maple push wake" });
  }
  if (!ok) await q(`DELETE FROM maple_push_sent WHERE key = $1`, [key]);
  return ok;
}

/**
 * Keep the QStash safety-net schedule (id maple-tick-net) as it should be:
 * on every MAPLE_TICK_NET_MIN minutes while `wanted` (some phone has
 * notifications on), else off. Re-sent once a day (that heals a schedule
 * someone deleted); otherwise it costs one small read.
 */
export async function ensureSafetyNet(wanted: boolean, now = new Date()): Promise<void> {
  if (schedulerMode() !== "qstash") return;
  const min = netMinutes();
  // On the GitHub backstop's minutes (:04 and :34), so the two wake Neon together rather than apart.
  const want = wanted && min > 0 ? (min >= 60 ? "4 * * * *" : `4-59/${min} * * * *`) : "off";
  const rows = await q(`SELECT key, sent_at FROM maple_push_sent WHERE key LIKE 'net:%' ORDER BY sent_at DESC LIMIT 1`);
  const cur = rows[0];
  if (cur && String(cur.key) === `net:${want}` && now.getTime() - new Date(cur.sent_at as string).getTime() < DAY) return;
  let ok = false;
  try {
    if (want === "off") {
      const res = await qstash(`/v2/schedules/maple-tick-net`, { method: "DELETE" });
      ok = res.ok || res.status === 404;
    } else {
      const res = await qstash(`/v2/schedules/${tickUrl()}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Upstash-Cron": want,
          "Upstash-Schedule-Id": "maple-tick-net",
          "Upstash-Retries": "2",
          "Upstash-Forward-X-Maple-Via": "net",
        },
        body: JSON.stringify({ via: "net" }),
      });
      ok = res.ok;
    }
    if (!ok) void captureServerException(new Error("qstash schedule failed"), { route: "maple push net" });
  } catch (err) {
    void captureServerException(new Error(`qstash schedule ${err instanceof Error ? err.name : "error"}`), { route: "maple push net" });
  }
  if (!ok) return;
  await q(`DELETE FROM maple_push_sent WHERE key LIKE 'net:%'`);
  await q(`INSERT INTO maple_push_sent (key, sent_at) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET sent_at = $2`, [`net:${want}`, now.toISOString()]);
}

/**
 * Publish wakes for the next few moments not already published: her
 * medicines' moments (only while some phone wants medicine notices) and
 * pending tests ("Send a test in 1 minute"), within QStash's 7 days. Also
 * keeps the safety net in step. Called from writes and from scheduled ticks,
 * never from an open app's polls. `pre`: moments the caller already worked
 * out (the tick shares its own).
 */
export async function scheduleWakeups(now = new Date(), pre?: { plans: PlanMoments[] } | null, tz?: string): Promise<{ mode: SchedulerMode; published: number }> {
  if (schedulerMode() !== "qstash") return { mode: "fallback", published: 0 };
  const subs = await q(`SELECT prefs, test_due_at FROM maple_push_subs WHERE NOT needs_resubscribe`);
  await ensureSafetyNet(subs.length > 0, now);
  if (!subs.length) return { mode: "qstash", published: 0 };
  const t = now.getTime();
  const times: number[] = [];
  const wantMeds = subs.some((s) => (s.prefs as { meds?: boolean } | null)?.meds !== false);
  if (wantMeds) {
    let plans = pre?.plans;
    if (!plans) {
      const zone = tz ?? (await babyTz());
      plans = (await collectMoments(now, zone)).plans;
    }
    for (const p of plans) for (const m of p.moments) if (m.at > t) times.push(m.at);
  }
  for (const s of subs) if (s.test_due_at) times.push(Math.max(t, new Date(s.test_due_at as string).getTime()));
  const next = [...new Set(times.filter((x) => x - t <= MAX_AHEAD_MS))].sort((a, b) => a - b).slice(0, WAKES_PER_CALL);
  let published = 0;
  for (const at of next) if (await scheduleWake(at, "wake")) published++;
  return { mode: "qstash", published };
}

async function babyTz(): Promise<string> {
  const rows = await q(`SELECT timezone FROM maple_babies ORDER BY id LIMIT 1`);
  return String(rows[0]?.timezone || "America/New_York");
}

/** The next wake already published (for the health line), if any. */
export async function nextWake(now = new Date()): Promise<string | null> {
  const rows = await q(`SELECT MIN(sent_at) AS at FROM maple_push_sent WHERE key LIKE 'wake:%' AND sent_at > $1`, [now.toISOString()]);
  return rows[0]?.at ? new Date(rows[0].at as string).toISOString() : null;
}

// ── the signature on QStash's requests ────────────────────────────────

const unpad = (s: string) => s.replace(/=+$/, "");
const b64urlOf = (s: string) => unpad(s).replace(/\+/g, "-").replace(/\//g, "_");

/**
 * Is this request really from QStash? The Upstash-Signature header is a JWT
 * (HS256) signed with the current or the next signing key; its claims say
 * it's from Upstash, for our tick path, still valid, and for exactly this
 * body (a SHA-256 of it). Without signing keys nothing verifies.
 */
export function verifyQstash(signature: string | null, body: string, now = Date.now()): boolean {
  if (!signature) return false;
  const keys = [process.env.QSTASH_CURRENT_SIGNING_KEY, process.env.QSTASH_NEXT_SIGNING_KEY].filter((k): k is string => !!k);
  if (!keys.length) return false;
  const parts = signature.split(".");
  if (parts.length !== 3) return false;
  const [h, p, sig] = parts;
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return false;
  }
  const signed = keys.some((k) => {
    const mac = createHmac("sha256", k).update(`${h}.${p}`).digest();
    return mac.length === given.length && timingSafeEqual(mac, given);
  });
  if (!signed) return false;
  let header: { alg?: unknown };
  let claims: { iss?: unknown; sub?: unknown; exp?: unknown; nbf?: unknown; body?: unknown };
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (header.alg !== "HS256" || claims.iss !== "Upstash") return false;
  const nowS = Math.floor(now / SEC);
  if (typeof claims.exp === "number" && claims.exp < nowS - 30) return false;
  if (typeof claims.nbf === "number" && claims.nbf > nowS + 30) return false;
  try {
    if (typeof claims.sub !== "string" || new URL(claims.sub).pathname !== "/api/maple/push/tick") return false;
  } catch {
    return false;
  }
  const hash = createHash("sha256").update(body).digest("base64url");
  return typeof claims.body === "string" && b64urlOf(claims.body) === unpad(hash);
}
