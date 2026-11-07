import { NextRequest } from "next/server";
import * as mcpRoute from "../../src/app/api/maple/[transport]/route";
import { activityDays, buildActivityChart, type ActivityDay } from "../../src/lib/maple/chat/charts";
import { ACTIVITY_VIEW_URI, MCP_APP_MIME, activityModel, activityViewHtml, type ActivityModel } from "../../src/lib/maple/mcp-apps/activity";
import { addDays, dayKey, parseDayKey, zonedTimeToUtc } from "../../src/lib/maple/time";
import { mintAccessToken } from "../../src/lib/mcp/auth";
import { done, eq, freshDb, ok, seedFamilies, sql, test, type FamilySeed } from "./harness";

/**
 * daily_summary's MCP App view through the real MCP route, for two made-up
 * families on both schema shapes: tools/list links daily_summary to the
 * view, resources/list and resources/read serve one page that's the same
 * for every family and needs a token like everything else, and each
 * family's own daily_summary result draws (activityModel, as the page runs
 * it) exactly the in-app chart's days, its flagged events word for word,
 * and nothing of her page. The result itself, the text the model reads,
 * carries nothing for the view.
 */

process.env.MCP_SECRET = "made-up-tenancy-mcp-secret";
process.env.GOOGLE_CLIENT_SECRET = "made-up-tenancy-session-secret";

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);

type Rpc = { status: number; result: Record<string, unknown> | null; error: unknown };

async function mcp(auth: { sub: string; fam?: number } | null, method: string, params: Record<string, unknown> = {}): Promise<Rpc> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (auth) headers.authorization = `Bearer ${mintAccessToken({ sub: auth.sub, ...(auth.fam === undefined ? {} : { fam: auth.fam }), scope: "maple", client_id: "made-up-client" })}`;
  const res = await mcpRoute.POST(new NextRequest("http://localhost/api/maple/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
  const text = await res.text();
  if (res.status !== 200) return { status: res.status, result: null, error: text };
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const body = JSON.parse(line ? line.slice("data: ".length) : text) as { result?: Record<string, unknown>; error?: unknown };
  return { status: res.status, result: body.result ?? null, error: body.error ?? null };
}

const owner = (f: FamilySeed) => ({ sub: `maple:${f.owner}`, ...(f.familyId === 1 ? {} : { fam: f.familyId }) });
const viewer = (f: FamilySeed) => ({ sub: `maple:${f.viewer}`, ...(f.familyId === 1 ? {} : { fam: f.familyId }) });

async function entry(f: FamilySeed, kind: string, data: unknown, at: Date, minutes = 0) {
  await sql(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, ended_at, data, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    f.familyId,
    f.babyId,
    kind,
    at.toISOString(),
    minutes ? new Date(at.getTime() + minutes * 60_000).toISOString() : null,
    data,
    f.owner,
  ]);
}

/** Made-up days: Alpha's baby 20 days old with a week of logs, a fever and a pale stool, and a dose of her own; Beta's born at noon two local days ago. */
async function seedLogs({ alpha, beta }: { alpha: FamilySeed; beta: FamilySeed }) {
  await sql(`UPDATE maple_babies SET born_at = $2 WHERE family_id = $1 AND id = $3`, [alpha.familyId, ago(20 * 24).toISOString(), alpha.babyId]);
  const birthday = parseDayKey(addDays(dayKey(new Date(), beta.tz), -2));
  const born = zonedTimeToUtc(birthday.year, birthday.month, birthday.day, 12, 0, beta.tz);
  await sql(`UPDATE maple_babies SET born_at = $2 WHERE family_id = $1 AND id = $3`, [beta.familyId, born.toISOString(), beta.babyId]);
  for (let d = 0; d < 6; d++) {
    const h = d * 24;
    await entry(alpha, "feed", { method: "bottle", amount_ml: 90 }, ago(h + 2));
    await entry(alpha, "feed", { method: "breast", left_sec: 540, right_sec: 360, first_side: "L", last_side: "R" }, ago(h + 5), 15);
    await entry(alpha, "diaper", { pee: true, poop: false }, ago(h + 3));
    if (d % 2 === 0) await entry(alpha, "diaper", { pee: false, poop: true, color: "yellow" }, ago(h + 6));
    if (d > 0) await entry(alpha, "sleep", { place: "bassinet" }, ago(h + 9), 120);
  }
  await entry(alpha, "temp", { temp_c: 38.4, method: "rectal" }, ago(1));
  await entry(alpha, "diaper", { pee: false, poop: true, color: "white" }, ago(27));
  await sql(`INSERT INTO maple_care_entries (family_id, id, person, kind, med_id, at, data, created_by) VALUES ($1, 10000003, $2, 'dose', $3, $4, '{}', $5)`, [
    alpha.familyId,
    alpha.care!.person,
    alpha.care!.medId,
    ago(3).toISOString(),
    alpha.owner,
  ]);
  await entry(beta, "feed", { method: "bottle", amount_ml: 60 }, new Date(Math.max(born.getTime() + HOUR, Date.now() - HOUR)));
  await entry(beta, "diaper", { pee: true, poop: true, color: "mustard" }, new Date(born.getTime() + 2 * HOUR));
}

