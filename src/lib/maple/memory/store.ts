import { createHash } from "node:crypto";
import { query, transaction, type Statement } from "@/lib/db";
import type { FamilyScope } from "../family";
import { StoreUnavailable } from "../store";
import { dayKey } from "../time";
import type { MemoryContext } from "./policy";
import { normalFact, type MemoryInput, type MemoryRecord, type MemoryState, type MemoryVia } from "./types";

/**
 * A family's memories (memory/schema.ts). Every query names the family, so
 * another family's memory reads exactly like one that isn't there.
 *
 * Writes run as one Neon transaction that first takes the family's
 * maple_memory_state row (FOR UPDATE), so one family's memory writes happen
 * one at a time and each sees the last one's result: a Forget can't miss a
 * correction made at the same moment. Each write checks, in SQL, what it
 * rests on: an edit names the memory's revision (a stale one is refused
 * with the memory as it is now), an assistant's write needs saving switched
 * on, and a chat turn's write needs the epoch it started with (a Forget or a
 * switch change since then refuses it, so the turn can't save back what it
 * read before).
 */

type Fam = Pick<FamilyScope, "familyId">;

export type MemoryRefusal = "changed" | "missing" | "duplicate" | "epoch" | "capture";

export class MemoryRefused extends Error {
  constructor(
    readonly code: MemoryRefusal,
    /** The memory as it is now: the one an edit lost a race to, or the one a correction would duplicate. */
    readonly current: MemoryRecord | null = null
  ) {
    super(code);
    this.name = "MemoryRefused";
  }
}

/** Who is writing, from where, and what the write is checked against. */
export type MemoryActor = {
  member: string;
  via: MemoryVia;
  /** A model wrote it (the chat or a connected app): refused while saving from chats is off. */
  assistant: boolean;
  /** A chat turn's starting epoch; null when nothing fences it (Settings, a connected app). */
  epoch: number | null;
};

/** What a new memory or a new version rests on. */
export type MemorySource = { text: string | null; words: boolean };

async function rows(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const r = await query(sql, params);
  if (r === null) throw new StoreUnavailable();
  return r as Record<string, unknown>[];
}

/** Runs `statement` holding the family's memory lock (making its state row on first use); returns its rows. */
async function locked(fam: Fam, statement: Statement): Promise<Record<string, unknown>[]> {
  const r = await transaction([
    { sql: `INSERT INTO maple_memory_state (family_id) VALUES ($1) ON CONFLICT (family_id) DO NOTHING`, params: [fam.familyId] },
    { sql: `SELECT family_id FROM maple_memory_state WHERE family_id = $1 FOR UPDATE`, params: [fam.familyId] },
    statement,
  ]);
  if (r === null) throw new StoreUnavailable();
  return r[2] as Record<string, unknown>[];
}

export const factKey = (fact: string) => createHash("sha256").update(normalFact(fact)).digest("hex");

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const isoOrNull = (v: unknown) => (v == null ? null : iso(v));
const textOrNull = (v: unknown) => (v == null ? null : String(v));

const COLUMNS = `id, kind, fact, reason, status, valid_from, valid_to, review_on, revision, predecessor_id, said_by, via,
  source_text, source_words, stated_at, ended_at, ended_by, ended_via, updated_at`;

export function rowToMemory(r: Record<string, unknown>): MemoryRecord {
  return {
    id: Number(r.id),
    kind: String(r.kind) as MemoryRecord["kind"],
    fact: String(r.fact),
    reason: textOrNull(r.reason),
    status: String(r.status) as MemoryRecord["status"],
    valid_from: textOrNull(r.valid_from),
    valid_to: textOrNull(r.valid_to),
    review_on: textOrNull(r.review_on),
    revision: Number(r.revision),
    predecessor_id: r.predecessor_id == null ? null : Number(r.predecessor_id),
    said_by: textOrNull(r.said_by),
    via: String(r.via) as MemoryVia,
    source_text: textOrNull(r.source_text),
    source_words: r.source_words === true,
    stated_at: iso(r.stated_at),
    ended_at: isoOrNull(r.ended_at),
    ended_by: textOrNull(r.ended_by),
    ended_via: (textOrNull(r.ended_via) as MemoryVia | null) ?? null,
    updated_at: iso(r.updated_at),
  };
}

