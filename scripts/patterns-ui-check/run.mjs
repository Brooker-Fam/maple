import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const tailwind = require("@tailwindcss/postcss");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const output = await mkdtemp(path.join(tmpdir(), "maple-patterns-ui-"));
const screenshots = path.join(root, "test-results/maple-patterns-ui");
await mkdir(screenshots, { recursive: true });
await build({
  entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env.NODE_ENV": '"test"' },
  plugins: [{ name: "synthetic-pattern-boundaries", setup(plugin) {
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav|ChatNav|useTimerActions|sheets)$/ }, () => ({ path: path.join(here, "mocks.jsx") }));
    plugin.onResolve({ filter: /^next\/dynamic$/ }, () => ({ path: path.join(here, "dynamic.jsx") }));
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => args.importer.endsWith("/sheets/parts.tsx") ? { path: path.join(here, "mocks.jsx") } : undefined);
  } }],
});
const css = path.join(root, "src/app/globals.css");
const compiled = await postcss([tailwind({ base: root })]).process(await readFile(css, "utf8"), { from: css });
await writeFile(path.join(output, "app.css"), compiled.css + "\n" + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
await writeFile(path.join(output, "index.html"), '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic pattern check</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const origin = "https://maple-patterns.example.test";
const only = process.env.MAPLE_PATTERNS_ONLY ? new RegExp(process.env.MAPLE_PATTERNS_ONLY) : null;
const settled = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const noOverflow = async (page) => {
  await settled(page);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "No horizontal page overflow on a narrow phone");
};
async function scenario(name, query, width, check) {
  if (only && !only.test(name)) return;
  const context = await browser.newContext({ viewport: { width, height: 812 }, reducedMotion: "reduce", locale: "en-US", serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors = [];
  const network = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || !["/", "/app.js", "/app.css"].includes(url.pathname)) {
      network.push(route.request().url());
      await route.abort();
      return;
    }
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    await route.fulfill({ contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html", body: await readFile(path.join(output, file)) });
  });
  try {
    await page.goto(`${origin}/?${query}${query.includes("historyShell") ? "#history/patterns" : ""}`);
    await page.waitForFunction(() => !!window.__patterns);
    await check(page);
    await noOverflow(page);
    assert.deepEqual(network, [], "Fixture cannot contact any external service");
    assert.deepEqual(errors, [], "No browser runtime errors");
    console.log(`PASS ${name}`);
  } catch (error) {
    await page.screenshot({ path: path.join(screenshots, "failure.png"), fullPage: true }).catch(() => {});
    console.error(await page.locator("body").innerText());
    console.error("Focused element:", await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute("aria-label"), text: document.activeElement?.textContent?.trim().slice(0, 100) })));
    throw new Error(`${name}: ${error.message}`, { cause: error });
  } finally {
    await context.close();
  }
}

