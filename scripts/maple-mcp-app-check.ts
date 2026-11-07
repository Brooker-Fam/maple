/**
 * pnpm check:maple-mcp-app: the MCP App view daily_summary opens
 * (src/lib/maple/mcp-apps/), on synthetic results only: no database, no
 * browser (scripts/mcp-app-ui/ draws it in Chromium). The resource is listed
 * and readable and daily_summary links to it; the page is self-contained,
 * reads nothing as markup and carries no family's words; the days it draws
 * are the in-app chart's (chat/charts.ts) for any per_day, refused exactly
 * when the in-app chart refuses them; and flagged events come through word
 * for word, or the view draws nothing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { activityDays, buildActivityChart, CHART_DAYS, parseChatChart, type ActivityDay } from "../src/lib/maple/chat/charts";
import { TIER_LABEL } from "../src/lib/maple/guidelines";
import { ACTIVITY_VIEW_URI, MCP_APP_MIME, MCP_APP_PROTOCOL, activityModel, activityViewHtml, registerMapleApps, type ActivityModel } from "../src/lib/maple/mcp-apps/activity";
import { MP_TOKENS } from "../src/lib/maple/mcp-apps/activity-frame";
import { FAMILY_ONE_COPY, registerMapleTools, toolCopy } from "../src/lib/maple/mcp-tools";
import { addDays } from "../src/lib/maple/time";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-11-05T17:15:00Z");
const TZ = "America/New_York";
const TO = "2026-11-05";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

type Row = { date: string; partial?: boolean; feeds: number; wet: number; dirty: number; sleep_hours: number } & Record<string, unknown>;
const row = (date: string, values: Partial<Row> = {}): Row => ({ date, feeds: 0, wet: 0, dirty: 0, sleep_hours: 0, ...(date === TO ? { partial: true } : {}), ...values });

/** A daily_summary result as ok() shapes it: the same object as text and as structuredContent. */
function summary(days: number, rows: Row[], extra: Record<string, unknown> = {}) {
  const data = { days, from: addDays(TO, 1 - days), to: TO, paragraph: "A made-up paragraph.", per_day: rows, flagged: [], ...extra };
  const text = `Summary for the last ${days} days, ready for a pediatrician visit:`;
  return { content: [{ type: "text", text: `${text}\n${JSON.stringify(data)}` }], structuredContent: { summary: text, ...data } };
}

const inApp = (result: { structuredContent: unknown }) => buildActivityChart(result.structuredContent, { now: NOW, timezone: TZ, range: 14 }).days;
const fullWeeks = (n: number) => Array.from({ length: n }, (_, i) => row(addDays(TO, i + 1 - n), { feeds: (i * 3) % 9, wet: i % 4, dirty: (i * 2) % 3, sleep_hours: ((i * 7) % 30) / 2 }));
const model = (result: unknown) => activityModel(result, activityDays);
const daysOf = (m: ActivityModel) => (m.kind === "days" ? m.days : m.kind === "day" ? [m.day] : []);

