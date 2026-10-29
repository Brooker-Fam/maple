import { query } from "@/lib/db";
import { captureServerException } from "@/lib/posthog-server";
import { FAMILY_OPTIONAL_TABLES, FAMILY_TABLES } from "./family-tables";
import { DEFAULT_TZ } from "./time";
import type { Role } from "./types";

/**
 * Which family a request acts in. Every entry point (withMember, withCare,
 * the MCP context, Siri, the chat, the native ticket trade, invites, the
 * push tick) resolves a FamilyCtx once, and every store call takes it.
 *
 * Carriers name their family in `fam`: the session cookie, the native
 * ticket, MCP codes, access and refresh tokens, and the chat's tool calls
 * (copied from the session). Siri tokens and invites carry it in their row's
 * family_id. One minted before families existed has no `fam` and means
 * family 1 (the Brookers), never "the person's only family": another
 * family's owner could change that by adding the address. Membership in
 * (family, member) is read fresh on every request, so an old carrier opens
 * family 1 only for someone who is a member there.
 */

export const FAMILY_ONE = 1;
export const ADMIN_MEMBER_ID = "admin";

export type FamilyStatus = "onboarding" | "active" | "deleting";

/** What a background job (push tick, wakes, the safety net) works in: one family at a time, never a mix. */
export type FamilyScope = {
  familyId: number;
  /** The family's active baby, null until onboarding adds one. */
  babyId: number | null;
  /** The baby's timezone while there is a baby (what every family-1 clock reads today), else the family's. */
  tz: string;
};

export type FamilyCtx = FamilyScope & {
  member: string;
  role: Role;
  status: FamilyStatus;
};

