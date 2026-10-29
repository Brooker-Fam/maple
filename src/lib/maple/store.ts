import { query } from "@/lib/db";
import { captureAppEventSoon } from "@/lib/analytics/server";
import {
  addPart,
  applyFeedCorrections,
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
import { blobBelongsTo } from "./blob";
import type {
  Baby,
  Entry,
  EntryDataByKind,
  EntryKind,
  FeedData,
  FeedEdit,
  Lifetime,
  MomentData,
  Segment,
  Side,
  Source,
  StretchSide,
  TimerKind,
  TimerResponse,
} from "./types";
import { captureServerException } from "@/lib/posthog-server";
import { parseFamilyId, type FamilyScope } from "./family";
import { nursingChanged } from "./push-hooks";

/**
 * Database access for Maple's Log. Every function throws StoreUnavailable when
 * DATABASE_URL is missing (query() returns null), so routes can answer 503
 * instead of pretending an entry was saved.
 *
 * Every function takes the family it acts in first, and every statement
 * filters by it: another family's row reads exactly like a missing one
 * (NotFound), and every insert files its row under that family.
 */

/** The family a store call acts in: its id, or a FamilyCtx / FamilyScope. */
export type FamilyRef = number | Pick<FamilyScope, "familyId">;

/** Fails closed: a missing or malformed family never falls back to family 1. */
export function famId(fam: FamilyRef): number {
  const id = parseFamilyId(typeof fam === "number" ? fam : fam?.familyId);
  if (id === null) throw new Error("family_required");
  return id;
}

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

/** The family's active baby (the same one FamilyCtx.babyId names). */
export async function getBaby(fam: FamilyRef): Promise<Baby> {
  const rows = await q(
    `SELECT ${BABY_COLS} FROM maple_babies WHERE family_id = $1 AND archived_at IS NULL ORDER BY id LIMIT 1`,
    [famId(fam)]
  );
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
    | "sex"
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
  "sex",
] as const;

/**
 * Update only the fields given, and merge settings in SQL, so two parents
 * saving different things at once (a birth time, an alert ack) both stick.
 */
export async function updateBaby(fam: FamilyRef, id: number, patch: BabyPatch): Promise<Baby> {
  const sets: string[] = [];
  const params: unknown[] = [id, famId(fam)];
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
     WHERE id = $1 AND family_id = $2 RETURNING ${BABY_COLS}`,
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
  before?: { startedAt: string; id: number };
};

export async function listEntries(fam: FamilyRef, opts: ListOptions): Promise<Entry[]> {
  const rows = await q(
    `SELECT * FROM maple_entries
     WHERE family_id = $9 AND baby_id = $1 AND deleted_at IS NULL
       AND ($2::text[] IS NULL OR kind = ANY($2::text[]))
       AND (
         ($3::timestamptz IS NULL OR COALESCE(ended_at, started_at) >= $3::timestamptz)
         AND ($4::timestamptz IS NULL OR started_at < $4::timestamptz)
         OR ($5::boolean AND active)
       )
       AND ($7::timestamptz IS NULL OR (started_at, id) > ($7::timestamptz, $8::bigint))
       AND ($10::timestamptz IS NULL OR (started_at, id) < ($10::timestamptz, $11::bigint))
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
      famId(fam),
      opts.before?.startedAt ?? null,
      opts.before?.id ?? 0,
    ]
  );
  return rows.map(rowToEntry);
}

export async function listMomentHighlights(fam: FamilyRef, babyId: number, milestones: string[]): Promise<Entry[]> {
  const rows = await q(
    `SELECT DISTINCT ON (data->>'milestone') * FROM maple_entries
     WHERE family_id = $1 AND baby_id = $2 AND deleted_at IS NULL AND kind = 'moment'
       AND data->>'milestone' = ANY($3::text[])
     ORDER BY data->>'milestone',
       CASE WHEN data->>'milestone' LIKE 'monthly-%' THEN started_at END DESC,
       started_at ASC,
       CASE WHEN data->>'milestone' LIKE 'monthly-%' THEN id END DESC,
       id ASC`,
    [famId(fam), babyId, milestones]
  );
  return rows.map(rowToEntry).sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id);
}

/** An entry by id, or null when it doesn't exist, is deleted (unless asked), or is another family's. */
export async function getEntry(fam: FamilyRef, id: number, opts: { includeDeleted?: boolean } = {}): Promise<Entry | null> {
  const rows = await q(
    `SELECT * FROM maple_entries WHERE id = $1 AND family_id = $2 ${opts.includeDeleted ? "" : "AND deleted_at IS NULL"}`,
    [id, famId(fam)]
  );
  return rows.length ? rowToEntry(rows[0]) : null;
}

