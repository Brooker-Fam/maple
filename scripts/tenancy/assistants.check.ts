import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { sealSession } from "../../src/lib/maple/auth";
import * as history from "../../src/lib/maple/chat/history";
import * as chat from "../../src/lib/maple/chat/store";
import { registrations } from "../../src/lib/maple/chat/tools";
import type { StreamItem } from "../../src/lib/maple/chat/window";
import { NOT_MEMBER_MESSAGE, type Extra } from "../../src/lib/maple/mcp-tools";
import { mintAccessToken, mintAuthCode, mintRefreshToken, verifyAccessToken, verifyAuthCode } from "../../src/lib/mcp/auth";
import { encryptSecret } from "../../src/lib/secret-box";
import * as mcpRoute from "../../src/app/api/maple/[transport]/route";
import * as authorizeRoute from "../../src/app/oauth/authorize/route";
import * as tokenRoute from "../../src/app/oauth/token/route";
import * as chatRoute from "../../src/app/api/maple/chat/route";
import * as quickRoute from "../../src/app/api/maple/quick/route";
import * as tokensRoute from "../../src/app/api/maple/tokens/route";
import { done, eq, freshDb, ok, seedFamilies, sql, test, type Seed, type Shape } from "./harness";

/**
 * The assistants (MCP tools and their OAuth, the in-app chat, Siri's quick
 * route and personal tokens) across two made-up families, on both schema
 * shapes: family B can neither read nor change family A's rows, another
 * family's row answers exactly like a missing one, and every write lands in
 * the caller's family. "Final" also puts one made-up person in both families,
 * where only family_id tells their rows apart.
 */

process.env.MCP_SECRET = "made-up-tenancy-mcp-secret";
process.env.GOOGLE_CLIENT_SECRET = "made-up-tenancy-session-secret";

const A = { familyId: 1 };
const B = { familyId: 2 };
const MISSING = 987654321;
const ORIGIN = "http://localhost";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

type Auth = { sub: string; fam?: unknown; via?: string };
type ToolOut = { text: string; isError: boolean; sc: Record<string, unknown> };

const sub = (email: string) => `maple:${email}`;

async function tool(name: string, args: Record<string, unknown>, auth: Auth): Promise<ToolOut> {
  const r = registrations().all.find((x) => x.name === name);
  if (!r) throw new Error(`no tool ${name}`);
  const extra = {
    signal: new AbortController().signal,
    requestId: "tenancy",
    authInfo: { token: "tenancy", clientId: "tenancy", scopes: ["maple"], extra: { via: "claude", ...auth } },
    sendNotification: async () => {},
    sendRequest: async () => {
      throw new Error("unsupported");
    },
  } as unknown as Extra;
  const res = await r.handler(args, extra);
  const text = res.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
  return { text, isError: res.isError === true, sc: (res.structuredContent ?? {}) as Record<string, unknown> };
}

/** The same tool call on another family's id and on an id nobody has: both errors, in the same words. */
async function toolLikeMissing(name: string, args: (id: number) => Record<string, unknown>, id: number, auth: Auth, label: string) {
  const theirs = await tool(name, args(id), auth);
  const none = await tool(name, args(MISSING), auth);
  ok(theirs.isError, `${label}: not an error: ${theirs.text.slice(0, 120)}`);
  eq(theirs.text.replaceAll(String(id), "<id>"), none.text.replaceAll(String(MISSING), "<id>"), label);
}

const entryRow = async (id: number) => (await sql(`SELECT family_id, baby_id, deleted_at, note, data FROM maple_entries WHERE id = $1`, [id]))[0];

/** A session cookie as the app seals it; `fam` undefined is one from before families. */
function cookie(id: string, fam?: number): string {
  const value = fam === undefined ? encryptSecret(JSON.stringify({ id, iat: Date.now() })) : sealSession(id, fam);
  return `maple_session=${encodeURIComponent(value)}`;
}

function req(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers: init.headers, body: init.body });
}

const jsonOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

// ── the chat's store ─────────────────────────────────────────────────

