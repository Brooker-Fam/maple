/**
 * Server-side storage for mom's area (maple_care_* tables): random 8-digit
 * ids, duplicate lookup, the per-member state and rev, share pruning and the
 * move out of Maple's log, plus the writes the routes, Siri and the MCP tools
 * share (logCareDose, saveCarePlan, …), so every channel applies the same
 * checks.
 *
 * Every read is filtered by the reader's CareAccess (careAccess() in
 * care.ts): Only me rows (a private plan, its doses, a private one-off or
 * question) and mood rows never leave for anyone but her, and an id they
 * can't read answers NotFound, so a private row and a missing one look the
 * same.
 */
import { createHash, randomInt } from "node:crypto";
import { query } from "@/lib/db";
import { assessMomTemp, type Assessment } from "./guidelines";
import {
  careAccess,
  doseFlags,
  doseNotes,
  forMom,
  normName,
  oneOffNotes,
  planActive,
  planNotes,
  planNames,
  planStatus,
  planView,
  parseUnits,
  sortPlans,
  recentDose,
  RECENT_MS,
  startsPrivate,
  unitsKnown,
  type CareChannel,
  type CareNote,
  type CareViewer,
  type PlanView,
} from "./care";
import { adminActsAs, isVitaminD, memberName } from "./insights";
import { NotFound, StoreUnavailable, getBaby } from "./store";
import { DEFAULT_TZ, dayBounds } from "./time";
import { cleanCareData, cleanCareNote, cleanCareSettings, cleanMoodData, cleanPlan, cleanSharedWith, cleanUnits, type PlanFields } from "./validate";
import { scoreScreen } from "./care";
import type {
  Baby,
  CareAccess,
  CareDataByKind,
  CareEntry,
  CareKind,
  CarePerson,
  CarePlan,
  CareSettings,
  CareState,
  DoseEntry,
  DoseResult,
  LimitUnit,
  Member,
  MoodDataByKind,
  MoodEntry,
  MoodKind,
  PlanInput,
  PlanStatus,
  Source,
} from "./types";

type Row = Record<string, unknown>;

async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const rows = await query(sql, params);
  if (rows === null) throw new StoreUnavailable();
  return rows as Row[];
}

const isoOrNull = (v: unknown): string | null => (v == null ? null : new Date(v as string | Date).toISOString());
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

/** A write someone else beat (an edit made against an older version). Carries the current row. */
export class CareConflict extends Error {
  constructor(message: string, readonly current: { plan?: CarePlan; entry?: CareEntry }, readonly reason: "changed" | "exists" = "changed") {
    super(message);
  }
}

/** The caller can read this but not write it (403 with a readable message). */
export class CareForbidden extends Error {}

// ── rows ──────────────────────────────────────────────────────────────

// DATE columns come back as text so no runtime timezone can shift them a day.
const PLAN_COLS = `m.*, to_char(m.course_start, 'YYYY-MM-DD') AS course_start_text, to_char(m.course_end, 'YYYY-MM-DD') AS course_end_text`;

export function rowToPlan(r: Row): CarePlan {
  return {
    id: Number(r.id),
    name: String(r.name),
    also_called: strOrNull(r.also_called),
    dose_text: strOrNull(r.dose_text),
    schedule: (r.schedule ?? { type: "as_needed" }) as CarePlan["schedule"],
    max_24h: r.max_24h == null ? null : Number(r.max_24h),
    limit_unit: (r.limit_unit ?? null) as LimitUnit | null,
    units_per_dose: strOrNull(r.units_per_dose),
    label_text: strOrNull(r.label_text),
    reason: (r.reason ?? null) as CarePlan["reason"],
    contains_apap: Boolean(r.contains_apap),
    instructions: strOrNull(r.instructions),
    course_start: strOrNull(r.course_start_text),
    course_end: strOrNull(r.course_end_text),
    show_on_today: Boolean(r.show_on_today),
    private: Boolean(r.private),
    stopped_at: isoOrNull(r.stopped_at),
    reviewed_at: isoOrNull(r.reviewed_at),
    reviewed_by: strOrNull(r.reviewed_by),
    sort: Number(r.sort ?? 0),
    created_by: strOrNull(r.created_by),
    updated_by: strOrNull(r.updated_by),
    source: (r.source ?? "web") as Source,
    created_at: isoOrNull(r.created_at)!,
    updated_at: isoOrNull(r.updated_at)!,
  };
}

export function rowToCareEntry(r: Row): CareEntry {
  return {
    id: Number(r.id),
    kind: String(r.kind) as CareKind,
    med_id: r.med_id == null ? null : Number(r.med_id),
    at: isoOrNull(r.at)!,
    data: (r.data ?? {}) as never,
    note: strOrNull(r.note),
    private: Boolean(r.private),
    created_by: strOrNull(r.created_by),
    updated_by: strOrNull(r.updated_by),
    source: (r.source ?? "web") as Source,
    created_at: isoOrNull(r.created_at)!,
    updated_at: isoOrNull(r.updated_at)!,
  } as CareEntry;
}

function rowToMood(r: Row): MoodEntry {
  return {
    id: Number(r.id),
    kind: String(r.kind) as MoodKind,
    at: isoOrNull(r.at)!,
    data: (r.data ?? {}) as never,
    note: strOrNull(r.note),
    created_at: isoOrNull(r.created_at)!,
    updated_at: isoOrNull(r.updated_at)!,
  } as MoodEntry;
}

function rowToPerson(r: Row): CarePerson {
  return {
    member: String(r.member),
    shared_with: Array.isArray(r.shared_with) ? (r.shared_with as unknown[]).map(String) : [],
    settings: (r.settings ?? {}) as CareSettings,
    created_by: strOrNull(r.created_by),
    created_at: isoOrNull(r.created_at)!,
    updated_at: isoOrNull(r.updated_at)!,
  };
}

/**
 * Who can read a care entry row: not private, and not a dose of a private
 * plan (a dose follows its plan), unless the reader can see Only me. `e` and
 * `m` are the entries and meds aliases; `$n` is a boolean param.
 */
const visibleSql = (n: number) => `($${n}::boolean OR (NOT e.private AND NOT COALESCE(m.private, FALSE)))`;

// ── random ids (§12.1) ────────────────────────────────────────────────

const newId = () => randomInt(10_000_000, 100_000_000);

/**
 * INSERT … ON CONFLICT DO NOTHING with a random id. No row back means the
 * client_id was already saved (deduped) or the id was taken (retry with a
 * new one, up to 5 times).
 */
async function insertRandom(
  table: "maple_care_meds" | "maple_care_entries",
  build: (id: number) => { sql: string; params: unknown[] },
  clientId: string | null,
  by: string
): Promise<{ row: Row; deduped: boolean }> {
  for (let i = 0; i < 5; i++) {
    const { sql, params } = build(newId());
    const rows = await q(sql, params);
    if (rows.length) return { row: rows[0], deduped: false };
    if (clientId) {
      const prior = await q(`SELECT * FROM ${table} WHERE client_id = $1`, [clientId]);
      // A retry is the same member's own write; anyone else's id (a private row included) is just not found.
      if (prior.length) {
        if (prior[0].created_by !== by) throw new NotFound("Not found");
        return { row: prior[0], deduped: true };
      }
    }
  }
  throw new Error("id_exhausted");
}

const CLIENT_ID_RE = /^[A-Za-z0-9:_.@-]{8,120}$/;
const cleanClientId = (raw: unknown): string | null => (typeof raw === "string" && CLIENT_ID_RE.test(raw) ? raw : null);

