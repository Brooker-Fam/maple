import { transaction } from "../../src/lib/db";
import { migrate } from "../../src/lib/migrate";
import { signupBlockers } from "../../src/lib/maple/family";
import { runFamilyContract, validateContractTarget } from "../family-contract";
import { done, eq, freshDb, ok, quietly, seedFamilies, sql, sqlError, test } from "./harness";

globalThis.fetch = async () => { throw new Error("contract_check_external_network_disabled"); };

async function rows() {
  const tables = await sql(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'maple_%' ORDER BY tablename`);
  const result: Record<string, unknown> = {};
  for (const { tablename } of tables) {
    result[String(tablename)] = await sql(`SELECT count(*)::int AS n, md5(COALESCE(string_agg(to_jsonb(t)::text, '' ORDER BY to_jsonb(t)::text), '')) AS digest FROM ${tablename} t`);
  }
  return result;
}

async function schema() {
  return {
    columns: await sql(`SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`),
    indexes: await sql(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`),
    constraints: await sql(`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`),
  };
}

async function database(): Promise<string> {
  return String((await sql(`SELECT current_database() AS name`))[0].name);
}

async function rejection(fn: () => unknown | Promise<unknown>): Promise<string> {
  try { await fn(); } catch (error) { return (error as Error).message; }
  return "not_rejected";
}