async function chatStoreChecks(shape: Shape, seed: Seed) {
  const { alpha, beta } = seed;

  await test(`${shape}: chat threads and messages are listed, read, locked and deleted in the caller's family only`, async () => {
    const mine = await history.chatStream(B, beta.owner, false, null);
    eq([mine.current?.id, mine.items.map((i) => i.thread)], [beta.threadId, [beta.threadId]]);
    eq((await history.chatStream(B, beta.owner, false, alpha.messageId)).items, [], "another family's message as the cursor reads as none");
    eq(await history.loadRecentMessages(B, alpha.threadId), []);
    eq((await history.loadRecentMessages(A, alpha.threadId)).map((m) => m.id), [alpha.messageId]);
    eq(await chat.lockThread(B, alpha.threadId, beta.owner, "zai/glm-5.3-flash", false, true), "missing");
    eq(await history.deleteChats(B, alpha.owner, false), 0);
    const [row] = await sql(`SELECT family_id, member, busy_until FROM maple_chat_threads WHERE id = $1`, [alpha.threadId]);
    eq([row.family_id, row.member, row.busy_until], ["1", alpha.owner, null]);
  });

  await test(`${shape}: a message, title or release aimed at another family's thread changes nothing`, async () => {
    await sql(`UPDATE maple_chat_threads SET busy_until = NOW() + INTERVAL '1 minute' WHERE id = $1`, [alpha.threadId]);
    await chat.saveMessage(B, alpha.threadId, beta.owner, { id: "msg_beta_into_alpha", role: "user", parts: [{ type: "text", text: "made-up" }] });
    await chat.saveMessage(B, beta.threadId, beta.owner, { id: alpha.messageId, role: "user", parts: [{ type: "text", text: "overwritten" }] });
    await chat.setTitle(B, alpha.threadId, "Taken over");
    await chat.releaseThread(B, alpha.threadId);
    const [t] = await sql(`SELECT title, busy_until IS NOT NULL AS busy FROM maple_chat_threads WHERE id = $1`, [alpha.threadId]);
    await chat.releaseThread(A, alpha.threadId);
    eq([t.title, t.busy], ["Made-up thread", true]);
    eq(await sql(`SELECT id FROM maple_chat_messages WHERE id = 'msg_beta_into_alpha'`), []);
    const [msg] = await sql(`SELECT parts->0->>'text' AS text FROM maple_chat_messages WHERE id = $1`, [alpha.messageId]);
    eq(msg.text, "How many diapers today?");
  });

  await test(`${shape}: a new thread, its messages, the day's count and usage land in the caller's family`, async () => {
    const locked = await chat.lockThread(B, "thread_beta_new_1", beta.member, "zai/glm-5.3-flash", false, false);
    ok(typeof locked === "object", "locked");
    await chat.saveMessage(B, "thread_beta_new_1", beta.member, { id: "msg_beta_new_1", role: "user", parts: [{ type: "text", text: "made-up" }] });
    await chat.countMessage(B, beta.member, "2026-10-21");
    await chat.recordUsage(B, {
      member: beta.member,
      threadId: "thread_beta_new_1",
      messageId: "msg_beta_new_1",
      step: 1,
      model: "zai/glm-5.3-flash",
      tokens: { prompt: 10, fresh: 10, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0 },
      costMicro: BigInt(7),
      priceKey: "zai/glm-5.3-flash",
      finishReason: "stop",
      generationId: null,
    });
    const fams = await sql(
      `SELECT (SELECT family_id FROM maple_chat_threads WHERE id = 'thread_beta_new_1') AS t,
              (SELECT family_id FROM maple_chat_messages WHERE id = 'msg_beta_new_1') AS m,
              (SELECT family_id FROM maple_chat_daily WHERE member = $1 AND day = DATE '2026-10-21') AS d,
              (SELECT family_id FROM maple_ai_usage WHERE message_id = 'msg_beta_new_1') AS u`,
      [beta.member]
    );
    eq(fams[0], { t: "2", m: "2", d: "2", u: "2" });
  });

  await test(`${shape}: one family's chat spend never counts against another's budget`, async () => {
    await sql(
      `INSERT INTO maple_ai_usage (family_id, member, step, model, cost_micro_usd, price_key) VALUES (1, $1, 1, 'zai/glm-5.3-flash', 4000, 'zai/glm-5.3-flash')`,
      [alpha.owner]
    );
    const since = new Date("2026-01-01T00:00:00Z");
    const [a, b] = [await chat.usageSince(A, alpha.owner, "2026-10-20", since, since), await chat.usageSince(B, beta.owner, "2026-10-20", since, since)];
    eq([a.mine, String(a.day), String(a.month), b.mine, String(b.day), String(b.month)], [3, "4200", "4200", 3, "207", "207"]);
    await sql(`UPDATE maple_families SET ai_daily_micro = 1234 WHERE id = 2`);
    const [fa, fb] = [await chat.familyBudget(A), await chat.familyBudget(B)];
    eq([fa.day, fa.month, String(fb.day), fb.month], [null, null, "1234", null]);
    await sql(`UPDATE maple_families SET ai_daily_micro = NULL WHERE id = 2`);
  });
}