/** A positive integer id; BIGINT columns arrive as strings. */
export function parseFamilyId(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The family a carrier's `fam` names: none means family 1; anything malformed opens nothing. */
export function carrierFamily(fam: unknown): number | null {
  return fam === undefined || fam === null ? FAMILY_ONE : parseFamilyId(fam);
}

/** The admin login only ever opens this family (MAPLE_ADMIN_FAMILY_ID, default 1). */
export function adminFamilyId(): number {
  return parseFamilyId(process.env.MAPLE_ADMIN_FAMILY_ID) ?? FAMILY_ONE;
}

/** The member id behind an MCP `sub` ("maple:<email>" or "admin"), or null. */
export function memberIdFromSub(sub: unknown): string | null {
  if (typeof sub !== "string" || !sub) return null;
  if (sub === ADMIN_MEMBER_ID) return sub;
  return sub.startsWith("maple:") && sub.length > "maple:".length ? sub.slice("maple:".length) : null;
}

/** The `fam` claim a new carrier for this context gets. */
export function familyClaim(ctx: Pick<FamilyScope, "familyId">): { fam: number } {
  return { fam: ctx.familyId };
}

const SCOPE_COLS = `f.id AS family_id, f.timezone AS family_tz, f.status,
  b.id AS baby_id, b.timezone AS baby_tz`;
const ACTIVE_BABY = `LEFT JOIN LATERAL (
    SELECT id, timezone FROM maple_babies
    WHERE family_id = f.id AND archived_at IS NULL ORDER BY id LIMIT 1
  ) b ON TRUE`;

function rowToScope(r: Record<string, unknown>): FamilyScope {
  return {
    familyId: parseFamilyId(r.family_id)!,
    babyId: r.baby_id == null ? null : Number(r.baby_id),
    tz: String(r.baby_tz || r.family_tz || DEFAULT_TZ),
  };
}

function rowStatus(raw: unknown): FamilyStatus {
  return raw === "onboarding" || raw === "deleting" ? raw : "active";
}

function rowRole(raw: unknown): Role {
  return raw === "owner" || raw === "viewer" || raw === "photos" ? raw : "member";
}

/**
 * A membership the person took up themselves: they made the family, joined
 * by its link or accepted its invite (accepted_at), or it's family 1, whose
 * owners add people by address as they always have. Anywhere else, a row
 * someone else wrote opens nothing and puts nothing in the switcher.
 */
export const ACCEPTED_MEMBERSHIP = (m: string) => `(${m}.family_id = ${FAMILY_ONE} OR ${m}.accepted_at IS NOT NULL)`;

/**
 * The context for member `id` in the family a carrier names, or null (signed
 * out): not a member there, a malformed or foreign `fam`, an admin login
 * outside its family, a family being deleted, or no database.
 */
export async function resolveFamily(id: string | null | undefined, fam: unknown): Promise<FamilyCtx | null> {
  const familyId = carrierFamily(fam);
  if (!id || familyId === null) return null;
  if (id === ADMIN_MEMBER_ID && familyId !== adminFamilyId()) return null;
  const rows = await query(
    `SELECT ${SCOPE_COLS}, m.role
     FROM maple_members m JOIN maple_families f ON f.id = m.family_id ${ACTIVE_BABY}
     WHERE m.family_id = $1 AND m.email = $2 AND f.status <> 'deleting' AND ${ACCEPTED_MEMBERSHIP("m")}`,
    [familyId, id]
  );
  if (!rows?.length) return null;
  return { ...rowToScope(rows[0]), member: id, role: rowRole(rows[0].role), status: rowStatus(rows[0].status) };
}

/** Session cookie or native ticket body: `{ id, fam? }`. */
export function familyForSession(body: { id?: unknown; fam?: unknown } | null | undefined): Promise<FamilyCtx | null> {
  return resolveFamily(typeof body?.id === "string" ? body.id : null, body?.fam);
}

/** MCP access token, refresh token or code, and the chat's tool calls: `{ sub, fam? }`. */
export async function familyForAuth(auth: { sub?: unknown; fam?: unknown } | null | undefined): Promise<FamilyCtx | null> {
  const ctx = await resolveFamily(memberIdFromSub(auth?.sub), auth?.fam);
  return ctx?.role === "photos" ? null : ctx;
}

/** A Siri personal token or a redeemed invite: the row's own member and family_id (DEFAULT 1 for rows from before). */
export async function familyForRow(row: { member?: unknown; family_id?: unknown } | null | undefined): Promise<FamilyCtx | null> {
  if (!row || row.family_id == null) return Promise.resolve(null);
  const ctx = await resolveFamily(typeof row.member === "string" ? row.member : null, row.family_id);
  return ctx?.role === "photos" ? null : ctx;
}

/** One family's scope for a job, or null when it doesn't exist or is being deleted. */
export async function familyScope(familyId: unknown): Promise<FamilyScope | null> {
  const id = parseFamilyId(familyId);
  if (id === null) return null;
  const rows = await query(`SELECT ${SCOPE_COLS} FROM maple_families f ${ACTIVE_BABY} WHERE f.id = $1 AND f.status <> 'deleting'`, [id]);
  return rows?.length ? rowToScope(rows[0]) : null;
}

/** Every family not being deleted (onboarding ones too, as resolveFamily lets them in), for jobs that walk them one at a time. */
export async function familyScopes(): Promise<FamilyScope[]> {
  const rows = await query(`SELECT ${SCOPE_COLS} FROM maple_families f ${ACTIVE_BABY} WHERE f.status <> 'deleting' ORDER BY f.id`);
  return rows ? rows.map(rowToScope) : [];
}

/** The families (not being deleted) with a phone that has notifications on: the only ones a sweep of the push tick has anything to send for. */
export async function familiesWithPhones(): Promise<FamilyScope[]> {
  const rows = await query(
    `SELECT ${SCOPE_COLS} FROM maple_families f ${ACTIVE_BABY}
     WHERE f.status <> 'deleting' AND EXISTS (SELECT 1 FROM maple_push_subs s WHERE s.family_id = f.id AND NOT s.needs_resubscribe)
     ORDER BY f.id`
  );
  return rows ? rows.map(rowToScope) : [];
}

/** The families a member id took up (the switcher shows only for two or more). */
export async function familiesOf(id: string): Promise<{ familyId: number; name: string | null; role: Role }[]> {
  const rows = await query(
    `SELECT f.id, f.name, m.role FROM maple_members m JOIN maple_families f ON f.id = m.family_id
     WHERE m.email = $1 AND f.status <> 'deleting' AND ${ACCEPTED_MEMBERSHIP("m")} ORDER BY f.id`,
    [id]
  );
  return (rows ?? []).map((r) => ({ familyId: parseFamilyId(r.id)!, name: r.name == null ? null : String(r.name), role: rowRole(r.role) }));
}

/**
 * The family a plain sign-in opens for someone already in one or more: the
 * one they used last, else the one they made, else family 1, else the one
 * they joined last. Never the lowest id, which another family's owner could
 * pick by being older. Undefined for someone in none; null without a database.
 */
export async function homeFamilyOf(email: string): Promise<number | null | undefined> {
  const rows = await query(
    `SELECT m.family_id FROM maple_members m JOIN maple_families f ON f.id = m.family_id
     WHERE m.email = $1 AND f.status <> 'deleting' AND ${ACCEPTED_MEMBERSHIP("m")}
     ORDER BY m.last_seen_at DESC NULLS LAST,
       (f.created_by = $1 AND m.role = 'owner') DESC,
       (m.family_id = ${FAMILY_ONE}) DESC,
       m.accepted_at DESC NULLS LAST, m.added_at DESC
     LIMIT 1`,
    [email]
  );
  if (!rows) return null;
  return rows.length ? (parseFamilyId(rows[0].family_id) ?? undefined) : undefined;
}

/**
 * True when a row fetched by id is this family's. Another family's row must
 * read exactly like a missing one, so callers answer NotFound on false; the
 * mismatch is reported as a bare code with the route, never the row.
 */
export function sameFamily(row: { family_id?: unknown } | null | undefined, ctx: Pick<FamilyScope, "familyId">, route: string): boolean {
  if (!row) return false;
  if (parseFamilyId(row.family_id) === ctx.familyId) return true;
  void captureServerException(new Error("cross_family"), { route });
  return false;
}

// ── sign-up switch ────────────────────────────────────────────────────

export type SignupMode = "off" | "invite" | "open";

/** MAPLE_SIGNUP: "invite" or "open"; anything else (unset included) is off. */
export function signupMode(raw: string | undefined = process.env.MAPLE_SIGNUP): SignupMode {
  const v = raw?.trim().toLowerCase();
  return v === "invite" || v === "open" ? v : "off";
}

/**
 * Columns that would file a second family's forgotten family_id under the
 * Brookers: a family table whose family_id is missing, has a default or
 * allows null. Null when the database can't be read.
 */
export async function signupBlockers(): Promise<string[] | null> {
  const rows = await query(
    `SELECT table_name, column_default, is_nullable FROM information_schema.columns
     WHERE table_schema = current_schema() AND column_name = 'family_id' AND table_name = ANY($1)`,
    [[...FAMILY_TABLES, ...FAMILY_OPTIONAL_TABLES]]
  );
  if (!rows) return null;
  const seen = new Map(rows.map((r) => [String(r.table_name), r]));
  const optional: readonly string[] = FAMILY_OPTIONAL_TABLES;
  const out: string[] = [];
  for (const table of [...FAMILY_TABLES, ...FAMILY_OPTIONAL_TABLES]) {
    const col = seen.get(table);
    if (!col) out.push(`${table}: no family_id`);
    else if (col.column_default != null) out.push(`${table}: family_id has a default`);
    else if (col.is_nullable === "YES" && !optional.includes(table)) out.push(`${table}: family_id allows null`);
  }
  return out;
}

/**
 * Signing keys someone outside Maple holds: MCP tokens signed with the
 * ADMIN_PASS-derived key (brooker-wedding's servers share it), and sessions,
 * native tickets and sign-up intents sealed with GOOGLE_CLIENT_SECRET (so
 * does brooker-wedding). Either lets its holder mint a carrier naming any
 * family.
 */
export function secretBlockers(env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  const mcp = env.MCP_SECRET?.trim();
  if (!mcp) out.push("MCP_SECRET: not set");
  else if (env.ADMIN_PASS && mcp === `brooker-mcp:${env.ADMIN_PASS}`) out.push("MCP_SECRET: derived from ADMIN_PASS");
  const session = env.MAPLE_SESSION_SECRET?.trim();
  if (!session) out.push("MAPLE_SESSION_SECRET: not set");
  else if (session === env.GOOGLE_CLIENT_SECRET?.trim()) out.push("MAPLE_SESSION_SECRET: same as GOOGLE_CLIENT_SECRET");
  return out;
}

/** How recently an older copy of Maple must have been quiet: it claims notices and wakes without a family (the code here always names one). */
export const OLDER_COPY_QUIET_DAYS = 7;

/**
 * True while an older copy of Maple still sends notices: its tick loads every
 * family's phones and members, so a second family's phones would get family
 * 1's medicine reminders. Null when the database can't be read.
 */
export async function olderCopyActive(): Promise<boolean | null> {
  const rows = await query(
    `SELECT 1 FROM maple_push_sent
     WHERE family_id IS NULL AND (key LIKE 's%|%' OR key LIKE 'wake:%') AND sent_at > NOW() - make_interval(days => $1)
     LIMIT 1`,
    [OLDER_COPY_QUIET_DAYS]
  );
  return rows ? rows.length > 0 : null;
}

/**
 * The sign-up mode in force: off until the schema files every row by its own
 * family (Phase 3 run), every signing key is Maple's own, and no older copy
 * of Maple has sent anything for a week.
 */
export async function effectiveSignupMode(): Promise<SignupMode> {
  const mode = signupMode();
  if (mode === "off" || secretBlockers().length) return "off";
  const blockers = await signupBlockers();
  if (!blockers || blockers.length) return "off";
  return (await olderCopyActive()) === false ? mode : "off";
}