// ── the person ────────────────────────────────────────────────────────

/** The one care person on this log, or null before setup. */
export async function getCarePerson(): Promise<CarePerson | null> {
  const rows = await q(`SELECT * FROM maple_care_people LIMIT 1`);
  return rows.length ? rowToPerson(rows[0]) : null;
}

/** Eligible to be the care person, or to be shared with: a current owner or member, never "admin". */
export const eligible = (m: Member | undefined): m is Member => !!m && m.email !== "admin" && m.role !== "viewer";

/** Every other current owner (not admin, not her): who sees her medicines to start. */
export function defaultShares(member: string, members: Member[]): string[] {
  return members.filter((m) => m.role === "owner" && eligible(m) && m.email !== member).map((m) => m.email);
}

/** Create the area for `member` (one per log: a second answers CareConflict "exists"). */
export async function createCarePerson(member: string, createdBy: string, members: Member[]): Promise<CarePerson> {
  const rows = await q(
    `INSERT INTO maple_care_people (member, shared_with, created_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT DO NOTHING RETURNING *`,
    [member, JSON.stringify(defaultShares(member, members)), createdBy]
  );
  if (!rows.length) throw new CareConflict("There's already a page for mom in Maple's Log.", {}, "exists");
  return rowToPerson(rows[0]);
}

/**
 * Update who she shares with and merge settings in SQL (two phones saving
 * different things both stick). Nulls remove a key; care_team merges one
 * level down; acks add to what's stored.
 */
export async function patchCarePerson(member: string, patch: { shared_with?: string[]; settings?: Record<string, unknown>; acks?: Record<string, string> | null }): Promise<CarePerson> {
  const params: unknown[] = [member];
  const sets: string[] = [];
  if (patch.shared_with) {
    params.push(JSON.stringify(patch.shared_with));
    sets.push(`shared_with = $${params.length}::jsonb`);
  }
  if (patch.settings || patch.acks) {
    const { care_team, ...rest } = patch.settings ?? {};
    params.push(JSON.stringify(rest));
    let expr = `settings || $${params.length}::jsonb`;
    if (care_team !== undefined) {
      params.push(JSON.stringify(care_team));
      expr = `(${expr}) || jsonb_build_object('care_team', CASE WHEN $${params.length}::jsonb = 'null'::jsonb THEN 'null'::jsonb
        ELSE COALESCE(settings->'care_team', '{}'::jsonb) || $${params.length}::jsonb END)`;
    }
    if (patch.acks) {
      params.push(JSON.stringify(patch.acks));
      expr = `jsonb_set(${expr}, '{acks}', COALESCE(settings->'acks', '{}'::jsonb) || $${params.length}::jsonb)`;
    }
    sets.push(`settings = jsonb_strip_nulls(${expr})`);
  }
  const rows = await q(`UPDATE maple_care_people SET ${[...sets, "updated_at = NOW()"].join(", ")} WHERE member = $1 RETURNING *`, params);
  if (!rows.length) throw new NotFound("Not found");
  return rowToPerson(rows[0]);
}

/** Everything about her, for good (the tables cascade). */
export async function deleteCarePerson(member: string): Promise<void> {
  await q(`DELETE FROM maple_care_people WHERE member = $1`, [member]);
}

/** Plans, entries and check-ins ever saved (deleted ones too): the creator may delete only an empty area. */
export async function careRowCount(member: string): Promise<number> {
  const rows = await q(
    `SELECT (SELECT COUNT(*) FROM maple_care_meds WHERE person = $1) + (SELECT COUNT(*) FROM maple_care_entries WHERE person = $1)
          + (SELECT COUNT(*) FROM maple_care_mood WHERE person = $1) AS n`,
    [member]
  );
  return Number(rows[0]?.n ?? 0);
}

// ── who's asking ──────────────────────────────────────────────────────

/** Her name as the app shows it ("Brittany"), never hard-coded. */
export const carePersonName = (person: CarePerson, members: Member[]) => memberName(person.member, members);

/**
 * The care viewer for a member signed in to the app: the admin login reads
 * as the member an owner picked (admin_as, viaAdmin), else as nobody.
 */
export function viewerFor(member: Member, baby: Baby, members: Member[], channel: CareChannel = "app"): CareViewer {
  if (member.email === "admin") {
    const as = adminActsAs(baby, members);
    return { id: as?.email ?? "admin", role: as?.role ?? "owner", viaAdmin: true, channel };
  }
  return { id: member.email, role: member.role, viaAdmin: false, channel };
}

/** Everything a care read or write needs, resolved once per request. */
export type CareSession = {
  viewer: CareViewer;
  person: CarePerson | null;
  access: CareAccess;
  members: Member[];
  baby: Baby;
  tz: string;
  /** memberName(person), or "mom" when there's no person or no access. */
  name: string;
  now: Date;
};

/** Resolve the person and the viewer's access (roles read fresh: a demoted member loses access at once). */
export async function careSession(viewer: CareViewer, ctx: { members: Member[]; baby?: Baby; person?: CarePerson | null }): Promise<CareSession> {
  const [baby, person] = await Promise.all([ctx.baby ?? getBaby(), ctx.person !== undefined ? ctx.person : getCarePerson()]);
  const access = careAccess(viewer, person, ctx.members);
  return {
    viewer,
    person,
    access,
    members: ctx.members,
    baby,
    tz: baby.timezone || DEFAULT_TZ,
    name: person && access.read ? carePersonName(person, ctx.members) : "mom",
    now: new Date(),
  };
}

/** The session's person, or NotFound (no area, or nothing here the viewer can read: the same answer). */
function personOf(s: CareSession): CarePerson {
  if (!s.person || !s.access.read) throw new NotFound("Not found");
  return s.person;
}

function needWrite(s: CareSession): CarePerson {
  const p = personOf(s);
  if (!s.access.write) throw new CareForbidden(`${s.name}'s medicines aren't shared with you.`);
  return p;
}

const noteCtx = (s: CareSession) => ({ name: s.name, self: s.access.self, settings: s.person?.settings ?? {} });

// ── plans ─────────────────────────────────────────────────────────────

/** Her plans that aren't deleted, private ones included (filter by access before showing them). */
export async function listCarePlans(person: string): Promise<CarePlan[]> {
  const rows = await q(`SELECT ${PLAN_COLS} FROM maple_care_meds m WHERE m.person = $1 AND m.deleted_at IS NULL ORDER BY m.sort, m.id`, [person]);
  return rows.map(rowToPlan);
}

/** The plans this session may see (Only me ones only for her). */
export async function visiblePlans(s: CareSession): Promise<CarePlan[]> {
  const p = personOf(s);
  return (await listCarePlans(p.member)).filter((x) => s.access.private || !x.private);
}

async function planRow(id: number, opts: { includeDeleted?: boolean } = {}): Promise<{ plan: CarePlan; person: string; deleted: boolean } | null> {
  const rows = await q(`SELECT ${PLAN_COLS} FROM maple_care_meds m WHERE m.id = $1 ${opts.includeDeleted ? "" : "AND m.deleted_at IS NULL"}`, [id]);
  if (!rows.length) return null;
  return { plan: rowToPlan(rows[0]), person: String(rows[0].person), deleted: rows[0].deleted_at != null };
}

/** A plan this session can read, else NotFound (private, deleted and missing look the same). */
export async function readablePlan(s: CareSession, id: number, opts: { includeDeleted?: boolean } = {}): Promise<CarePlan> {
  const p = personOf(s);
  const r = await planRow(id, opts);
  if (!r || r.person !== p.member || (r.plan.private && !s.access.private)) throw new NotFound("Not found");
  return r.plan;
}

