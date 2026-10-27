import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { encryptSecret } from "../../src/lib/secret-box";
import {
  addCareQuestion,
  careDiscardedBy,
  careRev,
  careSession,
  careStateFor,
  carePlanViews,
  createCarePerson,
  createCareEntry,
  createMood,
  DEFAULT_CARE_PERSON,
  deleteCareEntry,
  deleteCarePerson,
  deleteCarePlan,
  deleteMood,
  getCarePerson,
  listCareEntries,
  listCarePlans,
  listMood,
  logCareDose,
  logCareTemp,
  momMedicineClash,
  moveFromMaple,
  patchCareSettings,
  planDoses,
  readableEntry,
  readablePlan,
  restoreCareEntry,
  reviewCarePlan,
  saveCarePlan,
  stopCarePlan,
  undoMoveFromMaple,
  updateCareEntry,
  updateMood,
  viewerFor,
  type CareSession,
} from "../../src/lib/maple/care-store";
import { NotFound } from "../../src/lib/maple/store";
import type { Baby, Member, Role } from "../../src/lib/maple/types";
import { done, eq, freshDb, ok, seedFamilies, sql, test, type FamilySeed, type Shape } from "./harness";

/**
 * Her page (care-store.ts and /api/maple/care/*) scoped by family, with the
 * two made-up families. On the final shape both families have a page under
 * the same name, so a statement that matched on the name alone, or on an id
 * or client_id alone, reaches the other family and fails here. On the
 * production shape family 1 reads and writes exactly as it always has.
 */

delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
process.env.GOOGLE_CLIENT_SECRET = "made-up-session-secret-for-tenancy-checks";

const SAME_NAME = "Dana";
const AT = () => new Date(Date.now() - 60 * 60_000).toISOString();
const CARE_TABLES = ["maple_care_people", "maple_care_meds", "maple_care_entries", "maple_care_mood", "maple_entries"] as const;

async function membersOf(familyId: number): Promise<Member[]> {
  const rows = await sql(`SELECT email, role, display_name FROM maple_members WHERE family_id = $1 ORDER BY added_at, email`, [familyId]);
  return rows.map((r) => ({ email: String(r.email), role: r.role as Role, display_name: r.display_name == null ? null : String(r.display_name), emoji: null, color: null }));
}

async function babyOf(familyId: number): Promise<Baby> {
  const [r] = await sql(`SELECT id, name, timezone, settings FROM maple_babies WHERE family_id = $1 ORDER BY id LIMIT 1`, [familyId]);
  return {
    id: Number(r.id),
    name: String(r.name),
    nickname: null,
    sex: null,
    due_date: null,
    born_at: null,
    birth_weight_g: null,
    birth_length_cm: null,
    birth_head_cm: null,
    timezone: String(r.timezone),
    settings: (r.settings ?? {}) as Record<string, unknown>,
  };
}

async function sessionOf(f: FamilySeed, email = f.owner): Promise<CareSession> {
  const [members, baby] = await Promise.all([membersOf(f.familyId), babyOf(f.familyId)]);
  const me = members.find((m) => m.email === email);
  if (!me) throw new Error(`no member ${email}`);
  return careSession(viewerFor(me, baby, members), { familyId: f.familyId, members, baby });
}

/** Every care row of one family (and its Maple log), hashed: what another family's attempts must never move. */
async function fingerprint(familyId: number): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const t of CARE_TABLES) {
    const [r] = await sql(`SELECT COUNT(*)::int AS n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x WHERE family_id = $1`, [familyId]);
    out[t] = r;
  }
  return out;
}

async function familyOfRow(table: string, id: number): Promise<string | null> {
  const [r] = await sql(`SELECT family_id FROM ${table} WHERE id = $1`, [id]);
  return r ? String(r.family_id) : null;
}

