/**
 * The feeding plan's tools on an in-memory Postgres (feeding-plan-mcp.ts):
 * feeding_plan reads the plan and what it says now; set_feeding_plan saves it
 * only after a read-back, with the token for exactly that plan and target, by
 * PATCH /api/maple/baby's rules (a stale base_rev refused with the plan as it
 * is now, feeding-plan.ts's own words for a plan that can't be saved); removing
 * it; who may do what (viewers read, photos-only guests reach nothing); the
 * plan's line in maple_status, the chat's [App] lines and Siri's status, and
 * nothing of it for a family without one; start_timer and log_feed with a plan
 * feed, its nipple shield and a late top-up's feed; undo_last after a save;
 * and two made-up families kept apart.
 *
 * The plans are invented examples (as in scripts/maple-feeding-plan-check.ts),
 * never a family's. The clock sits at noon in family Alpha's zone, a day feed's
 * time in these plans, so it reads the same at any hour.
 *
 *   pnpm check:maple-tenancy feeding-plan-tools
 */
// First, for its side effect: the check's clock (scripts/tenancy/clock.ts).
import "./clock";
import { z } from "zod";
import { NextRequest } from "next/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { atClock, localInstant, setClock } from "./clock";
import { done, eq, freshDb, ok, seedFamilies, sql, test, type Seed, type Shape } from "./harness";

process.env.MCP_SECRET = "made-up-feeding-plan-tools-secret";
process.env.MAPLE_SESSION_SECRET = "made-up-feeding-plan-tools-session-secret";
delete process.env.QSTASH_TOKEN;
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;

// Noon on Wed Nov 4, 2026 in America/Chicago (family Alpha).
setClock("2026-11-04T18:00:00Z");

type Result = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
type Handler = (args: unknown, extra: unknown) => Promise<Result>;
type Call = { error: boolean; text: string; json: Record<string, unknown> };

/** By day every 2.5 to 3.5 hours, taking turns; at night (11 PM to 5 AM) every 3 hours, waking: invented. */
const INPUT = {
  from: "Feeding clinic",
  check_in: "2026-11-13",
  day: { every: [150, 210] },
  night: { from: "11 PM", to: "5:00", every: 180, wake: true, feed: "Pump + bottle" },
  feeds: [
    { name: "Nurse + SNS", steps: [{ do: "nurse", minutes: [12, 18], supplement: { via: "sns", ml: 20, milk: "formula" } }, { do: "pump", minutes: 15 }] },
    { name: "Nurse, top up", steps: [{ do: "nurse", minutes: [8, 12], each_side: true }, { do: "bottle", ml: [25, 35], milk: "either", via: "paced" }] },
    { name: "Pump + bottle", steps: [{ do: "pump", minutes: 20 }, { do: "bottle", milk: "breastmilk_first", to_target: true }, { do: "note", text: "Burp halfway" }] },
  ],
};

