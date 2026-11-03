import { query } from "@/lib/db";
import type { FamilyCtx } from "@/lib/maple/family";
import { StoreUnavailable } from "@/lib/maple/store";
import type { Member } from "@/lib/maple/types";
import { captureServerException } from "@/lib/posthog-server";

/**
 * What "Maple undo" may take back (./sleep.ts undo): the speaker's newest
 * Siri action, kept by the action itself on the speaker's Siri keys in the
 * family (maple_tokens.last_act, the same on each of their live keys), with
 * every row it wrote as it left it (table, id, updated_at). Undo acts on
 * that action only, and only while each row it takes back is still as it
 * was left: a newer change by anyone to that row, an app edit of a finished
 * nap included, is never read as something Siri did, and nothing older is
 * ever reached past it.
 *
 * Every Siri write keeps one, the ones Undo can't take back too (a side
 * switch: `other`), and so does an Undo (`undo`), so saying it twice takes
 * back one thing. Her page's doses aren't kept here (Undo reads her page's
 * own rows for those, and never takes one back). The next Siri action
 * replaces it; it names rows, never what's in them.
 */

/** A row a Siri action wrote, as it left it: its table, its id, and its updated_at then (ISO, ms). */
export type Wrote = { t: "entry" | "try" | "shift" | "checkin"; id: number; u: string };

/**
 * What Undo does with an action: put_down (the try goes, with the sleep it
 * made, and the holding turn it ended opens again), outcome (the try runs
 * again, with the sleep it stopped), ask (nobody is asked), handoff (the one
 * who handed over has her again), checkin (a new one goes), entry (what Siri
 * logged goes, and a timer it stopped as it started runs again), stop (the
 * timer runs again). `other`: a change with no voice Undo (a side switch,
 * going back and forth). `undo`: an Undo itself.
 */
export const ACT_KINDS = ["put_down", "outcome", "ask", "handoff", "checkin", "entry", "stop", "other", "undo"] as const;
export type ActKind = (typeof ACT_KINDS)[number];

/** `at`: when it was done (ms), by the database's clock, so it compares with the rows' own updated_at. */
export type SiriAct = { kind: ActKind; at: number; rows: Wrote[] };

/** A written row, for rememberAct (null: nothing written there). */
export const wrote = (t: Wrote["t"], row: { id: number; updated_at: string } | null | undefined): Wrote | null => (row ? { t, id: row.id, u: row.updated_at } : null);

/** Two updated_at values (JS ms and Postgres µs) that name the same write. */
export const sameWrite = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && Math.abs(Date.parse(a) - Date.parse(b)) <= 1;

/**
 * A timer the action changed (a stop or a switch), for rememberAct: `after`
 * isn't `before` any more and `by` made its newest change. Null when the
 * write found it already changed by someone else (another phone stopped it
 * first): nothing of the action's is there to take back.
 */
export const changedBy = (after: { id: number; updated_at: string; updated_by: string | null } | null | undefined, before: { updated_at: string } | null | undefined, by: string): Wrote | null =>
  after && after.updated_by === by && (!before || !sameWrite(after.updated_at, before.updated_at)) ? wrote("entry", after) : null;

/**
 * Keep `kind` as the speaker's newest Siri action, with the rows it wrote
 * (the first is the one it's about). `at` is the newest of their updated_at,
 * or the one given (an Undo keeps the time of what it took back, so the
 * changes it made read as newer than it). Never fails the action it follows:
 * a write that didn't land leaves the one before it, which Undo then finds
 * changed since, or behind a newer change of theirs.
 */
export async function rememberAct(c: { fam: FamilyCtx; me: Member }, kind: ActKind, rows: readonly (Wrote | null | undefined | false)[], at?: number): Promise<void> {
  const kept = rows.filter((r): r is Wrote => !!r);
  const when = at ?? Math.max(0, ...kept.map((r) => Date.parse(r.u)).filter(Number.isFinite));
  try {
    const r = await query(`UPDATE maple_tokens SET last_act = $3::jsonb WHERE family_id = $1 AND member = $2 AND revoked_at IS NULL`, [
      c.fam.familyId,
      c.me.email,
      JSON.stringify({ kind, at: when || Date.now(), rows: kept }),
    ]);
    if (r === null) throw new StoreUnavailable();
  } catch (err) {
    void captureServerException(new Error(String((err as { code?: unknown })?.code ?? (err instanceof Error ? err.name : "error"))), { route: "POST /api/maple/quick act" });
  }
}

/** One kept action, read past anything this release doesn't know (null: none, or not one). */
function actOf(v: unknown): SiriAct | null {
  const o = v && typeof v === "object" ? (v as { kind?: unknown; at?: unknown; rows?: unknown }) : null;
  if (!o || !(ACT_KINDS as readonly unknown[]).includes(o.kind) || typeof o.at !== "number" || !Number.isFinite(o.at) || !Array.isArray(o.rows)) return null;
  const rows = o.rows.flatMap((x): Wrote[] => {
    const w = x as Partial<Wrote> | null;
    return w && ["entry", "try", "shift", "checkin"].includes(w.t as string) && Number.isSafeInteger(w.id) && typeof w.u === "string" ? [{ t: w.t as Wrote["t"], id: w.id as number, u: w.u }] : [];
  });
  return { kind: o.kind as ActKind, at: o.at, rows };
}

/** The speaker's newest Siri action in this family (any of their live keys), or null. */
export async function lastAct(c: { fam: FamilyCtx; me: Member }): Promise<SiriAct | null> {
  const rows = await query(`SELECT last_act FROM maple_tokens WHERE family_id = $1 AND member = $2 AND revoked_at IS NULL AND last_act IS NOT NULL`, [c.fam.familyId, c.me.email]);
  if (rows === null) throw new StoreUnavailable();
  let newest: SiriAct | null = null;
  for (const r of rows) {
    const act = actOf((r as { last_act?: unknown }).last_act);
    if (act && (!newest || act.at > newest.at)) newest = act;
  }
  return newest;
}
