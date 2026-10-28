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
type Result = { entry?: { id: number; kind: string; data: Record<string, unknown>; note: string | null; at: string; updated_at: string }; entries?: { id: number }[]; created?: boolean; deduped?: boolean; reason?: string };
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

async function itemChecks({ owner, helper }: World) {
  const item = { name: "Synthetic oats", portion: "1 bowl", nutrients: { protein_g: 8, fiber_g: 4, energy_kcal: null }, groups: ["whole_grains"], source: "estimate", note: "Typical portion assumed" };
  const food = { description: "Synthetic breakfast", meal: "meal", items: [item] };

  await test("food details preserve unknowns and zero without adding calories", () => {
    const cleaned = cleanCareData("food", {
      ...food, items: [{ name: " Synthetic drink ", source: "manual", nutrients: { protein_g: 0, fiber_g: null, secret: 99 }, secret: "discard" }],
    });
    assert.deepEqual(cleaned, { description: food.description, meal: "meal", items: [{ name: "Synthetic drink", portion: null, nutrients: { protein_g: 0, fiber_g: null }, groups: null, source: "manual" }] });
  });

  const invalidItems: [string, unknown][] = [
    ["non-array", {}], ["null items", null], ["too many foods", Array.from({ length: 13 }, () => item)],
    ["null food", [null]], ["array food", [[]]], ["empty name", [{ ...item, name: " " }]],
    ["long name", [{ ...item, name: "x".repeat(121) }]], ["long portion", [{ ...item, portion: "x".repeat(121) }]],
    ["numeric portion", [{ ...item, portion: 1 }]], ["long note", [{ ...item, note: "x".repeat(501) }]],
    ["numeric note", [{ ...item, note: 4 }]], ["unknown source", [{ ...item, source: "verified" }]],
    ["missing source", [{ ...item, source: undefined }]], ["array nutrients", [{ ...item, nutrients: [] }]],
    ["null nutrients", [{ ...item, nutrients: null }]], ["unknown group", [{ ...item, groups: ["sweets"] }]],
    ["string groups", [{ ...item, groups: "protein" }]],
  ];
  for (const [label, nutrients] of [
    ["negative protein", { protein_g: -1 }], ["infinite protein", { protein_g: Infinity }],
    ["NaN fiber", { fiber_g: NaN }], ["string protein", { protein_g: "8" }],
    ["too much protein", { protein_g: 501 }], ["too much fiber", { fiber_g: 151 }],
    ["too many carbs", { carbs_g: 501 }], ["too much fat", { fat_g: 501 }],
    ["too much energy", { energy_kcal: 5001 }],
  ] as [string, unknown][]) invalidItems.push([label, [{ ...item, nutrients }]]);
  for (const [label, items] of invalidItems) {
    await test(`food details reject ${label}`, () => {
      assert.throws(() => cleanCareData("food", { ...food, items }));
    });
  }

  await test("food details pass through API normalization and persistence", async () => {
    const result = await call(entries.POST, helper, "POST", {
      kind: "food", at, data: { ...food, items: [{ ...item, name: " Synthetic oats ", portion: " 1 bowl ", note: " Typical portion assumed ", secret: true }] },
    });
    eq(result.status, 201);
    assert.deepEqual(result.body.entry?.data, food);
    const [stored] = await sql("SELECT data FROM maple_care_entries WHERE id = $1", [result.body.entry!.id]);
    assert.deepEqual(stored.data, food);
  });

  await test("food details reject malformed API data before saving", async () => {
    const before = await sql("SELECT COUNT(*)::int AS n FROM maple_care_entries");
    const result = await call(entries.POST, owner, "POST", { kind: "food", at, data: { ...food, items: [{ ...item, nutrients: { protein_g: -1 } }] } });
    eq(result.status, 400);
    eq(await sql("SELECT COUNT(*)::int AS n FROM maple_care_entries"), before);
  });

  await test("food details survive description, time and note corrections", async () => {
    const entry = await create(owner, "food");
    await sql("UPDATE maple_care_entries SET data = $2::jsonb WHERE id = $1", [entry.id, JSON.stringify(food)]);
    const changed = await call(entries.PATCH, helper, "PATCH", { data: { description: "Synthetic corrected breakfast" }, at, note: "Synthetic correction" }, `?id=${entry.id}`);
    eq(changed.status, 200);
    assert.deepEqual(changed.body.entry?.data, { ...food, description: "Synthetic corrected breakfast" });
  });

  await test("food details replace explicitly and survive removal and restore", async () => {
    const entry = await create(owner, "food");
    const replacement = { ...item, portion: "2 bowls", nutrients: { protein_g: 16, fiber_g: 8 }, source: "label", note: null };
    const data = { ...entry.data, items: [replacement] };
    const changed = await call(entries.PATCH, owner, "PATCH", { data: { items: [replacement] } }, `?id=${entry.id}`);
    assert.deepEqual(changed.body.entry?.data, data);
    await call(entries.DELETE, owner, "DELETE", undefined, `?id=${entry.id}`);
    assert.deepEqual((await call(restore.POST, helper, "POST", undefined, `?id=${entry.id}`)).body.entry?.data, data);
    assert.deepEqual((await call(entries.PATCH, owner, "PATCH", { data: { items: [] } }, `?id=${entry.id}`)).body.entry?.data, { ...entry.data, items: [] });
  });
}

