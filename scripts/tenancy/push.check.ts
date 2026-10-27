import { createHash, createHmac } from "node:crypto";
import webpush from "web-push";
import { familyScope, type FamilyCtx, type FamilyScope } from "../../src/lib/maple/family";
import {
  deleteSub,
  fillDeviceId,
  liveSubs,
  moveSub,
  patchPrefs,
  pushFamily,
  pushHealth,
  recordReceipt,
  reminderFacts,
  runPushTick,
  saveSub,
  scheduleTest,
  subFor,
  subsOf,
} from "../../src/lib/maple/push";
import { setLaterRunner, careChanged, nursingChanged } from "../../src/lib/maple/push-hooks";
import { nextWake, scheduleWake, scheduleWakeups, tickUrl } from "../../src/lib/maple/push-wake";
import { notifyDoseLogged, notifyNursing } from "../../src/lib/maple/notify";
import type { Member } from "../../src/lib/maple/types";
import { pgliteQueryCount } from "../../src/lib/db";
import { done, eq, freshDb, ok, seedFamilies, sql, test, type Seed, type Shape } from "./harness";

/**
 * Notifications by family (src/lib/maple/push.ts, push-wake.ts, notify.ts,
 * push-hooks.ts and the /api/maple/push routes): family B can neither read
 * nor change family A's phones, claims, wakes or health, and a tick, a
 * "Logged" or a nursing notice only ever reaches its own family's phones.
 * Sends and QStash calls are caught in-process; nothing leaves the machine.
 */

process.env.MCP_SECRET = "made-up-push-check-secret";
delete process.env.QSTASH_TOKEN;
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

type Sent = { endpoint: string; tag: string; title: string; kind: string; at: number };
const sent: Sent[] = [];
/** A push service that takes this long to answer for one endpoint. */
const slow = new Map<string, number>();
(webpush as unknown as { sendNotification: unknown }).sendNotification = async (sub: { endpoint: string }, payload: string) => {
  const p = JSON.parse(payload) as { tag: string; title: string; data: { kind: string } };
  const wait = slow.get(sub.endpoint);
  if (wait) await new Promise((r) => setTimeout(r, wait));
  sent.push({ endpoint: sub.endpoint, tag: p.tag, title: p.title, kind: p.data.kind, at: Date.now() });
  return { statusCode: 201, body: "", headers: {} };
};

type Published = { url: string; dedup: string | null; body: string };
const published: Published[] = [];
const realFetch = globalThis.fetch;
function stubQstash() {
  process.env.QSTASH_TOKEN = "made-up-qstash-token";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.includes("/v2/publish/")) published.push({ url, dedup: headers.get("upstash-deduplication-id"), body: String(init?.body ?? "") });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
}
function unstubQstash() {
  delete process.env.QSTASH_TOKEN;
  globalThis.fetch = realFetch;
}

const MIN = 60_000;
const ALPHA_PLAN = 10000001;
const BETA_PLAN = 20000001;
const ALPHA_IN_BETA_ENDPOINT = "https://push.example.test/alpha-owner-in-beta";
const keys = { p256dh: "made-up-p256dh-2", auth: "made-up-auth-2" };

type World = Seed & { a: FamilyScope; b: FamilyScope; alphaInBetaSub: number | null };

/**
 * Both made-up families with a care page whose person has the same name
 * (Dana) and a medicine on an every-6-hours plan, so a query scoped by her
 * name instead of the family would mix them. On the final shape Avery (Alpha's
 * owner) is also a member of Beta with a phone there: someone in two
 * families, so a query scoped by member instead of family would mix them too.
 * `okIn`: minutes from now each family's medicine is OK again (negative: due).
 */
