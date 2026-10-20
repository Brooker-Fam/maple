import { query } from "@/lib/db";
import { finalizeBreast, pause as pauseFeed, startBreast, switchTo } from "./feed";
import { cleanData } from "./validate";
import type {
  Baby,
  Entry,
  EntryDataByKind,
  EntryKind,
  FeedData,
  Member,
  MomentData,
  Role,
  Segment,
  Side,
  Source,
  TimerKind,
} from "./types";

/**
 * Database access for Maple's Log. Every function throws StoreUnavailable when
 * DATABASE_URL is missing (query() returns null), so routes can answer 503
 * instead of pretending an entry was saved.
 */

export class StoreUnavailable extends Error {
  constructor() {
    super("Maple's log database is unavailable");
  }
}

export class NotFound extends Error {}

type Row = Record<string, unknown>;

async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const rows = await query(sql, params);
  if (rows === null) throw new StoreUnavailable();
  return rows as Row[];
}

const isoOrNull = (v: unknown): string | null =>
  v == null ? null : new Date(v as string | Date).toISOString();

const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

// DATE columns are selected as text (BABY_COLS) so no runtime timezone can
// shift them a day.
const BABY_COLS = `*, to_char(due_date, 'YYYY-MM-DD') AS due_date_text`;

export function rowToEntry(r: Row): Entry {
  return {
    id: Number(r.id),
    kind: String(r.kind) as EntryKind,
    started_at: isoOrNull(r.started_at)!,
    ended_at: isoOrNull(r.ended_at),
    active: Boolean(r.active),
    data: (r.data ?? {}) as never,
    note: r.note == null ? null : String(r.note),
    created_by: r.created_by == null ? null : String(r.created_by),
    updated_by: r.updated_by == null ? null : String(r.updated_by),
    source: (r.source ?? "web") as Source,
    created_at: isoOrNull(r.created_at)!,
    updated_at: isoOrNull(r.updated_at)!,
  } as Entry;
}

function rowToBaby(r: Row): Baby {
  return {
    id: Number(r.id),
    name: String(r.name),
    nickname: r.nickname == null ? null : String(r.nickname),
    sex: r.sex === "female" || r.sex === "male" ? r.sex : null,
    due_date: r.due_date_text == null ? null : String(r.due_date_text),
    born_at: isoOrNull(r.born_at),
    birth_weight_g: numOrNull(r.birth_weight_g),
    birth_length_cm: numOrNull(r.birth_length_cm),
    birth_head_cm: numOrNull(r.birth_head_cm),
    timezone: String(r.timezone || "America/New_York"),
    settings: (r.settings ?? {}) as Record<string, unknown>,
  };
}

/** Strip blob keys before an entry leaves the server (photos load via the proxy). */
export function toClientEntry(e: Entry): Entry {
  if (e.kind !== "moment" || !e.data.photos?.length) return e;
  const data: MomentData = {
    ...e.data,
    photos: e.data.photos.map((p) => ({ w: p.w, h: p.h })),
  };
  return { ...e, data };
}

// ── baby ──────────────────────────────────────────────────────────────

export async function getBaby(): Promise<Baby> {
  const rows = await q(`SELECT ${BABY_COLS} FROM maple_babies ORDER BY id LIMIT 1`);
  if (!rows.length) throw new NotFound("No baby profile yet");
  return rowToBaby(rows[0]);
}

export type BabyPatch = Partial<
  Pick<
    Baby,
    | "name"
    | "nickname"
    | "due_date"
    | "born_at"
    | "birth_weight_g"
    | "birth_length_cm"
    | "birth_head_cm"
    | "timezone"
  >
> & {
  /** Settings keys to set (shallow); a null value removes the key. */
  settings?: Record<string, unknown>;
  /** Alert acknowledgements to add ({ alertId: isoTime }), merged in SQL. */
  acks?: Record<string, string>;
};

const BABY_FIELDS = [
  "name",
  "nickname",
  "due_date",
  "born_at",
  "birth_weight_g",
  "birth_length_cm",
  "birth_head_cm",
  "timezone",
] as const;

/**
 * Update only the fields given, and merge settings in SQL, so two parents
 * saving different things at once (a birth time, an alert ack) both stick.
 */
