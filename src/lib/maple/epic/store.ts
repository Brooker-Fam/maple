import { createHash } from "node:crypto";
import { query, transaction, type Row, type Statement } from "@/lib/db";
import { ACCEPTED_MEMBERSHIP, parseFamilyId, type FamilyCtx } from "../family";
import { cleanData } from "../validate";
import type { GrowthMeasurement } from "./fhir";

export class EpicStoreError extends Error {
  readonly code: "forbidden" | "expired" | "unavailable" | "invalid";
  constructor(public readonly reason: "forbidden" | "expired" | "unavailable" | "invalid") {
    super(`epic_store_${reason}`);
    this.code = reason;
  }
}

export type Pending = {
  id: string;
  babyId: number;
  providerId: string;
  sealed: string;
  expiresAt: string;
};

const OWNER = `EXISTS (SELECT 1 FROM maple_members m JOIN maple_families f ON f.id = m.family_id
  WHERE m.family_id = $1 AND m.email = $2 AND m.role = 'owner' AND f.status = 'active'
    AND ${ACCEPTED_MEMBERSHIP("m")})`;

function context(ctx: FamilyCtx): [number, string] {
  if (parseFamilyId(ctx.familyId) === null || !ctx.member || ctx.role !== "owner" || ctx.status !== "active") {
    throw new EpicStoreError("forbidden");
  }
  return [ctx.familyId, ctx.member];
}

async function read(sql: string, params: unknown[]): Promise<Row[]> {
  const rows = await query(sql, params);
  if (rows === null) throw new EpicStoreError("unavailable");
  return rows;
}

/** All changes for an owner serialize, including a slow callback racing Discard or a new connection. */
async function write(ctx: FamilyCtx, statements: Statement[]): Promise<Row[][]> {
  const params = context(ctx);
  const results = await transaction([
    { sql: `SELECT m.email FROM maple_members m JOIN maple_families f ON f.id = m.family_id
      WHERE m.family_id = $1 AND m.email = $2 AND m.role = 'owner' AND f.status = 'active'
      AND ${ACCEPTED_MEMBERSHIP("m")} FOR UPDATE OF m`, params },
    ...statements,
  ]);
  if (results === null) throw new EpicStoreError("unavailable");
  if (!results[0].length) throw new EpicStoreError("forbidden");
  return results.slice(1);
}

function boundedSealed(sealed: string): void {
  if (!sealed || sealed.length > 1_500_000) throw new EpicStoreError("invalid");
}

function expiry(expiresAt: string): string {
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms) || ms <= Date.now() || ms > Date.now() + 15 * 60_000 + 1000) throw new EpicStoreError("invalid");
  return new Date(ms).toISOString();
}

export async function cleanupExpired(): Promise<void> {
  const results = await transaction([
    { sql: `DELETE FROM maple_epic_attempts WHERE expires_at <= clock_timestamp()` },
    { sql: `DELETE FROM maple_epic_pending WHERE expires_at <= clock_timestamp()` },
  ]);
  if (results === null) throw new EpicStoreError("unavailable");
}

export async function saveAttempt(ctx: FamilyCtx, attempt: { stateHash: string; browserHash: string; sealed: string; expiresAt: string }): Promise<void> {
  const params = context(ctx);
  boundedSealed(attempt.sealed);
  if (!/^[a-f0-9]{64}$/.test(attempt.stateHash) || !/^[a-f0-9]{64}$/.test(attempt.browserHash)) throw new EpicStoreError("invalid");
  await write(ctx, [
    // Match cleanup/discard's lock order: attempts before pending reviews.
    { sql: `INSERT INTO maple_epic_attempts (family_id, member, state_hash, browser_hash, sealed_payload, expires_at)
        SELECT $1, $2, $3, $4, $5, $6::timestamptz WHERE ${OWNER}
        ON CONFLICT (family_id, member) DO UPDATE SET state_hash = EXCLUDED.state_hash,
        browser_hash = EXCLUDED.browser_hash, sealed_payload = EXCLUDED.sealed_payload,
        expires_at = EXCLUDED.expires_at, consumed_at = NULL`,
      params: [...params, attempt.stateHash, attempt.browserHash, attempt.sealed, expiry(attempt.expiresAt)] },
    { sql: `DELETE FROM maple_epic_pending WHERE family_id = $1 AND member = $2 AND ${OWNER}`, params },
  ]);
}

/** A wrong browser, family or session never consumes the legitimate attempt. */
export async function takeAttempt(ctx: FamilyCtx, stateHash: string, browserHash: string): Promise<string | null> {
  const params = context(ctx);
  const [rows] = await write(ctx, [{ sql: `UPDATE maple_epic_attempts SET consumed_at = NOW()
      WHERE family_id = $1 AND member = $2 AND state_hash = $3 AND browser_hash = $4
      AND consumed_at IS NULL AND expires_at > clock_timestamp() AND ${OWNER} RETURNING sealed_payload`,
    params: [...params, stateHash, browserHash] }]);
  return rows.length ? String(rows[0].sealed_payload) : null;
}