try {
  await scenario("clock is visible first; keyboard choices show one pattern view at a time", "", 320, async (page) => {
    const choices = page.getByRole("radiogroup", { name: "Pattern view", exact: true });
    await choices.getByRole("radio", { name: "Day clock", exact: true }).waitFor();
    assert.equal(await choices.getByRole("radio", { name: "Day clock", exact: true }).getAttribute("aria-checked"), "true");
    await page.getByRole("region", { name: "Day dial", exact: true }).waitFor();
    assert.equal(await page.getByText("Feeds per day", { exact: true }).isVisible(), false);
    await noOverflow(page);
    await page.screenshot({ path: path.join(screenshots, "clock-320-day.png"), fullPage: true });
    await choices.getByRole("radio", { name: "Day clock", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await choices.getByRole("radio", { name: "Compare days", exact: true }).getAttribute("aria-checked"), "true");
    assert.equal(await page.getByRole("region", { name: "Day dial", exact: true }).count(), 0);
    await page.getByRole("radio", { name: "Circles", exact: true }).click();
    await noOverflow(page);
    await page.screenshot({ path: path.join(screenshots, "circles-320-day.png"), fullPage: true });
    await choices.getByRole("radio", { name: "Daily totals", exact: true }).click();
    await page.getByRole("table", { name: "Daily totals", exact: true }).waitFor();
    assert.equal(await page.getByText("Feeds per day", { exact: true }).isVisible(), false);
    await page.getByRole("button", { name: "Charts", exact: true }).click();
    await page.getByText("Feeds per day", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await page.getByRole("table", { name: "Daily totals", exact: true }).waitFor();
    assert.equal(await page.getByText("Feeds per day", { exact: true }).count(), 0);
    const today = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "Today", exact: true }) });
    assert.equal(await today.getByRole("cell").first().innerText(), "2");
    await noOverflow(page);
  });

  await scenario("ribbons and circles preserve days, totals, filters and timeline action", "", 375, async (page) => {
    await page.getByRole("radio", { name: "Compare days", exact: true }).click();
    const todayRibbon = page.getByRole("button", { name: /^Today.*Open in the Timeline$/ });
    await todayRibbon.waitFor();
    const ribbonLabel = await todayRibbon.getAttribute("aria-label");
    assert.match(ribbonLabel, /2 feeds.*1 wet.*1 dirty.*4h 00m sleep/);
    await page.getByRole("radio", { name: "Circles", exact: true }).click();
    const todayCircle = page.getByRole("button", { name: /^Today.*Open this day in the Timeline/ });
    await todayCircle.waitFor();
    const circleLabel = await todayCircle.getAttribute("aria-label");
    for (const value of ["2 feeds", "1 wet", "1 dirty", "4h 00m sleep", "so far"]) assert(circleLabel.includes(value), `Circle includes ${value}`);
    const blankDay = page.getByRole("button", { name: /Oct 26.*No activity logged/ });
    await blankDay.waitFor();
    assert(!(await blankDay.getAttribute("aria-label")).includes("0 feeds"), "A blank day describes missing logs, not a missed feed");
    await page.getByRole("radiogroup", { name: "Activity to show", exact: true }).getByRole("radio", { name: "Sleep", exact: true }).click();
    const sleepLabel = await todayCircle.getAttribute("aria-label");
    assert(sleepLabel.includes("4h 00m sleep"));
    assert(!sleepLabel.includes("feeds") && !sleepLabel.includes("wet"), "Activity filter removes unrelated numbers");
    await noOverflow(page);
    await page.getByRole("radiogroup", { name: "Activity to show", exact: true }).getByRole("radio", { name: "All", exact: true }).click();
    await page.getByRole("radio", { name: "Nights", exact: true }).click();
    await page.getByText(/noon to noon/).first().waitFor();
    await page.evaluate(() => window.__patterns.night(true));
    await settled(page);
    await page.screenshot({ path: path.join(screenshots, "circles-375-night.png"), fullPage: true });
    await page.getByRole("radio", { name: "Days", exact: true }).click();
    await todayCircle.click();
    assert((await page.evaluate(() => window.__patterns.calls())).some((call) => call.kind === "navigate" && call.target === "log"));
    await page.evaluate(() => window.__patterns.growth());
    await page.getByText("Growth chart fixture", { exact: true }).waitFor();
  });

  await scenario("clock activity layers persist across views and entries open by keyboard", "", 320, async (page) => {
    await page.setViewportSize({ width: 320, height: 568 });
    const activity = page.getByRole("radiogroup", { name: "Activity to show", exact: true });
    await activity.getByRole("radio", { name: "All", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await activity.getByRole("radio", { name: "Feeds", exact: true }).getAttribute("aria-checked"), "true");
    await page.getByText("Browse logged entries", { exact: true }).click();
    const entries = page.locator(".mp-dial-log").getByRole("button");
    assert.equal(await entries.count(), 2, "The feed layer exposes only the two recorded feeds");
    const entry = entries.last();
    await entry.scrollIntoViewIfNeeded();
    await entry.focus();
    await page.keyboard.press("Enter");
    const detail = page.getByRole("region", { name: "Selected log entries", exact: true });
    await detail.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Selected log entries");
    assert(await detail.getByRole("heading").evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }), "Opening a scrolled entry brings its detail heading into view");
    assert.equal((await page.evaluate(() => window.__patterns.calls())).filter((call) => call.kind === "sheet").length, 0, "Browsing an event does not open an edit sheet");
    await page.keyboard.press("Escape");
    await detail.waitFor({ state: "hidden" });
    assert(await entry.evaluate((el) => el === document.activeElement), "Escape restores the selected entry's keyboard focus");
    assert(await entry.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }), "Restored entry focus stays visible on a short phone");

    await page.getByRole("radio", { name: "Compare days", exact: true }).click();
    assert.equal(await activity.getByRole("radio", { name: "Feeds", exact: true }).getAttribute("aria-checked"), "true", "Activity selection carries into comparison");
    await page.getByRole("radio", { name: "Circles", exact: true }).click();
    const today = await page.getByRole("button", { name: /^Today.*Open this day in the Timeline/ }).getAttribute("aria-label");
    assert(today.includes("2 feeds") && !today.includes("wet") && !today.includes("sleep"), "Comparison shows the selected feed layer");
    await page.getByRole("radio", { name: "Day clock", exact: true }).click();
    assert.equal(await activity.getByRole("radio", { name: "Feeds", exact: true }).getAttribute("aria-checked"), "true");
    await activity.getByRole("radio", { name: "Feeds", exact: true }).focus();
    await page.keyboard.press("End");
    assert.equal(await activity.getByRole("radio", { name: "Diapers", exact: true }).getAttribute("aria-checked"), "true");
    if (await page.locator(".mp-dial-log").getAttribute("open") === null) await page.getByText("Browse logged entries", { exact: true }).click();
    assert.equal(await entries.count(), 1, "The diaper layer exposes the one recorded change");
    await entries.first().click();
    await detail.getByRole("button", { name: /^Edit / }).click();
    const opened = (await page.evaluate(() => window.__patterns.calls())).find((call) => call.kind === "sheet");
    assert.equal(opened.value.kind, "diaper", "Explicit Edit opens the selected record's sheet");
    assert.equal(Date.parse(opened.value.entry.started_at), Date.parse("2026-10-29T09:00:00-04:00"));
    await noOverflow(page);
  });

  await scenario("viewers can explore recorded entries without edit controls", "viewer=1", 375, async (page) => {
    await page.getByText("Browse logged entries", { exact: true }).click();
    const entry = page.locator(".mp-dial-log").getByRole("button").last();
    await entry.focus();
    await page.keyboard.press("Enter");
    const detail = page.getByRole("region", { name: "Selected log entries", exact: true });
    await detail.waitFor();
    assert.equal(await detail.getByRole("button", { name: /^Edit / }).count(), 0, "View-only members get detail without an editing action");
    assert.equal((await page.evaluate(() => window.__patterns.calls())).filter((call) => call.kind === "sheet").length, 0);
    await page.keyboard.press("Escape");
    await detail.waitFor({ state: "hidden" });
  });

  await scenario("tapping a clock mark reveals its details on a short phone", "", 320, async (page) => {
    await page.setViewportSize({ width: 320, height: 568 });
    const dial = page.getByRole("region", { name: "Day dial", exact: true }).getByRole("img");
    await dial.scrollIntoViewIfNeeded();
    const box = await dial.boundingBox();
    // The synthetic 6 AM feed is on the right of the 24-hour dial's middle ring.
    await dial.click({ position: { x: box.width * 284 / 348, y: box.height / 2 } });
    const detail = page.getByRole("region", { name: "Selected log entries", exact: true });
    await detail.waitFor();
    await settled(page);
    await page.screenshot({ path: path.join(screenshots, "clock-320-selected-event.png"), fullPage: true });
    const heading = await detail.getByRole("heading").boundingBox();
    assert(heading.y >= 0 && heading.y + heading.height <= 568, `Tapped entry details must be visible without another scroll; heading starts at ${heading.y}`);
    assert.equal((await page.evaluate(() => window.__patterns.calls())).filter((call) => call.kind === "sheet").length, 0);
  });

  await scenario("historical clock failure exposes retry instead of empty totals", "historyError=1", 375, async (page) => {
    await page.getByRole("region", { name: "Day dial", exact: true }).waitFor();
    const previous = page.getByRole("button", { name: /Previous day|Earlier day/ });
    await previous.click();
    await previous.click();
    await page.getByText("Couldn't load this day's log.", { exact: true }).waitFor();
    const retry = page.getByRole("button", { name: /Try again|Retry/ });
    await retry.waitFor();
    assert.equal(await page.getByRole("img", { name: /0 feeds, 0 wet and 0 dirty/ }).count(), 0);
    assert.equal(await page.getByText("Nursing · L 100% · R 0%", { exact: true }).isVisible(), false);
    await page.evaluate(() => window.__patterns.allowHistory());
    await retry.click();
    await page.getByRole("img", { name: /2 feeds, 1 wet and 1 dirty diapers/ }).waitFor();
    assert.equal(await retry.count(), 0);
  });

  await scenario("growth shortcut remains available when comparison history fails", "rangeError=1", 375, async (page) => {
    await page.getByRole("region", { name: "Day dial", exact: true }).waitFor();
    await page.getByRole("img", { name: /2 feeds, 1 wet and 1 dirty diapers/ }).waitFor();
    await page.getByRole("radio", { name: "Compare days", exact: true }).click();
    await page.getByText("Couldn't load the history for these patterns.", { exact: true }).waitFor();
    assert.equal(await page.getByText("Growth chart fixture", { exact: true }).isVisible(), false);
    await page.evaluate(() => window.__patterns.growth());
    await page.getByText("Growth chart fixture", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: /^Growth Weight, length and head measurements$/ }).getAttribute("aria-expanded"), "true");
    assert.equal(await page.getByText("Couldn't load the history for these patterns.", { exact: true }).isVisible(), true);
  });

  await scenario("round1 totals preserve pumped milk and tummy time in table and charts", "extraTotals=1&metric=1", 320, async (page) => {
    await page.getByRole("radio", { name: "Daily totals", exact: true }).click();
    const table = page.getByRole("table", { name: "Daily totals", exact: true });
    await table.waitFor();
    const headers = await table.getByRole("columnheader").allTextContents();
    assert.deepEqual(headers.slice(0, 5), ["Day", "Feeds", "Sleep", "Wet", "Dirty"], "The first columns expose everyday counts");
    const today = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "Today", exact: true }) });
    const cells = await today.locator("th,td").allTextContents();
    assert.equal(cells[headers.indexOf("Pumped")], "1 session · 15m90 ml logged");
    assert.equal(cells[headers.indexOf("Tummy time")], "10m");
    const scroll = page.getByRole("region", { name: "Daily totals table", exact: true });
    await scroll.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.querySelector('[aria-label="Daily totals table"]').scrollLeft > 0);
    await noOverflow(page);
    await page.getByRole("button", { name: "Charts", exact: true }).click();
    await page.getByRole("button", { name: /More charts/ }).click();
    await page.getByRole("img", { name: /Recorded pump volume per day:.*10\/29 90 ml logged/ }).waitFor();
    await page.getByRole("img", { name: /Tummy time per day:.*10\/29 10m/ }).waitFor();
  });

  await scenario("round1 circles reveal one more week at a time", "longHistory=1", 375, async (page) => {
    await page.getByRole("radio", { name: "Compare days", exact: true }).click();
    await page.getByRole("radio", { name: "14 days", exact: true }).click();
    await page.getByRole("radio", { name: "Circles", exact: true }).click();
    const circles = page.getByRole("button", { name: /Open this day in the Timeline/ });
    const more = page.getByRole("button", { name: "Show 7 more days", exact: true });
    await more.waitFor();
    assert.equal(await circles.count(), 7);
    await more.click();
    assert.equal(await circles.count(), 14);
    assert.equal(await more.count(), 0);
    await page.getByRole("radio", { name: "Ribbons", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: /Open in the Timeline$/ }).count(), 14, "Both layouts cover the selected fortnight");
  });

  await scenario("round1 actual History shell preserves sticky controls and day navigation", "historyShell=1", 1024, async (page) => {
    await page.getByRole("heading", { name: "History", exact: true }).waitFor();
    assert.equal(await page.getByRole("radio", { name: "Patterns", exact: true }).getAttribute("aria-checked"), "true");
    await page.getByRole("radio", { name: "Compare days", exact: true }).click();
    await page.getByRole("radio", { name: "Circles", exact: true }).click();
    await page.getByRole("button", { name: /^Today.*Open this day in the Timeline/ }).waitFor();
    await page.screenshot({ path: path.join(screenshots, "circles-1024-history.png"), fullPage: true });
    await page.setViewportSize({ width: 320, height: 568 });
    await page.getByRole("radio", { name: "Ribbons", exact: true }).click();
    const yesterday = page.getByRole("button", { name: /^Yesterday.*Open in the Timeline$/ });
    await yesterday.scrollIntoViewIfNeeded();
    await settled(page);
    const bar = await page.getByRole("radiogroup", { name: "Show", exact: true }).boundingBox();
    assert(bar.y >= 0 && bar.y + bar.height <= 568, "History navigation remains visible while the graph scrolls");
    await page.screenshot({ path: path.join(screenshots, "ribbons-320-history.png"), fullPage: false });
    await yesterday.click();
    await page.waitForURL(/#history\/timeline$/);
    assert.equal(await page.getByRole("radio", { name: "Timeline", exact: true }).getAttribute("aria-checked"), "true");
    await noOverflow(page);
  });

  await scenario("round3 historical clock reflects edits and deletions from another device", "metric=1", 375, async (page) => {
    const previous = page.getByRole("button", { name: /Previous day|Earlier day/ });
    for (let i = 0; i < 4; i++) await previous.click();
    await page.getByRole("img", { name: /2 feeds, 1 wet and 1 dirty diapers/ }).waitFor();
    await page.getByText("Browse logged entries", { exact: true }).click();
    const id = await page.evaluate(() => window.__patterns.entries().find((entry) => entry.kind === "feed" && entry.data.method === "bottle" && entry.started_at.startsWith("2026-10-25")).id);
    await page.locator(".mp-dial-log").getByRole("button", { name: /60 ml/ }).click();
    const detail = page.getByRole("region", { name: "Selected log entries", exact: true });
    await detail.waitFor();
    await page.evaluate((id) => window.__patterns.updateEntry(id, { data: { method: "bottle", amount_ml: 90 } }), id);
    await page.locator(".mp-dial-log").getByRole("button", { name: /90 ml/ }).waitFor();
    await detail.getByText("90 ml", { exact: true }).waitFor();
    await page.evaluate((id) => window.__patterns.removeEntry(id), id);
    await page.getByRole("img", { name: /1 feeds?, 1 wet and 1 dirty diapers/ }).waitFor();
    assert.equal(await page.locator(".mp-dial-log").getByRole("button", { name: /Bottle/ }).count(), 0, "Deleted historical events leave the clock without a remount");
    assert.equal(await detail.getByRole("button", { name: /^Edit / }).count(), 0, "A remotely deleted record cannot remain as an edit action");
  });

  await scenario("round3 an unavailable latest week is not presented as blank days", "missingRecent=1", 375, async (page) => {
    await page.getByRole("radio", { name: "Compare days", exact: true }).click();
    await page.getByText(/Couldn't load every day|Couldn't load the history/).waitFor();
    await page.waitForFunction(() => window.__patterns.calls().filter((call) => call.kind === "api").length >= 2);
    await settled(page);
    assert.equal(await page.getByRole("button", { name: /Open in the Timeline$|Open this day in the Timeline/ }).count(), 0, "Failed newest history has no pretend empty comparison days");
    await page.getByRole("radio", { name: "Daily totals", exact: true }).click();
    assert.equal(await page.getByRole("table", { name: "Daily totals", exact: true }).count(), 0, "Unknown newest totals are not shown as zero");
    await page.evaluate(() => window.__patterns.allowRange());
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.getByRole("table", { name: "Daily totals", exact: true }).waitFor();
  });

  await scenario("round3 late historical response cannot replace a newer selected day", "", 375, async (page) => {
    await page.evaluate(() => window.__patterns.holdDay("2026-10-27"));
    const previous = page.getByRole("button", { name: /Previous day|Earlier day/ });
    await previous.click();
    await previous.click();
    await page.waitForFunction(() => window.__patterns.calls().some((call) => call.kind === "api" && call.path.includes("from=2026-10-26&to=2026-10-27")));
    await previous.click();
    await page.getByRole("img", { name: /Monday, Oct 26: 0 feeds/ }).waitFor();
    await page.evaluate(() => window.__patterns.releaseDay("2026-10-27"));
    await settled(page);
    assert.equal(await page.getByRole("img", { name: /Monday, Oct 26: 0 feeds/ }).count(), 1);
  });

  await scenario("round3 failed refresh keeps the last loaded day with explicit retry", "", 375, async (page) => {
    const previous = page.getByRole("button", { name: /Previous day|Earlier day/ });
    for (let i = 0; i < 4; i++) await previous.click();
    await page.getByRole("img", { name: /2 feeds, 1 wet and 1 dirty diapers/ }).waitFor();
    await page.evaluate(() => window.__patterns.failHistory());
    await page.getByText("Couldn't update this day. Showing the last loaded entries.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("img", { name: /2 feeds, 1 wet and 1 dirty diapers/ }).count(), 1, "Transient refresh failures preserve known data");
    await page.evaluate(() => window.__patterns.allowHistory());
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.getByText("Couldn't update this day. Showing the last loaded entries.", { exact: true }).waitFor({ state: "hidden" });
  });

  await scenario("round3 capped historical day discloses incomplete totals", "truncatedDay=2026-10-25", 375, async (page) => {
    const previous = page.getByRole("button", { name: /Previous day|Earlier day/ });
    for (let i = 0; i < 4; i++) await previous.click();
    await page.getByRole("region", { name: "Day dial", exact: true }).getByText("Some entries could not be loaded. Totals for this day may be incomplete.", { exact: true }).waitFor();
    assert((await page.evaluate(() => window.__patterns.calls())).some((call) => call.kind === "api" && call.path.includes("from=2026-10-25&to=2026-10-25")), "Capped multi-day history is split down to the actual day");
  });

  await scenario("round4 closing the real edit sheet restores the connected clock action", "realSheet=1", 320, async (page) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.getByText("Browse logged entries", { exact: true }).click();
    const entry = page.locator(".mp-dial-log").getByRole("button").last();
    await entry.click();
    const detail = page.getByRole("region", { name: "Selected log entries", exact: true });
    const edit = detail.getByRole("button", { name: /^Edit / });
    await page.waitForFunction(() => document.activeElement === document.querySelector('[aria-label="Selected log entries"]'));
    await edit.focus();
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", { name: "Edit recorded entry", exact: true });
    await sheet.waitFor();
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await sheet.waitFor({ state: "hidden" });
    assert(await edit.evaluate((el) => el.isConnected && el === document.activeElement), "Closing a sheet returns keyboard focus to the connected Edit action");
    await page.keyboard.press("Escape");
    await detail.waitFor({ state: "hidden" });
    assert(await entry.evaluate((el) => el === document.activeElement), "The next Escape returns from details to the logged entry");
  });

  await scenario("round3 a night never uses an unavailable previous-week half", "missingOlder=1&now=2026-10-28T16:00:00.000Z", 375, async (page) => {
    await page.getByRole("radio", { name: "Compare days", exact: true }).click();
    await page.getByText(/Couldn't load every day/).waitFor();
    await page.getByRole("radio", { name: "Nights", exact: true }).click();
    await page.getByRole("button", { name: /^Last night.*Open in the Timeline$/ }).waitFor();
    assert.equal(await page.getByRole("button", { name: /^Sun night, Oct 25.*Open in the Timeline$/ }).count(), 0, "Monday's data cannot stand in for the unknown Sunday half of a night");
  });

  await scenario("round5 pump-only logs still expose their daily totals", "pumpOnly=1&metric=1", 320, async (page) => {
    await page.getByRole("radio", { name: "Daily totals", exact: true }).click();
    const table = page.getByRole("table", { name: "Daily totals", exact: true });
    await table.waitFor();
    const headers = await table.getByRole("columnheader").allTextContents();
    const today = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "Today", exact: true }) });
    assert.equal((await today.locator("th,td").allTextContents())[headers.indexOf("Pumped")], "1 session · 15m90 ml logged");
    assert.equal(await today.getByText("Nothing logged", { exact: true }).count(), 0);
    await page.getByRole("radio", { name: "Compare days", exact: true }).click();
    await page.getByText("No feeds, sleep, diapers or tummy time in this range", { exact: true }).waitFor();
    await page.getByText("Pumping sessions and amounts are in Daily totals.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: /Open in the Timeline$|Open this day in the Timeline/ }).count(), 0, "Pump-only logging explains the supported view instead of drawing empty clock days");
  });

  await scenario("round5 tummy-only logs remain visible in totals and comparison", "tummyOnly=1", 320, async (page) => {
    await page.getByRole("radio", { name: "Daily totals", exact: true }).click();
    const table = page.getByRole("table", { name: "Daily totals", exact: true });
    await table.waitFor();
    const headers = await table.getByRole("columnheader").allTextContents();
    const today = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "Today", exact: true }) });
    assert.equal((await today.locator("th,td").allTextContents())[headers.indexOf("Tummy time")], "10m");
    await page.getByRole("radio", { name: "Compare days", exact: true }).click();
    const ribbon = page.getByRole("button", { name: /^Today.*Open in the Timeline$/ });
    await ribbon.waitFor();
    assert(!(await ribbon.getAttribute("aria-label")).includes("No activity logged"));
    await page.getByRole("radio", { name: "Circles", exact: true }).click();
    const circle = page.getByRole("button", { name: /^Today.*Open this day in the Timeline/ });
    await circle.waitFor();
    assert.match(await circle.getAttribute("aria-label"), /10m tummy/);
  });

  await scenario("round5 short sleep has matching nonempty ribbon and circle summaries", "shortSleep=1", 375, async (page) => {
    await page.getByRole("radio", { name: "Compare days", exact: true }).click();
    await page.getByRole("radiogroup", { name: "Activity to show", exact: true }).getByRole("radio", { name: "Sleep", exact: true }).click();
    const ribbon = page.getByRole("button", { name: /^Today.*Open in the Timeline$/ });
    await ribbon.waitFor();
    const ribbonLabel = await ribbon.getAttribute("aria-label");
    assert(!/No (?:sleep|activity) logged/.test(ribbonLabel), "Thirty seconds of sleep is still a log");
    await page.getByRole("radio", { name: "Circles", exact: true }).click();
    const circle = page.getByRole("button", { name: /^Today.*Open this day in the Timeline/ });
    await circle.waitFor();
    const circleLabel = await circle.getAttribute("aria-label");
    assert(!/No (?:sleep|activity) logged/.test(circleLabel));
    const duration = circleLabel.match(/(?:<1m|less than (?:a|one) minute|\d+[sm]) sleep/);
    assert(duration && ribbonLabel.includes(duration[0]), "Both views describe the same short recorded duration");
  });

  await scenario("round5 sleep carried from yesterday is not an empty circle today", "sleepCarry=1", 375, async (page) => {
    await page.getByRole("radio", { name: "Compare days", exact: true }).click();
    const ribbon = page.getByRole("button", { name: /^Today.*Open in the Timeline$/ });
    await ribbon.waitFor();
    assert.match(await ribbon.getAttribute("aria-label"), /1h 00m sleep/);
    await page.getByRole("radio", { name: "Circles", exact: true }).click();
    const circle = page.getByRole("button", { name: /^Today.*Open this day in the Timeline/ });
    await circle.waitFor();
    assert.match(await circle.getAttribute("aria-label"), /1h 00m sleep/);
    assert(!(await circle.getAttribute("aria-label")).includes("No activity logged"));
  });

  await scenario("round5 continuing nursing explains why no new feed started today", "nurseCarry=1", 375, async (page) => {
    await page.getByRole("radio", { name: "Compare days", exact: true }).click();
    await page.getByRole("radiogroup", { name: "Activity to show", exact: true }).getByRole("radio", { name: "Feeds", exact: true }).click();
    const ribbon = page.getByRole("button", { name: /^Today.*Open in the Timeline$/ });
    await ribbon.waitFor();
    const ribbonLabel = await ribbon.getAttribute("aria-label");
    assert(!/No (?:feeds|activity) logged/.test(ribbonLabel));
    assert.match(ribbonLabel, /continu|started (?:earlier|before)|from (?:earlier|before|yesterday)/i);
    await page.getByRole("radio", { name: "Circles", exact: true }).click();
    const circle = page.getByRole("button", { name: /^Today.*Open this day in the Timeline/ });
    await circle.waitFor();
    const circleLabel = await circle.getAttribute("aria-label");
    assert(!/No (?:feeds|activity) logged/.test(circleLabel));
    assert.match(circleLabel, /continu|started (?:earlier|before)|from (?:earlier|before|yesterday)/i);
  });

  await scenario("round5 an unlogged table day is not a row of zeros", "", 375, async (page) => {
    await page.getByRole("radio", { name: "Daily totals", exact: true }).click();
    const table = page.getByRole("table", { name: "Daily totals", exact: true });
    await table.waitFor();
    const blank = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: /Oct 26/ }) });
    await blank.getByText("Nothing logged", { exact: true }).waitFor();
    assert.equal(await blank.getByRole("cell", { name: "0", exact: true }).count(), 0);
  });

  await scenario("round5 All discloses its maximum historical range", "born=2024-01-01T12:00:00.000Z", 375, async (page) => {
    await page.getByRole("radio", { name: "Compare days", exact: true }).click();
    await page.getByRole("radiogroup", { name: "Date range", exact: true }).getByRole("radio", { name: "All", exact: true }).click();
    await page.getByText(/399 days/).waitFor();
  });

  await scenario("round5 All discloses its fallback without a birth date", "noBirthDate=1", 375, async (page) => {
    await page.getByRole("radio", { name: "Compare days", exact: true }).click();
    await page.getByRole("radiogroup", { name: "Date range", exact: true }).getByRole("radio", { name: "All", exact: true }).click();
    await page.getByText(/30 days.*birth|birth.*30 days/).waitFor();
  });

  for (const whileEditing of [false, true]) {
    await scenario(`round4 remote deletion preserves keyboard recovery${whileEditing ? " after closing the edit sheet" : " from focused details"}`, whileEditing ? "realSheet=1" : "", 320, async (page) => {
      await page.getByText("Browse logged entries", { exact: true }).click();
      await page.locator(".mp-dial-log").getByRole("button", { name: /Bottle/ }).click();
      const detail = page.getByRole("region", { name: "Selected log entries", exact: true });
      const edit = detail.getByRole("button", { name: /^Edit / });
      await page.waitForFunction(() => document.activeElement === document.querySelector('[aria-label="Selected log entries"]'));
      await edit.focus();
      const sheet = page.getByRole("dialog", { name: "Edit recorded entry", exact: true });
      if (whileEditing) {
        await page.keyboard.press("Enter");
        await sheet.waitFor();
      }
      await page.evaluate(() => {
        const entry = window.__patterns.entries().find((entry) => entry.kind === "feed" && entry.data.method === "bottle" && entry.started_at.startsWith("2026-10-29"));
        window.__patterns.removeEntry(entry.id);
      });
      if (whileEditing) {
        await settled(page);
        assert(await sheet.evaluate((el) => el.contains(document.activeElement)), "A remote deletion does not steal focus out of the open sheet");
        await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
        await sheet.waitFor({ state: "hidden" });
      }
      await detail.getByText("This entry is no longer in this view.", { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('[aria-label="Selected log entries"]')?.contains(document.activeElement));
      await page.keyboard.press("Escape");
      await detail.waitFor({ state: "hidden" });
      assert(await page.locator(".mp-dial-log > summary").evaluate((el) => el === document.activeElement), "When the old event is gone, Escape returns to the surviving Browse control");
    });
  }

  await scenario("fresh snapshots appear before the minute tick while true future entries stay hidden", "empty=1", 375, async (page) => {
    await page.getByRole("region", { name: "Day dial", exact: true }).getByRole("img", { name: /0 wet/ }).waitFor();
    await page.evaluate(() => {
      const base = { kind: "diaper", ended_at: null, active: false, data: { pee: true, poop: false }, note: null,
        source: "app", created_by: "alex@example.test", updated_by: null,
        created_at: "2026-10-29T16:00:31.000Z", updated_at: "2026-10-29T16:00:31.000Z" };
      // The fixture's clock hook remains at noon. Only the accepted server snapshot advances.
      window.__patterns.snapshot("2026-10-29T16:00:31.000Z", [
        { ...base, id: 2001, started_at: "2026-10-29T16:00:30.000Z" },
        { ...base, id: 2002, started_at: "2026-10-29T16:02:00.000Z" },
      ]);
    });
    await page.getByRole("region", { name: "Day dial", exact: true }).getByRole("img", { name: /1 wet and 0 dirty/ }).waitFor();
    await page.getByText("Browse logged entries", { exact: true }).click();
    assert.equal(await page.locator(".mp-dial-log").getByRole("button").count(), 1, "The clock exposes the fresh log without the future one");
    await page.getByRole("radio", { name: "Compare days", exact: true }).click();
    const ribbon = page.getByRole("button", { name: /^Today.*Open in the Timeline$/ });
    await ribbon.waitFor();
    assert.match(await ribbon.getAttribute("aria-label"), /1 wet/);
    assert.equal(await ribbon.locator("svg title").count(), 1, "Ribbons draw the accepted snapshot's event only");
    await page.getByRole("radio", { name: "Circles", exact: true }).click();
    const circle = page.getByRole("button", { name: /^Today.*Open this day in the Timeline/ });
    await circle.waitFor();
    assert.match(await circle.getAttribute("aria-label"), /1 wet/);
    assert.equal(await circle.locator("svg title").count(), 1, "Circles exclude the actual future event too");
  });
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
