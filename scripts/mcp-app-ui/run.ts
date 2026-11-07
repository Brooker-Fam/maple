/**
 * pnpm check:maple-mcp-app-ui: daily_summary's MCP App view in Chromium,
 * the page activityViewHtml() serves, in a sandboxed cross-origin frame of a
 * stand-in host under a no-network CSP, on made-up results only. The view
 * shakes hands first and reports its size only after; draws the chart,
 * flagged events word for word and nothing a result tries to inject; answers
 * the host's requests; follows the host's theme or the device's; and loads
 * nothing. It also takes ChatGPT's window.openai route with no handshake.
 * Screenshots (made-up data) go to test-results/maple-mcp-app/.
 *
 * Needs Playwright's Chromium (see scripts/chat-ui-check/README.md), or
 * MAPLE_UI_CHROMIUM pointing at a Chromium build.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";
import { ACTIVITY_VIEW_URI, MCP_APP_PROTOCOL, activityViewHtml } from "../../src/lib/maple/mcp-apps/activity";
import { MP_TOKENS } from "../../src/lib/maple/mcp-apps/activity-frame";
import { addDays } from "../../src/lib/maple/time";

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, "../../test-results/maple-mcp-app");
const HOST = "https://host.example.test";
const VIEW = "https://view.example.test";
/** A host's default for a page that declares no domains: inline code only, nothing fetched. */
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'";
const TO = "2026-11-05";
const html = activityViewHtml();

type Row = { date: string; partial?: boolean; feeds: number; wet: number; dirty: number; sleep_hours: number };
type Flag = { local: string; when: string; what: string; tier: string; title: string };
const row = (date: string, values: Partial<Row> = {}): Row => ({ date, feeds: 0, wet: 0, dirty: 0, sleep_hours: 0, ...(date === TO ? { partial: true } : {}), ...values });

function summary(days: number, rows: Row[], flagged: Flag[] = [], extra: Record<string, unknown> = {}) {
  const data = { days, from: addDays(TO, 1 - days), to: TO, paragraph: "A made-up paragraph.", per_day: rows, flagged, ...extra };
  const text = `Summary for the last ${days} days, ready for a pediatrician visit:`;
  return { content: [{ type: "text", text: `${text}\n${JSON.stringify(data)}` }], structuredContent: { summary: text, ...data } };
}

/** Two weeks, with days that have no feeds, no sleep or no diapers logged (today has all three but sleep). */
const TWO_WEEKS = Array.from({ length: 14 }, (_, i) =>
  row(addDays(TO, i - 13), { feeds: i % 5 === 2 ? 0 : 5 + (i % 4), sleep_hours: i % 6 === 1 ? 0 : 6 + (i % 3) * 1.5, wet: i % 7 === 2 ? 0 : 4 + (i % 3), dirty: i % 7 === 2 ? 0 : i % 3 })
);
const SHORT_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const label = (date: string) => SHORT_DAY.format(new Date(`${date}T12:00:00Z`));
const PAYLOAD = '<img src=x onerror="parent.postMessage({pwned:1},\'*\')"><script>parent.postMessage({pwned:2},"*")</script>';
const FLAGGED: Flag[] = [
  { local: "Today 9:59 AM", when: "9:59 AM today", what: "dirty diaper (pale yellow)", tier: "Call your pediatrician today", title: "Pale poop: call your pediatrician today" },
  { local: "Today 10:01 AM", when: "10:01 AM today", what: "temperature 100.6°F (38.1°C), rectal", tier: "Call your pediatrician now", title: "Fever: call your pediatrician now" },
  { local: "Today 11:30 AM", when: "11:30 AM today", what: "temperature 100.9°F (38.3°C), rectal", tier: "Call your pediatrician now", title: "Fever: call your pediatrician now" },
  { local: "Yesterday 3:12 AM", when: "3:12 AM yesterday", what: "vitals (SpO2 88%)", tier: "Call 911 now", title: "Low oxygen: call 911" },
  { local: "x", when: PAYLOAD, what: `${PAYLOAD} & "quoted"`, tier: "A label the view doesn't know", title: "</section><b>bold?</b>" },
];

