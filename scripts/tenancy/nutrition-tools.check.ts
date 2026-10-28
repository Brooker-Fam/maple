import { registrations, allowed } from "../../src/lib/maple/chat/tools";
import { consentCurrent } from "../../src/lib/maple/consent";
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
  return { error: result.isError === true, data: result.structuredContent as Record<string, unknown> };
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
      eq(allowed(registration!, { viewer: false, born: true, care: false, mom }), false);
      eq(allowed(registration!, { viewer: true, born: true, care: true, mom }), false);
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
  done("nutrition-tools.check.ts");
}

void run();