async function notFound(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof NotFound) return;
    throw new Error(`${label}: threw ${(error as Error)?.constructor?.name} ${(error as Error)?.message}`);
  }
  throw new Error(`${label}: succeeded on another family's row`);
}

async function mapleMed(familyId: number, babyId: number, name: string): Promise<number> {
  const [r] = await sql(
    `INSERT INTO maple_entries (family_id, baby_id, kind, started_at, data, created_by) VALUES ($1, $2, 'med', $3, $4, 'self') RETURNING id`,
    [familyId, babyId, AT(), { name, dose: "1 made-up tablet" }]
  );
  return Number(r.id);
}

/** One family's care rows, each made through the store (so every write path files its row too). */
type CareRows = {
  medId: number;
  doseId: number;
  tempId: number;
  questionId: number;
  deletedId: number;
  moodId: number;
  mapleMedId: number;
  movedEntryId: number;
  movedDoseId: number;
  planName: string;
};

/** Client ids both families send, Alpha first: a lookup by client_id alone would answer Beta with Alpha's row. */
const SHARED = { temp: "shared-client-temp-0001", question: "shared-client-question-0001", mood: "shared-client-mood-0001", plan: "shared-client-plan-0001", dose: "shared-client-dose-0001" };

async function careRows(f: FamilySeed, s: CareSession, planName: string): Promise<CareRows> {
  const plan = (await saveCarePlan(s, { name: planName, schedule: { type: "as_needed", min_gap_min: null }, client_id: SHARED.plan }, { source: "web" })).plan;
  const dose = await logCareDose(s, { planId: plan.id, at: AT(), clientId: SHARED.dose, source: "web" });
  const temp = await logCareTemp(s, { tempC: 37.1, at: AT(), clientId: SHARED.temp, source: "web" });
  const question = await addCareQuestion(s, { text: `A made-up question from ${f.name}`, clientId: SHARED.question, source: "web" });
  const gone = await logCareDose(s, { name: "Made-up one-off", at: AT(), source: "web" });
  await deleteCareEntry(s, gone.entry!.id);
  const mood = await createMood(s, { kind: "checkin", data: { level: 3 }, client_id: SHARED.mood });
  const mapleMedId = await mapleMed(f.familyId, f.babyId, "Made-up drops");
  const movedEntryId = await mapleMed(f.familyId, f.babyId, "Made-up moved med");
  const moved = await moveFromMaple(s, { entryId: movedEntryId });
  return {
    medId: plan.id,
    doseId: dose.entry!.id,
    tempId: temp.entry!.id,
    questionId: question.entry.id,
    deletedId: gone.entry!.id,
    moodId: mood.entry.id,
    mapleMedId,
    movedEntryId,
    movedDoseId: moved.entry.id,
    planName,
  };
}

type World = { alpha: FamilySeed; beta: FamilySeed; a: CareRows; b: CareRows; sa: CareSession; sb: CareSession };

/** The final shape, both families with a page for "Dana", Alpha's rows written first. */
async function world(): Promise<World> {
  await freshDb({ shape: "final" });
  const { alpha, beta } = await seedFamilies();
  await createCarePerson(beta, SAME_NAME, beta.owner, await membersOf(beta.familyId));
  const sa = await sessionOf(alpha);
  const a = await careRows(alpha, sa, "Made-up Alpha Med");
  const sb = await sessionOf(beta);
  const b = await careRows(beta, sb, "Made-up Beta Med");
  return { alpha, beta, a, b, sa: await sessionOf(alpha), sb: await sessionOf(beta) };
}

// ── family 1 on the production shape ──────────────────────────────────