/** Final shape only: the same person in both families, where only family_id keeps their chats apart. */
async function chatStoreBothFamilies(seed: Seed) {
  const { alpha } = seed;
  await test("final: someone in both families never sees, locks or counts their other family's chats", async () => {
    await sql(`UPDATE maple_chat_threads SET busy_until = NOW() + INTERVAL '1 minute' WHERE id = $1`, [alpha.threadId]);
    eq(await history.chatStream(B, alpha.owner, false, null), { current: null, items: [], more: false });
    eq(await history.loadRecentMessages(B, alpha.threadId), []);
    eq(await chat.lockThread(B, alpha.threadId, alpha.owner, "zai/glm-5.3-flash", false, true), "missing");
    eq(await history.deleteChats(B, alpha.owner, false), 0);
    eq((await history.chatStream(A, alpha.owner, false, null)).items.map((i) => i.message.id), [alpha.messageId], "their chat in family 1 is still there");
    const since = new Date("2026-01-01T00:00:00Z");
    eq((await chat.usageSince(B, alpha.owner, "2026-10-20", since, since)).mine, 0);
    await chat.countMessage(B, alpha.owner, "2026-10-20");
    eq((await sql(`SELECT family_id, messages FROM maple_chat_daily WHERE member = $1 ORDER BY family_id`, [alpha.owner])).map((r) => [r.family_id, r.messages]), [
      ["1", 3],
      ["2", 1],
    ]);
    await chat.releaseThread(A, alpha.threadId);
    eq(await chat.lockThread(B, alpha.threadId, alpha.owner, "zai/glm-5.3-flash", false, true), "missing");
    eq((await sql(`SELECT busy_until FROM maple_chat_threads WHERE id = $1`, [alpha.threadId]))[0].busy_until, null);
  });
}

// ── MCP tools (the connector's and the chat's) ───────────────────────

