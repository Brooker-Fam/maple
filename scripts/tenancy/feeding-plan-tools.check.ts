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
import { setClock } from "./clock";
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
      ok(r.text.includes('The plan\'s other feeds, if they\'d rather do one of those: "Nurse, top up", "Pump + bottle".'), "the others");
      eq([r.json.rev, (r.json.now as { state?: string }).state], [1, "upcoming"], "rev and state");
      const plan = r.json.plan as { feeds: { id: string; steps: unknown[] }[]; order: string[]; amounts_in: string; day: unknown };
      eq([plan.amounts_in, plan.day, plan.feeds[1].steps[1], r.json.target], ["ml", { every: [150, 210] }, { do: "bottle", ml: [25, 35], milk: "either", via: "paced" }, [50, 70]], "the shape set_feeding_plan takes");
      // Sent back changed, with base_rev: the ids stay, and it saves as revision 2.
      const edit = { ...plan, feeds: plan.feeds.map((f, i) => (i === 1 ? { ...f, steps: [f.steps[0], { do: "bottle", ml: [35, 45], milk: "either", via: "paced" }] } : f)) };
      const two = await save(alpha.member, A, { plan: edit, target: r.json.target, base_rev: 1 });
      ok(two.json.saved === true && two.json.rev === 2, two.text);
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
      ok(now.text.includes("Underway: \"Nurse + SNS\" (started from the plan, since 11:50 AM).") && now.text.includes("- Nurse 12–18 min, 20 ml of formula in the SNS (going now, 10 min so far)") && now.text.includes("- Pump 15 min (not logged yet)"), now.text);
      const status = await tool(alpha.member, A, "maple_status");
      ok(status.text.includes('Feeding plan: "Nurse + SNS" is underway since 11:50 AM. Going now: nurse 12–18 min, 20 ml of formula in the SNS (10 min so far). Next: pump 15 min. After it: "Nurse, top up"; next feed 2:20 PM–3:20 PM, in 2h 20m.'), status.text);
      ok(/From the feeding plan: Nurse \+ SNS is underway; still to do: pump 15 min\./.test((await siri(alpha.token, { action: "status" })).speak ?? ""), "Siri: what's left");
      eq((await tool(alpha.member, A, "stop_timer", { timer: "nursing" })).error, false, "stopped");
      // Done nursing, the SNS milk not logged: said calmly, and the pump still to do.
      const done = await tool(alpha.member, A, "feeding_plan");
      ok(done.text.includes("- Nurse 12–18 min, 20 ml of formula in the SNS (nursed 10 min; the 20 ml in the SNS isn't logged)"), done.text);
      // A plan feed whose nursing has the shield brings it unless told otherwise.
      const shieldPlan = { feeds: [{ name: "Shield, then pump", steps: [{ do: "nurse", minutes: [10, 15], shield: true }, { do: "pump", minutes: 10 }] }] };
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

    await test(`${shape}: undo_last after a plan save removes nothing and says why`, async () => {
      await tool(alpha.owner, A, "log_diaper", { diaper: "wet" });
      const plan = (await tool(alpha.owner, A, "feeding_plan")).json;
      const p = plan.plan as Record<string, unknown>;
      eq((await save(alpha.owner, A, { plan: { ...p, notes: "Weigh on Friday" }, target: plan.target, base_rev: plan.rev })).json.saved, true, "saved");
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
      ok((await tool(beta.member, B, "feeding_plan")).text.includes("• Shield, then pump: Nurse 10–15 min with the nipple shield; then pump 10 min"), "Beta reads its own");
      // A token Alpha's owner was given saves nothing in Beta.
      const wake = { ...INPUT, day: { every: [150, 210], wake: true } };
      const alphaRead = await tool(alpha.owner, A, "set_feeding_plan", { plan: wake });
      const cross = await tool(beta.owner, B, "set_feeding_plan", { plan: wake, base_rev: 1, confirmed: true, read_back: alphaRead.json.read_back });
      ok(cross.json.confirm_needed === true, "another family's token reads back again");
      ok(cross.text.includes("Day: every 2.5–3.5 hours, waking him if he's asleep") && cross.text.includes("Night (11 PM–5 AM): every 3 hours, waking him: Pump + bottle"), "Beta's boy is him");
      eq(feedingPlanOf(await settings(B))?.feeds.map((f) => f.name), ["Shield, then pump"], "Beta's plan unchanged");
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
  }

  done("feeding-plan-tools");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