export async function updateBaby(id: number, patch: BabyPatch): Promise<Baby> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const f of BABY_FIELDS) {
    if (!(f in patch)) continue;
    let v = patch[f] ?? null;
    if (f === "birth_weight_g" && typeof v === "number") v = Math.round(v);
    params.push(v);
    sets.push(`${f} = $${params.length}${f === "due_date" ? "::date" : ""}`);
  }
  if (patch.settings || patch.acks) {
    params.push(JSON.stringify(patch.settings ?? {}));
    let expr = `jsonb_strip_nulls(settings || $${params.length}::jsonb)`;
    if (patch.acks) {
      // Merge acks into what's stored (both parents may tap "We called" at
      // once) and drop any older than two weeks, all in one statement.
      params.push(JSON.stringify(patch.acks));
      expr = `jsonb_set(${expr}, '{acks}', (
        SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
        FROM jsonb_each(COALESCE(settings->'acks', '{}'::jsonb) || $${params.length}::jsonb) AS a(k, v)
        WHERE jsonb_typeof(v) = 'string' AND (v #>> '{}')::timestamptz > NOW() - INTERVAL '14 days'
      ))`;
    }
    sets.push(`settings = ${expr}`);
  }
  const rows = await q(
    `UPDATE maple_babies SET ${[...sets, "updated_at = NOW()"].join(", ")}
     WHERE id = $1 RETURNING ${BABY_COLS}`,
    params
  );
  if (!rows.length) throw new NotFound("Baby not found");
  return rowToBaby(rows[0]);
}

// ── entries ───────────────────────────────────────────────────────────

export type ListOptions = {
  babyId: number;
  /** Entries overlapping [from, to). */
  from?: Date;
  to?: Date;
  kinds?: EntryKind[];
  /** Always include running timers regardless of window. */
  includeActive?: boolean;
  limit?: number;
  /** Oldest first instead of newest first. */
  ascending?: boolean;
  /** Keyset paging (ascending only): rows strictly after this (started_at, id). */
  after?: { startedAt: string; id: number };
};

export async function listEntries(opts: ListOptions): Promise<Entry[]> {
  const rows = await q(
    `SELECT * FROM maple_entries
     WHERE baby_id = $1 AND deleted_at IS NULL
       AND ($2::text[] IS NULL OR kind = ANY($2::text[]))
       AND (
         ($3::timestamptz IS NULL OR COALESCE(ended_at, started_at) >= $3::timestamptz)
         AND ($4::timestamptz IS NULL OR started_at < $4::timestamptz)
         OR ($5::boolean AND active)
       )
       AND ($7::timestamptz IS NULL OR (started_at, id) > ($7::timestamptz, $8::bigint))
     ORDER BY started_at ${opts.ascending ? "ASC" : "DESC"}, id ${opts.ascending ? "ASC" : "DESC"}
     LIMIT $6`,
    [
      opts.babyId,
      opts.kinds?.length ? opts.kinds : null,
      opts.from ? opts.from.toISOString() : null,
      opts.to ? opts.to.toISOString() : null,
      Boolean(opts.includeActive),
      Math.min(Math.max(opts.limit ?? 2000, 1), 5000),
      opts.after?.startedAt ?? null,
      opts.after?.id ?? 0,
    ]
  );
  return rows.map(rowToEntry);
}

export async function getEntry(id: number, opts: { includeDeleted?: boolean } = {}): Promise<Entry | null> {
  const rows = await q(
    `SELECT * FROM maple_entries WHERE id = $1 ${opts.includeDeleted ? "" : "AND deleted_at IS NULL"}`,
    [id]
  );
  return rows.length ? rowToEntry(rows[0]) : null;
}

export async function activeTimers(babyId: number): Promise<Entry[]> {
  const rows = await q(
    `SELECT * FROM maple_entries WHERE baby_id = $1 AND active AND deleted_at IS NULL ORDER BY started_at`,
    [babyId]
  );
  return rows.map(rowToEntry);
}

