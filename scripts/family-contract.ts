import { neon } from "@neondatabase/serverless";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type { Statement } from "../src/lib/db";
import { OLDER_COPY_QUIET_DAYS } from "../src/lib/maple/family";
import { FAMILY_OPTIONAL_TABLES, FAMILY_TABLES } from "../src/lib/maple/family-tables";

type Action = "apply" | "rollback";
type Transaction = (statements: Statement[]) => Promise<unknown>;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const names = (values: readonly string[]) => `ARRAY[${values.map(quote).join(",")}]::text[]`;
const block = (body: string) => `DO $contract$ BEGIN ${body} END $contract$`;
const requireSql = (condition: string, code: string) => `IF NOT (${condition}) THEN RAISE EXCEPTION '${code}'; END IF;`;
const columnsOf = (key: string, table: string) => `ARRAY(SELECT a.attname::text FROM unnest(${key}) WITH ORDINALITY k(n, ord)
  JOIN pg_attribute a ON a.attrelid = ${table} AND a.attnum = k.n ORDER BY k.ord)`;

const primaryKeys = [
  { table: "maple_members", old: ["email"], next: ["family_id", "email"], index: "uniq_maple_members_family_email" },
  { table: "maple_removed", old: ["email"], next: ["family_id", "email"], index: "uniq_maple_removed_family_email" },
  { table: "maple_chat_daily", old: ["member", "day"], next: ["family_id", "member", "day"], index: "uniq_maple_chat_daily_family" },
  { table: "maple_consents", old: ["member", "kind"], next: ["family_id", "member", "kind"], index: "uniq_maple_consents_family" },
  { table: "maple_care_people", old: ["member"], next: ["family_id"], index: "uniq_maple_care_people_family" },
];
const careTables = ["maple_care_meds", "maple_care_entries", "maple_care_mood"];
const legacyIndexes = ["maple_entries", ...careTables].map((table) => ({ table, name: `uniq_${table}_client`, on: "client_id", where: " WHERE client_id IS NOT NULL" }));
legacyIndexes.push({ table: "maple_care_people", name: "uniq_maple_care_people_one", on: "(TRUE)", where: "" });
const foreignKeys = [
  ...careTables.map((table) => ({ table, name: `fk_${table}_care_family`, columns: ["family_id"], target: "maple_care_people", references: ["family_id"], cascade: true })),
  { table: "maple_entries", name: "fk_maple_entries_family_baby", columns: ["family_id", "baby_id"], target: "maple_babies", references: ["family_id", "id"], cascade: false },
];

function hasPrimary(table: string, columns: string[]) {
  return `EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_index i ON i.indexrelid = c.conindid
    WHERE c.conrelid = 'public.${table}'::regclass AND c.contype = 'p' AND i.indisvalid
    AND ${columnsOf("c.conkey", "c.conrelid")} = ${names(columns)})`;
}

function primarySwap(key: (typeof primaryKeys)[number], action: Action): string {
  const wanted = action === "apply" ? key.next : key.old;
  const prior = action === "apply" ? key.old : key.next;
  const add = action === "apply"
    ? `ALTER TABLE public.${key.table} ADD CONSTRAINT ${key.table}_pkey PRIMARY KEY USING INDEX ${key.index};`
    : `CREATE UNIQUE INDEX IF NOT EXISTS ${key.index} ON public.${key.table} (${key.next.join(", ")});
       ALTER TABLE public.${key.table} ADD CONSTRAINT ${key.table}_pkey PRIMARY KEY (${key.old.join(", ")});`;
  return block(`IF NOT (${hasPrimary(key.table, wanted)}) THEN
    ${requireSql(hasPrimary(key.table, prior), "family_contract_primary_mismatch")}
    ALTER TABLE public.${key.table} DROP CONSTRAINT ${key.table}_pkey;
    ${add}
  END IF;`);
}

