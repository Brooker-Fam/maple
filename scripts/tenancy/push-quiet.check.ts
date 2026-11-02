import webpush from "web-push";
import { familyScope, type FamilyScope } from "../../src/lib/maple/family";
import { notifyHandoffNow } from "../../src/lib/maple/notify";
import { runPushTick } from "../../src/lib/maple/push";
import { handoffFor } from "../../src/lib/maple/push-wake";
import { askHandoff, startShift } from "../../src/lib/maple/sleep/store";
import type { Member } from "../../src/lib/maple/types";
import { done, eq, freshDb, ok, seedFamilies, sql, test, type Seed } from "./harness";

/**
 * Who hears a holding turn's handoff (push.ts's tick, notify.ts): the
 * planned handoff reaches only the holder's and the next holder's phones,
 * and "Handoff now" only the phones of the person asked, never anyone else
 * in the family, with two made-up families kept apart. Sends are caught
 * in-process; nothing leaves the machine.
 */

process.env.MCP_SECRET = "made-up-push-quiet-secret";
delete process.env.QSTASH_TOKEN;
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

type Sent = { endpoint: string; tag: string; title: string; body: string; kind: string };
const sent: Sent[] = [];
(webpush as unknown as { sendNotification: unknown }).sendNotification = async (sub: { endpoint: string }, payload: string) => {
  const p = JSON.parse(payload) as { tag: string; title: string; body: string; data: { kind: string } };
  sent.push({ endpoint: sub.endpoint, tag: p.tag, title: p.title, body: p.body, kind: p.data.kind });
  return { statusCode: 201, body: "", headers: {} };
};

const MIN = 60_000;
const HARPER = "harper.alpha@example.com";

type World = Seed & { a: FamilyScope; b: FamilyScope; phone: (who: string) => string };

/** Both made-up families, with one phone per person (handoff reminders on) and nothing sent yet. */
async function world(): Promise<World> {
  await freshDb({ shape: "final" });
  const seed = await seedFamilies();
  await sql(`UPDATE maple_push_sent SET sent_at = '2020-01-01' WHERE key = 'floor:v2'`);
  await sql(`DELETE FROM maple_push_subs`);
  const phone = (who: string) => `https://push.example.test/quiet-${who.split("@")[0]}`;
  let n = 0;
  for (const f of [seed.alpha, seed.beta]) {
    for (const who of [f.owner, f.member, f.viewer]) {
      await sql(`INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, prefs, receipt_token) VALUES ($1, $2, $3, 'made-up', 'made-up', '{"handoff":true}', $4)`, [
        f.familyId,
        who,
        phone(who),
        String(++n).padStart(32, "0"),
      ]);
    }
  }
  sent.length = 0;
  return { ...seed, a: (await familyScope(1))!, b: (await familyScope(2))!, phone };
}

const heard = (kind: string) => [...new Set(sent.filter((s) => s.kind === kind).map((s) => s.endpoint))].sort();