const DEFAULT_STATE: MemoryState = { revision: 0, epoch: 0, capture: true, use: true };

export async function memoryState(fam: Fam): Promise<MemoryState> {
  const r = await rows(`SELECT revision, epoch, capture_enabled, use_enabled FROM maple_memory_state WHERE family_id = $1`, [fam.familyId]);
  return r.length ? { revision: Number(r[0].revision), epoch: Number(r[0].epoch), capture: r[0].capture_enabled !== false, use: r[0].use_enabled !== false } : DEFAULT_STATE;
}

/** A family's memories, newest first: the current ones (active, including any whose last day passed), or every version too. */
export async function listMemories(fam: Fam, opts: { history?: boolean; limit?: number } = {}): Promise<MemoryRecord[]> {
  const r = await rows(
    `SELECT ${COLUMNS} FROM maple_memories WHERE family_id = $1 AND ($2::boolean OR status = 'active') ORDER BY stated_at DESC, id DESC LIMIT $3`,
    [fam.familyId, !!opts.history, opts.limit ?? 300]
  );
  return r.map(rowToMemory);
}

export async function getMemory(fam: Fam, id: number): Promise<MemoryRecord | null> {
  const r = await rows(`SELECT ${COLUMNS} FROM maple_memories WHERE family_id = $1 AND id = $2`, [fam.familyId, id]);
  return r.length ? rowToMemory(r[0]) : null;
}

/** What an assistant reads: the switches, today in the family's clock, and the active memories. */
export async function memoryContext(fam: Fam, opts: { now: Date; tz: string }): Promise<MemoryContext> {
  const [state, records] = await Promise.all([memoryState(fam), listMemories(fam)]);
  return { state, today: dayKey(opts.now, opts.tz), tz: opts.tz, records: state.use ? records : [] };
}

/** The checks every assistant write starts with: its epoch, then saving switched on. */
function refusedCte(epochParam: number, captureParam: number): string {
  return `st AS (SELECT epoch, capture_enabled FROM maple_memory_state WHERE family_id = $1),
  refused AS (SELECT CASE WHEN $${epochParam}::int IS NOT NULL AND st.epoch <> $${epochParam}::int THEN 'epoch'
    WHEN $${captureParam}::boolean AND NOT st.capture_enabled THEN 'capture' END AS why FROM st)`;
}

function refusal(r: Record<string, unknown> | undefined): MemoryRefusal | null {
  const why = r?.refused;
  return why === "epoch" || why === "capture" ? why : null;
}

/**
 * Saves a new memory, or confirms the current one that already says the same
 * thing ("supported", which changes nothing the family sees).
 */
export async function saveMemory(fam: Fam, input: MemoryInput, actor: MemoryActor, source: MemorySource): Promise<{ status: "saved" | "supported"; memory: MemoryRecord }> {
  const r = await locked(fam, {
    sql: `WITH ${refusedCte(13, 14)},
    existing AS (SELECT id FROM maple_memories WHERE family_id = $1 AND fact_key = $4 AND status = 'active'),
    saved AS (
      INSERT INTO maple_memories (family_id, kind, fact, fact_key, reason, valid_from, valid_to, review_on, said_by, via, source_text, source_words)
      SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
      WHERE (SELECT why FROM refused) IS NULL AND NOT EXISTS (SELECT 1 FROM existing)
      RETURNING id
    ),
    confirmed AS (
      UPDATE maple_memories SET confirmed_at = NOW() WHERE family_id = $1 AND id IN (SELECT id FROM existing) AND (SELECT why FROM refused) IS NULL RETURNING id
    ),
    bumped AS (
      UPDATE maple_memory_state SET revision = revision + 1, updated_at = NOW() WHERE family_id = $1 AND EXISTS (SELECT 1 FROM saved) RETURNING revision
    )
    SELECT (SELECT why FROM refused) AS refused, (SELECT id FROM saved) AS saved, (SELECT id FROM confirmed) AS confirmed`,
    params: [
      fam.familyId, input.kind, input.fact, factKey(input.fact), input.reason, input.valid_from, input.valid_to, input.review_on,
      actor.member, actor.via, source.text, source.words, actor.epoch, actor.assistant,
    ],
  });
  const why = refusal(r[0]);
  if (why) throw new MemoryRefused(why);
  const id = Number(r[0]?.saved ?? r[0]?.confirmed);
  const memory = Number.isSafeInteger(id) ? await getMemory(fam, id) : null;
  if (!memory) throw new MemoryRefused("missing");
  return { status: r[0]?.saved != null ? "saved" : "supported", memory };
}

