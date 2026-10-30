import type { NextRequest } from "next/server";
import { done, eq, freshDb, ok, seedFamilies, sql, test, type Seed, type Shape } from "./harness";

/**
 * Onboarding (docs/multi-family-plan.md 4.2), family by family: a family
 * still setting up (made-up family Gamma, 3) answers through the structured
 * route into its own rows only; a finished family (Alpha stands in for the
 * Brookers as family 1) answers `needed: false`, refuses every write and
 * stays byte-for-byte the same; the chat's tools only propose, its usage is
 * filed under the family, and its step cap hands over to the form. Runs on
 * both schema shapes. Made-up people only; the model is a stand-in.
 */

delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.MAPLE_CHAT_MODEL;
process.env.GOOGLE_CLIENT_SECRET = "onboarding-check-secret-not-real";

const GAMMA = { familyId: 3, owner: "harper.gamma@example.com", member: "indy.gamma@example.com", tz: "America/Denver" };

async function main() {
  const { NextRequest } = await import("next/server");
  const { MockLanguageModelV4, simulateReadableStream } = await import("ai/test");
  const auth = await import("../../src/lib/maple/auth");
  const route = await import("../../src/app/api/maple/onboarding/route");
  const chatRoute = await import("../../src/app/api/maple/onboarding/chat/route");
  const { answerOnboardingChat, familyChatDeps } = await import("../../src/lib/maple/onboarding/chat");
  const { claimModelSteps } = await import("../../src/lib/maple/onboarding/store");
  const { ONBOARDING_MODEL_STEPS, ONBOARDING_STEPS_PER_MESSAGE } = await import("../../src/lib/maple/onboarding/steps");
  const { resolveFamily } = await import("../../src/lib/maple/family");

  type As = { id: string; fam: number };
  const req = (path: string, as: As | null, init: { method?: string; body?: unknown } = {}): NextRequest =>
    new NextRequest(new URL(path, "http://localhost:3000"), {
      method: init.method ?? "GET",
      headers: { ...(as ? { cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.sealSession(as.id, as.fam))}` } : {}), "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const call = async (handler: (r: NextRequest) => Promise<Response>, as: As | null, init: { method?: string; body?: unknown } = {}) => {
    const res = await handler(req("/api/maple/onboarding", as, init));
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
    return { status: res.status, body, text };
  };
  const answer = (as: As, step: string, value: unknown) => call(route.POST, as, { method: "POST", body: { step, value } });
  const gammaOwner: As = { id: GAMMA.owner, fam: GAMMA.familyId };
  const gammaMember: As = { id: GAMMA.member, fam: GAMMA.familyId };

  async function seedGamma(shape: Shape) {
    const [f] = await sql(`INSERT INTO maple_families (name, timezone, status, created_by, settings) VALUES (NULL, 'America/New_York', 'onboarding', $1, $2) RETURNING id`, [
      GAMMA.owner,
      { signup: { via: "open", terms: "2026-10-27", at: "2026-10-27T15:00:00Z" } },
    ]);
    if (Number(f.id) !== GAMMA.familyId) throw new Error(`Gamma came out as ${f.id}`);
    await sql(`INSERT INTO maple_members (family_id, email, role, display_name, added_by, accepted_at) VALUES (3, $1, 'owner', 'Harper', 'signup', NOW()), (3, $2, 'member', 'Indy', $1, NOW())`, [GAMMA.owner, GAMMA.member]);
    // Someone in two families: a write that forgets the family would reach their family 2 row too.
    if (shape === "final") await sql(`INSERT INTO maple_members (family_id, email, role, display_name, added_by, accepted_at) VALUES (2, $1, 'viewer', 'Harper in Beta', 'made-up', NOW())`, [GAMMA.owner]);
  }

  /** Everything of families 1 and 2, to prove onboarding never touched it. */
  const snapshot = async () =>
    JSON.stringify(
      await Promise.all(
        [
          `SELECT id, name, timezone, units, status, settings, onboarding, updated_at FROM maple_families WHERE id IN (1, 2) ORDER BY id`,
          `SELECT * FROM maple_babies WHERE family_id IN (1, 2) ORDER BY id`,
          `SELECT * FROM maple_members WHERE family_id IN (1, 2) ORDER BY family_id, email`,
          `SELECT id, family_id, role, display_name, used_at FROM maple_invites WHERE family_id IN (1, 2) ORDER BY id`,
          `SELECT * FROM maple_care_people WHERE family_id IN (1, 2) ORDER BY family_id`,
          `SELECT * FROM maple_chat_daily WHERE family_id IN (1, 2) ORDER BY family_id, member`,
          `SELECT id, family_id, cost_micro_usd FROM maple_ai_usage WHERE family_id IN (1, 2) OR family_id IS NULL ORDER BY id`,
        ].map((q) => sql(q))
      )
    );

  const GLM = "zai/glm-5.3-flash";
  const USAGE = { inputTokens: { total: 4_000, noCache: 4_000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 80, text: 80, reasoning: 0 } };
  const finish = (unified: string) => ({ type: "finish", finishReason: { unified, raw: unified }, usage: USAGE });
  const text = (t: string) => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: t }, { type: "text-end", id: "t" }];
  const standIn = (steps: Record<string, unknown>[][]) => {
    let n = 0;
    return new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, ...(steps[n++] ?? [...text("Okay."), finish("stop")])] as never[] }) }),
    });
  };
  const runChat = async (as: As, messages: unknown, model = standIn([])) => {
    const ctx = await resolveFamily(as.id, as.fam);
    const member = await auth.memberFor({ familyId: as.fam }, as.id);
    if (!ctx || !member) throw new Error("not signed in");
    const waits: Promise<unknown>[] = [];
    const reported: Error[] = [];
    const res = await answerOnboardingChat({ messages }, member, familyChatDeps(ctx, member, { model, modelKey: GLM, now: new Date(), newId: () => "msg_onb_made_up", report: (e) => void reported.push(e), waitUntil: (p) => void waits.push(p) }));
    const body = await res.text();
    await Promise.all(waits);
    const events = body
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
    return { status: res.status, body, events, model, reported };
  };

  for (const shape of ["production", "final"] as Shape[]) {
    await freshDb({ shape });
    const s: Seed = await seedFamilies();
    await seedGamma(shape);
    const alphaOwner: As = { id: s.alpha.owner, fam: 1 };
    const betaOwner: As = { id: s.beta.owner, fam: 2 };

    await test(`${shape}: a finished family (family 1) never opens onboarding, refuses every write and stays the same`, async () => {
      const before = await snapshot();
      eq((await call(route.GET, alphaOwner)).body, { needed: false }, "family 1's GET");
      eq((await call(route.GET, betaOwner)).body, { needed: false }, "family 2's GET");
      for (const [step, value] of [["you", { name: "Mallory" }], ["baby_name", { name: "Changed" }], ["timezone", { timezone: "Asia/Tokyo", units: "metric" }], ["invites", { people: [{ name: "Eve", role: "member" }] }], ["care", { choice: "me", consent: true }]] as const) {
        eq((await answer(alphaOwner, step, value)).status, 409, `family 1's ${step}`);
      }
      eq((await call(route.POST, alphaOwner, { method: "POST", body: { skip: "sex" } })).status, 409, "family 1's skip");
      eq((await call(route.POST, alphaOwner, { method: "POST", body: { finish: true } })).status, 409, "family 1's finish");
      eq((await runChat(alphaOwner, [{ role: "user", text: "Her name is Changed" }])).status, 409, "family 1's chat");
      eq(await snapshot(), before, "families 1 and 2 untouched");
      eq((await call(route.GET, null)).status, 401, "signed out");
    });

    await test(`${shape}: a family setting up resumes at its next question, and only its owner answers`, async () => {
      const before = await snapshot();
      const got = await call(route.GET, gammaOwner);
      const view = got.body.view as { next: string; done: Record<string, string>; values: { you: { name: string } } };
      eq([got.body.needed, view.next, view.done, view.values.you.name], [true, "you", { welcome: "answered" }, "Harper"], "terms came from /signup");
      eq((await answer(gammaMember, "you", { name: "Indy" })).status, 400, "a member who isn't the owner");
      eq((await answer(gammaOwner, "you", { name: "Harper", role_word: "Mama" })).status, 200, "you");
      eq((await answer(gammaOwner, "timezone", { timezone: GAMMA.tz, units: "metric" })).status, 200, "timezone");
      eq(((await call(route.GET, gammaOwner)).body.view as { next: string }).next, "baby_name", "resumes at the baby's name");
      eq((await call(route.POST, gammaOwner, { method: "POST", body: { skip: "birth" } })).status, 400, "birth can't be skipped");
      eq((await call(route.POST, gammaOwner, { method: "POST", body: { finish: true } })).status, 400, "not finished without a birth or due date");
      eq((await call(route.POST, gammaOwner, { method: "POST", body: { skip: "baby_name" } })).status, 200, "the name can be skipped");
      eq(await sql(`SELECT family_id, name, timezone FROM maple_babies WHERE family_id = 3`), [{ family_id: "3", name: "Baby", timezone: GAMMA.tz }], "a baby named Baby, in family 3");
      eq(await sql(`SELECT display_name, role_word FROM maple_members WHERE family_id = 3 AND email = $1`, [GAMMA.owner]), [{ display_name: "Harper", role_word: "Mama" }]);
      eq(await sql(`SELECT timezone, units FROM maple_families WHERE id = 3`), [{ timezone: GAMMA.tz, units: "metric" }]);
      eq(await snapshot(), before, "families 1 and 2 untouched");
    });

    await test(`${shape}: answers are checked before anything is written`, async () => {
      const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
      for (const [step, value] of [["birth", { born: true, date: future, time: "03:10" }], ["birth", { born: true, date: "2026-02-30" }], ["timezone", { timezone: "Mars/Olympus", units: "us" }], ["sex", { sex: "x" }], ["you", { name: "Robert'); DROP TABLE maple_members;--" }], ["pediatrician", { phone: "call me" }], ["invites", { people: [{ name: "Zed", role: "owner" }] }], ["care", { choice: "me" }]] as const) {
        const r = await answer(gammaOwner, step, value);
        eq(r.status, 400, `${step} ${JSON.stringify(value)}`);
      }
      eq(await sql(`SELECT born_at, sex FROM maple_babies WHERE family_id = 3`), [{ born_at: null, sex: null }], "nothing saved");
    });

    await test(`${shape}: every answer lands in family 3's own rows`, async () => {
      const before = await snapshot();
      eq((await answer(gammaOwner, "baby_name", { name: "Sage Test", nickname: "Sagey" })).status, 200, "name");
      eq((await answer(gammaOwner, "birth", { born: true, date: "2026-10-22", time: "03:10" })).status, 200, "birth");
      eq((await answer(gammaOwner, "sex", { sex: null })).status, 200, "prefer not to say");
      eq((await answer(gammaOwner, "feeding", { nursing: true, pumping: false, formula: true })).status, 200, "feeding");
      const inv = await answer(gammaOwner, "invites", { people: [{ name: "Grandma Test", role: "viewer" }, { name: "Jules", role: "member" }] });
      eq(inv.status, 200, "invites");
      const links = inv.body.invites as { url: string }[];
      ok(links.length === 2 && links.every((l) => /^http:\/\/localhost:3000\/maple\/join#[A-Za-z0-9_-]{20,}$/.test(l.url)), "two one-time links");
      eq((await answer(gammaOwner, "pediatrician", { name: "Dr. Made Up", phone: "(555) 010-0199", after_hours: null })).status, 200, "pediatrician");
      eq((await answer(gammaOwner, "notifications", { on: false })).status, 200, "notifications");
      const care = await answer(gammaOwner, "care", { choice: "me", consent: true });
      const baby = (await sql(`SELECT name, nickname, sex, born_at, settings FROM maple_babies WHERE family_id = 3`))[0];
      eq([baby.name, baby.nickname, baby.sex, new Date(baby.born_at as string).toISOString()], ["Sage Test", "Sagey", null, "2026-10-22T09:10:00.000Z"], "the baby, born 3:10 AM Denver time");
      const st = baby.settings as Record<string, unknown>;
      eq([st.feeds_bottle, st.track_pump, st.pediatrician_name, st.pediatrician_phone, "after_hours_phone" in st], [true, false, "Dr. Made Up", "(555) 010-0199", false], "settings");
      eq(await sql(`SELECT family_id, role, display_name FROM maple_invites WHERE family_id = 3 ORDER BY id`), [{ family_id: "3", role: "viewer", display_name: "Grandma Test" }, { family_id: "3", role: "member", display_name: "Jules" }], "invites in family 3");
      if (shape === "final") {
        eq(care.status, 200, "her page");
        const page = await sql(`SELECT family_id, member, settings FROM maple_care_people WHERE family_id = 3`);
        eq([page.length, page[0].member, (page[0].settings as { consent?: { by?: string; version?: number } }).consent?.by], [1, GAMMA.owner, GAMMA.owner], "tied to her member id, with her consent");
      } else {
        // Until the contract runs, one care page fits in the whole table: a second family's is refused, never another family's shown.
        eq([care.status, (care.body.error as string) ?? ""], [400, "This log already has a recovery page."], "refused on production's one-page index");
        eq(await sql(`SELECT 1 FROM maple_care_people WHERE family_id = 3`), [], "no page made");
      }
      eq(await snapshot(), before, "families 1 and 2 untouched");
    });

    await test(`${shape}: a new timezone keeps the birth's wall time`, async () => {
      const before = await snapshot();
      eq((await answer(gammaOwner, "timezone", { timezone: "America/New_York", units: "metric" })).status, 200);
      eq(new Date((await sql(`SELECT born_at FROM maple_babies WHERE family_id = 3`))[0].born_at as string).toISOString(), "2026-10-22T07:10:00.000Z", "3:10 AM New York time");
      eq((await answer(gammaOwner, "timezone", { timezone: GAMMA.tz, units: "metric" })).status, 200);
      eq(await snapshot(), before, "families 1 and 2 untouched");
    });

    await test(`${shape}: the chat proposes, never saves, and files its cost under its own family`, async () => {
      const before = await snapshot();
      eq((await runChat(gammaOwner, [{ role: "user", text: "Her name is Wren" }])).status, 403, "no chat terms yet");
      await sql(`INSERT INTO maple_consents (family_id, member, kind, version) VALUES (3, $1, 'chat', 3)`, [GAMMA.owner]);
      const model = standIn([
        [{ type: "tool-call", toolCallId: "c1", toolName: "propose_baby_name", input: JSON.stringify({ name: "Wren Test", nickname: null }) }, finish("tool-calls")],
        [...text("Wren Test it is: tap to confirm."), finish("stop")],
      ]);
      const r = await runChat(gammaOwner, [{ role: "assistant", text: "What's the baby's name?" }, { role: "user", text: "Her name is Wren" }], model);
      eq(r.status, 200, "streamed");
      const out = r.events.find((e) => e.type === "tool-output-available")?.output as { ok: boolean; kind: string; step: string; value: unknown };
      eq([out?.ok, out?.kind, out?.step, out?.value], [true, "answer", "baby_name", { name: "Wren Test", nickname: null }], "a proposal");
      eq((await sql(`SELECT name FROM maple_babies WHERE family_id = 3`))[0].name, "Sage Test", "nothing saved from the model's word");
      const prompt = JSON.stringify(model.doStreamCalls[0].prompt);
      ok(prompt.includes(`(${GAMMA.tz})`) && prompt.includes("Already set:") && !/Brooker|Brittany|Maple Jane/.test(prompt), "the family's own status, no Brooker names");
      const usage = await sql(`SELECT family_id, thread_id, member FROM maple_ai_usage WHERE family_id = 3 OR (family_id IS NULL AND thread_id = 'onboarding')`);
      eq(usage, [{ family_id: "3", thread_id: "onboarding", member: GAMMA.owner }, { family_id: "3", thread_id: "onboarding", member: GAMMA.owner }], "two steps, family 3's");
      eq(await sql(`SELECT family_id, messages FROM maple_chat_daily WHERE member = $1`, [GAMMA.owner]), [{ family_id: "3", messages: 1 }], "one message counted for family 3");
      eq(((await sql(`SELECT onboarding FROM maple_families WHERE id = 3`))[0].onboarding as { model_steps: number }).model_steps, 2, "unused steps handed back");
      eq(await snapshot(), before, "families 1 and 2 untouched");
    });

    await test(`${shape}: a crisis mention gets the help card even when the chat turns the message away, and the step cap hands over to the form`, async () => {
      await sql(`UPDATE maple_families SET onboarding = onboarding || '{"model_steps": ${ONBOARDING_MODEL_STEPS - 1}}'::jsonb WHERE id = 3`);
      const turned = await runChat(gammaOwner, [{ role: "user", text: "I don't want to be here anymore" }]);
      eq([turned.status, JSON.parse(turned.body).code, JSON.parse(turned.body).help], [429, "form", "crisis"], "the form takes over, with the help card");
      eq(turned.model.doStreamCalls.length, 0, "no model call past the cap");
      eq(await claimModelSteps({ familyId: 3 }, ONBOARDING_STEPS_PER_MESSAGE), null, "cap holds");
      eq(await claimModelSteps({ familyId: 1 }, 1), null, "a finished family has no steps to claim");
      await sql(`UPDATE maple_families SET onboarding = onboarding || '{"model_steps": 0}'::jsonb WHERE id = 3`);
      const streamed = await runChat(gammaOwner, [{ role: "user", text: "I don't want to be here anymore" }]);
      eq(streamed.events.find((e) => e.type === "data-help")?.data, { reason: "crisis" }, "the card in the stream");
      eq((await runChat(gammaMember, [{ role: "user", text: "Hi" }])).status, 409, "only the owner sets up");
      eq((await chatRoute.POST(req("/api/maple/onboarding/chat", gammaOwner, { method: "POST", body: { messages: [{ role: "assistant", text: "Hi" }] } }))).status, 400, "the newest message must be theirs");
    });

    await test(`${shape}: Start logging opens the app and onboarding never shows again`, async () => {
      const fin = await call(route.POST, gammaOwner, { method: "POST", body: { finish: true } });
      eq([fin.status, (fin.body.view as { status: string }).status], [200, "active"], "finished");
      eq((await call(route.GET, gammaOwner)).body, { needed: false }, "GET after");
      eq((await answer(gammaOwner, "baby_name", { name: "Later" })).status, 409, "no onboarding writes after");
      eq(await sql(`SELECT status FROM maple_families ORDER BY id`), [{ status: "active" }, { status: "active" }, { status: "active" }]);
      eq(await sql(`SELECT COUNT(*)::int AS n FROM maple_babies WHERE family_id = 3`), [{ n: 1 }], "one baby");
    });
  }
}

void main()
  .then(() => done("onboarding.check.ts"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