async function production() {
  await test("every care write tells the notifications its own family (a hook without one means family 1)", () => {
    // Read as text: the hook runs after the response, outside anything a check can watch without sending a push.
    const src = readFileSync(join(__dirname, "..", "..", "src", "lib", "maple", "care-store.ts"), "utf8");
    const calls = src.match(/careChanged\([^)]*\)/g) ?? [];
    ok(calls.length >= 10, `found ${calls.length} calls`);
    eq(calls.filter((c) => !c.includes("familyId: s.familyId")), []);
  });

  await test("production: family 1's page is made on first read, as it always is, and filed under family 1", async () => {
    await freshDb();
    const first = await getCarePerson({ familyId: 1 });
    eq(first?.member, DEFAULT_CARE_PERSON);
    eq((await getCarePerson({ familyId: 1 }))?.created_at, first?.created_at, "the second read finds the same page");
    eq(await sql(`SELECT member, family_id FROM maple_care_people`), [{ member: DEFAULT_CARE_PERSON, family_id: "1" }]);
  });

  await test("production: family 2 has no page of its own and never reads family 1's", async () => {
    await freshDb();
    const { alpha, beta } = await seedFamilies();
    eq(await getCarePerson(beta), null);
    const sb = await sessionOf(beta);
    eq([sb.person, sb.access.read, sb.name], [null, false, "mom"]);
    eq((await sessionOf(alpha)).person?.member, SAME_NAME);
    eq(await sql(`SELECT COUNT(*)::int AS n FROM maple_care_people`), [{ n: 1 }], "no page was made for family 2");
  });

  await test("production: every care write and read works for family 1 and files its rows there", async () => {
    await freshDb();
    const { alpha } = await seedFamilies();
    const sa = await sessionOf(alpha);
    const a = await careRows(alpha, sa, "Made-up Alpha Med");
    for (const [table, id] of [
      ["maple_care_meds", a.medId],
      ["maple_care_entries", a.doseId],
      ["maple_care_entries", a.tempId],
      ["maple_care_entries", a.questionId],
      ["maple_care_entries", a.movedDoseId],
      ["maple_care_mood", a.moodId],
    ] as const) {
      eq(await familyOfRow(table, id), "1", `${table} ${id}`);
    }
    const replay = await logCareTemp(sa, { tempC: 37.1, at: AT(), clientId: SHARED.temp, source: "web" });
    eq([replay.deduped, replay.entry?.id], [true, a.tempId], "a replayed temperature");
    const mood = await createMood(sa, { kind: "checkin", data: { level: 3 }, client_id: SHARED.mood });
    eq([mood.deduped, mood.entry.id], [true, a.moodId], "a replayed check-in, with the old client_id key still beside the new one");
    const plan = await saveCarePlan(sa, { name: "Made-up Alpha Med", schedule: { type: "as_needed", min_gap_min: null }, client_id: SHARED.plan }, { source: "web" });
    eq([plan.deduped, plan.plan.id], [true, a.medId], "a replayed plan");
    await stopCarePlan(sa, a.medId, true);
    await reviewCarePlan(sa, a.medId);
    await deleteCarePlan(sa, a.medId);
    await deleteCarePlan(sa, a.medId, true);
    await updateCareEntry(sa, a.tempId, { data: { temp_c: 37.3 } });
    await restoreCareEntry(sa, a.deletedId);
    await updateMood(sa, a.moodId, { note: "Made-up note" });
    await undoMoveFromMaple(sa, { entryId: a.movedEntryId, doseId: a.movedDoseId });
    await patchCareSettings(sa, { settings: { next_visit: "2026-11-02" } });
    const state = await careStateFor(await sessionOf(alpha));
    ok(state?.plans.some((p) => p.id === a.medId), "the plan is in the state");
    ok(state?.entries.some((e) => e.id === a.deletedId), "the restored dose is in the state");
    eq(state?.settings.next_visit, "2026-11-02");
    ok(await careRev(sa), "a rev");
    eq((await sql(`SELECT deleted_at FROM maple_entries WHERE id = $1`, [a.movedEntryId]))[0].deleted_at, null, "the move's undo put Maple's entry back");
    eq(await sql(`SELECT COUNT(*)::int AS n FROM maple_care_entries WHERE family_id IS DISTINCT FROM 1`), [{ n: 0 }]);
  });

  await test("production: rows that older code writes without a family_id (DEFAULT 1) show on family 1's page", async () => {
    await freshDb();
    const { alpha } = await seedFamilies();
    await sql(`INSERT INTO maple_care_entries (id, person, kind, at, data, note) VALUES (30000001, $1, 'question', NOW(), '{}', 'Made-up older question')`, [SAME_NAME]);
    ok((await listCareEntries(await sessionOf(alpha), {})).some((e) => e.id === 30000001), "family 1 sees it");
  });

  await test("production: a call without a family fails closed and writes nothing", async () => {
    await freshDb();
    const { alpha } = await seedFamilies();
    const members = await membersOf(1);
    const baby = await babyOf(1);
    const viewer = viewerFor(members[0], baby, members);
    for (const [label, run] of [
      ["careSession", () => careSession(viewer, { familyId: undefined as unknown as number, members, baby })],
      ["getCarePerson", () => getCarePerson({} as { familyId: number })],
      ["listCarePlans", () => listCarePlans({ familyId: 0 }, SAME_NAME)],
      ["planDoses", () => planDoses({ familyId: Number.NaN }, alpha.care!.medId)],
    ] as const) {
      let code: unknown = null;
      try {
        await run();
      } catch (error) {
        code = (error as { code?: unknown }).code;
      }
      eq(code, "family_required", label);
    }
    eq(await sql(`SELECT COUNT(*)::int AS n FROM maple_care_people`), [{ n: 1 }]);
  });
}