async function main() {
  const { registerMapleTools } = await import("../../src/lib/maple/mcp-tools");
  const { chatLogState } = await import("../../src/lib/maple/chat/tools");
  const { feedingPlanOf, parseFeedingPlan, planLines } = await import("../../src/lib/maple/feeding-plan");
  const quick = await import("../../src/app/api/maple/quick/route");

  const handlers = new Map<string, { parse: (a: unknown) => unknown; run: Handler }>();
  registerMapleTools({
    registerTool: (name: string, cfg: { inputSchema: z.ZodRawShape }, run: Handler) => void handlers.set(name, { parse: (a) => z.object(cfg.inputSchema).parse(a), run }),
  } as unknown as McpServer);
  /** One MCP tool call as `who` in family `fam`, its arguments parsed as the SDK parses them (via a connector unless `via` says the chat). */
  const tool = async (who: string, fam: number, name: string, args: unknown = {}, via = "claude"): Promise<Call> => {
    const h = handlers.get(name);
    if (!h) throw new Error(`no tool ${name}`);
    const res = await h.run(h.parse(args), { authInfo: { token: "t", clientId: "c", scopes: ["maple"], extra: { sub: `maple:${who}`, fam, via, care: true } } });
    const text = res.content.map((c) => c.text ?? "").join("\n");
    const json = text.includes("\n{") ? (JSON.parse(text.slice(text.lastIndexOf("\n{") + 1)) as Record<string, unknown>) : {};
    return { error: res.isError === true, text, json };
  };
  const siri = async (token: string, body: unknown) => {
    const res = await quick.POST(new NextRequest(new URL("/api/maple/quick", "http://localhost:3000"), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
    return (await res.json()) as { speak?: string };
  };
  const settings = async (fam: number) => ((await sql(`SELECT settings FROM maple_babies WHERE family_id = $1`, [fam]))[0]?.settings ?? {}) as Record<string, unknown>;
  /** The saved target per feed as [min, max] (JSONB keeps its keys in its own order). */
  const targetOf = (s: Record<string, unknown>) => {
    const t = s.feed_target_ml as { min?: number; max?: number } | undefined;
    return t ? [t.min, t.max] : null;
  };
  /** A read-back, then the same plan with its token: the save. */
  const save = async (who: string, fam: number, args: Record<string, unknown>) => {
    const first = await tool(who, fam, "set_feeding_plan", args);
    if (first.error || first.json.confirm_needed !== true) throw new Error(`no read-back: ${first.text}`);
    return tool(who, fam, "set_feeding_plan", { ...args, confirmed: true, read_back: first.json.read_back });
  };

  await test("a bottle up to the target that's short of it reads what's in it and what it still needs: the plan's line, the missed line and Siri's", async () => {
    // The engine's contract (feeding-plan.ts StepView.need): such a bottle stays to do while what's logged is under
    // its amount. The night feed's view is built here as the engine gives it, so the words are checked on their own.
    type Now = import("../../src/lib/maple/feeding-plan").FeedPlanNow;
    const { feedPlanNow } = await import("../../src/lib/maple/feeding-plan");
    const { planNowLine, planSpeak } = await import("../../src/lib/maple/feeding-plan-mcp");
    const { FAMILY_ONE_VOICE } = await import("../../src/lib/maple/voice");
    const { zonedTimeToUtc } = await import("../../src/lib/maple/time");
    const tz = "America/Chicago";
    const T = (h: number, m: number) => zonedTimeToUtc(2026, 11, 4, h, m, tz).getTime();
    const now = new Date(T(2, 5));
    const plan = parseFeedingPlan(INPUT, null, now);
    const target = { min: 50, max: 70 };
    // The night's pump from 1:30 to 1:50 AM, then 40 ml of pumped milk by bottle at 1:55: the formula to finish not yet given.
    const steps = plan.feeds[2].steps.map((step, i) =>
      step.do === "pump"
        ? { i, step, status: "done", minutes: 20, ml: null, need: null, milkMissing: false, entries: [] }
        : step.do === "bottle"
          ? { i, step, status: "todo", minutes: null, ml: 40, need: target, milkMissing: false, entries: [] }
          : { i, step, status: "info", minutes: null, ml: null, need: null, milkMissing: false, entries: [] }
    );
    // Named by its first bottle (PlanFeedView.named), never the pump begun before it.
    const short = { feed: plan.feeds[2], why: "night", night: true, start: T(1, 30), named: T(1, 55), group: null, steps, done: false, live: false, lastAt: T(1, 55), extraNursing: false } as unknown as Now["focus"];
    const base = feedPlanNow(plan, [], now, { tz, target });
    const w = { now, tz, vo: FAMILY_ONE_VOICE };
    const going: Now = { ...base, focus: { ...short, state: "underway" }, after: { feed: plan.feeds[0], night: true }, missed: null, others: [] };
    const line = planNowLine(going, w);
    ok(line.includes("So far: bottle up to 50–70 ml, pumped milk first, then formula to finish (40 ml so far). Next: formula to finish, 10–30 ml more; then burp halfway."), line);
    eq(planSpeak(going, w), "From the feeding plan: Pump + bottle is underway; still to do: formula to finish, 10 to 30 ml more (40 ml so far).", "Siri");
    // Left like that, the next feed's line says it, as a step the feed didn't finish.
    const after: Now = { ...base, missed: { view: short, steps: short.steps.filter((s) => s.status === "todo") } };
    const missed = planNowLine(after, w);
    ok(missed.includes('From the 1:55 AM feed ("Pump + bottle"), bottle up to 50–70 ml, pumped milk first, then formula to finish (40 ml so far); not logged: formula to finish, 10–30 ml more.'), missed);
  });

  await test("on demand, a step only if needed and one side in the plan's line and Siri's: when to feed by, what's left, never a miss", async () => {
    type Entry = import("../../src/lib/maple/types").Entry;
    const { feedPlanNow } = await import("../../src/lib/maple/feeding-plan");
    const { planNowLine, planSpeak } = await import("../../src/lib/maple/feeding-plan-mcp");
    const { makeVoice } = await import("../../src/lib/maple/voice");
    const { zonedTimeToUtc } = await import("../../src/lib/maple/time");
    const tz = "America/Chicago";
    const T = (h: number, m: number) => zonedTimeToUtc(2026, 11, 4, h, m, tz).toISOString();
    const SHE = makeVoice({ name: "River", pronoun: "she" });
    // On demand, at least every 3 hours; "Nurse, top up if hungry" (the top-up only if she's still hungry); "Left, pump the right".
    const plan = parseFeedingPlan(
      {
        day: { every: { max: 180 } },
        feeds: [
          { name: "Nurse, top up if hungry", steps: [{ do: "nurse", minutes: [8, 12], each_side: true }, { do: "bottle", ml: [25, 35], via: "paced", if_needed: true }] },
          { name: "Left, pump the right", steps: [{ do: "nurse", minutes: [15, 20], side: "left" }, { do: "pump", minutes: 15 }] },
        ],
      },
      null,
      new Date(T(8, 0))
    );
    const fed = {
      id: 1,
      kind: "feed",
      started_at: T(9, 0),
      ended_at: T(9, 20),
      active: false,
      note: null,
      created_by: null,
      updated_by: null,
      source: "web",
      created_at: T(9, 0),
      updated_at: T(9, 20),
      data: { method: "breast", segments: [{ side: "L", start: T(9, 0), end: T(9, 10) }, { side: "R", start: T(9, 10), end: T(9, 20) }], plan: plan.feeds[0].id },
    } as unknown as Entry;
    const w = (h: number, m: number) => ({ now: new Date(T(h, m)), tz, vo: SHE });
    // Just after: the top-up is still to do, if she's still hungry; the next feed by noon.
    const after = feedPlanNow(plan, [fed], new Date(T(9, 25)), { tz, target: null });
    const line = planNowLine(after, w(9, 25));
    ok(line.includes("Next: top up 25–35 ml if still hungry, paced bottle.") && line.includes('After it: "Left, pump the right"; by 12:00 PM (on demand).'), line);
    eq(planSpeak(after, w(9, 25)), "From the feeding plan: Nurse, top up if hungry is underway; still to do: top up 25 to 35 ml if still hungry, paced bottle.", "Siri, underway");
    // Nobody gave it: the next feed, on its one side, and never a miss.
    const later = feedPlanNow(plan, [fed], new Date(T(10, 30)), { tz, target: null });
    const next = planNowLine(later, w(10, 30));
    eq(next, 'Feeding plan: next is "Left, pump the right": nurse 15–20 min on the left; then pump 15 min. By 12:00 PM (on demand).');
    eq(planSpeak(later, w(10, 30)), "Next from the feeding plan: Left, pump the right, on demand, by 12:00 PM.", "Siri, next");
    // Waking her by its most.
    const woken = parseFeedingPlan({ day: { every: [0, 180], wake: true }, feeds: plan.feeds.map(({ name, steps }) => ({ name, steps })) }, null, new Date(T(8, 0)));
    const wake = feedPlanNow(woken, [{ ...fed, data: { ...(fed as { data: object }).data, plan: woken.feeds[0].id } } as unknown as Entry], new Date(T(10, 30)), { tz, target: null });
    ok(planNowLine(wake, w(10, 30)).endsWith("Wake her by 12:00 PM if still asleep."), planNowLine(wake, w(10, 30)));
    eq(planSpeak(wake, w(10, 30)), "Next from the feeding plan: Left, pump the right, waking her by 12:00 PM if she's still asleep.");
  });

  for (const shape of ["production", "final"] as Shape[]) {
    await freshDb({ shape });
    const s: Seed = await seedFamilies();
    const { alpha, beta } = s;
    const A = alpha.familyId;
    const B = beta.familyId;
    const photo = "pat.alpha@example.com";
    await sql(`INSERT INTO maple_members (family_id, email, role, display_name, added_by, accepted_at) VALUES ($1, $2, 'photos', 'Pat', 'self', NOW())`, [A, photo]);

    await test(`${shape}: with no plan, feeding_plan says so and how to add one; maple_status, the chat's lines and Siri say nothing of a plan`, async () => {
      const read = await tool(alpha.owner, A, "feeding_plan");
      ok(!read.error && /^There's no feeding plan saved\./.test(read.text) && /set_feeding_plan/.test(read.text) && /by hand in the app/.test(read.text), read.text);
      eq(read.json.plan, null, "no plan in the JSON");
      const status = await tool(alpha.owner, A, "maple_status");
      ok(!("feeding_plan" in status.json) && !/Feeding plan/.test(status.text), "maple_status has no plan field or line");
      ok(!(await chatLogState({ email: alpha.owner }, { fam: A, care: true, now: new Date() })).some((l) => l.startsWith("Feeding plan")), "no [App] line");
      ok(!/feeding plan/i.test((await siri(alpha.token, { action: "status" })).speak ?? ""), "Siri says nothing of it");
    });

    await test(`${shape}: set_feeding_plan without confirmed reads every line back with a token, and saves nothing`, async () => {
      const r = await tool(alpha.owner, A, "set_feeding_plan", { plan: INPUT, target: [50, 70] });
      ok(!r.error, r.text);
      eq(r.text.split("\n")[0], "Not saved yet: say yes to save the plan.", "the line the chat's card shows");
      const want = planLines(parseFeedingPlan(INPUT, null, new Date()), { min: 50, max: 70 });
      for (const line of want) ok(r.text.includes(line), `reads back "${line}"`);
      ok(r.text.includes("Night (11 PM–5 AM): every 3 hours, waking her: Pump + bottle"), "her, as the family's words say");
      eq([r.json.confirm_needed, /^rb[0-9a-f]{10}$/.test(String(r.json.read_back))], [true, true], "a read-back token");
      eq(["feeding_plan" in (await settings(A)), "feed_target_ml" in (await settings(A))], [false, false], "nothing saved");
      // Null for a field left out, as a model sends it, reads the same.
      const nulls = await tool(alpha.owner, A, "set_feeding_plan", { plan: { ...INPUT, notes: null, feeds: INPUT.feeds.map((f) => ({ ...f, id: null })) }, target: [50, 70], base_rev: null, remove: null });
      eq(nulls.json.read_back, r.json.read_back, "the same plan, the same token");
    });

    await test(`${shape}: a wrong token, a changed plan or a changed target reads back again and saves nothing`, async () => {
      const first = await tool(alpha.owner, A, "set_feeding_plan", { plan: INPUT, target: [50, 70] });
      const token = first.json.read_back;
      const wrong = await tool(alpha.owner, A, "set_feeding_plan", { plan: INPUT, target: [50, 70], confirmed: true, read_back: "rb0000000000" });
      ok(wrong.json.confirm_needed === true && /That read_back isn't for this plan/.test(wrong.text), wrong.text);
      const changed = await tool(alpha.owner, A, "set_feeding_plan", { plan: { ...INPUT, notes: "Weigh on Friday" }, target: [50, 70], confirmed: true, read_back: token });
      ok(changed.json.confirm_needed === true && changed.text.includes("Notes: Weigh on Friday"), "a changed plan is read back as it is now");
      const target = await tool(alpha.owner, A, "set_feeding_plan", { plan: INPUT, target: [55, 75], confirmed: true, read_back: token });
      ok(target.json.confirm_needed === true && target.text.includes("Target: 55–75 ml a feed"), "so is a changed target");
      const none = await tool(alpha.owner, A, "set_feeding_plan", { plan: INPUT, target: [50, 70], confirmed: true });
      ok(none.json.confirm_needed === true && /confirmed: true needs read_back/.test(none.text), "confirmed alone isn't a yes");
      eq("feeding_plan" in (await settings(A)), false, "nothing saved");
    });

    await test(`${shape}: with its token the plan saves (revision 1, the target with it) and the answer says what Today shows now`, async () => {
      const r = await save(alpha.owner, A, { plan: INPUT, target: [50, 70] });
      ok(!r.error && r.json.saved === true && r.json.rev === 1, r.text);
      eq(r.text.split("\n")[0], "Saved the feeding plan.", "the line the chat's card shows");
      ok(/^Revision 1, from Feeding clinic, with a target of 50–70 ml a feed\. Today shows it now: next is "Nurse \+ SNS": nurse 12–18 min, 20 ml of formula in the SNS; then pump 15 min\./m.test(r.text), r.text);
      ok(!/\(p\d+f\d+\)/.test(r.text.split("\n{")[0]), "no feed ids in its words");
      const saved = await settings(A);
      eq([feedingPlanOf(saved)?.rev, feedingPlanOf(saved)?.feeds.map((f) => f.name), targetOf(saved)], [1, ["Nurse + SNS", "Nurse, top up", "Pump + bottle"], [50, 70]], "saved as the route saves it");
      // The same plan again: nothing to change.
      const again = await tool(alpha.owner, A, "set_feeding_plan", { plan: INPUT, target: [50, 70], base_rev: 1 });
      ok(again.json.unchanged === true && /^Nothing to change/.test(again.text), again.text);
    });

    await test(`${shape}: feeding_plan reads it as saved: its lines, what's next, its rev, and the plan in set_feeding_plan's shape`, async () => {
      const r = await tool(alpha.member, A, "feeding_plan");
      ok(!r.error, r.text);
      ok(r.text.startsWith("Feeding plan (revision 1), as the family saved it from their care team:"), r.text.slice(0, 120));
      ok(r.text.includes("Next: \"Nurse + SNS\" (its turn in the plan's order).") && r.text.includes("- Nurse 12–18 min, 20 ml of formula in the SNS") && r.text.includes("- Pump 15 min"), "the next feed, step by step");
      ok(r.text.includes('The plan\'s other feeds, if they\'d rather do one of those (start_timer with plan when it begins; nothing in the plan changes): "Nurse, top up", "Pump + bottle".'), "the others, and how to do one");
      eq([r.json.rev, (r.json.now as { state?: string }).state], [1, "upcoming"], "rev and state");
      const plan = r.json.plan as { feeds: { id: string; steps: unknown[] }[]; order: string[]; amounts_in: string; day: unknown };
      eq([plan.amounts_in, plan.day, plan.feeds[1].steps[1], r.json.target], ["ml", { every: [150, 210] }, { do: "bottle", ml: [25, 35], milk: "either", via: "paced" }, [50, 70]], "the shape set_feeding_plan takes");
      // Sent back changed, with base_rev: the ids stay, and it saves as revision 2.
      const edit = { ...plan, feeds: plan.feeds.map((f, i) => (i === 1 ? { ...f, steps: [f.steps[0], { do: "bottle", ml: [35, 45], milk: "either", via: "paced" }] } : f)) };
      const two = await save(alpha.member, A, { plan: edit, target: r.json.target, base_rev: 1 });
      ok(two.json.saved === true && two.json.rev === 2, two.text);
      // The save's answer says what it changed, part by part, as its read-back did.
      ok(two.text.includes('What changed:\nChanged in "Nurse, top up": top up 35–45 ml (was 25–35 ml).\nEverything else stayed as it was.'), two.text);
      // And it hands back the plan as saved, in this shape, with the rev a later change starts from.
      const back = two.json.plan as { feeds: { id: string; steps: unknown[] }[] };
      eq([two.json.base_rev, back.feeds.map((f) => f.id), back.feeds[1].steps[1], two.json.target], [2, plan.feeds.map((f) => f.id), { do: "bottle", ml: [35, 45], milk: "either", via: "paced" }, [50, 70]], "the save's plan");
      const after = feedingPlanOf(await settings(A))!;
      eq([after.rev, after.feeds.map((f) => f.id), after.feeds[1].steps[1]], [2, plan.feeds.map((f) => f.id), { do: "bottle", ml: { min: 35, max: 45 }, milk: "either", via: "paced" }], "a member's edit, ids kept");
    });

    await test(`${shape}: an edit without base_rev says which; a stale one reads the plan as it is now and asks to make the change again`, async () => {
      const missing = await tool(alpha.owner, A, "set_feeding_plan", { plan: INPUT });
      ok(missing.error && /There's a saved feeding plan \(revision 2\)\. Send the whole plan with base_rev: 2/.test(missing.text), missing.text);
      const stale = await tool(alpha.owner, A, "set_feeding_plan", { plan: INPUT, base_rev: 1 });
      ok(stale.error && stale.text.startsWith("Nothing was saved: the feeding plan was changed since revision 1 (it's revision 2 now). It reads now:"), stale.text);
      ok(stale.text.includes("• Nurse, top up: Nurse 8–12 min each side; then top up 35–45 ml, formula or breast milk, paced bottle") && /Make the change again on this one/.test(stale.text), "the plan as it is now");
      eq(feedingPlanOf(await settings(A))?.rev, 2, "nothing saved");
    });

    await test(`${shape}: an edit reads back what it changes on the saved plan (feeds paired by id), then the whole plan; a resend that slips shows its slip`, async () => {
      const read = await tool(alpha.owner, A, "feeding_plan");
      const p = read.json.plan as { feeds: { id: string; name: string; steps: Record<string, unknown>[] }[]; night: Record<string, unknown> };
      const base = { target: read.json.target, base_rev: read.json.rev };
      const back = async (plan: unknown) => (await tool(alpha.owner, A, "set_feeding_plan", { ...base, plan })).text.split("\n{")[0];
      // One amount: one pair, everything else stays, and the whole plan after it, to read only if asked.
      const one = { ...p, feeds: p.feeds.map((f, i) => (i === 0 ? { ...f, steps: [{ ...f.steps[0], supplement: { via: "sns", ml: 25, milk: "formula" } }, f.steps[1]] } : f)) };
      const amount = await back(one);
      ok(
        amount.includes(
          'Read what changes back to them as it is, then ask if that\'s right:\nWhat changes:\nChanged in "Nurse + SNS": 25 ml of formula in the SNS (was 20 ml).\nEverything else stays as it is.\nThe whole plan with the change, to read them only if they ask:\nFrom: Feeding clinic'
        ),
        amount
      );
      eq((amount.match(/^(Was|Changed in) /gm) ?? []).length, 1, "exactly one change");
      // Two changes in one feed (a value an older copy of the plan puts back beside the one asked for): each said on its own.
      const two = { ...p, feeds: p.feeds.map((f, i) => (i === 0 ? { ...f, steps: [{ ...f.steps[0], minutes: [10, 15], supplement: { via: "sns", ml: 25, milk: "formula" } }, f.steps[1]] } : f)) };
      const twoBack = await back(two);
      ok(twoBack.includes('What changes:\nChanged in "Nurse + SNS": nurse 10–15 min (was 12–18 min); 25 ml of formula in the SNS (was 20 ml).\nEverything else stays as it is.'), twoBack);
      // A step added: the feed as it was and as it would be.
      const added = { ...p, feeds: p.feeds.map((f, i) => (i === 1 ? { ...f, steps: [...f.steps, { do: "pump", minutes: 10 }] } : f)) };
      const addedBack = await back(added);
      ok(addedBack.includes("Was: Nurse, top up: Nurse 8–12 min each side; then top up 35–45 ml, formula or breast milk, paced bottle\nNow: Nurse, top up: Nurse 8–12 min each side; then top up 35–45 ml, formula or breast milk, paced bottle; then pump 10 min"), addedBack);
      // The night left out reads as removed, and its feed, now in no turn, asks with it.
      const night = await back({ ...p, night: null });
      ok(night.includes("What changes:\nRemoved: Night (11 PM–5 AM): every 3 hours, waking her: Pump + bottle\nEverything else stays as it is."), night);
      ok(night.includes('Ask with it: "Pump + bottle" isn\'t in the day\'s turns, so Today only offers it as another choice. If it takes a turn, add it to order.'), "the feed it leaves without a turn");
      // A partial resend says everything it would take out.
      const partial = await back({ feeds: [p.feeds[1]] });
      ok(/Removed: From: Feeding clinic/.test(partial) && /Removed: Nurse \+ SNS: /.test(partial) && /Removed: Pump \+ bottle: /.test(partial) && /Removed: Night \(/.test(partial), partial);
      // A rename reads once, never again in the turns that name it.
      const renamed = await back({ ...p, feeds: p.feeds.map((f, i) => (i === 1 ? { ...f, name: "Nurse, then top up" } : f)) });
      ok(renamed.includes('What changes:\nRenamed: "Nurse, top up" is now "Nurse, then top up".\nEverything else stays as it is.'), renamed);
      // A yes sent with a plan that slipped from what was read back reads back again, the slip among the changes.
      const rb = await tool(alpha.owner, A, "set_feeding_plan", { ...base, plan: one });
      const slipped = { ...one, feeds: one.feeds.map((f, i) => (i === 1 ? { ...f, steps: [{ do: "nurse", minutes: [8, 12] }, f.steps[1]] } : f)) };
      const re = await tool(alpha.owner, A, "set_feeding_plan", { ...base, plan: slipped, confirmed: true, read_back: rb.json.read_back });
      ok(re.json.confirm_needed === true && /That read_back isn't for this plan/.test(re.text) && re.text.includes('Changed in "Nurse, top up": nurse 8–12 min (was 8–12 min each side).'), re.text);
      eq(feedingPlanOf(await settings(A))?.rev, 2, "nothing saved");
    });

    await test(`${shape}: a read-back asks with it about a night in the daytime, a long night and a feed nothing turns to; questions, never refusals`, async () => {
      const ask = async (plan: unknown) => (await tool(beta.owner, B, "set_feeding_plan", { plan, target: [50, 70] })).text.split("\n{")[0];
      // "11" and "1" read as 11 AM to 1 AM: 14 hours, so it isn't refused as too long, only asked about.
      const day = await ask({ ...INPUT, night: { ...INPUT.night, from: "11:00", to: "1:00" } });
      ok(day.includes('Ask with it: night would start at 11 AM, in the daytime. If they meant 11 PM, send night.from as "23:00".'), day);
      const long = await ask({ ...INPUT, night: { ...INPUT.night, from: "18:00", to: "8 AM" } });
      ok(long.includes("Ask with it: night would run 14 hours (6 PM to 8 AM). Check that's what their plan says."), long);
      // The night's feed left out, with the day's turns given: it's in neither.
      const left = await ask({ ...INPUT, order: ["Nurse + SNS", "Nurse, top up"], night: { ...INPUT.night, feed: null } });
      ok(left.includes('Ask with it: "Pump + bottle" isn\'t in the day\'s turns or the night\'s feed, so Today only offers it as another choice. If it\'s the night\'s feed, set night.feed to it; if it takes a turn by day, add it to order.'), left);
      ok(!/Ask with it/.test(await ask(INPUT)), "none for a plan without them");
      ok(!("feeding_plan" in (await settings(B))), "nothing saved");
    });

    await test(`${shape}: a plan that can't be saved comes back in feeding-plan.ts's own words; a number in the wrong place is refused, never dropped`, async () => {
      const pump = await tool(alpha.owner, A, "set_feeding_plan", { plan: { feeds: [{ name: "A", steps: [{ do: "pump", minutes: 500 }] }] }, base_rev: 2 });
      ok(pump.error && pump.text.startsWith('"A" step 1: the minutes must be between 1 and 120. Nothing was saved'), pump.text);
      const twice = await tool(alpha.owner, A, "set_feeding_plan", { plan: { feeds: [{ name: "A", steps: [{ do: "nurse" }, { do: "nurse" }] }] }, base_rev: 2 });
      ok(twice.error && /"A" nurses once; put both sides in one step \(each side\)/.test(twice.text), twice.text);
      const stray = await tool(alpha.owner, A, "set_feeding_plan", { plan: { feeds: [{ name: "Nurse + SNS", steps: [{ do: "nurse", minutes: 15, ml: 20 }] }] }, base_rev: 2 });
      ok(stray.error && /"Nurse \+ SNS" step 1: ml isn't a nurse step's \(.*supplement/.test(stray.text), stray.text);
      const target = await tool(alpha.owner, A, "set_feeding_plan", { plan: INPUT, target: 900, base_rev: 2 });
      ok(target.error && /A target per feed is between 5 and 300 ml/.test(target.text), target.text);
      const inside = await tool(alpha.owner, A, "set_feeding_plan", { plan: { ...INPUT, target: [50, 70] }, base_rev: 2 });
      ok(inside.error && /^target isn't part of a plan \(the target per feed goes beside the plan, as target;/.test(inside.text), inside.text);
      const feedLevel = await tool(alpha.owner, A, "set_feeding_plan", { plan: { feeds: [{ name: "A", every: 180, steps: [{ do: "pump" }] }] }, base_rev: 2 });
      ok(feedLevel.error && /^"A": every isn't part of a feed/.test(feedLevel.text), feedLevel.text);
      eq(feedingPlanOf(await settings(A))?.rev, 2, "nothing saved");
    });

    await test(`${shape}: a viewer reads the plan but can't save it; a photos-only guest reaches neither`, async () => {
      ok(!(await tool(alpha.viewer, A, "feeding_plan")).error, "a viewer reads it");
      const write = await tool(alpha.viewer, A, "set_feeding_plan", { plan: INPUT });
      ok(write.error && /You're a viewer on Maple's Log/.test(write.text), write.text);
      for (const name of ["feeding_plan", "set_feeding_plan"]) ok((await tool(photo, A, name, name === "feeding_plan" ? {} : { plan: INPUT })).error, `${name}: photos-only`);
      eq(feedingPlanOf(await settings(A))?.rev, 2, "nothing saved");
    });

    await test(`${shape}: once saved, maple_status, the chat's [App] lines and Siri say the plan's next feed, in its words`, async () => {
      const status = await tool(alpha.owner, A, "maple_status");
      const fp = status.json.feeding_plan as Record<string, unknown>;
      eq([fp.state, fp.feed, fp.due, fp.steps_left, fp.more], ["upcoming", "Nurse + SNS", null, ["Nurse 12–18 min, 20 ml of formula in the SNS", "Pump 15 min"], "feeding_plan"], "maple_status's field");
      const line = 'Feeding plan: next is "Nurse + SNS": nurse 12–18 min, 20 ml of formula in the SNS; then pump 15 min.';
      ok(status.text.split("\n").includes(line), status.text);
      const app = await chatLogState({ email: alpha.member }, { fam: A, care: true, now: new Date() });
      ok(app.includes(line), `the [App] line: ${app.join(" | ")}`);
      eq((await chatLogState({ email: alpha.viewer }, { fam: A, care: false, now: new Date() })).includes(line), true, "a viewer's chat has it too");
      const speak = (await siri(alpha.token, { action: "status" })).speak ?? "";
      ok(speak.includes("Next from the feeding plan: Nurse + SNS."), speak);
    });

    await test(`${shape}: start_timer with a plan feed tags the feed (and brings its nipple shield); the plan reads it underway, step by step`, async () => {
      const r = await tool(alpha.member, A, "start_timer", { timer: "nursing", side: "left", plan: "Nurse + SNS", minutes_ago: 10 });
      ok(!r.error && /for the feeding plan's "Nurse \+ SNS"/.test(r.text), r.text);
      const id = Number(r.json.id);
      const row = (await sql(`SELECT data FROM maple_entries WHERE id = $1`, [id]))[0].data as Record<string, unknown>;
      const plan = feedingPlanOf(await settings(A))!;
      eq([row.plan, row.shield], [plan.feeds[0].id, undefined], "tagged; this feed has no shield");
      const now = await tool(alpha.member, A, "feeding_plan");
      // While she's on, the SNS milk not given yet is said with it: the card's one action then.
      ok(now.text.includes("Underway: \"Nurse + SNS\" (started from the plan, since 11:50 AM).") && now.text.includes("- Nurse 12–18 min, 20 ml of formula in the SNS (going now, 10 min so far, the 20 ml in the SNS not logged yet)") && now.text.includes("- Pump 15 min (not logged yet)"), now.text);
      const status = await tool(alpha.member, A, "maple_status");
      ok(status.text.includes('Feeding plan: "Nurse + SNS" is underway since 11:50 AM. Going now: nurse 12–18 min, 20 ml of formula in the SNS (10 min so far); not logged yet: the 20 ml in the SNS. Next: pump 15 min. After it: "Nurse, top up"; next feed 2:20 PM–3:20 PM, in 2h 20m.'), status.text);
      eq((status.json.feeding_plan as { steps_left?: unknown }).steps_left, ["Nurse 12–18 min, 20 ml of formula in the SNS (going now; the 20 ml in the SNS not logged yet)", "Pump 15 min"], "maple_status's steps left");
      ok(/From the feeding plan: Nurse \+ SNS is underway; still to do: the 20 ml in the SNS, then pump 15 min\./.test((await siri(alpha.token, { action: "status" })).speak ?? ""), "Siri: what's left, the SNS milk first");
      // "It's the top-up one": start_timer with that plan feed while this one runs says how to make it that feed.
      const other = await tool(alpha.member, A, "start_timer", { timer: "nursing", plan: "Nurse, top up" });
      ok(other.text.includes(`No second timer was started, and the running feed kept its own plan feed and shield. To make the running feed the feeding plan's "Nurse, top up", update_entry ${id} with details {plan: "Nurse, top up"}.`), other.text);
      ok(!/To make the running feed/.test((await tool(alpha.member, A, "start_timer", { timer: "nursing", plan: "Nurse + SNS" })).text), "the same plan feed: nothing to change");
      // Its SNS milk logged while she's still on: milk at the breast, part of this feed, said as given, never a top-up or a feed.
      const sns = await tool(alpha.member, A, "log_feed", { method: "bottle", amount: 20, unit: "ml", via: "sns", milk: "formula", minutes_ago: 4 });
      ok(sns.text.includes("Counted with the feed that began at 11:50 AM today: milk at the breast, part of that feed, not a feed of its own.") && sns.text.includes("(with 0.68 oz (20 ml) in the SNS)"), sns.text);
      const lines = await chatLogState({ email: alpha.member }, { fam: A, care: true, now: new Date() });
      // The day's line says it as milk at the breast, and its formula never "by bottle".
      ok(lines.some((l) => l.startsWith("Today so far: 1 feed (0.68 oz (20 ml) in the SNS)")) && !lines.some((l) => /formula by bottle/.test(l)), lines.join(" | "));
      ok(lines.some((l) => l.startsWith("Nursing on the left since 11:50 AM") && l.endsWith("Given with it so far: 0.68 oz (20 ml) in the SNS at 11:56 AM.")), lines.join(" | "));
      ok(lines.some((l) => l.includes("Going now: nurse 12–18 min, 20 ml of formula in the SNS (10 min so far, 20 ml in the SNS at 11:56 AM).")), lines.join(" | "));
      ok((await tool(alpha.member, A, "feeding_plan")).text.includes("- Nurse 12–18 min, 20 ml of formula in the SNS (going now, 10 min so far, 20 ml in the SNS at 11:56 AM)"), "feeding_plan says it was given");
      const since = await tool(alpha.member, A, "maple_status", { since: "11:00am" });
      ok(/^Since 11:00 AM today \(1h 00m\): no feeds logged/m.test(since.text), since.text);
      await sql(`UPDATE maple_entries SET deleted_at = NOW() WHERE id = $1`, [Number(sns.json.id)]);
      eq((await tool(alpha.member, A, "stop_timer", { timer: "nursing" })).error, false, "stopped");
      // Done nursing, the SNS milk not logged: said calmly, and the pump still to do.
      const done = await tool(alpha.member, A, "feeding_plan");
      ok(done.text.includes("- Nurse 12–18 min, 20 ml of formula in the SNS (nursed 10 min; the 20 ml in the SNS isn't logged)"), done.text);
      // A plan feed whose nursing has the shield brings it unless told otherwise.
      const shieldPlan = { feeds: [{ name: "Shield, then pump", steps: [{ do: "nurse", minutes: [12, 20], shield: true }, { do: "pump", minutes: 15 }] }] };
      eq((await save(beta.owner, B, { plan: shieldPlan })).json.saved, true, "Beta's plan");
      const started = await tool(beta.owner, B, "start_timer", { timer: "nursing", side: "right", plan: "shield, then pump" });
      ok(/on the right with the nipple shield at/.test(started.text), started.text);
      const data = (await sql(`SELECT data FROM maple_entries WHERE id = $1`, [Number(started.json.id)]))[0].data as Record<string, unknown>;
      eq([data.shield, typeof data.plan], [true, "string"], "shield and plan saved");
      ok(/Nursing with the nipple shield, on the right since/.test((await tool(beta.owner, B, "maple_status")).text), "the running timer says the shield");
      await tool(beta.owner, B, "stop_timer", { timer: "nursing" });
      const unknown = await tool(beta.owner, B, "start_timer", { timer: "nursing", side: "left", plan: "Nurse + SNS" });
      ok(unknown.error && /"Nurse \+ SNS" isn't a feed in the feeding plan\. Its feeds: "Shield, then pump"/.test(unknown.text), unknown.text);
      const sleepy = await tool(beta.owner, B, "start_timer", { timer: "sleep", shield: true });
      ok(sleepy.error && /shield and plan are for a nursing timer/.test(sleepy.text), sleepy.text);
    });

    await test(`${shape}: log_feed takes a plan feed and a late top-up's feed, so the top-up is that feed's and Last fed stays put`, async () => {
      // A clean morning: the feed before is set aside.
      await sql(`UPDATE maple_entries SET deleted_at = NOW() WHERE family_id = $1 AND started_at > NOW() - INTERVAL '1 day'`, [A]);
      const fed = await tool(alpha.owner, A, "log_feed", { method: "breast", left_minutes: 10, right_minutes: 10, first_side: "left", plan: "Nurse, top up", minutes_ago: 120 });
      ok(!fed.error, fed.text);
      const nursingId = Number(fed.json.id);
      eq((await sql(`SELECT data->>'plan' AS plan FROM maple_entries WHERE id = $1`, [nursingId]))[0].plan, feedingPlanOf(await settings(A))!.feeds[1].id, "tagged by its name");
      const owed = (await tool(alpha.owner, A, "feeding_plan")).json.now as { top_up_of?: number };
      eq(owed.top_up_of, nursingId, "feeding_plan names the feed a top-up given now is for");
      // The chat's [App] line carries that feed's id with the step it says wasn't logged, as the timer line carries its own.
      const line = (await chatLogState({ email: alpha.owner }, { fam: A, care: true, now: new Date() })).find((l) => l.startsWith("Feeding plan:")) ?? "";
      ok(line.includes(`From the 10:00 AM feed ("Nurse, top up"), not logged: top up 35–45 ml, formula or breast milk, paced bottle [entry #${nursingId}].`), line);
      // An hour after it ended, past the 30 minutes a top-up is that feed's by its time: with top_up_of it still is.
      const late = await tool(alpha.owner, A, "log_feed", { method: "bottle", amount: 30, unit: "ml", via: "paced", top_up_of: nursingId, minutes_ago: 40 });
      ok(!late.error && /Counted as a top-up to the feed that began at 10:00 AM today/.test(late.text), late.text);
      const status = await tool(alpha.owner, A, "maple_status");
      const fp = status.json.feeding_plan as Record<string, unknown>;
      eq([fp.state, fp.feed, fp.missed], ["upcoming", "Nurse + SNS", undefined], "the top-up feed is done, nothing missed");
      ok(String(fp.due).startsWith("Next feed 12:30 PM–1:30 PM"), `due from the 10:00 feed, not the top-up: ${fp.due}`);
      ok(/^Last feed: nursed at 10:00 AM today \(2h 00m ago\): L 10m, R 10m, started on the left, with a 1\.01 oz \(30 ml\) top-up\.$/m.test(status.text), status.text);
      // A feed logged before can be given its nipple shield and plan feed afterwards (by the feed's name), and a bottle its via.
      const fix = await tool(alpha.owner, A, "update_entry", { id: nursingId, details: { shield: true, plan: "Nurse + SNS" } });
      ok(!fix.error, fix.text);
      const fixed = (await sql(`SELECT data FROM maple_entries WHERE id = $1`, [nursingId]))[0].data as Record<string, unknown>;
      eq([fixed.shield, fixed.plan], [true, feedingPlanOf(await settings(A))!.feeds[0].id], "update_entry: shield and plan");
      const via = await tool(alpha.owner, A, "update_entry", { id: Number(late.json.id), details: { via: "syringe" } });
      ok(!via.error && (await sql(`SELECT data->>'via' AS via FROM maple_entries WHERE id = $1`, [Number(late.json.id)]))[0].via === "syringe", via.text);
      const badPlan = await tool(alpha.owner, A, "update_entry", { id: nursingId, details: { plan: "No such feed" } });
      ok(badPlan.error && /"No such feed" isn't a feed in the feeding plan/.test(badPlan.text), badPlan.text);
      const bad = await tool(alpha.owner, A, "log_feed", { method: "bottle", amount: 30, unit: "ml", top_up_of: 999999 });
      ok(bad.error && /top_up_of 999999 isn't a nursing feed in this log/.test(bad.text), bad.text);
      const shieldBottle = await tool(alpha.owner, A, "log_feed", { method: "bottle", amount: 30, unit: "ml", shield: true });
      ok(shieldBottle.error && /shield is for nursing/.test(shieldBottle.text), shieldBottle.text);
    });

    await test(`${shape}: a bottle with no feed named is the late top-up the plan still owes the feed before, from log_feed and Siri; not past 90 minutes`, async () => {
      const wipe = () => sql(`UPDATE maple_entries SET deleted_at = NOW() WHERE family_id = $1 AND deleted_at IS NULL`, [A]);
      await wipe();
      // "Nurse, top up" from 10:40 to 11:00, its top-up not given: a paced bottle at noon, an hour on (past 30 minutes by its time).
      const fed = await tool(alpha.owner, A, "log_feed", { method: "breast", left_minutes: 10, right_minutes: 10, first_side: "left", plan: "Nurse, top up", minutes_ago: 80 });
      const nursingId = Number(fed.json.id);
      const late = await tool(alpha.owner, A, "log_feed", { method: "bottle", amount: 30, unit: "ml", via: "paced" });
      ok(late.text.includes("Counted as a top-up to the feed that began at 10:40 AM today: part of that feed, not a feed of its own."), late.text);
      ok(late.text.includes(`The feeding plan's 10:40 AM feed ("Nurse, top up") still had its top-up to log, so this was saved with that feed [entry #${nursingId}]. If it was a feed of its own, update_entry it with details {top_up_of: null}.`), late.text);
      eq((await sql(`SELECT (data->>'top_up_of')::int AS of FROM maple_entries WHERE id = $1`, [Number(late.json.id)]))[0].of, nursingId, "saved with that feed");
      const status = await tool(alpha.owner, A, "maple_status");
      ok(/^Last feed: nursed at 10:40 AM today \(1h 20m ago\): L 10m, R 10m, started on the left, with a 1\.01 oz \(30 ml\) top-up\.$/m.test(status.text), status.text);
      // Undone with update_entry, it's a feed of its own again.
      const undo = await tool(alpha.owner, A, "update_entry", { id: Number(late.json.id), details: { top_up_of: null } });
      ok(!undo.error && (await sql(`SELECT data ? 'top_up_of' AS has FROM maple_entries WHERE id = $1`, [Number(late.json.id)]))[0].has === false, undo.text);
      await sql(`UPDATE maple_entries SET deleted_at = NOW() WHERE id = $1`, [Number(late.json.id)]);
      // Siri's bottle in the same spot says whose top-up it is, and saves it so.
      const spoken = await siri(alpha.token, { action: "bottle", amount_oz: 1 });
      ok(spoken.speak === "Logged a 1 ounce bottle at 12:00 PM, a top-up for the 10:40 AM feed.", spoken.speak ?? "");
      eq((await sql(`SELECT (data->>'top_up_of')::int AS of FROM maple_entries WHERE family_id = $1 AND deleted_at IS NULL AND data->>'method' = 'bottle'`, [A]))[0]?.of, nursingId, "Siri's too");
      // A feed with a re-latch is named by its first nursing, as Today's card names it, though the link names the newest nursing.
      await wipe();
      const first = await tool(alpha.owner, A, "log_feed", { method: "breast", left_minutes: 10, right_minutes: 10, first_side: "left", plan: "Nurse, top up", at: "10:00am" });
      const relatch = await tool(alpha.owner, A, "log_feed", { method: "breast", left_minutes: 10, first_side: "left", at: "10:40am" });
      void first;
      const named = await tool(alpha.owner, A, "log_feed", { method: "bottle", amount: 30, unit: "ml", via: "paced" });
      ok(named.text.includes("Counted as a top-up to the feed that began at 10:00 AM today: part of that feed, not a feed of its own."), named.text);
      ok(named.text.includes(`The feeding plan's 10:00 AM feed ("Nurse, top up") still had its top-up to log, so this was saved with that feed [entry #${Number(relatch.json.id)}].`), named.text);
      // Milk the plan counts as a feed's milk at the breast, given later by Siri's bottle: for that feed, never "a top-up".
      await wipe();
      await tool(alpha.owner, A, "log_feed", { method: "breast", left_minutes: 12, first_side: "left", plan: "Nurse + SNS", minutes_ago: 52 });
      eq((await siri(alpha.token, { action: "bottle", amount_oz: 0.6 })).speak, "Logged a 0.6 ounce bottle at 12:00 PM, for the 11:08 AM feed.", "Siri: milk at the breast");
      // Over 90 minutes after the nursing ended, a bottle is a feed of its own, and by day (the day's feeds all nurse) no plan feed's.
      await wipe();
      await tool(alpha.owner, A, "log_feed", { method: "breast", left_minutes: 10, right_minutes: 10, first_side: "left", plan: "Nurse, top up", minutes_ago: 115 });
      const later = await tool(alpha.owner, A, "log_feed", { method: "bottle", amount: 30, unit: "ml", via: "paced" });
      ok(!/still had its/.test(later.text) && !/Counted as a top-up/.test(later.text) && !/feeding plan/.test(later.text), later.text);
      eq((await sql(`SELECT data ? 'plan' AS has FROM maple_entries WHERE id = $1`, [Number(later.json.id)]))[0].has, false, "no plan feed by day");
      await wipe();
    });

    await test(`${shape}: the night's pump, then its bottle and formula to finish, logged with no feed named (log_feed, log_many, Siri): saved with the plan feed, one feed, Last fed at the first bottle`, async () => {
      const wipe = () => sql(`UPDATE maple_entries SET deleted_at = NOW() WHERE family_id = $1 AND deleted_at IS NULL`, [A]);
      const night = feedingPlanOf(await settings(A))!.feeds.find((f) => f.name === "Pump + bottle")!.id;
      const planOf = async (id: unknown) => (await sql(`SELECT data->>'plan' AS plan FROM maple_entries WHERE id = $1`, [Number(id)]))[0].plan;
      const lastFed = async () => (await tool(alpha.owner, A, "maple_status")).text.split("\n").find((l) => l.startsWith("Last feed:")) ?? "";
      const tz = "America/Chicago";
      // The chat: the pump, then 35 ml of pumped milk, then 20 ml of formula to finish, as a model logs them.
      await atClock(localInstant(tz, "01:40", "2026-11-05"), async () => {
        await wipe();
        await tool(alpha.owner, A, "log_pump", { duration_minutes: 20, at: "1:00am" });
        const milk = await tool(alpha.owner, A, "log_feed", { method: "bottle", amount: 35, unit: "ml", milk: "breastmilk", at: "1:25am" });
        ok(milk.text.includes(`The feeding plan's "Pump + bottle" was underway (its pump logged), so this was saved as that feed's bottle. If it wasn't, update_entry it with details {plan: null}.`), milk.text);
        const formula = await tool(alpha.owner, A, "log_feed", { method: "bottle", amount: 20, unit: "ml", milk: "formula", at: "1:35am" });
        ok(formula.text.includes(`The feeding plan's 1:25 AM feed ("Pump + bottle") still had its formula to finish to give, so this was saved with that feed: part of it, not a feed of its own.`) && /^Feeds today: 1\b/m.test(formula.text), formula.text);
        eq([await planOf(milk.json.id), await planOf(formula.json.id)], [night, night], "both saved with the night feed");
        // Last fed at the first bottle; with the log's later bottles of a bottle feed (feed.ts LastFed's more), both, added up.
        ok(
          /^Last feed: (1\.18 oz \(35 ml\) bottle of breast milk|1\.86 oz \(55 ml\) by bottle \(1\.18 oz \(35 ml\) breast milk \+ 0\.68 oz \(20 ml\) formula\), one feed,) at 1:25 AM today/.test(await lastFed()),
          await lastFed()
        );
        // The same sent again (a retry) is the same save, read as the first was.
        const again = await tool(alpha.owner, A, "log_feed", { method: "bottle", amount: 20, unit: "ml", milk: "formula", at: "1:35am" });
        ok(again.json.deduped === true || again.json.created === false, again.text);
        // log_many: the same night in one message.
        await wipe();
        const many = await tool(alpha.owner, A, "log_many", {
          entries: [
            { kind: "pump", at: "1:00am", duration_minutes: 20 },
            { kind: "bottle", at: "1:25am", amount: 35, unit: "ml", milk: "breastmilk" },
            { kind: "bottle", at: "1:35am", amount: 20, unit: "ml", milk: "formula" },
          ],
        });
        ok(/^3 of 3 saved/.test(many.text) && many.text.includes("still had its formula to finish to give, so this was saved with that feed: part of it") && /^Feeds today: 1\b/m.test(many.text), many.text);
        ok(/ at 1:25 AM today/.test(await lastFed()), await lastFed());
      });
      // Siri: the pump, then "log a bottle" twice.
      await atClock(localInstant(tz, "01:25", "2026-11-05"), async () => {
        await wipe();
        await tool(alpha.owner, A, "log_pump", { duration_minutes: 20, at: "1:00am" });
        eq((await siri(alpha.token, { action: "bottle", amount_oz: 1.2 })).speak, "Logged a 1.2 ounce bottle at 1:25 AM, for the feeding plan's Pump + bottle.");
      });
      await atClock(localInstant(tz, "01:35", "2026-11-05"), async () => {
        eq((await siri(alpha.token, { action: "bottle", amount_oz: 0.7 })).speak, "Logged a 0.7 ounce bottle at 1:35 AM, for the 1:25 AM feed.");
        const rows = await sql(`SELECT data->>'plan' AS plan FROM maple_entries WHERE family_id = $1 AND deleted_at IS NULL AND kind = 'feed' ORDER BY started_at`, [A]);
        eq(rows.map((r) => r.plan), [night, night], "Siri's too");
        ok(/ at 1:25 AM today/.test(await lastFed()) && /^Today so far: 1 feed\b/m.test((await tool(alpha.owner, A, "maple_status")).text), await lastFed());
      });
      // The night's next feed begun with its bottle (no pump yet): that feed's. A bottle after its full bottle isn't one it still wants.
      await atClock(localInstant(tz, "04:30", "2026-11-05"), async () => {
        const next = await tool(alpha.owner, A, "log_feed", { method: "bottle", amount: 60, unit: "ml", milk: "breastmilk" });
        ok(next.text.includes(`The feeding plan reads this as its next feed, "Pump + bottle", so it was saved as that feed.`), next.text);
        eq(await planOf(next.json.id), night, "the next night feed");
      });
      await atClock(localInstant(tz, "04:45", "2026-11-05"), async () => {
        const more = await tool(alpha.owner, A, "log_feed", { method: "bottle", amount: 15, unit: "ml", milk: "formula" });
        ok(!more.error && !/feeding plan/.test(more.text), more.text);
        eq(await planOf(more.json.id), null, "not owed: no plan feed");
      });
      await wipe();
    });

    await test(`${shape}: two phones saying yes at once to changes from the same revision: one saves, the other is told it changed`, async () => {
      const read = await tool(alpha.owner, A, "feeding_plan");
      const p = read.json.plan as Record<string, unknown>;
      const rev = read.json.rev as number;
      const args = (notes: string) => ({ plan: { ...p, notes }, target: read.json.target, base_rev: rev });
      const ownerRead = await tool(alpha.owner, A, "set_feeding_plan", args("Weigh on Wednesday"));
      const memberRead = await tool(alpha.member, A, "set_feeding_plan", args("Weigh on Thursday"));
      const both = await Promise.all([
        tool(alpha.owner, A, "set_feeding_plan", { ...args("Weigh on Wednesday"), confirmed: true, read_back: ownerRead.json.read_back }),
        tool(alpha.member, A, "set_feeding_plan", { ...args("Weigh on Thursday"), confirmed: true, read_back: memberRead.json.read_back }),
      ]);
      const saved = both.filter((r) => r.json.saved === true).length;
      const told = both.filter((r) => r.error && /^Nothing was saved: the feeding plan was changed/.test(r.text)).length;
      eq([saved, told], [1, 1], `one saves, one is told: ${both.map((r) => r.text.split("\n")[0]).join(" | ")}`);
      eq(feedingPlanOf(await settings(A))?.rev, rev + 1, "one new revision");
      // The store itself refuses a plan save begun from a revision that's no longer stored, however it got there.
      const { updateBaby, SettingsChanged } = await import("../../src/lib/maple/store");
      const babyId = Number((await sql(`SELECT id FROM maple_babies WHERE family_id = $1`, [A]))[0].id);
      const stale = await updateBaby(A, babyId, { settings: { feeding_plan: null }, expect: { planRev: rev } }).then(
        () => "saved",
        (e) => (e instanceof SettingsChanged ? `refused, rev ${feedingPlanOf(e.baby.settings)?.rev}` : String(e))
      );
      eq(stale, `refused, rev ${rev + 1}`, "a stale expect is refused with the plan as it is");
      eq(feedingPlanOf(await settings(A))?.rev, rev + 1, "still there");
    });

    await test(`${shape}: undo_last after a plan save removes nothing and says why`, async () => {
      await tool(alpha.owner, A, "log_diaper", { diaper: "wet" });
      const plan = (await tool(alpha.owner, A, "feeding_plan")).json;
      const p = plan.plan as Record<string, unknown>;
      // A yes that leaves out the saved target it was read back with is the same plan and target: it saves.
      const args = { plan: { ...p, notes: "Weigh on Friday" }, base_rev: plan.rev };
      const rb = await tool(alpha.owner, A, "set_feeding_plan", { ...args, target: plan.target });
      const yes = await tool(alpha.owner, A, "set_feeding_plan", { ...args, confirmed: true, read_back: rb.json.read_back });
      eq(yes.json.saved, true, `saved: ${yes.text}`);
      const undo = await tool(alpha.owner, A, "undo_last");
      ok(undo.error && /^Nothing was removed\. The newest change was the feeding plan, saved at 12:00 PM/.test(undo.text), undo.text);
    });

    await test(`${shape}: remove reads back first; with its token the plan goes and the target per feed stays`, async () => {
      const first = await tool(alpha.owner, A, "set_feeding_plan", { remove: true });
      ok(first.json.confirm_needed === true && first.text.startsWith("Not removed yet: say yes to remove the plan.") && /remove the feeding plan from Feeding clinic \("Nurse \+ SNS", "Nurse, top up", "Pump \+ bottle"\)/.test(first.text), first.text);
      ok(/The target per feed \(50–70 ml\) stays, for bottles\./.test(first.text), "the target stays");
      eq("feeding_plan" in (await settings(A)), true, "not yet");
      const gone = await tool(alpha.owner, A, "set_feeding_plan", { remove: true, confirmed: true, read_back: first.json.read_back });
      ok(!gone.error && gone.json.removed === true && gone.text.startsWith("Removed the feeding plan."), gone.text);
      const after = await settings(A);
      eq(["feeding_plan" in after, targetOf(after)], [false, [50, 70]], "the plan's gone, the target stays");
      const again = await tool(alpha.owner, A, "set_feeding_plan", { remove: true });
      ok(again.error && /nothing to remove/.test(again.text), again.text);
    });

    await test(`${shape}: families stay apart: one's plan and token never reach the other; the read-back speaks of each baby in its family's words`, async () => {
      // Beta's plan is its own; Alpha (none now) reads none.
      ok(/^There's no feeding plan saved/.test((await tool(alpha.owner, A, "feeding_plan")).text), "Alpha has none");
      ok((await tool(beta.member, B, "feeding_plan")).text.includes("• Shield, then pump: Nurse 12–20 min with the nipple shield; then pump 15 min"), "Beta reads its own");
      // A token Alpha's owner was given saves nothing in Beta.
      const wake = { ...INPUT, day: { every: [150, 210], wake: true } };
      const alphaRead = await tool(alpha.owner, A, "set_feeding_plan", { plan: wake });
      const cross = await tool(beta.owner, B, "set_feeding_plan", { plan: wake, base_rev: 1, confirmed: true, read_back: alphaRead.json.read_back });
      ok(cross.json.confirm_needed === true, "another family's token reads back again");
      ok(cross.text.includes("Day: every 2.5–3.5 hours, waking him if he's asleep") && cross.text.includes("Night (11 PM–5 AM): every 3 hours, waking him: Pump + bottle"), "Beta's boy is him");
      eq(feedingPlanOf(await settings(B))?.feeds.map((f) => f.name), ["Shield, then pump"], "Beta's plan unchanged");
      // With no plan saved, no plan links a bottle to the feed before it (how the log itself counts one is feed.ts's rule).
      await tool(alpha.owner, A, "log_feed", { method: "breast", left_minutes: 10, right_minutes: 10, first_side: "left", minutes_ago: 80 });
      const own = await tool(alpha.owner, A, "log_feed", { method: "bottle", amount: 30, unit: "ml", via: "paced" });
      ok(!/still had its/.test(own.text) && !(await sql(`SELECT data ? 'top_up_of' OR data ? 'plan' AS has FROM maple_entries WHERE id = $1`, [Number(own.json.id)]))[0].has, own.text);
    });

    await test(`${shape}: an edit that takes out what a feed's name says (the shield of "Shield, then pump") asks if they'd like to rename it, as the form does`, async () => {
      const read = await tool(beta.owner, B, "feeding_plan");
      const p = read.json.plan as { feeds: { id: string; name: string; steps: Record<string, unknown>[] }[] };
      const back = async (feeds: unknown) => (await tool(beta.owner, B, "set_feeding_plan", { plan: { ...p, feeds }, base_rev: read.json.rev })).text.split("\n{")[0];
      const noShield = p.feeds.map((f) => ({ ...f, steps: [{ do: "nurse", minutes: [12, 20] }, f.steps[1]] }));
      const asked = await back(noShield);
      ok(asked.includes('Changed in "Shield, then pump": no nipple shield (was with it).'), asked);
      ok(asked.includes('Ask with it: "Shield, then pump" still says "shield", and its steps no longer use the nipple shield; Today shows that name as the feed\'s title. Ask if they\'d like to rename it.'), asked);
      // The pump taken out too: both words, in one question.
      const both = await back(p.feeds.map((f) => ({ ...f, steps: [{ do: "nurse", minutes: [12, 20] }] })));
      ok(both.includes('Ask with it: "Shield, then pump" still says "shield" and "pump", and its steps no longer use the nipple shield or a pump;'), both);
      // Renamed in the same edit, or a name that says it's without it: nothing to ask.
      ok(!/Ask with it/.test(await back(noShield.map((f) => ({ ...f, name: "Nurse, then pump" })))), "renamed");
      ok(!/Ask with it/.test(await back(noShield.map((f) => ({ ...f, name: "No shield, then pump" })))), "a name that says it's without it");
      eq(feedingPlanOf(await settings(B))?.feeds[0].steps[0], { do: "nurse", minutes: { min: 12, max: 20 }, shield: true }, "nothing saved");
    });

    await test(`${shape}: ounces as the care team wrote them, read back in ounces, and sent back without drift`, async () => {
      const oz = { amounts_in: "oz", feeds: [{ name: "Bottle", steps: [{ do: "bottle", ml: [1, 1.5], milk: "formula" }] }] };
      const saved = await save(alpha.owner, A, { plan: oz, target: [2, 2.5] });
      ok(saved.json.saved === true && /with a target of 2–2\.5 oz a feed/.test(saved.text), saved.text);
      const read = await tool(alpha.owner, A, "feeding_plan");
      ok(read.text.includes("• Bottle: Bottle 1–1.5 oz, formula") && read.text.includes("Target: 2–2.5 oz a feed"), read.text);
      const p = read.json.plan as { amounts_in: string; feeds: { steps: unknown[] }[] };
      eq([p.amounts_in, p.feeds[0].steps[0], read.json.target], ["oz", { do: "bottle", ml: [1, 1.5], milk: "formula" }, [2, 2.5]], "in ounces");
      const same = await tool(alpha.owner, A, "set_feeding_plan", { plan: p, target: read.json.target, base_rev: read.json.rev });
      ok(same.json.unchanged === true, "sent back as read: nothing to change, nothing drifted");
    });

    await test(`${shape}: only if needed, on demand, one side and the night's turns: read back in the plan's words, saved, sent back as read; start_timer takes the plan's side`, async () => {
      // Invented: on demand by day, at least every 3 hours, waking her; at night (11 PM to 5 AM) on demand at least every
      // 3.5 hours, the night's feeds taking turns.
      const WAVE = {
        from: "Feeding clinic",
        day: { every: { max: 180 }, wake: true },
        night: { from: "11 PM", to: "5:00", every: [0, 210], order: ["Pump + bottle", "Left, pump the right"] },
        feeds: [
          { name: "Left, pump the right", steps: [{ do: "nurse", minutes: [15, 20], side: "left" }, { do: "pump", minutes: 15 }] },
          { name: "Nurse, top up if hungry", steps: [{ do: "nurse", minutes: [8, 12], each_side: true }, { do: "bottle", ml: [25, 35], via: "paced", if_needed: true }, { do: "pump", minutes: 10, if_needed: true }] },
          { name: "Pump + bottle", steps: [{ do: "pump", minutes: 20 }, { do: "bottle", milk: "breastmilk_first", to_target: true }] },
        ],
        order: ["Nurse, top up if hungry", "Left, pump the right"],
      };
      const base_rev = feedingPlanOf(await settings(A))!.rev;
      const rb = await tool(alpha.owner, A, "set_feeding_plan", { plan: WAVE, target: [50, 70], base_rev });
      ok(!rb.error && rb.json.confirm_needed === true, rb.text);
      for (const line of [
        "Day: on demand, at least every 3 hours, waking her if she's asleep, taking turns: Nurse, top up if hungry, then Left, pump the right",
        "Left, pump the right: Nurse 15–20 min on the left; then pump 15 min",
        "Nurse, top up if hungry: Nurse 8–12 min each side; then top up 25–35 ml if still hungry, paced bottle; then pump 10 min if needed",
        "Night (11 PM–5 AM): on demand, at least every 3.5 hours, taking turns: Pump + bottle, then Left, pump the right",
      ]) {
        ok(rb.text.includes(line), `reads back "${line}": ${rb.text}`);
      }
      const saved = await tool(alpha.owner, A, "set_feeding_plan", { plan: WAVE, target: [50, 70], base_rev, confirmed: true, read_back: rb.json.read_back });
      ok(saved.json.saved === true, saved.text);
      const stored = feedingPlanOf(await settings(A))!;
      const [left, hungry, night] = stored.feeds;
      eq(
        [stored.day, stored.night, left.steps[0], hungry.steps[1], hungry.steps[2]],
        [
          { every: { min: 180, max: 180 }, on_demand: true, wake: true },
          { from: "23:00", to: "05:00", every: { min: 210, max: 210 }, on_demand: true, feed: night.id, order: [night.id, left.id] },
          { do: "nurse", minutes: { min: 15, max: 20 }, side: "L" },
          { do: "bottle", ml: { min: 25, max: 35 }, via: "paced", if_needed: true },
          { do: "pump", minutes: { min: 10, max: 10 }, if_needed: true },
        ],
        "stored as the plan's own keys, the night's feed its first turn"
      );
      // In set_feeding_plan's shape: on demand as {max}, the side by name, the night's turns by id; sent back, nothing changes.
      const read = await tool(alpha.owner, A, "feeding_plan");
      const p = read.json.plan as { day: unknown; night: unknown; feeds: { steps: unknown[] }[] };
      eq(
        [p.day, p.night, p.feeds[0].steps[0], p.feeds[1].steps[1]],
        [
          { every: { max: 180 }, wake: true },
          { from: "23:00", to: "05:00", every: { max: 210 }, order: [night.id, left.id] },
          { do: "nurse", minutes: [15, 20], side: "left" },
          { do: "bottle", ml: [25, 35], via: "paced", if_needed: true },
        ],
        "the plan as set_feeding_plan takes it"
      );
      const same = await tool(alpha.owner, A, "set_feeding_plan", { plan: p, target: read.json.target, base_rev: read.json.rev });
      ok(same.json.unchanged === true, `sent back as read: ${same.text}`);
      // A field in the wrong place is refused, never dropped; each side and one side aren't both.
      const stray = await tool(alpha.owner, A, "set_feeding_plan", { plan: { feeds: [{ name: "A", steps: [{ do: "nurse", if_needed: true }] }] }, base_rev: read.json.rev });
      ok(stray.error && /"A" step 1: if_needed isn't a nurse step's \(a nurse step takes minutes, each_side or side/.test(stray.text), stray.text);
      const both = await tool(alpha.owner, A, "set_feeding_plan", { plan: { feeds: [{ name: "A", steps: [{ do: "nurse", each_side: true, side: "left" }] }] }, base_rev: read.json.rev });
      ok(both.error && both.text.startsWith('"A" step 1: each side or one side, not both. Nothing was saved'), both.text);
      // start_timer with a plan feed on one side and no side: that side.
      const started = await tool(alpha.member, A, "start_timer", { timer: "nursing", plan: "Left, pump the right" });
      ok(!started.error && /timer started on the left at .*, for the feeding plan's "Left, pump the right" .*\(That's the side the plan's feed nurses on\.\)/.test(started.text), started.text);
      const row = (await sql(`SELECT data FROM maple_entries WHERE id = $1`, [Number(started.json.id)]))[0].data as { segments: { side: string }[]; plan: string };
      eq([row.segments[0].side, row.plan], ["L", left.id]);
      eq((await tool(alpha.member, A, "stop_timer", { timer: "nursing" })).error, false, "stopped");
    });

    await test(`${shape}: the plan's next feed on one side only is the next side for maple_status, the chat's lines, Siri and start_timer`, async () => {
      // "Left, pump the right" takes every day turn. The feeds above set aside, and one feed on the right four hours ago
      // (it was that turn, its pump not logged): it's next, nothing is underway, and taking turns alone would say left.
      const read = await tool(alpha.owner, A, "feeding_plan");
      const one = { ...(read.json.plan as Record<string, unknown>), night: null, order: ["Left, pump the right"] };
      ok((await save(alpha.owner, A, { plan: one, target: read.json.target, base_rev: read.json.rev })).json.saved === true, "saved");
      await sql(`UPDATE maple_entries SET deleted_at = NOW() WHERE family_id = $1 AND deleted_at IS NULL`, [A]);
      ok(!(await tool(alpha.member, A, "log_feed", { method: "breast", right_minutes: 15, first_side: "right", minutes_ago: 240 })).error, "the feed four hours ago");
      const status = await tool(alpha.member, A, "maple_status");
      const line = 'Next feed: offer the left side (the feeding plan\'s next feed, "Left, pump the right", nurses on the left only).';
      ok(status.text.split("\n").includes(line), status.text);
      eq([status.json.next_side, status.json.next_side_rule], ["left", 'the feeding plan\'s next feed, "Left, pump the right", nurses on the left only'], "maple_status's next side");
      ok(/start on the left next/.test(String(status.json.speak)), String(status.json.speak));
      ok((await chatLogState({ email: alpha.member }, { fam: A, care: true, now: new Date() })).includes(line), "the chat's [App] line");
      ok(/start on the left next/.test((await siri(alpha.token, { action: "status" })).speak ?? ""), "Siri's status");
      const started = await tool(alpha.member, A, "start_timer", { timer: "nursing" });
      ok(!started.error && /timer started on the left at .*\(That's the side the feeding plan's next feed, "Left, pump the right", nurses on\.\)/.test(started.text), started.text);
      eq((await tool(alpha.member, A, "stop_timer", { timer: "nursing" })).error, false, "stopped");
    });
  }

  done("feeding-plan-tools");
  // The check's clock moved (atClock), and the in-memory Postgres can hold a timer it set by that clock: exit once done.
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