const PLAN_WRITE_COLS = [
  "name",
  "also_called",
  "dose_text",
  "units_per_dose",
  "schedule",
  "max_24h",
  "limit_unit",
  "label_text",
  "reason",
  "contains_apap",
  "instructions",
  "course_start",
  "course_end",
  "show_on_today",
  "private",
  "sort",
] as const;

const planParam = (f: PlanFields, k: (typeof PLAN_WRITE_COLS)[number]) => (k === "schedule" ? JSON.stringify(f.schedule) : f[k]);
const planCast = (k: (typeof PLAN_WRITE_COLS)[number]) => (k === "schedule" ? "::jsonb" : k === "course_start" || k === "course_end" ? "::date" : "");

export type SavedPlan = { plan: CarePlan; deduped: boolean; notes: CareNote[]; madePrivate: boolean };

/**
 * Add a plan, or change one (`input.id`). Only her own session sets Only me;
 * a mood medicine she adds (from any channel) starts as Only me. Plans an
 * assistant adds or changes show "Check this against the label" until
 * someone confirms them (reviewed_at is cleared).
 */
export async function saveCarePlan(
  s: CareSession,
  input: PlanInput & { client_id?: string },
  opts: { source: Source; expectUpdatedAt?: string }
): Promise<SavedPlan> {
  const p = needWrite(s);
  const raw = input as unknown as Record<string, unknown>;
  if (raw.private === true && !s.access.private) throw new CareForbidden(`Only ${s.name} can mark a medicine Only me.`);
  const by = s.viewer.id;
  const assistant = opts.source === "claude" || opts.source === "chatgpt" || opts.source === "mcp";

  if (input.id != null) {
    const cur = await readablePlan(s, input.id);
    if (cur.private && !s.access.private) throw new NotFound("Not found");
    // A patch over what's stored, then the whole plan validated again.
    const merged: Record<string, unknown> = { ...cur, ...stripUndefined(raw) };
    if (!s.access.private) merged.private = cur.private;
    const fields = cleanPlan(merged, { creating: false, parseUnits });
    if (opts.expectUpdatedAt && Date.parse(cur.updated_at) > Date.parse(opts.expectUpdatedAt)) {
      throw new CareConflict(`${memberName(cur.updated_by ?? cur.created_by, s.members)} changed this plan a moment ago. Here's the latest.`, { plan: cur });
    }
    const params: unknown[] = [input.id, p.member, by];
    const sets = PLAN_WRITE_COLS.map((k) => {
      params.push(planParam(fields, k));
      return `${k} = $${params.length}${planCast(k)}`;
    });
    let expect = "";
    if (opts.expectUpdatedAt) {
      params.push(opts.expectUpdatedAt);
      expect = ` AND date_trunc('milliseconds', m.updated_at) <= $${params.length}::timestamptz`;
    }
    let reviewed = "";
    if (assistant) {
      params.push(opts.source);
      reviewed = `, reviewed_at = NULL, reviewed_by = NULL, source = $${params.length}`;
    }
    const rows = await q(
      `UPDATE maple_care_meds m SET ${sets.join(", ")}, updated_by = $3, updated_at = NOW()${reviewed}
       WHERE m.id = $1 AND m.person = $2 AND m.deleted_at IS NULL${expect} RETURNING ${PLAN_COLS}`,
      params
    );
    if (!rows.length) {
      const now = await readablePlan(s, input.id);
      throw new CareConflict(`${memberName(now.updated_by ?? now.created_by, s.members)} changed this plan a moment ago. Here's the latest.`, { plan: now });
    }
    const plan = rowToPlan(rows[0]);
    return { plan, deduped: false, notes: await notesOnSave(s, plan), madePrivate: false };
  }

  const fields = cleanPlan(raw, { creating: true, parseUnits });
  let madePrivate = false;
  if (raw.private === undefined && startsPrivate(fields, s.access.self)) {
    fields.private = true;
    madePrivate = true;
    if (raw.show_on_today === undefined) fields.show_on_today = false;
  }
  const clientId = cleanClientId(input.client_id);
  const { row, deduped } = await insertRandom(
    "maple_care_meds",
    (id) => {
      const params: unknown[] = [id, p.member, by, opts.source, clientId];
      const cols = PLAN_WRITE_COLS.map((k) => {
        params.push(planParam(fields, k));
        return { k, v: `$${params.length}${planCast(k)}` };
      });
      return {
        sql: `INSERT INTO maple_care_meds AS m (id, person, created_by, updated_by, source, client_id, ${cols.map((c) => c.k).join(", ")})
              VALUES ($1, $2, $3, $3, $4, $5, ${cols.map((c) => c.v).join(", ")})
              ON CONFLICT DO NOTHING RETURNING ${PLAN_COLS}`,
        params,
      };
    },
    clientId,
    by
  );
  const plan = deduped ? (await readablePlan(s, Number(row.id))) : rowToPlan(row);
  return { plan, deduped, notes: deduped ? [] : await notesOnSave(s, plan), madePrivate: madePrivate && !deduped };
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && k !== "id" && k !== "client_id"));
}

/** The plan notes as of its save (the opioid note shows "once on save", acked or not). */
async function notesOnSave(s: CareSession, plan: CarePlan): Promise<CareNote[]> {
  const doses = await planDoses(plan.id, new Date(s.now.getTime() - 2 * 86400_000));
  const status = planStatus(plan, doses, s.now, s.tz);
  return planNotes(plan, status, { ...noteCtx(s), settings: { ...(s.person?.settings ?? {}), acks: {} } });
}

/** Stop taking it (`stop`), or take back the stop (the toast's Undo). */
export async function stopCarePlan(s: CareSession, id: number, stop: boolean): Promise<CarePlan> {
  const p = needWrite(s);
  await readablePlan(s, id);
  const rows = await q(
    `UPDATE maple_care_meds m SET stopped_at = ${stop ? "COALESCE(stopped_at, NOW())" : "NULL"}, updated_by = $3, updated_at = NOW()
     WHERE m.id = $1 AND m.person = $2 AND m.deleted_at IS NULL RETURNING ${PLAN_COLS}`,
    [id, p.member, s.viewer.id]
  );
  if (!rows.length) throw new NotFound("Not found");
  return rowToPlan(rows[0]);
}

/** "Matches the label": someone checked an assistant-added plan against the label. */
export async function reviewCarePlan(s: CareSession, id: number): Promise<CarePlan> {
  const p = needWrite(s);
  await readablePlan(s, id);
  const rows = await q(
    `UPDATE maple_care_meds m SET reviewed_at = NOW(), reviewed_by = $3, updated_by = $3, updated_at = NOW()
     WHERE m.id = $1 AND m.person = $2 AND m.deleted_at IS NULL RETURNING ${PLAN_COLS}`,
    [id, p.member, s.viewer.id]
  );
  if (!rows.length) throw new NotFound("Not found");
  return rowToPlan(rows[0]);
}

/** Soft delete (a mistake), or bring it back (`restore`, the Undo). Doses already logged stay. */
export async function deleteCarePlan(s: CareSession, id: number, restore = false): Promise<CarePlan> {
  const p = needWrite(s);
  await readablePlan(s, id, { includeDeleted: restore });
  const rows = await q(
    `UPDATE maple_care_meds m SET deleted_at = ${restore ? "NULL" : "NOW()"}, updated_by = $3, updated_at = NOW()
     WHERE m.id = $1 AND m.person = $2 AND m.deleted_at IS ${restore ? "NOT NULL" : "NULL"} RETURNING ${PLAN_COLS}`,
    [id, p.member, s.viewer.id]
  );
  if (!rows.length) throw new NotFound("Not found");
  return rowToPlan(rows[0]);
}