async function world(shape: Shape, okIn: { a: number; b: number } = { a: -2, b: -3 }): Promise<World> {
  await freshDb({ shape });
  const seed = await seedFamilies();
  const { alpha, beta } = seed;
  await sql(`UPDATE maple_push_sent SET sent_at = '2020-01-01' WHERE key = 'floor:v2'`);
  await sql(`UPDATE maple_care_meds SET schedule = '{"type":"every","every_min":360}' WHERE id = $1`, [ALPHA_PLAN]);
  await sql(`UPDATE maple_care_entries SET deleted_at = NOW() WHERE id = $1`, [alpha.care!.doseId]);
  const now = Date.now();
  const dose = async (fam: number, id: number, med: number, okInMin: number) =>
    sql(`INSERT INTO maple_care_entries (family_id, id, person, kind, med_id, at, data, created_by) VALUES ($1, $2, 'Dana', 'dose', $3, $4, '{"name":"x"}', 'made-up')`, [
      fam,
      id,
      med,
      new Date(now - 360 * MIN + okInMin * MIN).toISOString(),
    ]);
  await dose(1, 10000031, ALPHA_PLAN, okIn.a);
  let alphaInBetaSub: number | null = null;
  if (shape === "final") {
    await sql(`INSERT INTO maple_care_people (family_id, member, created_by) VALUES (2, 'Dana', $1)`, [beta.owner]);
    await sql(`INSERT INTO maple_care_meds (family_id, id, person, name, schedule, created_by) VALUES (2, $1, 'Dana', 'Naproxen', '{"type":"every","every_min":360}', $2)`, [
      BETA_PLAN,
      beta.owner,
    ]);
    await dose(2, 20000031, BETA_PLAN, okIn.b);
    await sql(`INSERT INTO maple_members (family_id, email, role, display_name, accepted_at) VALUES (2, $1, 'member', 'Avery', NOW())`, [alpha.owner]);
    const [row] = await sql(
      `INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, prefs, receipt_token) VALUES (2, $1, $2, 'made-up', 'made-up', '{"meds":true,"logged":true,"nursing":true}', $3) RETURNING id`,
      [alpha.owner, ALPHA_IN_BETA_ENDPOINT, "c".repeat(32)]
    );
    alphaInBetaSub = Number(row.id);
  }
  sent.length = 0;
  published.length = 0;
  return { ...seed, a: (await familyScope(1))!, b: (await familyScope(2))!, alphaInBetaSub };
}

const subRow = async (id: number) => (await sql(`SELECT family_id, member, endpoint, p256dh, prefs, device_id FROM maple_push_subs WHERE id = $1`, [id]))[0];
const endpoints = () => [...new Set(sent.map((s) => s.endpoint))].sort();
const tags = (endpoint: string) => [...new Set(sent.filter((s) => s.endpoint === endpoint).map((s) => s.tag))].sort();

