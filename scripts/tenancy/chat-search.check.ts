/** Real search queries and route authorization against synthetic in-memory Postgres only. */
import { NextRequest } from "next/server";
import { POST } from "../../src/app/api/maple/chat/search/route";
import { SESSION_COOKIE, sealSession } from "../../src/lib/maple/auth";
import { acceptConsent, withdrawConsent } from "../../src/lib/maple/consent";
import { searchEntries, searchEntriesTool, ChatSearchError } from "../../src/lib/maple/chat/search-tools";
import { searchInputSchema, parseEntryResults, type ChatEntryResults } from "../../src/lib/maple/chat/search";
import { context, type Extra } from "../../src/lib/maple/mcp-tools";
import { addDays, dayBounds, dayKey } from "../../src/lib/maple/time";
import { done, eq, freshDb, ok, seedFamilies, sql, test, type FamilySeed } from "./harness";

process.env.MAPLE_SESSION_SECRET = "synthetic-chat-search-session-secret";
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
const now = new Date();
const ago = (hours: number) => new Date(now.getTime() - hours * 3600_000).toISOString();
const extra = (family: FamilySeed, email = family.member) => ({ authInfo: { extra: { sub: `maple:${email}`, fam: family.familyId, via: "chat", care: false } } }) as unknown as Extra;
const ctx = async (family: FamilySeed) => ({ ...await context(extra(family)), now });

async function entry(family: FamilySeed, note: string, at = ago(1), data: Record<string, unknown> = {}, options: { deleted?: boolean; babyId?: number; kind?: string } = {}) {
  const rows = await sql(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, data, note, created_by, deleted_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [family.familyId, options.babyId ?? family.babyId, options.kind ?? "note", at, data, note, family.owner, options.deleted ? now.toISOString() : null]);
  return Number(rows[0].id);
}

async function rejected(work: () => Promise<unknown>) {
  let failed = false;
  try { await work(); } catch (error) { failed = error instanceof ChatSearchError; }
  ok(failed, "invalid search refused with a readable error");
}

