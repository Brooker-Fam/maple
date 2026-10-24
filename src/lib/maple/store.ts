import { query } from "@/lib/db";
import {
  FeedEditError,
  feedCtx,
  feedParts,
  finalizeBreast,
  moveEdge,
  normalizeSegments,
  openSegment,
  pause as pauseFeed,
  restoredTap,
  retimeBreast,
  setSide,
  startBreast,
  stopBreast,
  summarize,
  switchTo,
  undoLastTap,
  type Moment,
  type TapFeedData,
} from "./feed";
import { cleanData } from "./validate";
import type {
  Baby,
  Entry,
  EntryDataByKind,
  EntryKind,
  FeedData,
  FeedEdit,
  Member,
  MomentData,
  Role,
  Segment,
  Side,
  Source,
  TimerKind,
  TimerResponse,
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

const SEC = 1000;
const HOUR = 3600 * SEC;
/** A last end this close to ended_at ran to the stop (feed.ts uses the same). */
const NEAR = 1500;

/** Two updated_at values from JS (ms) and Postgres (µs) name the same write. */
const sameInstant = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 1;

/** Parts can't end in the future (a little slack for clock skew). */
function noFutureEnds(segments: Segment[], now: Date) {
  for (const s of segments) {
    if (s.end && Date.parse(s.end) > now.getTime() + 5 * SEC) throw new FeedEditError("future", { now: now.toISOString() });
  }
}

/**
 * `expectUpdatedAt`: the updated_at the edit was made against (FeedSheet's
 * Save, a nap's restore); anything newer is someone else's change, 409.
 */
export async function updateEntry(id: number, patch: EntryPatch, by?: string, opts: { expectUpdatedAt?: string } = {}): Promise<Entry> {
  const cur = await getEntry(id);
  if (!cur) throw new NotFound(`Entry ${id} not found`);
  if (opts.expectUpdatedAt !== undefined && !sameInstant(opts.expectUpdatedAt, cur.updated_at)) {
    throw new Conflict("Someone else just changed this. Have another look and try again.", cur, "changed");
  }

  let mergedData: Record<string, unknown> = { ...(cur.data as Record<string, unknown>) };
  if (patch.data) {
    const incoming = { ...patch.data };
    // Photos are attached at upload time; clients never see their keys, so a
    // round-tripped photos array must not overwrite the stored one.
    if (cur.kind === "moment") delete incoming.photos;
    // Running nursing sessions keep their segments; timer actions edit those.
    if (cur.active) delete incoming.segments;
    // The tap record is the taps' own (undo reads it), never a client's.
    delete incoming.last_tap;
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
    delete mergedData.paused_at_stop;
  }
  let startedAt = patch.startedAt ?? new Date(cur.started_at);
  // A finished timed feed's parts as FeedSheet's Times staged them: they are
  // the feed, so totals, sides and the start follow them.
  let partsEnd: Date | undefined;
  const newEnd = !cur.active && patch.endedAt ? patch.endedAt : undefined;
  if (cur.kind === "feed" && !cur.active && mergedData.method === "breast" && Array.isArray(patch.data?.segments) && Array.isArray(mergedData.segments)) {
    const now = new Date();
    const segments = normalizeSegments(mergedData.segments as Segment[], { active: false });
    // Sent as [] (an old or hand-made client): a timed feed is its parts, so that's a 400, not a crash.
    if (!segments.length) throw new Error("A timed feed needs at least one side");
    noFutureEnds(segments, now);
    mergedData = { ...mergedData, segments, ...summarize(segments) };
    startedAt = new Date(segments[0].start);
    const lastEnd = Date.parse(segments[segments.length - 1].end!);
    // A legacy trailing break keeps its end when the last side's end didn't move.
    const trailing = feedParts(cur.data as FeedData, feedCtx(cur, now)).find((p) => p.kind === "break" && p.legacy);
    const kept = trailing && Math.abs(lastEnd - Date.parse(trailing.start)) < NEAR ? Date.parse(cur.ended_at!) : lastEnd;
    let end = patch.endedAt ? patch.endedAt.getTime() : kept;
    if (end > now.getTime() + 5 * SEC) throw new FeedEditError("future", { now: now.toISOString() });
    if (end < lastEnd) {
      if (lastEnd - end >= NEAR) throw new FeedEditError("before_break", { t: new Date(lastEnd).toISOString() });
      end = lastEnd;
    }
    // An end past the last side is a trailing break, not a stop at the pause.
    if (end - lastEnd >= NEAR) delete mergedData.paused_at_stop;
    partsEnd = new Date(end);
  } else if (cur.kind === "feed" && (patch.startedAt || newEnd) && Array.isArray(mergedData.segments) && mergedData.segments.length) {
    // Moving the start (or, once finished, the end) of a timed nursing session
    // moves its first (or last) side too, so the side minutes follow.
    if (cur.active && patch.startedAt && patch.startedAt.getTime() > Date.now()) throw new Error("Start time can't be in the future");
    // A "started on" correction sent with the move beats the recomputed sides.
    const sides = Object.fromEntries(
      (["first_side", "last_side"] as const).filter((k) => patch.data?.[k] != null).map((k) => [k, patch.data![k]])
    );
    mergedData = {
      ...mergedData,
      ...retimeBreast(mergedData as FeedData, {
        start: patch.startedAt,
        end: newEnd,
        prevEnd: cur.ended_at ? new Date(cur.ended_at) : null,
      }),
      ...sides,
    };
  }
  const data = cleanData(cur.kind, mergedData);

  let endedAt = partsEnd ?? (patch.endedAt !== undefined ? patch.endedAt : cur.ended_at ? new Date(cur.ended_at) : null);
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
    let stopAt = new Date(isoOrNull(deletedAt[0]?.deleted_at) ?? Date.now());
    let data: unknown = prev.data;
    if (prev.kind === "feed" && (prev.data as FeedData).segments?.length) {
      // The one stop rule: a running feed ends when it was deleted, a paused one at its pause.
      const stopped = stopBreast(prev.data as FeedData, undefined, stopAt);
      data = stopped.data;
      stopAt = new Date(stopped.endedAt);
    } else if (prev.kind === "feed") data = finalizeBreast(prev.data as FeedData, stopAt);
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
   * first). "changed": someone edited it a moment ago. "clash": another timer
   * of its kind is running, and only one may.
   */
  constructor(message: string, readonly entry: Entry, readonly reason: "stopped" | "changed" | "clash" = "stopped") {
    super(message);
  }
}

