import { NextRequest } from "next/server";
import { done, eq, freshDb, ok, seedFamilies, sql, test } from "./harness";

/**
 * What keeps other families' sign-ups bounded: a family still in onboarding
 * reaches only its setup, its photos have a quota, an abandoned one is
 * deleted, every family but the Brookers shares one monthly chat ceiling and
 * can be paused, and the crisis check knows each family's own baby's name.
 * Family 1 is never limited by any of it. Made-up families only; no model
 * runs (every chat here is turned away before one would).
 */

process.env.MCP_SECRET = "made-up-limits-secret";
process.env.GOOGLE_CLIENT_SECRET = "made-up-limits-session";
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.MAPLE_CHAT_GLOBAL_MONTHLY_MICRO;

const BASE = "http://localhost:3000";

async function main() {
  const auth = await import("../../src/lib/maple/auth");
  const { resolveFamily } = await import("../../src/lib/maple/family");
  const { FAMILY_TABLES } = await import("../../src/lib/maple/family-tables");
  const { CLEANUP_ORDER, deleteAbandonedFamilies } = await import("../../src/lib/maple/family/cleanup");
  const { claimUpload, FAMILY_UPLOAD_LIMITS } = await import("../../src/lib/maple/upload-quota");
  const { chatBudget } = await import("../../src/lib/maple/chat/store");
  const { GLOBAL_MONTHLY_DEFAULT } = await import("../../src/lib/maple/chat/caps");
  const { answerOnboardingChat, familyChatDeps } = await import("../../src/lib/maple/onboarding/chat");
  const { mentionsCrisis } = await import("../../src/lib/maple/chat/crisis");
  const { answerPost } = await import("../../src/lib/maple/chat/post");
  const { connectionKey, FAMILY_BUCKET } = await import("../../src/lib/maple/family/limits");
  const { familyPostDeps } = await import("../../src/lib/maple/chat/family-deps");
  const routes = {
    state: await import("../../src/app/api/maple/state/route"),
    entries: await import("../../src/app/api/maple/entries/route"),
    chat: await import("../../src/app/api/maple/chat/route"),
    upload: await import("../../src/app/api/maple/upload/route"),
    members: await import("../../src/app/api/maple/members/route"),
    tokens: await import("../../src/app/api/maple/tokens/route"),
    exportCsv: await import("../../src/app/api/maple/export/route"),
    onboarding: await import("../../src/app/api/maple/onboarding/route"),
    consent: await import("../../src/app/api/maple/chat/consent/route"),
    push: await import("../../src/app/api/maple/push/route"),
  };
  const call = async (handler: (r: NextRequest) => Promise<Response>, path: string, id: string, fam: number, method = "GET", body?: unknown) => {
    const res = await handler(
      new NextRequest(new URL(path, BASE), {
        method,
        headers: { cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.sealSession(id, fam))}`, "content-type": "application/json", "x-real-ip": "203.0.113.9" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    );
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      json = { text };
    }
    return { status: res.status, body: json };
  };

  await freshDb({ shape: "final" });
  const seed = await seedFamilies();
  const { beta } = seed;
  const [setup] = await sql(`INSERT INTO maple_families (timezone, status, created_by) VALUES ('America/Denver', 'onboarding', 'setting.up@example.com') RETURNING id`);
  const SETUP = Number(setup.id);
  await sql(`INSERT INTO maple_members (family_id, email, role, display_name, added_by, accepted_at) VALUES ($1, 'setting.up@example.com', 'owner', 'Setting Up', 'signup', NOW())`, [SETUP]);

  await test("a family still in onboarding reaches its setup and nothing else", async () => {
    const who = "setting.up@example.com";
    const refused = [
      await call(routes.state.GET, "/api/maple/state", who, SETUP),
      await call(routes.entries.POST, "/api/maple/entries", who, SETUP, "POST", { kind: "diaper", data: { pee: true } }),
      await call(routes.chat.POST, "/api/maple/chat", who, SETUP, "POST", { threadId: "thread_setup_made_up", message: { id: "x", role: "user", parts: [{ type: "text", text: "hi" }] } }),
      await call(routes.upload.GET, "/api/maple/upload", who, SETUP),
      await call(routes.members.POST, "/api/maple/members", who, SETUP, "POST", { email: "someone@example.com" }),
      await call(routes.tokens.POST, "/api/maple/tokens", who, SETUP, "POST", {}),
      await call(routes.exportCsv.GET, "/api/maple/export", who, SETUP),
    ];
    eq(refused.map((r) => [r.status, r.body.code]), refused.map(() => [403, "onboarding"]));
    eq((await call(routes.onboarding.GET, "/api/maple/onboarding", who, SETUP)).status, 200, "its setup");
    eq((await call(routes.consent.GET, "/api/maple/chat/consent", who, SETUP)).status, 200, "the chat's terms");
    eq((await call(routes.push.GET, "/api/maple/push", who, SETUP)).status, 200, "notifications");
    eq((await call(routes.state.GET, "/api/maple/state", beta.owner, 2)).status, 200, "a set-up family is unaffected");
    const mcpRoute = await import("../../src/app/api/maple/[transport]/route");
    const { mintAccessToken } = await import("../../src/lib/mcp/auth");
    const token = mintAccessToken({ sub: `maple:${who}`, fam: SETUP, scope: "maple", client_id: "made-up-client" });
    const res = await mcpRoute.POST(
      new NextRequest("http://localhost/api/maple/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "maple_status", arguments: {} } }),
      })
    );
    const text = await res.text();
    ok(text.includes("isn't set up yet") && text.includes('"isError":true'), `Claude's tools wait for the setup: ${text.slice(0, 160)}`);
    eq((await sql(`SELECT count(*)::int AS n FROM maple_entries WHERE family_id = $1`, [SETUP]))[0].n, 0, "nothing logged");
  });

  await test("photo quota: family 1 has none; another family stops at its daily, lifetime and photo limits", async () => {
    eq(await claimUpload(2), true, "family 2's first");
    await sql(`UPDATE maple_upload_counts SET tokens = $1 WHERE family_id = 2 AND day = CURRENT_DATE`, [FAMILY_UPLOAD_LIMITS.tokensPerDay]);
    eq(await claimUpload(2), false, "past the day's tokens");
    await sql(`DELETE FROM maple_upload_counts WHERE family_id = 2`);
    await sql(`INSERT INTO maple_upload_counts (family_id, day, tokens) VALUES (2, CURRENT_DATE - 40, $1)`, [FAMILY_UPLOAD_LIMITS.tokensTotal]);
    eq(await claimUpload(2), false, "past the lifetime tokens");
    await sql(`DELETE FROM maple_upload_counts WHERE family_id = 2`);
    const photos = Array.from({ length: FAMILY_UPLOAD_LIMITS.photos }, (_, i) => ({ key: `maple/f2/moments/made-up-${i}.jpg`, access: "private" }));
    await sql(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, data, created_by) VALUES (2, $1, 'moment', NOW(), $2, 'made-up')`, [beta.babyId, { title: "Made-up album", photos }]);
    eq(await claimUpload(2), false, "past the photos kept");
    await sql(`INSERT INTO maple_upload_counts (family_id, day, tokens) VALUES (1, CURRENT_DATE, 100000)`);
    eq(await claimUpload(1), true, "family 1, whatever its counts");
    eq((await sql(`SELECT tokens FROM maple_upload_counts WHERE family_id = 1`))[0].tokens, 100000, "and family 1 is never counted");
  });

  await test("chat ceiling: every family but the Brookers stops together at the monthly ceiling; family 1 never does", async () => {
    const now = new Date();
    eq((await chatBudget({ familyId: 2 }, now)).month > BigInt(0), true, "under it");
    await sql(`INSERT INTO maple_ai_usage (family_id, member, step, model, cost_micro_usd, price_key) VALUES (NULL, 'made-up', 1, 'zai/glm-5.3-flash', $1, 'made-up')`, [String(GLOBAL_MONTHLY_DEFAULT)]);
    eq(String(Object.values(await chatBudget({ familyId: 2 }, now))), "0,0", "family 2 at the ceiling");
    const ctx = (await resolveFamily("setting.up@example.com", SETUP))!;
    const deps = familyChatDeps(ctx, (await auth.memberFor(ctx, "setting.up@example.com"))!, {
      model: "made-up",
      modelKey: "zai/glm-5.3-flash",
      now,
      newId: () => "made-up",
      report: () => {},
      waitUntil: () => {},
    });
    eq(String(Object.values(await deps.budget())), "0,0", "the onboarding chat too");
    ok((await chatBudget({ familyId: 1 }, now)).month > BigInt(0), "family 1 untouched");
    process.env.MAPLE_CHAT_GLOBAL_MONTHLY_MICRO = String(GLOBAL_MONTHLY_DEFAULT * BigInt(2));
    try {
      ok((await chatBudget({ familyId: 2 }, now)).month > BigInt(0), "a higher ceiling lets it go on");
    } finally {
      delete process.env.MAPLE_CHAT_GLOBAL_MONTHLY_MICRO;
    }
    await sql(`DELETE FROM maple_ai_usage WHERE family_id IS NULL`);
  });

  await test("the onboarding chat's day doesn't move when the owner changes the family's timezone", async () => {
    const now = new Date("2026-10-27T13:15:00Z");
    const who = "setting.up@example.com";
    const ctx = (await resolveFamily(who, SETUP))!;
    const member = (await auth.memberFor(ctx, who))!;
    const asked: string[] = [];
    const deps = {
      ...familyChatDeps(ctx, member, { model: "made-up", modelKey: "zai/glm-5.3-flash", now, newId: () => "made-up", report: () => {}, waitUntil: () => {} }),
      consent: async () => ({ terms: true }),
      usage: async (day: string, dayStart: Date, monthStart: Date) => {
        asked.push(`${day} ${dayStart.toISOString()} ${monthStart.toISOString()}`);
        return { mine: 0, day: BigInt(250_000), month: BigInt(250_000) };
      },
      budget: async () => ({ day: BigInt(250_000), month: BigInt(4_000_000) }),
    };
    const statuses: number[] = [];
    for (const zone of ["Etc/GMT-12", "Etc/GMT+8", "America/Denver"]) {
      await sql(`UPDATE maple_families SET timezone = $2 WHERE id = $1`, [SETUP, zone]);
      statuses.push((await answerOnboardingChat({ messages: [{ role: "user", text: "Her name is Made Up" }] }, member, deps)).status);
    }
    eq(statuses, [429, 429, 429], "the day's spend stops it in every zone");
    eq(new Set(asked).size, 1, `one day whatever the zone: ${asked.join(" | ")}`);
    await sql(`UPDATE maple_families SET timezone = 'America/Denver' WHERE id = $1`, [SETUP]);
  });

  await test("chat pause: the operator's switch stops one family's chat, family 1's included, and nobody else's", async () => {
    const now = new Date();
    await sql(`UPDATE maple_families SET settings = settings || '{"chat_paused": true}'::jsonb WHERE id = 2`);
    eq(String(Object.values(await chatBudget({ familyId: 2 }, now))), "0,0", "paused");
    ok((await chatBudget({ familyId: 1 }, now)).month > BigInt(0), "another family");
    const turned = await call(routes.chat.POST, "/api/maple/chat", beta.owner, 2, "POST", { threadId: "thread_paused_made_up", message: { id: "x", role: "user", parts: [{ type: "text", text: "How many diapers?" }] } });
    eq([turned.status, turned.body.code], [429, "limit"], "the chat route says no");
    await sql(`UPDATE maple_families SET settings = settings - 'chat_paused' WHERE id = 2`);
  });

  await test("crisis check: a family's own baby's name counts like 'the baby'", async () => {
    eq(mentionsCrisis("I keep thinking I'll hurt Ro"), false, "without the name");
    eq(mentionsCrisis("I keep thinking I'll hurt Ro", ["Rowan Test", "Ro"]), true, "the nickname");
    eq(mentionsCrisis("sometimes I want to shake Rowan", ["Rowan Test", "Ro"]), true, "the first name");
    eq(mentionsCrisis("I'm scared I'll drop Rowan on purpose", ["Rowan Test"]), true, "on purpose");
    eq(mentionsCrisis("Rowan took the whole bottle", ["Rowan Test"]), false, "baby talk");
    const me = (await auth.memberFor({ familyId: 2 }, beta.member))!;
    const ctx = (await resolveFamily(beta.member, 2))!;
    const res = await answerPost(
      { threadId: "thread_crisis_made_up", message: { id: "x", role: "user", parts: [{ type: "text", text: "I keep thinking I'll hurt Ro" }] } },
      me,
      familyPostDeps(ctx, me, { model: "made-up", modelKey: "zai/glm-5.3-flash", device: null, now: new Date(), report: () => {}, waitUntil: () => {} })
    );
    const body = (await res.json()) as { code?: string; help?: string };
    eq([res.status, body.code, body.help], [403, "terms", "crisis"], "the chat route adds the help card, by the family's own name");
  });

  await test("an abandoned onboarding family is deleted after 30 days; one that logged, a recent one and family 1 stay", async () => {
    eq([...CLEANUP_ORDER].sort(), [...FAMILY_TABLES].sort(), "the cleanup covers every family table");
    const make = async (daysAgo: number, email: string) => {
      const [f] = await sql(`INSERT INTO maple_families (timezone, status, created_by, created_at) VALUES ('UTC', 'onboarding', $1, NOW() - make_interval(days => $2)) RETURNING id`, [email, daysAgo]);
      const id = Number(f.id);
      await sql(`INSERT INTO maple_members (family_id, email, role, added_by, accepted_at) VALUES ($1, $2, 'owner', 'signup', NOW())`, [id, email]);
      await sql(`INSERT INTO maple_consents (family_id, member, kind, version) VALUES ($1, $2, 'chat', 3)`, [id, email]);
      await sql(`INSERT INTO maple_invites (family_id, token_hash, role, created_by, expires_at) VALUES ($1, $2, 'member', $3, NOW() + INTERVAL '7 days')`, [id, `made-up-hash-${id}`, email]);
      await sql(`INSERT INTO maple_ai_usage (family_id, member, step, model, cost_micro_usd, price_key) VALUES ($1, $2, 1, 'm', 5, 'm')`, [id, email]);
      return id;
    };
    const old = await make(31, "abandoned@example.com");
    const logged = await make(31, "logged.once@example.com");
    const [baby] = await sql(`INSERT INTO maple_babies (family_id, name, timezone) VALUES ($1, 'Made-up', 'UTC') RETURNING id`, [logged]);
    await sql(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, data, created_by) VALUES ($1, $2, 'diaper', NOW(), '{}', 'made-up')`, [logged, baby.id]);
    const recent = await make(10, "recent.signup@example.com");
    const settled = await make(45, "set.up.quietly@example.com");
    await sql(`UPDATE maple_families SET status = 'active' WHERE id = $1`, [settled]);
    await sql(`UPDATE maple_families SET status = 'onboarding', created_at = NOW() - INTERVAL '400 days' WHERE id = 1`);
    try {
      eq(await deleteAbandonedFamilies(new Date()), [old], "only the abandoned one");
      eq((await sql(`SELECT id FROM maple_families WHERE id = ANY($1::bigint[]) ORDER BY id`, [[old, logged, recent, settled, 1]])).map((r) => Number(r.id)), [1, logged, recent, settled].sort((a, b) => a - b));
      eq((await sql(`SELECT 1 FROM maple_members WHERE family_id = $1`, [old])).length, 0, "its members");
      eq((await sql(`SELECT family_id FROM maple_ai_usage WHERE member = 'abandoned@example.com'`)).map((r) => r.family_id), [null], "its cost rows stay, with no family");
      ok((await sql(`SELECT 1 FROM maple_members WHERE family_id = 1`)).length > 0, "family 1's people stay");
    } finally {
      await sql(`UPDATE maple_families SET status = 'active' WHERE id = 1`);
    }
  });

  await test("sign-up counts an IPv6 connection's whole /64 as one connection, and IPv4 addresses as themselves", () => {
    const key = (ip: string) => connectionKey(new Request(BASE, { headers: { "x-real-ip": ip } }), FAMILY_BUCKET);
    eq(key("2001:db8:1:2:aaaa::1"), key("2001:db8:1:2:bbbb:cccc:dddd:eeee"), "one /64");
    ok(key("2001:db8:1:2::1") !== key("2001:db8:1:3::1"), "another /64");
    ok(key("203.0.113.7") !== key("203.0.113.8"), "IPv4");
    eq(key("::ffff:203.0.113.7"), key("203.0.113.7"), "IPv4-mapped");
  });

  done("limits.check.ts");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
