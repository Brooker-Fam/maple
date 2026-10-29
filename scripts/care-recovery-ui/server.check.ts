import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { encryptSecret } from "../../src/lib/secret-box";
import * as entries from "../../src/app/api/maple/care/entries/route";
import * as restore from "../../src/app/api/maple/care/entries/restore/route";
import { done, eq, freshDb, seedFamilies, sql, test } from "../tenancy/harness";

delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
process.env.GOOGLE_CLIENT_SECRET = "synthetic-care-recovery-secret";

async function main() {
  await freshDb({ shape: "final" });
  const { alpha } = await seedFamilies();
  const cookie = encryptSecret(JSON.stringify({ id: alpha.owner, fam: alpha.familyId, iat: Date.now() }));
  const call = async (method: "POST" | "PATCH" | "DELETE", body: unknown, id?: number) => {
    const request = new NextRequest(`http://localhost:3000/api/maple/care/entries${id ? `?id=${id}` : ""}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    request.cookies.set("maple_session", cookie);
    const response = await entries[method](request);
    return { status: response.status, body: await response.json() };
  };
  const create = async () => {
    const response = await call("POST", { kind: "question", at: new Date(Date.now() - 60_000).toISOString(), data: { done: true, answer: "Synthetic first answer" }, note: "Synthetic OB question" });
    eq(response.status, 201);
    return response.body.entry;
  };
  await test("question revisions reject stale answers and return the saved correction", async () => {
    const entry = await create();
    const updated = await call("PATCH", { data: { answer: "Synthetic other caregiver correction" }, expect_updated_at: entry.updated_at }, entry.id);
    eq(updated.status, 200);
    const refused = await call("PATCH", { data: { answer: "Synthetic stale answer" }, expect_updated_at: entry.updated_at }, entry.id);
    eq(refused.status, 409);
    eq(refused.body.entry.data.answer, "Synthetic other caregiver correction");
    eq((await sql("SELECT data FROM maple_care_entries WHERE id = $1", [entry.id]))[0].data, updated.body.entry.data);
  });
  await test("concurrent question corrections cannot both replace the same revision", async () => {
    const entry = await create();
    const results = await Promise.all(["Synthetic first correction", "Synthetic second correction"].map((answer) => call("PATCH", { data: { answer }, expect_updated_at: entry.updated_at }, entry.id)));
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  });
  await test("question revisions advance within the same transaction clock", async () => {
    const entry = await create();
    await sql("BEGIN");
    try {
      const [row] = await sql("UPDATE maple_care_entries SET updated_at = date_trunc('milliseconds', NOW()) WHERE id = $1 RETURNING updated_at", [entry.id]);
      const version = new Date(row.updated_at as string | Date).toISOString();
      const changed = await call("PATCH", { data: { answer: "Synthetic revised answer" }, expect_updated_at: version }, entry.id);
      eq(changed.status, 200);
      assert(Date.parse(changed.body.entry.updated_at) > Date.parse(version));
      eq((await call("PATCH", { data: { done: false }, expect_updated_at: version }, entry.id)).status, 409);
      eq((await call("DELETE", {}, entry.id)).status, 200);
      const undo = new NextRequest(`http://localhost:3000/api/maple/care/entries/restore?id=${entry.id}`, { method: "POST" });
      undo.cookies.set("maple_session", cookie);
      eq((await restore.POST(undo)).status, 200);
      eq((await call("PATCH", { data: { answer: "Synthetic pre-delete draft" }, expect_updated_at: changed.body.entry.updated_at }, entry.id)).status, 409);
    } finally { await sql("ROLLBACK"); }
  });
  done("care-recovery-ui/server.check.ts");
}

main().catch((error) => { console.error(error); process.exit(1); });