async function summaryFor(auth: { sub: string; fam?: number }, days: number) {
  const r = await mcp(auth, "tools/call", { name: "daily_summary", arguments: { days } });
  ok(r.status === 200 && r.result && r.result.isError !== true, `daily_summary ${days}: ${JSON.stringify(r.error ?? r.result).slice(0, 200)}`);
  return r.result as { content: { type: string; text: string }[]; structuredContent: Record<string, unknown>; _meta?: unknown };
}

/** The in-app chart's days for a result (show_chart's build, at noon on the result's own today), from the first one the view draws. */
function inAppFrom(sc: Record<string, unknown>, tz: string, first: string): ActivityDay[] {
  const { year, month, day } = parseDayKey(String(sc.to));
  return buildActivityChart(sc, { now: zonedTimeToUtc(year, month, day, 12, 0, tz), timezone: tz }).days.filter((d) => d.date >= first);
}

const drawn = (m: ActivityModel) => (m.kind === "days" ? m.days : m.kind === "day" ? [m.day] : []);
const alertsOf = (sc: Record<string, unknown>) =>
  (sc.flagged as { tier: string; title: string; what: string; when: string }[]).map(({ tier, title, what, when }) => ({ tier, title, what, when }));

async function main() {
  for (const shape of ["production", "final"] as const) {
    await freshDb({ shape });
    const seed = await seedFamilies();
    const { alpha, beta } = seed;
    await seedLogs(seed);

    await test(`${shape}: tools/list links daily_summary, and only it, to the view`, async () => {
      const r = await mcp(owner(alpha), "tools/list");
      const tools = (r.result?.tools ?? []) as { name: string; _meta?: Record<string, unknown> }[];
      const linked = tools.filter((t) => t._meta && ("ui" in t._meta || "ui/resourceUri" in t._meta));
      eq(linked.map((t) => t.name), ["daily_summary"]);
      eq(linked[0]._meta?.ui, { resourceUri: ACTIVITY_VIEW_URI });
      eq(linked[0]._meta?.["ui/resourceUri"], ACTIVITY_VIEW_URI);
    });

    await test(`${shape}: both families list and read the same page, and only with a token`, async () => {
      for (const f of [alpha, beta]) {
        const list = await mcp(owner(f), "resources/list");
        const view = ((list.result?.resources ?? []) as { uri: string; mimeType?: string }[]).filter((x) => x.uri.startsWith("ui://"));
        eq(view.map((x) => [x.uri, x.mimeType]), [[ACTIVITY_VIEW_URI, MCP_APP_MIME]], `family ${f.familyId}`);
        const read = await mcp(owner(f), "resources/read", { uri: ACTIVITY_VIEW_URI });
        const contents = (read.result?.contents ?? []) as { uri: string; mimeType: string; text: string }[];
        eq(contents.map((c) => [c.uri, c.mimeType]), [[ACTIVITY_VIEW_URI, MCP_APP_MIME]], `family ${f.familyId}`);
        ok(contents[0].text === activityViewHtml(), `family ${f.familyId} gets the one static page`);
      }
      const page = activityViewHtml();
      for (const word of [alpha.babyName, beta.babyName, "June", "Dana", alpha.owner, beta.owner, "Ibuprofen"]) ok(!page.includes(word), `the page never names ${word}`);
      eq((await mcp(null, "resources/read", { uri: ACTIVITY_VIEW_URI })).status, 401, "no token, no page");
    });

    await test(`${shape}: a week draws the in-app chart's days, both flagged events word for word, and none of her page`, async () => {
      const res = await summaryFor(owner(alpha), 7);
      const sc = res.structuredContent;
      const { summary, ...rest } = sc;
      eq(res.content.map((c) => c.type), ["text"]);
      ok(res.content[0].text === `${summary}\n${JSON.stringify(rest)}`, "the text the model reads is ok()'s, untouched");
      ok(res._meta === undefined, "the result carries nothing for the view");
      ok(typeof sc.mom === "object" && sc.mom !== null, "an owner's summary has her block");
      const m = activityModel(res, activityDays);
      ok(m.kind === "days", m.kind);
      eq(drawn(m).length, 7, "born 20 days ago: the whole week");
      eq(drawn(m), inAppFrom(sc, alpha.tz, drawn(m)[0].date));
      ok(drawn(m).some((d) => d.feeds !== null) && drawn(m).some((d) => d.sleepHours === null), "logged days and a day without sleep logged");
      const alerts = alertsOf(sc);
      ok(alerts.length >= 2, `the fever and the pale stool are flagged (${alerts.length})`);
      eq(m.kind === "days" && m.alerts, alerts);
      const text = JSON.stringify(m);
      ok(!text.includes("Dana") && !text.includes("Ibuprofen"), "her block never reaches the chart");
    });

    await test(`${shape}: one day draws today; a month draws its last 14 days and says it goes back further`, async () => {
      const day = await summaryFor(owner(alpha), 1);
      const one = activityModel(day, activityDays);
      ok(one.kind === "day" && one.day.date === day.structuredContent.to && one.day.partial, one.kind);
      eq(drawn(one), inAppFrom(day.structuredContent, alpha.tz, String(day.structuredContent.to)));
      eq(one.kind === "day" && one.alerts, alertsOf(day.structuredContent), "today's fever");
      const month = await summaryFor(owner(alpha), 31);
      const all = activityModel(month, activityDays);
      ok(all.kind === "days" && all.days.length === 14 && all.earlier && all.summaryDays === 31, JSON.stringify(all).slice(0, 160));
      eq(drawn(all), inAppFrom(month.structuredContent, alpha.tz, drawn(all)[0].date));
    });

    await test(`${shape}: a baby born 2 days ago draws from the birthday, in its own family's numbers only`, async () => {
      const res = await summaryFor(owner(beta), 7);
      const sc = res.structuredContent;
      const m = activityModel(res, activityDays);
      ok(m.kind === "days", m.kind);
      const firstRow = (sc.per_day as { date: string }[])[0].date;
      eq(drawn(m)[0].date, firstRow, "starts at the birthday, not at from");
      ok(String(sc.from) < firstRow, "the summary's window starts before the birth");
      eq(drawn(m).length, 3);
      eq(m.kind === "days" && m.ranges, [3]);
      ok(drawn(m)[0].partial, "the birthday is partial");
      eq(drawn(m), inAppFrom(sc, beta.tz, firstRow));
      const text = JSON.stringify(res);
      ok(!text.includes("June") && !text.includes("Dana") && !text.includes(alpha.owner), "nothing of family 1");
    });

    await test(`${shape}: a view-only guest's summary draws too, without her page`, async () => {
      const res = await summaryFor(viewer(alpha), 7);
      ok(res.structuredContent.mom === undefined, "no block of hers for a viewer");
      const m = activityModel(res, activityDays);
      ok(m.kind === "days" && m.days.length === 7, m.kind);
      eq(m.kind === "days" && m.alerts, alertsOf(res.structuredContent));
    });
  }
  done("mcp-app.check.ts");
  // The MCP handler's request timers outlive the calls; everything the checks awaited has settled.
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