async function main() {
  await test("contract target requires the exact unpooled TLS hostname and database", async () => {
    const url = "postgresql://synthetic:synthetic@ep-synthetic.example.invalid/maple?sslmode=require";
    const host = "ep-synthetic.example.invalid";
    eq(validateContractTarget(url, host, "maple"), url);
    for (const [raw, expectedHost, expectedDb] of [
      [undefined, host, "maple"],
      [url, "", "maple"],
      [url, host, ""],
      [url, "ep-other.example.invalid", "maple"],
      [url, host, "other"],
      [url.replace("ep-synthetic.", "ep-synthetic-pooler."), "ep-synthetic-pooler.example.invalid", "maple"],
      [url.replace("require", "disable"), host, "maple"],
      [url.replace("postgresql:", "https:"), host, "maple"],
      [url + "&host=ep-other.example.invalid", host, "maple"],
      [url + "&sslmode=disable", host, "maple"],
      [url.replace("/maple?", ":5433/maple?"), host, "maple"],
    ] as const) {
      ok((await rejection(() => validateContractTarget(raw, expectedHost, expectedDb))).startsWith("family_contract_"), "unsafe target refused");
    }
    await freshDb();
    const before = await schema();
    eq(await rejection(() => runFamilyContract(transaction, "wrong_database")), "family_contract_database_mismatch");
    eq(await schema(), before);
  });

  await test("contract and subsequent builds preserve rows and allow shared members, client ids and care names", async () => {
    await freshDb();
    const { alpha, beta } = await seedFamilies();
    const before = await rows();
    const db = await database();
    await runFamilyContract(transaction, db);
    eq(await rows(), before);
    eq(await signupBlockers(), []);
    const contracted = await schema();
    await runFamilyContract(transaction, db);
    await quietly(migrate);
    await quietly(migrate);
    eq(await schema(), contracted, "builds neither recreate legacy indexes nor duplicate the primary indexes");
    eq(await rows(), before);
    await sql(`INSERT INTO maple_members (family_id, email, role, accepted_at) VALUES (2, $1, 'member', NOW())`, [alpha.owner]);
    await sql(`INSERT INTO maple_removed (family_id, email) VALUES (2, 'removed.alpha@example.com')`);
    await sql(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, client_id) VALUES (2, $1, 'diaper', NOW(), $2)`, [beta.babyId, alpha.entryClientId]);
    await sql(`INSERT INTO maple_care_people (family_id, member) VALUES (2, 'Dana')`);
    await sql(`UPDATE maple_care_meds SET client_id = 'synthetic-shared-med' WHERE family_id = 1`);
    await sql(`INSERT INTO maple_care_meds (family_id, id, person, name, client_id) VALUES (2, 20000011, 'Dana', 'Synthetic medicine', 'synthetic-shared-med')`);
    await sql(`INSERT INTO maple_care_entries (family_id, id, person, kind, at, client_id) VALUES (2, 20000012, 'Dana', 'temp', NOW(), $1)`, [alpha.care!.doseClientId]);
    await sql(`INSERT INTO maple_care_mood (family_id, person, kind, at, data, client_id) VALUES (1, 'Dana', 'checkin', NOW(), '{}', 'synthetic-shared-mood'), (2, 'Dana', 'checkin', NOW(), '{}', 'synthetic-shared-mood')`);
    await sql(`INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, receipt_token) VALUES (2, $1, $2, 'made-up', 'made-up', 'cccccccccccccccccccccccccccccccc')`, [alpha.owner, alpha.pushEndpoint]);
    await sql(`INSERT INTO maple_chat_daily (family_id, member, day) VALUES (2, $1, DATE '2026-10-20')`, [alpha.owner]);
    await sql(`INSERT INTO maple_consents (family_id, member, kind, version) VALUES (2, $1, 'chat', 1)`, [alpha.owner]);
    eq(await sqlError(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at) VALUES (2, $1, 'diaper', NOW())`, [alpha.babyId]), "23503", "cross-family baby rejected");
    eq(await sqlError(`INSERT INTO maple_members (email) VALUES ('forgot-family@example.invalid')`), "23502", "missing family rejected");
    const populated = await rows();
    await quietly(migrate);
    await runFamilyContract(transaction, db);
    eq(await rows(), populated);
    eq(await schema(), contracted);
  });

  await test("contract refuses recent legacy claims and leaves every row and schema object unchanged", async () => {
    for (const key of ["s4|synthetic", "wake:1234"]) {
      await freshDb();
      await sql(`INSERT INTO maple_push_sent (key, family_id, sent_at) VALUES ($1, NULL, NOW())`, [key]);
      const before = { rows: await rows(), schema: await schema() };
      const db = await database();
      eq(await rejection(() => runFamilyContract(transaction, db)), "family_contract_older_copy_active");
      eq({ rows: await rows(), schema: await schema() }, before);
    }
  });

  await test("a failed late constraint validation rolls back earlier contract DDL", async () => {
    await freshDb();
    await sql(`INSERT INTO maple_consents (family_id, member, kind, version) VALUES (NULL, 'synthetic@example.invalid', 'chat', 1)`);
    const before = { rows: await rows(), schema: await schema() };
    const db = await database();
    ok((await rejection(() => runFamilyContract(transaction, db))) !== "not_rejected", "invalid existing family row rejected");
    eq({ rows: await rows(), schema: await schema() }, before, "earlier NOT NULL/default changes rolled back");
  });

  await test("contract row verification detects a changed record and rolls back the transaction", async () => {
    await freshDb();
    const before = { rows: await rows(), schema: await schema() };
    const db = await database();
    const corrupt: typeof transaction = (statements) => transaction([
      ...statements.slice(0, -1),
      { sql: `UPDATE maple_families SET name = 'synthetic changed record' WHERE id = 1` },
      statements.at(-1)!,
    ]);
    eq(await rejection(() => runFamilyContract(corrupt, db)), "family_contract_rows_changed");
    eq({ rows: await rows(), schema: await schema() }, before);
  });

  await test("reverse restores the original family1 schema and refuses after another family exists", async () => {
    await freshDb();
    await sql(`INSERT INTO maple_care_people (family_id, member) VALUES (1, 'Synthetic caregiver')`);
    const before = { rows: await rows(), schema: await schema() };
    const db = await database();
    await runFamilyContract(transaction, db);
    await sql(`INSERT INTO maple_families (timezone) VALUES ('UTC')`);
    const withTwo = { rows: await rows(), schema: await schema() };
    eq(await rejection(() => runFamilyContract(transaction, db, "rollback")), "family_contract_rollback_has_other_families");
    eq({ rows: await rows(), schema: await schema() }, withTwo);
    await sql(`DELETE FROM maple_families WHERE id = 2`);
    await runFamilyContract(transaction, db, "rollback");
    eq({ rows: await rows(), schema: await schema() }, before);
    await runFamilyContract(transaction, db, "rollback");
    eq({ rows: await rows(), schema: await schema() }, before);
  });

  done("family contract");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
