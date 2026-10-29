import { deepStrictEqual as eq } from "node:assert";
import { NextRequest } from "next/server";
import { POST } from "../../src/app/api/maple/timer/route";
import * as store from "../../src/lib/maple/store";
import type { Entry, FeedData, TimerResponse } from "../../src/lib/maple/types";
import { encryptSecret } from "../../src/lib/secret-box";
import { done, freshDb, seedFamilies, sql, test } from "./harness";

process.env.GOOGLE_CLIENT_SECRET ??= "synthetic-timing-switch-secret";
const A = { familyId: 1 };
const MIN = 60_000;
const version = "2026-01-01T00:00:00.123Z";

async function call(owner: string, entry: Entry, action: "switch" | "resume", at: string, revision: unknown) {
  const request = new NextRequest("http://localhost:3000/api/maple/timer", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, id: entry.id, side: "R", at, expect_updated_at: revision }),
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
    const pausedAt = new Date(startedAt.getTime() + 10 * MIN).toISOString();
    const switchedAt = new Date(startedAt.getTime() + 15 * MIN).toISOString();
    const fixture = async (action: "switch" | "resume") => {
      const entry = await store.createEntry(A, {
        babyId: alpha.babyId, kind: "feed", startedAt, active: true,
        data: { method: "breast", first_side: "L", segments: [{ side: "L", start: startedAt.toISOString(), end: action === "resume" ? pausedAt : null }] },
        createdBy: alpha.owner, source: "web",
      });
      await sql("UPDATE maple_entries SET updated_at = $2 WHERE id = $1", [entry.id, version]);
      return (await store.getEntry(A, entry.id))!;
    };
    for (const action of ["switch", "resume"] as const) {
      await test(`${shape}: a stale ${action} is rejected without changing the current feed`, async () => {
        const before = await fixture(action);
        try {
          await store.updateEntry(A, before.id, { note: "Synthetic correction from another phone" }, alpha.member);
          const current = (await store.getEntry(A, before.id))!;
          const stale = await call(alpha.owner, before, action, switchedAt, before.updated_at);
          eq([stale.status, stale.body.reason], [409, "changed"]);
          eq(stale.body.entry, current);
          eq(await store.getEntry(A, before.id), current);
          const saved = await call(alpha.owner, current, action, switchedAt, current.updated_at);
          eq(saved.status, 200);
          const entry = saved.body.entry!;
          eq((entry.data as FeedData).segments, [
            { side: "L", start: startedAt.toISOString(), end: action === "resume" ? pausedAt : switchedAt },
            { side: "R", start: switchedAt, end: null },
          ]);
          eq(entry.note, current.note);
          eq(saved.body.before?.segments, (current.data as FeedData).segments);
        } finally {
          await store.softDeleteEntry(A, before.id, alpha.owner);
        }
      });
      await test(`${shape}: a ${action} rejects invalid optional revisions before writing`, async () => {
        const before = await fixture(action);
        try {
          for (const invalid of [null, "", "invalid", 1, {}]) {
            const answer = await call(alpha.owner, before, action, switchedAt, invalid);
            eq(answer.status, 400, `invalid revision ${JSON.stringify(invalid)}`);
            eq(await store.getEntry(A, before.id), before);
          }
          eq((await call(alpha.owner, before, action, switchedAt, undefined)).status, 200);
        } finally {
          await store.softDeleteEntry(A, before.id, alpha.owner);
        }
      });
    }
  }
  done("timing-switch");
}

void main().catch((error) => { console.error(error); process.exit(1); });
