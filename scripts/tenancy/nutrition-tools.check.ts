import assert from "node:assert/strict";
import { z } from "zod";
import { registrations, allowed, forModel, MODEL_TEXT_MAX } from "../../src/lib/maple/chat/tools";
import { consentCurrent } from "../../src/lib/maple/consent";
import type { CareFoodItem } from "../../src/lib/maple/care-nutrition-types";
import type { CareNutritionEntry } from "../../src/lib/maple/types";
import type { Extra } from "../../src/lib/maple/mcp-tools";
import { done, eq, freshDb, ok, seedFamilies, sql, test } from "./harness";

delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
process.env.MCP_SECRET = "synthetic-nutrition-mcp-secret";
process.env.GOOGLE_CLIENT_SECRET = "synthetic-nutrition-session-secret";

async function tool(name: string, args: Record<string, unknown>, auth: Record<string, unknown>) {
  const registration = registrations().all.find((r) => r.name === name);
  ok(registration, `Missing tool ${name}`);
  const result = await registration!.handler(args, {
    signal: new AbortController().signal,
    requestId: "synthetic-nutrition",
    authInfo: { token: "synthetic", clientId: "synthetic", scopes: ["maple"], extra: { via: "claude", ...auth } },
  } as unknown as Extra);
  return { error: result.isError === true, data: result.structuredContent as Record<string, unknown>, text: result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") };
}

async function itemToolChecks(owner: Record<string, unknown>) {
  const item = { name: "Synthetic oats", portion: "1 bowl", nutrients: { protein_g: 8, fiber_g: null }, groups: ["whole_grains"], source: "estimate", note: "Typical portion assumed" };
  const food = { description: "Synthetic detailed breakfast", meal: "meal", items: [item] };
  const saved = async (id: unknown) => (await sql("SELECT data FROM maple_care_entries WHERE id = $1", [Number(String(id).slice(1))]))[0].data as Record<string, unknown>;
  const seed = async () => {
    const result = await tool("log_mom_food", { description: food.description }, owner);
    await sql("UPDATE maple_care_entries SET data = $2::jsonb WHERE id = $1", [Number(String(result.data.id).slice(1)), JSON.stringify(food)]);
    return result.data.id;
  };

  await test("maternal food tool schema accepts optional nutrition without requiring calories", () => {
    const registration = registrations().all.find((r) => r.name === "log_mom_food")!;
    const parsed = z.object(registration.shape).parse(food);
    assert.deepEqual(parsed.items, [item]);
  });

  await test("maternal food tool saves item details once and returns them in journal reads", async () => {
    const args = { ...food, client_ref: "synthetic-itemized-food" };
    const result = await tool("log_mom_food", args, owner);
    const replay = await tool("log_mom_food", args, owner);
    eq([result.error, replay.error, replay.data.id, replay.data.deduped], [false, false, result.data.id, true]);
    assert.deepEqual(await saved(result.data.id), food);
    const status = await tool("mom_nutrition", {}, owner);
    const entries = status.data.dayEntries as { id: number; data: unknown }[];
    assert.deepEqual(entries.find((entry) => `c${entry.id}` === result.data.id)?.data, food);
  });

  await test("maternal food journal text exposes estimated details and portion assumptions", async () => {
    await seed();
    const status = await tool("mom_nutrition", {}, owner);
    ok(status.text.includes("Synthetic oats") && status.text.includes("1 bowl") && status.text.includes("8 g protein") && status.text.includes("estimated") && status.text.includes("Typical portion assumed"), "model-visible text must include the food details and their uncertainty");
    ok(!status.text.includes("0 g fiber"), "unknown fiber is not shown as zero");
  });

  await test("maternal food tool preserves details when correcting descriptions", async () => {
    const id = await seed();
    const result = await tool("fix_mom_entry", { id, action: "update", food_description: "Synthetic corrected breakfast", note: "Synthetic correction" }, owner);
    eq(result.error, false);
    assert.deepEqual(await saved(id), { ...food, description: "Synthetic corrected breakfast" });
  });

  await test("maternal food tool replaces or clears the full item list explicitly", async () => {
    const id = await seed();
    const replacement = { ...item, source: "label", nutrients: { protein_g: 10, fiber_g: 0 }, note: null };
    eq((await tool("fix_mom_entry", { id, action: "update", items: [replacement] }, owner)).error, false);
    assert.deepEqual((await saved(id)).items, [replacement]);
    eq((await tool("fix_mom_entry", { id, action: "update", items: [] }, owner)).error, false);
    assert.deepEqual((await saved(id)).items, []);
  });

  await test("maternal food tools reject invalid details without modifying stored data", async () => {
    const id = await seed();
    const invalid = [{ ...item, nutrients: { protein_g: -1 } }];
    const before = await saved(id);
    eq((await tool("log_mom_food", { ...food, items: invalid }, owner)).error, true);
    eq((await tool("fix_mom_entry", { id, action: "update", food_description: "Do not save", items: invalid }, owner)).error, true);
    assert.deepEqual(await saved(id), before);
  });

  await test("maternal food items cannot be attached to a drink", async () => {
    const drink = await tool("log_mom_drink", { name: "Synthetic water" }, owner);
    eq((await tool("fix_mom_entry", { id: drink.data.id, action: "update", note: "Synthetic note", items: [item] }, owner)).error, true);
  });
}

async function longJournalCheck() {
  await test("long maternal journals retain nutrient coverage and all guidance before chat truncates details", async () => {
    await freshDb({ shape: "final" });
    const { alpha } = await seedFamilies();
    const owner = { sub: `maple:${alpha.owner}`, fam: alpha.familyId };
    const start = new Date(Date.now() - 60_000).toISOString();
    await sql("UPDATE maple_entries SET started_at = $2, ended_at = NULL, active = true, data = $3::jsonb WHERE id = $1", [
      alpha.entries.feed, start, JSON.stringify({ method: "breast", segments: [{ side: "L", start, end: null }] }),
    ]);
    const items: CareFoodItem[] = Array.from({ length: 12 }, (_, i) => ({
      name: `Synthetic wholegrain food ${i}: `.padEnd(120, "x"),
      portion: "Synthetic stated portion ".padEnd(120, "x"),
      nutrients: { protein_g: i === 0 ? 0 : i === 11 ? null : 8, fiber_g: null },
      groups: ["whole_grains"],
      source: i === 0 ? "label" : i === 1 ? "manual" : "estimate",
      note: "Synthetic portion explanation ".padEnd(500, "x"),
    }));
    for (let i = 0; i < 3; i++) {
      const logged = await tool("log_mom_food", { description: `Synthetic meal ${i}`, items, client_ref: `synthetic-long-journal-${i}` }, owner);
      eq(logged.error, false);
    }
    const status = await tool("mom_nutrition", {}, owner);
    eq(status.error, false);
    ok(status.text.length > MODEL_TEXT_MAX, "the detailed journal must exceed the chat limit");
    const model = forModel(status.text);
    const suggestions = status.data.suggestions as { title: string; body: string; sourceUrl: string }[];
    eq(suggestions.length, 2);
    const expected = [
      "Protein recorded: 240 g; 33 of 36 detailed foods have values, including 27 estimates; 3 unknown.",
      "Fiber recorded: unknown; 0 of 36 detailed foods have values, including 0 estimates; 36 unknown.",
      "Food detail coverage: 36 foods; 0 food entries without details; 0 foods with unknown groups.",
      "This is a record of what was logged, not a complete measure of intake.",
      "Nursing timer running",
      ...suggestions.flatMap((suggestion) => [suggestion.title, suggestion.body, suggestion.sourceUrl]),
    ];
    assert.deepEqual(expected.filter((line) => !model.includes(line)), [], "the model must retain totals, uncertainty, nursing and every sourced suggestion");
    const firstDetail = model.indexOf(items[0].name);
    ok(firstDetail > 0 && expected.every((line) => model.indexOf(line) < firstDetail), "the compact summary must precede item details");
    const entries = status.data.dayEntries as CareNutritionEntry[];
    eq(entries.length, 3);
    ok(entries.every((entry) => entry.kind === "food" && entry.data.items?.length === 12), "the structured response must retain every food");
  });
}

async function run() {
  await freshDb({ shape: "final" });
  const { alpha, beta } = await seedFamilies();
  const owner = { sub: `maple:${alpha.owner}`, fam: alpha.familyId };

  await test("maternal nutrition tools require care access, including inside chat", async () => {
    const { all, mom } = registrations();
    for (const name of ["log_mom_food", "log_mom_drink", "mom_nutrition"]) {
      const registration = all.find((r) => r.name === name);
      ok(registration && mom.has(name), `${name} must be a maternal care tool`);
      eq(allowed(registration!, { viewer: false, born: true, care: "none", mom }), false);
      // The chat never opens her page to a viewer (chatCareLevel); a member set to "view" gets her reads only.
      eq(allowed(registration!, { viewer: true, born: true, care: "none", mom }), false);
      eq(allowed(registration!, { viewer: false, born: true, care: "view", mom }), name === "mom_nutrition");
      const args = name === "log_mom_food" ? { description: "Synthetic oat bowl", meal: "meal" } : name === "log_mom_drink" ? { name: "Synthetic water", amount_ml: 240 } : {};
      eq((await tool(name, args, { ...owner, via: "chat", care: false })).error, true);
      eq((await tool(name, args, { sub: `maple:${alpha.viewer}`, fam: alpha.familyId })).error, true);
    }
  });

  await test("food and drinks logged through tools persist only in mom's log and retry once", async () => {
    const food = await tool("log_mom_food", { description: "Synthetic oat bowl", meal: "snack", client_ref: "synthetic-food" }, owner);
    eq(food.error, false);
    eq(food.data.created, true);
    const replay = await tool("log_mom_food", { description: "Synthetic oat bowl", meal: "snack", client_ref: "synthetic-food" }, owner);
    eq([replay.error, replay.data.id, replay.data.deduped], [false, food.data.id, true]);
    const drink = await tool("log_mom_drink", { name: "Synthetic water", amount_ml: 240, client_ref: "synthetic-drink" }, owner);
    eq(drink.error, false);
    const status = await tool("mom_nutrition", {}, owner);
    eq(status.error, false);
    eq([status.data.foodCount, status.data.drinkCount, status.data.fluidMl], [1, 1, 240]);
    const id = Number(String(food.data.id).slice(1));
    eq((await sql("SELECT family_id, kind, data FROM maple_care_entries WHERE id = $1", [id])).map((r) => [Number(r.family_id), r.kind, (r.data as { description: string }).description, (r.data as { meal: string }).meal]), [[1, "food", "Synthetic oat bowl", "snack"]]);
    eq(await sql("SELECT id FROM maple_entries WHERE id = $1", [id]), []);
    eq((await tool("fix_mom_entry", { id: drink.data.id, action: "update", drink_name: "Synthetic tea", amount_ml: 300 }, owner)).error, false);
    const updated = await tool("mom_nutrition", {}, owner);
    eq(updated.data.fluidMl, 300);
    eq((await tool("fix_mom_entry", { id: food.data.id, action: "delete" }, { sub: `maple:${beta.owner}`, fam: beta.familyId })).error, true);
    eq((await tool("fix_mom_entry", { id: food.data.id, action: "delete" }, owner)).error, false);
    eq((await tool("mom_nutrition", {}, owner)).data.foodCount, 0);
    eq((await tool("fix_mom_entry", { id: food.data.id, action: "restore" }, owner)).error, false);
    eq((await tool("mom_nutrition", {}, owner)).data.foodCount, 1);
  });

  await test("unknown drink amounts stay unknown and invalid nutrition is rejected", async () => {
    const unknown = await tool("log_mom_drink", { name: "Synthetic tea", client_ref: "synthetic-unknown-volume" }, owner);
    eq(unknown.error, false);
    eq((await tool("mom_nutrition", {}, owner)).data.unmeasuredDrinks, 1);
    eq((await tool("log_mom_drink", { name: "Synthetic tea", amount_ml: -20 }, owner)).error, true);
    eq((await tool("log_mom_food", { description: "  ", meal: "meal" }, owner)).error, true);
  });

  await test("older maternal chat consent does not open newly included nutrition records", () => {
    eq(consentCurrent("chat_care", 1), false);
    eq(consentCurrent("chat_care", 2), true);
  });
  await test("undo names the maternal food it removes", async () => {
    const food = await tool("log_mom_food", { description: "Synthetic toast", meal: "snack", client_ref: "synthetic-undo-food" }, owner);
    eq(food.error, false);
    const undo = await tool("undo_last", {}, owner);
    eq(undo.error, false);
    eq(undo.data.removed, { id: food.data.id, what: "Synthetic toast", whose: "Dana" });
  });
  await itemToolChecks(owner);
  await longJournalCheck();
  done("nutrition-tools.check.ts");
}

void run();