function hostPage(theme: string, answer: "result" | "error" | "none", openai: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Stand-in host</title>
<style>body { margin: 0; padding: 0; background: ${theme === "dark" ? "#262624" : "#faf9f5"}; } iframe { display: block; width: 100%; height: 80px; border: 0; }</style></head>
<body><iframe id="app" sandbox="allow-scripts" src="${VIEW}/activity.html${openai ? "?openai=1" : ""}"></iframe>
<script>
const frame = document.getElementById("app");
const host = window.__host = { messages: [], views: [], initialized: false };
window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;
  const m = event.data;
  if (m && (m.__view || m.pwned || m.openaiHeight !== undefined)) { host.views.push(m); return; }
  host.messages.push(JSON.parse(JSON.stringify(m)));
  if (m && m.method === "ui/initialize") {
    if (${JSON.stringify(answer)} === "result") frame.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, hostInfo: { name: "stand-in host", version: "1" }, hostCapabilities: {}, hostContext: { ${theme === "none" ? "" : `theme: ${JSON.stringify(theme)}, `}displayMode: "inline", platform: "web" } } }, "*");
    if (${JSON.stringify(answer)} === "error") frame.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Not here" } }, "*");
  }
  if (m && m.method === "ui/notifications/initialized") host.initialized = true;
  if (m && m.method === "ui/notifications/size-changed") frame.style.height = m.params.height + "px";
});
host.send = (message) => frame.contentWindow.postMessage(message, "*");
</script></body></html>`;
}

/** In every frame: the view's errors and CSP refusals go to the host; with ?openai=1, ChatGPT's globals. */
function initScript(openaiOutput: unknown): string {
  return `(() => {
  if (location.origin !== ${JSON.stringify(VIEW)} && !location.href.startsWith(${JSON.stringify(VIEW)})) return;
  window.addEventListener("error", (event) => parent.postMessage({ __view: "error", message: String(event.message) }, "*"));
  document.addEventListener("securitypolicyviolation", (event) => parent.postMessage({ __view: "csp", message: event.violatedDirective + " " + event.blockedURI }, "*"));
  if (location.search.includes("openai=1")) {
    window.openai = { toolOutput: ${JSON.stringify(openaiOutput ?? null)}, theme: "dark", notifyIntrinsicHeight: (height) => parent.postMessage({ openaiHeight: height }, "*") };
  }
})();`;
}

type HostState = { messages: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number } }[]; views: { __view?: string; message?: string; pwned?: number; openaiHeight?: number }[]; initialized: boolean };
const state = (page: Page) => page.evaluate(() => (window as unknown as { __host: HostState }).__host) as Promise<HostState>;
const send = (page: Page, message: unknown) => page.evaluate((m) => (window as unknown as { __host: { send: (x: unknown) => void } }).__host.send(m), message);
const deliver = (page: Page, result: unknown) => send(page, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });

async function waitFor(page: Page, test: (s: HostState) => boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    if (test(await state(page))) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`timed out: ${label}`);
}

let browser: Browser;
const outside: string[] = [];
let passed = 0;

/** Every frame's errors and CSP refusals, then the context goes. */
async function close(page: Page, context: BrowserContext) {
  const views = (await state(page)).views.filter((v) => v.__view || v.pwned);
  await context.close();
  assert.deepEqual(views, [], "no error, CSP refusal or injected script in the view");
}

async function open(opts: { theme?: "light" | "dark" | "none"; answer?: "result" | "error" | "none"; openai?: unknown; width?: number; scheme?: "light" | "dark" } = {}): Promise<{ context: BrowserContext; page: Page; view: Frame }> {
  const context = await browser.newContext({ viewport: { width: opts.width ?? 375, height: 900 }, locale: "en-US", timezoneId: "UTC", colorScheme: opts.scheme ?? "light", reducedMotion: "reduce" });
  await context.addInitScript({ content: initScript(opts.openai) });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === HOST && url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: hostPage(opts.theme ?? "light", opts.answer ?? "result", opts.openai !== undefined) });
    if (url.origin === VIEW && url.pathname === "/activity.html") return route.fulfill({ status: 200, contentType: "text/html", headers: { "content-security-policy": CSP }, body: html });
    outside.push(url.href);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => outside.push(`page error: ${error.message}`));
  await page.goto(`${HOST}/`);
  let view: Frame | null = null;
  for (let i = 0; i < 100 && !view; i++) {
    view = page.frames().find((f) => f.url().startsWith(VIEW)) ?? null;
    if (!view) await page.waitForTimeout(50);
  }
  assert(view, "the view's frame loaded");
  await view.waitForSelector("#view .card");
  return { context, page, view };
}

async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

const text = (view: Frame, selector: string) => view.locator(selector).allTextContents();
const visibleText = async (view: Frame) => (await view.locator("#view").innerText()).replace(/\s+/g, " ");

async function main() {
  await mkdir(shots, { recursive: true });
  browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
  try {
    await check("the view asks to initialize first, and sends its size only once the host has answered", async () => {
      const { context, page, view } = await open();
      await waitFor(page, (s) => s.initialized && s.messages.some((m) => m.method === "ui/notifications/size-changed"), "initialized and sized");
      const { messages } = await state(page);
      assert.equal(messages[0].method, "ui/initialize");
      assert.deepEqual(messages[0].params, { appInfo: { name: "activity-view", version: "1.0.0" }, appCapabilities: { availableDisplayModes: ["inline"] }, protocolVersion: MCP_APP_PROTOCOL });
      const initialized = messages.findIndex((m) => m.method === "ui/notifications/initialized");
      const sized = messages.findIndex((m) => m.method === "ui/notifications/size-changed");
      assert(initialized > 0 && sized > initialized, "initialized, then size");
      assert(Number(messages[sized].params?.height) > 40, "a height the host can show");
      assert.deepEqual([...new Set(messages.map((m) => m.method))].sort(), ["ui/initialize", "ui/notifications/initialized", "ui/notifications/size-changed"]);
      assert.equal((await visibleText(view)).includes("Waiting for the summary"), true, "a placeholder until the result comes");
      await close(page, context);
    });

    await check("two weeks: the chart, every flagged event word for word and loudest first, nothing injected", async () => {
      const { context, page, view } = await open();
      await waitFor(page, (s) => s.initialized, "initialized");
      await deliver(page, summary(14, TWO_WEEKS, FLAGGED, { mom: { name: "Dana", medicines: [{ name: "Ibuprofen" }] } }));
      await view.waitForSelector("svg.bars");
      const words = await visibleText(view);
      for (const f of FLAGGED) {
        assert(words.includes(f.tier), f.tier);
        assert(words.includes(f.title), f.title);
        assert(words.includes(`${f.what} at ${f.when}`.replace(/\s+/g, " ")), f.what);
      }
      assert.deepEqual(await view.locator(".alert").evaluateAll((nodes) => nodes.map((n) => n.className)), ["alert alert--emergency", "alert alert--now", "alert alert--today", "alert alert--mention"]);
      assert.deepEqual(await text(view, ".alert--now .alert-events li"), ["temperature 100.6°F (38.1°C), rectal at 10:01 AM today", "temperature 100.9°F (38.3°C), rectal at 11:30 AM today"]);
      assert.equal(await view.locator("#view img, #view script, #view b").count(), 0, "markup in a result stays text");
      assert(!words.includes("Dana") && !words.includes("Ibuprofen"), "her block isn't drawn");
      assert.equal(await view.locator("h1.title").textContent(), "Activity over time");
      assert.equal(await view.locator(".subtitle").textContent(), "Oct 23 to Nov 5");
      assert.equal(await view.locator('[aria-label="Chart range"] [aria-checked="true"]').textContent(), "14 days");
      const feeds = TWO_WEEKS.filter((r) => r.feeds > 0).length;
      assert.equal(await view.locator("rect.bar").count(), feeds);
      assert.equal(await view.locator("line.missing").count(), 14 - feeds, "a day without feeds logged is a dash, not a zero bar");
      assert.equal(await view.locator("rect.bar--partial").count(), 1, "today is partial");
      assert.equal(await view.locator(".nav-day").textContent(), "Nov 5 · partial day");
      assert.equal(await view.locator(".nav-value").textContent(), `${TWO_WEEKS[13].feeds} feeds logged`);
      await page.screenshot({ path: join(shots, "two-weeks-light.png"), fullPage: true });

      await view.locator('[aria-label="Chart range"] button', { hasText: "7 days" }).click();
      assert.equal(await view.locator("table tbody tr").count(), 7);
      await view.locator('[aria-label="Chart metric"] button', { hasText: "Sleep" }).click();
      const yesterday = TWO_WEEKS[12];
      await view.locator("svg.bars").focus();
      await view.locator("svg.bars").press("ArrowLeft");
      assert.equal(await view.locator(".nav-day").textContent(), "Nov 4");
      assert.equal(await view.locator(".nav-value").textContent(), yesterday.sleep_hours > 0 ? `${yesterday.sleep_hours} h logged` : "No logs");
      await view.locator('[aria-label="Chart metric"] [aria-checked="true"]').focus();
      await view.locator('[aria-label="Chart metric"] [aria-checked="true"]').press("ArrowRight");
      assert.equal(await view.locator('[aria-label="Chart metric"] [aria-checked="true"]').textContent(), "Diapers");
      assert.equal(await view.locator(".legend").count(), 1);
      await view.locator("summary").click();
      const table = await text(view, "table tbody tr");
      assert.equal(table.length, 7);
      assert.equal(table.at(-1), `Nov 5 (partial)${TWO_WEEKS[13].wet} wet · ${TWO_WEEKS[13].dirty} dirty`);
      const dry = TWO_WEEKS.slice(-7).find((r) => r.wet + r.dirty === 0);
      assert(dry && table.includes(`${label(dry.date)}No logs`), "a day with no diapers logged says so");
      assert(await view.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scroll at 375px");
      const drawnHeight = () => view.evaluate(() => Math.ceil(document.documentElement.getBoundingClientRect().height));
      let reported = 0;
      for (let i = 0; i < 100; i++) {
        reported = Number((await state(page)).messages.filter((m) => m.method === "ui/notifications/size-changed").at(-1)?.params?.height);
        if (Math.abs(reported - (await drawnHeight())) <= 1) break;
        await page.waitForTimeout(50);
      }
      assert(Math.abs(reported - (await drawnHeight())) <= 1 && reported > 600, `the host was told the open table's height: ${reported}`);
      assert(Math.abs((await page.locator("#app").evaluate((frame) => frame.getBoundingClientRect().height)) - reported) <= 1, "and the stand-in host grew the frame to it");
      assert.deepEqual((await state(page)).views.filter((v) => v.pwned), [], "no payload ran");
      await close(page, context);
    });

    await check("one day: today's three counts, missing ones as no logs; and it fits 320px", async () => {
      const { context, page, view } = await open({ width: 320 });
      await waitFor(page, (s) => s.initialized, "initialized");
      await deliver(page, summary(1, [row(TO, { feeds: 3, dirty: 1 })]));
      await view.waitForSelector(".day-list");
      assert.equal(await view.locator("h1.title").textContent(), "Today so far");
      assert.deepEqual(await text(view, ".day-row"), ["Feeds3 feeds logged", "SleepNo logs", "Diapers0 wet · 1 dirty"]);
      assert.equal(await view.locator("svg.bars").count(), 0);
      assert(await view.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scroll at 320px");
      await page.screenshot({ path: join(shots, "one-day-320.png"), fullPage: true });
      await close(page, context);
    });

    await check("what it can't check, an error and a cancelled call each get a plain line", async () => {
      const { context, page, view } = await open();
      await waitFor(page, (s) => s.initialized, "initialized");
      await send(page, { jsonrpc: "2.0", method: "ui/notifications/tool-cancelled", params: { reason: "user action" } });
      await view.waitForSelector(".notice");
      assert.equal(await view.locator(".notice").textContent(), "The summary was stopped before it finished, so there's nothing to draw.");
      await deliver(page, summary(7, [row(TO, { feeds: "5" as unknown as number })], FLAGGED));
      await view.waitForFunction(() => document.querySelector(".notice")?.textContent?.startsWith("This summary can't"));
      assert.equal(await view.locator(".notice").textContent(), "This summary can't be drawn as a chart here. Everything in it is in the conversation.");
      assert.equal(await view.locator(".alert, svg.bars").count(), 0, "no chart and no partial picture beside the line");
      await deliver(page, { isError: true, content: [{ type: "text", text: "Maple's Log can't reach its database right now, so nothing was saved." }] });
      await view.waitForFunction(() => document.querySelector(".notice")?.textContent?.startsWith("The summary didn't"));
      await close(page, context);
    });

    await check("it answers the host's requests: teardown and ping with a result, anything else with method not found", async () => {
      const { context, page } = await open();
      await waitFor(page, (s) => s.initialized, "initialized");
      await send(page, { jsonrpc: "2.0", id: 41, method: "ui/resource-teardown", params: {} });
      await send(page, { jsonrpc: "2.0", id: 42, method: "ping" });
      await send(page, { jsonrpc: "2.0", id: 43, method: "ui/something-new", params: {} });
      await waitFor(page, (s) => s.messages.some((m) => m.id === 43), "answers");
      const answers = (await state(page)).messages.filter((m) => m.id === 41 || m.id === 42 || m.id === 43);
      assert.deepEqual(answers, [
        { jsonrpc: "2.0", id: 41, result: {} },
        { jsonrpc: "2.0", id: 42, result: {} },
        { jsonrpc: "2.0", id: 43, error: { code: -32601, message: "Method not found" } },
      ]);
      await close(page, context);
    });

    const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
    const colors = (view: Frame) => view.locator(".card").evaluate((card) => [getComputedStyle(card).backgroundColor, getComputedStyle(card).color]);

    await check("the host's theme picks the mp colors, and the device's when the host names none", async () => {
      const dark = await open({ theme: "dark" });
      await waitFor(dark.page, (s) => s.initialized, "initialized");
      await deliver(dark.page, summary(14, TWO_WEEKS, FLAGGED.slice(0, 2)));
      await dark.view.waitForSelector("svg.bars");
      assert.deepEqual(await colors(dark.view), [rgb(MP_TOKENS.dark["--mp-surface"]), rgb(MP_TOKENS.dark["--mp-ink"])]);
      await dark.page.screenshot({ path: join(shots, "two-weeks-dark.png"), fullPage: true });
      await send(dark.page, { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "light" } });
      await dark.view.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "light");
      assert.deepEqual(await colors(dark.view), [rgb(MP_TOKENS.light["--mp-surface"]), rgb(MP_TOKENS.light["--mp-ink"])]);
      await close(dark.page, dark.context);
      const device = await open({ theme: "none", scheme: "dark" });
      await waitFor(device.page, (s) => s.initialized, "initialized");
      assert.deepEqual(await colors(device.view), [rgb(MP_TOKENS.dark["--mp-surface"]), rgb(MP_TOKENS.dark["--mp-ink"])]);
      await close(device.page, device.context);
    });

    await check("ChatGPT's window.openai route draws toolOutput and reports height with no handshake", async () => {
      const { context, page, view } = await open({ answer: "none", openai: summary(7, TWO_WEEKS.slice(-7), FLAGGED.slice(0, 1)).structuredContent });
      await view.waitForSelector("svg.bars");
      assert(((await visibleText(view)).includes("Pale poop: call your pediatrician today")), "its flagged event");
      assert.equal(await view.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark");
      await waitFor(page, (s) => s.views.some((v) => Number(v.openaiHeight) > 300), "notifyIntrinsicHeight");
      const { messages } = await state(page);
      assert.deepEqual(messages.map((m) => m.method), ["ui/initialize"], "no initialized or size-changed without the handshake");
      await close(page, context);
    });

    await check("a host that refuses the handshake gets a plain line", async () => {
      const { context, page, view } = await open({ answer: "error" });
      await view.waitForSelector(".notice");
      assert.equal(await view.locator(".notice").textContent(), "This chart can't be shown here. The summary is in the conversation.");
      await close(page, context);
    });

    await check("nothing was fetched or thrown on any page (each view's own errors and CSP refusals were checked as it closed)", async () => {
      assert.deepEqual(outside, []);
    });
  } finally {
    await browser.close();
  }
  console.log(`\n${passed} MCP App browser checks passed (${ACTIVITY_VIEW_URI}); screenshots in test-results/maple-mcp-app`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