// ── entries ───────────────────────────────────────────────────────────

/** A plan's doses (taken and skipped, not deleted), since `since` if given. */
export async function planDoses(planId: number, since?: Date): Promise<DoseEntry[]> {
  const rows = await q(
    `SELECT * FROM maple_care_entries WHERE med_id = $1 AND kind = 'dose' AND deleted_at IS NULL
       AND ($2::timestamptz IS NULL OR at >= $2::timestamptz) ORDER BY at`,
    [planId, since ? since.toISOString() : null]
  );
  return rows.map(rowToCareEntry) as DoseEntry[];
}

/** One-off doses (no plan) the session can see near a time, for the "same one-off name" duplicate check. */
async function oneOffsNear(s: CareSession, at: Date): Promise<DoseEntry[]> {
  const p = personOf(s);
  const rows = await q(
    `SELECT e.* FROM maple_care_entries e LEFT JOIN maple_care_meds m ON m.id = e.med_id
     WHERE e.person = $1 AND e.kind = 'dose' AND e.med_id IS NULL AND e.deleted_at IS NULL
       AND e.at > $2::timestamptz - INTERVAL '30 minutes' AND e.at < $2::timestamptz + INTERVAL '30 minutes' AND ${visibleSql(3)}`,
    [p.member, at.toISOString(), s.access.private]
  );
  return rows.map(rowToCareEntry) as DoseEntry[];
}

/** An entry this session can read (private ones and doses of private plans only for her), else NotFound. */
export async function readableEntry(s: CareSession, id: number, opts: { includeDeleted?: boolean } = {}): Promise<CareEntry> {
  const p = personOf(s);
  const rows = await q(
    `SELECT e.* FROM maple_care_entries e LEFT JOIN maple_care_meds m ON m.id = e.med_id
     WHERE e.id = $1 AND e.person = $2 ${opts.includeDeleted ? "" : "AND e.deleted_at IS NULL"} AND ${visibleSql(3)}`,
    [id, p.member, s.access.private]
  );
  if (!rows.length) throw new NotFound("Not found");
  return rowToCareEntry(rows[0]);
}

/**
 * Who deleted a care entry this session could read, when it's soft-deleted
 * (for "Matt removed this dose, so your change wasn't saved"), else undefined.
 */
export async function careDiscardedBy(s: CareSession, id: number): Promise<string | null | undefined> {
  try {
    const p = personOf(s);
    const rows = await q(
      `SELECT e.updated_by FROM maple_care_entries e LEFT JOIN maple_care_meds m ON m.id = e.med_id
       WHERE e.id = $1 AND e.person = $2 AND e.deleted_at IS NOT NULL AND ${visibleSql(3)}`,
      [id, p.member, s.access.private]
    );
    return rows.length ? strOrNull(rows[0].updated_by) : undefined;
  } catch {
    return undefined;
  }
}

/** Entries in [from, to) the session can read, newest first (plan detail, the visit summary). */
export async function listCareEntries(s: CareSession, opts: { from?: Date; to?: Date; kinds?: CareKind[]; limit?: number }): Promise<CareEntry[]> {
  const p = personOf(s);
  const rows = await q(
    `SELECT e.* FROM maple_care_entries e LEFT JOIN maple_care_meds m ON m.id = e.med_id
     WHERE e.person = $1 AND e.deleted_at IS NULL AND ${visibleSql(2)}
       AND ($3::timestamptz IS NULL OR e.at >= $3::timestamptz) AND ($4::timestamptz IS NULL OR e.at < $4::timestamptz)
       AND ($5::text[] IS NULL OR e.kind = ANY($5::text[]))
     ORDER BY e.at DESC, e.id DESC LIMIT $6`,
    [p.member, s.access.private, opts.from?.toISOString() ?? null, opts.to?.toISOString() ?? null, opts.kinds?.length ? opts.kinds : null, Math.min(Math.max(opts.limit ?? 2000, 1), 5000)]
  );
  return rows.map(rowToCareEntry);
}

/** The local days [fromKey, toKey] in the family's zone. */
export function careDayRange(fromKey: string, toKey: string, tz: string): { from: Date; to: Date } {
  return { from: dayBounds(fromKey, tz)[0], to: dayBounds(toKey, tz)[1] };
}

/** A little slack for phone clocks running ahead of the server. */
const FUTURE_SLACK_MS = 10 * 60_000;

function cleanAt(at: unknown, now: Date): Date {
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) throw new Error("When must be an ISO timestamp");
  const d = new Date(at);
  if (d.getTime() > now.getTime() + FUTURE_SLACK_MS) throw new Error("That time is in the future.");
  return d;
}

export type DoseInput = {
  /** A plan's dose; without it, a one-off (`name`). */
  planId?: number | null;
  name?: string;
  at: string;
  units?: number | null;
  /** "Dose, if different"; blank snapshots the plan's dose text. */
  dose?: string | null;
  note?: string | null;
  skipped?: boolean;
  /** A one-off marked Only me (hers only). */
  private?: boolean;
  allowDuplicate?: boolean;
  clientId?: string | null;
  source: Source;
  /**
   * Siri and the MCP: refuse (created: false, `reason`) a dose that's early,
   * at the limit or missing its units, as well as a likely duplicate, until
   * it's confirmed with allowDuplicate. The app asks before it sends, so it
   * only gets the duplicate check.
   */
  strict?: boolean;
};

/**
 * Log a dose (taken or skipped) of a plan or a one-off. A likely duplicate
 * (any non-skipped dose of the same plan, or one-off name, by anyone, within
 * the plan's gap or 30 minutes) comes back created: false with
 * possible_duplicate unless allowDuplicate; the same client_id comes back
 * deduped. Notes are the live early and over-limit notes for this dose.
 */
