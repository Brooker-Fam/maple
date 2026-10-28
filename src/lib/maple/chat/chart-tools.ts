import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { query } from "@/lib/db";
import { context, type Extra } from "../mcp-tools";
import { rowToEntry, StoreUnavailable } from "../store";
import { formatWeightBoth } from "../units";
import { activityMetricSchema, buildActivityChart, buildGrowthChart, CHART_GROWTH_POINTS, type ActivityMetric } from "./charts";
import type { ChatToolOutput } from "./types";

/** A chart can only describe freshly authorized reads. The model supplies no values or family IDs. */
export function showChartTool(extra: Extra, readSummary: () => Promise<CallToolResult>) {
  return tool<{ kind: "activity" | "growth"; metric?: ActivityMetric; days?: 7 | 14 }, ChatToolOutput, Record<string, unknown>>({
    description: "Show an interactive chart in the chat when the person asks for a chart, trend, comparison across days, or weight progress. Activity charts cover logged feeds, sleep or wet/dirty diapers over 7 or 14 days. Growth shows recorded weight and birth weight. The chart is a dated snapshot; it does not diagnose or score the baby. No data is changed.",
    inputSchema: zodSchema(z.object({
      kind: z.enum(["activity", "growth"]),
      metric: activityMetricSchema.optional().describe("Activity only: feeds, sleep, or diapers."),
      days: z.union([z.literal(7), z.literal(14)]).optional().describe("Activity only: initially show 7 or 14 days. Both remain available in the card."),
    })),
    execute: async ({ kind, metric, days }): Promise<ChatToolOutput> => {
      const ctx = await context(extra);
      if (kind === "growth") {
        const rows = await query(
          `SELECT * FROM maple_entries WHERE family_id = $1 AND baby_id = $2 AND kind = 'growth'
            AND deleted_at IS NULL AND data->>'weight_g' IS NOT NULL AND started_at <= $3
            ORDER BY started_at DESC, id DESC LIMIT $4`,
          [ctx.fam.familyId, ctx.baby.id, ctx.now.toISOString(), CHART_GROWTH_POINTS + 1],
        );
        if (rows === null) throw new StoreUnavailable();
        const entries = rows.map(rowToEntry);
        const chart = await buildGrowthChart(ctx.baby, entries, { now: ctx.now, timezone: ctx.tz, truncated: entries.length > CHART_GROWTH_POINTS });
        const latest = chart.points.at(-1);
        const latestText = latest ? ` Latest ${latest.birth ? "birth weight" : "recorded weight"}: ${formatWeightBoth(latest.weightG)} at ${latest.at}${latest.percentileLabel ? `, ${latest.percentileLabel} percentile (WHO)` : ""}.` : " There are no recorded weights yet.";
        return { ok: true, write: false, chart, text: `The weight chart is shown.${latestText} It is a dated snapshot; percentiles describe measurements, not targets.` };
      }
      const result = await readSummary();
      if (result.isError) return { ok: false, write: false, text: "The chart could not be loaded. Nothing was changed." };
      const chart = buildActivityChart(result.structuredContent, { now: ctx.now, timezone: ctx.tz, range: days, metric });
      const values = chart.days.slice(-(days ?? 7)).map((day) => {
        const value = metric === "sleep" ? day.sleepHours == null ? "no logs" : `${day.sleepHours} h` : metric === "diapers" ? day.wet == null ? "no logs" : `${day.wet} wet, ${day.dirty} dirty` : day.feeds == null ? "no logs" : `${day.feeds} feeds`;
        return `${day.date}${day.partial ? " (partial)" : ""}: ${value}`;
      }).join("; ");
      return { ok: true, write: false, chart, text: `The ${days ?? 7}-day ${metric ?? "feeds"} chart is shown. Only logged activity through ${chart.asOf}; missing logs do not mean zero activity. ${values}. The card has 7/14-day and feeds/sleep/diapers controls.` };
    },
    toModelOutput: ({ output }: { output: ChatToolOutput }) => ({ type: output.ok ? "text" as const : "error-text" as const, value: output.text }),
  });
}
