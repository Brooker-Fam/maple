import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "maple-care-ui-"));
await build({ entryPoints: [path.join(root, "scripts/ui-review-care-fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true, format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env.NODE_ENV": '"test"' }, plugins: [{ name: "synthetic-care-boundaries", setup(plugin) {
  plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav)$/ }, () => ({ path: path.join(root, "scripts/ui-review-care-mocks.jsx") }));
  plugin.onResolve({ filter: /^\.\/index$/ }, (args) => args.importer.endsWith("/sheets/parts.tsx") ? { path: path.join(root, "scripts/ui-review-care-mocks.jsx") } : undefined);
} }] });
const cssFile = path.join(root, "src/app/globals.css");
const css = await postcss([tailwind({ base: root })]).process(await readFile(cssFile, "utf8"), { from: cssFile });
await writeFile(path.join(output, "app.css"), css.css + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
const page = await context.newPage();
page.setDefaultTimeout(3000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  const file = url.pathname === "/app.js" || url.pathname === "/app.css" ? url.pathname.slice(1) : null;
  return route.fulfill({ contentType: file?.endsWith("js") ? "text/javascript" : file ? "text/css" : "text/html", body: file ? await readFile(path.join(output, file)) : '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>' });
});
const visit = async (scenario) => { await page.goto(`https://maple-care.example.test/?scenario=${scenario}`); await page.getByRole("dialog").first().waitFor(); };
const range = async (from, to) => {
  await page.getByLabel("History from date").fill(from);
  await page.getByLabel("History to date").fill(to);
  await page.getByRole("button", { name: "Show history", exact: true }).click();
};
const confirmDraft = async (input, value, saveLabel) => {
  await input.fill(value);
  if (saveLabel) {
    await page.getByRole("button", { name: saveLabel, exact: true }).click();
    await page.getByText("Synthetic save failure", { exact: true }).waitFor();
    assert.equal(await input.inputValue(), value);
  }
  await page.keyboard.press("Escape");
  const discard = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
  await discard.waitFor();
  await discard.getByRole("button", { name: "Keep editing", exact: true }).click();
  await discard.waitFor({ state: "hidden" });
  assert.equal(await input.inputValue(), value);
  await page.keyboard.press("Escape");
  await discard.getByRole("button", { name: "Discard changes", exact: true }).click();
  await input.waitFor({ state: "hidden" });
};
const cases = [
  ["older doses are reachable by date and explicitly read only", async () => {
    await visit("detail");
    await page.getByRole("button", { name: "View older doses", exact: true }).click();
    await range("2026-09-01", "2026-09-30");
    await page.getByText("Older example dose", { exact: true }).waitFor();
    assert.match(await page.getByRole("region", { name: "History results" }).textContent(), /Sep 1, 2026.*Sep 30, 2026/);
    await page.getByText(/Older entries are read only/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Edit time", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Previous period", exact: true }).click();
    await page.getByText("No entries in this date range.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Next period", exact: true }).click();
    await page.getByText("Older example dose", { exact: true }).waitFor();
  }],
  ["temperature history includes the seventh reading and recovers failed ranges", async () => {
    await visit("temp");
    await page.getByRole("button", { name: "View all readings", exact: true }).click();
    await page.getByText("99.7°F", { exact: true }).waitFor();
    await page.evaluate(() => { window.__careFixture.failures.history = true; });
    await range("2026-09-01", "2026-09-30");
    await page.getByRole("alert").filter({ hasText: "Couldn't load care history" }).waitFor();
    assert.equal(await page.getByText("99.7°F", { exact: true }).count(), 0);
    await page.evaluate(() => { window.__careFixture.failures.history = false; });
    await page.getByRole("button", { name: "Retry history", exact: true }).click();
    await page.getByText("97.7°F", { exact: true }).waitFor();
  }],
  ["capped history explicitly asks for a narrower date range", async () => {
    await visit("detail");
    await page.evaluate(() => { window.__careFixture.failures.cap = true; });
    await page.getByRole("button", { name: "View older doses", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Showing the newest 2,000 entries" }).waitFor();
  }],
  ["medicine setup links Claude photo support and distinguishes Maple Chat", async () => {
    await visit("plan");
    assert.equal(await page.getByRole("link", { name: "Set up Claude for photos", exact: true }).getAttribute("href"), "/maple/connect");
    await page.getByText(/This uses Claude outside Maple Chat/).waitFor();
  }],
  ["medicine form keeps a failed save and guards discarding", async () => {
    await visit("plan");
    await confirmDraft(page.getByLabel("Name", { exact: true }), "Example new medicine", "Save");
  }],
  ["temperature form keeps a failed save and guards discarding", async () => {
    await visit("temp");
    await confirmDraft(page.getByRole("textbox", { name: "temperature in degrees Fahrenheit", exact: true }), "98.6", "Save");
  }],
  ["temperature units preserve a measured reading and blank stays blank", async () => {
    for (const units of ["us", "metric"]) {
      await visit(`temp&units=${units}`);
      const form = page.getByRole("dialog").first();
      const unit = units === "metric" ? "Celsius" : "Fahrenheit";
      const input = () => form.getByRole("textbox", { name: `temperature in degrees ${unit}`, exact: true });
      assert.equal(await input().inputValue(), "", "New temperatures do not supply a reading");
      assert(await form.getByRole("button", { name: "Save", exact: true }).isDisabled());
      await input().fill(units === "metric" ? "37.1" : "98.7");
      for (let i = 0; i < 3; i++) {
        await form.getByRole("radio", { name: units === "metric" ? "°F" : "°C", exact: true }).click();
        await form.getByRole("radio", { name: units === "metric" ? "°C" : "°F", exact: true }).click();
        await page.waitForFunction(([unit, expected]) => document.querySelector(`input[aria-label="temperature in degrees ${unit}"]`)?.value === expected, [unit, units === "metric" ? "37.1" : "98.7"]);
      }
      await page.evaluate(() => { window.__careFixture.failures.save = false; });
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await form.waitFor({ state: "hidden" });
      assert.deepEqual(await page.evaluate(() => window.__careFixture.readings), [{ tempC: units === "metric" ? 37.1 : 37.056, at: "2026-10-28T13:30:00.000Z" }], "Saving uses the measured value, not the rounded display");
    }
    await visit("temp");
    const form = page.getByRole("dialog").first();
    await form.getByRole("textbox", { name: "temperature in degrees Fahrenheit", exact: true }).fill("98.7");
    await form.getByRole("radio", { name: "°C", exact: true }).click();
    await form.getByRole("textbox", { name: "temperature in degrees Celsius", exact: true }).fill("");
    await form.getByRole("radio", { name: "°F", exact: true }).click();
    assert.equal(await form.getByRole("textbox", { name: "temperature in degrees Fahrenheit", exact: true }).inputValue(), "");
    assert(await form.getByRole("button", { name: "Save", exact: true }).isDisabled());
  }],
  ["care settings keep a failed save and guard discarding", async () => {
    await visit("settings");
    await confirmDraft(page.getByRole("textbox", { name: "OB or midwife", exact: true }), "202-555-0100", "Save");
  }],
  ["one time dose keeps a failed save and guards discarding", async () => {
    await visit("dose");
    await confirmDraft(page.getByRole("textbox", { name: "Name", exact: true }), "Example one time medicine", "Took it");
  }],
  ["scheduled dose guards its entered details", async () => {
    await visit("plan-dose");
    assert(await page.getByRole("textbox", { name: "Dose, if different", exact: true }).isVisible());
    await confirmDraft(page.getByRole("textbox", { name: "Dose, if different", exact: true }), "Example label text");
  }],
  ["dose detail edits guard their entered details", async () => {
    await visit("detail");
    await page.getByRole("button", { name: "Dose details", exact: true }).click();
    assert(await page.getByRole("textbox", { name: "Dose, if different", exact: true }).isVisible());
    await confirmDraft(page.getByRole("textbox", { name: "Dose, if different", exact: true }), "Updated example label", "Save dose");
  }],
  ["dose time edits guard their entered time", async () => {
    await visit("dose-time");
    await confirmDraft(page.getByLabel("Taken at: time", { exact: true }), "05:30", "Save time");
  }],
];
const selected = cases.filter(([name]) => !process.env.CARE_CASE || name.includes(process.env.CARE_CASE));
let failed = 0;
try {
  for (const [name, run] of selected) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
  }
  assert.deepEqual(errors, []);
  console.log(`${selected.length - failed} passed, ${failed} failed`);
} finally { await browser.close(); await rm(output, { recursive: true, force: true }); }
if (failed) process.exit(1);