export async function logCareDose(s: CareSession, input: DoseInput): Promise<DoseResult> {
  const p = needWrite(s);
  const at = cleanAt(input.at, s.now);
  const clientId = cleanClientId(input.clientId);
  const ctx = { ...noteCtx(s), now: s.now, tz: s.tz };

  if (input.planId != null) {
    const plan = await readablePlan(s, input.planId);
    const units = input.skipped ? null : cleanUnits(input.units, plan.limit_unit);
    const doses = await planDoses(plan.id, new Date(at.getTime() - 3 * 86400_000));
    const before = planStatus(plan, doses, s.now, s.tz);
    const notes = doseNotes(plan, doses, { at: at.toISOString(), units, skipped: input.skipped }, ctx);
    // The count comes first, even for a dose the caller already confirmed (allow_duplicate): a dose saved without
    // one counts as 1 toward her limit, so the 24-hour total could read low and miss an over-limit warning.
    if (input.strict && !input.skipped && units === null && !unitsKnown(plan)) return { created: false, entry: null, notes, reason: "units", status: before };
    if (!input.allowDuplicate && !input.skipped) {
      const prior = clientId ? await priorByClient(clientId, s.viewer.id) : null;
      if (prior) return { created: false, deduped: true, entry: prior, notes: [], status: before };
      const dup = recentDose(plan, doses, at);
      if (!input.strict) {
        if (dup) return { created: false, entry: null, notes, possible_duplicate: dup, reason: "recent", status: before };
      } else {
        // As the one-tap reads it: someone else's dose inside the gap, or anyone's within 30 minutes, is
        // probably the same one; the caller's own older dose inside the gap is early.
        if (dup && (Math.abs(Date.parse(dup.at) - at.getTime()) < RECENT_MS || dup.created_by !== s.viewer.id)) {
          return { created: false, entry: null, notes, possible_duplicate: dup, reason: "recent", status: before };
        }
        const flags = doseFlags(plan, doses, { at: at.toISOString(), units });
        if (flags.over) return { created: false, entry: null, notes, reason: "at_limit", status: before };
        if (flags.early) return { created: false, entry: null, notes, reason: "early", status: before };
      }
    }
    const data = cleanCareData("dose", {
      name: plan.name,
      // Blank snapshots the plan's dose text, so later edits to the plan don't rewrite history.
      dose: input.dose?.trim() ? input.dose : plan.dose_text,
      units,
      skipped: input.skipped === true,
    }, { unit: plan.limit_unit });
    const saved = await insertEntry(p.member, { kind: "dose", medId: plan.id, at, data, note: cleanCareNote(input.note), priv: false, by: s.viewer.id, source: input.source, clientId });
    if (!saved.deduped && !input.allowDuplicate && !input.skipped) {
      const lost = await lostRace(plan, saved.entry as DoseEntry, at);
      if (lost) return { created: false, entry: null, notes, possible_duplicate: lost, reason: "recent", status: before };
    }
    const after = planStatus(plan, saved.deduped ? doses : [...doses, saved.entry as DoseEntry], s.now, s.tz);
    return { created: !saved.deduped, deduped: saved.deduped || undefined, entry: saved.entry, notes: saved.deduped ? [] : notes, status: after };
  }

  // A one-off ("Something else").
  if (input.private && !s.access.private) throw new CareForbidden(`Only ${s.name} can mark a medicine Only me.`);
  const data = cleanCareData("dose", { name: input.name, dose: input.dose, skipped: input.skipped === true }, { unit: null });
  const plans = await visiblePlans(s);
  const notes = oneOffNotes(data.name, plans.filter((x) => planActive(x, s.now, s.tz)), noteCtx(s));
  if (!input.allowDuplicate && !input.skipped) {
    const prior = clientId ? await priorByClient(clientId, s.viewer.id) : null;
    if (prior) return { created: false, deduped: true, entry: prior, notes: [] };
    const key = normName(data.name);
    const dup = (await oneOffsNear(s, at)).find((d) => !d.data.skipped && normName(d.data.name) === key && Math.abs(Date.parse(d.at) - at.getTime()) < RECENT_MS);
    if (dup) return { created: false, entry: null, notes, possible_duplicate: dup, reason: "recent" };
  }
  const saved = await insertEntry(p.member, { kind: "dose", medId: null, at, data, note: cleanCareNote(input.note), priv: input.private === true, by: s.viewer.id, source: input.source, clientId });
  return { created: !saved.deduped, deduped: saved.deduped || undefined, entry: saved.entry, notes: saved.deduped ? [] : notes };
}

const RACE_MS = 15_000;

/**
 * Two phones tapping "Took it" at the same moment both pass the duplicate
 * check (each read the doses before the other's insert). After saving, the
 * later of two such doses (by created_at, then id) takes itself back out and
 * answers like a duplicate, so exactly one stays and the other phone asks.
 */
async function lostRace(plan: CarePlan, mine: DoseEntry, at: Date): Promise<DoseEntry | null> {
  const t = Date.parse(mine.created_at);
  const doses = await planDoses(plan.id, new Date(at.getTime() - 3 * 86400_000));
  const earlier = doses.filter((d) => {
    if (d.id === mine.id) return false;
    const c = Date.parse(d.created_at);
    return c >= t - RACE_MS && (c < t || (c === t && d.id < mine.id));
  });
  const dup = recentDose(plan, earlier, at);
  if (!dup) return null;
  // Never shown to anyone as a dose of its own, so it goes for good rather than to Recently removed.
  await q(`DELETE FROM maple_care_entries WHERE id = $1 AND created_by IS NOT DISTINCT FROM $2`, [mine.id, mine.created_by]);
  return dup;
}

/** This member's own earlier write with this client_id (a retry), never anyone else's. */
async function priorByClient(clientId: string, by: string): Promise<CareEntry | null> {
  const rows = await q(`SELECT * FROM maple_care_entries WHERE client_id = $1 AND created_by = $2`, [clientId, by]);
  return rows.length ? rowToCareEntry(rows[0]) : null;
}

/** Log her temperature; the note is assessMomTemp's card (prefixed "For {Name}: " for anyone else). */
export async function logCareTemp(s: CareSession, input: { tempC: number; at: string; clientId?: string | null; source: Source }): Promise<DoseResult> {
  const p = needWrite(s);
  const at = cleanAt(input.at, s.now);
  const data = cleanCareData("temp", { temp_c: input.tempC });
  const saved = await insertEntry(p.member, { kind: "temp", medId: null, at, data, note: null, priv: false, by: s.viewer.id, source: input.source, clientId: cleanClientId(input.clientId) });
  const a = assessMomTemp(data.temp_c);
  return { created: !saved.deduped, deduped: saved.deduped || undefined, entry: saved.entry, notes: a ? [forMom(a, s.name, s.access.self)] : [] };
}

/** A question for her OB (the text is the note); Only me is hers to set. */
export async function addCareQuestion(s: CareSession, input: { text: string; private?: boolean; clientId?: string | null; source: Source }): Promise<{ entry: CareEntry; deduped: boolean }> {
  const p = needWrite(s);
  if (input.private && !s.access.private) throw new CareForbidden(`Only ${s.name} can mark a question Only me.`);
  const note = cleanCareNote(input.text);
  if (!note) throw new Error("Add the question.");
  return insertEntry(p.member, { kind: "question", medId: null, at: s.now, data: {}, note, priv: input.private === true, by: s.viewer.id, source: input.source, clientId: cleanClientId(input.clientId) });
}

/** POST /care/entries in one call: the kind decides which write runs. */
export async function createCareEntry(
  s: CareSession,
  body: { kind?: unknown; at?: unknown; med_id?: unknown; data?: unknown; note?: unknown; private?: unknown; client_id?: unknown; allow_duplicate?: unknown },
  source: Source
): Promise<DoseResult> {
  const d = (body.data ?? {}) as Record<string, unknown>;
  const clientId = typeof body.client_id === "string" ? body.client_id : null;
  if (body.kind === "dose") {
    return logCareDose(s, {
      planId: typeof body.med_id === "number" ? body.med_id : null,
      name: typeof d.name === "string" ? d.name : undefined,
      at: typeof body.at === "string" ? body.at : s.now.toISOString(),
      units: typeof d.units === "number" ? d.units : null,
      dose: typeof d.dose === "string" ? d.dose : null,
      note: typeof body.note === "string" ? body.note : null,
      skipped: d.skipped === true,
      private: body.private === true,
      allowDuplicate: body.allow_duplicate === true,
      clientId,
      source,
    });
  }
  if (body.kind === "temp") {
    return logCareTemp(s, { tempC: Number(d.temp_c), at: typeof body.at === "string" ? body.at : s.now.toISOString(), clientId, source });
  }
  if (body.kind === "question") {
    const { entry, deduped } = await addCareQuestion(s, { text: typeof body.note === "string" ? body.note : "", private: body.private === true, clientId, source });
    return { created: !deduped, deduped: deduped || undefined, entry, notes: [] };
  }
  throw new Error("Unknown kind");
}