function forward(): string[] {
  return [
    block(requireSql(`NOT EXISTS (SELECT 1 FROM public.maple_push_sent WHERE family_id IS NULL
      AND (key LIKE 's%|%' OR key LIKE 'wake:%') AND sent_at > NOW() - make_interval(days => ${OLDER_COPY_QUIET_DAYS}))`, "family_contract_older_copy_active")),
    ...FAMILY_TABLES.flatMap((table) => [
      block(`IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.${table}'::regclass AND attname = 'family_id' AND NOT attnotnull) THEN
        ALTER TABLE public.${table} ADD CONSTRAINT ${table}_contract_not_null CHECK (family_id IS NOT NULL) NOT VALID;
        ALTER TABLE public.${table} VALIDATE CONSTRAINT ${table}_contract_not_null;
        ALTER TABLE public.${table} ALTER COLUMN family_id SET NOT NULL;
        ALTER TABLE public.${table} DROP CONSTRAINT ${table}_contract_not_null;
      END IF;`),
      `ALTER TABLE public.${table} ALTER COLUMN family_id DROP DEFAULT`,
    ]),
    ...FAMILY_OPTIONAL_TABLES.map((table) => `ALTER TABLE public.${table} ALTER COLUMN family_id DROP DEFAULT`),
    ...careTables.map((table) => `ALTER TABLE public.${table} DROP CONSTRAINT IF EXISTS ${table}_person_fkey`),
    ...primaryKeys.map((key) => primarySwap(key, "apply")),
    ...legacyIndexes.map(({ name }) => `DROP INDEX IF EXISTS public.${name}`),
    `ALTER TABLE public.maple_push_subs DROP CONSTRAINT IF EXISTS maple_push_subs_endpoint_key`,
    ...foreignKeys.flatMap((fk) => [
      block(`IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.${fk.table}'::regclass AND conname = '${fk.name}') THEN
        ALTER TABLE public.${fk.table} ADD CONSTRAINT ${fk.name} FOREIGN KEY (${fk.columns.join(", ")})
          REFERENCES public.${fk.target} (${fk.references.join(", ")})${fk.cascade ? " ON DELETE CASCADE" : ""} NOT VALID;
      END IF;`),
      `ALTER TABLE public.${fk.table} VALIDATE CONSTRAINT ${fk.name}`,
      block(requireSql(`EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.${fk.table}'::regclass
        AND c.conname = '${fk.name}' AND c.contype = 'f' AND c.convalidated AND c.confrelid = 'public.${fk.target}'::regclass
        AND c.confdeltype = '${fk.cascade ? "c" : "a"}' AND ${columnsOf("c.conkey", "c.conrelid")} = ${names(fk.columns)}
        AND ${columnsOf("c.confkey", "c.confrelid")} = ${names(fk.references)})`, "family_contract_foreign_key_mismatch")),
    ]),
    block(requireSql(`NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'family_id'
      AND table_name = ANY(${names([...FAMILY_TABLES, ...FAMILY_OPTIONAL_TABLES])})
      AND (column_default IS NOT NULL OR (table_name = ANY(${names(FAMILY_TABLES)}) AND is_nullable = 'YES')))`, "family_contract_columns_mismatch")),
    ...primaryKeys.map((key) => block(requireSql(hasPrimary(key.table, key.next), "family_contract_primary_mismatch"))),
  ];
}

function reverse(): string[] {
  return [
    block(requireSql(`NOT EXISTS (SELECT 1 FROM public.maple_families WHERE id <> 1)`, "family_contract_rollback_has_other_families")),
    ...[...FAMILY_TABLES, ...FAMILY_OPTIONAL_TABLES].map((table) => block(requireSql(`NOT EXISTS (SELECT 1 FROM public.${table} WHERE family_id <> 1)`, "family_contract_rollback_has_other_families"))),
    ...foreignKeys.map((fk) => `ALTER TABLE public.${fk.table} DROP CONSTRAINT IF EXISTS ${fk.name}`),
    ...primaryKeys.map((key) => primarySwap(key, "rollback")),
    ...careTables.map((table) => block(`IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.${table}'::regclass AND conname = '${table}_person_fkey') THEN
      ALTER TABLE public.${table} ADD CONSTRAINT ${table}_person_fkey FOREIGN KEY (person) REFERENCES public.maple_care_people(member) ON DELETE CASCADE;
    END IF;`)),
    ...legacyIndexes.map(({ table, name, on, where }) => `CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON public.${table} (${on})${where}`),
    block(`IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.maple_push_subs'::regclass AND conname = 'maple_push_subs_endpoint_key') THEN
      ALTER TABLE public.maple_push_subs ADD CONSTRAINT maple_push_subs_endpoint_key UNIQUE (endpoint);
    END IF;`),
    ...FAMILY_TABLES.flatMap((table) => [
      `ALTER TABLE public.${table} ALTER COLUMN family_id DROP NOT NULL`,
      `ALTER TABLE public.${table} ALTER COLUMN family_id SET DEFAULT 1`,
    ]),
  ];
}

