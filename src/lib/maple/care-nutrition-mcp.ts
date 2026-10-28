import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CareToolRegistrar } from "./care-mcp";
import { careNutritionSummary } from "./care-nutrition";
import { careDayRange, createCareEntry, listCareEntries, type CareSession } from "./care-store";
import { READ_ANN, WRITE_ANN, ok, startFrom, whenText, type Ctx, type ToolCopy } from "./mcp-tools";
import { listEntries } from "./store";
import { dayKey } from "./time";
import type { CareNutritionEntry } from "./types";

type ClientId = (ctx: Ctx, ref: string | null | undefined) => string | null;

export function nutritionEntryText(entry: CareNutritionEntry): string {
  return entry.kind === "food"
    ? entry.data.description
    : `${entry.data.name}${entry.data.amount_ml == null ? " (amount not recorded)" : `, ${entry.data.amount_ml} mL`}`;
}

async function nutritionStatus(ctx: Ctx, session: CareSession) {
  const today = dayKey(ctx.now, ctx.tz);
  const [entries, feeds] = await Promise.all([
    listCareEntries(session, { ...careDayRange(today, today, ctx.tz), kinds: ["food", "drink"] }),
    listEntries(ctx.fam, { babyId: ctx.baby.id, kinds: ["feed"], from: new Date(ctx.now.getTime() - 7 * 86400_000), to: ctx.now, includeActive: true, limit: 1000 }),
  ]);
  return careNutritionSummary(entries, feeds, { now: ctx.now, tz: ctx.tz, feeding: session.person?.settings.feeding });
}

export function registerNutritionTools(server: McpServer, copy: ToolCopy, add: CareToolRegistrar, clientId: ClientId) {
  const mom = copy.v.mom;
  const time = {
    at: z.string().max(60).nullish().describe(`When it was eaten or drunk, as stated by the user: a local time in ${copy.tz}, an ISO timestamp, or yesterday plus a time. Omit for now. Never invent a time.`),
    minutes_ago: z.number().min(0).max(4320).nullish().describe("Minutes ago, only as stated. Use instead of at."),
    client_ref: z.string().max(100).nullish().describe("Reuse the same key when retrying this entry so it is saved once."),
  };

  add(server, "log_mom_food", {
    title: `Log food for ${mom}`,
    description: `Log a meal or snack ${mom} reports eating, in her maternal food journal. This never logs food for the baby. Use her words and portion if given; no calorie counting or portion questions are needed. Do not log plans, recommendations or a food question as eaten. Ask whose food only if it is unclear. Read mom_nutrition first when recapping today's food to avoid duplicates.`,
    inputSchema: { description: z.string().trim().min(1).max(500), meal: z.enum(["meal", "snack"]).optional(), ...time },
    annotations: WRITE_ANN, invoking: `Logging ${mom}'s food…`, invoked: "Food logged", write: true,
  }, async (args, ctx, session) => {
    const assumed: string[] = [];
    const at = startFrom(args, ctx, assumed) ?? ctx.now;
    const result = await createCareEntry(session, {
      kind: "food", data: { description: args.description, meal: args.meal ?? "meal" }, at: at.toISOString(),
      client_id: clientId(ctx, args.client_ref),
    }, ctx.who.via);
    const entry = result.entry as CareNutritionEntry;
    return ok(`${result.deduped ? "Already saved" : "Saved"} c${entry.id}: ${nutritionEntryText(entry)} for ${session.name} at ${whenText(entry.at, ctx)}.${assumed.length ? ` ${assumed.join("; ")}.` : ""}`, {
      created: result.created, deduped: result.deduped ?? false, id: `c${entry.id}`, entry,
    });
  });

  add(server, "log_mom_drink", {
    title: `Log a drink for ${mom}`,
    description: `Log a drink ${mom} reports drinking, in her maternal journal, never as a baby's bottle. Record its name and the volume only if stated; omit unknown volume without asking. Convert stated US fluid ounces to mL with 29.5735295625 mL per fl oz. Do not invent cup or bottle sizes or count planned drinks as consumed.`,
    inputSchema: { name: z.string().trim().min(1).max(100), amount_ml: z.number().positive().max(5000).nullish(), ...time },
    annotations: WRITE_ANN, invoking: `Logging ${mom}'s drink…`, invoked: "Drink logged", write: true,
  }, async (args, ctx, session) => {
    const assumed: string[] = [];
    const at = startFrom(args, ctx, assumed) ?? ctx.now;
    const result = await createCareEntry(session, {
      kind: "drink", data: { name: args.name, amount_ml: args.amount_ml ?? null }, at: at.toISOString(),
      client_id: clientId(ctx, args.client_ref),
    }, ctx.who.via);
    const entry = result.entry as CareNutritionEntry;
    return ok(`${result.deduped ? "Already saved" : "Saved"} c${entry.id}: ${nutritionEntryText(entry)} for ${session.name} at ${whenText(entry.at, ctx)}.${assumed.length ? ` ${assumed.join("; ")}.` : ""}`, {
      created: result.created, deduped: result.deduped ?? false, id: `c${entry.id}`, entry,
    });
  });

  add(server, "mom_nutrition", {
    title: `${mom}'s food and drinks today`,
    description: `Read ${mom}'s logged food and drinks today, known drink volume and nursing context, with the same sourced practical suggestion as her page. Use before reviewing her intake or suggesting food around nursing. Logs may be incomplete: no entry does not mean she has not eaten or drunk. Never infer milk supply, calories burned or nutrition/fluid targets from feed counts or nursing duration. Keep recommendations to the returned general guidance; don't diagnose, prescribe a diet or suggest weight loss.`,
    inputSchema: {}, annotations: READ_ANN, invoking: `Reading ${mom}'s food and drinks…`, invoked: "Food and drinks checked",
  }, async (_args, ctx, session) => {
    const summary = await nutritionStatus(ctx, session);
    return ok([
      `${session.name}'s food and drinks logged today: ${summary.foodCount} food entries, ${summary.drinkCount} drinks. Recorded volume: ${summary.fluidMl} mL; ${summary.unmeasuredDrinks} drinks without an amount.`,
      ...summary.dayEntries.map((entry) => `c${entry.id}: ${nutritionEntryText(entry)} at ${whenText(entry.at, ctx)}.`),
      summary.nursingLine,
      `${summary.suggestion.title}: ${summary.suggestion.body}`,
      `Source: ${summary.suggestion.sourceLabel} (${summary.suggestion.sourceUrl}).`,
      "This is a record of what was logged, not a complete measure of intake.",
    ].filter(Boolean).join("\n"), summary);
  });
}
