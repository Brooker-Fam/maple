import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { done, freshDb, seedFamilies, sql, test } from "./harness";
import { createEntry, getEntry, toClientEntry, updateEntry } from "../../src/lib/maple/store";
import { sealSession } from "../../src/lib/maple/auth";
import { GET } from "../../src/app/api/maple/photo/route";
import { FAMILY_UPLOAD_LIMITS } from "../../src/lib/maple/upload-quota";

process.env.GOOGLE_CLIENT_SECRET = "synthetic-moment-photo-check";
delete process.env.MAPLE_SESSION_SECRET;
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.MAPLE_BLOB_READ_WRITE_TOKEN;
delete process.env.BLOB_READ_WRITE_TOKEN;

const photo = (family: number, name: string) => ({ key: `https://synthetic.private.blob.vercel-storage.com/maple/f${family}/moments/${name}.jpg`, access: "private" as const, w: 20, h: 20 });

async function main() {
  await freshDb({ shape: "final" });
  const { alpha, beta } = await seedFamilies();
  await sql("DELETE FROM maple_entries WHERE kind = 'moment'");
  let count = 0;
  const moment = () => createEntry(beta.familyId, { babyId: beta.babyId, kind: "moment", startedAt: new Date(), data: { photos: [photo(2, `first-${++count}`), photo(2, `second-${count}`)] }, source: "web", createdBy: beta.member });

  await test("moment photos expose stable opaque references without storage keys", async () => {
    const entry = await moment();
    const client = toClientEntry(entry);
    const refs = client.kind === "moment" ? client.data.photos! : [];
    assert.equal(refs.length, 2);
    assert.ok(refs.every(ref => typeof (ref as { id?: string }).id === "string"));
    assert.notEqual((refs[0] as { id?: string }).id, (refs[1] as { id?: string }).id);
    assert.ok(!JSON.stringify(client).includes("vercel-storage"));
  });

  await test("an edit retains selected originals and adds a family photo in the requested order", async () => {
    const entry = await moment();
    const client = toClientEntry(entry);
    if (client.kind !== "moment" || entry.kind !== "moment") throw new Error("wrong fixture");
    const edited = await updateEntry(beta.familyId, entry.id, { data: { photos: [photo(2, "newly-uploaded"), client.data.photos![1]] } }, beta.member, { expectUpdatedAt: entry.updated_at });
    assert.equal(edited.kind, "moment");
    if (edited.kind !== "moment") return;
    assert.deepEqual(edited.data.photos!.map(ref => ref.key), [photo(2, "newly-uploaded").key, entry.data.photos![1].key]);
    const keptId = (client.data.photos![1] as { id?: string }).id;
    const output = toClientEntry(edited);
    assert.equal(output.kind === "moment" ? (output.data.photos![1] as { id?: string }).id : undefined, keptId);
  });

  await test("photo edits require an explicit revision", async () => {
    const entry = await moment();
    await assert.rejects(updateEntry(beta.familyId, entry.id, { data: { photos: [] } }, beta.member), /refresh|version|revision|changed/i);
  });

  await test("photo edits reject foreign uploads and unknown retained references", async () => {
    const entry = await moment();
    for (const photos of [[photo(alpha.familyId, "foreign")], [{ id: "unknown-existing-photo" }]]) {
      await assert.rejects(updateEntry(beta.familyId, entry.id, { data: { photos } }, beta.member, { expectUpdatedAt: entry.updated_at }), /photo/i);
    }
  });

  await test("photo edits reject duplicate refs and more than twelve photos", async () => {
    const entry = await moment();
    for (const photos of [[photo(2, "duplicate"), photo(2, "duplicate")], Array.from({ length: 13 }, (_, i) => photo(2, `too-many-${i}`))]) {
      await assert.rejects(updateEntry(beta.familyId, entry.id, { data: { photos } }, beta.member, { expectUpdatedAt: entry.updated_at }), /photo|12/i);
    }
  });

  await test("a removed stable photo reference cannot resolve to the next photo", async () => {
    const entry = await moment();
    const client = toClientEntry(entry);
    if (client.kind !== "moment") throw new Error("wrong fixture");
    const removedId = (client.data.photos![0] as { id?: string }).id ?? "missing-stable-id";
    await updateEntry(beta.familyId, entry.id, { data: { photos: [client.data.photos![1]] } }, beta.member, { expectUpdatedAt: entry.updated_at });
    const request = new NextRequest(`http://localhost:3000/api/maple/photo?entry=${entry.id}&photo=${removedId}&size=full`);
    request.cookies.set("maple_session", sealSession(beta.member, beta.familyId));
    const response = await GET(request);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "Photo not found");
  });

  await test("saving new moments cannot bypass the saved-photo quota", async () => {
    await sql("DELETE FROM maple_entries WHERE kind = 'moment'");
    await sql("INSERT INTO maple_entries (family_id,baby_id,kind,started_at,data,created_by) VALUES ($1,$2,'moment',NOW(),$3,$4)", [beta.familyId, beta.babyId, { photos: Array.from({ length: FAMILY_UPLOAD_LIMITS.photos - 1 }, (_, i) => photo(2, `quota-${i}`)) }, beta.member]);
    await assert.rejects(moment(), /many photos|room|limit/i);
  });

  await test("adding photos cannot bypass the saved-photo quota, while removal still works", async () => {
    await sql("DELETE FROM maple_entries WHERE kind = 'moment'");
    const entry = await moment();
    const client = toClientEntry(entry);
    if (client.kind !== "moment") throw new Error("wrong fixture");
    await sql("INSERT INTO maple_entries (family_id,baby_id,kind,started_at,data,created_by) VALUES ($1,$2,'moment',NOW(),$3,$4)", [beta.familyId, beta.babyId, { photos: Array.from({ length: FAMILY_UPLOAD_LIMITS.photos - 2 }, (_, i) => photo(2, `quota-${i}`)) }, beta.member]);
    await assert.rejects(updateEntry(beta.familyId, entry.id, { data: { photos: [...client.data.photos!, photo(2, "over-quota")] } }, beta.member, { expectUpdatedAt: entry.updated_at }), /many photos|room|limit/i);
    await updateEntry(beta.familyId, entry.id, { data: { photos: [] } }, beta.member, { expectUpdatedAt: entry.updated_at });
    const saved = await getEntry(beta.familyId, entry.id);
    assert.equal(saved?.kind === "moment" ? saved.data.photos?.length : -1, 0);
  });

  done("moment-photos.check.ts");
}
void main();