/** What a timer edit writes. Feed segments are normalized on the way in, and started_at follows them. */
type TimerWrite = {
  data: unknown;
  startedAt?: string;
  /** Finished entries only; omitted keeps the stored one. */
  endedAt?: string | null;
  active?: boolean;
  /** moved: a resume at a time found her already back on that side, so that one start moved instead. */
  flags?: Pick<TimerResponse, "clamped" | "merged" | "reverted"> & { moved?: true };
};

const CAS_ATTEMPTS = 3;

const changed = (cur: Entry) => new Conflict(`Someone just changed this ${cur.kind === "feed" ? "feed" : "timer"}`, cur, "changed");

/** The feed as an edit found it, for "Back to …" (retime restore). */
function beforeOf(cur: Entry): TimerResponse["before"] {
  if (cur.kind !== "feed") return undefined;
  return { segments: cur.data.segments ?? [], started_at: cur.started_at, ended_at: cur.ended_at, updated_at: cur.updated_at };
}

/**
 * The one way a timer changes: read it, apply `fn`, and write only if the row
 * is still the one read, else read again and re-apply. Every `fn` is an
 * intent ("switch to Right at 4:16", "move the stretch {R, 4:25} to 4:20",
 * "undo the tap that made {R, 4:25}"), so when both phones write at once
 * their changes merge instead of one overwriting the other. `fn` answers null
 * when there's nothing to do (already on that side, already paused).
 */
