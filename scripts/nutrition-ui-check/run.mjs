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
const openManual = async (label) => {
  const button = page.getByRole("button", { name: label, exact: true });
  if (!await button.isVisible()) await page.getByText("Log manually", { exact: true }).click();
  await button.click();
};
const saveFood = async (description) => {
  await openManual("Ate something");
  await page.getByLabel("What was it?", { exact: true }).fill(description);
  await page.getByRole("button", { name: "Log food", exact: true }).click();
  await closeSaved();
};

try {
  await reset();
  await page.getByRole("button", { name: "Ate something", exact: true }).click();
  await page.getByLabel("What was it?", { exact: true }).fill("Synthetic recent meal");
  const earlier = page.getByRole("button", { name: "1 min ago", exact: true });
  const timing = await earlier.boundingBox();
  const details = await page.getByText("Food details", { exact: false }).boundingBox();
  assert(timing.y + timing.height <= details.y, "Time is available before optional food details");
  await earlier.click();
  assert.equal(await page.getByLabel("Eaten at: time", { exact: true }).inputValue(), "09:29");
  assert.equal((await snapshot()).requests.length, 0, "Choosing an earlier time does not save a meal");
  await page.getByRole("button", { name: "Log food", exact: true }).click();
  await closeSaved();
  assert.equal((await snapshot()).server[0].at, "2026-10-28T13:29:00.000Z");
  console.log("PASS earlier meal: one-minute shortcut precedes optional details and saves the chosen time once");

  await reset();
  await page.getByRole("button", { name: "Other drink", exact: true }).click();
  await page.getByRole("button", { name: "Tea", exact: true }).click();
  await page.getByRole("button", { name: "Just now · Change time", exact: true }).click();
  await page.getByLabel("Drank at: time", { exact: true }).fill("23:00");
  assert(await page.getByRole("button", { name: "Log drink", exact: true }).isDisabled());
  await page.getByRole("button", { name: "Use current time", exact: true }).click();
  assert(await page.getByRole("button", { name: "Log drink", exact: true }).isEnabled());
  await page.getByRole("button", { name: "Log drink", exact: true }).click();
  await closeSaved();
  assert.equal((await snapshot()).server[0].at, "2026-10-28T13:30:00.000Z");
  assert.equal((await snapshot()).server[0].data.name, "Tea");
  console.log("PASS current-time reset: clears invalid earlier time and preserves drink details");

  await reset();
  await page.evaluate(() => window.__nutritionFixture.seedHistory());
  await page.getByLabel("Food and drink day", { exact: true }).selectOption("2026-10-24");
  await page.getByRole("button", { name: "Edit Lentil toast", exact: true }).click();
  await page.getByLabel("Food 1 protein (g)", { exact: true }).fill("10");
  const foodDraft = page.getByRole("dialog", { name: "Edit food or drink", exact: true });
  await foodDraft.getByRole("button", { name: "Close", exact: true }).click();
  const discardDraft = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
  await discardDraft.waitFor();
  await discardDraft.getByRole("button", { name: "Keep editing", exact: true }).click();
  assert.equal(await page.getByLabel("Food 1 protein (g)", { exact: true }).inputValue(), "10");
  await page.keyboard.press("Escape");
  await discardDraft.waitFor();
  await page.screenshot({ path: path.join(screenshots, "nutrition-discard.png"), fullPage: true });
  await discardDraft.getByRole("button", { name: "Discard changes", exact: true }).click();
  await closeSaved();
  assert.equal((await snapshot()).server[0].data.items[0].nutrients.protein_g, 9);
  assert.equal((await snapshot()).requests.filter((request) => request.method !== "GET").length, 0);
  console.log("PASS item-only draft: Close and Escape protect protein edits; explicit discard saves nothing");

  await reset();
  await openManual("Other drink");
  await page.getByLabel("Amount in oz", { exact: true }).fill("7..2");
  await page.getByRole("dialog", { name: "Had a drink", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
  await discardDraft.waitFor();
  await discardDraft.getByRole("button", { name: "Keep editing", exact: true }).click();
  assert.equal(await page.getByLabel("Amount in oz", { exact: true }).inputValue(), "7..2");
  assert.equal((await snapshot()).requests.length, 0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await closeSaved();
  console.log("PASS invalid drink draft: closing keeps typed text behind discard confirmation");

  await reset();
  await openManual("Ate something");
  await page.getByLabel("What was it?", { exact: true }).fill("Synthetic egg toast");
  await page.getByRole("button", { name: "Add food item", exact: true }).click();
  await page.getByLabel("Food 1 name", { exact: true }).fill("Egg");
  await page.getByLabel("Food 1 portion", { exact: true }).fill("One egg");
  await page.getByLabel("Food 1 protein (g)", { exact: true }).fill("6");
  await page.getByLabel("Food 1 fiber (g)", { exact: true }).fill("0");
  await page.getByLabel("Food 1 source", { exact: true }).selectOption("estimate");
  assert.equal(await page.getByLabel("Food 1 energy (kcal)", { exact: true }).isVisible(), true);
  assert(await page.getByLabel("Food 1 carbs (g)", { exact: true }).isVisible(), "food details start expanded");
  await page.getByRole("button", { name: "Food 1: Protein foods", exact: true }).click();
  await page.getByLabel("Food 1 note", { exact: true }).fill("Synthetic portion estimate");
  await page.getByRole("button", { name: "Add food item", exact: true }).click();
  await page.getByLabel("Food 2 name", { exact: true }).fill("Toast");
  await page.getByLabel("Food 2 fiber (g)", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Log food", exact: true }).click();
  await closeSaved();
  let rich = (await snapshot()).server[0];
  assert.equal(rich.data.items[0].nutrients.protein_g, 6);
  assert.equal(rich.data.items[0].nutrients.fiber_g, 0);
  assert.equal(rich.data.items[0].nutrients.energy_kcal ?? null, null);
  assert.equal(rich.data.items[0].source, "estimate");
  await page.getByRole("region", { name: "Recorded nutrition", exact: true }).getByText("6 g", { exact: true }).waitFor();
  await page.getByRole("region", { name: "Recorded nutrition", exact: true }).getByText("1 of 2 foods · 1 estimated", { exact: true }).waitFor();
  await page.getByRole("region", { name: "Recorded nutrition", exact: true }).getByText("Protein foods", { exact: true }).waitFor();
  await clearToasts();
  await page.getByRole("button", { name: "Edit Synthetic egg toast", exact: true }).click();
  await page.getByLabel("What was it?", { exact: true }).fill("Synthetic egg plate");
  await page.getByLabel("Food 1 protein (g)", { exact: true }).fill("oops");
  assert(await page.getByRole("button", { name: "Save changes", exact: true }).isDisabled());
  await page.getByLabel("Food 1 protein (g)", { exact: true }).fill("6");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await closeSaved();
  assert.deepEqual((await snapshot()).server[0].data.items, rich.data.items);
  await page.screenshot({ path: path.join(screenshots, "nutrition-details.png"), fullPage: true });
  console.log("PASS item details: known zero, unknown energy, estimates, summary and metadata-preserving edit");

  await reset();
  await page.evaluate(() => window.__nutritionFixture.seedHistory());
  await page.getByLabel("Food and drink day", { exact: true }).selectOption("2026-10-24");
  await page.getByText("Lentil toast", { exact: true }).waitFor();
  const historyRequest = (await snapshot()).requests.find((request) => request.method === "GET");
  assert.equal(historyRequest.family, "99");
  assert(historyRequest.query.includes("from=2026-10-24"));
  await page.getByRole("button", { name: "Edit Lentil toast", exact: true }).click();
  await page.getByLabel("What was it?", { exact: true }).fill("Lentil toast plate");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await closeSaved();
  await page.getByText("Lentil toast plate", { exact: true }).waitFor();
  await clearToasts();
  await page.getByRole("button", { name: "Log Lentil toast plate again", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).waitFor();
  const repeated = (await snapshot()).server.find((entry) => entry.id !== 8001);
  assert.equal(repeated.at, "2026-10-28T13:30:00.000Z");
  assert.equal(repeated.note, "Synthetic meal note");
  assert.deepEqual(repeated.data.items, (await snapshot()).server.find((entry) => entry.id === 8001).data.items);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal((await snapshot()).server.length, 1);
  console.log("PASS history: authenticated day load, older edits, Log again preserves details and Undo");

  await reset();
  await page.evaluate(() => { window.__nutritionFixture.seedHistory(); window.__nutritionFixture.reject(); });
  await page.getByLabel("Food and drink day", { exact: true }).selectOption("2026-10-24");
  await page.getByRole("alert").filter({ hasText: "Couldn't load this day" }).waitFor();
  assert.equal(await page.getByRole("region", { name: "Recorded nutrition", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByText("Lentil toast", { exact: true }).waitFor();
  console.log("PASS historical failure: no false zero totals and retry restores the day");

  await reset();
  await page.evaluate(() => { window.__nutritionFixture.seedHistory(); window.__nutritionFixture.pauseRequest(); });
  await page.getByLabel("Food and drink day", { exact: true }).selectOption("2026-10-24");
  await page.getByRole("status").filter({ hasText: "Loading food and drink" }).waitFor();
  await page.waitForFunction(() => window.__nutritionFixture.snapshot().requests.length > 0);
  await page.evaluate(() => window.__nutritionFixture.switchFamily());
  await page.getByRole("heading", { name: "Casey", exact: true }).waitFor();
  await page.evaluate(() => window.__nutritionFixture.resumeRequest());
  await page.waitForTimeout(100);
  assert.equal(await page.getByText("Lentil toast", { exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Food and drink day", { exact: true }).inputValue(), "2026-10-28");
  console.log("PASS historical scope: delayed responses cannot reveal another family's meal");

  await reset();
  await page.evaluate(() => window.__nutritionFixture.seedHistory());
  await page.getByLabel("Food and drink day", { exact: true }).selectOption("2026-10-24");
  await page.getByText("Lentil toast", { exact: true }).waitFor();
  const reads = (await snapshot()).requests.filter((request) => request.method === "GET").length;
  await page.evaluate(() => window.__nutritionFixture.poll());
  await page.waitForTimeout(100);
  assert.equal((await snapshot()).requests.filter((request) => request.method === "GET").length, reads, "Unchanged care snapshots do not reload history");
  console.log("PASS historical polling: unchanged snapshots preserve the loaded journal");

  await reset();
  await page.evaluate(() => window.__nutritionFixture.seedHistory());
  await page.getByLabel("Food and drink day", { exact: true }).selectOption("2026-10-24");
  await page.getByText("Lentil toast", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit Lentil toast", exact: true }).click();
  await page.evaluate(() => { window.__nutritionFixture.reject(); window.__nutritionFixture.changeElsewhere(8001); });
  await page.waitForFunction(() => window.__nutritionFixture.snapshot().requests.filter((request) => request.method === "GET").length === 2);
  await page.waitForTimeout(100);
  assert.equal(await page.getByText("This entry was removed. Your change hasn't been saved.", { exact: true }).count(), 0, "Failed refresh must not call an existing entry removed");
  assert.equal(await page.getByLabel("What was it?", { exact: true }).inputValue(), "Lentil toast");
  console.log("PASS historical refresh failure: existing editor retains its record and draft");

  await reset();
  await openManual("Other drink");
  await page.getByLabel("Drink", { exact: true }).fill("Water");
  await page.getByLabel("Amount in oz", { exact: true }).fill("8");
  await page.evaluate(() => window.__nutritionFixture.setUnits("metric"));
  await page.getByRole("button", { name: "Log drink", exact: true }).click();
  await closeSaved();
  assert(Math.abs((await snapshot()).server[0].data.amount_ml - 236.5882365) < 0.001);
  console.log("PASS draft units: settings changes do not reinterpret typed quantities");

  await reset();
  await openManual("Ate something");
  await page.getByLabel("What was it?", { exact: true }).fill("Sam's private meal draft");
  await page.evaluate(() => window.__nutritionFixture.switchFamily());
  await page.getByRole("heading", { name: "Casey", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0, "Switching families closes the previous family's nutrition draft");
  await openManual("Ate something");
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
  await openManual("Other drink");
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

  await openManual("Ate something");
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