/** Callback cleanup never discards a newer tab's attempt or an established review. */
export async function clearAttempt(ctx: FamilyCtx, stateHash: string): Promise<void> {
  const params = context(ctx);
  await write(ctx, [{ sql: `DELETE FROM maple_epic_attempts
    WHERE family_id = $1 AND member = $2 AND state_hash = $3 AND ${OWNER}`, params: [...params, stateHash] }]);
}

/** Requires the consumed attempt still to exist: a late OAuth callback cannot undo Discard. */
export async function putPending(ctx: FamilyCtx, pending: Pending & { attemptHash: string }): Promise<void> {
  const params = context(ctx);
  boundedSealed(pending.sealed);
  if (!pending.id || pending.id.length > 128 || pending.babyId !== ctx.babyId || !["sandbox", "albany-med"].includes(pending.providerId)) throw new EpicStoreError("invalid");
  const [rows] = await write(ctx, [{ sql: `WITH attempt AS (
      DELETE FROM maple_epic_attempts WHERE family_id = $1 AND member = $2 AND state_hash = $3
        AND consumed_at IS NOT NULL AND expires_at > clock_timestamp() AND ${OWNER}
        AND EXISTS (SELECT 1 FROM maple_babies WHERE family_id = $1 AND id = $5 AND archived_at IS NULL)
      RETURNING family_id, member
    ) INSERT INTO maple_epic_pending (family_id, member, id, baby_id, provider_id, sealed_payload, expires_at)
      SELECT family_id, member, $4, $5, $6, $7, $8::timestamptz FROM attempt
      ON CONFLICT (family_id, member) DO UPDATE SET id = EXCLUDED.id, baby_id = EXCLUDED.baby_id,
        provider_id = EXCLUDED.provider_id, sealed_payload = EXCLUDED.sealed_payload, expires_at = EXCLUDED.expires_at
      RETURNING id`,
    params: [...params, pending.attemptHash, pending.id, pending.babyId, pending.providerId, pending.sealed, expiry(pending.expiresAt)] }]);
  if (!rows.length) throw new EpicStoreError("expired");
}

export async function getPending(ctx: FamilyCtx): Promise<Pending | null> {
  const params = context(ctx);
  const rows = await read(`SELECT id, baby_id, provider_id, sealed_payload, expires_at FROM maple_epic_pending
    WHERE family_id = $1 AND member = $2 AND baby_id = $3 AND expires_at > clock_timestamp() AND ${OWNER}`,
  [...params, ctx.babyId]);
  if (!rows.length) return null;
  const r = rows[0];
  return { id: String(r.id), babyId: Number(r.baby_id), providerId: String(r.provider_id), sealed: String(r.sealed_payload), expiresAt: new Date(r.expires_at as string).toISOString() };
}

/** A review completing after replacement/discard must not restore the previous pending connection. */
export async function replacePending(ctx: FamilyCtx, id: string, previousSealed: string, sealed: string): Promise<boolean> {
  const params = context(ctx);
  boundedSealed(sealed);
  const [rows] = await write(ctx, [{ sql: `UPDATE maple_epic_pending SET sealed_payload = $5
    WHERE family_id = $1 AND member = $2 AND id = $3 AND sealed_payload = $4 AND expires_at > clock_timestamp()
      AND baby_id = $6 AND ${OWNER} RETURNING id`, params: [...params, id, previousSealed, sealed, ctx.babyId] }]);
  return rows.length > 0;
}

function discardStatements(params: [number, string]): Statement[] {
  return [
    { sql: `DELETE FROM maple_epic_attempts WHERE family_id = $1 AND member = $2 AND ${OWNER}`, params },
    { sql: `DELETE FROM maple_epic_pending WHERE family_id = $1 AND member = $2 AND ${OWNER}`, params },
  ];
}

export async function discardPending(ctx: FamilyCtx, expectedPendingId?: string): Promise<void> {
  const params = context(ctx);
  if (expectedPendingId !== undefined) {
    await write(ctx, [{ sql: `DELETE FROM maple_epic_pending
      WHERE family_id = $1 AND member = $2 AND id = $3 AND ${OWNER}`, params: [...params, expectedPendingId] }]);
    return;
  }
  await write(ctx, discardStatements(params));
}

export async function stats(ctx: FamilyCtx): Promise<{ importedCount: number; lastImportedAt: string | null }> {
  const params = context(ctx);
  const [row] = await read(`SELECT COUNT(*) AS n, MAX(i.imported_at) AS last
    FROM maple_epic_imports i JOIN maple_entries e ON e.id = i.entry_id AND e.family_id = i.family_id
    WHERE i.family_id = $1 AND i.member = $2 AND i.baby_id = $3 AND ${OWNER}`,
  [...params, ctx.babyId]);
  return { importedCount: Number(row?.n ?? 0), lastImportedAt: row?.last ? new Date(row.last as string).toISOString() : null };
}