export type NewEntry<K extends EntryKind = EntryKind> = {
  babyId: number;
  kind: K;
  startedAt: Date;
  endedAt?: Date | null;
  active?: boolean;
  data: unknown;
  note?: string | null;
  createdBy: string;
  source: Source;
  /** Idempotency key: a retry with the same id returns the first save. */
  clientId?: string | null;
};

/** A finished nursing session logged by minutes (no segments) ends when its minutes do. */
function manualFeedEnd(kind: EntryKind, data: unknown, startedAt: Date): Date | null {
  if (kind !== "feed") return null;
  const d = data as FeedData;
  if (d.method !== "breast" || d.segments?.length) return null;
  const sec = (d.left_sec ?? 0) + (d.right_sec ?? 0);
  return sec > 0 ? new Date(startedAt.getTime() + sec * 1000) : null;
}

const CLIENT_ID_RE = /^[A-Za-z0-9:_.@-]{8,120}$/;

export function cleanClientId(raw: unknown): string | null {
  return typeof raw === "string" && CLIENT_ID_RE.test(raw) ? raw : null;
}

/** Postgres unique violation on a named index. */
function isUniqueViolation(err: unknown, index: string): boolean {
  const e = err as { code?: string; constraint?: string; message?: string } | null;
  return !!e && e.code === "23505" && (e.constraint === index || !!e.message?.includes(index));
}

/** Create an entry. With a clientId it's idempotent: `deduped` marks a replayed save. */
export async function createEntryOnce(e: NewEntry): Promise<{ entry: Entry; deduped: boolean }> {
  const data = cleanData(e.kind, e.data);
  if (e.endedAt === undefined && !e.active) e = { ...e, endedAt: manualFeedEnd(e.kind, data, e.startedAt) };
  if (e.endedAt && e.endedAt.getTime() < e.startedAt.getTime()) {
    throw new Error("End time is before the start time");
  }
  const clientId = cleanClientId(e.clientId);
  const rows = await q(
    `INSERT INTO maple_entries (baby_id, kind, started_at, ended_at, active, data, note, created_by, source, client_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
     ON CONFLICT (client_id) WHERE client_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      e.babyId,
      e.kind,
      e.startedAt.toISOString(),
      e.endedAt ? e.endedAt.toISOString() : null,
      Boolean(e.active),
      JSON.stringify(data),
      e.note?.trim() ? e.note.trim().slice(0, 2000) : null,
      e.createdBy,
      e.source,
      clientId,
    ]
  );
  if (rows.length) return { entry: rowToEntry(rows[0]), deduped: false };
  const existing = await q(`SELECT * FROM maple_entries WHERE client_id = $1`, [clientId]);
  if (!existing.length) throw new Error("Couldn't save that, please try again");
  return { entry: rowToEntry(existing[0]), deduped: true };
}

export async function createEntry(e: NewEntry): Promise<Entry> {
  return (await createEntryOnce(e)).entry;
}

export type EntryPatch = {
  startedAt?: Date;
  endedAt?: Date | null;
  /** Merged over the existing data, then re-validated. */
  data?: Record<string, unknown>;
  note?: string | null;
};

export async function updateEntry(id: number, patch: EntryPatch, by?: string): Promise<Entry> {
  const cur = await getEntry(id);
  if (!cur) throw new NotFound(`Entry ${id} not found`);

  let mergedData: Record<string, unknown> = { ...(cur.data as Record<string, unknown>) };
  if (patch.data) {
    const incoming = { ...patch.data };
    // Photos are attached at upload time; clients never see their keys, so a
    // round-tripped photos array must not overwrite the stored one.
    if (cur.kind === "moment") delete incoming.photos;
    // Running nursing sessions keep their segments; timer actions edit those.
    if (cur.active) delete incoming.segments;
    mergedData = { ...mergedData, ...incoming };
    for (const [k, v] of Object.entries(incoming)) if (v === null) delete mergedData[k];
  }
  // Editing a finished nursing session's side minutes replaces its segments.
  if (
    cur.kind === "feed" &&
    patch.data &&
    ("left_sec" in patch.data || "right_sec" in patch.data) &&
    !("segments" in patch.data) &&
    !cur.active
  ) {
    delete mergedData.segments;
  }
  const startedAt = patch.startedAt ?? new Date(cur.started_at);
  // Moving the start of a timed nursing session moves its first segment too.
  if (cur.kind === "feed" && patch.startedAt && Array.isArray(mergedData.segments) && mergedData.segments.length) {
    const segs = (mergedData.segments as Segment[]).map((x) => ({ ...x }));
    const firstEnd = segs[0].end ? Date.parse(segs[0].end) : Date.now();
    if (startedAt.getTime() > firstEnd) throw new Error("Start time is after the first side ended");
    segs[0].start = startedAt.toISOString();
    mergedData.segments = segs;
  }
  const data = cleanData(cur.kind, mergedData);

  let endedAt = patch.endedAt !== undefined ? patch.endedAt : cur.ended_at ? new Date(cur.ended_at) : null;
  if (cur.active) endedAt = null;
  // New side minutes or a new start time on a by-minutes nursing session move its end.
  if (patch.endedAt === undefined && !cur.active && (patch.data || patch.startedAt)) {
    endedAt = manualFeedEnd(cur.kind, data, startedAt) ?? endedAt;
  }
  if (endedAt && endedAt.getTime() < startedAt.getTime()) {
    throw new Error("End time is before the start time");
  }
  const note = patch.note !== undefined ? (patch.note?.trim() ? patch.note.trim().slice(0, 2000) : null) : cur.note;

  // Only write if the timer state is still what we read: if the other phone
  // just stopped (or switched) it, don't stomp on that with stale data.
  const rows = await q(
    `UPDATE maple_entries SET started_at = $2, ended_at = $3, data = $4::jsonb, note = $5,
       updated_by = COALESCE($6, updated_by), updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL AND active = $7
       -- JS dates carry milliseconds; the column has microseconds.
       AND updated_at BETWEEN $8::timestamptz - INTERVAL '1 millisecond' AND $8::timestamptz + INTERVAL '1 millisecond'
     RETURNING *`,
    [
      id,
      startedAt.toISOString(),
      endedAt ? endedAt.toISOString() : null,
      JSON.stringify(data),
      note,
      by ?? null,
      cur.active,
      cur.updated_at,
    ]
  );
  if (!rows.length) {
    const now = await getEntry(id);
    if (!now) throw new NotFound(`Entry ${id} not found`);
    throw new Conflict("Someone else just changed this. Have another look and try again.", now, "changed");
  }
  return rowToEntry(rows[0]);
}

/**
 * Soft delete. A running timer keeps `active` (the running-timer index ignores
 * deleted rows), so Undo brings it back still running.
 */
export async function softDeleteEntry(id: number, by?: string): Promise<Entry> {
  const rows = await q(
    `UPDATE maple_entries SET deleted_at = NOW(), updated_by = COALESCE($2, updated_by), updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [id, by ?? null]
  );
  if (!rows.length) throw new NotFound(`Entry ${id} not found`);
  return rowToEntry(rows[0]);
}

