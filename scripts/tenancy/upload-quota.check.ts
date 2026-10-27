import { claimUpload, FAMILY_UPLOAD_LIMITS } from "../../src/lib/maple/upload-quota";
import { done, eq, freshDb, seedFamilies, sql, test } from "./harness";

async function main() {
  await freshDb({ shape: "final" });
  await seedFamilies();
  await sql(`INSERT INTO maple_families (timezone, status, created_by) VALUES ('UTC', 'active', 'synthetic.third@example.com')`);
  await sql(`INSERT INTO maple_upload_counts (family_id, day, tokens) VALUES (1, CURRENT_DATE, 100000)`);

  await test("upload tokens share one daily limit across other families", async () => {
    await sql(`DELETE FROM maple_upload_counts WHERE family_id <> 1`);
    await sql(`INSERT INTO maple_upload_counts (family_id, day, tokens) VALUES (2, CURRENT_DATE, $1), (3, CURRENT_DATE, $2)`, [60, FAMILY_UPLOAD_LIMITS.tokensPerDay - 61]);
    eq(await claimUpload(2), true, "last shared token");
    eq(await claimUpload(3), false, "another family cannot exceed the shared day");
    eq(await claimUpload(1), true, "family 1 remains exempt");
  });

  await test("upload tokens share one lifetime limit across other families", async () => {
    await sql(`DELETE FROM maple_upload_counts WHERE family_id <> 1`);
    await sql(`INSERT INTO maple_upload_counts (family_id, day, tokens) VALUES (2, CURRENT_DATE - 1, $1), (3, CURRENT_DATE - 2, $2)`, [1350, FAMILY_UPLOAD_LIMITS.tokensTotal - 1351]);
    eq(await claimUpload(2), true, "last shared lifetime token");
    eq(await claimUpload(3), false, "another family cannot exceed the shared total");
  });

  await test("parallel families cannot both claim the last shared daily token", async () => {
    await sql(`DELETE FROM maple_upload_counts WHERE family_id <> 1`);
    await sql(`INSERT INTO maple_upload_counts (family_id, day, tokens) VALUES (2, CURRENT_DATE, $1)`, [FAMILY_UPLOAD_LIMITS.tokensPerDay - 1]);
    const results = await Promise.all([claimUpload(2), claimUpload(3)]);
    eq(results.filter(Boolean).length, 1, "one token granted");
    eq((await sql(`SELECT SUM(tokens)::int AS n FROM maple_upload_counts WHERE family_id <> 1`))[0].n, FAMILY_UPLOAD_LIMITS.tokensPerDay, "shared total stays at the cap");
  });

  done("upload-quota.check.ts");
}

main().catch((error) => { console.error(error); process.exit(1); });