export async function activeTimers(fam: FamilyRef, babyId: number): Promise<Entry[]> {
  const rows = await q(
    `SELECT * FROM maple_entries WHERE family_id = $2 AND baby_id = $1 AND active AND deleted_at IS NULL ORDER BY started_at`,
    [babyId, famId(fam)]
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
  /** The phone's per-install id (X-Maple-Device), for notifications only; nothing in Maple's views reads it. */
  device?: string | null;
};

/** A finished nursing session logged by minutes (no segments) ends when its minutes do. */
function manualFeedEnd(kind: EntryKind, data: unknown, startedAt: Date): Date | null {
  if (kind !== "feed") return null;
  const d = data as FeedData;
  if (d.method !== "breast" || d.segments?.length) return null;
  // Back and forth (both_sec) is nursing too.
  const sec = (d.left_sec ?? 0) + (d.right_sec ?? 0) + (d.both_sec ?? 0);
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

/**
 * Create an entry. With a clientId it's idempotent within the family:
 * `deduped` marks a replayed save. A baby that isn't the family's saves
 * nothing (NotFound).
 */
export async function createEntryOnce(fam: FamilyRef, e: NewEntry): Promise<{ entry: Entry; deduped: boolean }> {
  const familyId = famId(fam);
  const data = cleanData(e.kind, e.data);
  if (e.kind === "moment") ownPhotosOnly(familyId, data as MomentData);
  if (e.endedAt === undefined && !e.active) e = { ...e, endedAt: manualFeedEnd(e.kind, data, e.startedAt) };
  if (e.endedAt && e.endedAt.getTime() < e.startedAt.getTime()) {
    throw new Error("End time is before the start time");
  }
  const clientId = cleanClientId(e.clientId);
  // The device column only when there's an id (a database a step behind on migrations still saves).
  const device = e.device ?? null;
  const rows = await q(
    `INSERT INTO maple_entries (family_id, baby_id, kind, started_at, ended_at, active, data, note, created_by, source, client_id${device ? ", device" : ""})
     SELECT $11::bigint, $1::integer, $2::text, $3::timestamptz, $4::timestamptz, $5::boolean, $6::jsonb, $7::text, $8::text, $9::text, $10::text${device ? ", $12::text" : ""}
     WHERE EXISTS (SELECT 1 FROM maple_babies WHERE id = $1::integer AND family_id = $11::bigint)
     ON CONFLICT (family_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
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
      familyId,
      ...(device ? [device] : []),
    ]
  );
  if (rows.length) {
    captureAppEventSoon({ familyId, member: String(rows[0].created_by) }, "entry_logged");
    return { entry: rowToEntry(rows[0]), deduped: false };
  }
  const existing = clientId ? await q(`SELECT * FROM maple_entries WHERE client_id = $1 AND family_id = $2`, [clientId, familyId]) : [];
  if (existing.length) return { entry: rowToEntry(existing[0]), deduped: true };
  if (!(await q(`SELECT 1 FROM maple_babies WHERE id = $1 AND family_id = $2`, [e.babyId, familyId])).length) throw new NotFound("Baby not found");
  throw new Error("Couldn't save that, please try again");
}

function ownPhotosOnly(familyId: number, data: MomentData): void {
  for (const p of data.photos ?? []) {
    if (!p.key || !blobBelongsTo(p.key, familyId) || (p.thumb_key !== undefined && !blobBelongsTo(p.thumb_key, familyId))) {
      throw new Error("photo must be a Maple upload");
    }
  }
}

export async function createEntry(fam: FamilyRef, e: NewEntry): Promise<Entry> {
  return (await createEntryOnce(fam, e)).entry;
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
export async function updateEntry(fam: FamilyRef, id: number, patch: EntryPatch, by?: string, opts: { expectUpdatedAt?: string } = {}): Promise<Entry> {
  const cur = await getEntry(fam, id);
  if (!cur) throw new NotFound(`Entry ${id} not found`);
  if (cur.kind === "growth" && cur.source === "epic") {
    throw new Error("Imported measurements keep their original values. Remove this point and log a separate measurement if needed.");
  }
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
    ("left_sec" in patch.data || "right_sec" in patch.data || "both_sec" in patch.data) &&
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
    // summarize leaves the side stored when the feed began going back and forth; a feed with no back and forth now drops both_sec.
    delete mergedData.both_sec;
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
     WHERE id = $1 AND family_id = $9 AND deleted_at IS NULL AND active = $7
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
      famId(fam),
    ]
  );
  if (!rows.length) {
    const now = await getEntry(fam, id);
    if (!now) throw new NotFound(`Entry ${id} not found`);
    throw new Conflict("Someone else just changed this. Have another look and try again.", now, "changed");
  }
  const updated = rowToEntry(rows[0]);
  // A running nursing feed's start moved (update_entry with at): its lock-screen notice says so.
  if (cur.active) nursingSoon(fam, updated);
  return updated;
}

/**
 * Soft delete. A running timer keeps `active` (the running-timer index ignores
 * deleted rows), so Undo brings it back still running.
 */
export async function softDeleteEntry(fam: FamilyRef, id: number, by?: string): Promise<Entry> {
  const rows = await q(
    `UPDATE maple_entries SET deleted_at = NOW(), updated_by = COALESCE($2, updated_by), updated_at = NOW()
     WHERE id = $1 AND family_id = $3 AND deleted_at IS NULL RETURNING *`,
    [id, by ?? null, famId(fam)]
  );
  if (!rows.length) throw new NotFound(`Entry ${id} not found`);
  const entry = rowToEntry(rows[0]);
  if (entry.active) nursingSoon(fam, entry);
  return entry;
}

/** A nursing timer changed: its lock-screen notice follows, after the response (push-hooks.ts). Other kinds: nothing. */
function nursingSoon(fam: FamilyRef, e: Entry): void {
  if (e.kind === "feed" && (e.data as FeedData).segments?.length) nursingChanged(e.id, famId(fam));
}

/**
 * Undo a delete. A deleted running timer comes back running, unless another
 * timer of its kind started in the meantime (only one may run): then it comes
 * back stopped at the moment it was deleted.
 */
export async function restoreEntry(fam: FamilyRef, id: number, by?: string): Promise<Entry> {
  return (await restoreEntryDetailed(fam, id, by)).entry;
}

/** restoreEntry, plus when a running timer had to come back stopped (else null). */
export async function restoreEntryDetailed(fam: FamilyRef, id: number, by?: string): Promise<{ entry: Entry; stoppedAt: string | null }> {
  const familyId = famId(fam);
  const prev = await getEntry(familyId, id, { includeDeleted: true });
  if (!prev) throw new NotFound(`Entry ${id} not found`);
  // Moved to mom's medicines (care-store moveFromMaple): back only through the Undo there, never as Maple's too.
  if ((prev.data as Record<string, unknown>).moved_to != null) throw new Error("That one moved to her own medicines, so it can't come back here. Undo the move from there.");
  try {
    const rows = await q(
      `UPDATE maple_entries SET deleted_at = NULL, data = data - 'joined_into', updated_by = COALESCE($2, updated_by), updated_at = NOW()
       WHERE id = $1 AND family_id = $3 AND deleted_at IS NOT NULL AND NOT (data ? 'moved_to') RETURNING *`,
      [id, by ?? null, familyId]
    );
    if (!rows.length) throw new NotFound(`Entry ${id} not found or not deleted`);
    const entry = rowToEntry(rows[0]);
    if (entry.active) nursingSoon(familyId, entry);
    return { entry, stoppedAt: null };
  } catch (err) {
    if (!isUniqueViolation(err, "uniq_maple_entries_running")) throw err;
    const deletedAt = await q(`SELECT deleted_at FROM maple_entries WHERE id = $1 AND family_id = $2`, [id, familyId]);
    let stopAt = new Date(isoOrNull(deletedAt[0]?.deleted_at) ?? Date.now());
    let data: unknown = prev.data;
    if (prev.kind === "feed" && (prev.data as FeedData).segments?.length) {
      // The one stop rule: a running feed ends when it was deleted, a paused one at its pause.
      const stopped = stopBreast(prev.data as FeedData, undefined, stopAt);
      data = stopped.data;
      stopAt = new Date(stopped.endedAt);
    } else if (prev.kind === "feed") data = finalizeBreast(prev.data as FeedData, stopAt);
    // Back as itself, not as part of the feed it was joined into.
    const { joined_into: _joined, ...kept } = data as Record<string, unknown>;
    void _joined;
    data = kept;
    const rows = await q(
      `UPDATE maple_entries SET deleted_at = NULL, active = FALSE, ended_at = COALESCE(ended_at, $3::timestamptz),
         data = $4::jsonb, updated_by = COALESCE($2, updated_by), updated_at = NOW()
       WHERE id = $1 AND family_id = $5 AND deleted_at IS NOT NULL RETURNING *`,
      [id, by ?? null, stopAt.toISOString(), JSON.stringify(data), familyId]
    );
    if (!rows.length) throw new NotFound(`Entry ${id} not found or not deleted`);
    return { entry: rowToEntry(rows[0]), stoppedAt: stopAt.toISOString() };
  }
}

/** Soft-deleted entries since a time, newest first ("Recently removed"). */
export async function listDeleted(fam: FamilyRef, babyId: number, since: Date): Promise<Entry[]> {
  const rows = await q(
    `SELECT * FROM maple_entries WHERE family_id = $3 AND baby_id = $1 AND deleted_at IS NOT NULL AND deleted_at >= $2 AND NOT (data ? 'moved_to')
     ORDER BY deleted_at DESC LIMIT 100`,
    [babyId, since.toISOString(), famId(fam)]
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
  flags?: Pick<TimerResponse, "clamped" | "merged" | "reverted" | "resided"> & { moved?: true };
};

const CAS_ATTEMPTS = 3;

const changed = (cur: Entry) => new Conflict(`Someone just changed this ${cur.kind === "feed" ? "feed" : "timer"}`, cur, "changed");

/** The feed as an edit found it, for "Back to …" (retime restore), with the flag of a Done at its pause so that comes back too. */
function beforeOf(cur: Entry): TimerResponse["before"] {
  if (cur.kind !== "feed") return undefined;
  const b = {
    segments: cur.data.segments ?? [], started_at: cur.started_at, ended_at: cur.ended_at, updated_at: cur.updated_at,
    first_side: cur.data.first_side ?? null, last_side: cur.data.last_side ?? null,
  };
  return !cur.active && cur.data.paused_at_stop === true ? { ...b, paused_at_stop: true } : b;
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
  fam: FamilyRef,
  id: number,
  fn: (cur: Entry) => TimerWrite | null,
  opts: { by?: string; allowFinished?: boolean; expectUpdatedAt?: string } = {}
): Promise<TimerResponse> {
  const familyId = famId(fam);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const cur = await getEntry(familyId, id);
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
       WHERE id = $1 AND family_id = $9 AND deleted_at IS NULL AND active = $7
         -- JS dates carry milliseconds; the column has microseconds.
         AND updated_at BETWEEN $8::timestamptz - INTERVAL '1 millisecond' AND $8::timestamptz + INTERVAL '1 millisecond'
       RETURNING *`,
      [id, JSON.stringify(cleanData(cur.kind, data)), startedAt, endedAt, active, opts.by ?? null, cur.active, cur.updated_at, familyId]
    );
    if (rows.length) {
      const entry = rowToEntry(rows[0]);
      // Running before or after (a tap, a fix while it runs, Done, Undo of Done): the nursing notice follows. A finished feed's fix doesn't.
      if (cur.active || entry.active) nursingSoon(familyId, entry);
      return { entry, ...w.flags, ...(cur.kind === "feed" ? { before: beforeOf(cur) } : {}) };
    }
  }
  const latest = await getEntry(familyId, id);
  if (!latest) throw new NotFound(`Timer ${id} not found`);
  throw changed(latest);
}

/**
 * Start a timer. Idempotent per kind: if one is already running (say, the
 * other parent started it a second ago), return that one, switching sides if
 * asked. A unique index backs this up when two phones race.
 *
 * `backAndForth` (feeds): she's going back and forth from the start. The
 * feed's one part is both sides and `side` is stored as where she started
 * (what the next side alternates from). With a feed already running, it goes
 * back and forth from now instead (a part under a minute old turns both,
 * switchTo), or resumes going both if it was paused.
 */
export async function startTimer(fam: FamilyRef, opts: {
  babyId: number;
  kind: TimerKind;
  side?: Side;
  backAndForth?: boolean;
  at: Date;
  createdBy: string;
  source: Source;
  clientId?: string | null;
  /** The phone's per-install id (X-Maple-Device). */
  device?: string | null;
}): Promise<{ entry: Entry; alreadyRunning: boolean }> {
  const both = opts.kind === "feed" && !!opts.backAndForth;
  const existing = async () => {
    const running = (await activeTimers(fam, opts.babyId)).find((e) => e.kind === opts.kind);
    if (!running) return null;
    // A different side switches (now: this is a tap, not a time someone gave); the same side resumes a paused feed.
    // Back and forth goes both from now (or resumes going both).
    const want: StretchSide | undefined = both ? "B" : opts.side;
    if (running.kind === "feed" && want && want !== openSegment((running.data as FeedData).segments)?.side) {
      return { entry: (await switchSide(fam, running.id, want, undefined, opts.createdBy)).entry, alreadyRunning: true };
    }
    return { entry: running, alreadyRunning: true };
  };
  const found = await existing();
  if (found) return found;
  const data: EntryDataByKind[TimerKind] =
    opts.kind === "feed" ? startBreast(opts.side ?? "L", opts.at, { both }) : {};
  try {
    const { entry, deduped } = await createEntryOnce(fam, {
      babyId: opts.babyId,
      kind: opts.kind,
      startedAt: opts.at,
      active: true,
      data,
      createdBy: opts.createdBy,
      source: opts.source,
      clientId: opts.clientId,
      device: opts.device,
    });
    if (!deduped) nursingSoon(fam, entry);
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
 *
 * `side` "B" is back and forth from now ("stop tracking sides"); a side
 * while she's going both is "She's on the Left" (tracking sides again).
 * resided: going both turned a part under a minute old into the both part
 * (or a side tapped within 15 s of going both re-sided it); reverted: that
 * side tap took going both back. Undo is retime undo_tap, as for any tap:
 * it gives a re-sided part its side back, or drops the part the tap added.
 */
export async function switchSide(fam: FamilyRef, id: number, side: StretchSide, at: Date | undefined, by?: string, opts: { resume?: boolean } = {}): Promise<SwitchResponse> {
  const now = new Date();
  const t = tapTime(at, now);
  return mutateTimer(fam, id, (cur) => {
    if (cur.kind !== "feed") throw new Error("Only nursing timers have sides");
    const { data, noop, ...flags } = switchTo(cur.data, side, t, { explicit: at !== undefined, resume: opts.resume, now, by });
    return noop ? null : { data, flags };
  }, { by });
}

/** Pause the open side now or at `at` (when she came off). Already paused: noop. */
export async function pauseTimer(fam: FamilyRef, id: number, at: Date | undefined, by?: string): Promise<TimerResponse> {
  const now = new Date();
  const t = tapTime(at, now);
  return mutateTimer(fam, id, (cur) => {
    if (cur.kind !== "feed") throw new Error("Only nursing timers can pause");
    const paused = pauseFeed(cur.data, t, { explicit: at !== undefined, now, by });
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
export async function stopTimer(fam: FamilyRef, id: number, at: Date | undefined, by?: string, opts: { expectUpdatedAt?: string } = {}): Promise<Entry> {
  if (at && Number.isNaN(at.getTime())) throw new Error("That time isn't a valid time");
  const now = new Date();
  const res = await mutateTimer(fam, id, (cur) => {
    // When Done was tapped, beside when it ended: the sheet's "edited" tells a later fix from the Done itself.
    const tapped = { stopped_at: now.toISOString() };
    if (cur.kind === "feed" && cur.data.segments?.length) {
      const stopped = stopBreast(cur.data, at, now);
      return { data: { ...stopped.data, ...tapped }, endedAt: stopped.endedAt, active: false };
    }
    const stopAt = new Date(Math.max(Date.parse(cur.started_at), Math.min((at ?? now).getTime(), now.getTime())));
    return { data: { ...(cur.kind === "feed" ? finalizeBreast(cur.data, stopAt) : cur.data), ...tapped }, endedAt: stopAt.toISOString(), active: false };
  }, { by, expectUpdatedAt: opts.expectUpdatedAt });
  return res.entry;
}

/** The timed breast feed an edit applies to, else not_timed (400). */
function timedFeed(cur: Entry): FeedData {
  if (cur.kind !== "feed" || cur.data.method !== "breast" || !cur.data.segments?.length) throw new FeedEditError("not_timed");
  return cur.data;
}

/**
 * Fix times: save a guarded draft, move one moment, fix which side a part
 * was, undo the latest tap, or restore the `before` a fix answered with.
 * Legacy one-tap edits name their stretch to merge with the other phone's
 * taps; a draft requires the exact revision its corrections were made on.
 */
export async function retimeFeed(fam: FamilyRef, id: number, edit: FeedEdit, by?: string): Promise<TimerResponse> {
  return retime(fam, id, edit, by, true);
}

async function retime(fam: FamilyRef, id: number, edit: FeedEdit, by: string | undefined, allowFinished: boolean): Promise<TimerResponse> {
  switch (edit.op) {
    case "batch": {
      const res = await mutateTimer(fam, id, (cur) => {
        const draft = applyFeedCorrections(cur, edit.edits, new Date());
        return { data: draft.data, startedAt: draft.started_at, endedAt: draft.ended_at };
      }, { by, allowFinished, expectUpdatedAt: edit.expect_updated_at });
      const was = res.before?.started_at;
      if (!was || Date.parse(res.entry.started_at) >= Date.parse(was)) return res;
      const nap = await followNap(fam, id, was, res.entry.started_at, by);
      return nap ? { ...res, nap } : res;
    }
    case "move": {
      // The moment the winning attempt moved (a retry re-reads the feed).
      const last: { moment?: Moment } = {};
      const res = await mutateTimer(fam, id, (cur) => {
        const moved = moveEdge(timedFeed(cur), { edge: edit.edge, ref: edit.ref, to: new Date(edit.to) }, feedCtx(cur, new Date()));
        last.moment = moved.moment;
        return { data: moved.data, startedAt: moved.startedAt, endedAt: moved.endedAt };
      }, { by, allowFinished, expectUpdatedAt: edit.expect_updated_at });
      const was = res.before?.started_at;
      if (last.moment !== "feed_start" || !was || Date.parse(res.entry.started_at) >= Date.parse(was)) return res;
      const nap = await followNap(fam, id, was, res.entry.started_at, by);
      return nap ? { ...res, nap } : res;
    }
    case "set_side":
      return mutateTimer(fam, id, (cur) => ({ data: setSide(timedFeed(cur), edit.ref, edit.side, feedCtx(cur, new Date())).data }), { by, allowFinished });
    case "undo_tap":
      // Running feeds only: a finished one comes back with reopen (the Done toast's Undo).
      return mutateTimer(fam, id, (cur) => ({ data: undoLastTap(timedFeed(cur), edit.expect, { active: cur.active }).data }), { by });
    case "add_part":
      // "She went back on…" after a Done: asked of the finished feed this phone saw, so one reopened or changed since is 409 "changed".
      return mutateTimer(
        fam,
        id,
        (cur) => {
          if (cur.active) throw changed(cur);
          const added = addPart(timedFeed(cur), { side: edit.side, start: edit.start, end: edit.end }, feedCtx(cur, new Date()));
          return { data: added.data, startedAt: added.startedAt, endedAt: added.endedAt };
        },
        { by, allowFinished: true, expectUpdatedAt: edit.expect_updated_at }
      );
    case "restore": {
      const res = await mutateTimer(fam, id, (cur) => restoreWrite(cur, edit), { by, allowFinished: true, expectUpdatedAt: edit.expect_updated_at });
      // The nap only goes back once the feed has.
      return edit.nap ? { ...res, ...(await restoreNap(fam, edit.nap, by)) } : res;
    }
  }
}

/**
 * Put back the parts a fix replaced, checked as strictly as any edit. An
 * end on a feed that's running again finishes it there: the Undo of a
 * Continue puts back the finished feed as the other phone's Done left it.
 */
function restoreWrite(cur: Entry, edit: Extract<FeedEdit, { op: "restore" }>): TimerWrite {
  const d = timedFeed(cur);
  const finish = cur.active && edit.ended_at != null;
  const active = cur.active && !finish;
  const segments = normalizeSegments(edit.segments, { active });
  noFutureEnds(segments, new Date());
  const sides = summarize(segments);
  const data: TapFeedData = { ...d, segments, first_side: sides.first_side ?? d.first_side, last_side: sides.last_side ?? d.last_side };
  // Both-side stretches cannot reconstruct these hints. New snapshots put
  // them back exactly; older clients keep the inferred/stored fallback.
  for (const key of ["first_side", "last_side"] as const) {
    if (edit[key] === null) delete data[key];
    else if (edit[key] !== undefined) data[key] = edit[key];
  }
  if (active) {
    // The latest tap stays only if it still fits the stretches put back ("Put it back" after an undo brings it back too).
    const tap = restoredTap(d, segments, true);
    if (tap) data.last_tap = tap;
    else delete data.last_tap;
    return { data };
  }
  const lastEnd = Date.parse(segments[segments.length - 1].end!);
  if (!edit.ended_at || Date.parse(edit.ended_at) < lastEnd - NEAR) throw new Error("A finished feed can't end before its last side");
  const end = Math.max(Date.parse(edit.ended_at), lastEnd);
  Object.assign(data, { left_sec: sides.left_sec, right_sec: sides.right_sec });
  if (sides.both_sec) data.both_sec = sides.both_sec;
  else delete data.both_sec;
  if (finish) {
    // The tap the Continue made isn't on the finished feed; one that still fits it (the pause before Done) stays.
    const tap = restoredTap(d, segments, true);
    if (tap) data.last_tap = tap;
    else delete data.last_tap;
  }
  // An end past the last side is a trailing break, not a stop at the pause.
  if (end - lastEnd >= NEAR) delete data.paused_at_stop;
  else if (edit.paused_at_stop) data.paused_at_stop = true;
  return { data, endedAt: new Date(end).toISOString(), ...(finish ? { active: false } : {}) };
}

/**
 * A feed start moved earlier takes the nap that ended at the old start with
 * it (she woke and latched), as long as the nap keeps a minute. The nap is
 * written with its own CAS and left alone if it changed meanwhile.
 */
async function followNap(fam: FamilyRef, feedId: number, wasStart: string, newStart: string, by?: string): Promise<TimerResponse["nap"]> {
  const rows = await q(
    `SELECT * FROM maple_entries
     WHERE family_id = $3 AND baby_id = (SELECT baby_id FROM maple_entries WHERE id = $1 AND family_id = $3)
       AND kind = 'sleep' AND NOT active AND deleted_at IS NULL
       AND ended_at BETWEEN $2::timestamptz - INTERVAL '60 seconds' AND $2::timestamptz + INTERVAL '60 seconds'
     ORDER BY ABS(EXTRACT(EPOCH FROM ended_at - $2::timestamptz)), id DESC LIMIT 1`,
    [feedId, wasStart, famId(fam)]
  );
  if (!rows.length) return undefined;
  const nap = rowToEntry(rows[0]);
  if (Date.parse(newStart) - Date.parse(nap.started_at) < 60 * SEC) return undefined;
  try {
    const entry = await updateEntry(fam, nap.id, { endedAt: new Date(newStart) }, by, { expectUpdatedAt: nap.updated_at });
    return { entry, before_ended_at: nap.ended_at!, before_updated_at: nap.updated_at };
  } catch (err) {
    if (!(err instanceof Conflict || err instanceof NotFound)) console.error("Maple nap follow failed:", err);
    return undefined;
  }
}

/** Put a followed nap's end back, only if nobody changed the nap since. */
async function restoreNap(
  fam: FamilyRef,
  nap: { id: number; ended_at: string; expect_updated_at: string },
  by?: string
): Promise<Pick<TimerResponse, "nap" | "nap_restored">> {
  try {
    const cur = await getEntry(fam, nap.id);
    if (!cur || cur.kind !== "sleep" || cur.active || !cur.ended_at) return { nap_restored: false };
    const entry = await updateEntry(fam, nap.id, { endedAt: new Date(nap.ended_at) }, by, { expectUpdatedAt: nap.expect_updated_at });
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
export async function adjustTimerStart(fam: FamilyRef, id: number, at: Date, by?: string): Promise<Entry> {
  if (Number.isNaN(at.getTime())) throw new Error("Start time must be a valid time");
  const e = await getEntry(fam, id);
  if (!e) throw new NotFound(`Timer ${id} not found`);
  if (e.kind === "feed") return (await retime(fam, id, { op: "move", edge: "start", to: at.toISOString() }, by, false)).entry;
  const now = Date.now();
  if (at.getTime() > now) throw new Error("Start time can't be in the future");
  if (at.getTime() < now - 12 * HOUR) throw new Error("That's more than 12 hours ago.");
  return (await mutateTimer(fam, id, (cur) => ({ data: cur.data, startedAt: at.toISOString() }), { by })).entry;
}

/**
 * Throw away a running timer (soft delete; Undo restores it). With
 * `expectUpdatedAt` (the start toast's Undo, sent with the start's answer),
 * only that version goes: if someone switched, paused or fixed it since,
 * 409 "changed" and nothing is thrown away.
 */
export async function discardTimer(fam: FamilyRef, id: number, by?: string, opts: { expectUpdatedAt?: string } = {}): Promise<Entry> {
  const familyId = famId(fam);
  // Already discarded is a 404 (who did it: discardedBy), never a 409 carrying the deleted row.
  const cur = await getEntry(familyId, id);
  if (!cur) throw new NotFound(`Timer ${id} not found`);
  if (!cur.active) throw new Conflict("That timer already stopped", cur);
  if (opts.expectUpdatedAt === undefined) return softDeleteEntry(familyId, id, by);
  if (!sameInstant(opts.expectUpdatedAt, cur.updated_at)) throw changed(cur);
  const rows = await q(
    `UPDATE maple_entries SET deleted_at = NOW(), updated_by = COALESCE($2, updated_by), updated_at = NOW()
     WHERE id = $1 AND family_id = $4 AND deleted_at IS NULL AND active
       AND updated_at BETWEEN $3::timestamptz - INTERVAL '1 millisecond' AND $3::timestamptz + INTERVAL '1 millisecond'
     RETURNING *`,
    [id, by ?? null, opts.expectUpdatedAt, familyId]
  );
  if (rows.length) {
    const entry = rowToEntry(rows[0]);
    nursingSoon(familyId, entry);
    return entry;
  }
  // Lost the race: stopped, discarded or changed in between.
  const now = await getEntry(familyId, id);
  if (!now) throw new NotFound(`Timer ${id} not found`);
  if (!now.active) throw new Conflict("That timer already stopped", now, "stopped");
  throw changed(now);
}

/**
 * Who discarded an entry, when `id` is a soft-deleted one (its updated_by,
 * which the delete wrote): for a 404 that can say "Brittany discarded this
 * feed". undefined when it isn't deleted (or doesn't exist).
 */
export async function discardedBy(fam: FamilyRef, id: number): Promise<string | null | undefined> {
  const rows = await q(`SELECT updated_by FROM maple_entries WHERE id = $1 AND family_id = $2 AND deleted_at IS NOT NULL`, [id, famId(fam)]);
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
 *
 * With `side`, the feed also carries on on that side, in the same write (the
 * dock's "Continue that feed on Right", "She's still on", "Same feed as
 * 8:30"), so no phone ever sees it reopened but not yet carried on:
 *   - ended at its pause (or a legacy trailing break): she goes back on at
 *     `at` (default now), a resume after the break with the resume's rules
 *     (clamped to the pause; the same side within a minute merges);
 *   - ended while running: the side she was on runs to the Done and she
 *     switches there; the same side just runs on (the Done is taken back).
 * `expectUpdatedAt`: only the finished feed this phone saw, else 409
 * "changed" and nothing is written. The answer's `before` is the finished
 * feed (with paused_at_stop), which a retime restore puts back exactly.
 */
export async function reopenTimerDetailed(fam: FamilyRef, id: number, by?: string, opts: { side?: StretchSide; at?: Date; expectUpdatedAt?: string } = {}): Promise<TimerResponse> {
  const now = new Date();
  const t = tapTime(opts.at, now);
  try {
    return await mutateTimer(fam, id, (e) => {
      if (e.active) return null;
      if (!["feed", "sleep", "tummy", "pump"].includes(e.kind)) throw new Error("Only a timer can be reopened");
      if (e.kind !== "feed") return { data: e.data, active: true, endedAt: null };
      const d = e.data as FeedData;
      if (!d.segments?.length) throw new Error("That feed wasn't timed, so it can't restart");
      const segs = d.segments.map((s) => ({ ...s }));
      const last = segs[segs.length - 1];
      // A side and a time after the Done ("Same feed as 9:09", from the new feed's start): she came off at the Done and
      // went back on then, so the gap is a break, not nursing nobody saw.
      // Within a minute of the Done (tapped Done, then her side, at once) there's no break to keep.
      const after = !!opts.side && opts.at !== undefined && !!e.ended_at && t.getTime() - Date.parse(e.ended_at) >= 60 * SEC;
      // Stopped at its pause (paused_at_stop): the last side stays closed. Otherwise
      // the side that ran to the stop reopens; a discarded-then-restored timer
      // never stopped (ended_at null), so its open side is still open.
      if (!d.paused_at_stop && !after && last.end && e.ended_at && Math.abs(Date.parse(last.end) - Date.parse(e.ended_at)) < NEAR) last.end = null;
      const rest: TapFeedData = { ...d, segments: segs };
      delete rest.left_sec;
      delete rest.right_sec;
      delete rest.both_sec;
      delete rest.paused_at_stop;
      delete rest.stopped_at;
      const side = opts.side;
      const open = openSegment(segs);
      if (!side || open?.side === side) return { data: rest, active: true, endedAt: null };
      // Carried on: the tap it records can't be taken back with undo_tap (that would leave it paused, not as Done
      // left it); the toast's Undo restores the finished feed instead.
      const carried = (x: FeedData) => {
        const tap = (x as TapFeedData).last_tap;
        if (tap) (x as TapFeedData).last_tap = { ...tap, carried: true };
        return x;
      };
      if (open) {
        // At the Done, which isn't a tap: the resume-side rule (a switch just after going back on) doesn't apply.
        delete rest.last_tap;
        const doneAt = e.ended_at ? new Date(e.ended_at) : t;
        const { data, noop: _noop, ...flags } = switchTo(rest, side, doneAt, { now, by });
        void _noop;
        return { data: carried(data), active: true, endedAt: null, flags };
      }
      const { data, noop: _noop, ...flags } = switchTo(rest, side, t, { explicit: opts.at !== undefined, resume: true, now, by });
      void _noop;
      return { data: carried(data), active: true, endedAt: null, flags };
    }, { by, allowFinished: true, expectUpdatedAt: opts.expectUpdatedAt });
  } catch (err) {
    if (!isUniqueViolation(err, "uniq_maple_entries_running")) throw err;
    const cur = await getEntry(fam, id);
    if (!cur) throw new NotFound(`Timer ${id} not found`);
    throw new Conflict("Another timer of that kind is running now", cur, "clash");
  }
}

/**
 * "Same feed as 8:30": a feed started a few minutes after the last one
 * ended (a Done by mistake, or she came back for more) is that feed going
 * on. One request: the new feed is set aside (only as this phone saw it,
 * marked joined_into so Recently removed doesn't offer it back as a stray)
 * and the old one is carried on, on `side`, from the new one's start. If
 * carrying on fails, the new one comes back as it was.
 */
export async function joinFeeds(fam: FamilyRef, newId: number, intoId: number, side: StretchSide, by: string | undefined, opts: { expectNew?: string; expectInto?: string } = {}): Promise<TimerResponse & { joined: Entry }> {
  const familyId = famId(fam);
  const cur = await getEntry(familyId, newId);
  if (!cur) throw new NotFound(`Timer ${newId} not found`);
  if (cur.kind !== "feed" || !cur.active) throw new Conflict("That feed already stopped", cur, "stopped");
  if (opts.expectNew !== undefined && !sameInstant(opts.expectNew, cur.updated_at)) throw changed(cur);
  // Joined as one side from its start: a feed that has switched or paused since has more to it than that.
  if (((cur.data as FeedData).segments?.length ?? 0) > 1) throw new Error("Only a feed still on its first side can be joined to the one before");
  const rows = await q(
    `UPDATE maple_entries SET deleted_at = NOW(), data = data || jsonb_build_object('joined_into', $3::bigint),
       updated_by = COALESCE($2, updated_by), updated_at = NOW()
     WHERE id = $1 AND family_id = $5 AND deleted_at IS NULL AND active
       AND updated_at BETWEEN $4::timestamptz - INTERVAL '1 millisecond' AND $4::timestamptz + INTERVAL '1 millisecond'
     RETURNING *`,
    [newId, by ?? null, intoId, cur.updated_at, familyId]
  );
  if (!rows.length) {
    const now = await getEntry(familyId, newId);
    if (!now) throw new NotFound(`Timer ${newId} not found`);
    throw now.active ? changed(now) : new Conflict("That feed already stopped", now, "stopped");
  }
  const joined = rowToEntry(rows[0]);
  try {
    const res = await reopenTimerDetailed(familyId, intoId, by, { side, at: new Date(cur.started_at), expectUpdatedAt: opts.expectInto });
    return { ...res, joined };
  } catch (err) {
    // Put the new one back exactly (still running), then say why.
    await q(`UPDATE maple_entries SET deleted_at = NULL, data = data - 'joined_into', updated_at = NOW() WHERE id = $1 AND family_id = $2`, [newId, familyId]);
    throw err;
  }
}

/** reopenTimerDetailed's entry. */
export async function reopenTimer(fam: FamilyRef, id: number, by?: string, opts: { side?: StretchSide; at?: Date; expectUpdatedAt?: string } = {}): Promise<Entry> {
  return (await reopenTimerDetailed(fam, id, by, opts)).entry;
}

// ── lifetime and presence ─────────────────────────────────────────────

/** How far back the app's entries reach (the state route's window): the brigade's week is split here. */
const LOADED_MS = 72 * 3600_000;

/**
 * Lifetime counts, and her firsts (the earliest poop, bath and finished tummy
 * time since she was born; an hour's slack for a birth time typed late), for
 * celebrations: the state only carries the last ~72h of entries. Also the
 * diaper brigade's week before that window (Lifetime.week), so "this week"
 * counts seven days, not three.
 */
export async function lifetimeCounts(fam: FamilyRef, babyId: number): Promise<Lifetime> {
  const familyId = famId(fam);
  const before = new Date(Date.now() - LOADED_MS);
  const [rows, week] = await Promise.all([
    q(
      `SELECT COUNT(*) FILTER (WHERE e.kind = 'diaper')::int AS diapers,
              COUNT(*) FILTER (WHERE e.kind = 'feed' AND NOT e.active)::int AS feeds,
              MIN(e.started_at) FILTER (WHERE e.kind = 'diaper' AND e.data->>'poop' = 'true' AND e.started_at >= b.born_at - INTERVAL '1 hour') AS first_poop,
              MIN(e.started_at) FILTER (WHERE e.kind = 'bath' AND e.started_at >= b.born_at - INTERVAL '1 hour') AS first_bath,
              MIN(e.started_at) FILTER (WHERE e.kind = 'tummy' AND NOT e.active AND e.started_at >= b.born_at - INTERVAL '1 hour') AS first_tummy
       FROM maple_entries e JOIN maple_babies b ON b.id = e.baby_id AND b.family_id = e.family_id
       WHERE e.family_id = $2 AND e.baby_id = $1 AND e.deleted_at IS NULL`,
      [babyId, familyId]
    ),
    // Diapers from 7 days ago up to `before`, per person; night = 10pm–6am in
    // her timezone. Best effort: without it the summary counts what's loaded.
    q(
      `SELECT e.created_by AS by, COUNT(*)::int AS diapers, COUNT(*) FILTER (WHERE l.hour >= 22 OR l.hour < 6)::int AS night
       FROM maple_entries e JOIN maple_babies b ON b.id = e.baby_id AND b.family_id = e.family_id,
            LATERAL (SELECT EXTRACT(HOUR FROM e.started_at AT TIME ZONE COALESCE(NULLIF(b.timezone, ''), 'America/New_York')) AS hour) l
       WHERE e.family_id = $3 AND e.baby_id = $1 AND e.deleted_at IS NULL AND e.kind = 'diaper'
         AND e.started_at > $2::timestamptz - INTERVAL '96 hours' AND e.started_at < $2::timestamptz
       GROUP BY e.created_by`,
      [babyId, before.toISOString(), familyId]
    ).catch((e) => {
      // Best effort (the card falls back to what's loaded), but never silent.
      void captureServerException(e, { where: "lifetimeCounts.week" });
      return null;
    }),
  ]);
  const r = rows[0];
  const at = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return {
    diapers: Number(r?.diapers ?? 0),
    feeds: Number(r?.feeds ?? 0),
    firsts: { poop: at(r?.first_poop), bath: at(r?.first_bath), tummy: at(r?.first_tummy) },
    ...(week && {
      week: {
        before: before.toISOString(),
        counts: week.map((w) => ({ by: w.by == null ? null : String(w.by), diapers: Number(w.diapers ?? 0), night: Number(w.night ?? 0) })),
      },
    }),
  };
}

/**
 * Mark a member as here now (at most once a minute) and return when they were
 * here before, for the "While you slept" recap.
 */
export async function touchLastSeen(fam: FamilyRef, id: string): Promise<string | null> {
  const familyId = famId(fam);
  const rows = await q(
    `WITH prev AS (SELECT last_seen_at FROM maple_members WHERE email = $1 AND family_id = $2)
     UPDATE maple_members SET last_seen_at = NOW()
     WHERE email = $1 AND family_id = $2 AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '1 minute')
     RETURNING (SELECT last_seen_at FROM prev) AS prev`,
    [id, familyId]
  );
  if (rows.length) return isoOrNull(rows[0].prev);
  const cur = await q(`SELECT last_seen_at FROM maple_members WHERE email = $1 AND family_id = $2`, [id, familyId]);
  return isoOrNull(cur[0]?.last_seen_at);
}

// ── personal tokens (iOS Shortcuts) ───────────────────────────────────

const sha256 = async (s: string) => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A member id with the family its row belongs to: what familyForRow resolves. */
export type FamilyMemberRow = { member: string; family_id: number };

export type PersonalToken = { id: number; label: string | null; created_at: string; last_used_at: string | null };

export async function createPersonalToken(fam: FamilyRef, member: string, label: string | null): Promise<{ token: string; record: PersonalToken }> {
  const token = `maple_${randomToken()}`;
  const rows = await q(
    `INSERT INTO maple_tokens (family_id, member, token_hash, label) VALUES ($4, $1, $2, $3)
     RETURNING id, label, created_at, last_used_at`,
    [member, await sha256(token), label, famId(fam)]
  );
  const r = rows[0];
  return {
    token,
    record: { id: Number(r.id), label: r.label == null ? null : String(r.label), created_at: isoOrNull(r.created_at)!, last_used_at: null },
  };
}

export async function listPersonalTokens(fam: FamilyRef, member: string): Promise<PersonalToken[]> {
  const rows = await q(
    `SELECT id, label, created_at, last_used_at FROM maple_tokens WHERE family_id = $2 AND member = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
    [member, famId(fam)]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    label: r.label == null ? null : String(r.label),
    created_at: isoOrNull(r.created_at)!,
    last_used_at: isoOrNull(r.last_used_at),
  }));
}

export async function revokePersonalToken(fam: FamilyRef, member: string, id: number): Promise<boolean> {
  const rows = await q(
    `UPDATE maple_tokens SET revoked_at = NOW() WHERE id = $1 AND family_id = $3 AND member = $2 AND revoked_at IS NULL RETURNING id`,
    [id, member, famId(fam)]
  );
  return rows.length > 0;
}

/** The member a personal token belongs to and its family (familyForRow resolves it), stamping last use; or null. */
export async function memberForPersonalToken(token: string): Promise<FamilyMemberRow | null> {
  if (!/^maple_[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const rows = await q(
    `UPDATE maple_tokens SET last_used_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING member, family_id`,
    [await sha256(token)]
  );
  const familyId = rows.length ? parseFamilyId(rows[0].family_id) : null;
  return familyId === null ? null : { member: String(rows[0].member), family_id: familyId };
}

// ── change token for cheap polling ────────────────────────────────────

export async function rev(fam: FamilyRef, babyId: number): Promise<string> {
  const rows = await q(
    `SELECT
       (SELECT COALESCE(MAX(updated_at)::text, '') || '/' || COUNT(*) FROM maple_entries WHERE family_id = $2 AND baby_id = $1) AS e,
       (SELECT COALESCE(updated_at::text, '') FROM maple_babies WHERE id = $1 AND family_id = $2) AS b,
       (SELECT COALESCE(MAX(updated_at)::text, '') || '/' || COUNT(*) FROM maple_members WHERE family_id = $2) AS m`,
    [babyId, famId(fam)]
  );
  const r = rows[0] ?? {};
  // The hour too: a full state at least hourly, so the server's older-week diaper count (lifetime.week) never goes
  // stale while nobody logs anything.
  return `${r.e}|${r.b}|${r.m}|${Math.floor(Date.now() / 3600_000)}`;
}