async function mcpToolChecks(shape: Shape, seed: Seed) {
  const { alpha, beta } = seed;
  const asBeta: Auth = { sub: sub(beta.owner), fam: 2 };
  const asAlpha: Auth = { sub: sub(alpha.owner) };

  await test(`${shape}: a tool call opens only a family the caller is a member of; no fam means family 1`, async () => {
    for (const auth of [{ sub: sub(beta.owner) }, { sub: sub(beta.owner), fam: 1 }, { sub: sub(alpha.owner), fam: 2 }, { sub: sub(beta.owner), fam: "2x" }]) {
      const r = await tool("maple_status", {}, auth);
      eq([r.isError, r.text], [true, NOT_MEMBER_MESSAGE], JSON.stringify(auth));
    }
    const a = await tool("maple_status", {}, asAlpha);
    const b = await tool("maple_status", {}, asBeta);
    ok(!a.isError && a.text.includes("June is") && !a.text.includes("Ro is"), `family 1 reads its baby: ${a.text.slice(0, 80)}`);
    ok(!b.isError && b.text.includes("Ro is") && !b.text.includes("June"), `family 2 reads its baby: ${b.text.slice(0, 80)}`);
  });

  await test(`${shape}: Muse and Grok entries are saved and credited under their own names, and undo_last reaches them`, async () => {
    for (const [via, name] of [["muse", "Muse"], ["grok", "Grok"]] as const) {
      const r = await tool("log_diaper", { diaper: "wet", allow_duplicate: true }, { ...asBeta, via });
      const id = Number(/Saved #(\d+)/.exec(r.text)?.[1]);
      ok(id > 0 && r.text.includes(`via ${name}`), `${via}: ${r.text.slice(0, 120)}`);
      eq((await sql(`SELECT source FROM maple_entries WHERE id = $1`, [id]))[0].source, via);
      const undo = await tool("undo_last", {}, { ...asBeta, via });
      ok(!undo.isError && undo.text.includes(`#${id}`), `${via} undo: ${undo.text.slice(0, 120)}`);
      ok((await entryRow(id)).deleted_at !== null, `${via}: #${id} removed`);
    }
  });

  await test(`${shape}: list_entries shows only the caller's family's entries`, async () => {
    const ids = (r: ToolOut) => [...r.text.matchAll(/"id":(\d+)/g)].map((m) => Number(m[1]));
    const b = ids(await tool("list_entries", { hours: 744, limit: 200 }, asBeta));
    ok(b.length > 0 && b.every((id) => Object.values(beta.entries).includes(id)), `beta's only: ${b}`);
    ok(!ids(await tool("list_entries", { hours: 744, limit: 200 }, asAlpha)).some((id) => Object.values(beta.entries).includes(id)), "alpha sees none of beta's");
  });

  await test(`${shape}: update_entry, delete_entry and restore_entry on another family's entry answer like a missing one and change nothing`, async () => {
    await toolLikeMissing("update_entry", (id) => ({ id, note: "made-up change" }), alpha.entries.diaper, asBeta, "update_entry");
    await toolLikeMissing("delete_entry", (id) => ({ id }), alpha.entries.feed, asBeta, "delete_entry");
    await sql(`UPDATE maple_entries SET deleted_at = NOW() WHERE id = $1`, [alpha.entries.moment]);
    await toolLikeMissing("restore_entry", (id) => ({ id }), alpha.entries.moment, asBeta, "restore_entry");
    const rows = await Promise.all([alpha.entries.diaper, alpha.entries.feed, alpha.entries.moment].map(entryRow));
    eq(rows.map((r) => [r.note, r.deleted_at === null]), [[null, true], [null, true], [null, false]]);
    await sql(`UPDATE maple_entries SET deleted_at = NULL WHERE id = $1`, [alpha.entries.moment]);
  });

  await test(`${shape}: a write through a tool files the row under the caller's family and baby`, async () => {
    const r = await tool("log_diaper", { diaper: "wet", client_ref: "made-up-ref-beta" }, asBeta);
    ok(!r.isError, r.text);
    const id = Number(/Saved #(\d+)/.exec(r.text)?.[1]);
    const row = await entryRow(id);
    eq([row.family_id, Number(row.baby_id)], ["2", beta.babyId]);
  });

  await test(`${shape}: undo_last in family 2 never takes back family 1's entries`, async () => {
    const mine = await tool("log_diaper", { diaper: "dirty" }, asAlpha);
    const id = Number(/Saved #(\d+)/.exec(mine.text)?.[1]);
    await tool("undo_last", {}, asBeta);
    eq((await entryRow(id)).deleted_at, null);
  });

  await test(`${shape}: questions for the doctor and her page stay in their family`, async () => {
    await sql(
      `INSERT INTO maple_entries (family_id, baby_id, kind, started_at, data, note, created_by) VALUES (1, $1, 'note', NOW(), '{"for_doctor":true}', 'Made-up question about June', $2)`,
      [alpha.babyId, alpha.owner]
    );
    ok((await tool("list_doctor_questions", {}, asAlpha)).text.includes("Made-up question about June"), "family 1 sees it");
    ok(!(await tool("list_doctor_questions", {}, asBeta)).text.includes("Made-up question"), "family 2 doesn't");
    const fix = await tool("fix_mom_entry", { id: `c${alpha.care!.doseId}`, action: "delete" }, asBeta);
    ok(fix.isError, `fix_mom_entry: ${fix.text}`);
    eq((await sql(`SELECT deleted_at FROM maple_care_entries WHERE id = $1`, [alpha.care!.doseId]))[0].deleted_at, null);
    const status = await tool("mom_status", {}, asBeta);
    ok(!status.text.includes("Ibuprofen") && !status.text.includes("Dana"), `mom_status in family 2: ${status.text.slice(0, 120)}`);
    const med = await tool("log_medicine", { name: "Ibuprofen" }, asBeta);
    ok(!med.text.includes("Dana"), `log_medicine never names family 1's mom: ${med.text.slice(0, 160)}`);
  });
}

/** Final shape only: the same person in both families, where only family_id keeps their writes apart. */
async function mcpToolsBothFamilies(seed: Seed) {
  const { alpha } = seed;
  const home: Auth = { sub: sub(alpha.owner), fam: 1 };
  const away: Auth = { sub: sub(alpha.owner), fam: 2 };

  await test("final: the same client_ref in another family saves a new entry there, never the other family's", async () => {
    const first = await tool("log_diaper", { diaper: "wet", client_ref: "made-up-ref-shared", allow_duplicate: true }, home);
    const second = await tool("log_diaper", { diaper: "wet", client_ref: "made-up-ref-shared", allow_duplicate: true }, away);
    const [a, b] = [first, second].map((r) => Number(/Saved #(\d+)/.exec(r.text)?.[1]));
    ok(a > 0 && b > 0 && a !== b, `two entries: ${first.text.slice(0, 60)} / ${second.text.slice(0, 60)}`);
    eq([(await entryRow(a)).family_id, (await entryRow(b)).family_id], ["1", "2"]);
    eq(second.sc.deduped ?? false, false);
  });

  await test("final: undo_last in one family never reaches the person's newer write to the other family's mom page", async () => {
    const dose = await tool("log_mom_medicine", { medicine: "Ibuprofen" }, home);
    const cid = /c(\d{8})/.exec(dose.text)?.[1];
    ok(cid, `dose saved: ${dose.text.slice(0, 80)}`);
    const undo = await tool("undo_last", {}, away);
    const removed = Number(/^Removed #(\d+)/.exec(undo.text)?.[1]);
    ok(removed > 0, `undo_last in family 2 takes back that family's own newest entry: ${undo.text.slice(0, 160)}`);
    eq((await entryRow(removed)).family_id, "2");
    eq((await sql(`SELECT deleted_at FROM maple_care_entries WHERE id = $1`, [Number(cid)]))[0].deleted_at, null);
  });
}

// ── the MCP endpoint and its OAuth ───────────────────────────────────

async function mcpPost(token: string, body: unknown): Promise<{ status: number; text: string }> {
  const request = new Request(`${ORIGIN}/api/maple/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  const res = await mcpRoute.POST(request as NextRequest);
  return { status: res.status, text: await res.text() };
}

const access = (s: string, fam?: unknown) => mintAccessToken({ sub: s, ...(fam === undefined ? {} : { fam: fam as number }), scope: "maple", client_id: "made-up-client" });
const statusCall = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "maple_status", arguments: {} } };

async function mcpRouteChecks(shape: Shape, seed: Seed) {
  const { alpha, beta } = seed;

  await test(`${shape}: the MCP endpoint lets a token in only for a member of the family it names`, async () => {
    const turnedAway = [access(sub(beta.owner)), access(sub(beta.owner), 1), access(sub(alpha.owner), 2), access(sub(beta.owner), 3), access("admin", 2)];
    eq(await Promise.all(turnedAway.map(async (t) => (await mcpPost(t, statusCall)).status)), [401, 401, 401, 401, 401]);
    const b = await mcpPost(access(sub(beta.owner), 2), statusCall);
    const a = await mcpPost(access(sub(alpha.owner)), statusCall);
    eq([a.status, b.status], [200, 200]);
    ok(b.text.includes("Ro is") && !b.text.includes("June"), "family 2's token reads family 2");
    ok(a.text.includes("June is") && !a.text.includes("Ro is"), "an old token reads family 1");
  });
}

const VERIFIER = "made-up-pkce-verifier-0123456789-abcdefghijklmnop";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const AUTHORIZE = new URLSearchParams({ client_id: "made-up-client", redirect_uri: REDIRECT, response_type: "code", code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s1" });

async function approve(sessionCookie: string, extra: Record<string, string> = {}): Promise<{ status: number; code: Record<string, unknown> | null; body: string }> {
  const form = new URLSearchParams({ ...Object.fromEntries(AUTHORIZE), maple_consent: "1", ...extra });
  const res = await authorizeRoute.POST(
    req("/oauth/authorize", { method: "POST", headers: { cookie: sessionCookie, "content-type": "application/x-www-form-urlencoded" }, body: form.toString() })
  );
  const to = res.headers.get("location");
  const code = to ? new URL(to).searchParams.get("code") : null;
  return { status: res.status, code: code ? ((verifyAuthCode(code) ?? null) as Record<string, unknown> | null) : null, body: to ? "" : await res.text() };
}

async function tokenPost(params: Record<string, string>): Promise<Record<string, unknown> & { status: number }> {
  const res = await tokenRoute.POST(req("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() }));
  return { status: res.status, ...(await jsonOf(res)) };
}

async function oauthChecks(shape: Shape, seed: Seed) {
  const { alpha, beta } = seed;

  await test(`${shape}: consent mints a code for the session's family, and never for a family the person isn't in`, async () => {
    const b = await approve(cookie(beta.owner, 2));
    eq([b.status, b.code?.sub, b.code?.fam], [302, sub(beta.owner), 2]);
    const a = await approve(cookie(alpha.owner));
    eq([a.status, a.code?.sub, a.code?.fam], [302, sub(alpha.owner), 1]);
    for (const [label, c, extra] of [
      ["an old cookie for a family-2 member", cookie(beta.owner), {}],
      ["a family-2 member picking family 1", cookie(beta.owner, 2), { maple_family: "1" }],
      ["a family-1 cookie naming family 2", cookie(alpha.owner, 2), {}],
    ] as const) {
      const r = await approve(c, extra);
      eq([r.status, r.code], [200, null], label);
      ok(r.body.includes("Please sign in again"), `${label}: sign-in page`);
    }
  });

  await test(`${shape}: a code and a refresh hand out tokens for their own family; membership there is checked again`, async () => {
    const code = mintAuthCode({ client_id: "made-up-client", redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256", scope: "maple", sub: sub(beta.owner), fam: 2 });
    const t = await tokenPost({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: "made-up-client", code_verifier: VERIFIER });
    eq([t.status, verifyAccessToken(String(t.access_token))?.fam], [200, 2]);
    const refresh = (s: string, fam?: number) => mintRefreshToken({ sub: s, ...(fam ? { fam } : {}), scope: "maple", client_id: "made-up-client" });
    const fresh = await tokenPost({ grant_type: "refresh_token", refresh_token: refresh(sub(beta.owner), 2) });
    eq([fresh.status, verifyAccessToken(String(fresh.access_token))?.fam], [200, 2]);
    const old = await tokenPost({ grant_type: "refresh_token", refresh_token: refresh(sub(alpha.owner)) });
    eq([old.status, verifyAccessToken(String(old.access_token))?.fam], [200, 1]);
    for (const [s, fam] of [[sub(beta.owner), undefined], [sub(beta.owner), 1], [sub(alpha.owner), 2]] as const) {
      eq((await tokenPost({ grant_type: "refresh_token", refresh_token: refresh(s, fam) })).error, "invalid_grant", `${s} in ${fam ?? "no family"}`);
    }
  });
}

/** Final shape only: someone in both families picks which one a connection opens. */
async function oauthBothFamilies(seed: Seed) {
  const { alpha } = seed;
  await test("final: someone in both families sees the family picker and gets a code for the one they picked", async () => {
    const page = await authorizeRoute.GET(req(`/oauth/authorize?${AUTHORIZE}`, { headers: { cookie: cookie(alpha.owner) } }));
    const html = await page.text();
    ok(html.includes("Which family?") && html.includes('value="1" checked') && html.includes('value="2"'), "picker with the session's family checked");
    eq((await approve(cookie(alpha.owner), { maple_family: "2" })).code?.fam, 2);
    eq((await approve(cookie(alpha.owner, 2))).code?.fam, 2);
  });
}

// ── Siri, personal tokens and the chat route ─────────────────────────

async function quick(token: string, body: Record<string, unknown>): Promise<{ status: number } & Record<string, unknown>> {
  const res = await quickRoute.POST(req("/api/maple/quick", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, ...(await jsonOf(res)) };
}

async function siriChecks(shape: Shape, seed: Seed) {
  const { alpha, beta } = seed;

  await test(`${shape}: a Siri token logs into and reads its own family only`, async () => {
    const b = await quick(beta.token, { action: "pee" });
    const a = await quick(alpha.token, { action: "poop" });
    eq([b.status, a.status], [200, 200]);
    const [rb, ra] = await Promise.all([entryRow(Number((b.entry as { id: number }).id)), entryRow(Number((a.entry as { id: number }).id))]);
    eq([rb.family_id, Number(rb.baby_id), ra.family_id, Number(ra.baby_id)], ["2", beta.babyId, "1", alpha.babyId]);
    const speak = String((await quick(beta.token, { action: "status" })).speak);
    ok(speak.includes("1 wet and 0 dirty diapers in the last 24 hours"), `family 2's own diapers only: ${speak}`);
    ok(!speak.includes("June") && !speak.includes("Dana"), "never family 1's baby or mom");
  });

  await test(`${shape}: her medicines by Siri stay in her family; a family without her page hears so`, async () => {
    const b = await quick(beta.token, { action: "mom_status" });
    eq(b.status, 404);
    ok(!JSON.stringify(b).includes("Ibuprofen"), "nothing of family 1's");
    const a = await quick(alpha.token, { action: "mom_status" });
    eq(a.status, 200);
    ok(JSON.stringify(a.plans).includes(`p${alpha.care!.medId}`), "family 1 still hears its own");
  });

  await test(`${shape}: a token row filed under a family its member isn't in opens nothing`, async () => {
    const token = "maple_madeUpMisfiledToken0123456789";
    await sql(`INSERT INTO maple_tokens (family_id, member, token_hash, label) VALUES (1, $1, $2, 'Made-up')`, [beta.owner, createHash("sha256").update(token).digest("hex")]);
    eq((await quick(token, { action: "status" })).status, 401);
  });
}

async function tokensRouteChecks(shape: Shape, seed: Seed) {
  const { alpha, beta } = seed;
  const asBeta = { cookie: cookie(beta.owner, 2) };

  await test(`${shape}: personal tokens are listed, made and revoked in the session's family only`, async () => {
    const list = await jsonOf(await tokensRoute.GET(req("/api/maple/tokens", { headers: asBeta })));
    eq((list.tokens as { id: number }[]).map((t) => t.id), [beta.tokenId]);
    await tokensRoute.DELETE(req(`/api/maple/tokens?id=${alpha.tokenId}`, { method: "DELETE", headers: asBeta }));
    eq((await sql(`SELECT revoked_at FROM maple_tokens WHERE id = $1`, [alpha.tokenId]))[0].revoked_at, null);
    const made = await jsonOf(await tokensRoute.POST(req("/api/maple/tokens", { method: "POST", headers: { ...asBeta, "content-type": "application/json" }, body: "{}" })));
    const id = (made.record as { id: number }).id;
    eq((await sql(`SELECT family_id, member FROM maple_tokens WHERE id = $1`, [id]))[0], { family_id: "2", member: beta.owner });
  });
}

const userMessage = (threadId: string) => JSON.stringify({ threadId, message: { id: "x", role: "user", parts: [{ type: "text", text: "How many made-up diapers today?" }] } });

async function chatRouteChecks(shape: Shape, seed: Seed) {
  const { alpha, beta } = seed;
  const asBeta = { cookie: cookie(beta.owner, 2) };

  await test(`${shape}: the chat route answers another family's thread like a missing one`, async () => {
    const list = await jsonOf(await chatRoute.GET(req("/api/maple/chat", { headers: asBeta })));
    eq([(list.current as { id: string } | null)?.id, (list.items as StreamItem[]).map((i) => i.thread)], [beta.threadId, [beta.threadId]]);
    eq((await jsonOf(await chatRoute.GET(req(`/api/maple/chat?before=${alpha.messageId}`, { headers: asBeta })))).items, []);
    const posted = await chatRoute.POST(req("/api/maple/chat", { method: "POST", headers: { ...asBeta, "content-type": "application/json" }, body: userMessage(alpha.threadId) }));
    eq(posted.status, 404);
    eq((await sql(`SELECT COUNT(*)::int AS n, bool_and(busy_until IS NULL) AS free FROM maple_chat_threads WHERE id = $1`, [alpha.threadId]))[0], { n: 1, free: true });
  });

  await test(`${shape}: a family over its chat budget is refused; the other family's budget is untouched`, async () => {
    await sql(`UPDATE maple_families SET ai_daily_micro = 100 WHERE id = 2`);
    await sql(`INSERT INTO maple_ai_usage (family_id, member, step, model, cost_micro_usd, price_key) VALUES (2, $1, 1, 'zai/glm-5.3-flash', 1000, 'zai/glm-5.3-flash')`, [beta.owner]);
    const b = await chatRoute.POST(req("/api/maple/chat", { method: "POST", headers: { ...asBeta, "content-type": "application/json" }, body: userMessage("thread_beta_made_up_2") }));
    eq([b.status, (await jsonOf(b)).code], [429, "limit"]);
    const a = await chatRoute.POST(req("/api/maple/chat", { method: "POST", headers: { cookie: cookie(alpha.owner), "content-type": "application/json" }, body: userMessage(beta.threadId) }));
    eq(a.status, 404);
    await sql(`UPDATE maple_families SET ai_daily_micro = NULL WHERE id = 2`);
  });

  await test(`${shape}: Delete chat history removes this member's chat in the session's family only`, async () => {
    eq((await chatRoute.DELETE(req("/api/maple/chat", { method: "DELETE", headers: asBeta }))).status, 200);
    eq((await sql(`SELECT id FROM maple_chat_threads WHERE id IN ($1, $2)`, [alpha.threadId, beta.threadId])).map((r) => r.id), [alpha.threadId]);
    eq((await sql(`SELECT id FROM maple_chat_messages WHERE id = $1`, [alpha.messageId])).length, 1);
  });
}

async function bothFamiliesRouteChecks(seed: Seed) {
  const { alpha } = seed;
  await test("final: someone in both families sees each family's chats only under its own session", async () => {
    const away = { cookie: cookie(alpha.owner, 2) };
    eq(await jsonOf(await chatRoute.GET(req("/api/maple/chat", { headers: away }))), { current: null, items: [], more: false });
    const home = await jsonOf(await chatRoute.GET(req("/api/maple/chat", { headers: { cookie: cookie(alpha.owner, 1) } })));
    eq([(home.current as { id: string } | null)?.id, (home.items as StreamItem[]).map((i) => i.thread)], [alpha.threadId, [alpha.threadId]]);
    eq((await chatRoute.DELETE(req("/api/maple/chat", { method: "DELETE", headers: away }))).status, 200);
    eq((await sql(`SELECT id FROM maple_chat_messages WHERE id = $1`, [alpha.messageId])).length, 1, "a delete in their other family leaves this one's chat");
    await sql(`INSERT INTO maple_consents (family_id, member, kind, version) VALUES (2, $1, 'chat', 2)`, [alpha.owner]);
    await sql(`UPDATE maple_chat_threads SET busy_until = NOW() + INTERVAL '1 minute' WHERE id = $1`, [alpha.threadId]);
    const posted = await chatRoute.POST(req("/api/maple/chat", { method: "POST", headers: { ...away, "content-type": "application/json" }, body: userMessage(alpha.threadId) }));
    await sql(`UPDATE maple_chat_threads SET busy_until = NULL WHERE id = $1`, [alpha.threadId]);
    eq(posted.status, 404, "their other family's busy thread reads as missing, not busy");
  });
}

// ── run ───────────────────────────────────────────────────────────────

/** Before any other family: a cost row the code from before families wrote (no family) is family 1's spend. */
async function unfiledSpend(shape: Shape) {
  await test(`${shape}: a cost row without a family counts for family 1 while it's the only family, and for nobody once another exists`, async () => {
    await freshDb({ shape });
    const since = new Date("2026-01-01T00:00:00Z");
    const row = (fam: number | null, cost: number, thread: string | null = null) =>
      sql(
        `INSERT INTO maple_ai_usage (family_id, member, thread_id, step, model, input_tokens, cost_micro_usd, price_key) VALUES ($1, 'made-up@example.com', $2, 1, 'zai/glm-5.3-flash', $3, $4, 'zai/glm-5.3-flash')`,
        [fam, thread, cost * 10, cost]
      );
    await row(1, 100);
    await row(null, 25, "thread_unfiled_made_up");
    const spent = async (fam: number) => {
      const u = await chat.usageSince({ familyId: fam }, "made-up@example.com", "2026-10-20", since, since);
      return [String(u.day), String(u.month)];
    };
    eq(await spent(1), ["125", "125"], "family 1 alone");
    await sql(`INSERT INTO maple_chat_threads (family_id, id, member, model) VALUES (1, 'thread_unfiled_made_up', 'made-up@example.com', 'zai/glm-5.3-flash')`);
    const locked = await chat.lockThread({ familyId: 1 }, "thread_unfiled_made_up", "made-up@example.com", "zai/glm-5.3-flash", false, false);
    eq(typeof locked === "object" ? locked.lastPrompt : locked, 250, "its thread's last prompt");
    await sql(`INSERT INTO maple_families (name, timezone, status, created_by) VALUES ('Family Beta', 'America/Los_Angeles', 'active', 'made-up')`);
    eq([await spent(1), await spent(2)], [["100", "100"], ["0", "0"]], "once family 2 exists");
  });
}

async function main() {
  await unfiledSpend("production");
  await unfiledSpend("final");
  for (const shape of ["production", "final"] as const) {
    await freshDb({ shape });
    const seed = await seedFamilies();
    await chatStoreChecks(shape, seed);
    await mcpToolChecks(shape, seed);
    await mcpRouteChecks(shape, seed);
    await oauthChecks(shape, seed);
    await siriChecks(shape, seed);
    await tokensRouteChecks(shape, seed);
    await chatRouteChecks(shape, seed);
    if (shape === "final") {
      await sql(`INSERT INTO maple_members (family_id, email, role, display_name, accepted_at) VALUES (2, $1, 'member', 'Avery', NOW())`, [seed.alpha.owner]);
      await chatStoreBothFamilies(seed);
      await mcpToolsBothFamilies(seed);
      await oauthBothFamilies(seed);
      await bothFamiliesRouteChecks(seed);
    }
  }
}

main()
  .then(() => done("assistants.check.ts"))
  .then(() => process.exit(0));