async function subscriptions() {
  const w = await world("final");
  const { alpha, beta, a, b } = w;
  const me = alpha.owner;

  await test("subFor: family B can't read family A's phone, even for someone in both families", async () => {
    eq(await subFor(b, me, alpha.pushEndpoint), null);
    eq((await subFor(a, me, alpha.pushEndpoint))?.id, alpha.pushSubId);
    eq((await subFor(b, me, ALPHA_IN_BETA_ENDPOINT))?.family_id, 2);
  });

  await test("patchPrefs: family B can't change family A's phone", async () => {
    eq(await patchPrefs(b, me, alpha.pushEndpoint, { meds: false }), null);
    eq((await subRow(alpha.pushSubId)).prefs, { meds: true });
  });

  await test("deleteSub: family B can't turn off family A's phone", async () => {
    await deleteSub(b, me, alpha.pushEndpoint);
    ok(await subRow(alpha.pushSubId), "family A's phone is still there");
  });

  await test("fillDeviceId: family B can't set family A's phone's install id", async () => {
    await fillDeviceId(b, alpha.pushSubId, "made-up-device");
    eq((await subRow(alpha.pushSubId)).device_id, null);
    await fillDeviceId(a, alpha.pushSubId, "made-up-device");
    eq((await subRow(alpha.pushSubId)).device_id, "made-up-device");
    await sql(`UPDATE maple_push_subs SET device_id = NULL WHERE id = $1`, [alpha.pushSubId]);
  });

  await test("subsOf and liveSubs: only the family's own phones", async () => {
    eq((await subsOf(b, me)).map((s) => s.endpoint), [ALPHA_IN_BETA_ENDPOINT]);
    eq((await subsOf(a, me)).map((s) => s.endpoint), [alpha.pushEndpoint]);
    eq((await liveSubs(b)).map((s) => s.endpoint).sort(), [ALPHA_IN_BETA_ENDPOINT, beta.pushEndpoint].sort());
    eq((await liveSubs(a)).map((s) => s.endpoint), [alpha.pushEndpoint]);
  });

  await test("moveSub: family B can't take over family A's phone", async () => {
    const before = await subRow(alpha.pushSubId);
    eq(await moveSub(b, alpha.owner, alpha.pushEndpoint, { endpoint: "https://push.example.test/moved-made-up", ...keys }), null);
    eq(await subRow(alpha.pushSubId), before);
    eq((await sql(`SELECT COUNT(*)::int AS n FROM maple_push_subs WHERE endpoint = 'https://push.example.test/moved-made-up'`))[0].n, 0);
  });

  await test("saveSub: the same phone turned on in family B is B's own row; A's stays exactly as it was", async () => {
    const before = await subRow(alpha.pushSubId);
    const made = await saveSub(b, me, { endpoint: alpha.pushEndpoint, ...keys }, { meds: false }, "Made-up phone");
    eq([made.family_id, made.member], [2, me]);
    ok(made.id !== alpha.pushSubId, "a separate row");
    eq(await subRow(alpha.pushSubId), before);
  });

  await test("recordReceipt: a receipt token marks only its own phone", async () => {
    await recordReceipt(beta.receiptToken, "made-up-key");
    eq((await sql(`SELECT last_delivered_at FROM maple_push_subs WHERE id = $1`, [alpha.pushSubId]))[0].last_delivered_at, null);
    ok((await sql(`SELECT last_delivered_at FROM maple_push_subs WHERE id = $1`, [beta.pushSubId]))[0].last_delivered_at, "family B's phone is marked");
  });

  await test("pushFamily: a route acts in the family it resolved, and a carrier without one opens family 1 for family-1 members only", async () => {
    const member = (email: string): Member => ({ email, role: "owner", display_name: null, emoji: null, color: null });
    const ctxB: FamilyCtx = { ...b, member: beta.owner, role: "owner", status: "active" };
    eq((await pushFamily(member(beta.owner), ctxB))?.familyId, 2);
    eq(await pushFamily(member(alpha.owner), ctxB), null);
    eq((await pushFamily(member(alpha.owner)))?.familyId, 1);
    eq(await pushFamily(member(beta.owner)), null);
  });

  await test("moveSub: a phone's new endpoint replaces the same person's row for it in their other family too, and no one else's", async () => {
    const rotated = "https://push.example.test/alpha-owner-rotated";
    const betaBefore = await subRow(beta.pushSubId);
    const moved = await moveSub(a, me, alpha.pushEndpoint, { endpoint: rotated, ...keys });
    eq(moved?.family_id, 1, "moved in family A");
    const rows = await sql(`SELECT family_id, member, p256dh, needs_resubscribe FROM maple_push_subs WHERE endpoint = $1 ORDER BY family_id`, [rotated]);
    eq(rows.map((r) => [Number(r.family_id), r.member, r.p256dh, r.needs_resubscribe]), [[1, me, keys.p256dh, false], [2, me, keys.p256dh, false]]);
    eq((await sql(`SELECT COUNT(*)::int AS n FROM maple_push_subs WHERE endpoint = $1`, [alpha.pushEndpoint]))[0].n, 0, "the old endpoint is gone everywhere");
    eq(await subRow(beta.pushSubId), betaBefore, "Beta's owner's phone");
  });

  await test("deleteSub on sign-out: the same person's row for this phone goes in every family they're in; turning off in one family leaves the other", async () => {
    const rotated = "https://push.example.test/alpha-owner-rotated";
    const where = async () => (await sql(`SELECT family_id FROM maple_push_subs WHERE endpoint = $1 ORDER BY family_id`, [rotated])).map((r) => Number(r.family_id));
    await deleteSub(b, me, rotated);
    eq(await where(), [1], "off in family B only");
    await saveSub(b, me, { endpoint: rotated, ...keys }, { meds: true }, null);
    await deleteSub(b, me, rotated, { everywhere: true });
    eq(await where(), [], "signed out");
    ok(await subRow(beta.pushSubId), "Beta's owner's phone stays");
    ok(await subRow(w.alphaInBetaSub!), "Avery's other phone stays");
  });

  // The production shape still has the global UNIQUE (endpoint): the same phone can't join a second family
  // there yet (sign-up stays off), and must never be moved out of family A.
  await test("production: saveSub from family B on family A's phone fails and leaves A's row as it was", async () => {
    const p = await world("production");
    const before = await subRow(p.alpha.pushSubId);
    let failed = false;
    try {
      await saveSub(p.b, p.beta.owner, { endpoint: p.alpha.pushEndpoint, ...keys }, {}, null);
    } catch {
      failed = true;
    }
    ok(failed, "refused");
    eq(await subRow(p.alpha.pushSubId), before);
  });
}

