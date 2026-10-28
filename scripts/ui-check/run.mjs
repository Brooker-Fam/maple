import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkProductionCare } from "./production-care-checks.mjs";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const output = await mkdtemp(path.join(tmpdir(), "maple-ui-"));
const screenshots = path.join(root, "test-results/maple-ui");
await mkdir(screenshots, { recursive: true });
await rm(path.join(screenshots, "failure.png"), { force: true });
await build({
  entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", sourcemap: "inline", absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"test"' },
  plugins: [{ name: "synthetic-app-hooks", setup(plugin) {
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav|useTimerActions)$/ }, () => ({ path: path.join(here, "mocks.jsx") }));
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => args.importer.endsWith("/sheets/parts.tsx") ? { path: path.join(here, "mocks.jsx") } : undefined);
  } }],
});
await build({
  entryPoints: [path.join(here, "production-care.jsx")], outfile: path.join(output, "care-app.js"), bundle: true,
  format: "esm", jsx: "automatic", sourcemap: "inline", absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"test"' },
  plugins: [{ name: "synthetic-care-boundaries", setup(plugin) {
    const mocks = { path: path.join(here, "care-mocks.jsx") };
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useTimerActions|AppNav|sheets)$/ }, () => mocks);
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => args.importer.endsWith("/sheets/parts.tsx") ? mocks : undefined);
    plugin.onResolve({ filter: /(?:^|\/)(?:DoctorSheet|HelpSheet|CrisisSheet|DoseSheet|MomTempSheet|Questions|SupportScreen|WarningSigns|MedPlanSheet)$/ }, (args) => /\/(?:CareNav|PlanPicker)\.tsx$/.test(args.importer) ? mocks : undefined);
    plugin.onResolve({ filter: /^\.\.\/notify$/ }, (args) => args.importer.endsWith("/care/CareNav.tsx") ? { path: path.join(root, "src/components/maple/notify/context.ts") } : undefined);
  } }],
});
const sourceCss = await readFile(path.join(root, "src/app/globals.css"), "utf8");
const compiled = await postcss([tailwind({ base: root })]).process(sourceCss, { from: path.join(root, "src/app/globals.css") });
await writeFile(path.join(output, "app.css"), compiled.css + "\n" + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
await writeFile(path.join(output, "index.html"), '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Maple synthetic UI checks</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
await writeFile(path.join(output, "care.html"), (await readFile(path.join(output, "index.html"), "utf8")).replace('/app.js', '/care-app.js'));
const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const errors = [];
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
const url = "https://maple-ui.example.test";
await page.route("**/*", async (route) => {
  const pathname = new URL(route.request().url()).pathname;
  const file = ["/app.js", "/care-app.js", "/app.css", "/care.html"].includes(pathname) ? pathname.slice(1) : "index.html";
  await route.fulfill({ status: 200, contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html", body: await readFile(path.join(output, file)) });
});
const snapshot = () => page.evaluate(() => window.__mapleUiFixture.snapshot());
const openDose = async () => {
  await page.getByRole("button", { name: /^Edit time for Example medicine,/ }).click();
  await page.getByRole("dialog", { name: "Edit dose time" }).waitFor();
  await page.getByLabel("Taken at: date", { exact: true }).waitFor();
  await page.getByLabel("Taken at: time", { exact: true }).waitFor();
};
const noOverflow = async () => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "Page has horizontal overflow");
  for (const field of await page.locator('input[type="date"], input[type="time"]').all()) {
    const box = await field.boundingBox();
    assert(box && box.x >= -1 && box.x + box.width <= page.viewportSize().width + 1, "Time field extends outside the viewport");
    assert(box.height >= 44, "Time field is smaller than a 44px tap target");
  }
};
const settleView = async () => {
  // Reduced motion still fades sheets in. Presence alone captures a translucent
  // intermediate frame and makes the underlying page look like an overlap bug.
  await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] > div')].every((el) => Number(getComputedStyle(el).opacity) >= 0.999));
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};

try {
  await checkProductionCare({ page, url, screenshots, settleView, noOverflow });
  await page.goto(url);
  await openDose();
  assert.equal(await page.getByLabel("Taken at: time", { exact: true }).inputValue(), "08:00");
  assert(await page.getByRole("button", { name: "Save time", exact: true }).isDisabled(), "An unchanged dose cannot save");
  await page.getByRole("button", { name: "5 min earlier", exact: true }).click();
  assert.equal(await page.getByLabel("Taken at: time", { exact: true }).inputValue(), "07:55");
  assert.equal((await snapshot()).doses[0].at, "2026-10-28T12:00:00.000Z", "Nudging must not save immediately");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("dialog", { name: "Edit dose time" }).waitFor({ state: "hidden" });
  assert.equal((await snapshot()).calls.length, 0, "Cancel makes no write");
  assert(await page.getByRole("button", { name: /^Edit time for Example medicine,/ }).evaluate((el) => el === document.activeElement), "Cancel returns focus to its dose");

  await openDose();
  const savedBefore = (await snapshot()).doses[0];
  await page.getByLabel("Taken at: time", { exact: true }).fill("07:45");
  await page.getByRole("button", { name: "Save time", exact: true }).click();
  await page.getByRole("dialog", { name: "Edit dose time" }).waitFor({ state: "hidden" });
  const savedAfter = (await snapshot()).doses[0];
  assert.equal(savedAfter.at, "2026-10-28T11:45:00.000Z");
  assert.deepEqual(savedAfter.data, savedBefore.data, "Time correction preserves dose data");
  assert.equal(savedAfter.note, savedBefore.note, "Time correction preserves the note");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal((await snapshot()).doses[0].at, savedBefore.at, "Undo restores the recorded time");
  console.log("PASS dose: direct fields, staged nudge, Cancel, focus restore, Save time, Undo");

  await openDose();
  await page.getByLabel("Taken at: time", { exact: true }).fill("10:00");
  assert(await page.getByRole("button", { name: "Save time", exact: true }).isDisabled(), "Future time cannot save");
  assert.equal(await page.getByLabel("Taken at: date", { exact: true }).inputValue(), "2026-10-28", "Future time does not become yesterday");
  await page.getByLabel("Taken at: time", { exact: true }).fill("");
  assert(await page.getByRole("button", { name: "Save time", exact: true }).isDisabled(), "Incomplete clock cannot save the old value");
  await page.getByLabel("Taken at: time", { exact: true }).fill("07:40");
  await page.evaluate(() => window.__mapleUiFixture.failNextSave());
  await page.getByRole("button", { name: "Save time", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Check the connection" }).waitFor();
  assert.equal(await page.getByLabel("Taken at: time", { exact: true }).inputValue(), "07:40", "Failed save keeps the draft");
  await page.evaluate(() => window.__mapleUiFixture.changeElsewhere());
  await page.getByRole("button", { name: "Use latest time", exact: true }).waitFor();
  assert(await page.getByRole("button", { name: "Save time", exact: true }).isDisabled(), "Concurrent change cannot be overwritten");
  await page.getByRole("button", { name: "Use latest time", exact: true }).click();
  assert.equal(await page.getByLabel("Taken at: time", { exact: true }).inputValue(), "08:10");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Edit dose time" }).waitFor({ state: "hidden" });
  console.log("PASS dose: explicit future date, incomplete input, failed save, concurrent change recovery");

  await openDose();
  await page.getByLabel("Taken at: time", { exact: true }).fill("10:00");
  assert(await page.getByRole("button", { name: "Save time", exact: true }).isDisabled());
  await page.evaluate(() => window.__mapleUiFixture.setNow("2026-10-28T14:00:00.000Z"));
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Save time" && !button.disabled));
  await page.getByRole("button", { name: "Save time", exact: true }).click();
  await page.getByRole("dialog", { name: "Edit dose time" }).waitFor({ state: "hidden" });
  assert.equal((await snapshot()).doses[0].at, "2026-10-28T14:00:00.000Z", "A future draft becoming valid saves the visible clock, not the last valid value");
  console.log("PASS clock advance: a newly valid draft propagates before Save time");

  await page.getByRole("button", { name: /^Edit time for One-time example/ }).click();
  assert.equal(await page.getByLabel("Taken at: date", { exact: true }).inputValue(), "2026-10-27", "Overnight dose shows its actual day");
  await page.getByLabel("Taken at: time", { exact: true }).fill("23:45");
  await page.getByRole("button", { name: "Save time", exact: true }).click();
  await page.getByRole("dialog", { name: "Edit dose time" }).waitFor({ state: "hidden" });
  assert.equal((await snapshot()).doses.find((d) => d.id === 102).at, "2026-10-28T03:45:00.000Z", "One-time doses use the same correction path");
  console.log("PASS one-time dose: direct overnight correction without deletion");

  await page.getByRole("button", { name: "Nursing", exact: true }).click();
  await page.getByRole("button", { name: "Edit left end time", exact: true }).click();
  await page.getByRole("dialog", { name: "Edit nursing time" }).locator('input[type="time"]').fill("08:53");
  assert.equal((await snapshot()).feed.data.segments[0].end, "2026-10-28T12:55:00.000Z", "Nursing correction stays a draft until Save");
  await page.getByRole("button", { name: "Save time", exact: true }).click();
  await page.getByRole("dialog", { name: "Edit nursing time" }).waitFor({ state: "hidden" });
  const nursingAfter = (await snapshot()).feed;
  assert.equal(nursingAfter.data.segments[0].end, "2026-10-28T12:53:00.000Z");
  assert.equal(nursingAfter.data.segments[1].start, "2026-10-28T13:00:00.000Z", "Moving the left end does not move the right start");
  assert.equal(nursingAfter.ended_at, "2026-10-28T13:15:00.000Z", "Moving one boundary preserves the whole feed end");
  console.log("PASS nursing: actual MomentEditor + engine preserve independent boundaries");

  await page.getByRole("button", { name: "Edit active nursing times", exact: true }).click();
  const activeSheet = page.getByRole("dialog", { name: "Edit nursing times", exact: true });
  await activeSheet.waitFor();
  const activeClock = activeSheet.locator('input[type="time"]');
  await activeClock.fill("09:05");
  await activeSheet.getByRole("group", { name: "Which part", exact: true }).getByRole("button", { name: /^Left,/ }).click();
  const discard = page.getByRole("alertdialog", { name: "Discard this time change?", exact: true });
  await discard.waitFor();
  await discard.getByRole("button", { name: "Keep editing", exact: true }).click();
  assert.equal(await activeClock.inputValue(), "09:05", "Switch guard preserves a dirty nursing draft");
  await activeSheet.getByRole("group", { name: "Which part", exact: true }).getByRole("button", { name: /^Left,/ }).click();
  await discard.getByRole("button", { name: "Discard change", exact: true }).click();
  assert.equal(await activeClock.inputValue(), "08:45", "Discard then switch opens the saved left start");
  assert(!(await snapshot()).calls.some((call) => call.timer), "Switching moments and discarding never writes a timer edit");
  await page.keyboard.press("Escape");
  await activeSheet.waitFor({ state: "hidden" });
  console.log("PASS active nursing: dirty-moment switching requires Keep editing or Discard change");

  for (const width of [320, 390, 1024]) {
    await page.goto(url);
    await page.setViewportSize({ width, height: 844 });
    await openDose();
    await settleView();
    await noOverflow();
    const saveBox = await page.getByRole("button", { name: "Save time", exact: true }).boundingBox();
    assert(saveBox && saveBox.y + saveBox.height <= 844, "Save time stays reachable without scrolling the sheet footer");
    await page.screenshot({ path: path.join(screenshots, `dose-${width}-day.png`) });
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() => { document.documentElement.classList.add("dark", "maple-night"); document.documentElement.style.fontSize = "20px"; });
  await settleView();
  assert.equal(await page.locator('input[type="time"]').evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(19, 23, 15)", "Native time input uses the night surface after transitions settle");
  await noOverflow();
  await page.screenshot({ path: path.join(screenshots, "dose-320-night-large-text.png") });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Edit dose time" }).waitFor({ state: "hidden" });
  await page.screenshot({ path: path.join(screenshots, "recent-320-night-large-text.png") });
  assert.deepEqual(errors, [], "Browser has no uncaught errors");
  console.log("PASS layout: 320/390/1024px, persistent footer, actual night tokens and large text");
} catch (error) {
  await page.screenshot({ path: path.join(screenshots, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