async function mutateTimer(
  id: number,
  fn: (cur: Entry) => TimerWrite | null,
  opts: { by?: string; allowFinished?: boolean; expectUpdatedAt?: string } = {}
): Promise<TimerResponse> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const cur = await getEntry(id);
    if (!cur) throw new NotFound(`Timer ${id} not found`);
    if (!cur.active && !opts.allowFinished) throw new Conflict("That timer already stopped", cur, "stopped");
    if (opts.expectUpdatedAt !== undefined && !sameInstant(opts.expectUpdatedAt, cur.updated_at)) throw changed(cur);
    let w: TimerWrite | null;
    try {
      w = fn(cur);
    } catch (err) {
      // The stretch the edit names is gone, or isn't the newest any more.
      if (err instanceof FeedEditError && (err.code === "not_found" || err.code === "not_newest")) throw changed(cur);
      throw err;
    }
    if (!w) return { entry: cur, noop: true };
    const active = w.active ?? cur.active;
    let data = w.data;
    let startedAt = w.startedAt ?? cur.started_at;
    const segs = cur.kind === "feed" ? (data as FeedData).segments : undefined;
    if (segs?.length) {
      const segments = normalizeSegments(segs, { active });
      data = { ...(data as FeedData), segments };
      startedAt = segments[0].start;
    }
    const endedAt = active ? null : w.endedAt !== undefined ? w.endedAt : cur.ended_at;
    if (endedAt && Date.parse(endedAt) < Date.parse(startedAt)) throw new Error("End time is before the start time");
    const rows = await q(
      `UPDATE maple_entries SET data = $2::jsonb, started_at = $3, ended_at = $4, active = $5,
         updated_by = COALESCE($6, updated_by), updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL AND active = $7
         -- JS dates carry milliseconds; the column has microseconds.
         AND updated_at BETWEEN $8::timestamptz - INTERVAL '1 millisecond' AND $8::timestamptz + INTERVAL '1 millisecond'
       RETURNING *`,
      [id, JSON.stringify(cleanData(cur.kind, data)), startedAt, endedAt, active, opts.by ?? null, cur.active, cur.updated_at]
    );
    if (rows.length) return { entry: rowToEntry(rows[0]), ...w.flags, ...(cur.kind === "feed" ? { before: beforeOf(cur) } : {}) };
  }
  const latest = await getEntry(id);
  if (!latest) throw new NotFound(`Timer ${id} not found`);
  throw changed(latest);
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
    // A different side switches (now: this is a tap, not a time someone gave); the same side resumes a paused feed.
    if (running.kind === "feed" && opts.side && opts.side !== openSegment((running.data as FeedData).segments)?.side) {
      return { entry: (await switchSide(running.id, opts.side, undefined, opts.createdBy)).entry, alreadyRunning: true };
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

/**
 * When a tap really happened: the `at` someone gave ("she went back on at
 * 4:20"), within the last 4 hours, else now. A few seconds ahead (a phone's
 * clock) counts as now.
 */
function tapTime(at: Date | undefined, now: Date): Date {
  if (!at) return now;
  const t = at.getTime();
  if (Number.isNaN(t)) throw new Error("That time isn't a valid time");
  if (t > now.getTime() + 5 * SEC) throw new FeedEditError("future", { now: now.toISOString() });
  if (t < now.getTime() - 4 * HOUR) throw new Error("That's more than 4 hours ago.");
  return t > now.getTime() ? now : at;
}

/** switchSide's answer: `moved` when a resume at a time moved when she went back on instead (see below). */
export type SwitchResponse = TimerResponse & { moved?: true };

/**
 * Switch sides, or resume on a side while paused, now or at `at`. Already on
 * that side: noop. A tap never moves a stretch that's already there; fixing
 * one is retimeFeed's job. The one exception is `resume` with a time (the
 * paused sheet's "Already back on? 5 min ago", made against a feed the other
 * phone has since resumed): on that side, an earlier time moves when she
 * went back on (`moved`, with `before` for "Back to …"); on the other side
 * it's 409 "changed", since what the person saw is gone (switchTo).
 */
export async function switchSide(id: number, side: Side, at: Date | undefined, by?: string, opts: { resume?: boolean } = {}): Promise<SwitchResponse> {
  const now = new Date();
  const t = tapTime(at, now);
  return mutateTimer(id, (cur) => {
    if (cur.kind !== "feed") throw new Error("Only nursing timers have sides");
    const { data, noop, ...flags } = switchTo(cur.data, side, t, { explicit: at !== undefined, resume: opts.resume, now });
    return noop ? null : { data, flags };
  }, { by });
}

/** Pause the open side now or at `at` (when she came off). Already paused: noop. */
export async function pauseTimer(id: number, at: Date | undefined, by?: string): Promise<TimerResponse> {
  const now = new Date();
  const t = tapTime(at, now);
  return mutateTimer(id, (cur) => {
    if (cur.kind !== "feed") throw new Error("Only nursing timers can pause");
    const paused = pauseFeed(cur.data, t, { explicit: at !== undefined, now });
    return paused.noop ? null : { data: paused.data };
  }, { by });
}

/**
 * Stop a timer. The one rule every Done goes through (the dock, Fell asleep,
 * Still nursing?, stop_timer): a running feed ends at `at` (default now,
 * never later), and an explicit time before its current side began is
 * refused, not clamped. A paused feed ends at its pause, unless `at` is
 * earlier, which trims the last side to it. Other timers end at `at`, kept
 * between their start and now.
 */
export async function stopTimer(id: number, at: Date | undefined, by?: string, opts: { expectUpdatedAt?: string } = {}): Promise<Entry> {
  if (at && Number.isNaN(at.getTime())) throw new Error("That time isn't a valid time");
  const now = new Date();
  const res = await mutateTimer(id, (cur) => {
    if (cur.kind === "feed" && cur.data.segments?.length) {
      const stopped = stopBreast(cur.data, at, now);
      return { data: stopped.data, endedAt: stopped.endedAt, active: false };
    }
    const stopAt = new Date(Math.max(Date.parse(cur.started_at), Math.min((at ?? now).getTime(), now.getTime())));
    return { data: cur.kind === "feed" ? finalizeBreast(cur.data, stopAt) : cur.data, endedAt: stopAt.toISOString(), active: false };
  }, { by, expectUpdatedAt: opts.expectUpdatedAt });
  return res.entry;
}

/** The timed breast feed an edit applies to, else not_timed (400). */
function timedFeed(cur: Entry): FeedData {
  if (cur.kind !== "feed" || cur.data.method !== "breast" || !cur.data.segments?.length) throw new FeedEditError("not_timed");
  return cur.data;
}

/**
 * Fix times: move one moment, fix which side a part was, undo the latest
 * tap, or put back what a fix replaced (the `before` it answered with). Each
 * names the stretch it means, so it merges with the other phone's taps.
 */
export async function retimeFeed(id: number, edit: FeedEdit, by?: string): Promise<TimerResponse> {
  return retime(id, edit, by, true);
}

async function retime(id: number, edit: FeedEdit, by: string | undefined, allowFinished: boolean): Promise<TimerResponse> {
  switch (edit.op) {
    case "move": {
      // The moment the winning attempt moved (a retry re-reads the feed).
      const last: { moment?: Moment } = {};
      const res = await mutateTimer(id, (cur) => {
        const moved = moveEdge(timedFeed(cur), { edge: edit.edge, ref: edit.ref, to: new Date(edit.to) }, feedCtx(cur, new Date()));
        last.moment = moved.moment;
        return { data: moved.data, startedAt: moved.startedAt, endedAt: moved.endedAt };
      }, { by, allowFinished });
      const was = res.before?.started_at;
      if (last.moment !== "feed_start" || !was || Date.parse(res.entry.started_at) >= Date.parse(was)) return res;
      const nap = await followNap(id, was, res.entry.started_at, by);
      return nap ? { ...res, nap } : res;
    }
    case "set_side":
      return mutateTimer(id, (cur) => ({ data: setSide(timedFeed(cur), edit.ref, edit.side, feedCtx(cur, new Date())).data }), { by, allowFinished });
    case "undo_tap":
      // Running feeds only: a finished one comes back with reopen (the Done toast's Undo).
      return mutateTimer(id, (cur) => ({ data: undoLastTap(timedFeed(cur), edit.expect, { active: cur.active }).data }), { by });
    case "restore": {
      const res = await mutateTimer(id, (cur) => restoreWrite(cur, edit), { by, allowFinished: true, expectUpdatedAt: edit.expect_updated_at });
      // The nap only goes back once the feed has.
      return edit.nap ? { ...res, ...(await restoreNap(edit.nap, by)) } : res;
    }
  }
}

/** Put back the parts a fix replaced, checked as strictly as any edit. */
function restoreWrite(cur: Entry, edit: Extract<FeedEdit, { op: "restore" }>): TimerWrite {
  const d = timedFeed(cur);
  const segments = normalizeSegments(edit.segments, { active: cur.active });
  noFutureEnds(segments, new Date());
  const sides = summarize(segments);
  if (cur.active) {
    // The latest tap stays only if it still fits the stretches put back ("Put it back" after an undo brings it back too).
    const data: TapFeedData = { ...d, segments, first_side: sides.first_side, last_side: sides.last_side };
    const tap = restoredTap(d, segments, true);
    if (tap) data.last_tap = tap;
    else delete data.last_tap;
    return { data };
  }
  const lastEnd = Date.parse(segments[segments.length - 1].end!);
  if (!edit.ended_at || Date.parse(edit.ended_at) < lastEnd - NEAR) throw new Error("A finished feed can't end before its last side");
  const end = Math.max(Date.parse(edit.ended_at), lastEnd);
  const data: FeedData = { ...d, segments, ...sides };
  // An end past the last side is a trailing break, not a stop at the pause.
  if (end - lastEnd >= NEAR) delete data.paused_at_stop;
  else if (edit.paused_at_stop) data.paused_at_stop = true;
  return { data, endedAt: new Date(end).toISOString() };
}

/**
 * A feed start moved earlier takes the nap that ended at the old start with
 * it (she woke and latched), as long as the nap keeps a minute. The nap is
 * written with its own CAS and left alone if it changed meanwhile.
 */
async function followNap(feedId: number, wasStart: string, newStart: string, by?: string): Promise<TimerResponse["nap"]> {
  const rows = await q(
    `SELECT * FROM maple_entries
     WHERE baby_id = (SELECT baby_id FROM maple_entries WHERE id = $1)
       AND kind = 'sleep' AND NOT active AND deleted_at IS NULL
       AND ended_at BETWEEN $2::timestamptz - INTERVAL '60 seconds' AND $2::timestamptz + INTERVAL '60 seconds'
     ORDER BY ABS(EXTRACT(EPOCH FROM ended_at - $2::timestamptz)), id DESC LIMIT 1`,
    [feedId, wasStart]
  );
  if (!rows.length) return undefined;
  const nap = rowToEntry(rows[0]);
  if (Date.parse(newStart) - Date.parse(nap.started_at) < 60 * SEC) return undefined;
  try {
    const entry = await updateEntry(nap.id, { endedAt: new Date(newStart) }, by, { expectUpdatedAt: nap.updated_at });
    return { entry, before_ended_at: nap.ended_at!, before_updated_at: nap.updated_at };
  } catch (err) {
    if (!(err instanceof Conflict || err instanceof NotFound)) console.error("Maple nap follow failed:", err);
    return undefined;
  }
}

/** Put a followed nap's end back, only if nobody changed the nap since. */
async function restoreNap(
  nap: { id: number; ended_at: string; expect_updated_at: string },
  by?: string
): Promise<Pick<TimerResponse, "nap" | "nap_restored">> {
  try {
    const cur = await getEntry(nap.id);
    if (!cur || cur.kind !== "sleep" || cur.active || !cur.ended_at) return { nap_restored: false };
    const entry = await updateEntry(nap.id, { endedAt: new Date(nap.ended_at) }, by, { expectUpdatedAt: nap.expect_updated_at });
    return { nap: { entry, before_ended_at: cur.ended_at, before_updated_at: cur.updated_at }, nap_restored: true };
  } catch (err) {
    // The feed is already back; a nap someone changed meanwhile stays as it is.
    if (!(err instanceof Conflict || err instanceof NotFound)) console.error("Maple nap restore failed:", err);
    return { nap_restored: false };
  }
}

/**
 * "Forgot to tap at latch": move a running timer's start. A feed moves its
 * first stretch's start (so a nap that ended then follows); this is also the
 * REST "adjust" alias that cached PWA clients still send. Other timers: not
 * in the future, at most 12 hours back.
 */
export async function adjustTimerStart(id: number, at: Date, by?: string): Promise<Entry> {
  if (Number.isNaN(at.getTime())) throw new Error("Start time must be a valid time");
  const e = await getEntry(id);
  if (!e) throw new NotFound(`Timer ${id} not found`);
  if (e.kind === "feed") return (await retime(id, { op: "move", edge: "start", to: at.toISOString() }, by, false)).entry;
  const now = Date.now();
  if (at.getTime() > now) throw new Error("Start time can't be in the future");
  if (at.getTime() < now - 12 * HOUR) throw new Error("That's more than 12 hours ago.");
  return (await mutateTimer(id, (cur) => ({ data: cur.data, startedAt: at.toISOString() }), { by })).entry;
}

/**
 * Throw away a running timer (soft delete; Undo restores it). With
 * `expectUpdatedAt` (the start toast's Undo, sent with the start's answer),
 * only that version goes: if someone switched, paused or fixed it since,
 * 409 "changed" and nothing is thrown away.
 */
export async function discardTimer(id: number, by?: string, opts: { expectUpdatedAt?: string } = {}): Promise<Entry> {
  // Already discarded is a 404 (who did it: discardedBy), never a 409 carrying the deleted row.
  const cur = await getEntry(id);
  if (!cur) throw new NotFound(`Timer ${id} not found`);
  if (!cur.active) throw new Conflict("That timer already stopped", cur);
  if (opts.expectUpdatedAt === undefined) return softDeleteEntry(id, by);
  if (!sameInstant(opts.expectUpdatedAt, cur.updated_at)) throw changed(cur);
  const rows = await q(
    `UPDATE maple_entries SET deleted_at = NOW(), updated_by = COALESCE($2, updated_by), updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL AND active
       AND updated_at BETWEEN $3::timestamptz - INTERVAL '1 millisecond' AND $3::timestamptz + INTERVAL '1 millisecond'
     RETURNING *`,
    [id, by ?? null, opts.expectUpdatedAt]
  );
  if (rows.length) return rowToEntry(rows[0]);
  // Lost the race: stopped, discarded or changed in between.
  const now = await getEntry(id);
  if (!now) throw new NotFound(`Timer ${id} not found`);
  if (!now.active) throw new Conflict("That timer already stopped", now, "stopped");
  throw changed(now);
}

/**
 * Who discarded an entry, when `id` is a soft-deleted one (its updated_by,
 * which the delete wrote): for a 404 that can say "Brittany discarded this
 * feed". undefined when it isn't deleted (or doesn't exist).
 */
export async function discardedBy(id: number): Promise<string | null | undefined> {
  const rows = await q(`SELECT updated_by FROM maple_entries WHERE id = $1 AND deleted_at IS NOT NULL`, [id]);
  if (!rows.length) return undefined;
  return rows[0].updated_by == null ? null : String(rows[0].updated_by);
}

/**
 * Undo a stop ("Done" tapped by mistake): the timer runs again as if it never
 * stopped. A nursing session reopens the side it ended on, unless it was
 * paused when it stopped, in which case it comes back paused. Built from the
 * row as read and written only if it's still that row (mutateTimer), so a
 * fix the other phone saved on the finished feed meanwhile isn't overwritten:
 * the reopen re-reads and applies to the fixed feed.
 */
export async function reopenTimer(id: number, by?: string): Promise<Entry> {
  try {
    const res = await mutateTimer(id, (e) => {
      if (e.active) return null;
      if (!["feed", "sleep", "tummy", "pump"].includes(e.kind)) throw new Error("Only a timer can be reopened");
      if (e.kind !== "feed") return { data: e.data, active: true, endedAt: null };
      const d = e.data as FeedData;
      if (!d.segments?.length) throw new Error("That feed wasn't timed, so it can't restart");
      const segs = d.segments.map((s) => ({ ...s }));
      const last = segs[segs.length - 1];
      // Stopped at its pause (paused_at_stop): the last side stays closed. Otherwise
      // the side that ran to the stop reopens; a discarded-then-restored timer
      // never stopped (ended_at null), so its open side is still open.
      if (!d.paused_at_stop && last.end && e.ended_at && Math.abs(Date.parse(last.end) - Date.parse(e.ended_at)) < NEAR) last.end = null;
      const rest: FeedData = { ...d, segments: segs };
      delete rest.left_sec;
      delete rest.right_sec;
      delete rest.paused_at_stop;
      return { data: rest, active: true, endedAt: null };
    }, { by, allowFinished: true });
    return res.entry;
  } catch (err) {
    if (!isUniqueViolation(err, "uniq_maple_entries_running")) throw err;
    const cur = await getEntry(id);
    if (!cur) throw new NotFound(`Timer ${id} not found`);
    throw new Conflict("Another timer of that kind is running now", cur, "clash");
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