async function ticks() {
  await test("a family's own tick sends its medicine only to its own phones", async () => {
    const w = await world("final");
    await runPushTick(new Date(), { via: "wake", trusted: true, familyId: 2 });
    eq(endpoints(), [ALPHA_IN_BETA_ENDPOINT, w.beta.pushEndpoint].sort());
    eq([...tags(ALPHA_IN_BETA_ENDPOINT), ...tags(w.beta.pushEndpoint)], [`med:${BETA_PLAN}`, `med:${BETA_PLAN}`]);
    sent.length = 0;
    await runPushTick(new Date(), { via: "wake", trusted: true, familyId: 1 });
    eq(endpoints(), [w.alpha.pushEndpoint]);
    eq(tags(w.alpha.pushEndpoint), [`med:${ALPHA_PLAN}`]);
  });

  await test("the safety net walks every family: each phone hears only its own family's medicine, named for its own care person", async () => {
    const w = await world("final");
    await runPushTick(new Date(), { via: "net", trusted: true });
    eq(tags(w.alpha.pushEndpoint), [`med:${ALPHA_PLAN}`]);
    eq(tags(w.beta.pushEndpoint), [`med:${BETA_PLAN}`]);
    eq(tags(ALPHA_IN_BETA_ENDPOINT), [`med:${BETA_PLAN}`]);
    ok(sent.find((s) => s.endpoint === w.beta.pushEndpoint)?.title.startsWith("Naproxen"), "family B reads its own medicine");
  });

  await test("claims are filed under the phone's family", async () => {
    const w = await world("final");
    await runPushTick(new Date(), { via: "net", trusted: true });
    const rows = await sql(`SELECT key, family_id FROM maple_push_sent WHERE key LIKE 's%|ok:%' ORDER BY key`);
    eq(
      rows.map((r) => [String(r.key).split("|")[0], r.family_id]),
      [
        [`s${w.alpha.pushSubId}`, "1"],
        [`s${w.beta.pushSubId}`, "2"],
        [`s${w.alphaInBetaSub}`, "2"],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0])))
    );
  });

  await test("an open app's poll gate is per family: family 1's poll never holds up family 2's", async () => {
    await world("final");
    eq((await runPushTick(new Date(), { via: "poll", familyId: 1 })).skipped, undefined);
    eq((await runPushTick(new Date(), { via: "poll", familyId: 2 })).skipped, undefined);
    eq((await runPushTick(new Date(), { via: "poll", familyId: 2 })).skipped, "recent");
    eq((await sql(`SELECT key FROM maple_push_sent WHERE key IN ('tick', 'gate:2') ORDER BY key`)).map((r) => r.key), ["gate:2", "tick"]);
  });

  await test("a family-1 poll never holds back the every-family GitHub or outside tick", async () => {
    const w = await world("final");
    eq((await runPushTick(new Date(), { via: "poll", familyId: 1 })).skipped, undefined, "family 1's poll");
    sent.length = 0;
    eq((await runPushTick(new Date(), { via: "gh" })).skipped, undefined, "the GitHub backstop right after");
    eq(tags(w.beta.pushEndpoint), [`med:${BETA_PLAN}`], "family 2's reminder went out");
    eq((await runPushTick(new Date(), { via: "ext" })).skipped, "recent", "a second every-family run waits its 20 seconds");
    await world("final");
    eq((await runPushTick(new Date(), { via: "gh" })).skipped, undefined, "an every-family run first");
    eq((await runPushTick(new Date(), { via: "poll", familyId: 1 })).skipped, undefined, "never holds family 1's poll");
  });

  await test("a sweep reads nothing for families with no phone on", async () => {
    await world("final");
    const sweep = async () => {
      await sql(`DELETE FROM maple_push_sent WHERE key LIKE 's%'`);
      const before = pgliteQueryCount();
      await runPushTick(new Date(), { via: "net", trusted: true });
      return pgliteQueryCount() - before;
    };
    const base = await sweep();
    for (let i = 0; i < 50; i++) {
      await sql(`INSERT INTO maple_families (name, timezone, status, created_by) VALUES ($1, 'America/Denver', 'active', 'made-up')`, [`Made-up empty family ${i}`]);
    }
    const more = await sweep();
    eq(more, base, `queries with 50 more phone-less families (base ${base})`);
  });

  await test("a sweep runs families side by side: one family's slow push service doesn't hold up another's", async () => {
    const w = await world("final");
    slow.set(w.alpha.pushEndpoint, 1500);
    try {
      const start = Date.now();
      await runPushTick(new Date(), { via: "net", trusted: true });
      const beta = sent.find((x) => x.endpoint === w.beta.pushEndpoint);
      ok(beta && beta.at - start < 1000, `family 2's send waited ${beta ? beta.at - start : "forever"} ms`);
      ok(sent.some((x) => x.endpoint === w.alpha.pushEndpoint), "family 1's send still went");
    } finally {
      slow.clear();
    }
  });

  await test("a family missing its reminders gets its own missed rows, and only its own show on its health line", async () => {
    const w = await world("final", { a: -200, b: -200 });
    await sql(`INSERT INTO maple_push_sent (key, sent_at) VALUES ('tick:net', NOW() - INTERVAL '5 hours')`);
    await sql(`INSERT INTO maple_push_sent (key, sent_at, ref) VALUES ('miss:legacy-made-up', NOW() - INTERVAL '1 hour', $1)`, [`med:${ALPHA_PLAN}`]);
    await runPushTick(new Date(), { via: "net", trusted: true });
    eq(sent.length, 0);
    const missedA = (await pushHealth(w.a, w.alpha.owner, null)).missed.map((m) => m.plan_id);
    const missedB = (await pushHealth(w.b, w.alpha.owner, null)).missed.map((m) => m.plan_id);
    eq([missedA, missedB], [[ALPHA_PLAN, ALPHA_PLAN], [BETA_PLAN]]);
  });

  await test("a family whose own clock stalled gets its missed rows, even while another family's app polls", async () => {
    const w = await world("final", { a: -200, b: -200 });
    await sql(`INSERT INTO maple_push_sent (key, sent_at, family_id) VALUES ('tick:poll', NOW() - INTERVAL '1 minute', 1), ('tick:2:poll', NOW() - INTERVAL '5 hours', 2)`);
    await runPushTick(new Date(), { via: "wake", trusted: true, familyId: 2 });
    eq((await pushHealth(w.b, w.beta.owner, null)).missed.map((m) => m.plan_id), [BETA_PLAN], "family 2's own miss");
    eq((await pushHealth(w.b, w.beta.owner, null)).gaps.length, 1, "and its own gap");
    eq((await pushHealth(w.a, w.alpha.owner, null)).gaps, [], "family 1's line has neither");
  });

  await test("the health line's clock is the every-family runs' and the family's own, never another family's", async () => {
    const w = await world("final");
    const line = async (scope: FamilyScope, who: string) => {
      const h = await pushHealth(scope, who, null);
      return [h.checked_at, h.clock_at];
    };
    const wake = new Date(Date.now() - 3 * MIN);
    await runPushTick(wake, { via: "wake", trusted: true, familyId: 1 });
    eq(await line(w.b, w.beta.owner), [null, null], "family 1's wake isn't family 2's clock");
    eq(await line(w.a, w.alpha.owner), [wake.toISOString(), wake.toISOString()], "family 1's own wake");
    const poll = new Date(Date.now() - 2 * MIN);
    await runPushTick(poll, { via: "write", trusted: true, familyId: 2 });
    eq(await line(w.a, w.alpha.owner), [wake.toISOString(), wake.toISOString()], "family 2's write isn't family 1's");
    eq(await line(w.b, w.beta.owner), [poll.toISOString(), null], "family 2's own write");
    const net = new Date(Date.now() - MIN);
    await runPushTick(net, { via: "net", trusted: true });
    eq([await line(w.a, w.alpha.owner), await line(w.b, w.beta.owner)], [[net.toISOString(), net.toISOString()], [net.toISOString(), net.toISOString()]], "the net is everyone's");
  });

  await test("a family still onboarding ticks: its phone's test goes out from its own wake and from the safety net", async () => {
    const w = await world("final");
    await sql(`UPDATE maple_families SET status = 'onboarding' WHERE id = 2`);
    const due = () => sql(`UPDATE maple_push_subs SET test_due_at = NOW() - INTERVAL '5 seconds', test_sent_at = NULL WHERE id = $1`, [w.beta.pushSubId]);
    const tested = () => sent.some((x) => x.endpoint === w.beta.pushEndpoint && x.kind === "test");
    await due();
    await runPushTick(new Date(), { via: "test", trusted: true, familyId: 2 });
    ok(tested(), "from its own test wake");
    sent.length = 0;
    await due();
    await runPushTick(new Date(), { via: "net", trusted: true });
    ok(tested(), "from the safety net");
  });

  await test("her page and doses are read in the family: another family's same-named page and a stray dose on this plan are never used", async () => {
    const w = await world("final");
    const { familyCarePerson } = await import("../../src/lib/maple/push-wake");
    eq([(await familyCarePerson(1))?.created_by, (await familyCarePerson(2))?.created_by], [w.alpha.owner, w.beta.owner]);
    await sql(`INSERT INTO maple_care_entries (family_id, id, person, kind, med_id, at, data) VALUES (2, 20000099, 'Dana', 'dose', $1, NOW() - INTERVAL '30 minutes', '{"name":"x"}')`, [ALPHA_PLAN]);
    await runPushTick(new Date(), { via: "wake", trusted: true, familyId: 1 });
    eq((await sql(`SELECT key FROM maple_push_sent WHERE key LIKE 's%|ok:%'`)).map((r) => r.key), [`s${w.alpha.pushSubId}|ok:${ALPHA_PLAN}:10000031`]);
  });

  await test("pushHealth: a member's phones are the family's own", async () => {
    const w = await world("final");
    eq((await pushHealth(w.b, w.alpha.owner, ALPHA_IN_BETA_ENDPOINT)).phones, [{ device: null, last_delivered_at: null, this: true }]);
    eq((await pushHealth(w.b, w.alpha.owner, w.alpha.pushEndpoint)).last_sent_at, null);
    eq((await pushHealth(w.a, w.alpha.owner, w.alpha.pushEndpoint)).phones.map((p) => p.this), [true]);
  });

  await test("reminderFacts: a family's own plans, and nothing for someone outside the family", async () => {
    const w = await world("final");
    eq((await reminderFacts(w.b, w.alpha.owner))?.map((f) => f.plan_id), [BETA_PLAN]);
    eq((await reminderFacts(w.a, w.alpha.owner))?.map((f) => f.plan_id), [ALPHA_PLAN]);
    eq(await reminderFacts(w.a, w.beta.owner), null);
    eq(await reminderFacts(w.b, w.beta.viewer), null);
  });
}

