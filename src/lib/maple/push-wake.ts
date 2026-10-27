import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { query } from "@/lib/db";
import { captureServerException } from "@/lib/posthog-server";
import { planStatus } from "./care";
import { rowToCareEntry, rowToPlan } from "./care-store";
import { FAMILY_ONE, type FamilyScope } from "./family";
import { addDays, dayKey, parseDayKey, zonedTimeToUtc } from "./time";
import type { CarePerson, CarePlan, CareSettings, DoseEntry, Member, Role } from "./types";
import { MAPLE_ORIGIN } from "./origin";

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
 *
 * Families: everything a tick reads (phones, members, her page, plans,
 * doses) is one family's, and each family's wakes are its own
 * (`wake:<fam>:<second>`, published with the family in the signed body), so
 * two families' moments in the same second both get one. Family 1 keeps the
 * keys, ids and body it had before families, which brooker-wedding's copy
 * still shares. Only the safety net is global: it walks every family.
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

/**
 * A maple_push_sent row of this family's. Rows written before families (and
 * by brooker-wedding's copy) have no family_id and are family 1's; the
 * global rows (ticks, the net, the floor, gaps) are never read through this.
 */
export const familySent = (n: number) => `(family_id = $${n} OR (family_id IS NULL AND $${n}::bigint = ${FAMILY_ONE}))`;

// ── who's in the family ──────────────────────────────────────────────

export async function familyMembers(familyId: number): Promise<Member[]> {
  const rows = await q(`SELECT email, role, display_name, emoji, color FROM maple_members WHERE family_id = $1 ORDER BY added_at, email`, [familyId]);
  return rows.map((r) => ({
    email: String(r.email),
    role: (r.role === "owner" || r.role === "viewer" ? r.role : "member") as Role,
    display_name: r.display_name == null ? null : String(r.display_name),
    emoji: r.emoji == null ? null : String(r.emoji),
    color: r.color == null ? null : String(r.color),
  }));
}

/** The family's care page, if it has one (read only: a notification never makes one). */
export async function familyCarePerson(familyId: number): Promise<CarePerson | null> {
  const rows = await q(`SELECT * FROM maple_care_people WHERE family_id = $1 ORDER BY created_at LIMIT 1`, [familyId]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    member: String(r.member),
    shared_with: Array.isArray(r.shared_with) ? (r.shared_with as unknown[]).map(String) : [],
    settings: (r.settings ?? {}) as CareSettings,
    created_by: r.created_by == null ? null : String(r.created_by),
    created_at: new Date(r.created_at as string).toISOString(),
    updated_at: new Date(r.updated_at as string).toISOString(),
  };
}

/** The member the admin login acts as (the active baby's settings.admin_as), for her page's access. */
export async function familyAdminAs(scope: FamilyScope): Promise<string | null> {
  if (scope.babyId == null) return null;
  const rows = await q(`SELECT settings->>'admin_as' AS admin_as FROM maple_babies WHERE id = $1 AND family_id = $2`, [scope.babyId, scope.familyId]);
  return rows[0]?.admin_as == null ? null : String(rows[0].admin_as);
}

const PLAN_COLS = `m.*, to_char(m.course_start, 'YYYY-MM-DD') AS course_start_text, to_char(m.course_end, 'YYYY-MM-DD') AS course_end_text`;

export async function familyPlans(familyId: number, person: string): Promise<CarePlan[]> {
  const rows = await q(`SELECT ${PLAN_COLS} FROM maple_care_meds m WHERE m.family_id = $1 AND m.person = $2 AND m.deleted_at IS NULL ORDER BY m.sort, m.id`, [familyId, person]);
  return rows.map(rowToPlan);
}

/** One of the family's plans by id, deleted ones included ("Logged" names it either way). */
export async function familyPlan(familyId: number, id: number): Promise<CarePlan | null> {
  const rows = await q(`SELECT ${PLAN_COLS} FROM maple_care_meds m WHERE m.id = $1 AND m.family_id = $2`, [id, familyId]);
  return rows.length ? rowToPlan(rows[0]) : null;
}

/** The family's doses of these plans since `since`. */
export async function familyDoses(familyId: number, planIds: number[], since: Date): Promise<DoseEntry[]> {
  const rows = await q(
    `SELECT * FROM maple_care_entries WHERE family_id = $1 AND med_id = ANY($2::bigint[]) AND kind = 'dose' AND deleted_at IS NULL AND at >= $3::timestamptz ORDER BY at`,
    [familyId, planIds, since.toISOString()]
  );
  return rows.map(rowToCareEntry) as DoseEntry[];
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
 * One family's active plans (private ones included: a wake only starts a
 * tick, and the tick still applies what each phone may see), their doses of
 * the last three days in one query, and each plan's moments, in the
 * family's timezone. No care page: nothing.
 */
