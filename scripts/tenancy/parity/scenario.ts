import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { query } from "../../../src/lib/db";
import { migrate } from "../../../src/lib/migrate";
import { encryptSecret } from "../../../src/lib/secret-box";

/**
 * Family 1's routes, before and after: run by scripts/tenancy/parity/run.ts
 * in two trees (the code before families and this one) on the same made-up
 * family-1 data, with the clock frozen (clock.mjs) and web-push stubbed.
 * Seeds exactly what the code before families writes (no family_id), then
 * calls the app's routes, Siri, the MCP tools and the push tick as family 1's
 * people would, and writes every answer, notice and table to argv[2].
 */
for (const k of Object.keys(process.env)) if (/^(QSTASH|VAPID|NEXT_PUBLIC_POSTHOG|MAPLE_|BLOB|VERCEL)/.test(k)) delete process.env[k];
process.env.DATABASE_URL = "pglite:parity";
process.env.GOOGLE_CLIENT_SECRET = "parity-made-up-session-secret";
process.env.MCP_SECRET = "parity-made-up-mcp-secret";
process.env.ADMIN_USER = "parity-admin";
process.env.ADMIN_PASS = "parity-admin-pass";

const OUT = process.argv[2];
const T0 = Date.now();
const ago = (min: number) => new Date(T0 - min * 60_000).toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const OWNER = "owner.one@example.com";
const OWNER2 = "owner.two@example.com";
const MEMBER = "grandparent@example.com";
const VIEWER = "viewer@example.com";
const SIRI = "maple_paritySiriTokenMadeUp0123456789ab";

async function sql(text: string, params: unknown[] = []) {
  const r = await query(text, params);
  if (!r) throw new Error("no db");
  return r as Record<string, unknown>[];
}