async function writes() {
  await test("Logged: family B can't send a notice about family A's dose; A's goes only to A's phones", async () => {
    const w = await world("final");
    await sql(`UPDATE maple_push_subs SET prefs = '{"meds":true,"logged":true}' WHERE id = $1`, [w.alpha.pushSubId]);
    eq(await notifyDoseLogged(w.b, 10000031, null), { sent: 0, failed: 0 });
    eq(sent.length, 0);
    await notifyDoseLogged(w.a, 10000031, null);
    eq(endpoints(), [w.alpha.pushEndpoint]);
  });

  await test("nursing: family B can't send family A's feed to the lock screen; A's goes only to A's phones", async () => {
    const w = await world("final");
    await sql(`UPDATE maple_push_subs SET prefs = '{"nursing":true}' WHERE id = $1`, [w.alpha.pushSubId]);
    const start = new Date(Date.now() - 10 * MIN).toISOString();
    const [feed] = await sql(
      `INSERT INTO maple_entries (family_id, baby_id, kind, started_at, active, data, created_by) VALUES (1, $1, 'feed', $2, TRUE, $3, 'made-up') RETURNING id`,
      [w.alpha.babyId, start, { method: "breast", segments: [{ side: "L", start }] }]
    );
    eq(await notifyNursing(w.b, Number(feed.id)), { sent: 0, failed: 0 });
    eq(sent.length, 0);
    await notifyNursing(w.a, Number(feed.id));
    eq(endpoints(), [w.alpha.pushEndpoint]);
  });

  await test("the write hooks: a write in family B never notifies about family A, and runs only B's tick", async () => {
    const w = await world("final");
    const tasks: Promise<void>[] = [];
    setLaterRunner((task) => tasks.push(task()));
    try {
      careChanged({ familyId: 2, doseId: 10000031 });
      await Promise.all(tasks.splice(0));
      ok(!endpoints().includes(w.alpha.pushEndpoint), "family A's phone heard nothing");
      eq(tags(w.beta.pushEndpoint), [`med:${BETA_PLAN}`]);
      eq((await sql(`SELECT COUNT(*)::int AS n FROM maple_push_sent WHERE key LIKE '%|log:%'`))[0].n, 0);
      const [feed] = await sql(
        `INSERT INTO maple_entries (family_id, baby_id, kind, started_at, active, data, created_by) VALUES (1, $1, 'feed', NOW(), TRUE, $2, 'made-up') RETURNING id`,
        [w.alpha.babyId, { method: "breast", segments: [{ side: "R", start: new Date().toISOString() }] }]
      );
      sent.length = 0;
      nursingChanged(Number(feed.id), 2);
      await Promise.all(tasks.splice(0));
      eq(sent.length, 0);
    } finally {
      setLaterRunner(null);
    }
  });
}

