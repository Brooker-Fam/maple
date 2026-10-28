import { NextRequest } from "next/server";
import { encryptSecret } from "../src/lib/secret-box";
import { GET } from "../src/app/api/maple/entries/route";
import { done, eq, freshDb, ok, seedFamilies, sql, test } from "./tenancy/harness";

process.env.GOOGLE_CLIENT_SECRET = "synthetic-moments-review-secret";

async function main() {
  await freshDb();
  const { alpha, beta } = await seedFamilies();
  await sql("DELETE FROM maple_entries WHERE kind = 'moment'");
  const at = "2026-09-01T12:00:00.000Z";
  const rows = await sql(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, data, created_by, source)
    SELECT $1, $2, 'moment', $3::timestamptz,
      jsonb_build_object('title', 'Synthetic moment ' || n, 'milestone', CASE WHEN n <= 2 THEN 'first-smile' WHEN n <= 4 THEN 'monthly-1' ELSE NULL END), $4, 'web'
    FROM generate_series(1, 501) AS n RETURNING id`, [alpha.familyId, alpha.babyId, at, alpha.owner]);
  const ids = rows.map((row) => Number(row.id));
  await sql(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, data, created_by, source) VALUES ($1, $2, 'moment', $3, '{"milestone":"first-smile"}', $4, 'web')`, [beta.familyId, beta.babyId, at, beta.owner]);
  const call = async (query: string, family = alpha) => {
    const request = new NextRequest(`http://localhost:3000/api/maple/entries?${query}`);
    request.cookies.set("maple_session", encryptSecret(JSON.stringify({ id: family.owner, fam: family.familyId, iat: Date.now() })));
    const result = await GET(request);
    return { status: result.status, body: await result.json() };
  };

  await test("moments cursor reaches all 501 equal-time entries without duplicates or another family", async () => {
    const seen: number[] = [];
    let query = "kind=moment&limit=100";
    for (let page = 0; page < 8; page++) {
      const result = await call(query);
      eq(result.status, 200);
      seen.push(...result.body.entries.map((entry: { id: number }) => entry.id));
      const next = result.body.next_cursor;
      if (!next) break;
      query = `kind=moment&limit=100&before=${encodeURIComponent(next.started_at)}&before_id=${next.id}`;
    }
    eq(seen, [...ids].reverse());
  });

  await test("moment highlights select earliest first and latest monthly record beyond the first page", async () => {
    const result = await call("kind=moment&highlights=1");
    eq(result.status, 200);
    eq(result.body.entries.map((entry: { id: number }) => entry.id).sort((a: number, b: number) => a - b), [ids[0], ids[3]]);
    const other = await call("kind=moment&highlights=1", beta);
    eq(other.body.entries.length, 1);
    ok(!ids.includes(other.body.entries[0].id), "highlights remain family scoped");
  });

  await test("invalid or incomplete moment cursors return a validation error", async () => {
    for (const query of ["before=not-a-date&before_id=1", "before=2026-09-01T12:00:00.000Z", "before_id=1", `before=${at}&before_id=1.5`, `before=${at}&before_id=-2`]) eq((await call(`kind=moment&${query}`)).status, 400, query);
  });

  await test("highlights mode refuses non-moment filters and pagination", async () => {
    for (const query of ["kind=feed&highlights=1", "highlights=1", `kind=moment&highlights=1&before=${at}&before_id=1`]) eq((await call(query)).status, 400, query);
  });
  done("ui-review-moments-api");
}

void main();