const lockAndSnapshot = `DO $contract$ DECLARE t text; n bigint; digest text; BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname LIKE 'maple\\_%' ESCAPE '\\' ORDER BY c.relname
  LOOP
    EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', t);
  END LOOP;
  CREATE TEMP TABLE maple_contract_before (table_name text PRIMARY KEY, row_count bigint, digest text) ON COMMIT DROP;
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname LIKE 'maple\\_%' ESCAPE '\\' ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT count(*), md5(COALESCE(string_agg(h, '''' ORDER BY h), '''')) FROM (SELECT md5(to_jsonb(r)::text) h FROM public.%I r) hashes', t) INTO n, digest;
    INSERT INTO pg_temp.maple_contract_before VALUES (t, n, digest);
  END LOOP;
END $contract$`;

const verifyRows = `DO $contract$ DECLARE r record; n bigint; digest text; BEGIN
  FOR r IN SELECT * FROM pg_temp.maple_contract_before LOOP
    EXECUTE format('SELECT count(*), md5(COALESCE(string_agg(h, '''' ORDER BY h), '''')) FROM (SELECT md5(to_jsonb(t)::text) h FROM public.%I t) hashes', r.table_name) INTO n, digest;
    IF n <> r.row_count OR digest <> r.digest THEN RAISE EXCEPTION 'family_contract_rows_changed'; END IF;
  END LOOP;
END $contract$`;

export function familyContractStatements(database: string, action: Action = "apply"): Statement[] {
  if (!database) throw new Error("family_contract_expected_database_required");
  return [
    "SET LOCAL lock_timeout = '3s'",
    "SET LOCAL statement_timeout = '90s'",
    "SET LOCAL search_path = pg_catalog, public",
    "SELECT pg_advisory_xact_lock(238472019, 3)",
    block(requireSql(`current_database() = ${quote(database)}`, "family_contract_database_mismatch")),
    lockAndSnapshot,
    ...[...FAMILY_TABLES, ...FAMILY_OPTIONAL_TABLES].map((table) => block(requireSql(`EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = 'family_id')`, "family_contract_family_column_missing"))),
    ...(action === "apply" ? forward() : reverse()),
    verifyRows,
  ].map((sql) => ({ sql }));
}

export async function runFamilyContract(execute: Transaction, database: string, action: Action = "apply"): Promise<void> {
  await execute(familyContractStatements(database, action));
}

export function validateContractTarget(raw: string | undefined, host: string, database: string): string {
  if (!raw || !host || !database) throw new Error("family_contract_target_required");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("family_contract_invalid_url"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || !url.password || url.hash) throw new Error("family_contract_invalid_url");
  if ((url.port && url.port !== "5432") || [...url.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key) || url.searchParams.getAll(key).length !== 1)) {
    throw new Error("family_contract_invalid_connection_options");
  }
  if (url.hostname !== host || decodeURIComponent(url.pathname.slice(1)) !== database) throw new Error("family_contract_target_mismatch");
  if (url.hostname.includes("-pooler.")) throw new Error("family_contract_requires_unpooled_url");
  if (url.searchParams.get("sslmode") !== "require" && url.searchParams.get("sslmode") !== "verify-full") throw new Error("family_contract_requires_tls");
  return raw;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "expected-host": { type: "string" }, "expected-database": { type: "string" }, apply: { type: "boolean" }, rollback: { type: "boolean" } } });
  if (Boolean(values.apply) === Boolean(values.rollback)) throw new Error("family_contract_choose_apply_or_rollback");
  const database = values["expected-database"] ?? "";
  const url = validateContractTarget(process.env.DATABASE_URL_UNPOOLED, values["expected-host"] ?? "", database);
  const sql = neon(url);
  await runFamilyContract((statements) => sql.transaction(statements.map((s) => sql.query(s.sql, s.params ?? []))), database, values.rollback ? "rollback" : "apply");
  console.log(values.rollback ? "Family contract reversed; rows verified unchanged." : "Family contract applied; rows verified unchanged.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const failure = error as { message?: unknown; code?: unknown };
    const message = typeof failure.message === "string" && /^family_contract_[a-z_]+$/.test(failure.message) ? failure.message : "family_contract_failed";
    const code = typeof failure.code === "string" && /^[A-Z0-9]{5}$/.test(failure.code) ? failure.code : "unknown";
    console.error(`${message} (${code}); completion not confirmed. Inspect the target before retrying.`);
    process.exitCode = 1;
  });
}