async function wakes() {
  stubQstash();
  try {
    await test("two families' moments in the same second both get a wake, each naming its own family", async () => {
      await world("final");
      const at = Date.now() + 90 * MIN;
      eq([await scheduleWake(1, at, "wake"), await scheduleWake(2, at, "wake"), await scheduleWake(2, at, "wake")], [true, true, false]);
      const sec = Math.ceil(at / 1000) + 10;
      eq(
        published.map((p) => [p.dedup, JSON.parse(p.body)]),
        [
          [`maple-wake-${sec}`, { via: "wake", at: sec }],
          [`maple-wake-2-${sec}`, { via: "wake", at: sec, family: 2 }],
        ]
      );
      const rows = await sql(`SELECT key, family_id FROM maple_push_sent WHERE key LIKE 'wake:%'`);
      eq(rows.map((r) => [r.key, r.family_id]).sort(), [
        [`wake:${sec}`, "1"],
        [`wake:2:${sec}`, "2"],
      ].sort());
    });

    await test("scheduleWakeups: a family publishes only its own moments and tests, and its health line shows only its own next wake", async () => {
      const w = await world("final", { a: 120, b: 60 });
      await sql(`UPDATE maple_push_subs SET test_due_at = NOW() + INTERVAL '5 minutes' WHERE id = $1`, [w.alpha.pushSubId]);
      await scheduleWakeups(w.b);
      eq(published.map((p) => JSON.parse(p.body).family), [2]);
      const bAt = JSON.parse(published[0].body).at * 1000;
      ok(Math.abs(bAt - (Date.now() + 60 * MIN)) < 2 * MIN, "family B's wake is at its own medicine's time");
      await scheduleWakeups(w.a);
      eq(published.map((p) => JSON.parse(p.body).family ?? 1), [2, 1, 1]);
      const firstA = Math.min(...published.slice(1).map((p) => JSON.parse(p.body).at * 1000));
      eq(await nextWake(1), new Date(firstA).toISOString());
      eq(await nextWake(2), new Date(bAt).toISOString());
    });

    await test("a test for a family-B phone is that family's wake", async () => {
      const w = await world("final");
      const sub = (await subsOf(w.b, w.beta.owner))[0];
      await scheduleTest(sub, 60);
      eq(published.map((p) => JSON.parse(p.body).family), [2]);
      ok((await sql(`SELECT 1 FROM maple_push_sent WHERE key LIKE 'wake:2:%' AND family_id = 2`)).length === 1, "claimed as family 2's");
    });

    await test("with QStash, the safety net runs family 1 itself and hands every other family its own signed wake", async () => {
      const w = await world("final");
      await runPushTick(new Date(), { via: "net", trusted: true });
      eq(tags(w.alpha.pushEndpoint), [`med:${ALPHA_PLAN}`], "family 1 inline");
      eq(sent.some((x) => x.endpoint === w.beta.pushEndpoint), false, "family 2 not in this invocation");
      ok(published.some((p) => (JSON.parse(p.body) as { family?: number }).family === 2), "family 2's wake was published");
      sent.length = 0;
      const wake = published.find((p) => (JSON.parse(p.body) as { family?: number }).family === 2)!;
      await runPushTick(new Date(), { via: "wake", trusted: true, schedule: true, familyId: (JSON.parse(wake.body) as { family: number }).family });
      eq(tags(w.beta.pushEndpoint), [`med:${BETA_PLAN}`], "which sends family 2's");
    });

    await test("with QStash, an unsigned outside call does nothing", async () => {
      const w = await world("final");
      const { GET } = await import("../../src/app/api/maple/push/tick/route");
      eq((await GET(new Request(tickUrl()) as never)).status, 204);
      eq(sent.length, 0);
      void w;
    });

    await test("the tick route: a signed wake ticks only the family its signed body names; one with no family is family 1's", async () => {
      process.env.QSTASH_CURRENT_SIGNING_KEY = "made-up-signing-key";
      try {
        const { POST } = await import("../../src/app/api/maple/push/tick/route");
        const call = (body: string, via: string | null = "wake") => {
          const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
          const h = b64({ alg: "HS256", typ: "JWT" });
          const now = Math.floor(Date.now() / 1000);
          const p = b64({ iss: "Upstash", sub: tickUrl(), exp: now + 300, nbf: now - 5, body: createHash("sha256").update(body).digest("base64url") });
          const sig = createHmac("sha256", "made-up-signing-key").update(`${h}.${p}`).digest("base64url");
          const req = new Request(tickUrl(), { method: "POST", body, headers: { "upstash-signature": `${h}.${p}.${sig}`, ...(via ? { "x-maple-via": via } : {}) } });
          return POST(req as never);
        };
        const w = await world("final");
        eq((await call(JSON.stringify({ via: "wake", at: 1, family: 2 }))).status, 204);
        ok(!endpoints().includes(w.alpha.pushEndpoint), "family A's phone heard nothing");
        eq(tags(w.beta.pushEndpoint), [`med:${BETA_PLAN}`]);
        sent.length = 0;
        await call(JSON.stringify({ via: "wake", at: 1 }));
        eq(endpoints(), [w.alpha.pushEndpoint]);
        sent.length = 0;
        await call(JSON.stringify({ via: "wake", at: 1, family: "2; DROP" }));
        eq(sent.length, 0);
        for (const header of [null, "wake"]) {
          const n = await world("final");
          await call(JSON.stringify({ via: "net" }), header);
          eq(tags(n.alpha.pushEndpoint), [`med:${ALPHA_PLAN}`], `the net (header ${header}) runs family 1`);
          ok(published.some((p) => (JSON.parse(p.body) as { family?: number }).family === 2), `the net (header ${header}) hands family 2 its wake`);
        }
      } finally {
        delete process.env.QSTASH_CURRENT_SIGNING_KEY;
      }
    });
  } finally {
    unstubQstash();
  }
}