/**
 * Undo a delete. A deleted running timer comes back running, unless another
 * timer of its kind started in the meantime (only one may run): then it comes
 * back stopped at the moment it was deleted.
 */
export async function restoreEntry(id: number, by?: string): Promise<Entry> {
  return (await restoreEntryDetailed(id, by)).entry;
}

/** restoreEntry, plus when a running timer had to come back stopped (else null). */
export async function restoreEntryDetailed(id: number, by?: string): Promise<{ entry: Entry; stoppedAt: string | null }> {
  const prev = await getEntry(id, { includeDeleted: true });
  if (!prev) throw new NotFound(`Entry ${id} not found`);
  try {
    const rows = await q(
      `UPDATE maple_entries SET deleted_at = NULL, updated_by = COALESCE($2, updated_by), updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *`,
      [id, by ?? null]
    );
    if (!rows.length) throw new NotFound(`Entry ${id} not found or not deleted`);
    return { entry: rowToEntry(rows[0]), stoppedAt: null };
  } catch (err) {
    if (!isUniqueViolation(err, "uniq_maple_entries_running")) throw err;
    const deletedAt = await q(`SELECT deleted_at FROM maple_entries WHERE id = $1`, [id]);
    const stopAt = new Date(isoOrNull(deletedAt[0]?.deleted_at) ?? Date.now());
    const data = prev.kind === "feed" ? finalizeBreast(prev.data as FeedData, stopAt) : prev.data;
    const rows = await q(
      `UPDATE maple_entries SET deleted_at = NULL, active = FALSE, ended_at = COALESCE(ended_at, $3::timestamptz),
         data = $4::jsonb, updated_by = COALESCE($2, updated_by), updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *`,
      [id, by ?? null, stopAt.toISOString(), JSON.stringify(data)]
    );
    if (!rows.length) throw new NotFound(`Entry ${id} not found or not deleted`);
    return { entry: rowToEntry(rows[0]), stoppedAt: stopAt.toISOString() };
  }
}

