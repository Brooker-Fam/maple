import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { migrate, migrateFamilies } from "../../src/lib/migrate";
import { FAMILY_OPTIONAL_TABLES, FAMILY_TABLES, FAMILY_KEYED_TABLES } from "../../src/lib/maple/family-tables";
import { done, eq, freshDb, ok, quietly, seedFamilies, sql, sqlError, test } from "./harness";

/**
 * Phase 1's schema on PGlite: migrate.ts twice is a no-op, an upgrade from the
 * schema production runs today files every row under family 1, older code's
 * inserts and ON CONFLICT targets keep working, and the final shape refuses
 * a row without its family.
 */

const ROOT = join(__dirname, "..", "..");

async function snapshot() {
  const tables = (await sql(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY 1`)).map((r) => String(r.relname));
  const data: Record<string, unknown> = {};
  for (const t of tables) {
    const [row] = await sql(`SELECT COUNT(*)::int AS n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`);
    data[t] = row;
  }
  return {
    columns: await sql(`SELECT table_name, column_name, data_type, column_default, is_nullable FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`),
    indexes: await sql(`SELECT c.relname, pg_get_indexdef(i.indexrelid) AS def, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relnamespace = 'public'::regnamespace ORDER BY 1`),
    constraints: await sql(`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`),
    files: await sql(`SELECT relname, relfilenode FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'i', 'S') ORDER BY 1`),
    sequence: await sql(`SELECT last_value, is_called FROM maple_families_id_seq`),
    data,
  };
}

async function watchDdl() {
  await sql(`CREATE TABLE IF NOT EXISTS ddl_seen (tag TEXT, obj TEXT)`);
  await sql(`CREATE OR REPLACE FUNCTION note_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO ddl_seen SELECT command_tag, object_identity FROM pg_event_trigger_ddl_commands(); END $$`);
  await sql(`CREATE EVENT TRIGGER note_ddl ON ddl_command_end EXECUTE FUNCTION note_ddl()`);
  await sql(`DELETE FROM ddl_seen`);
}

async function stopDdl() {
  const seen = await sql(`SELECT tag, obj FROM ddl_seen`);
  await sql(`DROP EVENT TRIGGER note_ddl`);
  await sql(`DROP TABLE ddl_seen`);
  return seen;
}

async function idempotency() {
  await test("migrate.ts twice on an empty database: the second run changes no schema, file or row", async () => {
    await freshDb();
    const first = await snapshot();
    await quietly(migrate);
    eq(await snapshot(), first);
  });

  await test("the family section's second run issues no DDL at all (no ALTER takes a lock)", async () => {
    await freshDb();
    await watchDdl();
    await quietly(migrateFamilies);
    eq(await stopDdl(), []);
  });

  await test("an empty database gets family 1 (active, no name) and no baby: the seed is gone", async () => {
    await freshDb();
    eq(await sql(`SELECT id, name, timezone, status FROM maple_families`), [{ id: "1", name: null, timezone: "America/New_York", status: "active" }]);
    eq(await sql(`SELECT COUNT(*)::int AS n FROM maple_babies`), [{ n: 0 }]);
  });

  await test("the families sequence hands out 2 next, and migrating again after a family is deleted never reuses its id", async () => {
    await freshDb();
    const [two] = await sql(`INSERT INTO maple_families (timezone) VALUES ('America/Chicago') RETURNING id`);
    const [three] = await sql(`INSERT INTO maple_families (timezone) VALUES ('America/Chicago') RETURNING id`);
    await sql(`DELETE FROM maple_families WHERE id = $1`, [three.id]);
    await quietly(migrate);
    const [four] = await sql(`INSERT INTO maple_families (timezone) VALUES ('America/Chicago') RETURNING id`);
    eq([two.id, three.id, four.id], ["2", "3", "4"]);
  });

  await test("an index left invalid by a failed build is rebuilt by the next one", async () => {
    await freshDb();
    await sql(`UPDATE pg_index SET indisvalid = FALSE WHERE indexrelid = 'uniq_maple_members_family_email'::regclass`);
    await quietly(migrate);
    eq(await sql(`SELECT indisvalid FROM pg_index WHERE indexrelid = 'uniq_maple_members_family_email'::regclass`), [{ indisvalid: true }]);
  });

  await test("every index creation path rejects an index left missing or invalid by a concurrent build", async () => {
    const source = ts.createSourceFile("migrate.ts", readFileSync(join(ROOT, "src/lib/migrate.ts"), "utf8"), ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "index");
    if (!declaration) throw new Error("index_helper_missing");
    const js = ts.transpileModule(`(${declaration.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    for (const code of [null, "25001", "42P07", "23505"] as const) {
      for (const validity of [undefined, false, true]) {
        let reads = 0;
        let fallback = false;
        const build = runInNewContext(js, {
          sql: async () => ++reads === 1 || validity === undefined ? [] : [{ indisvalid: validity }],
          query: async () => { if (code) throw { code, constraint: code === "23505" ? "pg_class_relname_nsp_index" : undefined }; },
          alter: async () => { fallback = true; },
          codeOf: (error: { code?: string }) => error.code ?? "",
        }) as (name: string, on: string, unique: boolean) => Promise<void>;
        let refusal: string | null = null;
        await build("synthetic_family_email", "synthetic_members (family_id, email)", true).catch((error: Error) => { refusal = error.message; });
        eq(refusal, validity ? null : "migration_index_invalid:synthetic_family_email", `${code ?? "concurrent"}: ${validity}`);
        eq(reads, 2, "index validity checked after creation");
        eq(fallback, code === "25001", "plain create is only the transaction fallback");
      }
    }
  });

  await test("family columns retain tenant defaults and separate analytics references", async () => {
    await freshDb();
    const cols = await sql(`SELECT table_name, column_default, is_nullable FROM information_schema.columns WHERE column_name = 'family_id' ORDER BY 1`);
    const byTable = Object.fromEntries(cols.map((c) => [String(c.table_name), [c.column_default, c.is_nullable]]));
    for (const t of FAMILY_TABLES) eq(byTable[t], ["1", "YES"], t);
    for (const t of FAMILY_OPTIONAL_TABLES) eq(byTable[t], [null, "YES"], t);
    for (const t of FAMILY_KEYED_TABLES) eq(byTable[t], [null, "NO"], t);
    eq(byTable.maple_analytics_families, [null, "NO"]);
    eq(byTable.maple_analytics_deliveries, [null, "YES"]);
    eq(await sql(`SELECT table_name, data_type FROM information_schema.columns WHERE column_name = 'family_id' AND table_name IN ('maple_analytics_families', 'maple_analytics_deliveries') ORDER BY 1`), [
      { table_name: "maple_analytics_deliveries", data_type: "uuid" },
      { table_name: "maple_analytics_families", data_type: "bigint" },
    ]);
    eq(Object.keys(byTable).sort(), [...FAMILY_TABLES, ...FAMILY_OPTIONAL_TABLES, ...FAMILY_KEYED_TABLES, "maple_analytics_families", "maple_analytics_deliveries"].sort());
  });

  await test("every family foreign key is validated and every new index is valid", async () => {
    await freshDb();
    const fks = await sql(`SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE 'fk_%_family' ORDER BY 1`);
    eq(fks.length, FAMILY_TABLES.length + FAMILY_OPTIONAL_TABLES.length);
    ok(fks.every((r) => r.convalidated === true), "an unvalidated family key");
    const idx = await sql(`SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname LIKE '%family%'`);
    ok(idx.length >= 26 && idx.every((r) => r.indisvalid === true), `family indexes: ${idx.length}`);
  });
}

async function loadBeforeSchema() {
  const text = readFileSync(join(__dirname, "before-multi-family.sql"), "utf8").replace(/^--.*$/gm, "");
  for (const statement of text.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await sql(statement);
}

/** One row in every family table, written the way today's (and brooker-wedding's) code writes them: no family_id. */
async function oldRows() {
  const [baby] = await sql(`INSERT INTO maple_babies (name, nickname, sex, due_date, timezone) VALUES ('Sample Baby', 'Sam', 'female', '2026-11-01', 'America/Denver') RETURNING id`);
  await sql(`INSERT INTO maple_members (email, role, display_name, added_by) VALUES ('pat.sample@example.com', 'owner', 'Pat', 'self')`);
  await sql(`INSERT INTO maple_entries (baby_id, kind, started_at, data, client_id) VALUES ($1, 'diaper', NOW(), '{"pee":true}', 'old-client-1')`, [baby.id]);
  await sql(`INSERT INTO maple_removed (email, removed_by) VALUES ('gone.sample@example.com', 'pat.sample@example.com')`);
  await sql(`INSERT INTO maple_invites (token_hash, role, created_by, expires_at) VALUES (repeat('a', 64), 'member', 'pat.sample@example.com', NOW() + INTERVAL '7 days')`);
  await sql(`INSERT INTO maple_tokens (member, token_hash, label) VALUES ('pat.sample@example.com', repeat('b', 64), 'Phone')`);
  await sql(`INSERT INTO maple_care_people (member) VALUES ('Quinn')`);
  await sql(`INSERT INTO maple_care_meds (id, person, name, client_id) VALUES (10000011, 'Quinn', 'Acetaminophen', 'old-med-1')`);
  await sql(`INSERT INTO maple_care_entries (id, person, kind, med_id, at, client_id) VALUES (10000012, 'Quinn', 'dose', 10000011, NOW(), 'old-dose-1')`);
  await sql(`INSERT INTO maple_care_mood (person, kind, at, client_id) VALUES ('Quinn', 'checkin', NOW(), 'old-mood-1')`);
  await sql(`INSERT INTO maple_push_subs (member, endpoint, p256dh, auth) VALUES ('pat.sample@example.com', 'https://push.example.test/old', 'k', 'a')`);
  await sql(`INSERT INTO maple_chat_threads (id, member, model) VALUES ('thread_old', 'pat.sample@example.com', 'zai/glm-5.3-flash')`);
  await sql(`INSERT INTO maple_chat_messages (id, thread_id, member, seq, role, parts) VALUES ('msg_old', 'thread_old', 'pat.sample@example.com', 1, 'user', '[]')`);
  await sql(`INSERT INTO maple_chat_daily (member, day, messages) VALUES ('pat.sample@example.com', CURRENT_DATE, 2)`);
  await sql(`INSERT INTO maple_consents (member, kind, version) VALUES ('pat.sample@example.com', 'chat', 1)`);
  await sql(`INSERT INTO maple_ai_usage (member, step, model, cost_micro_usd, price_key) VALUES ('pat.sample@example.com', 1, 'zai/glm-5.3-flash', 120, 'zai/glm-5.3-flash')`);
  for (const key of ["tick", "tick:qstash", "net:30", "wake:1790000000", "miss:med:10000011:1", "gap:2026-10-20T00:00:00.000Z", "med:10000011:1790000000:9"]) {
    await sql(`INSERT INTO maple_push_sent (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`, [key]);
  }
}

async function upgrade() {
  await test("upgrading today's production schema: every existing row lands in family 1, keys validate, nothing else moves", async () => {
    await freshDb({ migrations: 0 });
    await loadBeforeSchema();
    await oldRows();
    const before: Record<string, number> = {};
    for (const t of [...FAMILY_TABLES, ...FAMILY_OPTIONAL_TABLES]) before[t] = Number((await sql(`SELECT COUNT(*)::int AS n FROM ${t}`))[0].n);
    await quietly(migrate);
    for (const t of FAMILY_TABLES) {
      eq(await sql(`SELECT family_id, COUNT(*)::int AS n FROM ${t} GROUP BY 1`), [{ family_id: "1", n: before[t] }], t);
    }
    eq(await sql(`SELECT family_id, COUNT(*)::int AS n FROM maple_ai_usage GROUP BY 1`), [{ family_id: "1", n: 1 }], "ai_usage");
    const sent = await sql(`SELECT key, family_id FROM maple_push_sent ORDER BY key`);
    const filed = sent.filter((r) => r.family_id !== null).map((r) => r.key);
    eq(filed, ["gap:2026-10-20T00:00:00.000Z", "miss:med:10000011:1"], "only miss: and gap: claims are filed under family 1");
    eq(await sql(`SELECT id, timezone, status FROM maple_families`), [{ id: "1", timezone: "America/Denver", status: "active" }], "family 1 takes the baby's timezone");
    const bad = await sql(`SELECT conname FROM pg_constraint WHERE conname LIKE 'fk_%_family' AND NOT convalidated`);
    eq(bad, []);
  });

  await test("upgrading, then migrating again: the second run is a no-op on a populated database", async () => {
    await freshDb({ migrations: 0 });
    await loadBeforeSchema();
    await oldRows();
    await quietly(migrate);
    const first = await snapshot();
    await quietly(migrate);
    eq(await snapshot(), first);
  });

  await test("after families exist, a cost row without a family stays unfiled (a deleted family's cost is never moved to family 1)", async () => {
    await freshDb();
    await sql(`INSERT INTO maple_families (timezone, status) VALUES ('America/Chicago', 'active')`);
    await sql(`INSERT INTO maple_ai_usage (member, step, model, cost_micro_usd, price_key) VALUES ('x@example.com', 1, 'm', 5, 'm')`);
    await quietly(migrate);
    eq(await sql(`SELECT family_id FROM maple_ai_usage`), [{ family_id: null }]);
  });
}

/** Inserts the way code from before families writes them (brooker-wedding's copy among it), one per table. */
const OLD_INSERTS: Record<string, string> = {
  maple_babies: `INSERT INTO maple_babies (name) VALUES ('Old Code Baby')`,
  maple_members: `INSERT INTO maple_members (email, role, display_name, emoji, added_by) VALUES ('old.code@example.com', 'member', 'Old', NULL, 'self') ON CONFLICT (email) DO NOTHING`,
  maple_entries: `INSERT INTO maple_entries (baby_id, kind, started_at, data, client_id) SELECT id, 'note', NOW(), '{}', 'old-code-1' FROM maple_babies ORDER BY id LIMIT 1 ON CONFLICT (client_id) WHERE client_id IS NOT NULL DO NOTHING`,
  maple_removed: `INSERT INTO maple_removed (email, removed_by) VALUES ('old.removed@example.com', 'x') ON CONFLICT (email) DO UPDATE SET removed_at = NOW()`,
  maple_invites: `INSERT INTO maple_invites (token_hash, role, expires_at) VALUES (repeat('c', 64), 'member', NOW() + INTERVAL '1 day')`,
  maple_tokens: `INSERT INTO maple_tokens (member, token_hash) VALUES ('old.code@example.com', repeat('d', 64))`,
  maple_care_people: `INSERT INTO maple_care_people (member, created_by) VALUES ('Brook', 'x')`,
  maple_care_meds: `INSERT INTO maple_care_meds (id, person, name) VALUES (10000021, 'Brook', 'Acetaminophen')`,
  maple_care_entries: `INSERT INTO maple_care_entries (id, person, kind, at, client_id) VALUES (10000022, 'Brook', 'temp', NOW(), 'old-care-1') ON CONFLICT (client_id) WHERE client_id IS NOT NULL DO NOTHING`,
  maple_care_mood: `INSERT INTO maple_care_mood (person, kind, at) VALUES ('Brook', 'checkin', NOW())`,
  maple_push_subs: `INSERT INTO maple_push_subs (member, endpoint, p256dh, auth) VALUES ('old.code@example.com', 'https://push.example.test/old-code', 'k', 'a') ON CONFLICT (endpoint) DO UPDATE SET member = EXCLUDED.member`,
  maple_chat_threads: `INSERT INTO maple_chat_threads (id, member, model) VALUES ('thread_old_code', 'old.code@example.com', 'm')`,
  maple_chat_messages: `INSERT INTO maple_chat_messages (id, thread_id, member, seq, role, parts) VALUES ('msg_old_code', 'thread_old_code', 'old.code@example.com', 1, 'user', '[]')`,
  maple_chat_daily: `INSERT INTO maple_chat_daily (member, day, messages) VALUES ('old.code@example.com', CURRENT_DATE, 1) ON CONFLICT (member, day) DO UPDATE SET messages = maple_chat_daily.messages + 1`,
  maple_consents: `INSERT INTO maple_consents (member, kind, version) VALUES ('old.code@example.com', 'chat', 1) ON CONFLICT (member, kind) DO UPDATE SET version = EXCLUDED.version`,
  maple_push_sent: `INSERT INTO maple_push_sent (key, sent_at) VALUES ('tick', NOW()) ON CONFLICT (key) DO UPDATE SET sent_at = NOW()`,
  maple_ai_usage: `INSERT INTO maple_ai_usage (member, step, model, cost_micro_usd, price_key) VALUES ('old.code@example.com', 1, 'm', 7, 'm')`,
};

/** The family-led targets Phase 2 code switches to. */
const NEW_TARGETS = [
  `INSERT INTO maple_members (family_id, email, role) VALUES (1, 'new.code@example.com', 'member') ON CONFLICT (family_id, email) DO NOTHING`,
  `INSERT INTO maple_removed (family_id, email) VALUES (1, 'new.removed@example.com') ON CONFLICT (family_id, email) DO UPDATE SET removed_at = NOW()`,
  `INSERT INTO maple_entries (family_id, baby_id, kind, started_at, client_id) SELECT 1, id, 'note', NOW(), 'new-code-1' FROM maple_babies WHERE family_id = 1 ORDER BY id LIMIT 1 ON CONFLICT (family_id, client_id) WHERE client_id IS NOT NULL DO NOTHING`,
  `INSERT INTO maple_chat_daily (family_id, member, day, messages) VALUES (1, 'new.code@example.com', CURRENT_DATE, 1) ON CONFLICT (family_id, member, day) DO UPDATE SET messages = maple_chat_daily.messages + 1`,
  `INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth) VALUES (1, 'new.code@example.com', 'https://push.example.test/new-code', 'k', 'a') ON CONFLICT (family_id, endpoint) DO UPDATE SET member = EXCLUDED.member`,
  `INSERT INTO maple_consents (family_id, member, kind, version) VALUES (1, 'new.code@example.com', 'chat', 1) ON CONFLICT (family_id, member, kind) DO UPDATE SET version = EXCLUDED.version`,
];

async function olderCode() {
  await test("on the production shape, an INSERT without family_id lands in family 1 in every family table", async () => {
    await freshDb();
    for (const [table, insert] of Object.entries(OLD_INSERTS)) {
      if (table === "maple_entries") await sql(OLD_INSERTS.maple_babies);
      await sql(insert);
    }
    for (const t of FAMILY_TABLES) eq(await sql(`SELECT DISTINCT family_id FROM ${t}`), [{ family_id: "1" }], t);
    eq(await sql(`SELECT family_id FROM maple_push_sent WHERE key = 'tick'`), [{ family_id: null }], "maple_push_sent");
    eq(await sql(`SELECT DISTINCT family_id FROM maple_ai_usage`), [{ family_id: null }], "maple_ai_usage");
  });

  await test("older code's ON CONFLICT targets still match a key, run twice (the second insert conflicts)", async () => {
    await freshDb();
    await sql(OLD_INSERTS.maple_babies);
    await sql(OLD_INSERTS.maple_care_people);
    for (const insert of Object.values(OLD_INSERTS).filter((x) => x.includes("ON CONFLICT"))) {
      await sql(insert);
      eq(await sqlError(insert), null, insert.slice(0, 40));
    }
  });

  await test("Phase 2's family-led ON CONFLICT targets work beside the old keys", async () => {
    await freshDb();
    await sql(OLD_INSERTS.maple_babies);
    for (const insert of NEW_TARGETS) {
      await sql(insert);
      eq(await sqlError(insert), null, insert.slice(0, 40));
    }
  });
}

async function finalShape() {
  await test("final shape: an INSERT without family_id fails with 23502 in every family table", async () => {
    await freshDb({ shape: "final" });
    await seedFamilies();
    for (const t of FAMILY_TABLES) {
      const insert = OLD_INSERTS[t].replace(/ ON CONFLICT .*$/, "");
      eq(await sqlError(insert), "23502", t);
    }
  });

  await test("final shape: older code's ON CONFLICT targets fail with 42P10, the family-led ones work", async () => {
    await freshDb({ shape: "final" });
    await seedFamilies();
    for (const t of ["maple_members", "maple_removed", "maple_chat_daily", "maple_push_subs", "maple_consents", "maple_entries", "maple_care_entries"]) {
      const insert = OLD_INSERTS[t].replace(/^INSERT INTO (\w+) \(/, "INSERT INTO $1 (family_id, ").replace(/VALUES \(/, "VALUES (1, ").replace(/SELECT id,/, "SELECT 1, id,");
      eq(await sqlError(insert), "42P10", t);
    }
    for (const insert of NEW_TARGETS) eq(await sqlError(insert), null, insert.slice(0, 40));
  });

  await test("final shape: two families can share a member, a phone, a client_id and a care person's name", async () => {
    await freshDb({ shape: "final" });
    const { alpha, beta } = await seedFamilies();
    eq(await sqlError(`INSERT INTO maple_members (family_id, email, role) VALUES (2, $1, 'viewer')`, [alpha.owner]), null, "member");
    eq(await sqlError(`INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth) VALUES (2, $1, $2, 'k', 'a')`, [alpha.owner, alpha.pushEndpoint]), null, "endpoint");
    eq(await sqlError(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, client_id) VALUES (2, $1, 'note', NOW(), $2)`, [beta.babyId, alpha.entryClientId]), null, "client_id");
    eq(await sqlError(`INSERT INTO maple_care_people (family_id, member) VALUES (2, 'Dana')`), null, "care person");
  });

  await test("final shape: an entry can't name another family's baby (23503)", async () => {
    await freshDb({ shape: "final" });
    const { alpha } = await seedFamilies();
    eq(await sqlError(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at) VALUES (2, $1, 'note', NOW())`, [alpha.babyId]), "23503");
  });

  await test("the seed works on both shapes and keeps the families apart", async () => {
    for (const shape of ["production", "final"] as const) {
      await freshDb({ shape });
      const { alpha, beta } = await seedFamilies();
      eq([alpha.familyId, beta.familyId], [1, 2], shape);
      const per = await sql(`SELECT family_id, COUNT(*)::int AS n FROM maple_entries GROUP BY 1 ORDER BY 1`);
      eq(per, [{ family_id: "1", n: 3 }, { family_id: "2", n: 3 }], shape);
      eq(await sql(`SELECT family_id FROM maple_care_people`), [{ family_id: "1" }], `${shape}: only Alpha has a care page`);
    }
  });
}

const FORBIDDEN = [
  /\bDROP\s+(TABLE|COLUMN|CONSTRAINT|DEFAULT|SCHEMA)\b/i,
  /\bRENAME\b/i,
  /\bALTER\s+COLUMN\b/i,
  /\bSET\s+NOT\s+NULL\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bPRIMARY\s+KEY\s+USING\s+INDEX\b/i,
];
const ALLOWED_DROPS = [/DROP INDEX IF EXISTS idx_maple_entries_active/, /DROP INDEX (?:CONCURRENTLY )?IF EXISTS \$\{name\}/];

async function staticGuard() {
  await test("migrate.ts forbids destructive changes and allows the care-kind expansion", () => {
    const src = readFileSync(join(ROOT, "src", "lib", "migrate.ts"), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    const guarded = code.replace("ALTER TABLE maple_care_entries DROP CONSTRAINT IF EXISTS maple_care_entries_kind_check", "");
    for (const re of FORBIDDEN) {
      const hit = re.exec(guarded);
      ok(!hit, `migrate.ts has ${hit?.[0]}`);
    }
    const drops = code.match(/DROP INDEX[^`;]*/g) ?? [];
    for (const d of drops) ok(ALLOWED_DROPS.some((re) => re.test(d)), `migrate.ts drops an index: ${d}`);
    for (const m of code.matchAll(/ADD COLUMN IF NOT EXISTS [^`]*?NOT NULL[^`]*/g)) ok(/DEFAULT/.test(m[0]), `NOT NULL without a default: ${m[0]}`);
  });

  await test("the harness and the final shape refuse any database but pglite:", async () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://not-a-real-host.example.test/db";
    try {
      eq(await sqlError("SELECT 1"), "no_code");
      const { applyFinalShape } = await import("./final-shape");
      let refused = false;
      await applyFinalShape().catch(() => (refused = true));
      ok(refused, "applyFinalShape ran against a non-pglite URL");
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });
}

idempotency()
  .then(upgrade)
  .then(olderCode)
  .then(finalShape)
  .then(staticGuard)
  .then(() => done("schema.check.ts"));
