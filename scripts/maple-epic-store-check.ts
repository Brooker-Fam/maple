/** Real migrations and SQL, isolated synthetic Postgres databases only. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cleanupExpired, clearAttempt, discardPending, EpicStoreError, getPending, importMeasurements, putPending, removeImports, replacePending, saveAttempt, stats, takeAttempt, type Pending } from "../src/lib/maple/epic/store";
import type { FamilyCtx } from "../src/lib/maple/family";
import type { GrowthMeasurement } from "../src/lib/maple/epic/fhir";
import { updateEntry } from "../src/lib/maple/store";
import { done, freshDb, seedFamilies, sql, test, type FamilySeed, type Shape } from "./tenancy/harness";

delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const end = () => new Date(Date.now() + 10 * 60_000).toISOString();
const context = (f: FamilySeed): FamilyCtx => ({ familyId: f.familyId, babyId: f.babyId, tz: f.tz, member: f.owner, role: "owner", status: "active" });
const measurement = (id = "weight-1"): GrowthMeasurement => ({ id, measuredAt: "2026-10-20T12:00:00.000Z", originalDate: "2026-10-20T08:00:00-04:00", label: "Weight", originalValue: 3.5, originalUnit: "kg", data: { weight_g: 3500, at: "doctor" } });
const rejected = (reason: EpicStoreError["reason"]) => (error: unknown) => error instanceof EpicStoreError && error.reason === reason;

async function attempt(ctx: FamilyCtx) {
  const stateHash = hash(randomUUID());
  const browserHash = hash(randomUUID());
  await saveAttempt(ctx, { stateHash, browserHash, sealed: "encrypted-attempt", expiresAt: end() });
  return { stateHash, browserHash };
}

async function pending(ctx: FamilyCtx, providerId = "albany-med") {
  const a = await attempt(ctx);
  assert.equal(await takeAttempt(ctx, a.stateHash, a.browserHash), "encrypted-attempt");
  const p: Pending = { id: randomUUID(), babyId: ctx.babyId!, providerId, sealed: `encrypted-review-${randomUUID()}`, expiresAt: end() };
  await putPending(ctx, { ...p, attemptHash: a.stateHash });
  return p;
}

const save = (ctx: FamilyCtx, p: Pending, measurements = [measurement()]) => importMeasurements(ctx, { pending: p, patientId: "synthetic-child", expectedBirthDate: ctx.familyId === 1 ? "2026-10-10" : "2026-10-14", providerName: "Albany Med Health System", measurements });

async function run(shape: Shape) {
  await freshDb({ shape, migrations: 2 });
  const { alpha, beta } = await seedFamilies();
  const a = context(alpha), b = context(beta);

  await test(`${shape}: OAuth browser binding and atomic single-use attempt`, async () => {
    const issued = await attempt(a);
    assert.equal(await takeAttempt(a, issued.stateHash, hash("another-browser")), null);
    assert.equal(await takeAttempt(b, issued.stateHash, issued.browserHash), null);
    const takes = await Promise.all([takeAttempt(a, issued.stateHash, issued.browserHash), takeAttempt(a, issued.stateHash, issued.browserHash)]);
    assert.equal(takes.filter(Boolean).length, 1);
    assert.equal(await takeAttempt(a, issued.stateHash, issued.browserHash), null);
    await discardPending(a);
    await assert.rejects(putPending(a, { id: randomUUID(), babyId: a.babyId!, providerId: "albany-med", sealed: "late-callback", expiresAt: end(), attemptHash: issued.stateHash }), rejected("expired"));
    const newer = await attempt(a);
    await clearAttempt(a, issued.stateHash);
    assert.equal(await takeAttempt(a, newer.stateHash, newer.browserHash), "encrypted-attempt", "late cleanup preserves a newer attempt");
    await clearAttempt(a, newer.stateHash);
  });

  await test(`${shape}: expiration prevents reads/reviews and cleanup removes ciphertext`, async () => {
    const p = await pending(a);
    await sql(`UPDATE maple_epic_pending SET expires_at = NOW() - INTERVAL '1 second' WHERE family_id = $1`, [a.familyId]);
    assert.equal(await getPending(a), null);
    assert.equal(await replacePending(a, p.id, p.sealed, "late-review"), false);
    await assert.rejects(save(a, p), rejected("expired"));
    const issued = await attempt(b);
    await sql(`UPDATE maple_epic_attempts SET expires_at = NOW() - INTERVAL '1 second' WHERE family_id = $1`, [b.familyId]);
    assert.equal(await takeAttempt(b, issued.stateHash, issued.browserHash), null);
    await cleanupExpired();
    assert.equal((await sql(`SELECT * FROM maple_epic_pending`)).length, 0);
    assert.equal((await sql(`SELECT * FROM maple_epic_attempts`)).length, 0);
  });

  await test(`${shape}: pending reviews are owner/family scoped and replacement uses compare-and-swap`, async () => {
    const p = await pending(a);
    assert.equal((await getPending(a))?.id, p.id);
    assert.equal(await getPending(b), null);
    const member = { ...a, member: alpha.member, role: "member" as const };
    await assert.rejects(getPending(member), rejected("forbidden"));
    // A caller passing an old owner role cannot bypass the database membership check.
    assert.equal(await getPending({ ...member, role: "owner" }), null);
    await assert.rejects(saveAttempt({ ...member, role: "owner" }, { stateHash: hash("x"), browserHash: hash("y"), sealed: "invalid-owner", expiresAt: end() }), rejected("forbidden"));
    assert.equal(await replacePending(b, p.id, p.sealed, "foreign"), false);
    assert.equal(await replacePending(a, p.id, "not-current", "wrong"), false);
    assert.equal(await replacePending(a, p.id, p.sealed, "updated-ciphertext"), true);
    assert.equal(await replacePending(a, p.id, p.sealed, "stale-ciphertext"), false);
    await discardPending(a);
    assert.equal(await replacePending(a, p.id, "updated-ciphertext", "resurrect"), false);
  });

  await test(`${shape}: confirmed import is atomic, source-labelled, deduplicated, and separate across families`, async () => {
    const p = await pending(a);
    const outcomes = await Promise.allSettled([save(a, p), save(a, p)]);
    assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(await getPending(a), null);
    assert.equal((await stats(a)).importedCount, 1);
    const [row] = await sql(`SELECT e.* FROM maple_entries e JOIN maple_epic_imports i ON i.entry_id = e.id WHERE i.family_id = $1`, [a.familyId]);
    assert.equal(row.kind, "growth");
    assert.equal(row.source, "epic");
    assert.deepEqual(row.data, { weight_g: 3500, at: "doctor" });
    assert.equal(row.created_by, a.member);
    assert.match(String(row.note), /Albany Med Health System/);
    assert.match(String(row.note), /2026-10-20T08:00:00-04:00: 3.5 kg/);
    assert.ok(!JSON.stringify(row).includes("synthetic-child"), "no patient identifier in shared entry");
    assert.deepEqual(await save(a, await pending(a)), { imported: 0, duplicates: 1 });
    assert.deepEqual(await save(b, await pending(b)), { imported: 1, duplicates: 0 });
    assert.equal((await stats(b)).importedCount, 1);
    // Imported source values are immutable; a correction can be recorded as a separate home point.
    await assert.rejects(updateEntry(a, Number(row.id), { data: { weight_g: 3600 } }, a.member), /imported/i);
    await assert.rejects(updateEntry(a, Number(row.id), { note: "Changed original source" }, a.member), /imported/i);
    assert.deepEqual(await save(a, await pending(a)), { imported: 0, duplicates: 1 });
    assert.equal((await sql(`SELECT data FROM maple_entries WHERE id = $1`, [row.id]))[0].data.weight_g, 3500);
    const [home] = await sql(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, data, created_by, source)
      VALUES ($1, $2, 'growth', '2026-10-20T12:00:00Z', '{"weight_g":3500,"at":"home"}', $3, 'web') RETURNING id`,
    [a.familyId, a.babyId, a.member]);
    const updated = await updateEntry(a, Number(home.id), { data: { weight_g: 3600 } }, a.member);
    assert.ok(updated.kind === "growth");
    assert.equal(updated.data.weight_g, 3600);
    await sql(`UPDATE maple_entries SET deleted_at = NOW() WHERE id = $1`, [row.id]);
    assert.deepEqual(await save(a, await pending(a)), { imported: 0, duplicates: 1 });
    assert.equal((await stats(a)).importedCount, 1, "removed copies still expose the permanent removal control");
  });

  await test(`${shape}: sandbox and mismatched baby cannot save, and discarded or replaced reviews cannot resurrect`, async () => {
    const sandbox = await pending(a, "sandbox");
    await assert.rejects(save(a, sandbox), rejected("invalid"));
    const old = await pending(a);
    const newer = await pending(a);
    await assert.rejects(save(a, old, [measurement("weight-old")] ), rejected("expired"));
    await discardPending(a, old.id);
    assert.equal((await getPending(a))?.id, newer.id, "stale tab discard preserves the newer review");
    await assert.rejects(save({ ...a, babyId: b.babyId }, newer), rejected("invalid"));
    const originalBirth = (await sql(`SELECT born_at FROM maple_babies WHERE id = $1`, [a.babyId]))[0].born_at;
    await sql(`UPDATE maple_babies SET born_at = born_at + INTERVAL '1 day' WHERE id = $1`, [a.babyId]);
    await assert.rejects(save(a, newer), rejected("expired"), "changed DOB is checked again by the saving transaction");
    await sql(`UPDATE maple_babies SET born_at = $2 WHERE id = $1`, [a.babyId, originalBirth]);
    await discardPending(a);
    await assert.rejects(save(a, newer), rejected("expired"));
    const newAttempt = await attempt(a);
    await discardPending(a, newer.id);
    assert.equal(await takeAttempt(a, newAttempt.stateHash, newAttempt.browserHash), "encrypted-attempt", "stale tab discard preserves a new authorization attempt");
    await clearAttempt(a, newAttempt.stateHash);
  });

  await test(`${shape}: permanent removal clears only this owner's imported copies and pending authorization`, async () => {
    const before = (await sql(`SELECT id FROM maple_entries WHERE family_id = $1 AND client_id NOT LIKE 'epic:%'`, [a.familyId])).length;
    const p = await pending(a);
    assert.equal(await removeImports(a), 1, "includes the soft-deleted imported point");
    assert.equal(await getPending(a), null);
    await assert.rejects(save(a, p), rejected("expired"));
    assert.equal((await stats(b)).importedCount, 1, "another family unchanged");
    assert.equal((await sql(`SELECT id FROM maple_entries WHERE family_id = $1 AND client_id NOT LIKE 'epic:%'`, [a.familyId])).length, before);
    assert.equal((await sql(`SELECT * FROM maple_epic_imports WHERE family_id = $1`, [a.familyId])).length, 0);
    assert.deepEqual(await save(a, await pending(a)), { imported: 1, duplicates: 0 }, "explicit re-import after permanent deletion is possible");
  });

  await test(`${shape}: removal/import races cannot leave a pending token or imported copy behind`, async () => {
    const p = await pending(a);
    await Promise.allSettled([save(a, p, [measurement("race-weight")]), removeImports(a)]);
    assert.equal(await getPending(a), null);
    assert.equal((await stats(a)).importedCount, 0);
  });

  await test(`${shape}: membership removal cascades private authorization without erasing the shared log`, async () => {
    const anotherFamily = await pending(a);
    await pending(b);
    await sql(`DELETE FROM maple_members WHERE family_id = $1 AND email = $2`, [b.familyId, b.member]);
    assert.equal((await sql(`SELECT * FROM maple_epic_pending WHERE family_id = $1`, [b.familyId])).length, 0);
    assert.equal((await getPending(a))?.id, anotherFamily.id, "the deletion trigger does not touch another family's review");
    assert.equal((await sql(`SELECT * FROM maple_epic_imports WHERE family_id = $1`, [b.familyId])).length, 1);
    await assert.rejects(discardPending(b), rejected("forbidden"));
  });
}

async function main() {
  await run("production");
  await run("final");
  done("Epic store");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