type NewCareEntry = { kind: CareKind; medId: number | null; at: Date; data: unknown; note: string | null; priv: boolean; by: string; source: Source; clientId: string | null };

async function insertEntry(person: string, e: NewCareEntry): Promise<{ entry: CareEntry; deduped: boolean }> {
  const { row, deduped } = await insertRandom(
    "maple_care_entries",
    (id) => ({
      sql: `INSERT INTO maple_care_entries (id, person, kind, med_id, at, data, note, private, created_by, source, client_id)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)
            ON CONFLICT DO NOTHING RETURNING *`,
      params: [id, person, e.kind, e.medId, e.at.toISOString(), JSON.stringify(e.data), e.note, e.priv, e.by, e.source, e.clientId],
    }),
    e.clientId,
    e.by
  );
  return { entry: rowToCareEntry(row), deduped };
}

export type CareEntryPatch = {
  at?: string;
  /** Merged over the stored data, then validated again (dose: units, dose, skipped; question: done, answer). */
  data?: Record<string, unknown>;
  note?: string | null;
  /** Hers only, on one-offs and questions. */
  private?: boolean;
  expect_updated_at?: string;
};

/**
 * Edit a dose, temperature or question. With expect_updated_at, a newer
 * edit answers CareConflict; someone else's delete meanwhile answers
 * NotFound (the route says who). A dose edit comes back with its plan's
 * notes and status.
 */
export async function updateCareEntry(s: CareSession, id: number, patch: CareEntryPatch): Promise<{ entry: CareEntry; notes: Assessment[]; status?: PlanStatus }> {
  const p = needWrite(s);
  const cur = await readableEntry(s, id);
  if (patch.expect_updated_at && Date.parse(cur.updated_at) > Date.parse(patch.expect_updated_at)) {
    throw new CareConflict(`${memberName(cur.updated_by ?? cur.created_by, s.members)} changed this a moment ago. Here's the latest.`, { entry: cur });
  }
  const at = patch.at !== undefined ? cleanAt(patch.at, s.now) : new Date(cur.at);
  let plan: CarePlan | null = null;
  if (cur.kind === "dose" && cur.med_id != null) plan = await readablePlan(s, cur.med_id, { includeDeleted: true }).catch(() => null);
  const merged = { ...(cur.data as Record<string, unknown>), ...(patch.data ?? {}) };
  const data = cleanCareData(cur.kind, merged, cur.kind === "dose" ? { unit: plan ? plan.limit_unit : (cur.data as CareDataByKind["dose"]).unit ?? null } : {});
  const note = patch.note !== undefined ? cleanCareNote(patch.note) : cur.note;
  if (cur.kind === "question" && !note) throw new Error("Add the question.");
  let priv = cur.private;
  if (patch.private !== undefined) {
    if (!s.access.private) throw new CareForbidden(`Only ${s.name} can mark this Only me.`);
    // A plan's dose follows its plan; a temperature is never private.
    priv = cur.kind === "temp" || cur.med_id != null ? false : patch.private;
  }
  const params: unknown[] = [id, p.member, at.toISOString(), JSON.stringify(data), note, priv, s.viewer.id];
  let expect = "";
  if (patch.expect_updated_at) {
    params.push(patch.expect_updated_at);
    expect = ` AND date_trunc('milliseconds', updated_at) <= $${params.length}::timestamptz`;
  }
  const rows = await q(
    `UPDATE maple_care_entries SET at = $3, data = $4::jsonb, note = $5, private = $6, updated_by = $7, updated_at = NOW()
     WHERE id = $1 AND person = $2 AND deleted_at IS NULL${expect} RETURNING *`,
    params
  );
  if (!rows.length) {
    const now = await readableEntry(s, id);
    throw new CareConflict(`${memberName(now.updated_by ?? now.created_by, s.members)} changed this a moment ago. Here's the latest.`, { entry: now });
  }
  const entry = rowToCareEntry(rows[0]);
  if (entry.kind === "dose" && plan) {
    const doses = await planDoses(plan.id, new Date(Math.min(at.getTime(), s.now.getTime()) - 3 * 86400_000));
    const others = doses.filter((d) => d.id !== entry.id);
    const notes = doseNotes(plan, others, { at: entry.at, units: entry.data.units, skipped: entry.data.skipped, id: entry.id }, { ...noteCtx(s), now: s.now, tz: s.tz });
    return { entry, notes, status: planStatus(plan, doses, s.now, s.tz) };
  }
  if (entry.kind === "temp") {
    const a = assessMomTemp(entry.data.temp_c);
    return { entry, notes: a ? [forMom(a, s.name, s.access.self)] : [] };
  }
  return { entry, notes: [] };
}

/** Soft delete (Undo restores it). NotFound if it's gone already (the route says who). */
export async function deleteCareEntry(s: CareSession, id: number): Promise<CareEntry> {
  const p = needWrite(s);
  await readableEntry(s, id);
  const rows = await q(
    `UPDATE maple_care_entries SET deleted_at = NOW(), updated_by = $3, updated_at = NOW() WHERE id = $1 AND person = $2 AND deleted_at IS NULL RETURNING *`,
    [id, p.member, s.viewer.id]
  );
  if (!rows.length) throw new NotFound("Not found");
  return rowToCareEntry(rows[0]);
}

export async function restoreCareEntry(s: CareSession, id: number): Promise<CareEntry> {
  const p = needWrite(s);
  await readableEntry(s, id, { includeDeleted: true });
  const rows = await q(
    `UPDATE maple_care_entries SET deleted_at = NULL, updated_by = $3, updated_at = NOW() WHERE id = $1 AND person = $2 AND deleted_at IS NOT NULL RETURNING *`,
    [id, p.member, s.viewer.id]
  );
  if (!rows.length) throw new NotFound("Not found");
  return rowToCareEntry(rows[0]);
}

// ── mood (her session only) ───────────────────────────────────────────

function needMood(s: CareSession): CarePerson {
  // Everyone else gets the same answer as for something that isn't there.
  if (!s.person || !s.access.mood) throw new NotFound("Not found");
  return s.person;
}

export async function listMood(s: CareSession, opts: { from?: Date; to?: Date } = {}): Promise<MoodEntry[]> {
  const p = needMood(s);
  const rows = await q(
    `SELECT * FROM maple_care_mood WHERE person = $1 AND ($2::timestamptz IS NULL OR at >= $2::timestamptz) AND ($3::timestamptz IS NULL OR at < $3::timestamptz)
     ORDER BY at DESC, id DESC LIMIT 2000`,
    [p.member, opts.from?.toISOString() ?? null, opts.to?.toISOString() ?? null]
  );
  return rows.map(rowToMood);
}

export async function createMood(s: CareSession, body: { kind?: unknown; at?: unknown; data?: unknown; note?: unknown; client_id?: unknown }): Promise<{ entry: MoodEntry; deduped: boolean }> {
  const p = needMood(s);
  if (body.kind !== "checkin" && body.kind !== "screen") throw new Error("Unknown kind");
  const at = body.at === undefined ? s.now : cleanAt(body.at, s.now);
  const data = cleanMoodData(body.kind, body.data, scoreScreen);
  const clientId = cleanClientId(body.client_id);
  const rows = await q(
    `INSERT INTO maple_care_mood (person, kind, at, data, note, client_id) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (client_id) WHERE client_id IS NOT NULL DO NOTHING RETURNING *`,
    [p.member, body.kind, at.toISOString(), JSON.stringify(data), cleanCareNote(body.note), clientId]
  );
  if (rows.length) return { entry: rowToMood(rows[0]), deduped: false };
  const prior = await q(`SELECT * FROM maple_care_mood WHERE client_id = $1 AND person = $2`, [clientId, p.member]);
  if (!prior.length) throw new Error("Couldn't save that, please try again");
  return { entry: rowToMood(prior[0]), deduped: true };
}

