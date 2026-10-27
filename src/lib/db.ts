import { neon, types, type QueryRows } from "@neondatabase/serverless";
import type { PGlite } from "@electric-sql/pglite";

export type Rows = QueryRows<false>;
export type Row = Rows[number];
export type Statement = { sql: string; params?: unknown[] };

/** `pglite:` (or `pglite:<name>`, a separate database per name) runs an in-memory Postgres in this process, for checks. */
export const PGLITE_PREFIX = "pglite:";

export function isPglite(url = process.env.DATABASE_URL): boolean {
  return Boolean(url?.startsWith(PGLITE_PREFIX));
}

let pgliteQueries = 0;

/** Statements run against a pglite: database so far, so a check can count what a job costs. */
export const pgliteQueryCount = () => pgliteQueries;

export async function query(sql: string, params: unknown[] = []) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return null;
  }
  if (isPglite(url)) {
    pgliteQueries++;
    const db = await pglite(url);
    return (await db.query<Row>(sql, params, PGLITE_QUERY)).rows;
  }
  return neon(url).query(sql, params);
}

/** Runs the statements in one transaction (one Neon HTTP request), returning each one's rows. */
export async function transaction(statements: Statement[]) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return null;
  }
  if (isPglite(url)) {
    const db = await pglite(url);
    return db.transaction(async (tx) => {
      const out: Row[][] = [];
      for (const s of statements) out.push((await tx.query<Row>(s.sql, s.params ?? [], PGLITE_QUERY)).rows);
      return out;
    });
  }
  const sql = neon(url);
  return sql.transaction(statements.map((s) => sql.query(s.sql, s.params ?? [])));
}

const instances = new Map<string, Promise<PGlite>>();

function pglite(url: string): Promise<PGlite> {
  let db = instances.get(url);
  if (!db) {
    db = (async () => {
      // Never bundled or traced into a deployment: only checks set a pglite: URL.
      const { PGlite } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "@electric-sql/pglite");
      return PGlite.create({ parsers: NEON_PARSERS });
    })();
    instances.set(url, db);
  }
  return db;
}

// Rows and parameters cross the same pg-types conversions the Neon driver applies (BIGINT as a string, DATE as a
// local Date, every parameter sent as text), so a check sees exactly what production code sees.
const NEON_PARSERS: Record<number, (value: string) => unknown> = (() => {
  type Oid = Parameters<typeof types.getTypeParser>[0];
  const unparsed = types.getTypeParser(0 as Oid, "text");
  const out: Record<number, (value: string) => unknown> = {};
  for (let oid = 1; oid < 5000; oid++) {
    const parse = types.getTypeParser(oid as Oid, "text");
    if (parse !== unparsed) out[oid] = parse as (value: string) => unknown;
  }
  return out;
})();

const asText = (value: unknown) => neonText(value) as string;
const PGLITE_QUERY = {
  parsers: NEON_PARSERS,
  serializers: new Proxy({} as Record<number, (value: unknown) => string>, { get: () => asText }),
};

function neonText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString("hex")}`;
  if (Array.isArray(value)) return pgArray(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function pgArray(values: unknown[]): string {
  const items = values.map((v) => {
    if (v === null || v === undefined) return "NULL";
    if (Array.isArray(v)) return pgArray(v);
    const text = neonText(v) as string;
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  });
  return `{${items.join(",")}}`;
}