function request(family: FamilySeed | null, body: unknown, email = family?.member) {
  return new NextRequest("http://localhost:3000/api/maple/chat/search", {
    method: "POST", headers: { "content-type": "application/json", ...(family && email ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealSession(email, family.familyId))}` } : {}) }, body: JSON.stringify(body),
  });
}

async function main() {
  await freshDb();
  const { alpha, beta } = await seedFamilies();
  await acceptConsent({ familyId: alpha.familyId }, alpha.member, "chat");
  await acceptConsent({ familyId: alpha.familyId }, alpha.viewer, "chat");
  await acceptConsent({ familyId: beta.familyId }, beta.member, "chat");
  await sql("DELETE FROM maple_entries");
  const alt = await sql("INSERT INTO maple_babies (family_id, name, timezone, archived_at) VALUES ($1, 'Archived synthetic baby', $2, NOW()) RETURNING id", [alpha.familyId, alpha.tz]);
  const one = await entry(alpha, "Hiccups after feeding");
  await entry(beta, "Hiccups other family");
  await entry(alpha, "Hiccups deleted", ago(2), {}, { deleted: true });
  await entry(alpha, "Hiccups future", ago(-1));
  await entry(alpha, "Hiccups archived baby", ago(2), {}, { babyId: Number(alt[0].id) });

  await test("search scopes family, current baby, deletion and future timestamps", async () => {
    const result = await searchEntries(await ctx(alpha), { query: "hiccups" });
    eq(result.entries.map((row) => row.id), [one]);
    ok(!JSON.stringify(result).includes("other family"), "other family text excluded");
    eq(result.timezone, alpha.tz);
  });

  await test("substring search is case insensitive and escapes SQL wildcard characters", async () => {
    const literal = await entry(alpha, "Literal 50%_done \\ note");
    await entry(alpha, "Literal 50ABdone X note");
    eq((await searchEntries(await ctx(alpha), { query: "50%_done \\" })).entries.map((row) => row.id), [literal]);
    eq((await searchEntries(await ctx(alpha), { query: "HICCUPS" })).entries.map((row) => row.id), [one]);
    eq((await searchEntries(await ctx(alpha), { query: "' OR 1=1 --" })).entries.length, 0);
  });

  await test("dates follow the family timezone and exact time filters remain bounded", async () => {
    const yesterday = addDays(dayKey(now, alpha.tz), -1);
    const [start, end] = dayBounds(yesterday, alpha.tz);
    const inside = await entry(alpha, "local boundary", new Date(start.getTime() + 1000).toISOString());
    await entry(alpha, "local boundary", new Date(start.getTime() - 1000).toISOString());
    const before = new Date(start.getTime() + 2000).toISOString();
    eq((await searchEntries(await ctx(alpha), { query: "local boundary", from: yesterday, to: yesterday, before })).entries.map((row) => row.id), [inside]);
    await rejected(async () => searchEntries(await ctx(alpha), { from: yesterday, to: yesterday, after: end.toISOString() }));
    await rejected(async () => searchEntries(await ctx(alpha), { to: addDays(dayKey(now, alpha.tz), 1) }));
  });

  let first: ChatEntryResults;
  await test("keyset pagination preserves criteria without duplicates for equal timestamps", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await entry(alpha, `paging synthetic ${i}`, ago(3)));
    first = await searchEntries(await ctx(alpha), { query: "paging synthetic", kind: "note", limit: 2 });
    const second = await searchEntries(await ctx(alpha), { cursor: first.nextCursor! });
    const third = await searchEntries(await ctx(alpha), { cursor: second.nextCursor! });
    eq([...first.entries, ...second.entries, ...third.entries].map((row) => row.id), ids.reverse());
    eq(third.nextCursor, null);
    eq(second.criteria, first.criteria);
    eq(second.asOf, first.asOf);
    await rejected(async () => searchEntries(await ctx(beta), { cursor: first.nextCursor! }));
    await rejected(async () => searchEntries(await ctx(alpha), { cursor: first.nextCursor!, query: "changed" }));
    const changed = first.nextCursor!.split("");
    changed[42] = changed[42] === "A" ? "B" : "A";
    await rejected(async () => searchEntries(await ctx(alpha), { cursor: changed.join("") }));
  });

  await test("pediatrician questions include only baby notes and optionally answered questions", async () => {
    const open = await entry(alpha, "Synthetic open question", ago(1), { for_doctor: true });
    const asked = await entry(alpha, "Synthetic answered question", ago(2), { for_doctor: true, done: true, answer: "Recorded answer" });
    const result = await searchEntries(await ctx(alpha), { doctorQuestions: true });
    eq(result.entries.map((row) => row.id), [open]);
    eq(result.entries[0].question, true);
    eq((await searchEntries(await ctx(alpha), { doctorQuestions: true, includeAnswered: true })).entries.map((row) => row.id), [open, asked]);
    ok(!JSON.stringify(result).includes("Ibuprofen"), "no care fields copied");
  });

  await test("search schema, cursor and payload are bounded", async () => {
    ok(!searchInputSchema.safeParse({ limit: 21 }).success, "page limit enforced");
    ok(!searchInputSchema.safeParse({ query: "x".repeat(121) }).success, "search length enforced");
    ok(!searchInputSchema.safeParse({ from: "2026-02-30" }).success, "invalid date refused");
    ok(parseEntryResults({ version: 999 }) === null, "unknown card versions refused");
    await rejected(async () => searchEntries(await ctx(alpha), { cursor: "not-a-cursor" }));
    await rejected(async () => searchEntries(await ctx(alpha), { from: addDays(dayKey(now, alpha.tz), -400) }));
    await entry(alpha, "x".repeat(2000));
    ok((await searchEntries(await ctx(alpha), { query: "xxxxxxxxxx" })).entries[0].summary.length <= 500, "summary bounded");
  });

  await test("pagination endpoint requires membership, permits viewers and rejects foreign cursors", async () => {
    eq((await POST(request(null, { cursor: first.nextCursor }))).status, 401);
    const viewer = await POST(request(alpha, { cursor: first.nextCursor }, alpha.viewer));
    eq(viewer.status, 200);
    eq(viewer.headers.get("cache-control"), "no-store");
    ok(parseEntryResults(await viewer.json()) !== null, "typed results returned");
    eq((await POST(request(beta, { cursor: first.nextCursor }))).status, 400);
    eq((await POST(request(alpha, { query: "anything" }))).status, 400);
    await withdrawConsent({ familyId: alpha.familyId }, alpha.viewer, "chat");
    eq((await POST(request(alpha, { cursor: first.nextCursor }, alpha.viewer))).status, 403);
  });

  await test("retained tool and cursor both recheck removed membership", async () => {
    const tool = searchEntriesTool(extra(alpha));
    await sql("DELETE FROM maple_members WHERE family_id = $1 AND email = $2", [alpha.familyId, alpha.member]);
    let refused = false;
    try { await tool.execute!({ query: "hiccups" }, { toolCallId: "synthetic-search", messages: [], context: {} }); } catch { refused = true; }
    ok(refused, "retained model tool cannot read after removal");
    ok((await POST(request(alpha, { cursor: first.nextCursor }))).status >= 400, "removed member cannot paginate");
  });
  done("chat-search.check.ts");
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
