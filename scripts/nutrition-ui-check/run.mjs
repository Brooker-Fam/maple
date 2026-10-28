import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.MAPLE_UI_TOOLS ? path.join(process.env.MAPLE_UI_TOOLS, "package.json") : import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const output = await mkdtemp(path.join(tmpdir(), "maple-nutrition-ui-"));
const screenshots = path.join(root, "test-results/maple-nutrition-ui");
await mkdir(screenshots, { recursive: true });
await build({
  entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"test"' },
  plugins: [{ name: "synthetic-boundaries", setup(plugin) {
    const mocks = { path: path.join(here, "mocks.jsx") };
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|CareNav|sheets)$/ }, () => mocks);
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => args.importer.endsWith("/sheets/parts.tsx") ? mocks : undefined);
    plugin.onResolve({ filter: /(?:CareSettingsSheet|CareTeam|CheckIn|CrisisSheet|MedPlanSheet|MedQuestionsSheet|MomTempSheet|OverLimitList|PlanDetail|RecentDoses|Questions|VisitSummary|ChatTerms|notify)$/ }, (args) => args.importer.endsWith("/care/CareScreen.tsx") ? mocks : undefined);
  } }],
});
const cssPath = path.join(root, "src/app/globals.css");
const compiled = await postcss([tailwind({ base: root })]).process(await readFile(cssPath, "utf8"), { from: cssPath });
await writeFile(path.join(output, "app.css"), compiled.css + "\n" + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
await writeFile(path.join(output, "index.html"), '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic nutrition checks</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
page.setDefaultTimeout(7000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", async (route) => {
  const pathname = new URL(route.request().url()).pathname;
  const file = ["/app.js", "/app.css"].includes(pathname) ? pathname.slice(1) : "index.html";
  await route.fulfill({ status: 200, contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html", body: await readFile(path.join(output, file)) });
});
const snapshot = () => page.evaluate(() => window.__nutritionFixture.snapshot());
const reset = () => page.goto("https://synthetic.example.test");
const clearToasts = async () => {
  await page.evaluate(() => window.__nutritionFixture.clearToasts());
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].some((button) => button.textContent === "Undo"));
};
const closeSaved = () => page.getByRole("dialog").waitFor({ state: "hidden" });
const saveFood = async (description) => {
  await page.getByRole("button", { name: "Ate something", exact: true }).click();
  await page.getByLabel("What was it?", { exact: true }).fill(description);
  await page.getByRole("button", { name: "Log food", exact: true }).click();
  await closeSaved();
};

try {
  await reset();
  await page.getByRole("button", { name: "Ate something", exact: true }).click();
  await page.getByLabel("What was it?", { exact: true }).fill("Sam's private meal draft");
  await page.evaluate(() => window.__nutritionFixture.switchFamily());
  await page.getByRole("heading", { name: "Casey", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0, "Switching families closes the previous family's nutrition draft");
  await page.getByRole("button", { name: "Ate something", exact: true }).click();
  assert.equal(await page.getByLabel("What was it?", { exact: true }).inputValue(), "");
  assert.equal((await snapshot()).requests.length, 0);
  console.log("PASS family switch: maternal drafts never carry into another family");

  await reset();
  await page.evaluate(() => window.__nutritionFixture.showApproval("food"));
  const approval = page.getByRole("region", { name: "Delete this entry?", exact: true });
  await approval.getByText("Sam's Oatmeal and berries").waitFor();
  assert.equal(await approval.getByText(/question for her OB/).count(), 0);
  await page.evaluate(() => window.__nutritionFixture.showApproval("drink"));
  await approval.getByText("Sam's Herbal tea").waitFor();
  assert.equal(await approval.getByText(/question for her OB/).count(), 0);
  console.log("PASS chat approvals: identify the selected maternal food or drink");

  await reset();
  await page.getByRole("button", { name: "Log water, 8 oz", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).waitFor();
  let data = await snapshot();
  assert.equal(data.server[0].kind, "drink");
  assert.equal(data.server[0].data.name, "Water");
  assert(Math.abs(data.server[0].data.amount_ml - 236.5882365) < 0.001);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal((await snapshot()).server.length, 0);
  console.log("PASS water: explicit portion, metric storage, saved feedback and Undo");

  await clearToasts();
  await saveFood("Toast and eggs");
  data = await snapshot();
  const food = data.server[0];
  assert.deepEqual(food.data, { description: "Toast and eggs", meal: "meal" });
  await clearToasts();
  await page.getByRole("button", { name: "Edit Toast and eggs", exact: true }).click();
  await page.getByLabel("Eaten at: time", { exact: true }).fill("08:15");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await closeSaved();
  assert.equal((await snapshot()).server[0].at, "2026-10-28T12:15:00.000Z");
  await clearToasts();
  await page.getByRole("button", { name: "Remove Toast and eggs", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal((await snapshot()).server[0].data.description, "Toast and eggs");
  console.log("PASS food: capture, editing exact local time, removal and restoration");

  await clearToasts();
  await page.getByRole("button", { name: "Other drink", exact: true }).click();
  await page.getByLabel("Drink", { exact: true }).fill("Tea");
  await page.getByRole("button", { name: "Log drink", exact: true }).click();
  await closeSaved();
  assert.equal((await snapshot()).server.find((entry) => entry.kind === "drink").data.amount_ml, null);
  console.log("PASS drink: unknown quantity remains unknown");

  await clearToasts();
  await page.evaluate(() => window.__nutritionFixture.offline());
  await saveFood("Oatmeal");
  assert.equal((await snapshot()).queued.length, 1);
  await page.getByText("On this phone, not synced", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal((await snapshot()).queued.length, 0);
  console.log("PASS offline: queued entry, pending journal and Undo");

  await clearToasts();
  await page.getByRole("button", { name: "Edit Toast and eggs", exact: true }).click();
  await page.getByLabel("What was it?", { exact: true }).fill("Draft meal");
  await page.evaluate((id) => window.__nutritionFixture.changeElsewhere(id), food.id);
  await page.getByRole("button", { name: "Use latest entry", exact: true }).waitFor();
  assert(await page.getByRole("button", { name: "Save changes", exact: true }).isDisabled());
  await page.getByRole("button", { name: "Use latest entry", exact: true }).click();
  assert.equal(await page.getByLabel("What was it?", { exact: true }).inputValue(), "Updated meal");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  console.log("PASS concurrency: stale edits cannot overwrite another caregiver");

  await page.getByRole("button", { name: "Ate something", exact: true }).click();
  await page.getByLabel("What was it?", { exact: true }).fill("Fruit and yogurt");
  await page.getByRole("button", { name: "Just now · Change time", exact: true }).click();
  await page.getByLabel("Eaten at: time", { exact: true }).fill("23:00");
  assert(await page.getByRole("button", { name: "Log food", exact: true }).isDisabled());
  await page.getByLabel("Eaten at: time", { exact: true }).fill("08:00");
  await page.evaluate(() => window.__nutritionFixture.reject());
  await page.getByRole("button", { name: "Log food", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "That entry could not be saved" }).waitFor();
  assert.equal(await page.getByLabel("What was it?", { exact: true }).inputValue(), "Fruit and yogurt");
  assert.equal((await snapshot()).queued.length, 0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  console.log("PASS validation: future dates blocked and rejected writes preserve the draft");

  await reset();
  await page.evaluate(() => window.__nutritionFixture.setUnits("metric"));
  await page.getByRole("button", { name: "Log water, 250 ml", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).waitFor();
  assert.equal((await snapshot()).server[0].data.amount_ml, 250);
  await clearToasts();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(screenshots, `nutrition-${width}.png`), fullPage: true });
  }
  await page.evaluate(() => document.documentElement.classList.add("maple-night"));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('button[aria-label="Log water, 250 ml"]')).backgroundColor === "rgb(19, 23, 15)");
  await page.screenshot({ path: path.join(screenshots, "nutrition-night.png"), fullPage: true });
  await page.evaluate(() => window.__nutritionFixture.viewOnly());
  assert.equal(await page.getByRole("button", { name: "Ate something", exact: true }).count(), 0);
  console.log("PASS metric units, small screens, night theme and read permissions");

  await reset();
  await page.evaluate(() => { window.__nutritionFixture.offline(); window.__nutritionFixture.pauseRequest(); });
  await page.getByRole("button", { name: "Log water, 8 oz", exact: true }).click();
  await page.waitForFunction(() => window.__nutritionFixture.snapshot().requests.length > 0);
  await page.evaluate(() => window.__nutritionFixture.signOut());
  await page.waitForFunction(() => window.__nutritionFixture.snapshot().state.care === null);
  await page.evaluate(() => window.__nutritionFixture.resumeRequest());
  await page.waitForTimeout(100);
  assert.equal((await snapshot()).queued.length, 0);
  assert.equal((await snapshot()).state.care, null);
  assert.deepEqual(errors, []);
  console.log("PASS sign-out: in-flight failure cannot requeue maternal data");
} catch (error) {
  await page.screenshot({ path: path.join(screenshots, "failure.png"), fullPage: true });
  throw error;
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