async function seed() {
  // Exactly what the code before families writes: no family_id anywhere.
  const [b] = await sql(
    `INSERT INTO maple_babies (name, nickname, sex, due_date, born_at, timezone, settings, created_at, updated_at)
     VALUES ('Maple Jane', 'Maple', 'female', '2026-10-20', $1, 'America/New_York', '{"show_alerts": true}', $2, $2) RETURNING id`,
    [ago(60 * 24 * 6), ago(60 * 24 * 30)]
  );
  const baby = b.id;
  const people: [string, string, string][] = [
    [OWNER, "owner", "Matt"],
    [OWNER2, "owner", "Brittany"],
    [MEMBER, "member", "Grandma"],
    [VIEWER, "viewer", "Neighbor"],
  ];
  for (const [i, [email, role, name]] of people.entries()) {
    await sql(`INSERT INTO maple_members (email, role, display_name, added_by, added_at, updated_at) VALUES ($1, $2, $3, 'self', $4, $4)`, [email, role, name, ago(60 * 24 * 20 - i)]);
  }
  const entry = (kind: string, start: number, end: number | null, data: unknown, by = OWNER) =>
    sql(
      `INSERT INTO maple_entries (baby_id, kind, started_at, ended_at, data, created_by, created_at, updated_at, source) VALUES ($1, $2, $3, $4, $5, $6, $3, $3, 'web')`,
      [baby, kind, ago(start), end === null ? null : ago(end), JSON.stringify(data), by]
    );
  await entry("diaper", 30, null, { pee: true, poop: true, stool_color: "yellow" });
  await entry("diaper", 200, null, { pee: true }, OWNER2);
  await entry("diaper", 400, null, { pee: true }, MEMBER);
  await entry("feed", 180, 150, { segments: [{ side: "L", start: ago(180), end: ago(165) }, { side: "R", start: ago(165), end: ago(150) }], last_side: "R" }, OWNER2);
  await entry("feed", 360, 330, { segments: [{ side: "R", start: ago(360), end: ago(330) }], last_side: "R" }, OWNER2);
  await entry("feed", 90, null, { method: "bottle", amount_ml: 60 });
  await entry("sleep", 140, 100, {});
  await entry("growth", 60 * 24 * 2, null, { weight_g: 3350, length_cm: 50.5, head_cm: 34.5 });
  await entry("temp", 120, null, { temp_c: 37.0, method: "axillary" });
  await entry("note", 50, null, { text: "Sleepy after the bath" });
  await entry("med", 300, null, { name: "Vitamin D", dose: "400 IU" });
  await entry("moment", 60 * 24, null, { title: "First bath", photos: [{ key: "https://madeup.private.blob.vercel-storage.com/maple/moments/firstbath-abcdefgh-x1y2.jpg", access: "private" }] });
  await sql(`INSERT INTO maple_care_people (member, created_by, created_at, updated_at) VALUES ('Brittany', $1, $2, $2)`, [OWNER, ago(60 * 24 * 6)]);
  await sql(
    `INSERT INTO maple_care_meds (id, person, name, schedule, created_by, created_at, updated_at) VALUES (10000001, 'Brittany', 'Ibuprofen', '{"type":"every","every_min":360}', $1, $2, $2)`,
    [OWNER, ago(60 * 24 * 5)]
  );
  await sql(
    `INSERT INTO maple_care_entries (id, person, kind, med_id, at, data, created_by, created_at, updated_at) VALUES (10000002, 'Brittany', 'dose', 10000001, $1, '{}', $2, $1, $1)`,
    [ago(355), OWNER2]
  );
  await sql(`INSERT INTO maple_tokens (member, token_hash, label, created_at) VALUES ($1, $2, 'Made-up iPhone', $3)`, [OWNER, sha(SIRI), ago(60 * 24 * 3)]);
  await sql(`INSERT INTO maple_consents (member, kind, version, accepted_at) VALUES ($1, 'chat', 1, $2)`, [OWNER, ago(60 * 24)]);
  const thread = (id: string, member: string, at: number, viewerOnly = false) =>
    sql(`INSERT INTO maple_chat_threads (id, member, title, model, viewer_only, created_at, updated_at) VALUES ($1, $2, 'Made-up chat', 'zai/glm-5.3-flash', $3, $4, $4)`, [id, member, viewerOnly, ago(at)]);
  const message = (id: string, threadId: string, member: string, seq: number, role: "user" | "assistant", text: string, at: number) =>
    sql(`INSERT INTO maple_chat_messages (id, thread_id, member, seq, role, parts, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7)`, [
      id,
      threadId,
      member,
      seq,
      role,
      JSON.stringify([{ type: "text", text }]),
      ago(at),
    ]);
  await thread("parity-thread-old", OWNER, 60 * 30);
  await message("parity-m1", "parity-thread-old", OWNER, 1, "user", "How many made-up diapers today?", 60 * 30);
  await message("parity-m2", "parity-thread-old", OWNER, 2, "assistant", "Three so far.", 60 * 30 - 1);
  await thread("parity-thread-new", OWNER, 20);
  await message("parity-m3", "parity-thread-new", OWNER, 1, "user", "Which side next?", 20);
  await message("parity-m4", "parity-thread-new", OWNER, 2, "assistant", "The left.", 19);
  await thread("parity-thread-viewer", VIEWER, 40, true);
  await message("parity-m5", "parity-thread-viewer", VIEWER, 1, "user", "When did she last eat?", 40);
}

const cookieFor = (id: string) => encryptSecret(JSON.stringify({ id, iat: Date.now() }));

type H = (r: NextRequest) => Promise<Response>;
let lastSession: string | null = null;
const queue: (() => Promise<void>)[] = [];
const sends: { endpoint: string; payload: unknown }[] = [];
async function drain() {
  while (queue.length) await queue.shift()!();
  const got = sends.splice(0);
  return got.length ? got : undefined;
}
const out: Record<string, unknown> = {};