/** Soft-deleted entries since a time, newest first ("Recently removed"). */
export async function listDeleted(babyId: number, since: Date): Promise<Entry[]> {
  const rows = await q(
    `SELECT * FROM maple_entries WHERE baby_id = $1 AND deleted_at IS NOT NULL AND deleted_at >= $2
     ORDER BY deleted_at DESC LIMIT 100`,
    [babyId, since.toISOString()]
  );
  return rows.map(rowToEntry);
}

// ── timers ────────────────────────────────────────────────────────────

/** A request that lost a race (the other parent already stopped it). Carries the current entry. */
export class Conflict extends Error {
  /**
   * "stopped": the timer had already stopped (the other parent got there
   * first). "changed": someone edited it a moment ago.
   */
  constructor(message: string, readonly entry: Entry, readonly reason: "stopped" | "changed" = "stopped") {
    super(message);
  }
}

async function saveTimer(id: number, data: unknown, opts: { stopAt?: Date; by?: string } = {}): Promise<Entry> {
  const rows = await q(
    `UPDATE maple_entries SET data = $2::jsonb,
       active = CASE WHEN $3::timestamptz IS NULL THEN active ELSE FALSE END,
       ended_at = COALESCE($3::timestamptz, ended_at),
       updated_by = COALESCE($4, updated_by),
       updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL AND active RETURNING *`,
    [id, JSON.stringify(data), opts.stopAt ? opts.stopAt.toISOString() : null, opts.by ?? null]
  );
  if (!rows.length) {
    const cur = await getEntry(id, { includeDeleted: true });
    if (!cur) throw new NotFound(`Timer ${id} not found`);
    throw new Conflict("That timer already stopped", cur);
  }
  return rowToEntry(rows[0]);
}

async function runningTimer(id: number): Promise<Entry> {
  const e = await getEntry(id, { includeDeleted: true });
  if (!e) throw new NotFound(`Timer ${id} not found`);
  if (!e.active) throw new Conflict("That timer already stopped", e);
  return e;
}

/**
 * Start a timer. Idempotent per kind: if one is already running (say, the
 * other parent started it a second ago), return that one, switching sides if
 * asked. A unique index backs this up when two phones race.
 */
export async function startTimer(opts: {
  babyId: number;
  kind: TimerKind;
  side?: Side;
  at: Date;
  createdBy: string;
  source: Source;
  clientId?: string | null;
}): Promise<{ entry: Entry; alreadyRunning: boolean }> {
  const existing = async () => {
    const running = (await activeTimers(opts.babyId)).find((e) => e.kind === opts.kind);
    if (!running) return null;
    if (running.kind === "feed" && opts.side && opts.side !== (running.data as FeedData).last_side) {
      return { entry: await switchSide(running.id, opts.side, opts.at, opts.createdBy), alreadyRunning: true };
    }
    return { entry: running, alreadyRunning: true };
  };
  const found = await existing();
  if (found) return found;
  const data: EntryDataByKind[TimerKind] =
    opts.kind === "feed" ? startBreast(opts.side ?? "L", opts.at) : {};
  try {
    const { entry, deduped } = await createEntryOnce({
      babyId: opts.babyId,
      kind: opts.kind,
      startedAt: opts.at,
      active: true,
      data,
      createdBy: opts.createdBy,
      source: opts.source,
      clientId: opts.clientId,
    });
    return { entry, alreadyRunning: deduped };
  } catch (err) {
    if (!isUniqueViolation(err, "uniq_maple_entries_running")) throw err;
    const raced = await existing();
    if (raced) return raced;
    throw err;
  }
}

