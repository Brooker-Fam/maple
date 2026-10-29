import { deepStrictEqual as eq } from "node:assert";
import { NextRequest } from "next/server";
import { encryptSecret } from "../../src/lib/secret-box";
import { POST } from "../../src/app/api/maple/timer/route";
import * as store from "../../src/lib/maple/store";
import { applyFeedCorrections } from "../../src/lib/maple/feed";
import type { FeedCorrection, FeedData, FeedEdit, TimerResponse } from "../../src/lib/maple/types";
import { done, freshDb, ok, seedFamilies, sql, test } from "./harness";

/** Historical and live nursing corrections use the same timer endpoint.
 * Exercise single edits and atomic drafts through the real route and in-memory Postgres.
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
  return { status: response.status, body: await response.json() as Partial<TimerResponse> & { reason?: string; error?: string; code?: string } };
}

async function main() {
  for (const shape of ["production", "final"] as const) {
    await freshDb({ shape });
    const { alpha, beta } = await seedFamilies();
    // Count actual row writes, so one request cannot hide sequential partial saves.
    await sql("CREATE TABLE synthetic_timer_writes (entry_id integer NOT NULL)");
    await sql(`CREATE FUNCTION record_synthetic_timer_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO synthetic_timer_writes (entry_id) VALUES (NEW.id); RETURN NEW; END $$`);
    await sql("CREATE TRIGGER synthetic_timer_write AFTER UPDATE ON maple_entries FOR EACH ROW EXECUTE FUNCTION record_synthetic_timer_write()");
    const writes = async (id: number) => Number((await sql("SELECT count(*) AS n FROM synthetic_timer_writes WHERE entry_id = $1", [id]))[0].n);
    const fixture = async (state: "finished" | "running" | "paused" = "finished") => {
      const entry = await store.createEntry(A, {
        babyId: alpha.babyId, kind: "feed", startedAt: new Date(at(0)),
        endedAt: state === "finished" ? new Date(at(40)) : null, active: state !== "finished",
        data: { method: "breast", first_side: "L", segments: [
          { side: "L", start: at(0), end: at(20) },
          { side: "R", start: at(20), end: state === "running" ? null : at(40) },
        ] },
        note: "Synthetic draft note", createdBy: alpha.owner, source: "web",
      });
      await sql("UPDATE maple_entries SET updated_at = $2 WHERE id = $1", [entry.id, version]);
      await sql("DELETE FROM synthetic_timer_writes WHERE entry_id = $1", [entry.id]);
      return (await store.getEntry(A, entry.id))!;
    };
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

    await test(`${shape}: multiple times and sides save as one atomic draft and one undo`, async () => {
      const before = await fixture();
      const edits: FeedCorrection[] = [
        { op: "move", edge: "side_end", ref: { side: "L", start: at(0) }, to: at(15) },
        { op: "set_side", ref: { side: "L", start: at(0) }, side: "B" },
        { op: "move", edge: "start", ref: { side: "R", start: at(20) }, to: at(22) },
        { op: "set_side", ref: { side: "R", start: at(22) }, side: "L" },
        { op: "move", edge: "end", ref: { side: "L", start: at(22) }, to: at(35) },
      ];
      const original = structuredClone(before);
      const preview = applyFeedCorrections(before, edits, new Date());
      eq(before, original, "preview does not mutate its input");
      const saved = await call(alpha.member, 1, before.id, { op: "batch", edits, expect_updated_at: before.updated_at });
      eq(saved.status, 200);
      const result = saved.body.entry!;
      eq((result.data as FeedData).segments, [
        { side: "B", start: at(0), end: at(15) },
        { side: "L", start: at(22), end: at(35) },
      ]);
      eq(result.data, preview.data, "server and preview use the same nursing rules");
      eq([result.active, result.ended_at, result.note, result.created_by, result.source, result.updated_by],
        [false, at(35), before.note, before.created_by, before.source, alpha.member]);
      eq(await writes(before.id), 1, "all corrections produce exactly one database update");
      eq(saved.body.before, {
        segments: (before.data as FeedData).segments, started_at: before.started_at, ended_at: before.ended_at, updated_at: before.updated_at,
        first_side: (before.data as FeedData).first_side ?? null, last_side: (before.data as FeedData).last_side ?? null,
      });
      const undone = await call(alpha.member, 1, before.id, { op: "restore", ...saved.body.before, expect_updated_at: result.updated_at });
      eq(undone.status, 200);
      eq([(undone.body.entry!.data as FeedData).segments, undone.body.entry!.started_at, undone.body.entry!.ended_at],
        [(before.data as FeedData).segments, before.started_at, before.ended_at], "one undo restores the entire draft");
    });

    await test(`${shape}: later corrections use merged sides and their corrected refs`, async () => {
      const before = await fixture();
      const saved = await call(alpha.owner, 1, before.id, { op: "batch", expect_updated_at: before.updated_at, edits: [
        { op: "set_side", ref: { side: "R", start: at(20) }, side: "L" },
        { op: "move", edge: "start", ref: { side: "L", start: at(0) }, to: at(2) },
        { op: "move", edge: "end", ref: { side: "L", start: at(2) }, to: at(35) },
      ] });
      eq(saved.status, 200);
      eq((saved.body.entry!.data as FeedData).segments, [{ side: "L", start: at(2), end: at(35) }]);
      eq([saved.body.entry!.started_at, saved.body.entry!.ended_at, await writes(before.id)], [at(2), at(35), 1]);
    });

    await test(`${shape}: batch undo restores known and absent side hints on both-side feeds`, async () => {
      // Finished covers stored hints; running covers explicit absence and the active restore path.
      for (const active of [false, true]) {
        const before = await store.createEntry(A, {
          babyId: alpha.babyId, kind: "feed", startedAt: new Date(at(0)), endedAt: active ? null : new Date(at(20)), active,
          data: { method: "breast", segments: [{ side: "B", start: at(0), end: active ? null : at(20) }],
            ...(!active ? { first_side: "L", last_side: "L" } : {}) },
          createdBy: alpha.owner, source: "web",
        });
        const saved = await call(alpha.owner, 1, before.id, { op: "batch", expect_updated_at: before.updated_at, edits: [
          { op: "set_side", ref: { side: "B", start: at(0) }, side: "R" },
        ] });
        eq(saved.status, 200);
        eq([saved.body.before!.first_side, saved.body.before!.last_side], active ? [null, null] : ["L", "L"]);
        const changedData = saved.body.entry!.data as FeedData;
        eq([changedData.first_side, changedData.last_side], ["R", "R"]);
        const restore = { op: "restore", ...saved.body.before, expect_updated_at: saved.body.entry!.updated_at };
        for (const key of ["first_side", "last_side"]) {
          const invalid = await call(alpha.owner, 1, before.id, { ...restore, [key]: "B" });
          eq(invalid.status, 400, "stored hints are tracked sides or explicit null");
        }
        const undone = await call(alpha.owner, 1, before.id, restore);
        eq(undone.status, 200);
        const restored = undone.body.entry!.data as FeedData;
        eq(restored.segments, (before.data as FeedData).segments);
        eq([restored.first_side, restored.last_side], active ? [undefined, undefined] : ["L", "L"]);
        if (active) {
          ok(!Object.hasOwn(restored, "first_side") && !Object.hasOwn(restored, "last_side"), "explicit null removes newly introduced hints");
          await store.stopTimer(A, before.id, new Date(at(20)), alpha.owner);
        }
      }
    });

    await test(`${shape}: an invalid later correction leaves every earlier draft change unsaved`, async () => {
      const before = await fixture();
      const edits: FeedCorrection[] = [
        { op: "set_side", ref: { side: "L", start: at(0) }, side: "B" },
        { op: "move", edge: "side_end", ref: { side: "B", start: at(0) }, to: at(25) },
      ];
      let rejected = false;
      const original = structuredClone(before);
      try { applyFeedCorrections(before, edits, new Date()); } catch { rejected = true; }
      ok(rejected, "the preview rejects moving past the following side");
      eq(before, original, "a failed preview also preserves its input");
      const saved = await call(alpha.owner, 1, before.id, { op: "batch", edits, expect_updated_at: before.updated_at });
      eq([saved.status, saved.body.code], [400, "after_next"]);
      eq(await store.getEntry(A, before.id), before, "no earlier side change leaks from a failed draft");
      eq(await writes(before.id), 0);
    });

    await test(`${shape}: a stale batch returns current data without partially applying corrections`, async () => {
      const before = await fixture();
      await store.updateEntry(A, before.id, { note: "Synthetic note from the other parent" }, alpha.member);
      const current = await store.getEntry(A, before.id);
      const count = await writes(before.id);
      const saved = await call(alpha.owner, 1, before.id, { op: "batch", expect_updated_at: before.updated_at, edits: [
        { op: "move", edge: "side_end", ref: { side: "L", start: at(0) }, to: at(15) },
        { op: "set_side", ref: { side: "R", start: at(20) }, side: "B" },
      ] });
      eq([saved.status, saved.body.reason], [409, "changed"]);
      eq(saved.body.entry, current);
      eq(await store.getEntry(A, before.id), current);
      eq(await writes(before.id), count);
    });

    await test(`${shape}: batches require a revision, bounded corrections, valid fields, and no nested actions`, async () => {
      const before = await fixture();
      const good = { op: "set_side", ref: { side: "L", start: at(0) }, side: "B" };
      for (const invalid of [undefined, null, "", "invalid", 1, {}]) {
        const saved = await call(alpha.owner, 1, before.id, { op: "batch", edits: [good], expect_updated_at: invalid });
        eq(saved.status, 400, `invalid batch revision ${JSON.stringify(invalid)}`);
      }
      for (const edits of [undefined, [], Array(121).fill(good), [null], [{ op: "batch", edits: [good] }], [{ op: "restore" }],
        [good, { ...good, side: "X" }], [good, { ...good, ref: { side: "L", start: "invalid" } }],
        [good, { op: "move", edge: "unknown", to: at(15) }], [good, { op: "move", edge: "end", to: "invalid" }]]) {
        const saved = await call(alpha.owner, 1, before.id, { op: "batch", edits, expect_updated_at: before.updated_at });
        eq(saved.status, 400, `invalid batch contents ${JSON.stringify(edits)}`);
      }
      eq(await store.getEntry(A, before.id), before);
      eq(await writes(before.id), 0);
    });

    for (const state of ["running", "paused", "finished"] as const) {
      await test(`${shape}: a batch preserves a ${state} feed's state`, async () => {
        const before = await fixture(state);
        const saved = await call(alpha.owner, 1, before.id, { op: "batch", expect_updated_at: before.updated_at, edits: [
          { op: "move", edge: "side_end", ref: { side: "L", start: at(0) }, to: at(15) },
          { op: "set_side", ref: { side: "R", start: at(20) }, side: "B" },
        ] });
        eq(saved.status, 200);
        const result = saved.body.entry!;
        eq([result.active, result.ended_at], [before.active, before.ended_at]);
        eq((result.data as FeedData).segments, [
          { side: "L", start: at(0), end: at(15) },
          { side: "B", start: at(20), end: state === "running" ? null : at(40) },
        ]);
        eq(await writes(before.id), 1);
        if (result.active) await store.stopTimer(A, result.id, new Date(at(45)), alpha.owner);
      });
    }

    await test(`${shape}: batch corrections keep family and viewer access boundaries`, async () => {
      const before = await fixture();
      const edit = { op: "batch", expect_updated_at: before.updated_at, edits: [
        { op: "set_side", ref: { side: "L", start: at(0) }, side: "B" },
      ] };
      const other = await call(beta.owner, 2, before.id, edit);
      eq([other.status, other.body.entry], [404, undefined]);
      const viewer = await call(alpha.viewer, 1, before.id, edit);
      eq([viewer.status, viewer.body.entry], [403, undefined]);
      eq(await store.getEntry(A, before.id), before);
      eq(await writes(before.id), 0);
    });

    await test(`${shape}: a batch's earlier start follows its nap once and undo restores both`, async () => {
      const before = await fixture();
      const nap = await store.createEntry(A, {
        babyId: alpha.babyId, kind: "sleep", startedAt: new Date(at(-30)), endedAt: new Date(at(0)),
        data: {}, createdBy: alpha.owner, source: "web",
      });
      const saved = await call(alpha.owner, 1, before.id, { op: "batch", expect_updated_at: before.updated_at, edits: [
        { op: "move", edge: "start", ref: { side: "L", start: at(0) }, to: at(-5) },
        { op: "set_side", ref: { side: "L", start: at(-5) }, side: "B" },
      ] });
      eq(saved.status, 200);
      eq([saved.body.entry!.started_at, saved.body.nap?.entry.id, saved.body.nap?.entry.ended_at], [at(-5), nap.id, at(-5)]);
      eq([await writes(before.id), await writes(nap.id)], [1, 1]);
      const undone = await call(alpha.owner, 1, before.id, {
        op: "restore", ...saved.body.before, expect_updated_at: saved.body.entry!.updated_at,
        nap: { id: nap.id, ended_at: saved.body.nap!.before_ended_at, expect_updated_at: saved.body.nap!.entry.updated_at },
      });
      eq([undone.status, undone.body.nap_restored], [200, true]);
      eq([undone.body.entry!.started_at, (await store.getEntry(A, nap.id))!.ended_at], [at(0), at(0)]);
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
