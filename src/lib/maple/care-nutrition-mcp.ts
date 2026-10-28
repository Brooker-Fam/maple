import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CareToolRegistrar } from "./care-mcp";
import { careNutritionSummary } from "./care-nutrition";
import { FOOD_GROUPS, type NutrientTotal } from "./care-nutrition-types";
import { cleanCareFoodItems, FOOD_ITEM_LIMITS, NUTRIENT_LIMITS } from "./care-nutrition-validation";
import { careDayRange, createCareEntry, listCareEntries, type CareSession } from "./care-store";
import { READ_ANN, WRITE_ANN, ok, startFrom, whenText, type Ctx, type ToolCopy } from "./mcp-tools";
import { listEntries } from "./store";
import { dayKey } from "./time";
import type { CareNutritionEntry } from "./types";

type ClientId = (ctx: Ctx, ref: string | null | undefined) => string | null;

export const careFoodItemsSchema = z.array(z.object({
  name: z.string().trim().min(1).max(FOOD_ITEM_LIMITS.name),
  portion: z.string().trim().max(FOOD_ITEM_LIMITS.portion).nullish().describe("The stated portion, or an explicitly assumed typical portion; null if unknown."),
  nutrients: z.object({
    protein_g: z.number().finite().min(0).max(NUTRIENT_LIMITS.protein_g).nullish(),
    fiber_g: z.number().finite().min(0).max(NUTRIENT_LIMITS.fiber_g).nullish(),
    carbs_g: z.number().finite().min(0).max(NUTRIENT_LIMITS.carbs_g).nullish(),
    fat_g: z.number().finite().min(0).max(NUTRIENT_LIMITS.fat_g).nullish(),
    energy_kcal: z.number().finite().min(0).max(NUTRIENT_LIMITS.energy_kcal).nullish(),
  }).optional().describe("Values for this portion. Omit or use null when unknown; zero means a known zero. Calories are optional."),
  groups: z.array(z.enum(FOOD_GROUPS)).max(FOOD_GROUPS.length).nullish().describe("Food groups supported by the food's ingredients; null when unknown."),
  source: z.enum(["estimate", "label", "manual"]).describe("estimate for typical food values or assumed portions; label for supplied label values scaled to a stated portion; manual for values supplied by the user."),
  note: z.string().trim().max(FOOD_ITEM_LIMITS.note).nullish().describe("A brief portion assumption or uncertainty, when relevant."),
})).max(FOOD_ITEM_LIMITS.items);

export function nutritionEntryText(entry: CareNutritionEntry): string {
  return entry.kind === "food"
    ? entry.data.description
    : `${entry.data.name}${entry.data.amount_ml == null ? " (amount not recorded)" : `, ${entry.data.amount_ml} mL`}`;
}

function foodDetailsText(entry: CareNutritionEntry): string[] {
  if (entry.kind !== "food") return [];
  return (entry.data.items ?? []).map((item) => {
    const n = item.nutrients;
    const values = [
      n.protein_g == null ? null : `${n.protein_g} g protein`,
      n.fiber_g == null ? null : `${n.fiber_g} g fiber`,
      n.carbs_g == null ? null : `${n.carbs_g} g carbs`,
      n.fat_g == null ? null : `${n.fat_g} g fat`,
      n.energy_kcal == null ? null : `${n.energy_kcal} kcal`,
    ].filter(Boolean);
    const source = item.source === "estimate" ? "estimated" : item.source === "label" ? "from label" : "entered values";
    return `  ${item.name}${item.portion ? ` (${item.portion})` : " (portion unknown)"}: ${source}${values.length ? `; ${values.join(", ")}` : "; nutrients unknown"}${item.note ? `; ${item.note}` : ""}.`;
  });
}

