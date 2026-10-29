import { deepStrictEqual as eq } from "node:assert";
import { NextRequest } from "next/server";
import { POST } from "../../src/app/api/maple/timer/route";
import * as store from "../../src/lib/maple/store";
import type { Entry, FeedData, TimerResponse } from "../../src/lib/maple/types";
import { encryptSecret } from "../../src/lib/secret-box";
import { done, freshDb, seedFamilies, sql, test } from "./harness";

process.env.GOOGLE_CLIENT_SECRET ??= "synthetic-timing-adjust-secret";
const A = { familyId: 1 };
const MIN = 60_000;
const version = "2026-01-01T00:00:00.123Z";
const newerVersion = "2026-01-02T00:00:00.123Z";

async function call(owner: string, entry: Entry, action: "adjust" | "stop" | "reopen", at: unknown, revision: unknown) {
  const request = new NextRequest("http://localhost:3000/api/maple/timer", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, id: entry.id, at, expect_updated_at: revision }),
  });
  request.cookies.set("maple_session", encryptSecret(JSON.stringify({ id: owner, fam: 1, iat: Date.now() })));
  const response = await POST(request);
  return { status: response.status, body: await response.json() as Partial<TimerResponse> & { reason?: string } };
}

async function main() {
  for (const shape of ["production", "final"] as const) {
    await freshDb({ shape });
    const { alpha } = await seedFamilies();
    const startedAt = new Date(Date.now() - 30 * MIN);
    const earlier = new Date(startedAt.getTime() - 5 * MIN).toISOString();
    const earliest = new Date(startedAt.getTime() - 10 * MIN).toISOString();
    const endedAt = new Date(startedAt.getTime() + 20 * MIN).toISOString();
    const fixture = async (kind: "sleep" | "tummy" | "pump" | "feed") => {
      const entry = await store.createEntry(A, {
        babyId: alpha.babyId, kind, startedAt, active: true,
        data: kind === "feed" ? { method: "breast", first_side: "L", segments: [{ side: "L", start: startedAt.toISOString(), end: null }] }
          : kind === "pump" ? { left_ml: 15, right_ml: 20 } : kind === "sleep" ? { place: "crib" } : {},
        note: "Synthetic timer note", createdBy: alpha.owner, source: "web",
      });
      await sql("UPDATE maple_entries SET updated_at = $2 WHERE id = $1", [entry.id, version]);
      return (await store.getEntry(A, entry.id))!;
    };

    for (const kind of ["sleep", "tummy", "pump", "feed"] as const) {
      await test(`${shape}: stale ${kind} start adjustments preserve newer corrections`, async () => {
        const original = await fixture(kind);
        try {
          await store.adjustTimerStart(A, original.id, new Date(earlier), alpha.member);
          const current = (await store.getEntry(A, original.id))!;
          const stale = await call(alpha.owner, original, "adjust", earliest, original.updated_at);
          eq([stale.status, stale.body.reason], [409, "changed"]);
          eq(stale.body.entry, current);
          eq(await store.getEntry(A, original.id), current);
          const saved = await call(alpha.owner, current, "adjust", earliest, current.updated_at);
          eq(saved.status, 200);
          eq([saved.body.entry!.started_at, saved.body.entry!.ended_at, saved.body.entry!.note], [earliest, null, original.note]);
          if (kind === "feed") eq((saved.body.entry!.data as FeedData).segments?.[0].start, earliest);
          else eq(saved.body.entry!.data, original.data);
          const stopped = await call(alpha.owner, saved.body.entry!, "stop", endedAt, saved.body.entry!.updated_at);
          eq(stopped.status, 200);
          eq(Date.parse(stopped.body.entry!.ended_at!) - Date.parse(stopped.body.entry!.started_at), 30 * MIN);
        } finally {
          await store.softDeleteEntry(A, original.id, alpha.owner);
        }
      });
    }

    for (const kind of ["sleep", "tummy", "pump"] as const) {
      await test(`${shape}: ${kind} adjustment Undo and Done Undo preserve subsequent edits`, async () => {
        const original = await fixture(kind);
        try {
          const adjusted = await call(alpha.owner, original, "adjust", earlier, original.updated_at);
          eq(adjusted.status, 200);
          await store.adjustTimerStart(A, original.id, new Date(earliest), alpha.member);
          await sql("UPDATE maple_entries SET updated_at = $2 WHERE id = $1", [original.id, newerVersion]);
          const current = (await store.getEntry(A, original.id))!;
          const undo = await call(alpha.owner, current, "adjust", original.started_at, adjusted.body.entry!.updated_at);
          eq([undo.status, undo.body.reason], [409, "changed"]);
          eq(await store.getEntry(A, original.id), current);
          const staleStop = await call(alpha.owner, current, "stop", endedAt, adjusted.body.entry!.updated_at);
          eq([staleStop.status, staleStop.body.reason], [409, "changed"]);
          eq(await store.getEntry(A, original.id), current);
          const stopped = await call(alpha.owner, current, "stop", endedAt, current.updated_at);
          eq(stopped.status, 200);
          await store.updateEntry(A, original.id, { startedAt: new Date(earlier) }, alpha.member);
          await sql("UPDATE maple_entries SET updated_at = $2 WHERE id = $1", [original.id, newerVersion]);
          const corrected = (await store.getEntry(A, original.id))!;
          const staleReopen = await call(alpha.owner, corrected, "reopen", undefined, stopped.body.entry!.updated_at);
          eq([staleReopen.status, staleReopen.body.reason], [409, "changed"]);
          eq(await store.getEntry(A, original.id), corrected);
          const reopened = await call(alpha.owner, corrected, "reopen", undefined, corrected.updated_at);
          eq(reopened.status, 200);
          eq([reopened.body.entry!.active, reopened.body.entry!.ended_at, reopened.body.entry!.started_at], [true, null, earlier]);
          const restored = await call(alpha.owner, reopened.body.entry!, "adjust", original.started_at, reopened.body.entry!.updated_at);
          eq(restored.status, 200);
          eq(restored.body.entry!.started_at, original.started_at);
        } finally {
          await store.softDeleteEntry(A, original.id, alpha.owner);
        }
      });
    }

    await test(`${shape}: adjustment validates supplied revisions and times while retaining legacy calls`, async () => {
      const original = await fixture("sleep");
      try {
        for (const invalid of [null, "", "invalid", 1, {}]) {
          const answer = await call(alpha.owner, original, "adjust", earlier, invalid);
          eq(answer.status, 400, `invalid revision ${JSON.stringify(invalid)}`);
          eq(await store.getEntry(A, original.id), original);
        }
        for (const invalid of [null, "", "invalid", 1, {}, new Date(Date.now() + MIN).toISOString(), new Date(Date.now() - 13 * 60 * MIN).toISOString()]) {
          const answer = await call(alpha.owner, original, "adjust", invalid, original.updated_at);
          eq(answer.status, 400, `invalid start ${JSON.stringify(invalid)}`);
          eq(await store.getEntry(A, original.id), original);
        }
        const legacy = await call(alpha.owner, original, "adjust", earlier, undefined);
        eq(legacy.status, 200);
        eq(legacy.body.entry!.started_at, earlier);
      } finally {
        await store.softDeleteEntry(A, original.id, alpha.owner);
      }
    });
  }
  done("timing-adjust");
}

void main().catch((error) => { console.error(error); process.exit(1); });