export async function switchSide(id: number, side: Side, at: Date, by?: string): Promise<Entry> {
  const e = await runningTimer(id);
  if (e.kind !== "feed") throw new Error("Only nursing timers have sides");
  return saveTimer(id, switchTo(e.data as FeedData, side, at), { by });
}

export async function pauseTimer(id: number, at: Date, by?: string): Promise<Entry> {
  const e = await runningTimer(id);
  if (e.kind !== "feed") throw new Error("Only nursing timers can pause");
  return saveTimer(id, pauseFeed(e.data as FeedData, at), { by });
}

/**
 * Stop a timer at `at` (now, or earlier for "ended earlier…"). Never before
 * the moment the current side started, never in the future.
 */
export async function stopTimer(id: number, at: Date, by?: string): Promise<Entry> {
  const e = await runningTimer(id);
  let floor = Date.parse(e.started_at);
  if (e.kind === "feed") {
    for (const s of (e.data as FeedData).segments ?? []) floor = Math.max(floor, Date.parse(s.start));
  }
  const stopAt = new Date(Math.min(Date.now(), Math.max(at.getTime(), floor)));
  const data = e.kind === "feed" ? finalizeBreast(e.data as FeedData, stopAt) : e.data;
  return saveTimer(id, data, { stopAt, by });
}

/** "Forgot to tap at latch": move a running timer's start earlier (or later). */
export async function adjustTimerStart(id: number, at: Date, by?: string): Promise<Entry> {
  await runningTimer(id);
  if (at.getTime() > Date.now()) throw new Error("Start time can't be in the future");
  return updateEntry(id, { startedAt: at }, by);
}

export async function discardTimer(id: number, by?: string): Promise<Entry> {
  await runningTimer(id);
  return softDeleteEntry(id, by);
}

/**
 * Undo a stop ("Done" tapped by mistake): the timer runs again as if it never
 * stopped. A nursing session reopens the side it ended on, unless it was
 * paused when it stopped, in which case it comes back paused.
 */
export async function reopenTimer(id: number, by?: string): Promise<Entry> {
  const e = await getEntry(id);
  if (!e) throw new NotFound(`Timer ${id} not found`);
  if (e.active) return e;
  if (!["feed", "sleep", "tummy", "pump"].includes(e.kind)) throw new Error("Only a timer can be reopened");
  let data: unknown = e.data;
  if (e.kind === "feed") {
    const d = e.data as FeedData;
    if (!d.segments?.length) throw new Error("That feed wasn't timed, so it can't restart");
    const segs = d.segments.map((s) => ({ ...s }));
    const last = segs[segs.length - 1];
    // A discarded-then-restored timer never stopped (ended_at null): its open side is still open.
    if (last.end && e.ended_at && Math.abs(Date.parse(last.end) - Date.parse(e.ended_at)) < 1500) last.end = null;
    const rest: FeedData = { ...d, segments: segs };
    delete rest.left_sec;
    delete rest.right_sec;
    data = rest;
  }
  try {
    const rows = await q(
      `UPDATE maple_entries SET active = TRUE, ended_at = NULL, data = $2::jsonb,
         updated_by = COALESCE($3, updated_by), updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL AND NOT active RETURNING *`,
      [id, JSON.stringify(data), by ?? null]
    );
    if (rows.length) return rowToEntry(rows[0]);
    const cur = await getEntry(id);
    if (!cur) throw new NotFound(`Timer ${id} not found`);
    return cur;
  } catch (err) {
    if (!isUniqueViolation(err, "uniq_maple_entries_running")) throw err;
    throw new Conflict("Another timer of that kind is running now", e);
  }
}

// ── members ───────────────────────────────────────────────────────────

export async function addMember(email: string, addedBy: string, emoji: string, role: "member" | "viewer" = "member"): Promise<void> {
  await q(`DELETE FROM maple_removed WHERE email = $1`, [email]);
  await q(
    `INSERT INTO maple_members (email, role, emoji, added_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO NOTHING`,
    [email, role, emoji, addedBy]
  );
}