function nutrientTotalText(label: string, nutrient: NutrientTotal, itemCount: number): string {
  const amount = nutrient.total === null ? "unknown" : `${nutrient.total.toLocaleString("en-US", { maximumSignificantDigits: 5 })} g`;
  return `${label} recorded: ${amount}; ${nutrient.knownItems} of ${itemCount} detailed foods have values, including ${nutrient.estimatedItems} estimates; ${itemCount - nutrient.knownItems} unknown.`;
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
    description: `Log a meal or snack ${mom} reports eating, in her maternal food journal. This never logs food for the baby. Use her words; a description alone is enough for a quick log. Preserve supplied label or user nutrient values in item details. Only estimate nutrients or assume a typical portion when she asks for estimates and the described food supports them. Mark estimates with source estimate, including an assumed typical portion in portion and note, and briefly disclose the assumption. Do not ask unnecessary portion questions before saving; leave uncertain details or nutrient values unknown, never zero by default. Calories are optional background detail, never a goal or score. Do not log plans, recommendations or a food question as eaten. Ask whose food only if it is unclear. Read mom_nutrition first when recapping today's food to avoid duplicates.`,
    inputSchema: { description: z.string().trim().min(1).max(500), meal: z.enum(["meal", "snack"]).optional(), items: careFoodItemsSchema.optional(), ...time },
    annotations: WRITE_ANN, invoking: `Logging ${mom}'s food…`, invoked: "Food logged", write: true,
  }, async (args, ctx, session) => {
    const assumed: string[] = [];
    const at = startFrom(args, ctx, assumed) ?? ctx.now;
    const result = await createCareEntry(session, {
      kind: "food", data: { description: args.description, meal: args.meal ?? "meal", ...(args.items === undefined ? {} : { items: cleanCareFoodItems(args.items) }) }, at: at.toISOString(),
      client_id: clientId(ctx, args.client_ref),
    }, ctx.who.via);
    const entry = result.entry as CareNutritionEntry;
    return ok([`${result.deduped ? "Already saved" : "Saved"} c${entry.id}: ${nutritionEntryText(entry)} for ${session.name} at ${whenText(entry.at, ctx)}.${assumed.length ? ` ${assumed.join("; ")}.` : ""}`, ...foodDetailsText(entry)].join("\n"), {
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
    description: `Read ${mom}'s logged food and drinks today, item details with their estimate/label/manual sources, known drink volume and nursing context, with the same sourced practical suggestions as her page. Use before reviewing her intake or suggesting food around nursing. Logs and nutrient details may be incomplete: unknown is not zero, and no entry does not mean she has not eaten or drunk. Never infer milk supply, calories burned or nutrition/fluid targets from feed counts or nursing duration. Keep recommendations to the returned general guidance; don't diagnose, prescribe a diet or suggest weight loss.`,
    inputSchema: {}, annotations: READ_ANN, invoking: `Reading ${mom}'s food and drinks…`, invoked: "Food and drinks checked",
  }, async (_args, ctx, session) => {
    const summary = await nutritionStatus(ctx, session);
    const nutrition = summary.nutrition;
    return ok([
      `${session.name}'s food and drinks logged today: ${summary.foodCount} food entries, ${summary.drinkCount} drinks. Recorded volume: ${summary.fluidMl} mL; ${summary.unmeasuredDrinks} drinks without an amount.`,
      nutrientTotalText("Protein", nutrition.nutrients.protein_g, nutrition.itemCount),
      nutrientTotalText("Fiber", nutrition.nutrients.fiber_g, nutrition.itemCount),
      `Food detail coverage: ${nutrition.itemCount} foods; ${nutrition.unassessedEntries} food entries without details; ${nutrition.unknownGroupItems} foods with unknown groups.`,
      "This is a record of what was logged, not a complete measure of intake.",
      summary.nursingLine,
      ...summary.suggestions.flatMap((suggestion) => [`${suggestion.title}: ${suggestion.body}`, `Source: ${suggestion.sourceLabel} (${suggestion.sourceUrl}).`]),
      ...summary.dayEntries.flatMap((entry) => [`c${entry.id}: ${nutritionEntryText(entry)} at ${whenText(entry.at, ctx)}.`, ...foodDetailsText(entry)]),
    ].filter(Boolean).join("\n"), summary);
  });
}
