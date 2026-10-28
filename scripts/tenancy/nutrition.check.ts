import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { encryptSecret } from "../../src/lib/secret-box";
import { migrate } from "../../src/lib/migrate";
import { createCarePerson } from "../../src/lib/maple/care-store";
import { cleanCareData } from "../../src/lib/maple/validate";
import type { CareKind } from "../../src/lib/maple/types";
import * as entries from "../../src/app/api/maple/care/entries/route";
import * as restore from "../../src/app/api/maple/care/entries/restore/route";
import { done, eq, freshDb, ok, quietly, seedFamilies, sql, sqlError, test, type FamilySeed } from "./harness";

delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
process.env.GOOGLE_CLIENT_SECRET = "made-up-nutrition-session-secret";

type Route = (request: NextRequest) => Promise<Response>;
type Result = { entry?: { id: number; kind: string; data: Record<string, unknown>; note: string | null; at: string }; entries?: { id: number }[]; created?: boolean; deduped?: boolean };
type World = { alpha: FamilySeed; beta: FamilySeed; owner: string; helper: string; other: string; viewer: string };
const at = new Date(Date.now() - 60_000).toISOString();
const cookie = (id: string, familyId: number) => encryptSecret(JSON.stringify({ id, fam: familyId, iat: Date.now() }));

