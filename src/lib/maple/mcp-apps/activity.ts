import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { activityDays, type ActivityDay } from "../chat/charts";
import { TIER_LABEL } from "../guidelines";
import { ACTIVITY_CSS, ACTIVITY_FRAME_JS } from "./activity-frame";

/**
 * The MCP App view daily_summary opens in Claude and ChatGPT: the in-app
 * chat's activity chart (feeds, logged sleep, wet and dirty diapers by day),
 * drawn in the host's sandboxed frame from the tool result the host hands it
 * (`ui/notifications/tool-result`, or ChatGPT's `window.openai.toolOutput`),
 * never from a read of its own. MCP Apps spec 2026-01-26
 * (@modelcontextprotocol/ext-apps).
 *
 * - The page is the same for every family and every call: no names, no data,
 *   no requests out (so the resource declares no CSP domains). Everything it
 *   shows comes from structuredContent, which already went to the host with
 *   the text the model reads; nothing about the tool's result changes.
 * - The days come from activityDays (chat/charts.ts), the same function the
 *   in-app chart's snapshot is built with, run from its own source in the
 *   frame; activityModel below is served the same way. Neither may name
 *   anything outside itself (see activityDays).
 * - Flagged events (health alerts) are shown word for word above the chart,
 *   and a result the view can't fully check, alerts included, draws nothing
 *   but a plain line pointing back to the reply.
 * - Hosts may keep the page by its URI: a change that old results or hosts
 *   can't take should get a new URI.
 */

export const ACTIVITY_VIEW_URI = "ui://maple/activity";
export const MCP_APP_MIME = "text/html;profile=mcp-app";
export const MCP_APP_PROTOCOL = "2026-01-26";

/** daily_summary's link to the view: the standard key and the older flat one that hosts still read. */
export const ACTIVITY_VIEW_TOOL_META = { ui: { resourceUri: ACTIVITY_VIEW_URI }, "ui/resourceUri": ACTIVITY_VIEW_URI } as const;

/** The view draws its own card, so the host adds no border of its own; no `csp`: nothing leaves the frame. */
const ACTIVITY_VIEW_UI = { prefersBorder: false } as const;

/** One flagged event (daily_summary's `flagged`), its words as the result has them. */
export type ActivityAlert = { tier: string; title: string; what: string; when: string };

export type ActivityModel =
  | { kind: "fallback"; reason: "error" | "unreadable" }
  /** A summary covering one day (or only today since the birth): today's three counts. */
  | { kind: "day"; to: string; day: ActivityDay; alerts: ActivityAlert[] }
  /**
   * Several days: the in-app chart's days (at most 14, ending today), from
   * the first day the summary covers. `ranges`: the day counts offered (7
   * and all of them, or only all of them up to a week). `earlier`: the
   * summary goes back further than the chart.
   */
  | { kind: "days"; to: string; days: ActivityDay[]; ranges: number[]; summaryDays: number; earlier: boolean; alerts: ActivityAlert[] };

/**
 * What the view draws for one daily_summary result (a CallToolResult). An
 * error result, a result whose days activityDays refuses, `from` and `days`
 * that don't agree with `to`, or a flagged event (or `alerts`) the view can't
 * show word for word (each of its four texts a non-blank string of at most
 * 500 characters, never cut) makes it a fallback. Days before `from`, or
 * before the first day per_day lists (days that ended before the birth aren't
 * in it), aren't the summary's, so the chart leaves them out rather than draw
 * them as missing logs.
 *
 * Served from its own source like activityDays, which it gets as `build`, so
 * it names nothing outside itself and has no inner named functions.
 */