/**
 * Remove someone: their session, MCP tokens and Siri tokens stop working at
 * once, and a tombstone keeps an allowlisted address from simply signing back
 * in with Google. Inviting them again (addMember) lifts it.
 */
export async function removeMember(email: string, by: string): Promise<boolean> {
  // Owners stay, except the "admin" pseudo-owner, which a real owner may remove.
  const rows = await q(
    `DELETE FROM maple_members WHERE email = $1 AND (role <> 'owner' OR email = 'admin') RETURNING email`,
    [email]
  );
  if (!rows.length) return false;
  await q(`UPDATE maple_tokens SET revoked_at = NOW() WHERE member = $1 AND revoked_at IS NULL`, [email]);
  await q(
    `INSERT INTO maple_removed (email, removed_by) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET removed_at = NOW(), removed_by = EXCLUDED.removed_by`,
    [email, by]
  );
  return true;
}

export async function wasRemoved(email: string): Promise<boolean> {
  return (await q(`SELECT 1 FROM maple_removed WHERE email = $1`, [email])).length > 0;
}

export async function updateMember(
  email: string,
  patch: Partial<Pick<Member, "display_name" | "emoji" | "color">> & { role?: "member" | "viewer" }
): Promise<void> {
  const rows = await q(`SELECT display_name, emoji, color, role FROM maple_members WHERE email = $1`, [email]);
  if (!rows.length) throw new NotFound("Member not found");
  const cur = rows[0];
  // Owners stay owners; only members and viewers swap roles.
  const role = patch.role && cur.role !== "owner" ? patch.role : cur.role;
  await q(
    `UPDATE maple_members SET display_name = $2, emoji = $3, color = $4, role = $5, updated_at = NOW() WHERE email = $1`,
    [
      email,
      patch.display_name !== undefined ? patch.display_name : cur.display_name,
      patch.emoji !== undefined ? patch.emoji : cur.emoji,
      patch.color !== undefined ? patch.color : cur.color,
      role,
    ]
  );
}

export async function lifetimeCounts(babyId: number): Promise<{ diapers: number; feeds: number }> {
  const rows = await q(
    `SELECT COUNT(*) FILTER (WHERE kind = 'diaper')::int AS diapers,
            COUNT(*) FILTER (WHERE kind = 'feed' AND NOT active)::int AS feeds
     FROM maple_entries WHERE baby_id = $1 AND deleted_at IS NULL`,
    [babyId]
  );
  return { diapers: Number(rows[0]?.diapers ?? 0), feeds: Number(rows[0]?.feeds ?? 0) };
}

/**
 * Mark a member as here now (at most once a minute) and return when they were
 * here before, for the "While you slept" recap.
 */
export async function touchLastSeen(id: string): Promise<string | null> {
  const rows = await q(
    `WITH prev AS (SELECT last_seen_at FROM maple_members WHERE email = $1)
     UPDATE maple_members SET last_seen_at = NOW()
     WHERE email = $1 AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '1 minute')
     RETURNING (SELECT last_seen_at FROM prev) AS prev`,
    [id]
  );
  if (rows.length) return isoOrNull(rows[0].prev);
  const cur = await q(`SELECT last_seen_at FROM maple_members WHERE email = $1`, [id]);
  return isoOrNull(cur[0]?.last_seen_at);
}

// ── invite links (family without Google) ──────────────────────────────

const sha256 = async (s: string) => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type Invite = {
  id: number;
  role: Role;
  display_name: string | null;
  emoji: string | null;
  created_by: string | null;
  expires_at: string;
  used_at: string | null;
};

const INVITE_DAYS = 7;

export async function createInvite(opts: {
  role: Role;
  displayName: string | null;
  emoji: string | null;
  createdBy: string;
}): Promise<{ invite: Invite; token: string }> {
  const token = randomToken();
  const rows = await q(
    `INSERT INTO maple_invites (token_hash, role, display_name, emoji, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(days => $6))
     RETURNING id, role, display_name, emoji, created_by, expires_at, used_at`,
    [await sha256(token), opts.role, opts.displayName, opts.emoji, opts.createdBy, INVITE_DAYS]
  );
  return { invite: rowToInvite(rows[0]), token };
}