async function call(route: Route, session: string, method = "GET", body?: unknown, query = "") {
  const request = new NextRequest(`http://localhost:3000/api/maple/care/entries${query}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  request.cookies.set("maple_session", session);
  const response = await route(request);
  return { status: response.status, body: await response.json() as Result };
}

async function create(session: string, kind: "food" | "drink", clientId?: string) {
  const data = kind === "food" ? { description: "Example lentil toast", meal: "meal" } : { name: "Example citrus water", amount_ml: 240 };
  const result = await call(entries.POST, session, "POST", { kind, at, data, ...(clientId ? { client_id: clientId } : {}) });
  eq(result.status, 201);
  return result.body.entry!;
}

async function migrationChecks({ alpha, owner }: World) {
  await test("nutrition migration upgrades the old constraint twice without losing entries", async () => {
    const before = await sql("SELECT id, kind, data, at FROM maple_care_entries WHERE id = $1", [alpha.care!.doseId]);
    await sql("ALTER TABLE maple_care_entries DROP CONSTRAINT IF EXISTS maple_care_entries_kind_v2_check");
    await sql("ALTER TABLE maple_care_entries DROP CONSTRAINT IF EXISTS maple_care_entries_kind_check");
    await sql("ALTER TABLE maple_care_entries ADD CONSTRAINT maple_care_entries_kind_check CHECK (kind IN ('dose', 'temp', 'question', 'bp'))");
    await quietly(migrate);
    await create(owner, "food");
    await create(owner, "drink");
    await quietly(migrate);
    eq(await sql("SELECT id, kind, data, at FROM maple_care_entries WHERE id = $1", [alpha.care!.doseId]), before);
    eq(await sqlError("INSERT INTO maple_care_entries (id, family_id, person, kind, at) VALUES (90000001, $1, $2, 'unknown_kind', $3)", [alpha.familyId, alpha.care!.person, at]), "23514");
  });
}

async function loggingChecks({ alpha, owner, helper }: World) {
  await test("food: caregiver logging keeps the food on the mother's family page", async () => {
    const result = await call(entries.POST, helper, "POST", {
      kind: "food", at, data: { description: "  Example lentil toast  ", meal: "snack", calories: 123 }, note: "  Example note  ",
    });
    eq(result.status, 201);
    assert.deepEqual(result.body.entry?.data, { description: "Example lentil toast", meal: "snack" });
    eq(result.body.entry?.note, "Example note");
    const [row] = await sql("SELECT family_id, person, created_by, med_id FROM maple_care_entries WHERE id = $1", [result.body.entry!.id]);
    eq(row, { family_id: String(alpha.familyId), person: alpha.care!.person, created_by: alpha.member, med_id: null });
    const listed = await call(entries.GET, owner, "GET", undefined, "?kind=food");
    eq(listed.status, 200);
    ok(listed.body.entries?.some((entry) => entry.id === result.body.entry!.id), "food is listed on her page");
    eq(await sql("SELECT COUNT(*)::int AS n FROM maple_entries WHERE id = $1 AND kind = 'food'", [result.body.entry!.id]), [{ n: 0 }]);
  });

  await test("drink: name-only logging preserves an unknown amount", async () => {
    const result = await call(entries.POST, owner, "POST", { kind: "drink", at, data: { name: "  Example water  ", calories: 10 } });
    eq(result.status, 201);
    eq(result.body.entry?.data, { name: "Example water" });
    const named = await call(entries.GET, owner, "GET", undefined, "?kind=drink");
    eq(named.status, 200);
    ok(named.body.entries?.some((entry) => entry.id === result.body.entry!.id), "drink is listed");
  });

  await test("food: blank or long descriptions and unrecognized meal types are rejected", async () => {
    await create(owner, "food");
    for (const data of [
      { description: " ", meal: "meal" },
      { description: "x".repeat(501), meal: "meal" },
      { description: 12, meal: "meal" },
      { description: "Example toast", meal: "breakfast" },
      { description: "Example toast" },
    ]) {
      eq((await call(entries.POST, owner, "POST", { kind: "food", at, data })).status, 400);
    }
  });

  await test("drink: amounts stay optional and reject nonpositive, nonfinite and excessive values", async () => {
    eq(cleanCareData("drink" as CareKind, { name: "Example tea", amount_ml: null }), { name: "Example tea", amount_ml: null });
    for (const amount_ml of [0, -10, NaN, Infinity, 5001, "240"]) {
      assert.throws(() => cleanCareData("drink" as CareKind, { name: "Example tea", amount_ml }));
    }
    for (const data of [{ name: "" }, { name: "x".repeat(101) }, { name: 12 }, { name: "Example tea", amount_ml: 0 }]) {
      eq((await call(entries.POST, owner, "POST", { kind: "drink", at, data })).status, 400);
    }
  });
}

async function lifecycleChecks({ alpha, beta, owner, helper, other, viewer }: World) {
  for (const kind of ["food", "drink"] as const) {
    await test(`${kind}: edit, delete and restore retain the entry's data`, async () => {
      const entry = await create(owner, kind);
      const changedAt = new Date(Date.parse(at) - 10 * 60_000).toISOString();
      const data = kind === "food" ? { description: "Example bean bowl", meal: "snack" } : { name: "Example milk", amount_ml: 180 };
      const changed = await call(entries.PATCH, helper, "PATCH", { at: changedAt, data }, `?id=${entry.id}`);
      eq(changed.status, 200);
      assert.deepEqual(changed.body.entry?.data, data);
      eq(changed.body.entry?.at, changedAt);
      const invalid = kind === "food" ? { description: "" } : { amount_ml: -1 };
      eq((await call(entries.PATCH, owner, "PATCH", { data: invalid }, `?id=${entry.id}`)).status, 400);
      eq((await call(entries.DELETE, owner, "DELETE", undefined, `?id=${entry.id}`)).status, 200);
      ok(!(await call(entries.GET, owner)).body.entries?.some((item) => item.id === entry.id), "deleted entry is absent");
      const restored = await call(restore.POST, helper, "POST", undefined, `?id=${entry.id}`);
      eq(restored.status, 200);
      assert.deepEqual(restored.body.entry?.data, data);
    });

    await test(`${kind}: retries are idempotent within each family`, async () => {
      const client_id = `shared-nutrition-${kind}-0001`;
      const first = await create(owner, kind, client_id);
      const again = await call(entries.POST, helper, "POST", { kind, at, data: first.data, client_id });
      eq([again.status, again.body.created, again.body.deduped, again.body.entry?.id], [200, false, true, first.id]);
      const separate = await create(other, kind, client_id);
      ok(separate.id !== first.id, "the other family owns a separate entry");
    });

    await test(`${kind}: another family and view-only guests cannot read or mutate it`, async () => {
      const entry = await create(owner, kind);
      for (const session of [other, viewer]) {
        const list = await call(entries.GET, session);
        eq(list.status, session === other ? 200 : 404);
        ok(!list.body.entries?.some((item) => item.id === entry.id), "entry is not disclosed");
        eq((await call(entries.PATCH, session, "PATCH", { note: "Example change" }, `?id=${entry.id}`)).status, 404);
        eq((await call(entries.DELETE, session, "DELETE", undefined, `?id=${entry.id}`)).status, 404);
      }
      eq((await call(entries.POST, viewer, "POST", { kind, at, data: entry.data })).status, 404);
      eq((await call(entries.GET, cookie(beta.owner, alpha.familyId))).status, 401);
      eq((await call(entries.DELETE, owner, "DELETE", undefined, `?id=${entry.id}`)).status, 200);
      for (const session of [other, viewer]) {
        eq((await call(restore.POST, session, "POST", undefined, `?id=${entry.id}`)).status, 404);
      }
    });
  }
}

async function main() {
  await freshDb({ shape: "final" });
  const { alpha, beta } = await seedFamilies();
  await createCarePerson(beta, alpha.care!.person, beta.owner, []);
  const world = {
    alpha, beta,
    owner: cookie(alpha.owner, alpha.familyId),
    helper: cookie(alpha.member, alpha.familyId),
    other: cookie(beta.owner, beta.familyId),
    viewer: cookie(alpha.viewer, alpha.familyId),
  };
  await migrationChecks(world);
  await loggingChecks(world);
  await lifecycleChecks(world);
  done("nutrition.check.ts");
}

main().catch((error) => { console.error(error); process.exit(1); });