// ── isolation on the final shape ──────────────────────────────────────

async function isolation() {
  const { alpha, beta, a, b, sa, sb } = await world();

  await test("final: each family's session opens its own page, though both are named Dana", async () => {
    eq([sa.person?.member, sb.person?.member], [SAME_NAME, SAME_NAME]);
    eq([sa.person?.created_by, sb.person?.created_by], [alpha.owner, beta.owner]);
    eq((await getCarePerson(beta))?.created_by, beta.owner);
  });

  await test("final: every row Beta writes is filed under Beta", async () => {
    for (const [table, id] of [
      ["maple_care_meds", b.medId],
      ["maple_care_entries", b.doseId],
      ["maple_care_entries", b.tempId],
      ["maple_care_entries", b.questionId],
      ["maple_care_entries", b.deletedId],
      ["maple_care_entries", b.movedDoseId],
      ["maple_care_mood", b.moodId],
    ] as const) {
      eq(await familyOfRow(table, id), "2", `${table} ${id}`);
    }
  });

  await test("final: Beta's lists hold only Beta's plans, entries and check-ins", async () => {
    const alphaIds = new Set([a.medId, a.doseId, a.tempId, a.questionId, a.deletedId, a.moodId, a.movedDoseId, alpha.care!.medId, alpha.care!.doseId]);
    const plans = (await listCarePlans(sb, SAME_NAME)).map((p) => p.id);
    eq(plans, [b.medId]);
    eq((await carePlanViews(sb, { finished: true })).map((v) => v.plan.id), [b.medId]);
    const entries = (await listCareEntries(sb, {})).map((e) => e.id);
    ok(entries.length > 0 && entries.every((id) => !alphaIds.has(id)), `Beta's entries ${JSON.stringify(entries)}`);
    eq((await listMood(sb)).map((m) => m.id), [b.moodId]);
    eq((await planDoses(beta, a.medId)).length, 0, "Alpha's plan's doses, asked for by Beta");
    eq((await planDoses(alpha, a.medId)).map((d) => d.id), [a.doseId]);
  });

  await test("final: Beta's state and rev carry nothing of Alpha's, and Alpha's writes never move Beta's rev", async () => {
    const state = await careStateFor(sb);
    eq(state?.plans.map((p) => p.id), [b.medId]);
    ok(state?.entries.every((e) => e.id !== a.doseId && e.id !== a.tempId && e.id !== a.questionId), "no Alpha entry");
    eq(state?.mood?.map((m) => m.id), [b.moodId]);
    const rev = await careRev(sb);
    await logCareTemp(sa, { tempC: 37.4, at: AT(), source: "web" });
    await saveCarePlan(sa, { name: "Made-up Alpha Second", schedule: { type: "as_needed", min_gap_min: null } }, { source: "web" });
    await createMood(sa, { kind: "checkin", data: { level: 4 } });
    eq(await careRev(sb), rev);
  });

  await test("final: a client_id both families sent replays to the sender's own row, never the other family's", async () => {
    eq((await logCareTemp(sb, { tempC: 37.1, at: AT(), clientId: SHARED.temp, source: "web" })).entry?.id, b.tempId, "temperature");
    eq((await addCareQuestion(sb, { text: "Again", clientId: SHARED.question, source: "web" })).entry.id, b.questionId, "question");
    eq((await logCareDose(sb, { planId: b.medId, at: AT(), clientId: SHARED.dose, source: "web" })).entry?.id, b.doseId, "dose");
    const plan = await saveCarePlan(sb, { name: b.planName, schedule: { type: "as_needed", min_gap_min: null }, client_id: SHARED.plan }, { source: "web" });
    eq([plan.deduped, plan.plan.id], [true, b.medId], "plan");
    const mood = await createMood(sb, { kind: "checkin", data: { level: 3 }, client_id: SHARED.mood });
    eq([mood.deduped, mood.entry.id], [true, b.moodId], "check-in");
    const fresh = await createCareEntry(sb, { kind: "dose", data: { name: "Made-up one-off" }, client_id: "seed-alpha-dose" }, "web");
    eq([fresh.created, await familyOfRow("maple_care_entries", fresh.entry!.id)], [true, "2"], "Alpha's seeded dose's client_id, sent by Beta");
  });

  await test("final: Alpha's dose of the same one-off at the same time never reads as Beta's duplicate", async () => {
    const at = AT();
    eq((await logCareDose(sa, { name: "Made-up Shared One-off", at, source: "web" })).created, true);
    const mine = await logCareDose(sb, { name: "Made-up Shared One-off", at, source: "web" });
    eq([mine.created, mine.possible_duplicate ?? null], [true, null]);
  });

  await test("final: Beta's newest temperature and fuller check-in stay in its state, however old, whatever Alpha logs later", async () => {
    const screen = await createMood(sb, { kind: "screen", data: { phq9: [0, 0, 0, 0, 0, 0, 0, 0, 0] } });
    await sql(`UPDATE maple_care_entries SET at = NOW() - INTERVAL '20 days' WHERE family_id = 2 AND kind = 'temp'`);
    await sql(`UPDATE maple_care_mood SET at = NOW() - INTERVAL '30 days' WHERE id = $1`, [screen.entry.id]);
    await logCareTemp(sa, { tempC: 37.5, at: AT(), source: "web" });
    await createMood(sa, { kind: "screen", data: { phq9: [0, 0, 0, 0, 0, 0, 0, 0, 0] } });
    const state = await careStateFor(await sessionOf(beta));
    ok(state?.entries.some((e) => e.id === b.tempId), "Beta's newest temperature");
    ok(state?.mood?.some((m) => m.id === screen.entry.id), "Beta's newest fuller check-in");
  });

  const gonePlan = (await saveCarePlan(sa, { name: "Made-up Alpha Gone", schedule: { type: "as_needed", min_gap_min: null } }, { source: "web" })).plan.id;
  await deleteCarePlan(sa, gonePlan);
  const before = await fingerprint(alpha.familyId);

  await test("final: Beta can't read Alpha's plans or entries by id", async () => {
    await notFound("readablePlan", () => readablePlan(sb, a.medId));
    await notFound("readablePlan deleted", () => readablePlan(sb, gonePlan, { includeDeleted: true }));
    await notFound("readableEntry", () => readableEntry(sb, a.doseId));
    await notFound("readableEntry deleted", () => readableEntry(sb, a.deletedId, { includeDeleted: true }));
    eq(await careDiscardedBy(sb, a.deletedId), undefined, "who removed Alpha's dose");
    eq(await careDiscardedBy(sa, a.deletedId), alpha.owner, "Alpha's own answer");
  });

  await test("final: Beta can't change, stop, review, delete or restore Alpha's plan", async () => {
    await notFound("edit", () => saveCarePlan(sb, { id: a.medId, name: "Renamed", schedule: { type: "as_needed", min_gap_min: null } }, { source: "web" }));
    await notFound("stop", () => stopCarePlan(sb, a.medId, true));
    await notFound("review", () => reviewCarePlan(sb, a.medId));
    await notFound("delete", () => deleteCarePlan(sb, a.medId));
    await notFound("restore", () => deleteCarePlan(sb, gonePlan, true));
  });

  await test("final: Beta can't log against, edit, delete or restore Alpha's entries", async () => {
    await notFound("dose on Alpha's plan", () => logCareDose(sb, { planId: a.medId, at: AT(), source: "web" }));
    await notFound("edit", () => updateCareEntry(sb, a.tempId, { data: { temp_c: 39 } }));
    await notFound("delete", () => deleteCareEntry(sb, a.tempId));
    await notFound("restore", () => restoreCareEntry(sb, a.deletedId));
  });

  await test("final: Beta can't edit or delete Alpha's check-ins", async () => {
    await notFound("edit", () => updateMood(sb, a.moodId, { note: "Changed" }));
    await notFound("delete", () => deleteMood(sb, a.moodId));
  });

  await test("final: Beta can't move Alpha's Maple medicine entry, or undo Alpha's move", async () => {
    await notFound("move", () => moveFromMaple(sb, { entryId: a.mapleMedId }));
    await notFound("move onto Beta's plan", () => moveFromMaple(sb, { entryId: a.mapleMedId, planId: b.medId }));
    await notFound("undo", () => undoMoveFromMaple(sb, { entryId: a.movedEntryId, doseId: a.movedDoseId }));
    eq((await sql(`SELECT deleted_at FROM maple_entries WHERE id = $1`, [a.mapleMedId]))[0].deleted_at, null, "Alpha's entry is still in Maple's log");
  });

  await test("final: a Beta dose that names Alpha's moved entry (bad data) still can't bring that entry back", async () => {
    await sql(`UPDATE maple_care_entries SET data = data || jsonb_build_object('moved_from', $1::bigint) WHERE id = $2`, [a.movedEntryId, b.movedDoseId]);
    await notFound("undo", () => undoMoveFromMaple(sb, { entryId: a.movedEntryId, doseId: b.movedDoseId }));
    ok((await sql(`SELECT deleted_at FROM maple_entries WHERE id = $1`, [a.movedEntryId]))[0].deleted_at != null, "Alpha's moved entry stays moved");
  });

  await test("final: the medicine clash guard reads only the caller's family's list", async () => {
    const members = await membersOf(beta.familyId);
    const viewer = viewerFor(members.find((m) => m.email === beta.owner)!, await babyOf(beta.familyId), members);
    eq(await momMedicineClash(viewer, "Ibuprofen", { familyId: beta.familyId, members, baby: await babyOf(beta.familyId) }), null, "Alpha's Ibuprofen, asked by Beta");
    const am = await membersOf(alpha.familyId);
    const av = viewerFor(am.find((m) => m.email === alpha.owner)!, await babyOf(alpha.familyId), am);
    eq((await momMedicineClash(av, "Ibuprofen", { familyId: alpha.familyId, members: am, baby: await babyOf(alpha.familyId) }))?.plan.id, alpha.care!.medId);
  });

  await test("final: Beta's settings change only Beta's page", async () => {
    await patchCareSettings(sb, { settings: { next_visit: "2026-12-01", feeding: "no" } });
    const [aRow, bRow] = await sql(`SELECT family_id, settings FROM maple_care_people ORDER BY family_id`);
    eq([aRow.family_id, (aRow.settings as Record<string, unknown>).next_visit ?? null], ["1", null]);
    eq([bRow.family_id, (bRow.settings as Record<string, unknown>).next_visit], ["2", "2026-12-01"]);
  });

  await test("final: Alpha's page is exactly as it was after everything Beta tried", async () => {
    eq(await fingerprint(alpha.familyId), before);
  });

  await test("final: a second page for a family is refused; deleting Beta's page leaves Alpha's whole", async () => {
    let reason: unknown = null;
    await createCarePerson(beta, "Someone Else", beta.owner, []).catch((error) => (reason = (error as { reason?: unknown }).reason));
    eq(reason, "exists");
    await deleteCarePerson(sb, SAME_NAME);
    eq(await getCarePerson(beta), null, "Beta's page is gone, and not made again");
    eq(await sql(`SELECT COUNT(*)::int AS n FROM maple_care_entries WHERE family_id = 2`), [{ n: 0 }], "its rows went with it");
    eq(await fingerprint(alpha.familyId), before);
  });
}

