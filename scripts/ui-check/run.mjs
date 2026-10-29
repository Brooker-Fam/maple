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
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav|useTimerActions|sheets)$/ }, () => ({ path: path.join(here, "mocks.jsx") }));
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => args.importer.endsWith("/sheets/FixTimesSheet.tsx") ? { path: path.join(here, "mocks.jsx") } : undefined);
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
  assert.equal(await activeClock.inputValue(), "08:55", "Discard then switch opens the completed left side's end");
  assert(!(await snapshot()).calls.some((call) => call.timer), "Switching moments and discarding never writes a timer edit");
  await page.keyboard.press("Escape");
  await activeSheet.waitFor({ state: "hidden" });
  console.log("PASS active nursing: dirty-moment switching requires Keep editing or Discard change");

  // A late side's timer is corrected independently. Exercise the real shared
  // sheet for both running and saved feeds, including all four direct nudges.
  for (const running of [true, false]) {
    await page.evaluate(() => window.__mapleUiFixture.nursingScenario("switch"));
    await page.getByRole("button", { name: running ? "Edit active nursing times" : "Edit saved nursing times", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Edit nursing times", exact: true });
    await sheet.getByRole("group", { name: "Which part", exact: true }).getByRole("button", { name: /^Left,/ }).click();
    const clock = sheet.locator('input[type="time"]');
    assert.equal(await clock.inputValue(), "09:05", "A completed side opens at its end without another choice");
    await sheet.getByRole("button", { name: "5 min earlier", exact: true }).click();
    assert.equal(await clock.inputValue(), "09:00");
    await sheet.getByRole("button", { name: "1 min earlier", exact: true }).click();
    assert.equal(await clock.inputValue(), "08:59");
    await sheet.getByRole("button", { name: "1 min later", exact: true }).click();
    assert.equal(await clock.inputValue(), "09:00");
    await sheet.getByRole("button", { name: "5 min later", exact: true }).click();
    assert.equal(await clock.inputValue(), "09:05");
    assert(await sheet.getByRole("button", { name: "Save time", exact: true }).isDisabled(), "Returning to the saved minute clears the draft");
    assert(await sheet.getByRole("button", { name: "1 min later", exact: true }).isDisabled(), "A finished side cannot overlap the next side");
    await sheet.getByRole("button", { name: "5 min earlier", exact: true }).click();
    assert.equal((await snapshot()).calls.length, 0, "Quick adjustments remain unsaved until Save time");
    const before = (await snapshot())[running ? "activeFeed" : "feed"];
    assert.equal(before.data.segments[0].end, "2026-10-28T13:05:00.000Z");
    await sheet.getByRole("button", { name: "Save time", exact: true }).click();
    await sheet.waitFor({ state: "hidden" });
    const after = (await snapshot())[running ? "activeFeed" : "feed"];
    assert.equal(after.data.segments[0].end, "2026-10-28T13:00:00.000Z");
    assert.equal(after.data.segments[1].start, "2026-10-28T13:05:00.000Z", "Removing five minutes from Left leaves Right's start unchanged");
    assert.equal(after.ended_at, before.ended_at, "Correcting Left preserves the feed's end or running status");
    assert.equal((await snapshot()).calls[0].edit.edge, "side_end");
  }
  console.log("PASS nursing: active/saved parity, direct ±1/±5, staged Save, completed-side corrections preserve the next side");

  await page.evaluate(() => window.__mapleUiFixture.nursingScenario("switch"));
  await page.getByRole("button", { name: "Edit active nursing times", exact: true }).click();
  const switchSheet = page.getByRole("dialog", { name: "Edit nursing times", exact: true });
  const switchClock = switchSheet.locator('input[type="time"]');
  const quick = switchSheet.getByRole("group", { name: "Quick time choices", exact: true });
  await quick.getByRole("button", { name: /^Usual,/ }).click();
  assert.equal(await switchClock.inputValue(), "08:55", "Usual uses the synthetic history's ten minutes on Left");
  await quick.getByRole("button", { name: /^Likely,/ }).click();
  assert.equal(await switchClock.inputValue(), "09:00", "Likely uses fifteen minutes on Left");
  await quick.getByRole("button", { name: /^Likely,/ }).click();
  assert.equal(await switchClock.inputValue(), "09:00", "Tapping a preset twice never accumulates the correction");
  await switchClock.fill("");
  assert(await switchSheet.getByRole("button", { name: "Save time", exact: true }).isDisabled());
  await quick.getByRole("button", { name: /^Likely,/ }).click();
  assert.equal(await switchClock.inputValue(), "09:00", "A preset recovers invalid input even when it equals the last valid draft");
  assert(!(await switchSheet.getByRole("button", { name: "Save time", exact: true }).isDisabled()));
  assert.equal((await snapshot()).calls.length, 0, "Named presets stage an absolute time without writing");
  await switchSheet.getByRole("button", { name: "Save time", exact: true }).click();
  await switchSheet.waitFor({ state: "hidden" });
  const switched = (await snapshot()).activeFeed;
  assert.equal(switched.data.segments[0].end, "2026-10-28T13:00:00.000Z");
  assert.equal(switched.data.segments[1].start, "2026-10-28T13:00:00.000Z", "Editing the switch itself intentionally moves both sides' common boundary");
  assert.equal(switched.started_at, "2026-10-28T12:45:00.000Z", "A switch correction preserves total elapsed nursing time");
  console.log("PASS nursing: usual/likely absolute presets, repeat tap, invalid-input recovery, intentional switch boundary transfer");

  await page.evaluate(() => window.__mapleUiFixture.nursingScenario("break"));
  await page.getByRole("button", { name: "Edit active nursing times", exact: true }).click();
  const breakSheet = page.getByRole("dialog", { name: "Edit nursing times", exact: true });
  await breakSheet.getByRole("group", { name: "Quick time choices", exact: true }).getByRole("button", { name: /^No break,/ }).click();
  assert.equal(await breakSheet.locator('input[type="time"]').inputValue(), "08:55");
  await breakSheet.getByRole("button", { name: "Save time", exact: true }).click();
  await breakSheet.waitFor({ state: "hidden" });
  assert.equal((await snapshot()).activeFeed.data.segments[1].start, "2026-10-28T12:55:00.000Z", "No break meets the previous side's end exactly");

  await page.evaluate(() => window.__mapleUiFixture.nursingScenario("last-feed"));
  await page.getByRole("button", { name: "Edit active nursing times", exact: true }).click();
  const startSheet = page.getByRole("dialog", { name: "Edit nursing times", exact: true });
  await startSheet.getByRole("group", { name: "Which part", exact: true }).getByRole("button", { name: /^Left,/ }).click();
  await startSheet.getByRole("button", { name: /^Started Left/ }).click();
  await startSheet.getByRole("group", { name: "Quick time choices", exact: true }).getByRole("button", { name: /^Since the last feed,/ }).click();
  assert.equal(await startSheet.locator('input[type="time"]').inputValue(), "08:38");
  assert.equal((await snapshot()).calls.length, 0);
  await startSheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await startSheet.waitFor({ state: "hidden" });
  console.log("PASS nursing: No break and Since the last feed retain exact boundaries and remain drafts");

  await page.evaluate(() => window.__mapleUiFixture.nursingScenario("break"));
  await page.getByRole("button", { name: "Edit completed break", exact: true }).click();
  const completedBreakSheet = page.getByRole("dialog", { name: "Edit nursing times", exact: true });
  assert.equal(await completedBreakSheet.locator('input[type="time"]').inputValue(), "09:00", "A completed break targets when the following side started, not ended");
  await completedBreakSheet.getByRole("button", { name: "1 min earlier", exact: true }).click();
  await completedBreakSheet.getByRole("button", { name: "Save time", exact: true }).click();
  await completedBreakSheet.waitFor({ state: "hidden" });
  assert.equal((await snapshot()).feed.data.segments[1].start, "2026-10-28T12:59:00.000Z");
  assert.equal((await snapshot()).feed.data.segments[1].end, "2026-10-28T13:15:00.000Z");

  await page.evaluate(() => window.__mapleUiFixture.nursingScenario("paused"));
  await page.getByRole("button", { name: "Edit active nursing times", exact: true }).click();
  const pausedSheet = page.getByRole("dialog", { name: "Edit nursing times", exact: true });
  await pausedSheet.getByRole("radiogroup", { name: "Which side is she on", exact: true }).getByRole("radio", { name: "Right", exact: true }).click();
  assert.equal(await pausedSheet.locator('input[type="time"]').inputValue(), "09:30", "Already back on opens the current time without another choice");
  assert(!(await pausedSheet.getByRole("button", { name: "Save time", exact: true }).isDisabled()), "A new resume can save the default now without nudging it");
  assert.equal((await snapshot()).calls.length, 0, "Choosing the resumed side does not save immediately");
  await pausedSheet.getByRole("button", { name: "Save time", exact: true }).click();
  await pausedSheet.waitFor({ state: "hidden" });
  assert.equal((await snapshot()).calls[0].action, "resume");
  assert.equal((await snapshot()).activeFeed.data.segments[1].start, "2026-10-28T13:30:00.000Z");
  console.log("PASS nursing context: completed-break entry edits the resume start; Already back on saves its default now");

  // Keep the nursing shortcuts usable on the narrowest supported phone too.
  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() => window.__mapleUiFixture.nursingScenario("switch"));
  await page.getByRole("button", { name: "Edit active nursing times", exact: true }).click();
  await settleView();
  await noOverflow();
  for (const label of ["5 min earlier", "1 min earlier", "1 min later", "5 min later"]) {
    const box = await page.getByRole("button", { name: label, exact: true }).boundingBox();
    assert(box && box.width >= 44 && box.height >= 44 && box.x >= 0 && box.x + box.width <= 321, `${label} remains a 44px target within 320px`);
  }
  await page.screenshot({ path: path.join(screenshots, "nursing-320-day.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Edit nursing times", exact: true }).waitFor({ state: "hidden" });

  await page.goto(url);
  await page.getByRole("button", { name: "History", exact: true }).click();
  const log = page.getByRole("region", { name: "Example log", exact: true });
  await log.getByRole("button", { name: /^Edit time:/ }).first().click();
  const logSheet = page.getByRole("dialog", { name: "Edit nursing times", exact: true });
  await logSheet.waitFor();
  assert.equal(await logSheet.locator('input[type="time"]').inputValue(), "09:15", "A logged feed opens the shared editor at its end");
  assert.equal((await snapshot()).sheetTargets.at(-1).preset.fix.target, "finish", "The real EntryRow preset selects the nursing end editor");
  await logSheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await logSheet.waitFor({ state: "hidden" });

  // This historical entry is intentionally never included in state.entries.
  await log.getByRole("button", { name: /^Edit time:/ }).last().click();
  await logSheet.waitFor();
  assert.equal(await logSheet.locator('input[type="date"]').inputValue(), "2026-10-23");
  assert.equal(await logSheet.getByText(/discarded|no longer in the log/i).count(), 0, "Outside the recent-state window does not mean discarded");
  await logSheet.getByRole("button", { name: "1 min earlier", exact: true }).click();
  await logSheet.getByRole("button", { name: "Save time", exact: true }).click();
  await logSheet.waitFor({ state: "hidden" });
  assert.equal((await snapshot()).historicalFeed.ended_at, "2026-10-23T13:14:00.000Z");
  assert.equal((await snapshot()).calls.at(-1).id, 203, "History edits retain the exact old entry identity");
  assert.equal((await snapshot()).calls.at(-1).edit.expect_updated_at, "2026-10-23T13:15:00.000Z", "Historical correction uses the version it opened");
  console.log("PASS log entry: real EntryRow preset opens shared end editor; historical time outside recent state saves the exact entry/version");

  await log.getByRole("button", { name: /^Edit time:/ }).last().click();
  await logSheet.getByRole("button", { name: "1 min earlier", exact: true }).click();
  await logSheet.getByRole("button", { name: "Edit feed details or add a side", exact: true }).click();
  const detailsGuard = page.getByRole("alertdialog", { name: "Discard this time change?", exact: true });
  await detailsGuard.waitFor();
  await detailsGuard.getByRole("button", { name: "Keep editing", exact: true }).click();
  assert.equal(await logSheet.locator('input[type="time"]').inputValue(), "09:13", "Details navigation keeps the unsaved time until explicitly discarded");
  const writesBeforeDetails = (await snapshot()).calls.length;
  await logSheet.getByRole("button", { name: "Edit feed details or add a side", exact: true }).click();
  await detailsGuard.getByRole("button", { name: "Discard change", exact: true }).click();
  const detailsSheet = page.getByRole("dialog", { name: "Feed details", exact: true });
  await detailsSheet.waitFor();
  assert.equal((await snapshot()).sheetTargets.at(-1).entry.id, 203);
  assert.equal((await snapshot()).sheetTargets.at(-1).preset, undefined, "Full details navigation leaves the quick-time route");
  assert.equal((await snapshot()).sheetTargets.at(-1).entry.ended_at, "2026-10-23T13:14:00.000Z", "Details receives saved times, not a discarded draft");
  assert.equal((await snapshot()).calls.length, writesBeforeDetails, "Discard and details navigation make no timer write");
  assert(await detailsSheet.getByText("Historical example note", { exact: true }).isVisible());
  await page.keyboard.press("Escape");
  await detailsSheet.waitFor({ state: "hidden" });

  await log.getByRole("button", { name: /^Edit time:/ }).last().click();
  await logSheet.getByRole("button", { name: "1 min earlier", exact: true }).click();
  await page.keyboard.press("Escape");
  const closeGuard = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
  await closeGuard.waitFor();
  await closeGuard.getByRole("button", { name: "Keep editing", exact: true }).click();
  await closeGuard.waitFor({ state: "hidden" });
  assert.equal(await logSheet.locator('input[type="time"]').inputValue(), "09:13");
  await page.keyboard.press("Escape");
  await closeGuard.getByRole("button", { name: "Discard changes", exact: true }).click();
  await logSheet.waitFor({ state: "hidden" });
  assert.equal((await snapshot()).historicalFeed.ended_at, "2026-10-23T13:14:00.000Z");
  console.log("PASS log details: explicit route, exact saved entry and note, dirty navigation/closing guards preserve unsaved work");

  await page.evaluate(() => window.__mapleUiFixture.setReadOnly(true));
  assert.equal(await log.getByRole("button", { name: /^Edit time:/ }).count(), 0, "Read-only log offers no Edit time action");
  await log.getByRole("button").last().click();
  await logSheet.waitFor();
  assert(await logSheet.getByText(/View only\. Ask/).isVisible());
  assert.equal(await logSheet.locator('input').count(), 0, "Even a read-only history route exposes no time editor");
  assert.equal(await logSheet.getByRole("button", { name: "Save time", exact: true }).count(), 0);
  assert.equal(await logSheet.getByRole("button", { name: "Edit feed details or add a side", exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  await logSheet.waitFor({ state: "hidden" });
  console.log("PASS log access: read-only entry route cannot edit times or open editing details");

  await page.evaluate(() => window.__mapleUiFixture.setReadOnly(false));
  await log.getByRole("button", { name: /^Edit time:/ }).last().click();
  await logSheet.getByRole("button", { name: "1 min earlier", exact: true }).click();
  await page.evaluate(() => window.__mapleUiFixture.historicalFailure("changed"));
  await logSheet.getByRole("button", { name: "Save time", exact: true }).click();
  await logSheet.getByRole("alert").filter({ hasText: "nothing was saved" }).waitFor();
  const conflictTime = (await snapshot()).historicalFeed.ended_at;
  const conflictVersion = (await snapshot()).historicalFeed.updated_at;
  assert.equal(await logSheet.locator('input[type="time"]').inputValue(), "09:16", "Conflict resets the historical editor to the returned current value");
  await page.evaluate(() => window.__mapleUiFixture.evictHistorical());
  assert.equal(await logSheet.getByText(/discarded|no longer in the log/i).count(), 0, "Polling the recent window must not turn the historical conflict response into a deletion");
  await logSheet.getByRole("button", { name: "1 min earlier", exact: true }).click();
  await logSheet.getByRole("button", { name: "Save time", exact: true }).click();
  await logSheet.waitFor({ state: "hidden" });
  assert.equal((await snapshot()).calls.at(-1).edit.expect_updated_at, conflictVersion, "Retry keeps the latest historical revision after poll eviction");
  assert.equal(Date.parse((await snapshot()).historicalFeed.ended_at), Date.parse(conflictTime) - 60_000);
  await log.getByRole("button", { name: /^Edit time:/ }).last().click();
  await logSheet.getByRole("button", { name: "1 min earlier", exact: true }).click();
  await page.evaluate(() => window.__mapleUiFixture.historicalFailure("gone"));
  await logSheet.getByRole("button", { name: "Save time", exact: true }).click();
  await logSheet.getByText(/Alex discarded this feed/).first().waitFor();
  assert(await logSheet.getByRole("button", { name: "Save time", exact: true }).isDisabled(), "An explicit deletion still disables historical editing");
  await logSheet.getByRole("button", { name: "Close", exact: true }).last().click();
  await logSheet.waitFor({ state: "hidden" });
  console.log("PASS historical recovery: conflict revision survives recent-window eviction; explicit deletion disables editing");

  await page.setViewportSize({ width: 320, height: 568 });
  await log.getByRole("button", { name: /^Edit time:/ }).first().click();
  await settleView();
  const fixedSave = logSheet.getByRole("button", { name: "Save time", exact: true });
  const initialSaveBox = await fixedSave.boundingBox();
  assert(initialSaveBox && initialSaveBox.y >= 0 && initialSaveBox.y + initialSaveBox.height <= 568, "Save time is visible immediately at 320×568");
  await logSheet.getByRole("button", { name: "Edit feed details or add a side", exact: true }).scrollIntoViewIfNeeded();
  const scrolledSaveBox = await fixedSave.boundingBox();
  assert(scrolledSaveBox && Math.abs(scrolledSaveBox.y - initialSaveBox.y) <= 1 && scrolledSaveBox.y + scrolledSaveBox.height <= 568, "Save time stays fixed while editing controls scroll");
  await noOverflow();
  await page.screenshot({ path: path.join(screenshots, "nursing-320-short-fixed-save.png"), fullPage: true });
  await logSheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await logSheet.waitFor({ state: "hidden" });
  console.log("PASS short phone: nursing Save stays visible and fixed at 320×568 while controls scroll");

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