/** The same source Observation remains deduplicated even when its log entry is soft-deleted. */
export function importClientId(providerId: string, patientId: string, observationId: string, familyId: number): string {
  // The legacy schema still has a global client_id index alongside the family index.
  return `epic:${createHash("sha256").update(JSON.stringify([familyId, providerId, patientId, observationId])).digest("hex")}`;
}

export async function importMeasurements(ctx: FamilyCtx, input: {
  pending: Pending; patientId: string; expectedBirthDate: string; providerName: string; measurements: GrowthMeasurement[];
}): Promise<{ imported: number; duplicates: number }> {
  const params = context(ctx);
  const { pending, measurements } = input;
  // Synthetic data can be previewed, but cannot enter a family's real log.
  if (pending.providerId !== "albany-med" || pending.babyId !== ctx.babyId || !/^[A-Za-z0-9.-]{1,64}$/.test(input.patientId)
    || !/^\d{4}-\d{2}-\d{2}$/.test(input.expectedBirthDate)
    || !measurements.length || measurements.length > 2000) throw new EpicStoreError("invalid");
  const seen = new Set<string>();
  const records = measurements.map((m) => {
    if (!m.id || seen.has(m.id) || m.id.length > 128 || !Number.isFinite(Date.parse(m.measuredAt))
      || !Number.isFinite(m.originalValue) || m.originalUnit.length > 40 || m.originalDate.length > 64) throw new EpicStoreError("invalid");
    seen.add(m.id);
    return { client_id: importClientId(pending.providerId, input.patientId, m.id, ctx.familyId),
      started_at: new Date(m.measuredAt).toISOString(), data: cleanData("growth", { ...m.data, at: "doctor" }),
      note: `Imported from Albany Med Health System. Measured ${m.originalDate}: ${m.originalValue} ${m.originalUnit}.` };
  });
  const [, rows] = await write(ctx, [
    // A separate statement after acquiring this lock sees any edit that was already in flight.
    // Holding SHARE prevents born_at/timezone changes until the validated import commits.
    { sql: `SELECT id FROM maple_babies WHERE family_id = $1 AND id = $3 AND ${OWNER} FOR SHARE`, params: [...params, pending.babyId] },
    { sql: `WITH consumed AS (
      DELETE FROM maple_epic_pending WHERE family_id = $1 AND member = $2 AND id = $3
        AND baby_id = $4 AND provider_id = $5 AND sealed_payload = $6 AND expires_at > clock_timestamp() AND ${OWNER}
        AND EXISTS (SELECT 1 FROM maple_babies b WHERE b.family_id = $1 AND b.id = $4 AND b.archived_at IS NULL
          AND to_char(b.born_at AT TIME ZONE b.timezone, 'YYYY-MM-DD') = $8
          AND b.id = (SELECT MIN(id) FROM maple_babies WHERE family_id = $1 AND archived_at IS NULL))
      RETURNING family_id, member, baby_id
    ), inserted AS (
      INSERT INTO maple_entries (family_id, baby_id, kind, started_at, data, note, created_by, source, client_id)
      SELECT c.family_id, c.baby_id, 'growth', r.started_at, r.data, r.note, c.member, 'epic', r.client_id
      FROM consumed c CROSS JOIN jsonb_to_recordset($7::jsonb) AS r(client_id text, started_at timestamptz, data jsonb, note text)
      ON CONFLICT (family_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
      RETURNING id, family_id, baby_id, created_by
    ), tracked AS (
      INSERT INTO maple_epic_imports (family_id, member, baby_id, entry_id)
      SELECT family_id, created_by, baby_id, id FROM inserted RETURNING entry_id
    ) SELECT (SELECT COUNT(*) FROM consumed) AS consumed, (SELECT COUNT(*) FROM tracked) AS imported`,
    params: [...params, pending.id, pending.babyId, pending.providerId, pending.sealed, JSON.stringify(records), input.expectedBirthDate] }]);
  if (!Number(rows[0]?.consumed)) throw new EpicStoreError("expired");
  const imported = Number(rows[0].imported);
  return { imported, duplicates: records.length - imported };
}

/** Remove this owner's imported copies, including soft-deleted points, without touching home entries. */
export async function removeImports(ctx: FamilyCtx): Promise<number> {
  const params = context(ctx);
  const results = await write(ctx, [
    ...discardStatements(params),
    { sql: `DELETE FROM maple_entries e USING maple_epic_imports i
      WHERE i.family_id = $1 AND i.member = $2 AND i.baby_id = $3
        AND e.id = i.entry_id AND e.family_id = i.family_id AND ${OWNER} RETURNING e.id`,
    params: [...params, ctx.babyId] },
  ]);
  return results[2].length;
}