/** A seeded generator, so a failure names a case that can be replayed. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BAD_VALUES: unknown[] = [NaN, Infinity, -Infinity, -1, 0.5, 2001, "5", null, undefined, true, {}, [], 73, 1e21];
const BAD_DATES: unknown[] = ["2026-11-5", "2026-11-05T00:00", 20261105, null, "", "Nov 5"];
const BAD_PARTIAL: unknown[] = [null, "true", 1, 0, {}];
const BAD_ROWS: unknown[] = [null, [], "row", 5, true];

/** per_day rows: distinct days from two ahead to 30 back, sometimes one twice, more than 31, or one value wrong. */
function fuzzRows(next: () => number): unknown[] {
  const pick = <T,>(list: T[]) => list[Math.floor(next() * list.length)];
  const back = Array.from({ length: 33 }, (_, i) => i - 2);
  for (let i = back.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [back[i], back[j]] = [back[j], back[i]];
  }
  const length = next() < 0.05 ? 32 + Math.floor(next() * 2) : Math.floor(next() * 32);
  const rows: unknown[] = back.slice(0, length).map((offset) => {
    const date = addDays(TO, -offset);
    const r: Record<string, unknown> = {
      date,
      feeds: next() < 0.3 ? 0 : Math.floor(next() * 14),
      wet: next() < 0.3 ? 0 : Math.floor(next() * 9),
      dirty: next() < 0.4 ? 0 : Math.floor(next() * 6),
      sleep_hours: next() < 0.3 ? 0 : Math.round(next() * 200) / 10,
      ...(next() < 0.2 ? { note: "made-up note", id: 912, stool_colors: ["yellow"] } : {}),
    };
    const p = next();
    if (p < 0.2) r.partial = true;
    else if (p < 0.3) r.partial = false;
    return r;
  });
  if (rows.length && next() < 0.1) rows.push({ ...(rows[Math.floor(next() * rows.length)] as Record<string, unknown>) });
  if (rows.length && next() < 0.3) {
    const i = Math.floor(next() * rows.length);
    const which = next();
    if (which < 0.15) rows[i] = pick(BAD_ROWS);
    else if (which < 0.3) (rows[i] as Record<string, unknown>).date = pick(BAD_DATES);
    else if (which < 0.4) (rows[i] as Record<string, unknown>).partial = pick(BAD_PARTIAL);
    else if (which < 0.55) delete (rows[i] as Record<string, unknown>)[pick(["feeds", "wet", "dirty", "sleep_hours", "date"])];
    else (rows[i] as Record<string, unknown>)[pick(["feeds", "wet", "dirty", "sleep_hours"])] = pick(BAD_VALUES);
  }
  return rows;
}

/** What the in-app chart makes of per_day: its days, or "refused" when buildActivityChart throws. */
function inAppDays(perDay: unknown): ActivityDay[] | "refused" {
  try {
    return buildActivityChart({ per_day: perDay }, { now: NOW, timezone: TZ }).days;
  } catch {
    return "refused";
  }
}

/** The view's script, as the page serves it. */
const scriptOf = (html: string) => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1, "one script element");
  assert.equal(scripts[0][1].trim(), "", "an inline script, no src or type");
  return scripts[0][2];
};