async function nutritionRevisionChecks({ owner, helper, alpha }: World) {
  await test("food revisions refuse stale item snapshots and accept fresh or partial corrections", async () => {
    const item = { name: "Synthetic oats", portion: "1 bowl", nutrients: { protein_g: 6 }, groups: null, source: "estimate" };
    const made = await call(entries.POST, owner, "POST", { kind: "food", at, data: { description: "Synthetic oats", meal: "meal", items: [item] } });
    const entry = made.body.entry!;
    const latest = { ...entry.data, items: [{ ...item, nutrients: { protein_g: 12 }, source: "label", note: "Synthetic label correction" }] };
    await sql("UPDATE maple_care_entries SET data = $2::jsonb, updated_at = $3::timestamptz WHERE id = $1", [entry.id, JSON.stringify(latest), "2026-01-01T00:00:00.124456Z"]);
    const stale = await call(entries.PATCH, owner, "PATCH", { data: { ...entry.data, description: "Synthetic renamed meal" }, expect_updated_at: "2026-01-01T00:00:00.123Z" }, `?id=${entry.id}`);
    eq([stale.status, stale.body.reason], [409, "changed"]);
    assert.deepEqual(stale.body.entry?.data, latest);
    assert.deepEqual((await sql("SELECT data FROM maple_care_entries WHERE id = $1", [entry.id]))[0].data, latest);
    const fresh = await call(entries.PATCH, helper, "PATCH", { data: { description: "Synthetic corrected breakfast" }, expect_updated_at: stale.body.entry!.updated_at }, `?id=${entry.id}`);
    eq(fresh.status, 200, "fresh food revision");
    const partial = await call(entries.PATCH, owner, "PATCH", { note: "Synthetic note" }, `?id=${entry.id}`);
    assert.deepEqual(partial.body.entry?.data, { ...latest, description: "Synthetic corrected breakfast" });
    eq(partial.body.entry?.note, "Synthetic note");
    await call(entries.DELETE, owner, "DELETE", undefined, `?id=${entry.id}`);
    eq((await call(entries.PATCH, helper, "PATCH", { data: latest, expect_updated_at: fresh.body.entry!.updated_at }, `?id=${entry.id}`)).status, 404);
    eq((await call(entries.PATCH, owner, "PATCH", { data: { name: "Synthetic medicine" }, note: "Synthetic dose note", expect_updated_at: "2020-01-01T00:00:00.000Z" }, `?id=${alpha.care!.doseId}`)).status, 200, "dose corrections keep last-write-wins behavior");
  });

  await test("drink revisions reject stale or future versions without replacing the amount", async () => {
    const entry = await create(owner, "drink");
    await sql("UPDATE maple_care_entries SET data = $2::jsonb, updated_at = $3::timestamptz WHERE id = $1", [entry.id, JSON.stringify({ name: "Synthetic water", amount_ml: 300 }), "2026-01-01T00:00:00.321987Z"]);
    for (const expect_updated_at of ["2026-01-01T00:00:00.320Z", "2026-01-01T00:00:00.322Z"]) {
      const stale = await call(entries.PATCH, helper, "PATCH", { data: { name: "Synthetic tea", amount_ml: 10 }, expect_updated_at }, `?id=${entry.id}`);
      eq([stale.status, stale.body.entry?.data.amount_ml], [409, 300]);
    }
    const fresh = await call(entries.PATCH, owner, "PATCH", { data: { name: "Synthetic tea" }, expect_updated_at: "2026-01-01T00:00:00.321Z" }, `?id=${entry.id}`);
    eq(fresh.status, 200);
    assert.deepEqual(fresh.body.entry?.data, { name: "Synthetic tea", amount_ml: 300 });
  });

  await test("concurrent food corrections cannot both replace one recorded version", async () => {
    const entry = await create(owner, "food");
    const results = await Promise.all(["Synthetic first correction", "Synthetic second correction"].map((description) =>
      call(entries.PATCH, helper, "PATCH", { data: { description }, expect_updated_at: entry.updated_at }, `?id=${entry.id}`),
    ));
    eq(results.map((result) => result.status).sort(), [200, 409]);
    const saved = results.find((result) => result.status === 200)!.body.entry!;
    const refused = results.find((result) => result.status === 409)!.body.entry!;
    assert.deepEqual(refused.data, saved.data);
  });

  await test("nutrition revisions remain distinct when PostgreSQL keeps the same transaction clock", async () => {
    const entry = await create(owner, "food");
    await sql("BEGIN");
    try {
      const [row] = await sql("UPDATE maple_care_entries SET updated_at = date_trunc('milliseconds', NOW()) WHERE id = $1 RETURNING updated_at", [entry.id]);
      const version = new Date(row.updated_at as string | Date).toISOString();
      const first = await call(entries.PATCH, owner, "PATCH", { data: { description: "Synthetic first save" }, expect_updated_at: version }, `?id=${entry.id}`);
      eq(first.status, 200);
      ok(Date.parse(first.body.entry!.updated_at) > Date.parse(version), "a successful save must advance the browser-visible revision");
      const stale = await call(entries.PATCH, helper, "PATCH", { data: { description: "Synthetic stale save" }, expect_updated_at: version }, `?id=${entry.id}`);
      eq(stale.status, 409);
      const fresh = await call(entries.PATCH, helper, "PATCH", { note: "Synthetic fresh save", expect_updated_at: first.body.entry!.updated_at }, `?id=${entry.id}`);
      eq(fresh.status, 200);
      ok(Date.parse(fresh.body.entry!.updated_at) > Date.parse(first.body.entry!.updated_at), "the next save also advances the revision");
    } finally {
      await sql("ROLLBACK");
    }
  });

  for (const kind of ["food", "drink"] as const) {
    await test(`${kind}: delete and restore cannot reuse a previous revision`, async () => {
      const entry = await create(owner, kind);
      const data = kind === "food"
        ? { ...entry.data, items: [{ name: "Synthetic oats", portion: "1 bowl", nutrients: { protein_g: 12 }, groups: null, source: "label" }] }
        : { name: "Synthetic water", amount_ml: 300 };
      await sql("BEGIN");
      try {
        const [row] = await sql("UPDATE maple_care_entries SET updated_at = date_trunc('milliseconds', NOW()) WHERE id = $1 RETURNING updated_at", [entry.id]);
        const version = new Date(row.updated_at as string | Date).toISOString();
        const changed = await call(entries.PATCH, owner, "PATCH", { data, expect_updated_at: version }, `?id=${entry.id}`);
        eq(changed.status, 200);
        const removed = await call(entries.DELETE, helper, "DELETE", undefined, `?id=${entry.id}`);
        eq(removed.status, 200);
        const restored = await call(restore.POST, helper, "POST", undefined, `?id=${entry.id}`);
        eq(restored.status, 200);
        for (const expect_updated_at of [version, changed.body.entry!.updated_at]) {
          const stale = await call(entries.PATCH, owner, "PATCH", { data: entry.data, expect_updated_at }, `?id=${entry.id}`);
          eq([stale.status, stale.body.reason], [409, "changed"]);
          assert.deepEqual(stale.body.entry?.data, data);
        }
        ok(Date.parse(removed.body.entry!.updated_at) > Date.parse(changed.body.entry!.updated_at), "delete advances the revision");
        ok(Date.parse(restored.body.entry!.updated_at) > Date.parse(removed.body.entry!.updated_at), "restore advances the revision");
        const fresh = await call(entries.PATCH, owner, "PATCH", { note: "Synthetic note after Undo", expect_updated_at: restored.body.entry!.updated_at }, `?id=${entry.id}`);
        eq(fresh.status, 200);
        assert.deepEqual(fresh.body.entry?.data, data);
      } finally {
        await sql("ROLLBACK");
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
  await itemChecks(world);
  await nutritionRevisionChecks(world);
  done("nutrition.check.ts");
}

main().catch((error) => { console.error(error); process.exit(1); });
