import { createHash, randomUUID } from "node:crypto";
import { query, transaction } from "@/lib/db";
import { cleanClientId, famId, getEntry, listEntries, NotFound, reopenTimer, restoreEntry, rowToEntry, softDeleteEntry, stopTimer, StoreUnavailable, updateEntry, type FamilyRef } from "../store";
import { addDays, DEFAULT_TZ, isDayKey } from "../time";
import { SLEEP_PLACES, type Entry, type EntryOf, type SleepPlace, type Source } from "../types";
import type { Voice } from "../voice";
import { chooseSleepLink, endsSleep, followSleep, nextHandoff, progressWindow, SAME_MS, sleepProgress, tryDayBounds } from "./engine";
import { SleepInputError } from "./errors";
import { cleanCheckinExtras, cleanCheckinNight, cleanGoalInput, cleanGoalNote, cleanProtected, goalProgress, goalSpan, lastNightKey, refuseUnsafe, type GoalProgress, type GoalRules } from "./goals";
import {
  CHECKIN_NOTE_MAX,
  CHECKIN_PLACES,
  HANDOFF_ANSWERS,
  UNTIMED_TRIES,
  type CheckinExtras,
  GOAL_NOTE_MAX,
  GOAL_STATUSES,
  GOALS_ACTIVE_MAX,
  GOALS_OPEN_MAX,
  PROTECTED_ANSWERS,
  TARGET_KINDS,
  type GoalInput,
  type GoalStatus,
  type GoalStep,
  type GoalTarget,
  type ProtectedAnswer,
  type RosterWindow,
  type SleepCheckin,
  HANDOFF_AHEAD_MS,
  LOOKBACK_MS,
  MAX_SPAN_MS,
  PLAN_GOAL_MAX,
  PLAN_STAGES,
  SHIFT_ENDINGS,
  TRIES_PER_DAY_MAX,
  TRY_NOTE_MAX,
  TRY_OUTCOMES,
  TRY_TAGS,
  TRY_TIMES_MAX,
  type BassinetTry,
  type HoldingShift,
  type PlanPatch,
  type PlanStage,
  type ShiftEnding,
  type SleepGoal,
  type SleepPlan,
  type SleepState,
  type TryOutcome,
  type TryTag,
} from "./types";
import { isTrySlot, STAGE_INFO } from "./words";

/**
 * The sleep plan's SQL (sleep/schema.ts). Every statement names the family
 * and the baby, so another family's plan, try or shift reads exactly like
 * one that isn't there.
 *
 * A try sits on one sleep entry in maple_entries, and the sleep entry is the
 * only thing sleep totals read, so a try never counts as sleep twice:
 * - Starting a try links the running sleep timer, else the logged sleep it
 *   overlaps; with neither, it makes a running bassinet sleep in the same
 *   transaction (made_sleep), so the log and the try can't disagree.
 * - Finishing it with a wake ends a running linked sleep then; picked up
 *   still asleep, the sleep runs on (in arms, for a sleep the try made).
 * - Moving a try's times moves the linked sleep's start or end only where it
 *   matched the try's (engine.ts followSleep), with the sleep's own check.
 * - Deleting a try deletes a sleep only if the try made it and it's still
 *   as the try left it.
 * Edits name the updated_at they were made against (a newer one is someone
 * else's change: SleepConflict "changed"); retries carry a client_id.
 */

type Row = Record<string, unknown>;

async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const rows = await query(sql, params);
  if (rows === null) throw new StoreUnavailable();
  return rows as Row[];
}

async function tx(statements: { sql: string; params: unknown[] }[]): Promise<Row[][]> {
  const r = await transaction(statements);
  if (r === null) throw new StoreUnavailable();
  return r as Row[][];
}

const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const textOrNull = (v: unknown): string | null => (v == null ? null : String(v));

export { SleepInputError };

/**
 * Lost a race or found it changed (409). "changed": someone edited it since
 * this phone read it. "finished": the try already ended. "running": another
 * try is running. "open": another shift is open. Carries the record as it is.
 */
export class SleepConflict extends Error {
  constructor(
    message: string,
    readonly reason: "changed" | "finished" | "running" | "open",
    readonly current: BassinetTry | HoldingShift | SleepPlan | SleepGoal | null
  ) {
    super(message);
    this.name = "SleepConflict";
  }
}

function isUnique(err: unknown, index: string): boolean {
  const e = err as { code?: string; constraint?: string; message?: string } | null;
  return !!e && e.code === "23505" && (e.constraint === index || !!e.message?.includes(index));
}

/** JS ms against Postgres µs: two updated_at values naming the same write. */
const same = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 1;
const updatedAtMatches = (param: number) => `updated_at BETWEEN $${param}::timestamptz - INTERVAL '1 millisecond' AND $${param}::timestamptz + INTERVAL '1 millisecond'`;

// ── rows ─────────────────────────────────────────────────────────────────

const asStage = (v: unknown): PlanStage => (PLAN_STAGES as readonly number[]).includes(Number(v)) ? (Number(v) as PlanStage) : 1;
const asPlace = (v: unknown): SleepPlace | null => ((SLEEP_PLACES as readonly unknown[]).includes(v) ? (v as SleepPlace) : null);
const asSource = (v: unknown): Source => String(v ?? "web") as Source;