async function call(label: string, h: H, method: string, path: string, opts: { as?: string; body?: unknown; headers?: Record<string, string>; session?: string } = {}) {
  const req = new NextRequest(new URL(path, "http://localhost:3000"), {
    method,
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9", ...(opts.headers ?? {}) },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const session = opts.session ?? (opts.as ? cookieFor(opts.as) : undefined);
  if (session) req.cookies.set("maple_session", session);
  let res: Response;
  try {
    res = await h(req);
  } catch (err) {
    out[label] = { threw: String(err) };
    return null;
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  const sc = res.headers.get("set-cookie");
  const m = sc ? /maple_session=([^;]+)/.exec(sc) : null;
  if (m) lastSession = decodeURIComponent(m[1]);
  out[label] = { status: res.status, body, setCookie: sc ? "set" : null, sent: await drain() };
  return body as Record<string, unknown>;
}

async function tool(label: string, name: string, args: Record<string, unknown>, sub: string) {
  const { registrations } = await import("../../../src/lib/maple/chat/tools");
  const r = registrations().all.find((x) => x.name === name);
  if (!r) {
    out[label] = { missing: name };
    return;
  }
  const extra = {
    signal: new AbortController().signal,
    requestId: "parity",
    authInfo: { token: "parity", clientId: "parity", scopes: ["maple"], extra: { via: "claude", sub } },
    sendNotification: async () => {},
    sendRequest: async () => {
      throw new Error("unsupported");
    },
  };
  try {
    const res = await r.handler(args as never, extra as never);
    out[label] = { text: res.content.flatMap((c: { type: string; text?: string }) => (c.type === "text" ? [c.text] : [])).join("\n"), isError: res.isError === true, sc: res.structuredContent ?? null };
  } catch (err) {
    out[label] = { threw: String(err) };
  }
}

async function main() {
  const log = console.log;
  console.log = () => {};
  await migrate();
  console.log = log;
  await seed();
  const { createRequire } = await import("node:module");
  const req = createRequire(process.cwd() + "/package.json");
  const wp = req("web-push");
  wp.sendNotification = async (sub: { endpoint: string }, payload: string) => {
    sends.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    return { statusCode: 201, body: "", headers: {} };
  };
  const hooks = await import("../../../src/lib/maple/push-hooks");
  hooks.setLaterRunner((t) => queue.push(t));

  const state = (await import("../../../src/app/api/maple/state/route")).GET as H;
  const entries = await import("../../../src/app/api/maple/entries/route");
  const timer = await import("../../../src/app/api/maple/timer/route");
  const me = (await import("../../../src/app/api/maple/auth/me/route")).GET as H;
  const members = await import("../../../src/app/api/maple/members/route");
  const invites = await import("../../../src/app/api/maple/invites/route");
  const tokens = await import("../../../src/app/api/maple/tokens/route");
  const consent = await import("../../../src/app/api/maple/chat/consent/route");
  const exportCsv = (await import("../../../src/app/api/maple/export/route")).GET as H;
  const careEntries = await import("../../../src/app/api/maple/care/entries/route");
  const quick = (await import("../../../src/app/api/maple/quick/route")).POST as H;
  const password = (await import("../../../src/app/api/maple/auth/password/route")).POST as H;
  const push = await import("../../../src/app/api/maple/push/route");
  const baby = await import("../../../src/app/api/maple/baby/route");

  await call("me.owner", me, "GET", "/api/maple/auth/me", { as: OWNER });
  await call("me.none", me, "GET", "/api/maple/auth/me");
  await call("me.stranger", me, "GET", "/api/maple/auth/me", { as: "stranger@example.com" });
  const s1 = await call("state.owner", state, "GET", "/api/maple/state", { as: OWNER });
  await call("state.owner2", state, "GET", "/api/maple/state", { as: OWNER2 });
  await call("state.viewer", state, "GET", "/api/maple/state", { as: VIEWER });
  await call("state.member", state, "GET", "/api/maple/state", { as: MEMBER });
  await call("state.unchanged", state, "GET", `/api/maple/state?rev=${encodeURIComponent(String(s1?.rev ?? ""))}`, { as: OWNER });
  await call("entries.list", entries.GET as H, "GET", `/api/maple/entries?from=${encodeURIComponent(ago(600))}`, { as: OWNER });
  await call("entries.viewer.post", entries.POST as H, "POST", "/api/maple/entries", { as: VIEWER, body: { kind: "diaper", started_at: ago(1), data: { pee: true } } });
  await call("entries.post", entries.POST as H, "POST", "/api/maple/entries", { as: OWNER, body: { kind: "diaper", started_at: ago(5), data: { pee: true }, client_id: "parity-c1" } });
  await call("entries.post.again", entries.POST as H, "POST", "/api/maple/entries", { as: OWNER, body: { kind: "diaper", started_at: ago(5), data: { pee: true }, client_id: "parity-c1" } });
  const started = await call("timer.start", timer.POST as H, "POST", "/api/maple/timer", { as: OWNER2, body: { action: "start", kind: "feed", side: "L", at: ago(12) } });
  const fid = (started?.entry as { id?: number } | undefined)?.id;
  await call("timer.switch", timer.POST as H, "POST", "/api/maple/timer", { as: OWNER2, body: { action: "switch", id: fid, side: "R", at: ago(6) } });
  await call("state.running", state, "GET", "/api/maple/state", { as: OWNER });
  await call("timer.stop", timer.POST as H, "POST", "/api/maple/timer", { as: OWNER2, body: { action: "stop", id: fid, at: ago(2) } });
  await call("members.get", members.GET as H, "GET", "/api/maple/members", { as: OWNER });
  await call("invites.get", invites.GET as H, "GET", "/api/maple/invites", { as: OWNER });
  await call("tokens.get", tokens.GET as H, "GET", "/api/maple/tokens", { as: OWNER });
  await call("consent.get", consent.GET as H, "GET", "/api/maple/chat/consent", { as: OWNER });
  await call("consent.get.member", consent.GET as H, "GET", "/api/maple/chat/consent", { as: MEMBER });
  const chat = await import("../../../src/app/api/maple/chat/route");
  await call("chat.get.owner", chat.GET as H, "GET", "/api/maple/chat", { as: OWNER });
  await call("chat.get.owner.before", chat.GET as H, "GET", "/api/maple/chat?before=parity-m3", { as: OWNER });
  await call("chat.get.viewer", chat.GET as H, "GET", "/api/maple/chat", { as: VIEWER });
  await call("chat.get.owner2", chat.GET as H, "GET", "/api/maple/chat", { as: OWNER2 });
  await call("chat.post.noterms", chat.POST as H, "POST", "/api/maple/chat", {
    as: MEMBER,
    body: { threadId: "parity-thread-member", message: { id: "parity-u1", role: "user", parts: [{ type: "text", text: "Log a wet diaper" }] } },
  });
  await call("chat.delete.member", chat.DELETE as H, "DELETE", "/api/maple/chat", { as: MEMBER });
  await call("chat.get.owner.kept", chat.GET as H, "GET", "/api/maple/chat", { as: OWNER });
  await call("chat.delete.owner", chat.DELETE as H, "DELETE", "/api/maple/chat", { as: OWNER });
  await call("chat.get.owner.deleted", chat.GET as H, "GET", "/api/maple/chat", { as: OWNER });
  await call("chat.get.viewer.kept", chat.GET as H, "GET", "/api/maple/chat", { as: VIEWER });
  await call("export", exportCsv, "GET", "/api/maple/export", { as: OWNER });
  await call("push.get", push.GET as H, "GET", "/api/maple/push", { as: OWNER });
  const phone = (n: string) => ({ endpoint: `https://push.example.test/parity-${n}-0123456789`, keys: { p256dh: `made-up-p256dh-${n}`, auth: `made-up-auth-${n}` } });
  const prefs = { meds: true, ok: true, at: true, logged: true, nursing: true };
  await call("push.sub.owner", push.POST as H, "POST", "/api/maple/push", { as: OWNER, body: { subscription: phone("a"), prefs, device: "Phone A" }, headers: { "X-Maple-Device": "dev-a-0123456789abcdef" } });
  await call("push.sub.owner2", push.POST as H, "POST", "/api/maple/push", { as: OWNER2, body: { subscription: phone("b"), prefs, device: "Phone B" }, headers: { "X-Maple-Device": "dev-b-0123456789abcdef" } });
  await call("push.sub.viewer", push.POST as H, "POST", "/api/maple/push", { as: VIEWER, body: { subscription: phone("v"), prefs, device: "Phone V" }, headers: { "X-Maple-Device": "dev-v-0123456789abcdef" } });
  await call("push.get.owner", push.GET as H, "GET", `/api/maple/push?endpoint=${encodeURIComponent(phone("a").endpoint)}`, { as: OWNER });
  process.env.CRON_SECRET = "parity-made-up-cron";
  const tick = await import("../../../src/app/api/maple/push/tick/route");
  await call("push.tick", tick.POST as H, "POST", "/api/maple/push/tick?via=daily", { headers: { authorization: "Bearer parity-made-up-cron" } });
  (globalThis as { __clockOffset?: number }).__clockOffset = 7 * 60_000;
  await call("push.tick.later", tick.POST as H, "POST", "/api/maple/push/tick?via=daily", { headers: { authorization: "Bearer parity-made-up-cron" } });
  await call("state.later", state, "GET", "/api/maple/state", { as: OWNER });
  (globalThis as { __clockOffset?: number }).__clockOffset = 0;
  await call("push.tick.again", tick.POST as H, "POST", "/api/maple/push/tick?via=daily", { headers: { authorization: "Bearer parity-made-up-cron" } });
  await call("care.entries", careEntries.GET as H, "GET", "/api/maple/care/entries", { as: OWNER2 });
  await call("care.entries.viewer", careEntries.GET as H, "GET", "/api/maple/care/entries", { as: VIEWER });
  await call("care.dose", careEntries.POST as H, "POST", "/api/maple/care/entries", { as: OWNER, body: { kind: "dose", med_id: 10000001, at: ago(3), data: {}, client_id: "parity-dose-1" }, headers: { "X-Maple-Device": "dev-a-0123456789abcdef" } });
  await call("care.dose.again", careEntries.POST as H, "POST", "/api/maple/care/entries", { as: OWNER, body: { kind: "dose", med_id: 10000001, at: ago(3), data: {}, client_id: "parity-dose-1" } });
  await call("push.tick.after", tick.POST as H, "POST", "/api/maple/push/tick?via=daily", { headers: { authorization: "Bearer parity-made-up-cron" } });
  await call("baby.patch", baby.PATCH as H, "PATCH", "/api/maple/baby", { as: OWNER, body: { settings: { show_alerts: true } } });
  const siri = { authorization: `Bearer ${SIRI}` };
  await call("quick.status", quick, "POST", "/api/maple/quick", { headers: siri, body: { action: "status" } });
  await call("quick.pee", quick, "POST", "/api/maple/quick", { headers: siri, body: { action: "pee", client_id: "q1" } });
  await call("quick.sleep", quick, "POST", "/api/maple/quick", { headers: siri, body: { action: "sleep", client_id: "q2" } });
  await call("quick.mom_status", quick, "POST", "/api/maple/quick", { headers: siri, body: { action: "mom_status" } });
  await call("quick.badtoken", quick, "POST", "/api/maple/quick", { headers: { authorization: "Bearer maple_nope" }, body: { action: "status" } });
  await tool("mcp.maple_status", "maple_status", {}, `maple:${OWNER}`);
  await tool("mcp.list_entries", "list_entries", { hours: 12 }, `maple:${OWNER}`);
  await tool("mcp.daily_summary", "daily_summary", {}, `maple:${OWNER}`);
  await tool("mcp.mom_status", "mom_status", {}, `maple:${OWNER}`);
  await tool("mcp.log_diaper", "log_diaper", { diaper: "wet", client_ref: "mcp-1" }, `maple:${MEMBER}`);
  await tool("mcp.undo_last", "undo_last", {}, `maple:${MEMBER}`);
  await tool("mcp.stranger", "maple_status", {}, `maple:stranger@example.com`);
  await tool("mcp.admin", "maple_status", {}, `admin`);
  await tool("mcp.start_timer", "start_timer", { timer: "nursing", side: "left" }, `maple:${OWNER}`);
  await tool("mcp.switch_side", "switch_side", {}, `maple:${OWNER}`);
  await tool("mcp.stop_timer", "stop_timer", { timer: "nursing" }, `maple:${OWNER}`);
  out["mcp.sent"] = await drain();
  await tool("mcp.log_mom_medicine", "log_mom_medicine", { medicine: "Ibuprofen" }, `maple:${OWNER2}`);
  out["mcp.mom.sent"] = await drain();
  const inv = await call("invites.post", invites.POST as H, "POST", "/api/maple/invites", { as: OWNER, body: { display_name: "Aunt", role: "member" } });
  const tok = String((inv?.url as string | undefined) ?? "").split("#")[1] ?? "";
  if (inv) inv.url = "<masked>";
  const join = (await import("../../../src/app/api/maple/auth/join/route")).POST as H;
  lastSession = null;
  await call("join", join, "POST", "/api/maple/auth/join", { body: { token: tok } });
  const joined = lastSession;
  await call("state.invitee", state, "GET", "/api/maple/state", { session: joined ?? "none" });
  await call("join.again", join, "POST", "/api/maple/auth/join", { body: { token: tok } });
  await call("members.add", members.POST as H, "POST", "/api/maple/members", { as: OWNER, body: { email: "New.Person@Example.com" } });
  await call("members.remove", members.DELETE as H, "DELETE", `/api/maple/members?email=${encodeURIComponent(MEMBER)}`, { as: OWNER });
  await call("state.removed", state, "GET", "/api/maple/state", { as: MEMBER });
  await tool("mcp.removed", "maple_status", {}, `maple:${MEMBER}`);
  const auth = await import("../../../src/lib/maple/auth");
  process.env.MAPLE_ALLOWED_EMAILS = "allowed.one@example.com";
  for (const [k, email] of [["g.owner", OWNER], ["g.allowed", "allowed.one@example.com"], ["g.stranger", "stranger@example.com"], ["g.removed", MEMBER], ["g.added", "new.person@example.com"]]) {
    const r = (await auth.joinWithGoogle({ email, name: "Made Up", sub: "x" } as never)) as { member: unknown; reason?: string };
    out[k] = { member: r.member, reason: r.reason ?? null };
  }
  delete process.env.MAPLE_ALLOWED_EMAILS;
  lastSession = null;
  await call("password", password, "POST", "/api/maple/auth/password", { body: { username: "parity-admin", password: "parity-admin-pass" } });
  await call("state.admin", state, "GET", "/api/maple/state", { session: lastSession ?? "none" });
  await call("tokens.admin", tokens.GET as H, "GET", "/api/maple/tokens", { session: lastSession ?? "none" });
  await call("state.final", state, "GET", "/api/maple/state", { as: OWNER });

  const tables = (await sql(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname LIKE 'maple_%' ORDER BY 1`)).map((r) => String(r.relname));
  const db: Record<string, unknown> = {};
  for (const t of tables) db[t] = await sql(`SELECT * FROM ${t} ORDER BY 1`);
  writeFileSync(OUT, JSON.stringify({ out, db }, null, 1));
  console.log("wrote", OUT, Object.keys(out).length, "calls");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