/** A made-up host's style block, parsed: `selector { --a: b; ... }` → { --a: "b" }. */
function cssVars(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert(start >= 0, `${selector} block in maple.css`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start)).replace(/\/\*[\s\S]*?\*\//g, "");
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

async function connect(copy = FAMILY_ONE_COPY) {
  const server = new McpServer({ name: "maples-log", version: "1.0.0" });
  registerMapleTools(server, copy);
  registerMapleApps(server);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "made-up-host", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function main() {
  const html = activityViewHtml();
  const script = scriptOf(html);

  await check("the view is listed and readable as an MCP App, and daily_summary (only) links to it", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    const listed = resources.filter((r) => r.uri.startsWith("ui://"));
    assert.deepEqual(listed.map((r) => [r.uri, r.mimeType]), [[ACTIVITY_VIEW_URI, MCP_APP_MIME]]);
    assert.equal(MCP_APP_MIME, "text/html;profile=mcp-app");
    assert.deepEqual(listed[0]._meta, { ui: { prefersBorder: false } });
    const read = await client.readResource({ uri: ACTIVITY_VIEW_URI });
    assert.equal(read.contents.length, 1);
    const [content] = read.contents;
    assert.equal(content.uri, ACTIVITY_VIEW_URI);
    assert.equal(content.mimeType, MCP_APP_MIME);
    assert.equal("text" in content ? content.text : null, html);
    assert.deepEqual(content._meta, { ui: { prefersBorder: false } }, "no csp: the page reaches nothing");
    await assert.rejects(client.readResource({ uri: "ui://maple/other" }));
    const { tools } = await client.listTools();
    const linked = tools.filter((t) => t._meta && ("ui" in t._meta || "ui/resourceUri" in t._meta));
    assert.deepEqual(linked.map((t) => t.name), ["daily_summary"]);
    const meta = linked[0]._meta as Record<string, unknown>;
    assert.deepEqual(meta.ui, { resourceUri: ACTIVITY_VIEW_URI });
    assert.equal(meta["ui/resourceUri"], ACTIVITY_VIEW_URI);
    assert.equal(meta["openai/toolInvocation/invoking"], "Gathering the week's leaves…", "the tool's other _meta stays");
    assert.equal(linked[0].outputSchema, undefined, "still no outputSchema");
    await client.close();
  });

  await check("every family is served the same page, with none of its words in it", async () => {
    const other = await connect(toolCopy(2, { name: "Rowan Test", nickname: "Ro", sex: "male" }, "Dana", "America/Los_Angeles"));
    const read = await other.readResource({ uri: ACTIVITY_VIEW_URI });
    assert.equal("text" in read.contents[0] ? read.contents[0].text : null, html);
    for (const word of ["Rowan", "Juniper", "June", "Dana", "Brittany", "Brooker", "America/"]) assert(!html.includes(word), word);
    assert(!/\bRo\b/.test(html) && !/\bMaple\b/.test(html), "no baby's name, and not the product's either (family 1's baby shares it)");
    assert(!/\b(she|her|hers|herself|he|him|his|himself|mom|mommy)\b/i.test(html), "no pronouns or care person: the result's own words name anyone");
    await other.close();
  });

  await check("the page is self-contained: no outside address, request, storage or second document", () => {
    const urls = [...new Set(html.match(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]*/gi) ?? [])];
    assert.deepEqual(urls, ["http://www.w3.org/2000/svg"], "only the SVG namespace, which is never fetched");
    const markup = html.replace(script, "");
    const tags = [...new Set([...markup.matchAll(/<([a-z][a-z0-9]*)\b/gi)].map((m) => m[1].toLowerCase()))].sort();
    assert.deepEqual(tags, ["body", "div", "h1", "head", "html", "main", "meta", "p", "script", "section", "style", "title"], "the page's own markup");
    assert(!/\s(?:src|href|srcset|action|formaction|poster|data|xlink:href|ping|background|http-equiv)\s*=/i.test(markup), "no attribute that loads anything");
    // el("tag" and svg("tag" calls, and the icons' shapes, which icon() hands to svg().
    const made = [...new Set([...[...script.matchAll(/\b(el|svg)\("([a-zA-Z0-9]+)"/g)].map((m) => `${m[1]}:${m[2]}`), ...[...script.matchAll(/\["([a-z]+)", \{/g)].map((m) => `svg:${m[1]}`)])].sort();
    assert.deepEqual(made, [
      "el:button", "el:caption", "el:dd", "el:details", "el:div", "el:dl", "el:dt", "el:h1", "el:h2", "el:li", "el:p", "el:section", "el:span", "el:summary",
      "el:table", "el:tbody", "el:td", "el:th", "el:thead", "el:tr", "el:ul",
      "svg:circle", "svg:line", "svg:path", "svg:rect", "svg:svg", "svg:text", "svg:title",
    ], "the only elements the script makes, none of which loads anything");
    assert.equal((script.match(/createElement(?:NS)?\(/g) ?? []).length, 2, "every element goes through el() or svg()");
    assert(!/setAttribute\("(?:src|href|srcset|action|formaction|poster|data|xlink:href|ping|background|style|on\w+)"/i.test(script), "no loading, styling or handler attribute");
    assert(!/\.(?:src|href|srcset|action|formAction|poster|background|ping)\s*=(?!=)/.test(script), "no loading property");
    assert(!/url\(|@import|image-set\(/i.test(html), "no CSS that loads anything");
    for (const api of [/\bfetch\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /\bimport\(/, /importScripts/, /Worker\(/, /serviceWorker/, /\bopen\(/, /\blocation\b/, /document\.cookie/, /localStorage/, /sessionStorage/, /indexedDB/, /\bcaches\./]) {
      assert(!api.test(script), String(api));
    }
  });

  await check("no text is ever read as markup, and the script can't be ended early", () => {
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "DOMParser", "createContextualFragment", "srcdoc", "eval(", "new Function", "setTimeout(", "setInterval(", "javascript:"]) {
      assert(!script.includes(sink), sink);
    }
    assert(!/<\/script|<script|<!--/i.test(script), "nothing in the script closes it");
    assert.doesNotThrow(() => new vm.Script(script), "the script parses");
  });

  await check("the view sends the host only the handshake, its size and its answers", () => {
    const methods = [...new Set(script.match(/"(?:ui|tools|resources|sampling|prompts|notifications)\/[\w/-]+"/g) ?? [])].sort();
    assert.deepEqual(methods, [
      '"ui/initialize"',
      '"ui/notifications/host-context-changed"',
      '"ui/notifications/initialized"',
      '"ui/notifications/size-changed"',
      '"ui/notifications/tool-cancelled"',
      '"ui/notifications/tool-result"',
      '"ui/resource-teardown"',
    ]);
    assert(script.includes(`const PROTOCOL = ${JSON.stringify(MCP_APP_PROTOCOL)};`));
    assert.equal(MCP_APP_PROTOCOL, "2026-01-26");
  });

  await check("the page serves activityDays and activityModel from their own source", () => {
    assert(script.includes(`const activityDays = (${activityDays.toString()});`));
    assert(script.includes(`const activityModel = (${activityModel.toString()});`));
    for (const fn of [activityDays, activityModel]) assert(!/__name|_define_property|_object_spread|cov_\w+/.test(fn.toString()), `${fn.name} carries no bundler helper`);
    const tiers = JSON.parse(/const TIER_OF = (\{[^}]*\});/.exec(script)?.[1] ?? "{}") as Record<string, string>;
    assert.deepEqual(tiers, Object.fromEntries(Object.entries(TIER_LABEL).map(([tier, label]) => [label, tier])), "each flagged label gets its tier's look");
  });

  await check("the view's colors are maple.css's, by day and in dark mode", () => {
    const css = readFileSync(join(here, "../src/app/maple/maple.css"), "utf8");
    assert.deepEqual(MP_TOKENS.light, cssVars(css, ":root"));
    assert.deepEqual(MP_TOKENS.dark, cssVars(css, ".dark"));
    for (const [name, value] of Object.entries(MP_TOKENS.dark)) assert(html.includes(`${name}: ${value};`), name);
    assert(/:root\[data-theme="dark"\]/.test(html) && /prefers-color-scheme: dark/.test(html), "the host's theme, else the device's");
  });

  await check("no emoji or long dashes anywhere on the page", () => {
    assert(!/\p{Extended_Pictographic}/u.test(html), "emoji");
    assert(!/[–—]/.test(html), "en or em dash");
  });

  await check("the days drawn are the in-app chart's for any per_day, and refused exactly when it refuses them", () => {
    const next = random(20261105);
    let refused = 0;
    let drawn = 0;
    for (let i = 0; i < 4000; i++) {
      const raw = fuzzRows(next);
      for (const perDay of [raw, JSON.parse(JSON.stringify(raw)) as unknown]) {
        const want = inAppDays(perDay);
        const got = activityDays(perDay, TO, CHART_DAYS);
        if (want === "refused") {
          assert.equal(got, null, `case ${i}: the in-app chart refuses ${JSON.stringify(perDay)}`);
          refused++;
        } else {
          assert.deepEqual(got, want, `case ${i}`);
          assert(parseChatChart({ version: 1, kind: "activity", asOf: NOW.toISOString(), timezone: TZ, from: got![0].date, to: TO, range: 14, metric: "feeds", days: got }), "a snapshot the in-app card renders");
          drawn++;
        }
      }
    }
    assert(refused > 400 && drawn > 4000, `both kinds of case ran (${refused} refused, ${drawn} drawn)`);
    assert.equal(activityDays([], "2026-02-30", 14), null, "a to that isn't a calendar day");
    assert.equal(activityDays([], 20261105, 14), null);
    assert.equal(activityDays({ length: 1 }, TO, 14), null);
  });

  await check("the served activityDays and activityModel run alone and agree with the imported ones", () => {
    const sandbox = vm.createContext({});
    const servedDays = vm.runInContext(`(${activityDays.toString()})`, sandbox) as typeof activityDays;
    const servedModel = vm.runInContext(`(${activityModel.toString()})`, sandbox) as typeof activityModel;
    const next = random(7);
    for (let i = 0; i < 500; i++) {
      const rows = fuzzRows(next);
      const result = summary(1 + Math.floor(next() * 31), rows as Row[], next() < 0.3 ? { flagged: [{ local: "x", when: "9:59 AM today", what: "dirty diaper (white)", tier: "Call your pediatrician today", title: "Pale poop: call your pediatrician today" }] } : {});
      assert.equal(JSON.stringify(servedDays(rows, TO, CHART_DAYS)), JSON.stringify(activityDays(rows, TO, CHART_DAYS)), `days ${i}`);
      assert.equal(JSON.stringify(servedModel(result, servedDays)), JSON.stringify(model(result)), `model ${i}`);
    }
  });

  await check("one day draws today's three counts, missing ones as no logs, never 0", () => {
    const m = model(summary(1, [row(TO, { feeds: 3, dirty: 1 })]));
    assert.deepEqual(m, { kind: "day", to: TO, day: { date: TO, partial: true, feeds: 3, sleepHours: null, wet: 0, dirty: 1 }, alerts: [] });
    const empty = model(summary(1, [row(TO)]));
    assert.deepEqual(empty.kind === "day" && empty.day, { date: TO, partial: true, feeds: null, sleepHours: null, wet: null, dirty: null });
  });

  await check("several days draw the in-app chart's days the summary covers, with 7 and all of them offered", () => {
    for (const [n, ranges] of [[2, [2]], [7, [7]], [8, [7, 8]], [10, [7, 10]], [14, [7, 14]]] as const) {
      const result = summary(n, fullWeeks(n));
      const m = model(result);
      assert(m.kind === "days", `${n} days`);
      assert.deepEqual(m.days, inApp(result).slice(-n), `${n} days are the in-app chart's`);
      assert.deepEqual(m.ranges, ranges);
      assert.equal(m.earlier, false);
      assert.equal(m.days.at(-1)?.partial, true, "today is partial");
    }
    const month = summary(31, fullWeeks(31));
    const m = model(month);
    assert(m.kind === "days" && m.days.length === CHART_DAYS && m.earlier && m.summaryDays === 31, "a month draws the last 14 days and says so");
    assert.deepEqual(m.days, inApp(month));
  });

  await check("days before the summary's first day (before the birth) aren't drawn as missing logs", () => {
    const born = summary(7, [row(addDays(TO, -2), { feeds: 2, partial: true }), row(addDays(TO, -1), { feeds: 8 }), row(TO, { feeds: 4 })]);
    const m = model(born);
    assert(m.kind === "days");
    assert.deepEqual(m.days.map((d) => d.date), [addDays(TO, -2), addDays(TO, -1), TO]);
    assert.deepEqual(m.days, inApp(born).slice(-3));
    assert.deepEqual(m.ranges, [3]);
    assert.equal(m.days[0].partial, true, "the birthday is partial");
    assert.equal(model(summary(7, [row(TO, { feeds: 1 })])).kind, "day", "born today: one day");
    const unborn = model(summary(7, fullWeeks(7).map((r) => ({ ...r, feeds: 0, wet: 0, dirty: 0, sleep_hours: 0 }))));
    assert(unborn.kind === "days" && unborn.days.every((d) => d.feeds === null && d.sleepHours === null && d.wet === null), "nothing logged is no logs, not zero");
  });

  await check("flagged events come through word for word, however they're written", () => {
    const flagged = [
      { local: "Today 9:59 AM", when: "9:59 AM today", what: "dirty diaper (pale yellow)", tier: "Call your pediatrician today", title: "Pale poop: call your pediatrician today" },
      { local: "Today 10:01 AM", when: "10:01 AM today", what: "temperature 100.6°F (38.1°C), rectal", tier: "Call your pediatrician now", title: "Fever: call your pediatrician now" },
      { local: "x", when: '<img src=x onerror="alert(1)">', what: "<script>alert(1)</script> & \"quoted\"", tier: "A label the view doesn't know", title: "</section><b>bold?</b>" },
    ];
    for (const n of [1, 7]) {
      const m = model(summary(n, fullWeeks(n), { flagged, mom: { name: "Dana", medicines: [{ name: "Ibuprofen" }] } }));
      assert(m.kind !== "fallback");
      assert.deepEqual(m.alerts, flagged.map(({ tier, title, what, when }) => ({ tier, title, what, when })));
      assert(!JSON.stringify(m).includes("Dana") && !JSON.stringify(m).includes("Ibuprofen"), "her block never reaches the chart");
    }
  });

  await check("a result the view can't fully check draws nothing but the plain line", () => {
    const good = summary(7, fullWeeks(7));
    const sc = good.structuredContent as Record<string, unknown>;
    const alert = { local: "x", when: "9:59 AM today", what: "dirty diaper (white)", tier: "Call your pediatrician today", title: "Pale poop: call your pediatrician today" };
    const unreadable: [string, unknown][] = [
      ["no result", null],
      ["text only", { content: good.content }],
      ["structuredContent not an object", { structuredContent: [sc] }],
      ["a count as text", { structuredContent: { ...sc, per_day: [row(TO, { feeds: "5" as unknown as number })] } }],
      ["a day twice", { structuredContent: { ...sc, per_day: [row(TO), row(TO)] } }],
      ["no to", { structuredContent: { ...sc, to: undefined } }],
      ["days out of range", { structuredContent: { ...sc, days: 32 } }],
      ["days as text", { structuredContent: { ...sc, days: "7" } }],
      ["from that doesn't fit days", { structuredContent: { ...sc, from: addDays(TO, -7) } }],
      ["flagged not a list", { structuredContent: { ...sc, flagged: { 0: alert } } }],
      ["a flagged event without its title", { structuredContent: { ...sc, flagged: [{ ...alert, title: undefined }] } }],
      ["a blank flagged label", { structuredContent: { ...sc, flagged: [{ ...alert, tier: "  " }] } }],
      ["a flagged text too long to show whole", { structuredContent: { ...sc, flagged: [{ ...alert, what: "x".repeat(501) }] } }],
      ["a flagged event that isn't one", { structuredContent: { ...sc, flagged: ["Call your pediatrician now"] } }],
      ["alerts the view doesn't draw", { structuredContent: { ...sc, alerts: [{ tier: "now", label: "Call your pediatrician now", title: "Fever", body: "…" }] } }],
    ];
    for (const [label, result] of unreadable) assert.deepEqual(model(result), { kind: "fallback", reason: "unreadable" }, label);
    assert.deepEqual(model({ ...good, isError: true }), { kind: "fallback", reason: "error" });
    assert.equal(model({ structuredContent: { ...sc, alerts: [] } }).kind, "days", "an empty alerts list is nothing to show");
    assert.equal(model({ structuredContent: { ...sc, flagged: undefined } }).kind, "days", "no flagged list is no flagged events");
  });

  await check("the reviewed family-1 reply (copy fixture) draws its day and both of its flagged events", () => {
    const golden = JSON.parse(readFileSync(join(here, "tenancy/copy.family-one.json"), "utf8")) as Record<string, string>;
    const text = golden["family1.tool.17.daily_summary"];
    const cut = text.lastIndexOf("\n");
    const data = JSON.parse(text.slice(cut + 1)) as { flagged: { tier: string; title: string; what: string; when: string }[] };
    const m = model({ content: [{ type: "text", text }], structuredContent: { summary: text.slice(0, cut), ...data } });
    assert(m.kind === "day", m.kind);
    assert.deepEqual(m.day, { date: "2026-10-21", partial: true, feeds: 1, sleepHours: 0.8, wet: 0, dirty: 1 });
    assert.equal(m.alerts.length, 2);
    assert.deepEqual(m.alerts, data.flagged.map(({ tier, title, what, when }) => ({ tier, title, what, when })));
  });

  console.log(`\n${passed} MCP App checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