export async function updateMood(s: CareSession, id: number, patch: { data?: Record<string, unknown>; note?: string | null }): Promise<MoodEntry> {
  const p = needMood(s);
  const cur = await q(`SELECT * FROM maple_care_mood WHERE id = $1 AND person = $2`, [id, p.member]);
  if (!cur.length) throw new NotFound("Not found");
  const prev = rowToMood(cur[0]);
  const data = patch.data ? cleanMoodData(prev.kind, { ...(prev.data as Record<string, unknown>), ...patch.data }, scoreScreen) : prev.data;
  if (prev.kind === "screen" && (prev.data as MoodDataByKind["screen"]).item9_ever) (data as MoodDataByKind["screen"]).item9_ever = true;
  if (prev.kind === "checkin" && (prev.data as MoodDataByKind["checkin"]).harm_ever) (data as MoodDataByKind["checkin"]).harm_ever = true;
  const rows = await q(
    `UPDATE maple_care_mood SET data = $3::jsonb, note = $4, updated_at = NOW() WHERE id = $1 AND person = $2 RETURNING *`,
    [id, p.member, JSON.stringify(data), patch.note !== undefined ? cleanCareNote(patch.note) : prev.note]
  );
  if (!rows.length) throw new NotFound("Not found");
  return rowToMood(rows[0]);
}

/** Hard delete: the row is gone, not hidden. */
export async function deleteMood(s: CareSession, id: number): Promise<void> {
  const p = needMood(s);
  const rows = await q(`DELETE FROM maple_care_mood WHERE id = $1 AND person = $2 RETURNING id`, [id, p.member]);
  if (!rows.length) throw new NotFound("Not found");
}

// ── settings and sharing ──────────────────────────────────────────────

/**
 * PATCH /care/person. Her: who she shares with and every setting. Shared
 * writers: the shared settings (care team numbers, next visit, nursing,
 * note acks). The therapist, suggestions and banner keys are hers only.
 */
export async function patchCareSettings(s: CareSession, body: { shared_with?: unknown; settings?: unknown }): Promise<CarePerson> {
  const p = needWrite(s);
  const out: { shared_with?: string[]; settings?: Record<string, unknown>; acks?: Record<string, string> | null } = {};
  if (body.shared_with !== undefined) {
    if (!s.access.manage) throw new CareForbidden(`Only ${s.name} can change who sees this.`);
    out.shared_with = cleanSharedWith(body.shared_with, s.members, p.member);
  }
  if (body.settings !== undefined) {
    const { settings, acks } = cleanCareSettings(body.settings, { self: s.access.manage, name: s.name });
    out.settings = settings;
    out.acks = acks;
  }
  return patchCarePerson(p.member, out);
}

// ── the reader's state and rev (§9.2) ─────────────────────────────────

/** Doses reach back this far in the state, so plan detail's 7 days need no extra fetch. */
const DOSE_DAYS = 8;
const WINDOW_HOURS = 72;

/** The plans a note's ack key names: "opioid:p123" → [123], "apap:12,34" → [12, 34]. */
function ackPlanIds(key: string): number[] {
  const one = /^[a-z]+:p(\d+)$/.exec(key);
  if (one) return [Number(one[1])];
  return key.startsWith("apap:") ? key.slice(5).split(",").map(Number) : [];
}

/** Her Only me plans (deleted ones too), whose note acks no one else may see. */
async function privatePlanIds(person: string): Promise<Set<number>> {
  const rows = await q(`SELECT id FROM maple_care_meds WHERE person = $1 AND private`, [person]);
  return new Set(rows.map((r) => Number(r.id)));
}

/**
 * Settings as this reader may see them: the therapist and her own keys only
 * for her, and no acks for plans they can't see (`hidden`, her Only me ones),
 * which would give away that plan, what kind it is and when she read its note.
 */
function settingsFor(settings: CareSettings, access: CareAccess, hidden: Set<number>): CareSettings {
  const out: CareSettings = { ...settings };
  if (out.care_team) {
    const { therapist, ...team } = out.care_team;
    out.care_team = access.therapist ? { ...team, ...(therapist ? { therapist } : {}) } : team;
  }
  if (!access.mood) {
    delete out.checkin_suggestions;
    delete out.sharing_seen_at;
  }
  if (out.acks && (!access.mood || hidden.size)) {
    const shared = Object.entries(out.acks).filter(([k]) => (access.mood || !k.startsWith("suggest:")) && !ackPlanIds(k).some((id) => hidden.has(id)));
    // No empty acks left behind either: whether she dismissed a suggestion shows nowhere.
    if (shared.length) out.acks = Object.fromEntries(shared);
    else delete out.acks;
  }
  return out;
}

/**
 * Mom's part of GET /api/maple/state for one reader: plans (Only me ones for
 * her only), entries (the last 72 hours, 8 days of doses for plan detail,
 * each active plan's newest dose, open questions and her newest
 * temperature), and for her alone her check-ins and fuller check-ins of the
 * last 14 days plus her newest fuller check-in.
 */
export async function careStateFor(s: CareSession): Promise<CareState | null> {
  if (!s.person || !s.access.read) return null;
  const p = s.person;
  const now = s.now.getTime();
  const [plans, hidden, entryRows, mood] = await Promise.all([
    visiblePlans(s),
    s.access.private ? new Set<number>() : privatePlanIds(p.member),
    q(
      `SELECT e.* FROM maple_care_entries e LEFT JOIN maple_care_meds m ON m.id = e.med_id
       WHERE e.person = $1 AND e.deleted_at IS NULL AND ${visibleSql(2)} AND (
         e.at >= $3::timestamptz
         OR (e.kind IN ('dose', 'question') AND e.at >= $4::timestamptz)
         OR (e.kind = 'question' AND NOT COALESCE((e.data->>'done')::boolean, FALSE))
         OR e.id IN (SELECT DISTINCT ON (med_id) id FROM maple_care_entries
                     WHERE person = $1 AND kind = 'dose' AND med_id IS NOT NULL AND deleted_at IS NULL
                       AND NOT COALESCE((data->>'skipped')::boolean, FALSE)
                     ORDER BY med_id, at DESC)
         OR e.id = (SELECT id FROM maple_care_entries x WHERE x.person = $1 AND x.kind = 'temp' AND x.deleted_at IS NULL ORDER BY x.at DESC LIMIT 1)
       )
       ORDER BY e.at DESC, e.id DESC LIMIT 2000`,
      [p.member, s.access.private, new Date(now - WINDOW_HOURS * 3600_000).toISOString(), new Date(now - DOSE_DAYS * 86400_000).toISOString()]
    ),
    s.access.mood
      ? q(
          // Every screen of the 14 days, not only the newest: an earlier one today with
          // item 9 keeps the crisis strip up even after a later one without it.
          `SELECT * FROM maple_care_mood WHERE person = $1 AND (
             at >= $2::timestamptz
             OR id = (SELECT id FROM maple_care_mood WHERE person = $1 AND kind = 'screen' ORDER BY at DESC, id DESC LIMIT 1)
           ) ORDER BY at DESC, id DESC`,
          [p.member, new Date(now - 14 * 86400_000).toISOString()]
        )
      : Promise.resolve(null),
  ]);
  return {
    person: { member: p.member, name: carePersonName(p, s.members), self: s.access.self, created_by: p.created_by },
    access: s.access,
    settings: settingsFor(p.settings, s.access, hidden),
    ...(s.access.manage ? { shared_with: p.shared_with } : {}),
    plans,
    entries: entryRows.map(rowToCareEntry),
    ...(mood ? { mood: mood.map(rowToMood) } : {}),
  };
}