// ── the routes, through withCare and a real session cookie ────────────

type Route = (request: NextRequest) => Promise<Response>;

async function routes() {
  const { NextRequest: Req } = await import("next/server");
  const entries = await import("../../src/app/api/maple/care/entries/route");
  const restore = await import("../../src/app/api/maple/care/entries/restore/route");
  const meds = await import("../../src/app/api/maple/care/meds/route");
  const mood = await import("../../src/app/api/maple/care/mood/route");
  const move = await import("../../src/app/api/maple/care/move/route");
  const person = await import("../../src/app/api/maple/care/person/route");
  const { alpha, beta, a, b } = await world();

  // The session cookie's body as sealed (auth.ts): `fam` names the family, none means family 1.
  const cookie = (id: string, fam?: number) => encryptSecret(JSON.stringify({ id, ...(fam === undefined ? {} : { fam }), iat: Date.now() }));
  const asBeta = cookie(beta.owner, beta.familyId);
  const call = async (route: Route, path: string, session: string, method = "GET", body?: unknown) => {
    const request = new Req(new URL(`/api/maple/care/${path}`, "http://localhost:3000"), {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    request.cookies.set("maple_session", session);
    const res = await route(request);
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  };
  const ids = (body: Record<string, unknown> | null, key = "entries") => ((body?.[key] as { id: number }[] | undefined) ?? []).map((e) => e.id);
  const before = await fingerprint(alpha.familyId);

  await test("routes: a family-1 cookie from before families (no fam) still opens family 1's page", async () => {
    const res = await call(entries.GET, "entries", cookie(alpha.owner));
    eq(res.status, 200);
    ok(ids(res.body).includes(a.tempId), "Alpha's temperature is listed");
  });

  await test("routes: Beta's cookie lists only Beta's entries and check-ins", async () => {
    const got = ids((await call(entries.GET, "entries", asBeta)).body);
    ok(got.includes(b.tempId) && ![a.tempId, a.doseId, a.questionId].some((id) => got.includes(id)), `Beta's list ${JSON.stringify(got)}`);
    eq(ids((await call(mood.GET, "mood", asBeta)).body), [b.moodId]);
  });

  await test("routes: Beta's member claiming family 1 opens nothing", async () => {
    eq((await call(entries.GET, "entries", cookie(beta.owner, alpha.familyId))).status, 401);
  });

  await test("routes: every by-id route on Alpha's rows answers Beta 404, with nothing about who did what", async () => {
    const tries: [string, Route, string, string, unknown?][] = [
      ["edit entry", entries.PATCH, `entries?id=${a.tempId}`, "PATCH", { data: { temp_c: 39 } }],
      ["edit deleted entry", entries.PATCH, `entries?id=${a.deletedId}`, "PATCH", { note: "x" }],
      ["delete entry", entries.DELETE, `entries?id=${a.tempId}`, "DELETE"],
      ["restore entry", restore.POST, `entries/restore?id=${a.deletedId}`, "POST"],
      ["edit plan", meds.PATCH, `meds?id=${a.medId}`, "PATCH", { name: "Renamed" }],
      ["stop plan", meds.PATCH, `meds?id=${a.medId}`, "PATCH", { stopped: true }],
      ["review plan", meds.PATCH, `meds?id=${a.medId}`, "PATCH", { reviewed: true }],
      ["restore plan", meds.PATCH, `meds?id=${a.medId}`, "PATCH", { deleted: false }],
      ["delete plan", meds.DELETE, `meds?id=${a.medId}`, "DELETE"],
      ["edit check-in", mood.PATCH, `mood?id=${a.moodId}`, "PATCH", { note: "x" }],
      ["delete check-in", mood.DELETE, `mood?id=${a.moodId}`, "DELETE"],
      ["move", move.POST, "move", "POST", { entry_id: a.mapleMedId }],
      ["undo move", move.POST, "move", "POST", { undo: { entry_id: a.movedEntryId, dose_id: a.movedDoseId } }],
      ["dose on Alpha's plan", entries.POST, "entries", "POST", { kind: "dose", med_id: a.medId, at: AT(), data: {} }],
    ];
    for (const [label, route, path, method, body] of tries) {
      const res = await call(route, path, asBeta, method, body);
      eq([res.status, res.body?.deleted_by ?? null, res.body?.reason ?? null], [404, null, null], label);
    }
  });

  await test("routes: Beta's writes land in Beta, and its replays answer with its own rows", async () => {
    const temp = await call(entries.POST, "entries", asBeta, "POST", { kind: "temp", at: AT(), data: { temp_c: 37.2 } });
    eq([temp.status, await familyOfRow("maple_care_entries", (temp.body?.entry as { id: number }).id)], [201, "2"]);
    const again = await call(entries.POST, "entries", asBeta, "POST", { kind: "temp", at: AT(), data: { temp_c: 37.1 }, client_id: SHARED.temp });
    eq([again.status, (again.body?.entry as { id: number }).id], [200, b.tempId]);
    const plan = await call(meds.POST, "meds", asBeta, "POST", { name: "Made-up Beta Route Med", schedule: { type: "as_needed" } });
    eq([plan.status, await familyOfRow("maple_care_meds", (plan.body?.plan as { id: number }).id)], [201, "2"]);
    const checkin = await call(mood.POST, "mood", asBeta, "POST", { kind: "checkin", data: { level: 2 }, client_id: SHARED.mood });
    eq([checkin.status, (checkin.body?.entry as { id: number }).id], [200, b.moodId]);
  });

  await test("routes: Beta's settings and its delete touch only Beta's page", async () => {
    eq((await call(person.PATCH, "person", asBeta, "PATCH", { settings: { next_visit: "2026-12-03" } })).status, 200);
    eq((await call(person.DELETE, "person", asBeta, "DELETE", { confirm: true })).status, 200);
    eq((await call(entries.GET, "entries", asBeta)).status, 404, "Beta's page is gone and isn't made again");
    eq((await call(entries.GET, "entries", cookie(alpha.owner, alpha.familyId))).status, 200);
  });

  await test("routes: Alpha's page is exactly as it was", async () => {
    eq(await fingerprint(alpha.familyId), before);
  });
}

/** A section that throws part-way (its set-up included) counts as a failure, and the next section still runs. */
async function section(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    await test(`${name} ran to the end`, () => {
      throw error;
    });
  }
}

section("production", production)
  .then(() => section("final", isolation))
  .then(() => section("routes", routes))
  .then(() => done("care.check.ts"));
