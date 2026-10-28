import { query } from "@/lib/db";
import { normalizeEmail } from "@/lib/waitlist";
import { BadRequest } from "../api";
import { FAMILY_ONE } from "../family";
import { NotFound, StoreUnavailable } from "../store";
import type { AdminDetails, AdminDetailsFilter, AdminDetailsOptions, AdminDetailsRow, AdminDetailsView } from "./details-types";
import { maskAdminEmail, sealAdminRef, type AdminRef } from "./refs";

const PAGE_SIZE = 25;
const FAMILY_FILTERS = new Set<AdminDetailsFilter>(["all", "7d", "30d", "onboarding", "setup_complete", "deleting", "active7d", "active30d"]);

export function parseAdminDetailsOptions(params: URLSearchParams): AdminDetailsOptions {
  const view = params.get("view") ?? "families";
  const filter = params.get("filter") ?? "all";
  const page = params.get("page") ?? "1";
  if (!["families", "people", "waitlist"].includes(view) || !FAMILY_FILTERS.has(filter as AdminDetailsFilter)
    || (view !== "families" && filter !== "all") || !/^[1-9]\d{0,7}$/.test(page)) throw new BadRequest("Invalid list options");
  return { view: view as AdminDetailsView, filter: filter as AdminDetailsFilter, page: Number(page) };
}

const asIso = (value: unknown): string => new Date(value as string).toISOString();
const nullableIso = (value: unknown): string | null => value == null ? null : asIso(value);

function familyFilter(filter: AdminDetailsFilter): string {
  if (filter === "7d" || filter === "30d") return `f.created_at > $2::timestamptz - INTERVAL '${filter === "7d" ? 168 : 720} hours' AND f.created_at <= $2::timestamptz`;
  if (filter === "onboarding" || filter === "deleting" || filter === "setup_complete") return `f.status = '${filter === "setup_complete" ? "active" : filter}'`;
  if (filter === "active7d" || filter === "active30d") return `EXISTS (SELECT 1 FROM maple_members seen WHERE seen.family_id = f.id
    AND seen.accepted_at IS NOT NULL AND seen.email <> 'admin'
    AND seen.last_seen_at > $2::timestamptz - INTERVAL '${filter === "active7d" ? 168 : 720} hours' AND seen.last_seen_at <= $2::timestamptz)`;
  return "TRUE";
}

/** Lists have only masked contact information; explicit reveals use a separate protected POST. */
export async function readAdminDetails(options: AdminDetailsOptions, now = new Date()): Promise<AdminDetails> {
  // Validate callers too: SQL clauses below come only from this closed enum.
  const opts = parseAdminDetailsOptions(new URLSearchParams({ view: options.view, filter: options.filter, page: String(options.page) }));
  const offset = (opts.page - 1) * PAGE_SIZE;
  let source: string;
  let order: string;
  if (opts.view === "families") {
    source = `SELECT f.id, f.created_at, f.status, f.created_by AS email,
      (SELECT COUNT(*)::int FROM maple_members m WHERE m.family_id = f.id AND m.accepted_at IS NOT NULL AND m.email <> 'admin') AS members
      FROM maple_families f WHERE f.id <> $1 AND ${familyFilter(opts.filter)}`;
    order = "created_at DESC, id DESC";
  } else if (opts.view === "people") {
    source = `SELECT m.email, array_agg(DISTINCT m.family_id ORDER BY m.family_id) AS family_ids,
      MIN(m.accepted_at) AS joined_at, MAX(m.last_seen_at) AS last_seen_at
      FROM maple_members m JOIN maple_families f ON f.id = m.family_id
      WHERE f.id <> $1 AND m.accepted_at IS NOT NULL AND m.email <> 'admin' AND m.email NOT LIKE 'invite:%'
      GROUP BY m.email`;
    order = "joined_at DESC NULLS LAST, email";
  } else {
    source = "SELECT id, email, created_at FROM maple_waitlist";
    order = "created_at DESC, id DESC";
  }
  const rows = await query(`WITH contacts AS (${source}), page_rows AS (SELECT * FROM contacts ORDER BY ${order} LIMIT $3 OFFSET $4)
    SELECT (SELECT COUNT(*)::int FROM contacts) AS total,
      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY ${order}) FROM page_rows p), '[]'::jsonb) AS rows,
      $2::timestamptz AS snapshot_at, $1::bigint AS excluded_family`, [FAMILY_ONE, now.toISOString(), PAGE_SIZE, offset]);
  if (!rows?.[0]) throw new StoreUnavailable();
  const records = rows[0].rows as Record<string, unknown>[];
  const masked: AdminDetailsRow[] = records.map((row) => {
    const email = typeof row.email === "string" ? normalizeEmail(row.email) : null;
    if (opts.view === "families") return {
      kind: "family", id: Number(row.id), createdAt: asIso(row.created_at), status: row.status as "onboarding" | "active" | "deleting",
      members: Number(row.members), emailMasked: email ? maskAdminEmail(email) : null,
      ref: email ? sealAdminRef({ kind: "family", id: Number(row.id) }) : null,
    };
    if (!email) throw new StoreUnavailable();
    if (opts.view === "people") return {
      kind: "person", ref: sealAdminRef({ kind: "person", email }), emailMasked: maskAdminEmail(email),
      familyIds: (row.family_ids as (string | number)[]).map(Number), joinedAt: nullableIso(row.joined_at), lastSeenAt: nullableIso(row.last_seen_at),
    };
    return { kind: "waitlist", id: Number(row.id), ref: sealAdminRef({ kind: "waitlist", id: Number(row.id) }), emailMasked: maskAdminEmail(email), createdAt: asIso(row.created_at) };
  });
  return { view: opts.view, page: opts.page, pageSize: PAGE_SIZE, total: Number(rows[0].total), rows: masked };
}

/** Resolve from current records so removed contacts cannot be recovered with an old list token. */
export async function revealAdminEmail(ref: AdminRef): Promise<string> {
  const statement = ref.kind === "family"
    ? "SELECT created_by AS email FROM maple_families WHERE id = $1 AND id <> $2"
    : ref.kind === "person"
      ? `SELECT m.email FROM maple_members m JOIN maple_families f ON f.id = m.family_id
         WHERE m.email = $1 AND f.id <> $2 AND m.accepted_at IS NOT NULL AND m.email <> 'admin' AND m.email NOT LIKE 'invite:%' LIMIT 1`
      : "SELECT email FROM maple_waitlist WHERE id = $1 AND $2::bigint > 0";
  const rows = await query(statement, [ref.kind === "person" ? ref.email : ref.id, FAMILY_ONE]);
  if (!rows) throw new StoreUnavailable();
  const email = normalizeEmail(rows[0]?.email);
  if (!email) throw new NotFound("This contact is no longer available");
  return email;
}
