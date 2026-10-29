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
const settled = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const noOverflow = async (page) => {
  await settled(page);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "No horizontal page overflow on a narrow phone");
};
async function scenario(name, query, width, check) {
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
    await page.goto(`${origin}/?${query}`);
    await page.waitForFunction(() => !!window.__patterns);
    await check(page);
    await noOverflow(page);
    assert.deepEqual(network, [], "Fixture cannot contact any external service");
    assert.deepEqual(errors, [], "No browser runtime errors");
    console.log(`PASS ${name}`);
  } catch (error) {
    await page.screenshot({ path: path.join(screenshots, "failure.png"), fullPage: true }).catch(() => {});
    console.error(await page.locator("body").innerText());
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
    await page.getByLabel("Activity to show", { exact: true }).selectOption({ label: "Sleep" });
    const sleepLabel = await todayCircle.getAttribute("aria-label");
    assert(sleepLabel.includes("4h 00m sleep"));
    assert(!sleepLabel.includes("feeds") && !sleepLabel.includes("wet"), "Activity filter removes unrelated numbers");
    await noOverflow(page);
    await page.getByLabel("Activity to show", { exact: true }).selectOption({ label: "All activity" });
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
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