/**
 * Replaces memory `id` at `revision` with a new version: the old one stays
 * as history (superseded), the new one points at it. Refused when the
 * memory changed since that revision, is gone or no longer current, or when
 * another current memory already says the new text.
 */
export async function correctMemory(
  fam: Fam,
  target: { id: number; revision: number },
  input: MemoryInput,
  actor: MemoryActor,
  source: MemorySource
): Promise<{ memory: MemoryRecord; previous: MemoryRecord }> {
  const r = await locked(fam, {
    sql: `WITH ${refusedCte(15, 16)},
    dupe AS (SELECT id FROM maple_memories WHERE family_id = $1 AND fact_key = $5 AND status = 'active' AND id <> $2),
    old AS (
      UPDATE maple_memories SET status = 'superseded', revision = revision + 1, ended_at = NOW(), ended_by = $11, ended_via = $12, updated_at = NOW()
      WHERE family_id = $1 AND id = $2 AND status = 'active' AND revision = $3
        AND (SELECT why FROM refused) IS NULL AND NOT EXISTS (SELECT 1 FROM dupe)
      RETURNING id
    ),
    made AS (
      INSERT INTO maple_memories (family_id, kind, fact, fact_key, reason, valid_from, valid_to, review_on, said_by, via, source_text, source_words, predecessor_id)
      SELECT $1, $4, $6, $5, $7, $8, $9, $10, $11, $12, $13, $14, old.id FROM old
      RETURNING id
    ),
    bumped AS (
      UPDATE maple_memory_state SET revision = revision + 1, updated_at = NOW() WHERE family_id = $1 AND EXISTS (SELECT 1 FROM made) RETURNING revision
    )
    SELECT (SELECT why FROM refused) AS refused, (SELECT id FROM dupe LIMIT 1) AS duplicate, (SELECT id FROM made) AS made`,
    params: [
      fam.familyId, target.id, target.revision, input.kind, factKey(input.fact), input.fact, input.reason, input.valid_from, input.valid_to,
      input.review_on, actor.member, actor.via, source.text, source.words, actor.epoch, actor.assistant,
    ],
  });
  const why = refusal(r[0]);
  if (why) throw new MemoryRefused(why);
  if (r[0]?.made == null) {
    if (r[0]?.duplicate != null) throw new MemoryRefused("duplicate", await getMemory(fam, Number(r[0].duplicate)));
    throw await lostRace(fam, target.id);
  }
  const [memory, previous] = await Promise.all([getMemory(fam, Number(r[0].made)), getMemory(fam, target.id)]);
  if (!memory || !previous) throw new MemoryRefused("missing");
  return { memory, previous };
}

/** The refusal for an edit that found nothing to change: the memory moved on, or isn't there. */
async function lostRace(fam: Fam, id: number): Promise<MemoryRefused> {
  const current = await getMemory(fam, id);
  return new MemoryRefused(current ? "changed" : "missing", current);
}

/** Ends memory `id` at `revision`: resolved (it's over) or archived (set aside). It stays as history until forgotten. */
export async function endMemory(fam: Fam, target: { id: number; revision: number }, as: "resolved" | "archived", actor: MemoryActor): Promise<MemoryRecord> {
  const r = await locked(fam, {
    sql: `WITH ${refusedCte(7, 8)},
    ended AS (
      UPDATE maple_memories SET status = $4, revision = revision + 1, ended_at = NOW(), ended_by = $5, ended_via = $6, updated_at = NOW()
      WHERE family_id = $1 AND id = $2 AND status = 'active' AND revision = $3 AND (SELECT why FROM refused) IS NULL
      RETURNING id
    ),
    bumped AS (
      UPDATE maple_memory_state SET revision = revision + 1, updated_at = NOW() WHERE family_id = $1 AND EXISTS (SELECT 1 FROM ended) RETURNING revision
    )
    SELECT (SELECT why FROM refused) AS refused, (SELECT id FROM ended) AS ended`,
    params: [fam.familyId, target.id, target.revision, as, actor.member, actor.via, actor.epoch, actor.assistant],
  });
  const why = refusal(r[0]);
  if (why) throw new MemoryRefused(why);
  if (r[0]?.ended == null) throw await lostRace(fam, target.id);
  const memory = await getMemory(fam, target.id);
  if (!memory) throw new MemoryRefused("missing");
  return memory;
}