export function rowToPlan(r: Row): SleepPlan {
  const times = Array.isArray(r.try_times) ? r.try_times.filter(isTrySlot) : [];
  return {
    baby_id: Number(r.baby_id),
    stage: asStage(r.stage),
    stage_since: iso(r.stage_since),
    sleeps_now: asPlace(r.sleeps_now),
    goal: textOrNull(r.goal),
    tries_per_day: Number(r.tries_per_day) || 1,
    try_times: times,
    fallback: isTrySlot(r.fallback) ? r.fallback : null,
    snoozed_until: isDayKey(r.snoozed_until) ? r.snoozed_until : null,
    revision: Number(r.revision),
    created_by: textOrNull(r.created_by),
    updated_by: textOrNull(r.updated_by),
    source: asSource(r.source),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

export function rowToTry(r: Row): BassinetTry {
  const tags = Array.isArray(r.tags) ? (r.tags.filter((t) => (TRY_TAGS as readonly unknown[]).includes(t)) as TryTag[]) : [];
  return {
    id: Number(r.id),
    started_at: iso(r.started_at),
    ended_at: isoOrNull(r.ended_at),
    outcome: (TRY_OUTCOMES as readonly unknown[]).includes(r.outcome) ? (r.outcome as TryOutcome) : null,
    put_down_by: textOrNull(r.put_down_by),
    tags,
    note: textOrNull(r.note),
    sleep_entry_id: r.sleep_entry_id == null ? null : Number(r.sleep_entry_id),
    made_sleep: r.made_sleep === true,
    created_by: textOrNull(r.created_by),
    updated_by: textOrNull(r.updated_by),
    source: asSource(r.source),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

export function rowToShift(r: Row): HoldingShift {
  return {
    id: Number(r.id),
    holder: String(r.holder),
    started_at: iso(r.started_at),
    handoff_at: isoOrNull(r.handoff_at),
    next_holder: textOrNull(r.next_holder),
    ended_at: isoOrNull(r.ended_at),
    ended_how: (SHIFT_ENDINGS as readonly unknown[]).includes(r.ended_how) ? (r.ended_how as ShiftEnding) : null,
    created_by: textOrNull(r.created_by),
    updated_by: textOrNull(r.updated_by),
    source: asSource(r.source),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

// ── checks every write shares ────────────────────────────────────────────

const FUTURE_SLACK_MS = 5_000;

/** A time someone gave: not ahead of now (a few seconds of phone clock count as now), not before `lookback`. */
function pastTime(at: Date | undefined, now: Date, label: string, lookback = LOOKBACK_MS): Date {
  const t = at ?? now;
  if (Number.isNaN(t.getTime())) throw new SleepInputError(`${label} isn't a valid time.`);
  if (t.getTime() > now.getTime() + FUTURE_SLACK_MS) throw new SleepInputError(`${label} can't be in the future.`);
  if (t.getTime() < now.getTime() - lookback) throw new SleepInputError(`${label} is too long ago (${lookback >= 24 * 3600_000 ? `${Math.round(lookback / (24 * 3600_000))} days` : `${Math.round(lookback / 3600_000)} hours`} at most).`);
  return t.getTime() > now.getTime() ? now : t;
}

function span(start: Date, end: Date | null, what = "That try") {
  if (end && end.getTime() < start.getTime() - SAME_MS) throw new SleepInputError("The end is before the start.");
  if (end && end.getTime() - start.getTime() > MAX_SPAN_MS) throw new SleepInputError(`${what} would be over 12 hours. Pick when it really ended.`);
}

export function cleanTags(raw: unknown): TryTag[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new SleepInputError("Tags must be a list.");
  const bad = raw.filter((t) => !(TRY_TAGS as readonly unknown[]).includes(t));
  if (bad.length) throw new SleepInputError(`Unknown tag: ${String(bad[0])}. Tags are fed, swaddled and white_noise.`);
  return [...new Set(raw as TryTag[])];
}

export function cleanNote(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") throw new SleepInputError("The note must be text.");
  const t = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (t.length > TRY_NOTE_MAX) throw new SleepInputError(`The note is too long (${TRY_NOTE_MAX} characters at most).`);
  return t || null;
}

const asOutcome = (v: unknown): TryOutcome => {
  if (!(TRY_OUTCOMES as readonly unknown[]).includes(v)) throw new SleepInputError("How it went must be stayed_asleep, woke_calm, woke_crying or picked_up.");
  return v as TryOutcome;
};

/** A sleep entry's client id derived from its try's, so a retried start never makes a second sleep. */
const sleepClientFor = (tryClient: string | null) => `tsl:${createHash("sha256").update(tryClient ?? randomUUID()).digest("hex").slice(0, 40)}`;

// ── the plan ─────────────────────────────────────────────────────────────

export async function getPlan(fam: FamilyRef, babyId: number): Promise<SleepPlan | null> {
  const rows = await q(`SELECT * FROM maple_sleep_plans WHERE family_id = $1 AND baby_id = $2`, [famId(fam), babyId]);
  return rows.length ? rowToPlan(rows[0]) : null;
}

/**
 * A patch checked and filled in: a new stage brings its defaults, unless the
 * same patch sets them. The goal's words never leave the baby to cry or have
 * the baby asleep on or with an adult, or in a bed, couch, recliner,
 * armchair or swing (goals.ts unsafeSleep; `v` names the baby in the refusal).
 */
export function cleanPlanPatch(raw: Record<string, unknown>, current: SleepPlan | null, v?: Voice): PlanPatch {
  const out: PlanPatch = {};
  if ("stage" in raw) {
    if (!(PLAN_STAGES as readonly unknown[]).includes(raw.stage)) throw new SleepInputError("The stage must be 1, 2, 3 or 4.");
    out.stage = raw.stage as PlanStage;
  }
  if ("sleeps_now" in raw) {
    if (raw.sleeps_now !== null && !(SLEEP_PLACES as readonly unknown[]).includes(raw.sleeps_now)) throw new SleepInputError(`Where she sleeps now must be one of ${SLEEP_PLACES.join(", ")}.`);
    out.sleeps_now = (raw.sleeps_now as SleepPlace | null) ?? null;
  }
  if ("goal" in raw) {
    if (raw.goal !== null && typeof raw.goal !== "string") throw new SleepInputError("The goal must be text.");
    const g = typeof raw.goal === "string" ? raw.goal.trim() : "";
    if (g.length > PLAN_GOAL_MAX) throw new SleepInputError(`The goal is too long (${PLAN_GOAL_MAX} characters at most).`);
    refuseUnsafe(g, "The goal", { v });
    out.goal = g || null;
  }
  if ("tries_per_day" in raw) {
    const n = raw.tries_per_day;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > TRIES_PER_DAY_MAX) throw new SleepInputError(`Tries a day must be a whole number from 1 to ${TRIES_PER_DAY_MAX}.`);
    out.tries_per_day = n;
  }
  if ("try_times" in raw) {
    const t = raw.try_times;
    if (!Array.isArray(t) || !t.length || t.length > TRY_TIMES_MAX || !t.every(isTrySlot)) {
      throw new SleepInputError(`Try times are 1 to ${TRY_TIMES_MAX} of first_night_stretch, night_stretch, first_morning_nap, any_nap or a local time like 22:30.`);
    }
    out.try_times = [...new Set(t as string[])];
  }
  if ("fallback" in raw) {
    if (raw.fallback !== null && !isTrySlot(raw.fallback)) throw new SleepInputError("The backup time must be a named moment or a local time like 09:30.");
    out.fallback = (raw.fallback as string | null) ?? null;
  }
  if ("snoozed_until" in raw) {
    if (raw.snoozed_until !== null && !isDayKey(raw.snoozed_until)) throw new SleepInputError("snoozed_until must be a date like 2026-10-20.");
    out.snoozed_until = (raw.snoozed_until as string | null) ?? null;
  }
  if (out.stage !== undefined && out.stage !== current?.stage) {
    const d = STAGE_INFO[out.stage].defaults;
    if (out.tries_per_day === undefined) out.tries_per_day = d.tries_per_day;
    if (out.try_times === undefined) out.try_times = d.try_times;
    if (out.fallback === undefined) out.fallback = d.fallback;
    // A new stage starts fresh: the suggestion counts tries from now, and "Not now" no longer holds.
    if (out.snoozed_until === undefined) out.snoozed_until = null;
  }
  return out;
}

/** The plan, made with stage 1's defaults if there's none yet (two phones setting it up at once get the same one). */
export async function ensurePlan(fam: FamilyRef, babyId: number, by: string, source: Source, init: PlanPatch = {}): Promise<{ plan: SleepPlan; created: boolean }> {
  const stage = init.stage ?? 1;
  const d = STAGE_INFO[stage].defaults;
  const rows = await q(
    `INSERT INTO maple_sleep_plans (family_id, baby_id, stage, sleeps_now, goal, tries_per_day, try_times, fallback, created_by, source)
     SELECT $1::bigint, $2::integer, $3, $4, $5, $6, $7::jsonb, $8, $9, $10
     WHERE EXISTS (SELECT 1 FROM maple_babies WHERE id = $2::integer AND family_id = $1::bigint)
     ON CONFLICT (family_id, baby_id) DO NOTHING RETURNING *`,
    [
      famId(fam),
      babyId,
      stage,
      init.sleeps_now === undefined ? "arms" : init.sleeps_now,
      init.goal ?? null,
      init.tries_per_day ?? d.tries_per_day,
      JSON.stringify(init.try_times ?? d.try_times),
      init.fallback === undefined ? d.fallback : init.fallback,
      by,
      source,
    ]
  );
  if (rows.length) return { plan: rowToPlan(rows[0]), created: true };
  const plan = await getPlan(fam, babyId);
  if (!plan) throw new NotFound("Baby not found");
  return { plan, created: false };
}

/** Change the plan, only if it's still at `revision` (else SleepConflict "changed" with the plan as it is). */
export async function updatePlan(fam: FamilyRef, babyId: number, patch: PlanPatch, revision: number, by: string, source: Source): Promise<{ plan: SleepPlan; before: SleepPlan }> {
  const before = await getPlan(fam, babyId);
  if (!before) throw new NotFound("There's no sleep plan yet");
  if (before.revision !== revision) throw new SleepConflict("Someone changed the sleep plan just now.", "changed", before);
  const sets: string[] = [];
  const params: unknown[] = [famId(fam), babyId, revision, by, source];
  const set = (col: string, v: unknown, cast = "") => {
    params.push(v);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (patch.stage !== undefined) {
    set("stage", patch.stage);
    if (patch.stage !== before.stage) sets.push("stage_since = NOW()");
  }
  if (patch.sleeps_now !== undefined) set("sleeps_now", patch.sleeps_now);
  if (patch.goal !== undefined) set("goal", patch.goal);
  if (patch.tries_per_day !== undefined) set("tries_per_day", patch.tries_per_day);
  if (patch.try_times !== undefined) set("try_times", JSON.stringify(patch.try_times), "::jsonb");
  if (patch.fallback !== undefined) set("fallback", patch.fallback);
  if (patch.snoozed_until !== undefined) set("snoozed_until", patch.snoozed_until);
  if (!sets.length) return { plan: before, before };
  const rows = await q(
    `UPDATE maple_sleep_plans SET ${sets.join(", ")}, revision = revision + 1, updated_by = $4, source = $5, updated_at = NOW()
     WHERE family_id = $1 AND baby_id = $2 AND revision = $3 RETURNING *`,
    params
  );
  if (!rows.length) {
    const now = await getPlan(fam, babyId);
    throw new SleepConflict("Someone changed the sleep plan just now.", "changed", now);
  }
  return { plan: rowToPlan(rows[0]), before };
}

// ── tries ────────────────────────────────────────────────────────────────

export async function getTry(fam: FamilyRef, id: number, opts: { includeDeleted?: boolean } = {}): Promise<(BassinetTry & { deleted_at?: string | null; baby_id: number }) | null> {
  const rows = await q(`SELECT * FROM maple_sleep_tries WHERE id = $1 AND family_id = $2 ${opts.includeDeleted ? "" : "AND deleted_at IS NULL"}`, [id, famId(fam)]);
  return rows.length ? { ...rowToTry(rows[0]), deleted_at: isoOrNull(rows[0].deleted_at), baby_id: Number(rows[0].baby_id) } : null;
}

export async function runningTry(fam: FamilyRef, babyId: number): Promise<BassinetTry | null> {
  const rows = await q(`SELECT * FROM maple_sleep_tries WHERE family_id = $1 AND baby_id = $2 AND ended_at IS NULL AND deleted_at IS NULL`, [famId(fam), babyId]);
  return rows.length ? rowToTry(rows[0]) : null;
}

/** Tries that began in [from, to), plus the running one, newest first. */
export async function listTries(fam: FamilyRef, babyId: number, opts: { from?: Date; to?: Date; limit?: number } = {}): Promise<BassinetTry[]> {
  const rows = await q(
    `SELECT * FROM maple_sleep_tries
     WHERE family_id = $1 AND baby_id = $2 AND deleted_at IS NULL
       AND ((($3::timestamptz IS NULL OR started_at >= $3::timestamptz) AND ($4::timestamptz IS NULL OR started_at < $4::timestamptz)) OR ended_at IS NULL)
     ORDER BY started_at DESC, id DESC LIMIT $5`,
    [famId(fam), babyId, opts.from?.toISOString() ?? null, opts.to?.toISOString() ?? null, Math.min(Math.max(opts.limit ?? 500, 1), 2000)]
  );
  return rows.map(rowToTry);
}

async function byClient(fam: FamilyRef, table: "maple_sleep_tries" | "maple_sleep_shifts", clientId: string): Promise<Row | null> {
  const rows = await q(`SELECT * FROM ${table} WHERE family_id = $1 AND client_id = $2`, [famId(fam), clientId]);
  return rows[0] ?? null;
}

/** The sleep entries a try between `start` and `end` could sit on: the running one, and any logged one it overlaps. */
async function sleepsAround(fam: FamilyRef, babyId: number, start: Date, end: Date | null, now: Date): Promise<Entry[]> {
  return listEntries(fam, { babyId, kinds: ["sleep"], from: start, to: new Date((end ?? now).getTime() + 1000), includeActive: true, limit: 50 });
}

export type TryWrite = {
  try: BassinetTry;
  /** The try before this write (null for a new one), for Undo. */
  before: BassinetTry | null;
  /** The sleep entry the try sits on, after the write, and before it. */
  sleep: Entry | null;
  sleepBefore: Entry | null;
  status: "created" | "running" | "deduped" | "duplicate" | "updated" | "finished" | "already_finished";
  /** How the try found its sleep: the running timer, a logged sleep it overlaps, or one it made. */
  link?: "running" | "overlap" | "create";
  /** Starting a try ends the open holding shift: she's in the bassinet now. */
  endedShift?: HoldingShift | null;
  endedShiftBefore?: HoldingShift | null;
};

const SLEEP_NOW = JSON.stringify({ place: "bassinet" });

/**
 * Lay her down: a running try, sitting on the running sleep timer if there
 * is one, else a logged sleep it overlaps, else a running bassinet sleep it
 * makes in the same transaction. Two phones at once get the same try
 * (status "running"); a retried request with its client id gets its first
 * save back ("deduped"). The open holding shift ends at the same moment.
 */
export async function startTry(
  fam: FamilyRef,
  input: { babyId: number; at?: Date; putDownBy: string | null; tags: TryTag[]; note: string | null; by: string; source: Source; clientId?: string | null; device?: string | null }
): Promise<TryWrite> {
  const familyId = famId(fam);
  const now = new Date();
  const at = pastTime(input.at, now, "When she was laid down", 4 * 3600_000);
  const clientId = cleanClientId(input.clientId);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (clientId) {
      const prior = await byClient(fam, "maple_sleep_tries", clientId);
      if (prior) {
        const t = rowToTry(prior);
        const sleep = t.sleep_entry_id ? await getEntry(fam, t.sleep_entry_id) : null;
        return { try: t, before: null, sleep, sleepBefore: sleep, status: "deduped" };
      }
    }
    const running = await runningTry(fam, input.babyId);
    if (running) {
      const sleep = running.sleep_entry_id ? await getEntry(fam, running.sleep_entry_id) : null;
      return { try: running, before: null, sleep, sleepBefore: sleep, status: "running" };
    }
    const link = chooseSleepLink(at.getTime(), null, await sleepsAround(fam, input.babyId, at, null, now), now.getTime());
    const common = [familyId, input.babyId, at.toISOString(), input.putDownBy, input.tags, input.note, input.by, input.source, clientId, input.device ?? null];
    try {
      let rows: Row[];
      let made: Entry | null = null;
      if (link.kind === "create") {
        const sleepClient = sleepClientFor(clientId);
        const [sleepRows, tryRows] = await tx([
          {
            sql: `INSERT INTO maple_entries (family_id, baby_id, kind, started_at, active, data, created_by, source, client_id, device)
                  SELECT $1::bigint, $2::integer, 'sleep', $3::timestamptz, TRUE, $4::jsonb, $5, $6, $7, $8
                  WHERE EXISTS (SELECT 1 FROM maple_babies WHERE id = $2::integer AND family_id = $1::bigint)
                  RETURNING *`,
            params: [familyId, input.babyId, at.toISOString(), SLEEP_NOW, input.by, input.source, sleepClient, input.device ?? null],
          },
          {
            sql: `INSERT INTO maple_sleep_tries (family_id, baby_id, started_at, put_down_by, tags, note, created_by, source, client_id, device, sleep_entry_id, made_sleep)
                  SELECT $1::bigint, $2::integer, $3::timestamptz, $4, $5::text[], $6, $7, $8, $9, $10, e.id, TRUE
                  FROM maple_entries e WHERE e.family_id = $1::bigint AND e.client_id = $11
                  RETURNING *`,
            params: [...common, sleepClient],
          },
        ]);
        rows = tryRows;
        made = sleepRows[0] ? rowToEntry(sleepRows[0]) : null;
      } else {
        rows = await q(
          `INSERT INTO maple_sleep_tries (family_id, baby_id, started_at, put_down_by, tags, note, created_by, source, client_id, device, sleep_entry_id, made_sleep)
           SELECT $1::bigint, $2::integer, $3::timestamptz, $4, $5::text[], $6, $7, $8, $9, $10, $11, FALSE
           WHERE EXISTS (SELECT 1 FROM maple_babies WHERE id = $2::integer AND family_id = $1::bigint)
           RETURNING *`,
          [...common, link.entry.id]
        );
      }
      if (!rows.length) throw new NotFound("Baby not found");
      const t = rowToTry(rows[0]);
      const sleep = made ?? (link.kind === "create" ? null : await getEntry(fam, link.entry.id));
      const shift = await endOpenShift(fam, input.babyId, at, "bassinet", input.by);
      return { try: t, before: null, sleep, sleepBefore: link.kind === "create" ? null : link.entry, status: "created", link: link.kind, endedShift: shift?.after ?? null, endedShiftBefore: shift?.before ?? null };
    } catch (err) {
      // Another phone laid her down (or started the sleep timer) at the same moment: read again and join that.
      if (isUnique(err, "uniq_maple_sleep_tries_running") || isUnique(err, "uniq_maple_entries_running") || isUnique(err, "uniq_maple_sleep_tries_client")) continue;
      throw err;
    }
  }
  const running = await runningTry(fam, input.babyId);
  if (running) return { try: running, before: null, sleep: running.sleep_entry_id ? await getEntry(fam, running.sleep_entry_id) : null, sleepBefore: null, status: "running" };
  throw new Error("Couldn't start the try, please try again");
}

/** Possibly the same try someone already logged: starting within 3 minutes, or overlapping. */
function looksSameTry(t: BassinetTry, start: number, end: number, now: number): boolean {
  const s = Date.parse(t.started_at);
  const e = t.ended_at ? Date.parse(t.ended_at) : now;
  return Math.abs(s - start) <= 3 * 60_000 || (s < end && start < e);
}

/**
 * A try that already happened. It sits on the logged sleep it overlaps most
 * (a running sleep timer counts), and with none, on a finished bassinet
 * sleep it makes with it. Existing sleeps are never changed by a logged
 * try. "duplicate": an overlapping try is already there (nothing saved,
 * unless allowDuplicate).
 */
export async function logTry(
  fam: FamilyRef,
  input: { babyId: number; start: Date; end: Date; outcome: TryOutcome; putDownBy: string | null; tags: TryTag[]; note: string | null; by: string; source: Source; clientId?: string | null; device?: string | null; allowDuplicate?: boolean }
): Promise<TryWrite> {
  const familyId = famId(fam);
  const now = new Date();
  const start = pastTime(input.start, now, "When she was laid down");
  const end = pastTime(input.end, now, "When the try ended");
  span(start, end);
  const outcome = asOutcome(input.outcome);
  const clientId = cleanClientId(input.clientId);
  if (clientId) {
    const prior = await byClient(fam, "maple_sleep_tries", clientId);
    if (prior) {
      const t = rowToTry(prior);
      return { try: t, before: null, sleep: t.sleep_entry_id ? await getEntry(fam, t.sleep_entry_id) : null, sleepBefore: null, status: "deduped" };
    }
  }
  const nearby = await listTries(fam, input.babyId, { from: new Date(start.getTime() - MAX_SPAN_MS), to: new Date(end.getTime() + 3 * 60_000) });
  // The same person sending the same thing again within two minutes (a model retrying after a timeout).
  const retry = nearby.find(
    (t) => t.created_by === input.by && t.outcome === outcome && Math.abs(Date.parse(t.started_at) - start.getTime()) <= 2 * 60_000 && now.getTime() - Date.parse(t.created_at) <= 2 * 60_000
  );
  if (retry) return { try: retry, before: null, sleep: retry.sleep_entry_id ? await getEntry(fam, retry.sleep_entry_id) : null, sleepBefore: null, status: "deduped" };
  if (!input.allowDuplicate) {
    const twin = nearby.find((t) => looksSameTry(t, start.getTime(), end.getTime(), now.getTime()));
    if (twin) return { try: twin, before: null, sleep: null, sleepBefore: null, status: "duplicate" };
  }
  const link = chooseSleepLink(start.getTime(), end.getTime(), await sleepsAround(fam, input.babyId, start, end, now), now.getTime());
  const common = [familyId, input.babyId, start.toISOString(), end.toISOString(), outcome, input.putDownBy, input.tags, input.note, input.by, input.source, clientId, input.device ?? null];
  const insertTry = (sleepSql: string) => `INSERT INTO maple_sleep_tries (family_id, baby_id, started_at, ended_at, outcome, put_down_by, tags, note, created_by, source, client_id, device, sleep_entry_id, made_sleep)
    SELECT $1::bigint, $2::integer, $3::timestamptz, $4::timestamptz, $5, $6, $7::text[], $8, $9, $10, $11, $12, ${sleepSql}`;
  let rows: Row[];
  let made: Entry | null = null;
  try {
    if (link.kind === "create") {
      const sleepClient = sleepClientFor(clientId);
      const [sleepRows, tryRows] = await tx([
        {
          sql: `INSERT INTO maple_entries (family_id, baby_id, kind, started_at, ended_at, active, data, created_by, source, client_id, device)
                SELECT $1::bigint, $2::integer, 'sleep', $3::timestamptz, $4::timestamptz, FALSE, $5::jsonb, $6, $7, $8, $9
                WHERE EXISTS (SELECT 1 FROM maple_babies WHERE id = $2::integer AND family_id = $1::bigint)
                RETURNING *`,
          params: [familyId, input.babyId, start.toISOString(), end.toISOString(), SLEEP_NOW, input.by, input.source, sleepClient, input.device ?? null],
        },
        { sql: `${insertTry("e.id, TRUE")} FROM maple_entries e WHERE e.family_id = $1::bigint AND e.client_id = $13 RETURNING *`, params: [...common, sleepClient] },
      ]);
      rows = tryRows;
      made = sleepRows[0] ? rowToEntry(sleepRows[0]) : null;
    } else {
      rows = await q(`${insertTry("$13, FALSE")} WHERE EXISTS (SELECT 1 FROM maple_babies WHERE id = $2::integer AND family_id = $1::bigint) RETURNING *`, [...common, link.entry.id]);
    }
  } catch (err) {
    if (isUnique(err, "uniq_maple_sleep_tries_client") && clientId) {
      const prior = await byClient(fam, "maple_sleep_tries", clientId);
      if (prior) return { try: rowToTry(prior), before: null, sleep: null, sleepBefore: null, status: "deduped" };
    }
    throw err;
  }
  if (!rows.length) throw new NotFound("Baby not found");
  const t = rowToTry(rows[0]);
  return { try: t, before: null, sleep: made ?? (link.kind === "create" ? null : await getEntry(fam, link.entry.id)), sleepBefore: link.kind === "create" ? null : link.entry, status: "created", link: link.kind };
}

/** A sleep the try made is "as the try left it" while it still starts when she was laid down. */
const sameMs = (a: string | null, b: string | null) => a != null && b != null && Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_MS;

/**
 * How it went. A wake (stayed asleep, woke calm, woke crying) ends a running
 * linked sleep at the try's end; picked up while still asleep, the sleep
 * runs on, and a bassinet sleep the try made carries on as in arms. Asked of
 * the try this phone saw (expectUpdatedAt, optional): changed since,
 * SleepConflict "changed"; already finished, status "already_finished".
 */
export async function finishTry(
  fam: FamilyRef,
  id: number,
  input: { outcome: TryOutcome; at?: Date; tags?: TryTag[]; note?: string | null; putDownBy?: string | null; by: string; expectUpdatedAt?: string }
): Promise<TryWrite> {
  const now = new Date();
  const outcome = asOutcome(input.outcome);
  const before = await getTry(fam, id);
  if (!before) throw new NotFound(`Bassinet try ${id} not found`);
  if (before.ended_at) return { try: before, before, sleep: null, sleepBefore: null, status: "already_finished" };
  if (input.expectUpdatedAt !== undefined && !same(input.expectUpdatedAt, before.updated_at)) throw new SleepConflict("Someone changed this try just now.", "changed", before);
  const sleepBefore = before.sleep_entry_id ? await getEntry(fam, before.sleep_entry_id) : null;
  // A sleep timer stopped meanwhile (Woke up on the dock, Siri) is when she came out, unless a time was given.
  const defaultEnd = sleepBefore && !sleepBefore.active && sleepBefore.ended_at && Date.parse(sleepBefore.ended_at) >= Date.parse(before.started_at) ? new Date(sleepBefore.ended_at) : now;
  const end = pastTime(input.at ?? defaultEnd, now, "When the try ended");
  const start = new Date(before.started_at);
  if (end.getTime() < start.getTime()) throw new SleepInputError("That's before she was laid down.");
  span(start, end);
  const params: unknown[] = [id, famId(fam), end.toISOString(), outcome, input.by, before.updated_at];
  const sets = ["ended_at = $3", "outcome = $4", "updated_by = $5", "updated_at = NOW()"];
  if (input.tags !== undefined) {
    params.push(input.tags);
    sets.push(`tags = $${params.length}::text[]`);
  }
  if (input.note !== undefined) {
    params.push(input.note);
    sets.push(`note = $${params.length}`);
  }
  if (input.putDownBy !== undefined) {
    params.push(input.putDownBy);
    sets.push(`put_down_by = $${params.length}`);
  }
  const rows = await q(`UPDATE maple_sleep_tries SET ${sets.join(", ")} WHERE id = $1 AND family_id = $2 AND deleted_at IS NULL AND ended_at IS NULL AND ${updatedAtMatches(6)} RETURNING *`, params);
  if (!rows.length) {
    const cur = await getTry(fam, id);
    if (!cur) throw new NotFound(`Bassinet try ${id} not found`);
    if (cur.ended_at) return { try: cur, before, sleep: null, sleepBefore: null, status: "already_finished" };
    throw new SleepConflict("Someone changed this try just now.", "changed", cur);
  }
  const t = rowToTry(rows[0]);
  let sleep = sleepBefore;
  if (sleepBefore && sleepBefore.kind === "sleep" && sleepBefore.active) {
    try {
      if (endsSleep(outcome)) sleep = await stopTimer(fam, sleepBefore.id, end, input.by);
      else if (before.made_sleep && (sleepBefore as EntryOf<"sleep">).data.place === "bassinet") {
        // Picked up still asleep: the rest of this sleep is in arms (the try's own window stays the bassinet's).
        sleep = await updateEntry(fam, sleepBefore.id, { data: { place: "arms" } }, input.by, { expectUpdatedAt: sleepBefore.updated_at });
      }
    } catch (err) {
      // The sleep changed meanwhile (the other phone's Woke up): the try is finished either way, and the sleep stays as they left it.
      sleep = (await getEntry(fam, sleepBefore.id)) ?? null;
      if (!(err instanceof Error)) throw err;
    }
  }
  return { try: t, before, sleep, sleepBefore, status: "finished" };
}

/**
 * Undo a finish: the try runs again, and a sleep the finish stopped (or put
 * in arms) goes back as it was, each only if nobody changed it since.
 */
export async function undoFinish(
  fam: FamilyRef,
  id: number,
  input: { expectUpdatedAt: string; sleep?: { id: number; expectUpdatedAt: string; wasActive: boolean; place?: SleepPlace | null } | null; by: string }
): Promise<TryWrite> {
  const cur = await getTry(fam, id);
  if (!cur) throw new NotFound(`Bassinet try ${id} not found`);
  if (!same(input.expectUpdatedAt, cur.updated_at)) throw new SleepConflict("Someone changed this try just now.", "changed", cur);
  let rows: Row[];
  try {
    rows = await q(
      `UPDATE maple_sleep_tries SET ended_at = NULL, outcome = NULL, updated_by = $3, updated_at = NOW()
       WHERE id = $1 AND family_id = $2 AND deleted_at IS NULL AND ${updatedAtMatches(4)} RETURNING *`,
      [id, famId(fam), input.by, cur.updated_at]
    );
  } catch (err) {
    if (isUnique(err, "uniq_maple_sleep_tries_running")) throw new SleepConflict("Another bassinet try is running now, so this one can't go back to running.", "running", cur);
    throw err;
  }
  if (!rows.length) throw new SleepConflict("Someone changed this try just now.", "changed", (await getTry(fam, id)) ?? cur);
  const t = rowToTry(rows[0]);
  let sleep: Entry | null = null;
  const s = input.sleep;
  if (s && t.sleep_entry_id === s.id) {
    const now = await getEntry(fam, s.id);
    if (now && same(s.expectUpdatedAt, now.updated_at)) {
      try {
        if (s.wasActive && !now.active) sleep = await reopenTimer(fam, s.id, input.by, { expectUpdatedAt: now.updated_at });
        else if (s.place !== undefined && now.kind === "sleep") sleep = await updateEntry(fam, s.id, { data: { place: s.place } }, input.by, { expectUpdatedAt: now.updated_at });
        else sleep = now;
      } catch {
        // Another sleep timer runs now, or it changed: the try is back, the sleep stays as it is.
        sleep = (await getEntry(fam, s.id)) ?? null;
      }
    } else sleep = now;
  }
  return { try: t, before: cur, sleep, sleepBefore: null, status: "updated" };
}

export type TryPatch = { started_at?: Date; ended_at?: Date; outcome?: TryOutcome; tags?: TryTag[]; note?: string | null; put_down_by?: string | null };

/**
 * Correct a try (Edit time, a later fix): only the try this phone saw. The
 * linked sleep's start or end moves with it where it matched the try's
 * (followSleep), with the sleep's own check; when the sleep changed
 * meanwhile, the try still saves and `sleep` says where the sleep is.
 */
export async function updateTry(fam: FamilyRef, id: number, patch: TryPatch, opts: { by: string; expectUpdatedAt?: string }): Promise<TryWrite & { sleepMoved: boolean }> {
  const now = new Date();
  const before = await getTry(fam, id);
  if (!before) throw new NotFound(`Bassinet try ${id} not found`);
  if (opts.expectUpdatedAt !== undefined && !same(opts.expectUpdatedAt, before.updated_at)) throw new SleepConflict("Someone changed this try just now.", "changed", before);
  const start = patch.started_at ? pastTime(patch.started_at, now, "When she was laid down") : new Date(before.started_at);
  if (patch.ended_at && !before.ended_at && patch.outcome === undefined) throw new SleepInputError("Say how it went to end a running try.");
  if (patch.outcome !== undefined && !before.ended_at && !patch.ended_at) throw new SleepInputError("This try is still running: finish it to say how it went.");
  const end = patch.ended_at ? pastTime(patch.ended_at, now, "When the try ended") : before.ended_at ? new Date(before.ended_at) : null;
  if (end && end.getTime() < start.getTime()) throw new SleepInputError("The end is before the start.");
  span(start, end);
  const params: unknown[] = [id, famId(fam), opts.by, before.updated_at, start.toISOString(), end ? end.toISOString() : null];
  const sets = ["started_at = $5", "ended_at = $6", "updated_by = $3", "updated_at = NOW()"];
  if (patch.outcome !== undefined) {
    params.push(asOutcome(patch.outcome));
    sets.push(`outcome = $${params.length}`);
  }
  if (patch.tags !== undefined) {
    params.push(patch.tags);
    sets.push(`tags = $${params.length}::text[]`);
  }
  if (patch.note !== undefined) {
    params.push(patch.note);
    sets.push(`note = $${params.length}`);
  }
  if (patch.put_down_by !== undefined) {
    params.push(patch.put_down_by);
    sets.push(`put_down_by = $${params.length}`);
  }
  const rows = await q(`UPDATE maple_sleep_tries SET ${sets.join(", ")} WHERE id = $1 AND family_id = $2 AND deleted_at IS NULL AND ${updatedAtMatches(4)} RETURNING *`, params);
  if (!rows.length) throw new SleepConflict("Someone changed this try just now.", "changed", (await getTry(fam, id)) ?? before);
  const t = rowToTry(rows[0]);
  const sleepBefore = before.sleep_entry_id ? await getEntry(fam, before.sleep_entry_id) : null;
  let sleep = sleepBefore;
  let sleepMoved = false;
  if (sleepBefore) {
    const move = followSleep(
      { start: Date.parse(before.started_at), end: before.ended_at ? Date.parse(before.ended_at) : null },
      { start: start.getTime(), end: end ? end.getTime() : null },
      { start: Date.parse(sleepBefore.started_at), end: sleepBefore.ended_at ? Date.parse(sleepBefore.ended_at) : null }
    );
    if (move) {
      try {
        sleep = await updateEntry(
          fam,
          sleepBefore.id,
          { ...(move.start !== undefined ? { startedAt: new Date(move.start) } : {}), ...(move.end !== undefined && !sleepBefore.active ? { endedAt: new Date(move.end) } : {}) },
          opts.by,
          { expectUpdatedAt: sleepBefore.updated_at }
        );
        sleepMoved = true;
      } catch {
        sleep = (await getEntry(fam, sleepBefore.id)) ?? null;
      }
    }
  }
  return { try: t, before, sleep, sleepBefore, status: "updated", sleepMoved };
}

/**
 * Delete a try (soft, so Undo brings it back). A sleep the try made goes with
 * it while it's still as the try left it (same start, and still running with
 * a running try, or ending when the try did); a sleep someone else logged, or
 * one changed since, stays.
 */
export async function deleteTry(fam: FamilyRef, id: number, by: string, opts: { expectUpdatedAt?: string } = {}): Promise<{ try: BassinetTry; sleepDeleted: Entry | null }> {
  const cur = await getTry(fam, id);
  if (!cur) throw new NotFound(`Bassinet try ${id} not found`);
  if (opts.expectUpdatedAt !== undefined && !same(opts.expectUpdatedAt, cur.updated_at)) throw new SleepConflict("Someone changed this try just now.", "changed", cur);
  const rows = await q(
    `UPDATE maple_sleep_tries SET deleted_at = NOW(), updated_by = $3, updated_at = NOW() WHERE id = $1 AND family_id = $2 AND deleted_at IS NULL AND ${updatedAtMatches(4)} RETURNING *`,
    [id, famId(fam), by, cur.updated_at]
  );
  if (!rows.length) throw new SleepConflict("Someone changed this try just now.", "changed", (await getTry(fam, id)) ?? cur);
  let sleepDeleted: Entry | null = null;
  if (cur.made_sleep && cur.sleep_entry_id) {
    const s = await getEntry(fam, cur.sleep_entry_id);
    // Picked up still asleep, the sleep goes on in arms and is hers either way: only a sleep that ended with the try (or a running try's) goes.
    const untouched = !!s && sameMs(s.started_at, cur.started_at) && ((cur.ended_at == null && s.active) || (!s.active && sameMs(s.ended_at, cur.ended_at)));
    const others = untouched ? await q(`SELECT 1 FROM maple_sleep_tries WHERE family_id = $1 AND sleep_entry_id = $2 AND id <> $3 AND deleted_at IS NULL LIMIT 1`, [famId(fam), cur.sleep_entry_id, id]) : [];
    if (s && untouched && !others.length) sleepDeleted = await softDeleteEntry(fam, s.id, by);
  }
  return { try: rowToTry(rows[0]), sleepDeleted };
}

/** Bring a deleted try back, and the sleep it made if that went with it. */
export async function restoreTry(fam: FamilyRef, id: number, by: string, opts: { sleepId?: number | null } = {}): Promise<{ try: BassinetTry; sleep: Entry | null }> {
  const cur = await getTry(fam, id, { includeDeleted: true });
  if (!cur || !cur.deleted_at) throw new NotFound(`Bassinet try ${id} not found or not deleted`);
  let rows: Row[];
  try {
    rows = await q(`UPDATE maple_sleep_tries SET deleted_at = NULL, updated_by = $3, updated_at = NOW() WHERE id = $1 AND family_id = $2 AND deleted_at IS NOT NULL RETURNING *`, [id, famId(fam), by]);
  } catch (err) {
    if (isUnique(err, "uniq_maple_sleep_tries_running")) throw new SleepConflict("Another bassinet try is running now, so this one can't come back running. Finish that one first.", "running", cur);
    throw err;
  }
  if (!rows.length) throw new NotFound(`Bassinet try ${id} not found or not deleted`);
  // The sleep it made comes back after it (a running one comes back stopped if another sleep timer runs now: restoreEntry's rule).
  let sleep: Entry | null = null;
  if (opts.sleepId && cur.sleep_entry_id === opts.sleepId && !(await getEntry(fam, opts.sleepId))) sleep = await restoreEntry(fam, opts.sleepId, by).catch(() => null);
  return { try: rowToTry(rows[0]), sleep: sleep ?? (cur.sleep_entry_id ? await getEntry(fam, cur.sleep_entry_id) : null) };
}

// ── holding shifts ───────────────────────────────────────────────────────

export async function getShift(fam: FamilyRef, id: number, opts: { includeDeleted?: boolean } = {}): Promise<(HoldingShift & { deleted_at?: string | null; baby_id: number }) | null> {
  const rows = await q(`SELECT * FROM maple_sleep_shifts WHERE id = $1 AND family_id = $2 ${opts.includeDeleted ? "" : "AND deleted_at IS NULL"}`, [id, famId(fam)]);
  return rows.length ? { ...rowToShift(rows[0]), deleted_at: isoOrNull(rows[0].deleted_at), baby_id: Number(rows[0].baby_id) } : null;
}

export async function openShift(fam: FamilyRef, babyId: number): Promise<HoldingShift | null> {
  const rows = await q(`SELECT * FROM maple_sleep_shifts WHERE family_id = $1 AND baby_id = $2 AND ended_at IS NULL AND deleted_at IS NULL`, [famId(fam), babyId]);
  return rows.length ? rowToShift(rows[0]) : null;
}

export async function listShifts(fam: FamilyRef, babyId: number, opts: { from?: Date; limit?: number } = {}): Promise<HoldingShift[]> {
  const rows = await q(
    `SELECT * FROM maple_sleep_shifts WHERE family_id = $1 AND baby_id = $2 AND deleted_at IS NULL
       AND ($3::timestamptz IS NULL OR COALESCE(ended_at, NOW()) >= $3::timestamptz OR ended_at IS NULL)
     ORDER BY started_at DESC, id DESC LIMIT $4`,
    [famId(fam), babyId, opts.from?.toISOString() ?? null, Math.min(Math.max(opts.limit ?? 100, 1), 500)]
  );
  return rows.map(rowToShift);
}

function handoffTime(handoffAt: Date | null | undefined, start: Date): Date | null {
  if (!handoffAt) return null;
  if (Number.isNaN(handoffAt.getTime())) throw new SleepInputError("The planned handoff isn't a valid time.");
  if (handoffAt.getTime() <= start.getTime()) throw new SleepInputError("The planned handoff has to be after the shift starts.");
  if (handoffAt.getTime() - start.getTime() > HANDOFF_AHEAD_MS) throw new SleepInputError("A planned handoff can be up to 12 hours away.");
  return handoffAt;
}

export type ShiftWrite = { shift: HoldingShift; before: HoldingShift | null; status: "created" | "open" | "deduped" | "updated" | "ended" | "handed_off"; ended?: HoldingShift | null; endedBefore?: HoldingShift | null };

/** Start holding her awake. With a shift already open, that one comes back ("open"): changing who holds her is a handoff. */
export async function startShift(
  fam: FamilyRef,
  input: { babyId: number; holder: string; at?: Date; handoffAt?: Date | null; nextHolder?: string | null; by: string; source: Source; clientId?: string | null; device?: string | null }
): Promise<ShiftWrite> {
  const now = new Date();
  const at = pastTime(input.at, now, "When the shift started", 4 * 3600_000);
  const handoff = handoffTime(input.handoffAt, at);
  const clientId = cleanClientId(input.clientId);
  if (clientId) {
    const prior = await byClient(fam, "maple_sleep_shifts", clientId);
    if (prior) return { shift: rowToShift(prior), before: null, status: "deduped" };
  }
  const open = await openShift(fam, input.babyId);
  if (open) return { shift: open, before: null, status: "open" };
  try {
    const rows = await q(
      `INSERT INTO maple_sleep_shifts (family_id, baby_id, holder, started_at, handoff_at, next_holder, created_by, source, client_id, device)
       SELECT $1::bigint, $2::integer, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9, $10
       WHERE EXISTS (SELECT 1 FROM maple_babies WHERE id = $2::integer AND family_id = $1::bigint)
       RETURNING *`,
      [famId(fam), input.babyId, input.holder, at.toISOString(), handoff?.toISOString() ?? null, input.nextHolder ?? null, input.by, input.source, clientId, input.device ?? null]
    );
    if (!rows.length) throw new NotFound("Baby not found");
    return { shift: rowToShift(rows[0]), before: null, status: "created" };
  } catch (err) {
    if (isUnique(err, "uniq_maple_sleep_shifts_open")) {
      const raced = await openShift(fam, input.babyId);
      if (raced) return { shift: raced, before: null, status: "open" };
    }
    if (isUnique(err, "uniq_maple_sleep_shifts_client") && clientId) {
      const prior = await byClient(fam, "maple_sleep_shifts", clientId);
      if (prior) return { shift: rowToShift(prior), before: null, status: "deduped" };
    }
    throw err;
  }
}

/** End the open shift (if it began by `at`): used when a try starts. */
async function endOpenShift(fam: FamilyRef, babyId: number, at: Date, how: ShiftEnding, by: string): Promise<{ before: HoldingShift; after: HoldingShift } | null> {
  const open = await openShift(fam, babyId);
  if (!open || Date.parse(open.started_at) > at.getTime()) return null;
  const rows = await q(
    `UPDATE maple_sleep_shifts SET ended_at = $3, ended_how = $4, updated_by = $5, updated_at = NOW()
     WHERE id = $1 AND family_id = $2 AND ended_at IS NULL AND deleted_at IS NULL RETURNING *`,
    [open.id, famId(fam), at.toISOString(), how, by]
  );
  return rows.length ? { before: open, after: rowToShift(rows[0]) } : null;
}

/** End a shift now (or at `at`), only the one this phone saw. */
export async function endShift(fam: FamilyRef, id: number, input: { at?: Date; how?: ShiftEnding; by: string; expectUpdatedAt?: string }): Promise<ShiftWrite> {
  const now = new Date();
  const cur = await getShift(fam, id);
  if (!cur) throw new NotFound(`Holding shift ${id} not found`);
  if (cur.ended_at) return { shift: cur, before: cur, status: "ended" };
  if (input.expectUpdatedAt !== undefined && !same(input.expectUpdatedAt, cur.updated_at)) throw new SleepConflict("Someone changed this shift just now.", "changed", cur);
  const at = pastTime(input.at, now, "When the shift ended");
  if (at.getTime() < Date.parse(cur.started_at)) throw new SleepInputError("That's before the shift started.");
  const rows = await q(
    `UPDATE maple_sleep_shifts SET ended_at = $3, ended_how = $4, updated_by = $5, updated_at = NOW()
     WHERE id = $1 AND family_id = $2 AND ended_at IS NULL AND deleted_at IS NULL AND ${updatedAtMatches(6)} RETURNING *`,
    [id, famId(fam), at.toISOString(), input.how ?? "ended", input.by, cur.updated_at]
  );
  if (!rows.length) throw new SleepConflict("Someone changed this shift just now.", "changed", (await getShift(fam, id)) ?? cur);
  return { shift: rowToShift(rows[0]), before: cur, status: "ended" };
}

/**
 * Hand her over: the open shift ends and `to`'s starts at the same moment,
 * one transaction, with the next planned handoff as long as the last one
 * (nextHandoff) unless given, and the person handing over as the one after.
 */
export async function handOff(
  fam: FamilyRef,
  id: number,
  input: { to: string; at?: Date; handoffAt?: Date | null; by: string; source: Source; device?: string | null; expectUpdatedAt?: string }
): Promise<ShiftWrite> {
  const now = new Date();
  const cur = await getShift(fam, id);
  if (!cur) throw new NotFound(`Holding shift ${id} not found`);
  if (cur.ended_at) throw new SleepConflict("That shift already ended.", "changed", cur);
  if (input.expectUpdatedAt !== undefined && !same(input.expectUpdatedAt, cur.updated_at)) throw new SleepConflict("Someone changed this shift just now.", "changed", cur);
  if (input.to === cur.holder) throw new SleepInputError("That's who is holding her now.");
  const at = pastTime(input.at, now, "When the handoff happened", 4 * 3600_000);
  if (at.getTime() < Date.parse(cur.started_at)) throw new SleepInputError("That's before the shift started.");
  const handoff = input.handoffAt === undefined ? new Date(nextHandoff(cur, at.getTime())) : handoffTime(input.handoffAt, at);
  const familyId = famId(fam);
  const [ended, started] = await tx([
    {
      sql: `UPDATE maple_sleep_shifts SET ended_at = $3, ended_how = 'handoff', updated_by = $4, updated_at = NOW()
            WHERE id = $1 AND family_id = $2 AND ended_at IS NULL AND deleted_at IS NULL AND ${updatedAtMatches(5)} RETURNING *`,
      params: [id, familyId, at.toISOString(), input.by, cur.updated_at],
    },
    {
      sql: `INSERT INTO maple_sleep_shifts (family_id, baby_id, holder, started_at, handoff_at, next_holder, created_by, source, device)
            SELECT $1::bigint, s.baby_id, $3, $4::timestamptz, $5::timestamptz, s.holder, $6, $7, $8
            FROM maple_sleep_shifts s WHERE s.id = $2 AND s.family_id = $1::bigint AND s.ended_how = 'handoff' AND s.ended_at = $4::timestamptz AND s.updated_by = $6
              AND NOT EXISTS (SELECT 1 FROM maple_sleep_shifts o WHERE o.family_id = $1::bigint AND o.baby_id = s.baby_id AND o.ended_at IS NULL AND o.deleted_at IS NULL)
            RETURNING *`,
      params: [familyId, id, input.to, at.toISOString(), handoff?.toISOString() ?? null, input.by, input.source, input.device ?? null],
    },
  ]);
  if (!ended.length || !started.length) {
    const now2 = (await getShift(fam, id)) ?? cur;
    throw new SleepConflict("Someone changed this shift just now.", "changed", now2);
  }
  return { shift: rowToShift(started[0]), before: null, status: "handed_off", ended: rowToShift(ended[0]), endedBefore: cur };
}

/** Change the planned handoff (or who's next), only the shift this phone saw. */
export async function updateShift(
  fam: FamilyRef,
  id: number,
  patch: { handoffAt?: Date | null; nextHolder?: string | null; startedAt?: Date },
  opts: { by: string; expectUpdatedAt?: string }
): Promise<ShiftWrite> {
  const now = new Date();
  const cur = await getShift(fam, id);
  if (!cur) throw new NotFound(`Holding shift ${id} not found`);
  if (opts.expectUpdatedAt !== undefined && !same(opts.expectUpdatedAt, cur.updated_at)) throw new SleepConflict("Someone changed this shift just now.", "changed", cur);
  const start = patch.startedAt ? pastTime(patch.startedAt, now, "When the shift started", 12 * 3600_000) : new Date(cur.started_at);
  if (cur.ended_at && start.getTime() > Date.parse(cur.ended_at)) throw new SleepInputError("That's after the shift ended.");
  const handoff = patch.handoffAt === undefined ? (cur.handoff_at ? new Date(cur.handoff_at) : null) : handoffTime(patch.handoffAt, start);
  const rows = await q(
    `UPDATE maple_sleep_shifts SET started_at = $3, handoff_at = $4, next_holder = $5, updated_by = $6, updated_at = NOW()
     WHERE id = $1 AND family_id = $2 AND deleted_at IS NULL AND ${updatedAtMatches(7)} RETURNING *`,
    [id, famId(fam), start.toISOString(), handoff?.toISOString() ?? null, patch.nextHolder === undefined ? cur.next_holder : patch.nextHolder, opts.by, cur.updated_at]
  );
  if (!rows.length) throw new SleepConflict("Someone changed this shift just now.", "changed", (await getShift(fam, id)) ?? cur);
  return { shift: rowToShift(rows[0]), before: cur, status: "updated" };
}

/** Undo a shift's start (soft delete) or bring one back. */
export async function deleteShift(fam: FamilyRef, id: number, by: string, opts: { expectUpdatedAt?: string } = {}): Promise<HoldingShift> {
  const cur = await getShift(fam, id);
  if (!cur) throw new NotFound(`Holding shift ${id} not found`);
  if (opts.expectUpdatedAt !== undefined && !same(opts.expectUpdatedAt, cur.updated_at)) throw new SleepConflict("Someone changed this shift just now.", "changed", cur);
  const rows = await q(`UPDATE maple_sleep_shifts SET deleted_at = NOW(), updated_by = $3, updated_at = NOW() WHERE id = $1 AND family_id = $2 AND deleted_at IS NULL AND ${updatedAtMatches(4)} RETURNING *`, [id, famId(fam), by, cur.updated_at]);
  if (!rows.length) throw new SleepConflict("Someone changed this shift just now.", "changed", (await getShift(fam, id)) ?? cur);
  return rowToShift(rows[0]);
}

export async function restoreShift(fam: FamilyRef, id: number, by: string): Promise<HoldingShift> {
  try {
    const rows = await q(`UPDATE maple_sleep_shifts SET deleted_at = NULL, updated_by = $3, updated_at = NOW() WHERE id = $1 AND family_id = $2 AND deleted_at IS NOT NULL RETURNING *`, [id, famId(fam), by]);
    if (!rows.length) throw new NotFound(`Holding shift ${id} not found or not deleted`);
    return rowToShift(rows[0]);
  } catch (err) {
    if (isUnique(err, "uniq_maple_sleep_shifts_open")) throw new SleepConflict("Someone else is holding her now, so that shift can't come back open.", "open", null);
    throw err;
  }
}

/**
 * Undo a handoff: the new shift goes and the one handed over is open again,
 * each only as this phone saw it; if the second step loses a race, the first
 * is put back, so nothing is left half undone.
 */
export async function undoHandOff(fam: FamilyRef, input: { startedId: number; startedUpdatedAt: string; endedId: number; endedUpdatedAt: string; by: string }): Promise<{ shift: HoldingShift }> {
  await deleteShift(fam, input.startedId, input.by, { expectUpdatedAt: input.startedUpdatedAt });
  try {
    const cur = await getShift(fam, input.endedId);
    if (!cur) throw new NotFound(`Holding shift ${input.endedId} not found`);
    if (!same(input.endedUpdatedAt, cur.updated_at)) throw new SleepConflict("Someone changed that shift just now.", "changed", cur);
    const rows = await q(
      `UPDATE maple_sleep_shifts SET ended_at = NULL, ended_how = NULL, updated_by = $3, updated_at = NOW()
       WHERE id = $1 AND family_id = $2 AND deleted_at IS NULL AND ${updatedAtMatches(4)} RETURNING *`,
      [input.endedId, famId(fam), input.by, cur.updated_at]
    );
    if (!rows.length) throw new SleepConflict("Someone changed that shift just now.", "changed", (await getShift(fam, input.endedId)) ?? cur);
    return { shift: rowToShift(rows[0]) };
  } catch (err) {
    await restoreShift(fam, input.startedId, input.by).catch(() => undefined);
    if (isUnique(err, "uniq_maple_sleep_shifts_open")) throw new SleepConflict("Someone else is holding her now.", "open", null);
    throw err;
  }
}

/** Put an ended shift back open (the Undo of End, or of Into the bassinet), only as this phone saw it. */
export async function reopenShift(fam: FamilyRef, id: number, input: { by: string; expectUpdatedAt: string }): Promise<HoldingShift> {
  const cur = await getShift(fam, id);
  if (!cur) throw new NotFound(`Holding shift ${id} not found`);
  if (!same(input.expectUpdatedAt, cur.updated_at)) throw new SleepConflict("Someone changed this shift just now.", "changed", cur);
  try {
    const rows = await q(
      `UPDATE maple_sleep_shifts SET ended_at = NULL, ended_how = NULL, updated_by = $3, updated_at = NOW()
       WHERE id = $1 AND family_id = $2 AND deleted_at IS NULL AND ${updatedAtMatches(4)} RETURNING *`,
      [id, famId(fam), input.by, cur.updated_at]
    );
    if (!rows.length) throw new SleepConflict("Someone changed this shift just now.", "changed", (await getShift(fam, id)) ?? cur);
    return rowToShift(rows[0]);
  } catch (err) {
    if (isUnique(err, "uniq_maple_sleep_shifts_open")) throw new SleepConflict("Someone else is holding her now.", "open", cur);
    throw err;
  }
}

// ── what the app's state carries ─────────────────────────────────────────

const STATE_TRIES_MS = 8 * 24 * 3600_000;
const STATE_SHIFTS_MS = 2 * 24 * 3600_000;
/** The state carries goals closed this recently, and check-ins for this many nights. */
const STATE_GOALS_CLOSED_DAYS = 60;
const STATE_CHECKIN_NIGHTS = 14;

/**
 * The plan, the last 8 days of tries (and the running one), the last 2 days
 * of shifts (and the open one), the goals, and, only with `checkins` (an
 * owner or member reading: goals.ts seesCheckins), the adults' check-ins for
 * the last 14 nights. Without it there's no `checkins` key at all.
 */
export async function sleepStateFor(fam: FamilyRef, babyId: number, now = new Date(), opts: { checkins?: boolean; tz?: string } = {}): Promise<SleepState> {
  // The last 14 nights by the family's own calendar (a FamilyCtx carries the baby's timezone).
  const tz = opts.tz ?? (typeof fam === "object" && "tz" in fam && typeof fam.tz === "string" ? fam.tz : DEFAULT_TZ);
  const since = addDays(lastNightKey(now, tz), -(STATE_CHECKIN_NIGHTS - 1));
  const [plan, tries, shifts, goals, checkins] = await Promise.all([
    getPlan(fam, babyId),
    listTries(fam, babyId, { from: new Date(now.getTime() - STATE_TRIES_MS), limit: 400 }),
    listShifts(fam, babyId, { from: new Date(now.getTime() - STATE_SHIFTS_MS), limit: 100 }),
    listGoals(fam, babyId, { closedDays: STATE_GOALS_CLOSED_DAYS }),
    opts.checkins ? listCheckins(fam, babyId, { from: since }) : Promise.resolve(null),
  ]);
  return { plan, tries, shifts, goals, ...(checkins ? { checkins } : {}) };
}

/** The progress view over the last `days` try days, from the log (tries plus the sleep entries they sit on). */
export async function progressFor(fam: FamilyRef, babyId: number, tz: string, now: Date, days = 7) {
  const w = progressWindow(now, tz, days);
  const [tries, entries] = await Promise.all([
    listTries(fam, babyId, { from: new Date(w.from.getTime() - MAX_SPAN_MS), to: w.to, limit: 2000 }),
    listEntries(fam, { babyId, kinds: ["sleep"], from: w.from, to: w.to, includeActive: true, limit: 2000 }),
  ]);
  return sleepProgress({ tries, entries, now, tz, days });
}

// ── sleep goals ──────────────────────────────────────────────────────────
//
// Every statement names the family (and a goal's baby), so another family's
// goal reads exactly like one that isn't there. Writes name the revision
// they were made from (a stale one is SleepConflict "changed" with the goal
// as it is); a step, a review or a close without one applies to the goal as
// it is now, retried if another phone wrote in between. Creating a goal, or
// making one active again, holds the family's goal lock so two phones can't
// pass the active cap together.

/** pg_advisory_xact_lock(GOAL_LOCK, family): one goal write at a time per family where a cap is checked. */
const GOAL_LOCK = 72620311;

const asGoalStatus = (v: unknown): GoalStatus => ((GOAL_STATUSES as readonly unknown[]).includes(v) ? (v as GoalStatus) : "active");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const list = <T>(v: unknown, keep: (x: Record<string, unknown>) => boolean): T[] => (Array.isArray(v) ? (v.filter((x) => isObj(x) && keep(x)) as T[]) : []);

export function rowToGoal(r: Row): SleepGoal {
  return {
    id: Number(r.id),
    baby_id: Number(r.baby_id),
    title: String(r.title ?? ""),
    why: textOrNull(r.why),
    target_date: isDayKey(r.target_date) ? r.target_date : null,
    status: asGoalStatus(r.status),
    // A kind this release doesn't know (from a newer one) is read past.
    targets: list<GoalTarget>(r.targets, (x) => typeof x.id === "string" && (TARGET_KINDS as readonly unknown[]).includes(x.kind)),
    steps: list<GoalStep>(r.steps, (x) => typeof x.id === "string" && typeof x.title === "string"),
    roster: list<RosterWindow>(r.roster, (x) => typeof x.id === "string" && typeof x.member === "string" && Array.isArray(x.nights)),
    last_review_at: isoOrNull(r.last_review_at),
    review_note: textOrNull(r.review_note),
    closed_at: isoOrNull(r.closed_at),
    revision: Number(r.revision),
    created_by: textOrNull(r.created_by),
    updated_by: textOrNull(r.updated_by),
    source: asSource(r.source),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

/** The people and day a goal write is checked against (goals.ts cleanGoalInput). */
export type GoalCtx = Pick<GoalRules, "adults" | "name" | "today" | "v" | "ageDays">;

export type GoalWrite = {
  goal: SleepGoal;
  /** The goal before this write (null for a new one), for Undo. */
  before: SleepGoal | null;
  status: "created" | "deduped" | "updated" | "unchanged";
};

async function goalRow(fam: FamilyRef, id: number, opts: { includeDeleted?: boolean } = {}): Promise<{ goal: SleepGoal; seq: number; deleted: boolean } | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const rows = await q(`SELECT * FROM maple_sleep_goals WHERE id = $1 AND family_id = $2 ${opts.includeDeleted ? "" : "AND deleted_at IS NULL"}`, [id, famId(fam)]);
  return rows.length ? { goal: rowToGoal(rows[0]), seq: Number(rows[0].item_seq) || 0, deleted: rows[0].deleted_at != null } : null;
}

export async function getGoal(fam: FamilyRef, id: number): Promise<SleepGoal | null> {
  return (await goalRow(fam, id))?.goal ?? null;
}

/** Open goals (active or paused), with those closed in the last `closedDays` (none by default), newest first. */
export async function listGoals(fam: FamilyRef, babyId: number, opts: { closedDays?: number; limit?: number } = {}): Promise<SleepGoal[]> {
  const rows = await q(
    `SELECT * FROM maple_sleep_goals
     WHERE family_id = $1 AND baby_id = $2 AND deleted_at IS NULL
       AND (status IN ('active', 'paused') OR ($3::int > 0 AND closed_at >= NOW() - $3::int * INTERVAL '1 day'))
     ORDER BY created_at DESC, id DESC LIMIT $4`,
    [famId(fam), babyId, Math.max(0, Math.floor(opts.closedDays ?? 0)), Math.min(Math.max(opts.limit ?? 30, 1), 100)]
  );
  return rows.map(rowToGoal);
}

const goalCapWords = async (fam: FamilyRef, babyId: number) => {
  const [r] = await q(
    `SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS active, COUNT(*) FILTER (WHERE status IN ('active', 'paused'))::int AS open
     FROM maple_sleep_goals WHERE family_id = $1 AND baby_id = $2 AND deleted_at IS NULL`,
    [famId(fam), babyId]
  );
  return Number(r?.active) >= GOALS_ACTIVE_MAX
    ? `There are ${GOALS_ACTIVE_MAX} active sleep goals already, the most at once. Close or pause one first.`
    : `There are ${GOALS_OPEN_MAX} open sleep goals already (paused ones count). Close one first.`;
};

/**
 * A new goal, active. A retried request with its client id gets its first
 * save back ("deduped"), and so does the same person saving a goal with the
 * same title again within two minutes (a model retrying after a timeout).
 */
export async function createGoal(
  fam: FamilyRef,
  input: { babyId: number; goal: GoalInput; ctx: GoalCtx; by: string; source: Source; clientId?: string | null; device?: string | null }
): Promise<GoalWrite> {
  const familyId = famId(fam);
  const clientId = cleanClientId(input.clientId);
  if (clientId) {
    const prior = await q(`SELECT * FROM maple_sleep_goals WHERE family_id = $1 AND client_id = $2`, [familyId, clientId]);
    if (prior.length) return { goal: rowToGoal(prior[0]), before: null, status: "deduped" };
  }
  const { fields, seq } = cleanGoalInput(input.goal, { ...input.ctx, current: null, seq: 0 }, "create");
  const again = await q(
    `SELECT * FROM maple_sleep_goals WHERE family_id = $1 AND baby_id = $2 AND created_by = $3 AND deleted_at IS NULL
       AND created_at >= NOW() - INTERVAL '2 minutes' AND lower(title) = lower($4) ORDER BY id DESC LIMIT 1`,
    [familyId, input.babyId, input.by, fields.title]
  );
  if (again.length) return { goal: rowToGoal(again[0]), before: null, status: "deduped" };
  let rows: Row[];
  try {
    [, rows] = await tx([
      { sql: `SELECT pg_advisory_xact_lock(${GOAL_LOCK}, $1::int)`, params: [familyId] },
      {
        sql: `INSERT INTO maple_sleep_goals (family_id, baby_id, title, why, target_date, targets, steps, roster, item_seq, created_by, source, client_id, device)
              SELECT $1::bigint, $2::integer, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13
              WHERE EXISTS (SELECT 1 FROM maple_babies WHERE id = $2::integer AND family_id = $1::bigint)
                AND (SELECT COUNT(*) FROM maple_sleep_goals WHERE family_id = $1::bigint AND baby_id = $2::integer AND status = 'active' AND deleted_at IS NULL) < ${GOALS_ACTIVE_MAX}
                AND (SELECT COUNT(*) FROM maple_sleep_goals WHERE family_id = $1::bigint AND baby_id = $2::integer AND status IN ('active', 'paused') AND deleted_at IS NULL) < ${GOALS_OPEN_MAX}
              RETURNING *`,
        params: [
          familyId,
          input.babyId,
          fields.title,
          fields.why ?? null,
          fields.target_date ?? null,
          JSON.stringify(fields.targets ?? []),
          JSON.stringify(fields.steps ?? []),
          JSON.stringify(fields.roster ?? []),
          seq,
          input.by,
          input.source,
          clientId,
          input.device ?? null,
        ],
      },
    ]);
  } catch (err) {
    if (isUnique(err, "uniq_maple_sleep_goals_client") && clientId) {
      const prior = await q(`SELECT * FROM maple_sleep_goals WHERE family_id = $1 AND client_id = $2`, [familyId, clientId]);
      if (prior.length) return { goal: rowToGoal(prior[0]), before: null, status: "deduped" };
    }
    throw err;
  }
  if (!rows.length) {
    const baby = await q(`SELECT 1 FROM maple_babies WHERE id = $1 AND family_id = $2`, [input.babyId, familyId]);
    if (!baby.length) throw new NotFound("Baby not found");
    throw new SleepInputError(await goalCapWords(fam, input.babyId));
  }
  return { goal: rowToGoal(rows[0]), before: null, status: "created" };
}

/** What one goal write changes: its fields, and the review and close stamps ("now" or cleared). */
type GoalChange = {
  title?: string;
  why?: string | null;
  target_date?: string | null;
  targets?: GoalTarget[];
  steps?: GoalStep[];
  roster?: RosterWindow[];
  status?: GoalStatus;
  seq?: number;
  review?: { note: string | null };
  closed?: "now" | null;
};

/**
 * Read the goal, work out the change on it as it is, and write it only if
 * it's still at that revision. With `revision`, a goal that moved on is
 * SleepConflict "changed"; without, the change is worked out again on the
 * newer goal (a step, a review or a close means the same either way).
 */
async function mutateGoal(
  fam: FamilyRef,
  id: number,
  opts: { revision?: number; by: string; source: Source },
  change: (cur: SleepGoal, seq: number) => GoalChange | null
): Promise<GoalWrite> {
  const familyId = famId(fam);
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await goalRow(fam, id);
    if (!row) throw new NotFound(`Sleep goal ${id} not found`);
    const cur = row.goal;
    if (opts.revision !== undefined && cur.revision !== opts.revision) throw new SleepConflict("Someone changed this sleep goal just now.", "changed", cur);
    const c = change(cur, row.seq);
    if (!c) return { goal: cur, before: cur, status: "unchanged" };
    const params: unknown[] = [id, familyId, cur.revision, opts.by, opts.source];
    const sets: string[] = [];
    const set = (col: string, v: unknown, cast = "") => {
      params.push(v);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    if (c.title !== undefined) set("title", c.title);
    if (c.why !== undefined) set("why", c.why);
    if (c.target_date !== undefined) set("target_date", c.target_date);
    if (c.targets !== undefined) set("targets", JSON.stringify(c.targets), "::jsonb");
    if (c.steps !== undefined) set("steps", JSON.stringify(c.steps), "::jsonb");
    if (c.roster !== undefined) set("roster", JSON.stringify(c.roster), "::jsonb");
    if (c.seq !== undefined && c.seq !== row.seq) set("item_seq", c.seq);
    if (c.status !== undefined) set("status", c.status);
    if (c.review) {
      sets.push("last_review_at = NOW()");
      set("review_note", c.review.note);
    }
    if (c.closed === "now") sets.push("closed_at = NOW()");
    else if (c.closed === null) sets.push("closed_at = NULL");
    if (!sets.length) return { goal: cur, before: cur, status: "unchanged" };
    // Making a goal active, or opening a closed one, is checked against the caps under the family's goal lock.
    const activates = c.status === "active" && cur.status !== "active";
    const opens = c.status !== undefined && (c.status === "active" || c.status === "paused") && (cur.status === "met" || cur.status === "dropped");
    const caps = [
      activates ? `(SELECT COUNT(*) FROM maple_sleep_goals o WHERE o.family_id = $2 AND o.baby_id = maple_sleep_goals.baby_id AND o.status = 'active' AND o.deleted_at IS NULL AND o.id <> $1) < ${GOALS_ACTIVE_MAX}` : "",
      opens ? `(SELECT COUNT(*) FROM maple_sleep_goals o WHERE o.family_id = $2 AND o.baby_id = maple_sleep_goals.baby_id AND o.status IN ('active', 'paused') AND o.deleted_at IS NULL AND o.id <> $1) < ${GOALS_OPEN_MAX}` : "",
    ].filter(Boolean);
    const update = `UPDATE maple_sleep_goals SET ${sets.join(", ")}, revision = revision + 1, updated_by = $4, source = $5, updated_at = NOW()
       WHERE id = $1 AND family_id = $2 AND deleted_at IS NULL AND revision = $3${caps.map((x) => ` AND ${x}`).join("")} RETURNING *`;
    const rows = caps.length ? (await tx([{ sql: `SELECT pg_advisory_xact_lock(${GOAL_LOCK}, $1::int)`, params: [familyId] }, { sql: update, params }]))[1] : await q(update, params);
    if (rows.length) return { goal: rowToGoal(rows[0]), before: cur, status: "updated" };
    const now = await goalRow(fam, id);
    if (!now) throw new NotFound(`Sleep goal ${id} not found`);
    // Still at the revision it read: the cap turned it away, not another phone.
    if (now.goal.revision === cur.revision && caps.length) throw new SleepInputError(await goalCapWords(fam, cur.baby_id));
    if (opts.revision !== undefined) throw new SleepConflict("Someone changed this sleep goal just now.", "changed", now.goal);
  }
  throw new SleepConflict("Someone changed this sleep goal just now.", "changed", await getGoal(fam, id));
}

/**
 * Change a goal (title, why, target date, targets, steps, roster, active or
 * paused), only if it's still at `revision`. A list replaces the whole list;
 * items that name an existing id keep it. Moving back from met or dropped
 * opens it again.
 */
export async function updateGoal(fam: FamilyRef, id: number, input: { patch: GoalInput; revision: number; ctx: GoalCtx; by: string; source: Source }): Promise<GoalWrite> {
  return mutateGoal(fam, id, { revision: input.revision, by: input.by, source: input.source }, (cur, seq) => {
    const { fields, seq: nextSeq } = cleanGoalInput(input.patch, { ...input.ctx, current: cur, seq }, "update");
    if (!Object.keys(fields).length) return null;
    const reopening = fields.status !== undefined && (cur.status === "met" || cur.status === "dropped");
    return { ...fields, seq: nextSeq, ...(reopening ? { closed: null } : {}) };
  });
}

/** Mark a step done (by `by`, now) or not done. Already that way: "unchanged". */
export async function setGoalStep(fam: FamilyRef, id: number, input: { step: string; done: boolean; by: string; source: Source; revision?: number }): Promise<GoalWrite> {
  return mutateGoal(fam, id, input, (cur) => {
    const s = cur.steps.find((x) => x.id === input.step);
    if (!s) throw new SleepInputError(`This goal has no step ${input.step}. Its steps are ${cur.steps.map((x) => x.id).join(", ") || "none yet"}.`);
    if (!!s.done_at === input.done) return null;
    const now = new Date().toISOString();
    return { steps: cur.steps.map((x) => (x.id === input.step ? { ...x, done_at: input.done ? now : null, done_by: input.done ? input.by : null } : x)) };
  });
}

/** A review: stamps last_review_at now, with the short note (or none). */
export async function reviewGoal(fam: FamilyRef, id: number, input: { note: unknown; by: string; source: Source; revision?: number }): Promise<GoalWrite> {
  const note = cleanGoalNote(input.note, GOAL_NOTE_MAX);
  return mutateGoal(fam, id, input, () => ({ review: { note } }));
}

/** Close a goal as met or dropped; a note given is its last review. Closed already the same way: "unchanged". */
export async function closeGoal(fam: FamilyRef, id: number, input: { status: "met" | "dropped"; note?: unknown; by: string; source: Source; revision?: number }): Promise<GoalWrite> {
  if (input.status !== "met" && input.status !== "dropped") throw new SleepInputError("A goal closes as met or dropped.");
  const note = input.note === undefined ? undefined : cleanGoalNote(input.note, GOAL_NOTE_MAX);
  return mutateGoal(fam, id, input, (cur) => {
    if (cur.status === input.status) return null;
    return { status: input.status, closed: "now", ...(note !== undefined && note !== null ? { review: { note } } : {}) };
  });
}

/** Soft-delete a goal (nothing in the app or the tools offers it yet; a family's log deletion removes them for good). */
export async function deleteGoal(fam: FamilyRef, id: number, by: string): Promise<SleepGoal> {
  const rows = await q(`UPDATE maple_sleep_goals SET deleted_at = NOW(), updated_by = $3, updated_at = NOW() WHERE id = $1 AND family_id = $2 AND deleted_at IS NULL RETURNING *`, [id, famId(fam), by]);
  if (!rows.length) throw new NotFound(`Sleep goal ${id} not found`);
  return rowToGoal(rows[0]);
}

// ── check-ins ────────────────────────────────────────────────────────────

const asAnswer = (v: unknown): ProtectedAnswer => ((PROTECTED_ANSWERS as readonly unknown[]).includes(v) ? (v as ProtectedAnswer) : "no");

export function rowToCheckin(r: Row): SleepCheckin {
  return {
    id: Number(r.id),
    member: String(r.member),
    night: String(r.night),
    protected: asAnswer(r.protected),
    note: textOrNull(r.note),
    ...checkinExtrasOf(r),
    source: asSource(r.source),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

/** A row's extra answers (sleep/schema.ts migrateCheckinExtras), only those given; a value this release doesn't know reads as none. */
function checkinExtrasOf(r: Row): Pick<SleepCheckin, "place" | "untimed_try" | "untimed_min" | "handoff"> {
  const one = <T extends string>(v: unknown, list: readonly T[]): T | null => ((list as readonly unknown[]).includes(v) ? (v as T) : null);
  const place = one(r.place, CHECKIN_PLACES);
  const untimed = one(r.untimed_try, UNTIMED_TRIES);
  const handoff = one(r.handoff, HANDOFF_ANSWERS);
  return {
    ...(place ? { place } : {}),
    ...(untimed ? { untimed_try: untimed, untimed_min: r.untimed_min == null ? null : Number(r.untimed_min) } : {}),
    ...(handoff ? { handoff } : {}),
  };
}

/** Check-ins for nights in [from, to] (YYYY-MM-DD), newest night first; one adult's with `member`. */
export async function listCheckins(fam: FamilyRef, babyId: number, opts: { from: string; to?: string; member?: string }): Promise<SleepCheckin[]> {
  const rows = await q(
    `SELECT * FROM maple_sleep_checkins
     WHERE family_id = $1 AND baby_id = $2 AND deleted_at IS NULL AND night >= $3 AND ($4::text IS NULL OR night <= $4::text) AND ($5::text IS NULL OR member = $5::text)
     ORDER BY night DESC, member, id DESC LIMIT 1000`,
    [famId(fam), babyId, opts.from, opts.to ?? null, opts.member ?? null]
  );
  return rows.map(rowToCheckin);
}

export type CheckinWrite = { checkin: SleepCheckin; before: SleepCheckin | null; status: "created" | "updated" | "unchanged" | "deduped" };

/**
 * An adult's check-in for one night, saved for themselves only (`member` is
 * the signed-in adult; the callers never take it from the request). One per
 * adult per night: saving again changes that one. A retried request with its
 * client id gets its first save back. `note` undefined keeps the one there;
 * null clears it.
 */
export async function saveCheckin(
  fam: FamilyRef,
  input: { babyId: number; member: string; night?: unknown; protected: unknown; note?: unknown; extras?: unknown; tz: string; now?: Date; source: Source; clientId?: string | null; device?: string | null }
): Promise<CheckinWrite> {
  const familyId = famId(fam);
  const night = cleanCheckinNight(input.night, input.now ?? new Date(), input.tz);
  const answer = cleanProtected(input.protected);
  const keep = input.note === undefined;
  const note = keep ? null : cleanGoalNote(input.note, CHECKIN_NOTE_MAX);
  const extras = extrasWrite(cleanCheckinExtras(input.extras));
  const clientId = cleanClientId(input.clientId);
  if (clientId) {
    const prior = await q(`SELECT * FROM maple_sleep_checkins WHERE family_id = $1 AND client_id = $2`, [familyId, clientId]);
    if (prior.length) return { checkin: rowToCheckin(prior[0]), before: null, status: "deduped" };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const found = await q(`SELECT * FROM maple_sleep_checkins WHERE family_id = $1 AND baby_id = $2 AND member = $3 AND night = $4 AND deleted_at IS NULL`, [familyId, input.babyId, input.member, night]);
    const before = found.length ? rowToCheckin(found[0]) : null;
    if (before) {
      if (before.protected === answer && (keep || note === before.note) && extras.same(before)) return { checkin: before, before, status: "unchanged" };
      const rows = await q(
        `UPDATE maple_sleep_checkins SET protected = $4, note = CASE WHEN $5::boolean THEN note ELSE $6 END, source = $7, device = $8, ${extras.sets(9)}, updated_at = NOW()
         WHERE id = $1 AND family_id = $2 AND member = $3 AND deleted_at IS NULL RETURNING *`,
        [before.id, familyId, input.member, answer, keep, note, input.source, input.device ?? null, ...extras.params]
      );
      if (rows.length) return { checkin: rowToCheckin(rows[0]), before, status: "updated" };
      continue;
    }
    try {
      const rows = await q(
        `INSERT INTO maple_sleep_checkins (family_id, baby_id, member, night, protected, note, source, client_id, device, place, untimed_try, untimed_min, handoff)
         SELECT $1::bigint, $2::integer, $3, $4, $5, $6, $7, $8, $9, $10::text, $11::text, $12::smallint, $13::text
         WHERE EXISTS (SELECT 1 FROM maple_babies WHERE id = $2::integer AND family_id = $1::bigint)
         RETURNING *`,
        [familyId, input.babyId, input.member, night, answer, note, input.source, clientId, input.device ?? null, ...extras.values]
      );
      if (!rows.length) throw new NotFound("Baby not found");
      return { checkin: rowToCheckin(rows[0]), before: null, status: "created" };
    } catch (err) {
      // Their other phone saved this night at the same moment: change that one instead.
      if (isUnique(err, "uniq_maple_sleep_checkins_night")) continue;
      if (isUnique(err, "uniq_maple_sleep_checkins_client") && clientId) {
        const prior = await q(`SELECT * FROM maple_sleep_checkins WHERE family_id = $1 AND client_id = $2`, [familyId, clientId]);
        if (prior.length) return { checkin: rowToCheckin(prior[0]), before: null, status: "deduped" };
      }
      throw err;
    }
  }
  throw new Error("Couldn't save the check-in, please try again");
}

const EXTRA_COLUMNS = [
  { key: "place", cast: "text" },
  { key: "untimed_try", cast: "text" },
  { key: "untimed_min", cast: "smallint" },
  { key: "handoff", cast: "text" },
] as const;

/** How a check-in write's extra answers apply: each one given is set (null clears it); the rest stay as they are. */
function extrasWrite(x: CheckinExtras) {
  const given = EXTRA_COLUMNS.map((c) => x[c.key] !== undefined);
  const values = EXTRA_COLUMNS.map((c) => x[c.key] ?? null);
  return {
    /** Already so on `before`: nothing to change. */
    same: (before: SleepCheckin) => EXTRA_COLUMNS.every((c, i) => !given[i] || (before[c.key] ?? null) === values[i]),
    /** The SET clauses, numbering their parameters from `from` (a given flag, then its value, for each column). */
    sets: (from: number) => EXTRA_COLUMNS.map((c, i) => `${c.key} = CASE WHEN $${from + 2 * i}::boolean THEN $${from + 2 * i + 1}::${c.cast} ELSE ${c.key} END`).join(", "),
    params: EXTRA_COLUMNS.flatMap((_, i) => [given[i], values[i]]),
    /** For a new check-in: the values, null for those not given. */
    values,
  };
}

/** Delete your own check-in (soft), by its id or its night. Someone else's reads as missing. */
export async function deleteCheckin(fam: FamilyRef, input: { babyId: number; member: string; id?: number | null; night?: string | null }): Promise<SleepCheckin> {
  if (input.id == null && !isDayKey(input.night)) throw new SleepInputError("Say which check-in: its id or its night.");
  const rows = await q(
    `UPDATE maple_sleep_checkins SET deleted_at = NOW(), updated_at = NOW()
     WHERE family_id = $1 AND baby_id = $2 AND member = $3 AND deleted_at IS NULL AND (($4::bigint IS NOT NULL AND id = $4::bigint) OR ($4::bigint IS NULL AND night = $5::text))
     RETURNING *`,
    [famId(fam), input.babyId, input.member, input.id ?? null, input.night ?? null]
  );
  if (!rows.length) throw new NotFound("Check-in not found");
  return rowToCheckin(rows[0]);
}

// ── a goal's progress, from the log ──────────────────────────────────────

/**
 * Each goal's progress (goals.ts goalProgress) from one read of the log over
 * all of their shown nights: tries, the sleeps they sit on, feeds and holding
 * turns for the roster hints, and check-ins only with `checkins` (an owner or
 * member reading); without, every check-in count comes back null.
 */
export async function goalProgressFor(fam: FamilyRef, babyId: number, goals: readonly SleepGoal[], opts: { tz: string; now: Date; checkins: boolean }): Promise<Map<number, GoalProgress>> {
  const out = new Map<number, GoalProgress>();
  if (!goals.length) return out;
  const { tz, now } = opts;
  const spans = goals.map((g) => goalSpan(g, now, tz));
  const first = spans.map((s) => s.weeks[0]?.from ?? s.startsOn).sort()[0];
  const last = spans.map((s) => s.lastNight).sort().slice(-1)[0];
  const from = tryDayBounds(first, tz)[0];
  const to = new Date(Math.min(tryDayBounds(last > first ? last : first, tz)[1].getTime(), now.getTime() + 1));
  // Last night's check-ins too, for each adult's latest answer, even before a goal set this morning.
  const lastNight = lastNightKey(now, tz);
  // Entries of every kind and the holding turns over the shown nights: what was logged each night (coverage), the stretches and the roster's hints.
  const since = new Date(from.getTime() - MAX_SPAN_MS);
  const [tries, entries, shifts, checkins] = await Promise.all([
    listTries(fam, babyId, { from: since, to, limit: 2000 }),
    listEntries(fam, { babyId, from: since, to, includeActive: true, limit: 5000 }),
    listShifts(fam, babyId, { from: since, limit: 500 }),
    opts.checkins ? listCheckins(fam, babyId, { from: first < lastNight ? first : lastNight, to: last > lastNight ? last : lastNight }) : Promise.resolve(null),
  ]);
  for (const g of goals) out.set(g.id, goalProgress(g, { tries, entries, shifts, checkins }, now, tz));
  return out;
}