export function activityModel(result: unknown, build: typeof activityDays): ActivityModel {
  const unreadable: ActivityModel = { kind: "fallback", reason: "unreadable" };
  if (result === null || typeof result !== "object") return unreadable;
  const res = result as { isError?: unknown; structuredContent?: unknown };
  if (res.isError === true) return { kind: "fallback", reason: "error" };
  const sc = res.structuredContent as Record<string, unknown> | null | undefined;
  if (!sc || typeof sc !== "object" || Array.isArray(sc)) return unreadable;
  const all = build(sc.per_day, sc.to, 14);
  const n = sc.days;
  if (!all || typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 31 || typeof sc.from !== "string") return unreadable;
  const to = sc.to as string;
  const end = to.split("-").map(Number);
  const start = new Date(Date.UTC(end[0], end[1] - 1, end[2] - (n - 1)));
  const from = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}-${String(start.getUTCDate()).padStart(2, "0")}`;
  if (sc.from !== from) return unreadable;

  if (sc.alerts !== undefined && !(Array.isArray(sc.alerts) && sc.alerts.length === 0)) return unreadable;
  const flagged = sc.flagged === undefined ? [] : sc.flagged;
  if (!Array.isArray(flagged)) return unreadable;
  const alerts: ActivityAlert[] = [];
  for (const item of flagged as unknown[]) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return unreadable;
    const f = item as Record<string, unknown>;
    if (![f.tier, f.title, f.what, f.when].every((w) => typeof w === "string" && w.trim() !== "" && w.length <= 500)) return unreadable;
    alerts.push({ tier: f.tier as string, title: f.title as string, what: f.what as string, when: f.when as string });
  }

  let first = to;
  for (const row of sc.per_day as { date: string }[]) if (row.date < first) first = row.date;
  const begin = first > from ? first : from;
  const days = all.filter((d) => d.date >= begin);
  if (days.length === 1) return { kind: "day", to, day: days[0], alerts };
  return { kind: "days", to, days, ranges: days.length <= 7 ? [days.length] : [7, days.length], summaryDays: n, earlier: begin < days[0].date, alerts };
}

/** JSON inside a script element: `<` escaped, so no value can close it. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

/** Code for the page's one inline script; refuses anything that could end the element early. */
function inlineScript(code: string): string {
  if (/<\/script|<script|<!--/i.test(code)) throw new Error("The activity view's script can't contain a script tag or <!--");
  return code;
}

/** Each flagged event's tier label (guidelines.ts) to its look, loudest first. */
const TIER_OF: Record<string, string> = Object.fromEntries(Object.entries(TIER_LABEL).map(([tier, label]) => [label, tier]));

let html: string | null = null;

/** The view's page: one static document, built once. */
export function activityViewHtml(): string {
  if (html !== null) return html;
  const script = inlineScript(
    [
      '"use strict";',
      `const activityDays = (${activityDays.toString()});`,
      `const activityModel = (${activityModel.toString()});`,
      `const TIER_OF = ${scriptJson(TIER_OF)};`,
      `const PROTOCOL = ${scriptJson(MCP_APP_PROTOCOL)};`,
      ACTIVITY_FRAME_JS,
    ].join("\n")
  );
  html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Logged activity</title>
<style>${ACTIVITY_CSS}</style>
</head>
<body>
<main id="view"><section class="card" aria-label="Activity over time" aria-busy="true"><h1 class="title">Activity over time</h1><p class="subtitle">Waiting for the summary…</p><div class="skeleton" aria-hidden="true"></div></section></main>
<script>
(function () {
${script}
})();
</script>
</body>
</html>
`;
  return html;
}

/** The views on Maple's MCP server (route.ts), beside registerMapleTools; like it, free of database calls. */
export function registerMapleApps(server: McpServer): void {
  server.registerResource(
    "activity_view",
    ACTIVITY_VIEW_URI,
    {
      title: "Activity chart",
      description: "The chart daily_summary opens: logged feeds, sleep and diapers by day, drawn from that tool's own result.",
      mimeType: MCP_APP_MIME,
      _meta: { ui: ACTIVITY_VIEW_UI },
    },
    async () => ({ contents: [{ uri: ACTIVITY_VIEW_URI, mimeType: MCP_APP_MIME, text: activityViewHtml(), _meta: { ui: ACTIVITY_VIEW_UI } }] })
  );
}
