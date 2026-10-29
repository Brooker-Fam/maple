import { NextRequest } from "next/server";
import { encryptSecret } from "../../src/lib/secret-box";
import { POST } from "../../src/app/api/maple/timer/route";
import * as store from "../../src/lib/maple/store";
import type { Entry, FeedData, FeedEdit } from "../../src/lib/maple/types";
import { done, eq, freshDb, ok, seedFamilies, sql, test } from "./harness";

/** Historical nursing corrections use the same timer endpoint as live feeds.
 * Exercise its optional revision through the real route and in-memory Postgres.
 */
process.env.GOOGLE_CLIENT_SECRET ??= "synthetic-secret-for-timer-correction-checks";
const A = { familyId: 1 };
const MIN = 60_000;
const BASE = Date.now() - 24 * 60 * MIN;
const at = (minutes: number) => new Date(BASE + minutes * MIN).toISOString();
const version = "2026-01-01T00:00:00.123Z";

async function call(owner: string, familyId: number, id: number, edit: unknown) {
  const request = new NextRequest("http://localhost:3000/api/maple/timer", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "retime", id, edit }),
  });
  request.cookies.set("maple_session", encryptSecret(JSON.stringify({ id: owner, fam: familyId, iat: Date.now() })));
  const response = await POST(request);
  return { status: response.status, body: await response.json() as { entry?: Entry; reason?: string; error?: string } };
}

async function main() {
  for (const shape of ["production", "final"] as const) {
    await freshDb({ shape });
    const { alpha, beta } = await seedFamilies();
    const feed = await store.createEntry(A, {
      babyId: alpha.babyId, kind: "feed", startedAt: new Date(at(0)), endedAt: new Date(at(40)),
      data: { method: "breast", first_side: "L", segments: [
        { side: "L", start: at(0), end: at(20) },
        { side: "R", start: at(20), end: at(40) },
      ] },
      note: "Synthetic note to preserve", createdBy: alpha.owner, source: "web",
    });
    // A stable old revision makes the stale-version regression deterministic.
    await sql("UPDATE maple_entries SET updated_at = $2 WHERE id = $1", [feed.id, version]);
    const ref = { side: "L" as const, start: at(0) };
    const edit: FeedEdit = { op: "move", edge: "side_end", ref, to: at(15), expect_updated_at: version };

    await test(`${shape}: guarded historical correction changes only the completed side`, async () => {
      const saved = await call(alpha.owner, 1, feed.id, edit);
      eq(saved.status, 200);
      const result = saved.body.entry!;
      eq((result.data as FeedData).segments?.map((s) => [s.side, s.start, s.end]), [
        ["L", at(0), at(15)],
        ["R", at(20), at(40)],
      ], "shortening Left creates a break and preserves Right");
      eq([result.active, result.ended_at, result.note], [false, at(40), feed.note]);
      ok(result.updated_at !== version, "successful correction advances the revision");
    });

    await test(`${shape}: stale historical correction returns the current feed without writing`, async () => {
      const before = await store.getEntry(A, feed.id);
      const stale = await call(alpha.owner, 1, feed.id, { ...edit, to: at(10) });
      eq([stale.status, stale.body.reason], [409, "changed"]);
      eq(stale.body.entry, before, "conflict carries the current entry for recovery");
      eq(await store.getEntry(A, feed.id), before, "stale draft writes nothing");
      const fresh = await call(alpha.owner, 1, feed.id, { ...edit, to: at(10), expect_updated_at: before!.updated_at });
      eq(fresh.status, 200, "retry with reviewed revision succeeds");
      eq((fresh.body.entry!.data as FeedData).segments?.[0].end, at(10));
    });

    await test(`${shape}: malformed optional correction revisions are rejected before any write`, async () => {
      const before = await store.getEntry(A, feed.id);
      for (const invalid of [null, "", "invalid", 1, {}]) {
        const answer = await call(alpha.owner, 1, feed.id, { ...edit, expect_updated_at: invalid });
        eq(answer.status, 400, `invalid revision ${JSON.stringify(invalid)}`);
      }
      eq(await store.getEntry(A, feed.id), before);
    });

    await test(`${shape}: legacy correction without a revision still works`, async () => {
      const answer = await call(alpha.owner, 1, feed.id, { op: "move", edge: "end", ref: { side: "R", start: at(20) }, to: at(35) });
      eq(answer.status, 200);
      eq(answer.body.entry!.ended_at, at(35));
      eq((answer.body.entry!.data as FeedData).segments?.[0].end, at(10), "another side stays untouched");
    });

    await test(`${shape}: correction revision never reveals another family's feed`, async () => {
      const before = await store.getEntry(A, feed.id);
      const denied = await call(beta.owner, 2, feed.id, edit);
      eq(denied.status, 404);
      eq(denied.body.entry, undefined);
      eq(await store.getEntry(A, feed.id), before);
    });

    await test(`${shape}: legacy live correction still merges with a newer switch`, async () => {
      const running = (await store.startTimer(A, {
        babyId: alpha.babyId, kind: "feed", side: "L", at: new Date(Date.now() - 30 * MIN), createdBy: alpha.owner, source: "web",
      })).entry;
      await sql("UPDATE maple_entries SET updated_at = $2 WHERE id = $1", [running.id, version]);
      const rightAt = new Date(Date.now() - 10 * MIN).toISOString();
      await store.switchSide(A, running.id, "R", new Date(rightAt), alpha.member);
      const before = await store.getEntry(A, running.id);
      const shift = { op: "move", edge: "start", ref: { side: "L", start: running.started_at }, to: new Date(Date.parse(running.started_at) - 5 * MIN).toISOString() };
      const stale = await call(alpha.owner, 1, running.id, { ...shift, expect_updated_at: version });
      eq([stale.status, stale.body.reason], [409, "changed"]);
      eq(await store.getEntry(A, running.id), before);
      const legacy = await call(alpha.owner, 1, running.id, shift);
      eq(legacy.status, 200);
      const result = legacy.body.entry!;
      eq([result.active, result.started_at], [true, shift.to]);
      const right = (result.data as FeedData).segments?.[1];
      eq([right?.side, right?.start, right?.end], ["R", rightAt, null], "switch survives merged start correction");
    });
  }
}

main().then(() => done("timer-time-correction.check.ts"));
