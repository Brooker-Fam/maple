import { CLUSTER_GAP_MS, clusterOf, nursingRuns, openSegment, staleFeed, typicalFeedGapMin, type TapFeedData } from "./feed";
import { foodNutritionSummary } from "./care-nutrition-summary";
import type { FoodNutritionSummary } from "./care-nutrition-types";
import { MOM_NUTRITION_SUGGESTIONS } from "./guidelines";
import { dayBounds, dayKey, formatMinutes, formatTime } from "./time";
import type { CareEntry, CareNutritionEntry, Entry, EntryOf } from "./types";

type NutritionOptions = { now: Date; tz: string; feeding?: "yes" | "no" | null };
type SuggestionKey = keyof typeof MOM_NUTRITION_SUGGESTIONS;

function foodSuggestion(nutrition: FoodNutritionSummary): SuggestionKey | null {
  if (!nutrition.assessedGroupItems || nutrition.unassessedEntries || nutrition.unknownGroupItems) return null;
  const groups = nutrition.groups;
  const hasProteinFood = groups.some((group) => ["protein", "legumes", "nuts_seeds", "dairy_or_fortified"].includes(group));
  const hasFiberFood = groups.some((group) => ["fruit", "vegetables", "whole_grains", "legumes", "nuts_seeds"].includes(group));
  if (!hasProteinFood) return "protein";
  if (!hasFiberFood) return "fiber";
  if (!groups.includes("fruit") && !groups.includes("vegetables")) return "variety";
  return null;
}

function recordedNursing(entries: readonly Entry[], now: Date): EntryOf<"feed">[] {
  const happened = (at: string) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= now.getTime();
  return entries.filter((entry): entry is EntryOf<"feed"> =>
    entry.kind === "feed" && entry.data.method !== "bottle"
    && happened(entry.started_at) && (!entry.ended_at || happened(entry.ended_at))
    && (entry.data.segments ?? []).every((part) => happened(part.start) && (!part.end || happened(part.end))),
  ).map((entry) => {
    const data: TapFeedData = entry.data;
    return data.last_tap && !happened(data.last_tap.at) ? { ...entry, data: { ...data, last_tap: undefined } } : entry;
  });
}

function nursingContext(
  entries: readonly Entry[],
  options: NutritionOptions,
): { line: string | null; situation: "general" | "running" | "pause" | "prepared" | "cluster" } {
  const { now, tz, feeding } = options;
  if (feeding === "no") return { line: null, situation: "general" };
  const nursing = recordedNursing(entries, now);
  const newest = nursing.reduce<EntryOf<"feed"> | null>((latest, entry) =>
    !latest || Date.parse(entry.started_at) > Date.parse(latest.started_at) ? entry : latest, null);
  if (newest?.active && (staleFeed(newest, now) || !newest.data.segments?.length)) {
    return { line: "Nursing timer needs checking", situation: "general" };
  }
  const usable = nursing.filter((entry) => !entry.active || !staleFeed(entry, now));
  const runs = nursingRuns(usable, now);
  const latest = runs.at(-1);
  if (!latest || (latest.end ?? latest.start) < now.getTime() - 24 * 60 * 60_000) {
    return { line: null, situation: feeding === "yes" ? "prepared" : "general" };
  }
  const cluster = clusterOf(runs, latest);
  const recent = latest.end !== null && now.getTime() - latest.end < CLUSTER_GAP_MS;
  const running = latest.end === null && latest.entries.some((entry) => entry.active && openSegment(entry.data.segments));
  if (cluster && (running || recent)) return { line: `${cluster.feeds} nursing feeds close together`, situation: "cluster" };
  if (running) return { line: "Nursing timer running", situation: "running" };
  if (latest.live) return { line: "Nursing timer paused", situation: "pause" };
  let line = `Last nursing logged at ${formatTime(latest.start, tz)}`;
  const usualGap = typicalFeedGapMin(usable, now, runs);
  if (usualGap !== null) line += ` · usual gap about ${formatMinutes(usualGap * 60)} (estimate from logged feeds)`;
  return { line, situation: recent ? "pause" : "prepared" };
}

export function careNutritionSummary(
  entries: readonly CareEntry[],
  babyEntries: readonly Entry[],
  options: NutritionOptions,
) {
  const [start] = dayBounds(dayKey(options.now, options.tz), options.tz);
  const dayEntries = entries.filter((entry): entry is CareNutritionEntry =>
    (entry.kind === "food" || entry.kind === "drink")
    && Date.parse(entry.at) >= start.getTime() && Date.parse(entry.at) <= options.now.getTime(),
  ).sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id - a.id);
  let foodCount = 0;
  let drinkCount = 0;
  let fluidMl = 0;
  let unmeasuredDrinks = 0;
  for (const entry of dayEntries) {
    if (entry.kind === "food") foodCount++;
    else {
      drinkCount++;
      const amount = entry.data.amount_ml;
      if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) fluidMl += amount;
      else unmeasuredDrinks++;
    }
  }
  const { line: nursingLine, situation } = nursingContext(babyEntries, options);
  const suggestionKey: SuggestionKey = situation === "running"
    ? drinkCount === 0 ? "drink" : foodCount === 0 ? "snack" : "prepared"
    : situation;
  const nutrition = foodNutritionSummary(dayEntries);
  const foodKey = foodSuggestion(nutrition);
  const suggestion = MOM_NUTRITION_SUGGESTIONS[suggestionKey];
  return {
    dayEntries,
    foodCount,
    drinkCount,
    fluidMl,
    unmeasuredDrinks,
    nursingLine,
    nutrition,
    suggestion,
    suggestions: [suggestion, ...(foodKey ? [MOM_NUTRITION_SUGGESTIONS[foodKey]] : [])],
  };
}