export async function collectMoments(scope: FamilyScope, now: Date): Promise<{ person: CarePerson | null; plans: PlanMoments[] }> {
  const person = await familyCarePerson(scope.familyId);
  if (!person) return { person, plans: [] };
  const plans = (await familyPlans(scope.familyId, person.member)).filter((p) => !p.stopped_at);
  if (!plans.length) return { person, plans: [] };
  const doses = await familyDoses(
    scope.familyId,
    plans.map((p) => p.id),
    new Date(now.getTime() - DOSE_LOOKBACK_MS)
  );
  return {
    person,
    plans: plans.map((plan) => {
      const mine = doses.filter((d) => d.med_id === plan.id);
      return { plan, doses: mine, moments: dueMoments(plan, mine, now, scope.tz) };
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
  return `${MAPLE_ORIGIN}/api/maple/push/tick`;
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

/** A wake's claim key, QStash deduplication id and signed body: family 1's are the ones from before families. */
export function wakeIds(familyId: number, sec: number, via: Via): { key: string; dedup: string; body: string } {
  if (familyId === FAMILY_ONE) return { key: `wake:${sec}`, dedup: `maple-wake-${sec}`, body: JSON.stringify({ via, at: sec }) };
  return { key: `wake:${familyId}:${sec}`, dedup: `maple-wake-${familyId}-${sec}`, body: JSON.stringify({ via, at: sec, family: familyId }) };
}

/**
 * Publish one wake for `atMs` (plus a few seconds) for one family, once: its
 * `wake:` row is claimed first and given back if the publish fails, so a
 * later write or tick tries again. False when there's no QStash, it was
 * already published, or the publish failed.
 */
export async function scheduleWake(familyId: number, atMs: number, via: Via, slackS = WAKE_SLACK_S): Promise<boolean> {
  if (schedulerMode() !== "qstash") return false;
  const sec = Math.ceil(atMs / SEC) + slackS;
  const { key, dedup, body } = wakeIds(familyId, sec, via);
  const claimed = await q(
    `INSERT INTO maple_push_sent (key, sent_at, state, family_id) VALUES ($1, to_timestamp($2::double precision), 'sent', $3) ON CONFLICT (key) DO NOTHING RETURNING key`,
    [key, sec, familyId]
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
        "Upstash-Deduplication-Id": dedup,
        "Upstash-Forward-X-Maple-Via": via,
      },
      body,
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
 * Whether any phone in any family has notifications on: the safety net is
 * shared, so it runs while anyone's does. Reads no family's data.
 */
export async function anyPhoneOn(): Promise<boolean> {
  return (await q(`SELECT 1 FROM maple_push_subs WHERE NOT needs_resubscribe LIMIT 1`)).length > 0;
}

/**
 * Publish one family's wakes for its next few moments not already
 * published: her medicines' moments (only while one of its phones wants
 * medicine notices) and its pending tests ("Send a test in 1 minute"),
 * within QStash's 7 days. Also keeps the shared safety net in step. Called
 * from writes and from scheduled ticks, never from an open app's polls.
 * `pre`: moments the caller already worked out for this family (the tick
 * shares its own).
 */
export async function scheduleWakeups(scope: FamilyScope, now = new Date(), pre?: { plans: PlanMoments[] } | null): Promise<{ mode: SchedulerMode; published: number }> {
  if (schedulerMode() !== "qstash") return { mode: "fallback", published: 0 };
  const subs = await q(`SELECT prefs, test_due_at FROM maple_push_subs WHERE family_id = $1 AND NOT needs_resubscribe`, [scope.familyId]);
  await ensureSafetyNet(subs.length > 0 || (await anyPhoneOn()), now);
  if (!subs.length) return { mode: "qstash", published: 0 };
  const t = now.getTime();
  const times: number[] = [];
  const wantMeds = subs.some((s) => (s.prefs as { meds?: boolean } | null)?.meds !== false);
  if (wantMeds) {
    const plans = pre?.plans ?? (await collectMoments(scope, now)).plans;
    for (const p of plans) for (const m of p.moments) if (m.at > t) times.push(m.at);
  }
  for (const s of subs) if (s.test_due_at) times.push(Math.max(t, new Date(s.test_due_at as string).getTime()));
  const next = [...new Set(times.filter((x) => x - t <= MAX_AHEAD_MS))].sort((a, b) => a - b).slice(0, WAKES_PER_CALL);
  let published = 0;
  for (const at of next) if (await scheduleWake(scope.familyId, at, "wake")) published++;
  return { mode: "qstash", published };
}

/** The family's next wake already published (for the health line), if any. */
export async function nextWake(familyId: number, now = new Date()): Promise<string | null> {
  const rows = await q(`SELECT MIN(sent_at) AS at FROM maple_push_sent WHERE key LIKE 'wake:%' AND sent_at > $1 AND ${familySent(2)}`, [now.toISOString(), familyId]);
  return rows[0]?.at ? new Date(rows[0].at as string).toISOString() : null;
}

/**
 * The family a signed wake names in its body (`family`), or family 1 for a
 * wake published before families (or by brooker-wedding's copy). Null when
 * the body names something that isn't a family id.
 */
export function wakeFamily(body: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    return FAMILY_ONE;
  }
  const fam = parsed && typeof parsed === "object" ? (parsed as { family?: unknown }).family : undefined;
  if (fam === undefined || fam === null) return FAMILY_ONE;
  return typeof fam === "number" && Number.isSafeInteger(fam) && fam > 0 ? fam : null;
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