async function audiences() {
  await test("handoffFor: the holder and the planned next person; with none planned, the only other adult; with two others and none planned, the holder alone", () => {
    const m = (email: string, role: Member["role"]): Member => ({ email, role, display_name: null, emoji: null, color: null });
    const family = [m("sam@example.test", "owner"), m("alex@example.test", "member"), m("noor@example.test", "viewer"), m("theo@example.test", "photos")];
    eq(handoffFor({ holder: "sam@example.test", next: "alex@example.test" }, family), ["sam@example.test", "alex@example.test"]);
    eq(handoffFor({ holder: "sam@example.test", next: null }, family), ["sam@example.test", "alex@example.test"], "the only other adult");
    eq(handoffFor({ holder: "sam@example.test", next: "theo@example.test" }, family), ["sam@example.test", "alex@example.test"], "a photos-only guest is never next");
    eq(handoffFor({ holder: "sam@example.test", next: "sam@example.test" }, family), ["sam@example.test", "alex@example.test"], "never the holder twice");
    const three = [...family, m("harper@example.test", "member")];
    eq(handoffFor({ holder: "sam@example.test", next: null }, three), ["sam@example.test"], "two other adults: nobody is guessed");
    eq(handoffFor({ holder: "sam@example.test", next: "harper@example.test" }, three), ["sam@example.test", "harper@example.test"]);
    eq(handoffFor({ holder: "sam@example.test", next: "noor@example.test" }, three), ["sam@example.test", "noor@example.test"], "a view-only guest planned next hears it");
  });

  await test("the planned handoff reaches the holder's and the next holder's phones only, once each; beta hears nothing", async () => {
    const w = await world();
    const plannedFor = new Date(Date.now() + MIN);
    const s = await startShift(1, { babyId: w.alpha.babyId, holder: w.alpha.owner, handoffAt: plannedFor, nextHolder: w.alpha.member, by: w.alpha.owner, source: "web" });
    await runPushTick(new Date(plannedFor.getTime() + 30_000), { via: "wake", trusted: true, familyId: 1 });
    eq(heard("handoff"), [w.phone(w.alpha.member), w.phone(w.alpha.owner)].sort(), "Avery (holding her) and Blake (next), not Casey");
    ok(sent.every((x) => x.tag === `handoff:${s.shift.id}` && x.title === "Handoff time"), JSON.stringify(sent));
    sent.length = 0;
    await runPushTick(new Date(plannedFor.getTime() + 90_000), { via: "wake", trusted: true, familyId: 1 });
    eq(sent.length, 0, "once per phone");
    await runPushTick(new Date(plannedFor.getTime() + 90_000), { via: "wake", trusted: true, familyId: 2 });
    eq(sent.length, 0, "beta has no turn");
  });

  await test("the planned handoff with nobody planned next and two other adults reaches only the holder's phone", async () => {
    const w = await world();
    await sql(`INSERT INTO maple_members (family_id, email, role, display_name, added_by, accepted_at) VALUES (1, $1, 'member', 'Harper', 'self', NOW())`, [HARPER]);
    await sql(`INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, prefs, receipt_token) VALUES (1, $1, $2, 'made-up', 'made-up', '{"handoff":true}', $3)`, [HARPER, w.phone(HARPER), "f".repeat(32)]);
    const plannedFor = new Date(Date.now() + MIN);
    await startShift(1, { babyId: w.alpha.babyId, holder: w.alpha.member, handoffAt: plannedFor, by: w.alpha.member, source: "web" });
    await runPushTick(new Date(plannedFor.getTime() + 30_000), { via: "wake", trusted: true, familyId: 1 });
    eq(heard("handoff"), [w.phone(w.alpha.member)], "Blake, holding her: who's next isn't known, so nobody else is woken");
  });

  await test("Handoff now reaches only the phones of the person asked: not the holder's, not the viewer's, not another adult's", async () => {
    const w = await world();
    await sql(`INSERT INTO maple_members (family_id, email, role, display_name, added_by, accepted_at) VALUES (1, $1, 'member', 'Harper', 'self', NOW())`, [HARPER]);
    await sql(`INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, prefs, receipt_token) VALUES (1, $1, $2, 'made-up', 'made-up', '{"handoff":true}', $3)`, [HARPER, w.phone(HARPER), "f".repeat(32)]);
    // Blake has a second phone: both of Blake's hear it.
    const second = "https://push.example.test/quiet-blake-second";
    await sql(`INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, prefs, receipt_token) VALUES (1, $1, $2, 'made-up', 'made-up', '{"handoff":true}', $3)`, [w.alpha.member, second, "a".repeat(32)]);
    const t = (await startShift(1, { babyId: w.alpha.babyId, holder: w.alpha.owner, by: w.alpha.owner, source: "web" })).shift;
    await askHandoff(1, { babyId: w.alpha.babyId, id: t.id, to: w.alpha.member, by: w.alpha.owner, source: "web" });
    await notifyHandoffNow(w.a, t.id, null);
    eq(heard("handoff"), [second, w.phone(w.alpha.member)].sort(), "Blake's two phones only");
    ok(sent.every((x) => x.title === "Handoff now" && !/Avery|Blake|Casey|Harper|June|Juniper|Dana/.test(`${x.title} ${x.body}`)), JSON.stringify(sent));
    // Beta's same shift id reads as missing.
    sent.length = 0;
    await notifyHandoffNow(w.b, t.id, null);
    eq(sent.length, 0, "family B can't send family A's ask");
  });
}

audiences().then(() => done("push-quiet.check.ts"));