/**
 * Forget: deletes memory `id` with every version of it (what it replaced and
 * what replaced it), or all of the family's memories. It then moves the epoch
 * (a chat turn already running can't save it back) and the forget floor:
 * chat messages from before now stay on the phone but never go to the model
 * again, in anyone's chat in this family. Returns how many versions went.
 */
export async function forgetMemories(fam: Fam, target: { id: number } | { all: true }): Promise<number> {
  const all = "all" in target;
  const r = await locked(fam, {
    sql: `WITH RECURSIVE chain(id, predecessor_id) AS (
      SELECT id, predecessor_id FROM maple_memories WHERE family_id = $1 AND ($3::boolean OR id = $2::bigint)
      UNION
      SELECT m.id, m.predecessor_id FROM maple_memories m JOIN chain c ON m.id = c.predecessor_id OR m.predecessor_id = c.id
      WHERE m.family_id = $1
    ),
    gone AS (DELETE FROM maple_memories WHERE family_id = $1 AND id IN (SELECT id FROM chain) RETURNING id),
    bumped AS (
      UPDATE maple_memory_state SET revision = revision + 1, epoch = epoch + 1, forget_floor = NOW(), updated_at = NOW()
      WHERE family_id = $1 AND EXISTS (SELECT 1 FROM gone) RETURNING revision
    )
    SELECT COUNT(*) AS forgotten FROM gone`,
    params: [fam.familyId, all ? null : target.id, all],
  });
  return Number(r[0]?.forgotten ?? 0);
}

/** The family's switches. Changing one moves the epoch, so a chat turn that started under the old ones writes nothing. */
export async function setMemorySwitches(fam: Fam, change: { capture?: boolean; use?: boolean }): Promise<MemoryState> {
  const r = await locked(fam, {
    sql: `UPDATE maple_memory_state SET capture_enabled = COALESCE($2::boolean, capture_enabled), use_enabled = COALESCE($3::boolean, use_enabled),
      revision = revision + 1, epoch = epoch + 1, updated_at = NOW()
      WHERE family_id = $1 RETURNING revision, epoch, capture_enabled, use_enabled`,
    params: [fam.familyId, change.capture ?? null, change.use ?? null],
  });
  return { revision: Number(r[0].revision), epoch: Number(r[0].epoch), capture: r[0].capture_enabled !== false, use: r[0].use_enabled !== false };
}

/**
 * A member deleted their chat history: their words quoted from that chat
 * go too. The memories stay; they're the family's, and Settings shows them.
 */
export async function forgetChatWords(fam: Fam, member: string): Promise<void> {
  await rows(
    `WITH scrubbed AS (
      UPDATE maple_memories SET source_text = NULL, source_words = FALSE, updated_at = NOW()
      WHERE family_id = $1 AND said_by = $2 AND via = 'chat' AND source_text IS NOT NULL RETURNING id
    ) UPDATE maple_memory_state SET revision = revision + 1, updated_at = NOW() WHERE family_id = $1 AND EXISTS (SELECT 1 FROM scrubbed)`,
    [fam.familyId, member]
  );
}

/** This thread's messages from before the family's last Forget (the newest ones a turn reads), which never go to the model again. */
export async function forgottenMessageIds(fam: Fam, threadId: string): Promise<string[]> {
  const r = await rows(
    `SELECT m.id FROM maple_chat_messages m JOIN maple_memory_state s ON s.family_id = m.family_id
     WHERE m.thread_id = $1 AND m.family_id = $2 AND s.forget_floor IS NOT NULL AND m.created_at <= s.forget_floor
     ORDER BY m.seq DESC LIMIT 60`,
    [threadId, fam.familyId]
  );
  return r.map((m) => String(m.id));
}