async function familyOne() {
  await test("family 1 on the production shape: the keys, ids and words from before families", async () => {
    const w = await world("production");
    stubQstash();
    try {
      await runPushTick(new Date(), { via: "poll", familyId: 1 });
      eq(sent.map((s) => [s.endpoint, s.tag, s.title]), [[w.alpha.pushEndpoint, `med:${ALPHA_PLAN}`, "Ibuprofen is OK again for Dana"]]);
      eq((await sql(`SELECT key FROM maple_push_sent WHERE key = 'tick'`)).length, 1);
      eq((await sql(`SELECT key FROM maple_push_sent WHERE key LIKE 's%|ok:%'`)).map((r) => r.key), [`s${w.alpha.pushSubId}|ok:${ALPHA_PLAN}:10000031`]);
      const at = Date.now() + 30 * MIN;
      await scheduleWake(1, at, "wake");
      const sec = Math.ceil(at / 1000) + 10;
      eq(published.map((p) => [p.url.endsWith(`/v2/publish/${tickUrl()}`), p.dedup, p.body]), [[true, `maple-wake-${sec}`, JSON.stringify({ via: "wake", at: sec })]]);
    } finally {
      unstubQstash();
    }
  });

  await test("family 1: rows older code writes without a family (phones, wakes) are family 1's", async () => {
    await world("production");
    await sql(`INSERT INTO maple_push_subs (member, endpoint, p256dh, auth) VALUES ('avery.alpha@example.com', 'https://push.example.test/old-code-made-up', 'x', 'y')`);
    await sql(`INSERT INTO maple_push_sent (key, sent_at, state) VALUES ('wake:4102444800', to_timestamp(4102444800), 'sent')`);
    ok((await liveSubs({ familyId: 1 })).some((s) => s.endpoint.endsWith("old-code-made-up")), "family 1 sees the old code's phone");
    eq((await liveSubs({ familyId: 2 })).some((s) => s.endpoint.endsWith("old-code-made-up")), false);
    eq(await nextWake(1), "2100-01-01T00:00:00.000Z");
    eq(await nextWake(2), null);
  });
}

subscriptions()
  .then(ticks)
  .then(writes)
  .then(wakes)
  .then(familyOne)
  .then(() => done("push.check.ts"));