/**
 * The care part of a reader's rev token: the count and newest updated_at of
 * only the rows they can read, plus the person row as they see it. An Only
 * me or mood write never changes anyone else's token, and a reader with no
 * access has none.
 */
export async function careRev(s: CareSession): Promise<string | null> {
  if (!s.person || !s.access.read) return null;
  // What this reader sees of the person row, not its updated_at: her own
  // keys (a suggestion's "Not now", the check-in switch, the banner) never
  // move anyone else's token.
  const p = s.person;
  const hidden = s.access.private ? new Set<number>() : await privatePlanIds(p.member);
  const seen = JSON.stringify([p.member, p.created_by, settingsFor(p.settings, s.access, hidden), s.access.manage ? p.shared_with : null, s.access]);
  const person = createHash("sha1").update(seen).digest("base64url").slice(0, 16);
  const rows = await q(
    `SELECT
       (SELECT COALESCE(MAX(m.updated_at)::text, '') || '/' || COUNT(*) FROM maple_care_meds m WHERE m.person = $1 AND ($2::boolean OR NOT m.private)) AS m,
       (SELECT COALESCE(MAX(e.updated_at)::text, '') || '/' || COUNT(*) FROM maple_care_entries e LEFT JOIN maple_care_meds m ON m.id = e.med_id
          WHERE e.person = $1 AND ${visibleSql(2)}) AS e,
       ${s.access.mood ? `(SELECT COALESCE(MAX(updated_at)::text, '') || '/' || COUNT(*) FROM maple_care_mood WHERE person = $1)` : `''`} AS o`,
    [s.person.member, s.access.private]
  );
  const r = rows[0] ?? {};
  return `${person}/${r.m}/${r.e}/${r.o}`;
}

// ── for Siri, the MCP and maple_status ────────────────────────────────

/**
 * Her plans as this session may see them, each as the app shows it (line,
 * sentence, meta, notes, one-tap), sorted by sortPlans: active ones first,
 * then (with `finished`) the stopped and finished ones. Doses from the last
 * 8 days; `by` is who's asking, for the "someone else logged it" ask.
 */
export async function carePlanViews(s: CareSession, opts: { finished?: boolean } = {}): Promise<PlanView[]> {
  const plans = await visiblePlans(s);
  const since = new Date(s.now.getTime() - DOSE_DAYS * 86400_000);
  const ctx = { now: s.now, tz: s.tz, members: s.members, me: s.viewer.id, ...noteCtx(s) };
  const views = await Promise.all(plans.map(async (plan) => planView(plan, await planDoses(plan.id, since), ctx, s.viewer.id)));
  const active = sortPlans(views.filter((v) => planActive(v.plan, s.now, s.tz)));
  return opts.finished ? [...active, ...views.filter((v) => !planActive(v.plan, s.now, s.tz))] : active;
}

/**
 * The log_medicine guard (§10.3): her active, non-private plan whose
 * normalized name or an Also called name is exactly this name, when the
 * caller can read her medicines. Vitamin D never trips it ("Vitamin D3" on
 * her list never refuses Maple's vitamin D), and nothing about her is read
 * for anyone who can't see it. Null: log it for Maple.
 */
export async function momMedicineClash(viewer: CareViewer, name: string, ctx: { members: Member[]; baby?: Baby }): Promise<{ name: string; plan: CarePlan } | null> {
  if (isVitaminD(name)) return null;
  const s = await careSession(viewer, ctx);
  if (!s.person || !s.access.read) return null;
  const key = normName(name);
  if (!key) return null;
  // A plan's own name first, then Also called: ids are random, so plan order alone would pick either.
  const all = (await listCarePlans(s.person.member)).filter((p) => !p.private && planActive(p, s.now, s.tz));
  const plan = all.find((p) => normName(p.name) === key) ?? all.find((p) => planNames(p).includes(key));
  return plan ? { name: s.name, plan } : null;
}

// ── moving a dose out of Maple's log (§5.10) ──────────────────────────

/**
 * "Move to {Name}'s medicines": her dose (on `planId`, or a one-off with the
 * entry's name and dose) is created and Maple's med entry soft-deleted in one
 * statement, so neither happens without the other. `undo` puts both back.
 */
export async function moveFromMaple(s: CareSession, input: { entryId: number; planId?: number | null }): Promise<{ entry: CareEntry; maple_entry_id: number }> {
  const p = needWrite(s);
  const plan = input.planId != null ? await readablePlan(s, input.planId) : null;
  for (let i = 0; i < 5; i++) {
    const id = newId();
    const rows = await q(
      `WITH src AS (
         -- moved_to keeps it out of Maple's Recently removed and its restore: her dose's Undo is the only way back.
         UPDATE maple_entries SET deleted_at = NOW(), data = data || jsonb_build_object('moved_to', $2::bigint), updated_by = $3, updated_at = NOW()
         WHERE id = $1 AND kind = 'med' AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM maple_care_entries WHERE id = $2)
         RETURNING started_at, data, note
       )
       INSERT INTO maple_care_entries (id, person, kind, med_id, at, data, note, private, created_by, source)
       SELECT $2, $4, 'dose', $5, src.started_at,
              jsonb_strip_nulls(jsonb_build_object('name', COALESCE($6::text, src.data->>'name'), 'dose', COALESCE(NULLIF(src.data->>'dose', ''), $7::text),
                'unit', $8::text, 'moved_from', $1::bigint)),
              src.note, FALSE, $3, 'web'
       FROM src RETURNING *`,
      [input.entryId, id, s.viewer.id, p.member, plan?.id ?? null, plan?.name ?? null, plan?.dose_text ?? null, plan?.limit_unit ?? null]
    );
    if (rows.length) return { entry: rowToCareEntry(rows[0]), maple_entry_id: input.entryId };
    const left = await q(`SELECT 1 FROM maple_entries WHERE id = $1 AND kind = 'med' AND deleted_at IS NULL`, [input.entryId]);
    if (!left.length) throw new NotFound("That medicine entry isn't in Maple's log anymore.");
  }
  throw new Error("id_exhausted");
}

/** The Undo of a move: Maple's entry back, her dose deleted, together. */
export async function undoMoveFromMaple(s: CareSession, input: { entryId: number; doseId: number }): Promise<void> {
  const p = needWrite(s);
  await readableEntry(s, input.doseId);
  const rows = await q(
    `WITH d AS (
       UPDATE maple_care_entries SET deleted_at = NOW(), updated_by = $3, updated_at = NOW()
       WHERE id = $2 AND person = $4 AND deleted_at IS NULL AND (data->>'moved_from')::bigint = $1
       RETURNING id
     )
     UPDATE maple_entries SET deleted_at = NULL, data = data - 'moved_to', updated_by = $3, updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM d) RETURNING id`,
    [input.entryId, input.doseId, s.viewer.id, p.member]
  );
  if (!rows.length) throw new NotFound("Not found");
}