function rowToInvite(r: Row): Invite {
  return {
    id: Number(r.id),
    role: (r.role === "owner" || r.role === "viewer" ? r.role : "member") as Role,
    display_name: r.display_name == null ? null : String(r.display_name),
    emoji: r.emoji == null ? null : String(r.emoji),
    created_by: r.created_by == null ? null : String(r.created_by),
    expires_at: isoOrNull(r.expires_at)!,
    used_at: isoOrNull(r.used_at),
  };
}

export async function listInvites(): Promise<Invite[]> {
  const rows = await q(
    `SELECT id, role, display_name, emoji, created_by, expires_at, used_at FROM maple_invites
     WHERE used_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC`
  );
  return rows.map(rowToInvite);
}

export async function revokeInvite(id: number): Promise<void> {
  await q(`DELETE FROM maple_invites WHERE id = $1 AND used_at IS NULL`, [id]);
}

/**
 * Redeem a one-time invite: creates the member "invite:<id>" with the name,
 * emoji and role the owner chose. Returns null if the link is used/expired.
 */
export async function redeemInvite(token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const rows = await q(
    `UPDATE maple_invites SET used_at = NOW(), used_by = 'invite:' || id
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
     RETURNING id, role, display_name, emoji, created_by`,
    [await sha256(token)]
  );
  if (!rows.length) return null;
  const r = rows[0];
  const id = `invite:${r.id}`;
  await q(
    `INSERT INTO maple_members (email, role, display_name, emoji, added_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO NOTHING`,
    [id, r.role === "viewer" ? "viewer" : "member", r.display_name, r.emoji, r.created_by]
  );
  return id;
}

// ── personal tokens (iOS Shortcuts) ───────────────────────────────────

export type PersonalToken = { id: number; label: string | null; created_at: string; last_used_at: string | null };

export async function createPersonalToken(member: string, label: string | null): Promise<{ token: string; record: PersonalToken }> {
  const token = `maple_${randomToken()}`;
  const rows = await q(
    `INSERT INTO maple_tokens (member, token_hash, label) VALUES ($1, $2, $3)
     RETURNING id, label, created_at, last_used_at`,
    [member, await sha256(token), label]
  );
  const r = rows[0];
  return {
    token,
    record: { id: Number(r.id), label: r.label == null ? null : String(r.label), created_at: isoOrNull(r.created_at)!, last_used_at: null },
  };
}

export async function listPersonalTokens(member: string): Promise<PersonalToken[]> {
  const rows = await q(
    `SELECT id, label, created_at, last_used_at FROM maple_tokens WHERE member = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
    [member]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    label: r.label == null ? null : String(r.label),
    created_at: isoOrNull(r.created_at)!,
    last_used_at: isoOrNull(r.last_used_at),
  }));
}

export async function revokePersonalToken(member: string, id: number): Promise<boolean> {
  const rows = await q(
    `UPDATE maple_tokens SET revoked_at = NOW() WHERE id = $1 AND member = $2 AND revoked_at IS NULL RETURNING id`,
    [id, member]
  );
  return rows.length > 0;
}

/** The member a personal token belongs to (and stamps last use), or null. */
export async function memberForPersonalToken(token: string): Promise<string | null> {
  if (!/^maple_[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const rows = await q(
    `UPDATE maple_tokens SET last_used_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING member`,
    [await sha256(token)]
  );
  return rows.length ? String(rows[0].member) : null;
}

// ── change token for cheap polling ────────────────────────────────────

export async function rev(babyId: number): Promise<string> {
  const rows = await q(
    `SELECT
       (SELECT COALESCE(MAX(updated_at)::text, '') || '/' || COUNT(*) FROM maple_entries WHERE baby_id = $1) AS e,
       (SELECT COALESCE(updated_at::text, '') FROM maple_babies WHERE id = $1) AS b,
       (SELECT COALESCE(MAX(updated_at)::text, '') || '/' || COUNT(*) FROM maple_members) AS m`,
    [babyId]
  );
  const r = rows[0] ?? {};
  return `${r.e}|${r.b}|${r.m}`;
}
