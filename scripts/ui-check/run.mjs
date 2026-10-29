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
    plugin.onResolve({ filter: /(?:^|\/)MoreSheet$/ }, () => ({ path: path.join(here, "mocks.jsx") }));
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => /\/sheets\/(?:FixTimesSheet|NursingCorrections)\.tsx$/.test(args.importer) ? { path: path.join(here, "mocks.jsx") } : undefined);
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
  await page.evaluate(() => window.__mapleUiFixture.openManualFeed());
  await page.setViewportSize({ width: 320, height: 844 });
  const manualFeed = page.getByRole("dialog", { name: "Feed", exact: true });
  const leftMinutes = manualFeed.getByLabel("minutes on the left", { exact: true });
  const rightMinutes = manualFeed.getByLabel("minutes on the right", { exact: true });
  const bothMinutes = manualFeed.getByLabel("minutes going back and forth", { exact: true });
  const logFeed = manualFeed.getByRole("button", { name: "Log it", exact: true });
  assert(await logFeed.isDisabled(), "An empty nursing duration cannot be logged");
  for (const field of [leftMinutes, rightMinutes, bothMinutes]) {
    const usable = await field.evaluate((el) => el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) - parseFloat(getComputedStyle(el).paddingRight));
    assert(usable >= 48, "Nursing minutes have room for three digits beside the unit at 320px");
  }
  await manualFeed.getByRole("button", { name: "5 more minutes on the left", exact: true }).click();
  await manualFeed.getByRole("button", { name: "5 more minutes on the left", exact: true }).click();
  await manualFeed.getByRole("button", { name: "5 more minutes on the right", exact: true }).click();
  await manualFeed.getByRole("button", { name: "More minutes on the left", exact: true }).click();
  assert.equal(await leftMinutes.inputValue(), "11", "Exact one-minute adjustment remains available");
  await manualFeed.getByRole("button", { name: "Less minutes on the left", exact: true }).click();
  await manualFeed.getByRole("button", { name: "5 more minutes going back and forth", exact: true }).click();
  await manualFeed.getByRole("button", { name: "5 fewer minutes going back and forth", exact: true }).click();
  assert.equal(await bothMinutes.inputValue(), "0");
  assert.equal(await rightMinutes.inputValue(), "5");
  assert.equal((await snapshot()).calls.length, 0, "Duration controls stage all sides without saving");
  await leftMinutes.fill("12");
  await leftMinutes.blur();
  await settleView();
  await noOverflow();
  await page.screenshot({ path: path.join(screenshots, "manual-feed-320.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await settleView();
  await noOverflow();
  await page.screenshot({ path: path.join(screenshots, "manual-feed-390.png") });
  await logFeed.click();
  await manualFeed.waitFor({ state: "hidden" });
  const loggedFeed = (await snapshot()).calls;
  assert.equal(loggedFeed.length, 1, "One Log saves the complete manual feed");
  assert.equal(loggedFeed[0].entry.data.left_sec, 12 * 60);
  assert.equal(loggedFeed[0].entry.data.right_sec, 5 * 60);
  assert.equal(loggedFeed[0].entry.started_at, "2026-10-28T13:13:00.000Z", "Duration moves the inferred start back from the end");
  assert.equal(loggedFeed[0].entry.ended_at, "2026-10-28T13:30:00.000Z");

  await page.evaluate(() => window.__mapleUiFixture.openManualFeed());
  await leftMinutes.fill("2");
  await rightMinutes.fill("1");
  await manualFeed.getByLabel("Started", { exact: true }).getByRole("button", { name: "5 min ago", exact: true }).click();
  assert.equal(await leftMinutes.inputValue(), "2", "Choosing an earlier start preserves the typed left duration");
  assert.equal(await rightMinutes.inputValue(), "1", "Choosing an earlier start preserves the typed right duration");
  await manualFeed.getByRole("button", { name: "More minutes on the left", exact: true }).click();
  await logFeed.click();
  await manualFeed.waitFor({ state: "hidden" });
  const anchoredFeed = (await snapshot()).calls;
  assert.equal(anchoredFeed.length, 1);
  assert.equal(anchoredFeed[0].entry.started_at, "2026-10-28T13:25:00.000Z", "A chosen start stays fixed when side minutes change afterward");
  assert.equal(anchoredFeed[0].entry.ended_at, "2026-10-28T13:30:00.000Z");
  assert.equal(anchoredFeed[0].entry.data.left_sec, 3 * 60);
  assert.equal(anchoredFeed[0].entry.data.right_sec, 60);

  await page.evaluate(() => window.__mapleUiFixture.openManualFeed());
  const runningBeforeManual = (await snapshot()).activeFeed;
  await manualFeed.getByLabel("Started", { exact: true }).getByRole("button", { name: "1 min ago", exact: true }).click();
  await logFeed.click();
  await manualFeed.waitFor({ state: "hidden" });
  const minuteAgoFeed = (await snapshot()).calls;
  assert.equal(minuteAgoFeed.length, 1);
  assert.equal(minuteAgoFeed[0].entry.started_at, "2026-10-28T13:29:00.000Z");
  assert.equal(minuteAgoFeed[0].entry.ended_at, "2026-10-28T13:30:00.000Z");
  assert.equal(minuteAgoFeed[0].entry.data.left_sec, 60, "Without typed minutes, the chosen span counts on the starting side");
  assert.equal(minuteAgoFeed[0].entry.active, undefined, "Logging an earlier feed does not start a timer");
  assert.deepEqual((await snapshot()).activeFeed, runningBeforeManual, "Logging earlier leaves the running timer unchanged");

  await page.evaluate(() => window.__mapleUiFixture.openManualFeed());
  await leftMinutes.fill("5");
  const manualStart = manualFeed.getByLabel("Started: time", { exact: true });
  await manualStart.fill("09:45");
  assert(await logFeed.isDisabled());
  await leftMinutes.fill("6");
  assert.equal(await manualStart.inputValue(), "09:45", "Changing side minutes preserves an invalid explicit start");
  assert(await logFeed.isDisabled(), "Side minutes cannot silently replace an invalid start with an inferred time");
  assert.equal((await snapshot()).calls.length, 0);
  await manualFeed.getByRole("group", { name: "Started", exact: true }).getByRole("button", { name: "5 min ago", exact: true }).click();
  assert.equal(await manualStart.inputValue(), "09:25", "A deliberate time preset can recover the invalid draft");
  await logFeed.click();
  await manualFeed.waitFor({ state: "hidden" });
  assert.equal((await snapshot()).calls[0].entry.started_at, "2026-10-28T13:25:00.000Z");

  for (const change of ["start", "first side"]) {
    await page.evaluate((change) => window.__mapleUiFixture.openSavedFeed("manual", change === "first side" ? 3 : 0), change);
    const form = page.getByRole("dialog").last();
    const end = form.getByLabel("Ended: time", { exact: true });
    const shownEnd = await end.inputValue();
    if (change === "start") await form.getByRole("group", { name: "Started", exact: true }).getByRole("button", { name: "1 minute earlier", exact: true }).click();
    else await form.getByRole("radio", { name: "Right", exact: true }).click();
    assert.equal(await end.inputValue(), shownEnd);
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await form.waitFor({ state: "hidden" });
    const patches = (await snapshot()).calls.filter((call) => call.patch);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].patch.ended_at, `2026-10-28T12:${change === "start" ? "12" : "15"}:00.000Z`, `${change} edits pin the displayed end instead of allowing the store to infer a new end`);
    if (change === "start") assert.equal(patches[0].patch.started_at, "2026-10-28T11:59:00.000Z");
    else assert.equal(patches[0].patch.data.first_side, "R");
  }

  await page.evaluate(() => window.__mapleUiFixture.openSavedFeed("timed"));
  const addSideForm = page.getByRole("dialog").last();
  await addSideForm.getByRole("button", { name: /^Add a side/ }).click();
  await addSideForm.getByRole("radio", { name: "Left", exact: true }).click();
  const addedStart = addSideForm.getByLabel("Started: time", { exact: true });
  const addedEnd = addSideForm.getByLabel("Ended: time", { exact: true });
  const saveSide = addSideForm.getByRole("button", { name: /^Save(?: time)?$/ });
  await addedEnd.fill("10:00");
  assert(await saveSide.isDisabled());
  await addedStart.fill("09:16");
  assert.equal(await addedEnd.inputValue(), "10:00", "Changing an added side's start cannot replace its invalid end with a five-minute guess");
  assert(await saveSide.isDisabled());
  assert.equal((await snapshot()).calls.length, 0);
  await addedEnd.fill("09:23");
  await saveSide.click();
  await addSideForm.waitFor({ state: "hidden" });
  const addedSidePatch = (await snapshot()).calls.find((call) => call.patch).patch;
  assert.equal(addedSidePatch.data.segments.at(-1).start, "2026-10-28T13:16:00.000Z");
  assert.equal(addedSidePatch.data.segments.at(-1).end, "2026-10-28T13:23:00.000Z");
  console.log("PASS nursing drafts: invalid clocks survive related edits; one Save preserves the displayed start and end");

  await page.evaluate(() => window.__mapleUiFixture.openManualFeed());
  await leftMinutes.fill("238");
  await manualFeed.getByRole("button", { name: "5 more minutes on the left", exact: true }).click();
  assert.equal(await leftMinutes.inputValue(), "240", "Quick duration adjustment respects the existing maximum");
  await leftMinutes.fill("2");
  await manualFeed.getByRole("button", { name: "5 fewer minutes on the left", exact: true }).click();
  assert.equal(await leftMinutes.inputValue(), "0", "Quick duration adjustment does not go below zero");
  await manualFeed.getByRole("button", { name: "5 more minutes going back and forth", exact: true }).click();
  await manualFeed.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  assert.equal(await bothMinutes.inputValue(), "5", "Closing and keeping a draft preserves the selected duration");
  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() => { document.documentElement.classList.add("dark", "maple-night"); document.documentElement.style.fontSize = "20px"; });
  await leftMinutes.fill("123");
  await leftMinutes.blur();
  await settleView();
  await noOverflow();
  const largeTextWidth = await leftMinutes.evaluate((el) => el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) - parseFloat(getComputedStyle(el).paddingRight));
  assert(largeTextWidth >= 44, "Three-digit minutes remain readable with large text at 320px");
  await page.screenshot({ path: path.join(screenshots, "manual-feed-320-night-large-text.png") });
  await manualFeed.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await manualFeed.waitFor({ state: "hidden" });
  assert.equal((await snapshot()).calls.length, 0, "Discarding duration changes makes no write");
  console.log("PASS manual nursing: readable ±1/±5 controls, exact typing, duration bounds, preserved drafts and one complete save");
  await page.goto(url);
  await page.setViewportSize({ width: 390, height: 844 });
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

  const nursingSheet = () => page.getByRole("dialog", { name: "Edit nursing times", exact: true });
  const selectPart = (sheet, side) => sheet.getByRole("group", { name: "Which part", exact: true }).getByRole("button", { name: new RegExp(`^${side}\\b`) }).first().click();
  const saveCorrections = (sheet) => sheet.getByRole("button", { name: "Save", exact: true });
  const cancelCorrections = async (sheet) => {
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await sheet.waitFor({ state: "hidden" });
  };

  // Every live timer exposes the same precise start controls on the first screen.
  for (const kind of ["sleep", "tummy", "pump"]) {
    await page.evaluate((kind) => window.__mapleUiFixture.timerScenario(kind), kind);
    await page.getByRole("button", { name: "Edit active nursing times", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Edit times", exact: true });
    const clock = sheet.locator('input[type="time"]');
    assert.equal(await clock.inputValue(), "09:00", "Start time is editable immediately without choosing an earlier preset");
    await sheet.getByRole("button", { name: "1 min earlier", exact: true }).click();
    assert.equal(await clock.inputValue(), "08:59");
    assert.equal((await snapshot()).calls.length, 0, "Start correction remains a draft");
    await sheet.getByRole("button", { name: kind === "sleep" ? "She's already awake" : "Already done", exact: true }).click();
    await sheet.getByRole("alertdialog", { name: "Discard this time change?" }).waitFor();
    await sheet.getByRole("button", { name: "Keep editing", exact: true }).click();
    assert.equal(await clock.inputValue(), "08:59", "Recovery navigation preserves an unsaved start correction");
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await sheet.waitFor({ state: "hidden" });
    assert.equal((await snapshot()).calls.length, 0, "Cancel leaves the running timer unchanged");

    await page.getByRole("button", { name: "Edit active nursing times", exact: true }).click();
    await sheet.getByRole("button", { name: kind === "sleep" ? "She's already awake" : "Already done", exact: true }).click();
    await sheet.getByRole("button", { name: kind === "sleep" ? "Fix when she fell asleep" : `Fix when ${kind === "tummy" ? "tummy time" : "pumping"} started`, exact: true }).click();
    assert.equal(await clock.inputValue(), "09:00", "Returning from the end question opens the start editor directly");
    await sheet.getByRole("button", { name: "1 min earlier", exact: true }).click();
    await sheet.getByRole("button", { name: "Save time", exact: true }).click();
    await sheet.waitFor({ state: "hidden" });
    const result = await snapshot();
    assert.equal(result.calls.length, 1, "One Save makes one correction request");
    assert.equal(result.activeFeed.started_at, "2026-10-28T12:59:00.000Z");
    assert(result.activeFeed.active, "Correcting the start keeps the timer running");
  }
  console.log("PASS live timers: immediate ±1/±5 start controls, staged edits, recovery navigation, Cancel and one Save");

  // The same draft spans several parts in running, paused and completed feeds.
  for (const kind of ["running", "paused", "saved"]) {
    await page.evaluate((kind) => window.__mapleUiFixture.nursingScenario(kind === "paused" ? "paused-multi" : "switch"), kind);
    await page.getByRole("button", { name: kind === "saved" ? "Edit saved nursing times" : "Edit active nursing times", exact: true }).click();
    const sheet = nursingSheet();
    const clock = sheet.locator('input[type="time"]');
    await selectPart(sheet, "Left");
    const originalLeft = kind === "paused" ? "08:55" : "09:05";
    assert.equal(await clock.inputValue(), originalLeft, "A completed side opens at its end");
    await sheet.getByRole("button", { name: "5 min earlier", exact: true }).click();
    const correctedLeft = await clock.inputValue();
    await sheet.getByRole("button", { name: "1 min earlier", exact: true }).click();
    await sheet.getByRole("button", { name: "1 min later", exact: true }).click();
    assert.equal(await clock.inputValue(), correctedLeft);
    await sheet.getByRole("button", { name: "5 min later", exact: true }).click();
    assert.equal(await clock.inputValue(), originalLeft);
    assert(await saveCorrections(sheet).isDisabled(), "Returning to the original time clears the draft");
    if (kind !== "paused") assert(await sheet.getByRole("button", { name: "1 min later", exact: true }).isDisabled(), "A side end cannot overlap the next side");
    await sheet.getByRole("button", { name: "5 min earlier", exact: true }).click();
    await selectPart(sheet, "Right");
    assert.equal(await page.getByRole("alertdialog").count(), 0, "Moving to another part never asks to discard the first correction");
    await clock.fill("09:10");
    await selectPart(sheet, "Left");
    assert.equal(await clock.inputValue(), correctedLeft, "The first side's draft survives part navigation");
    await selectPart(sheet, "Right");
    assert.equal(await clock.inputValue(), "09:10", "The second side's draft survives part navigation");
    assert.equal((await snapshot()).calls.length, 0, "All corrections stay local until Save");
    const key = kind === "saved" ? "feed" : "activeFeed";
    const before = (await snapshot())[key];
    assert.equal(before.data.segments[0].end, kind === "paused" ? "2026-10-28T12:55:00.000Z" : "2026-10-28T13:05:00.000Z");
    if (kind === "running") {
      await settleView();
      await page.screenshot({ path: path.join(screenshots, "nursing-390-staged.png"), fullPage: true });
    }
    await saveCorrections(sheet).click();
    await sheet.waitFor({ state: "hidden" });
    const result = await snapshot();
    assert.equal(result.calls.length, 1, "One Save makes one timer request for the whole draft");
    assert.equal(result.calls[0].edit.op, "batch");
    assert(result.calls[0].edit.edits.length >= 2, "Both corrections are included in one batch");
    assert.equal(result.calls[0].edit.expect_updated_at, before.updated_at);
    assert.equal(result[key].data.segments[0].end, kind === "paused" ? "2026-10-28T12:50:00.000Z" : "2026-10-28T13:00:00.000Z");
    assert.equal(result[key].data.segments[1][kind === "running" ? "start" : "end"], "2026-10-28T13:10:00.000Z");
    assert.equal(result[key].active, before.active, "Corrections preserve active status");
    if (kind !== "saved") assert.equal(result[key].ended_at, null, "A correction does not finish a running or paused feed");
    if (kind === "running") assert.equal(result[key].data.segments[1].end, null);
    if (kind === "paused") assert(result[key].data.segments.every((segment) => segment.end), "A paused feed stays paused");
  }
  console.log("PASS nursing: multiple corrections survive part navigation and save atomically on running, paused and saved feeds");

  // Changing a side is another part of the same draft; it never writes on tap.
  for (const save of [false, true]) {
    await page.evaluate(() => window.__mapleUiFixture.nursingScenario("break"));
    await page.getByRole("button", { name: "Edit saved nursing times", exact: true }).click();
    const sheet = nursingSheet();
    await selectPart(sheet, "Left");
    await sheet.locator('input[type="time"]').fill("08:53");
    await sheet.getByRole("button", { name: /^It was both sides:/ }).click();
    await selectPart(sheet, "Right");
    assert.equal((await snapshot()).calls.length, 0, "Choosing a side is staged alongside time changes");
    assert.equal((await snapshot()).feed.data.segments[0].side, "L");
    assert.equal((await snapshot()).feed.data.segments[0].end, "2026-10-28T12:55:00.000Z");
    if (save) {
      await saveCorrections(sheet).click();
      await sheet.waitFor({ state: "hidden" });
      const result = await snapshot();
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].edit.op, "batch");
      assert(result.calls[0].edit.edits.some((edit) => edit.op === "move"));
      assert(result.calls[0].edit.edits.some((edit) => edit.op === "set_side"));
      assert.equal(result.feed.data.segments[0].side, "B");
      assert.equal(result.feed.data.segments[0].end, "2026-10-28T12:53:00.000Z");
      assert.equal(result.feed.data.segments[1].start, "2026-10-28T13:00:00.000Z");
    } else {
      await cancelCorrections(sheet);
      assert.equal((await snapshot()).calls.length, 0, "Cancel discards every staged correction without a request");
      assert.equal((await snapshot()).feed.data.segments[0].side, "L");
    }
  }
  console.log("PASS nursing sides: time and side changes share one draft, Cancel makes no request, Save applies both once");


  await page.evaluate(() => window.__mapleUiFixture.nursingScenario("same-side-gap"));
  await page.getByRole("button", { name: "Edit saved nursing times", exact: true }).click();
  const mergeSheet = nursingSheet();
  await mergeSheet.getByRole("group", { name: "Which part", exact: true }).getByRole("button", { name: /^Left\b/ }).nth(1).click();
  await mergeSheet.getByRole("button", { name: /^Started Left/ }).click();
  await mergeSheet.getByRole("group", { name: "Quick time choices", exact: true }).getByRole("button", { name: /^No break,/ }).click();
  assert.equal(await mergeSheet.getByRole("group", { name: "Which part", exact: true }).getByRole("button", { name: /^Left\b/ }).count(), 1, "Removing the break merges adjacent parts on the same side");
  assert(await mergeSheet.getByRole("button", { name: /^Started Left/ }).isVisible(), "The merged Left part stays selected after its index changes");
  await mergeSheet.getByRole("button", { name: /^It was both sides:/ }).click();
  assert.equal((await snapshot()).calls.length, 0);
  await saveCorrections(mergeSheet).click();
  await mergeSheet.waitFor({ state: "hidden" });
  const merged = await snapshot();
  assert.equal(merged.calls.length, 1);
  assert.equal(merged.feed.data.segments.length, 2);
  assert.equal(merged.feed.data.segments[0].side, "B", "A side correction after merging addresses the merged part");
  assert.equal(merged.feed.data.segments[0].start, "2026-10-28T12:45:00.000Z");
  assert.equal(merged.feed.data.segments[1].side, "R", "Merging never retargets a subsequent correction to the following side");
  assert.equal(merged.feed.data.segments[1].start, "2026-10-28T13:10:00.000Z");
  console.log("PASS nursing merge: No break preserves the selected part and later side correction uses its new reference");

  await page.evaluate(() => window.__mapleUiFixture.nursingScenario("switch"));
  await page.getByRole("button", { name: "Edit active nursing times", exact: true }).click();
  const switchSheet = nursingSheet();
  const switchClock = switchSheet.locator('input[type="time"]');
  const quick = switchSheet.getByRole("group", { name: "Quick time choices", exact: true });
  await quick.getByRole("button", { name: /^Usual,/ }).click();
  assert.equal(await switchClock.inputValue(), "08:55", "Usual uses the synthetic history's ten minutes on Left");
  await quick.getByRole("button", { name: /^Likely,/ }).click();
  assert.equal(await switchClock.inputValue(), "09:00", "Likely uses fifteen minutes on Left");
  await quick.getByRole("button", { name: /^Likely,/ }).click();
  assert.equal(await switchClock.inputValue(), "09:00", "Repeating a named preset never accumulates the correction");
  await switchClock.fill("");
  assert(await saveCorrections(switchSheet).isDisabled(), "Invalid current input cannot save the last valid draft");
  await quick.getByRole("button", { name: /^Likely,/ }).click();
  assert.equal(await switchClock.inputValue(), "09:00", "A preset recovers an incomplete input");
  await selectPart(switchSheet, "Left");
  await switchSheet.getByRole("button", { name: /^Started Left/ }).click();
  await switchSheet.getByRole("button", { name: "1 min earlier", exact: true }).click();
  await selectPart(switchSheet, "Right");
  const stagedPreset = switchSheet.getByRole("group", { name: "Quick time choices", exact: true }).getByRole("button", { name: /^Usual,/ });
  await stagedPreset.click();
  const stagedPresetTime = await switchClock.inputValue();
  await stagedPreset.click();
  assert.equal(await switchClock.inputValue(), stagedPresetTime, "A repeated preset stays absolute when another part is also staged");
  assert.equal((await snapshot()).calls.length, 0);
  await saveCorrections(switchSheet).click();
  await switchSheet.waitFor({ state: "hidden" });
  const switched = (await snapshot()).activeFeed;
  assert.equal(switched.data.segments[0].end, switched.data.segments[1].start, "Editing a switch intentionally transfers the shared boundary");
  assert.equal(switched.started_at, "2026-10-28T12:44:00.000Z", "The additional first-start correction is saved too");
  assert.equal((await snapshot()).calls.length, 1);
  console.log("PASS nursing presets: Usual/Likely are absolute, recover invalid input and remain idempotent amid other staged corrections");

  await page.evaluate(() => window.__mapleUiFixture.nursingScenario("break"));
  await page.getByRole("button", { name: "Edit active nursing times", exact: true }).click();
  const breakSheet = nursingSheet();
  await breakSheet.getByRole("group", { name: "Quick time choices", exact: true }).getByRole("button", { name: /^No break,/ }).click();
  assert.equal(await breakSheet.locator('input[type="time"]').inputValue(), "08:55");
  await saveCorrections(breakSheet).click();
  await breakSheet.waitFor({ state: "hidden" });
  assert.equal((await snapshot()).activeFeed.data.segments[1].start, "2026-10-28T12:55:00.000Z");

  await page.evaluate(() => window.__mapleUiFixture.nursingScenario("last-feed"));
  await page.getByRole("button", { name: "Edit active nursing times", exact: true }).click();
  const startSheet = nursingSheet();
  await selectPart(startSheet, "Left");
  await startSheet.getByRole("button", { name: /^Started Left/ }).click();
  await startSheet.getByRole("group", { name: "Quick time choices", exact: true }).getByRole("button", { name: /^Since the last feed,/ }).click();
  assert.equal(await startSheet.locator('input[type="time"]').inputValue(), "08:38");
  assert.equal((await snapshot()).calls.length, 0);
  await cancelCorrections(startSheet);

  await page.evaluate(() => window.__mapleUiFixture.nursingScenario("break"));
  await page.getByRole("button", { name: "Edit completed break", exact: true }).click();
  const completedBreakSheet = nursingSheet();
  assert.equal(await completedBreakSheet.locator('input[type="time"]').inputValue(), "09:00", "Opening a completed break selects the following start");
  await completedBreakSheet.getByRole("button", { name: "1 min earlier", exact: true }).click();
  await saveCorrections(completedBreakSheet).click();
  await completedBreakSheet.waitFor({ state: "hidden" });
  assert.equal((await snapshot()).feed.data.segments[1].start, "2026-10-28T12:59:00.000Z");
  assert.equal((await snapshot()).feed.data.segments[1].end, "2026-10-28T13:15:00.000Z");
  console.log("PASS nursing context: No break, Since the last feed and completed-break corrections retain the intended boundaries");

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
  await cancelCorrections(nursingSheet());

  await page.goto(url);
  await page.getByRole("button", { name: "History", exact: true }).click();
  const log = page.getByRole("region", { name: "Example log", exact: true });
  await log.getByRole("button", { name: /^Edit time:/ }).first().click();
  const logSheet = nursingSheet();
  await logSheet.waitFor();
  assert.equal(await logSheet.locator('input[type="time"]').inputValue(), "09:15");
  assert.equal((await snapshot()).sheetTargets.at(-1).preset.fix.target, "finish", "EntryRow opens the shared editor at the nursing end");
  await cancelCorrections(logSheet);

  // An old entry may never be loaded, or may fall out of the recent window later.
  await log.getByRole("button", { name: /^Edit time:/ }).last().click();
  await logSheet.waitFor();
  assert.equal(await logSheet.locator('input[type="date"]').inputValue(), "2026-10-23");
  assert.equal(await logSheet.getByText(/discarded|no longer in the log/i).count(), 0);
  await logSheet.getByRole("button", { name: "1 min earlier", exact: true }).click();
  await saveCorrections(logSheet).click();
  await logSheet.waitFor({ state: "hidden" });
  assert.equal((await snapshot()).historicalFeed.ended_at, "2026-10-23T13:14:00.000Z");
  assert.equal((await snapshot()).calls.at(-1).id, 203);
  assert.equal((await snapshot()).calls.at(-1).edit.expect_updated_at, "2026-10-23T13:15:00.000Z");

  await page.evaluate(() => window.__mapleUiFixture.loadHistorical());
  await log.getByRole("button", { name: /^Edit time:/ }).last().click();
  await logSheet.getByRole("button", { name: "1 min earlier", exact: true }).click();
  await page.evaluate(() => window.__mapleUiFixture.evictHistorical());
  assert.equal(await logSheet.getByText(/discarded|no longer in the log/i).count(), 0, "An initially loaded historical entry is not deleted when the recent window evicts it");
  assert.equal(await logSheet.locator('input[type="time"]').inputValue(), "09:13", "Recent-window eviction retains the historical draft");
  assert(!(await saveCorrections(logSheet).isDisabled()));
  await cancelCorrections(logSheet);
  console.log("PASS history: absent and initially loaded old entries remain editable across recent-window eviction");

  await log.getByRole("button", { name: /^Edit time:/ }).last().click();
  await logSheet.getByRole("button", { name: "1 min earlier", exact: true }).click();
  await logSheet.getByRole("button", { name: "Edit feed details or add a side", exact: true }).click();
  const detailsGuard = page.getByRole("alertdialog");
  await detailsGuard.waitFor();
  await detailsGuard.getByRole("button", { name: "Keep editing", exact: true }).click();
  assert.equal(await logSheet.locator('input[type="time"]').inputValue(), "09:13");
  const writesBeforeDetails = (await snapshot()).calls.length;
  await logSheet.getByRole("button", { name: "Edit feed details or add a side", exact: true }).click();
  await detailsGuard.getByRole("button", { name: /Discard/ }).click();
  const detailsSheet = page.getByRole("dialog", { name: "Feed details", exact: true });
  await detailsSheet.waitFor();
  assert.equal((await snapshot()).sheetTargets.at(-1).entry.id, 203);
  assert.equal((await snapshot()).sheetTargets.at(-1).preset, undefined);
  assert.equal((await snapshot()).sheetTargets.at(-1).entry.ended_at, "2026-10-23T13:14:00.000Z");
  assert.equal((await snapshot()).calls.length, writesBeforeDetails);
  assert(await detailsSheet.getByText((await snapshot()).historicalFeed.note, { exact: true }).isVisible());
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
  console.log("PASS nursing dismissal: details navigation and closing preserve the draft until explicitly discarded");

  await page.evaluate(() => window.__mapleUiFixture.setReadOnly(true));
  assert.equal(await log.getByRole("button", { name: /^Edit time:/ }).count(), 0);
  const viewerWrites = (await snapshot()).calls.length;
  await log.getByRole("button").last().click();
  const viewerSheet = page.getByRole("dialog");
  await viewerSheet.waitFor();
  assert.equal((await snapshot()).sheetTargets.at(-1).preset, undefined, "A viewer opens full details rather than the correction form");
  assert(await viewerSheet.getByText(/View only\. Ask/).isVisible());
  assert.equal(await viewerSheet.getByRole("button", { name: /^Save(?: time)?$/ }).count(), 0);
  assert.equal(await viewerSheet.getByRole("button", { name: "Delete", exact: true }).count(), 0);
  const fullNote = (await snapshot()).historicalFeed.note;
  const noteText = viewerSheet.getByText(fullNote, { exact: true });
  if (await noteText.count()) {
    await noteText.scrollIntoViewIfNeeded();
    assert(await noteText.isVisible(), "The full historical note is readable in the real details sheet");
    assert(await noteText.evaluate((element) => element.scrollHeight <= element.clientHeight + 1), "The viewer note has no clipped hidden lines");
  } else {
    assert.equal(await viewerSheet.locator("textarea").inputValue(), fullNote, "The full historical note survives the viewer route");
    await viewerSheet.locator("textarea").scrollIntoViewIfNeeded();
  }
  assert.equal((await snapshot()).calls.length, viewerWrites);
  await page.keyboard.press("Escape");
  await viewerSheet.waitFor({ state: "hidden" });
  console.log("PASS viewer history: real FeedSheet exposes the complete long note without correction, Save or Delete actions");

  await page.evaluate(() => window.__mapleUiFixture.setReadOnly(false));
  await log.getByRole("button", { name: /^Edit time:/ }).last().click();
  await logSheet.getByRole("button", { name: "1 min earlier", exact: true }).click();
  await selectPart(logSheet, "Left");
  await logSheet.locator('input[type="time"]').fill("08:53");
  await page.evaluate(() => window.__mapleUiFixture.historicalFailure("changed"));
  const originalConflictFeed = (await snapshot()).historicalFeed;
  await saveCorrections(logSheet).click();
  await logSheet.getByRole("button", { name: "Use latest", exact: true }).waitFor();
  assert(await saveCorrections(logSheet).isDisabled(), "A stale batch cannot overwrite the returned current entry");
  assert.equal(await logSheet.locator('input[type="time"]').inputValue(), "08:53", "Conflict keeps the local draft available for review");
  assert.equal((await snapshot()).historicalFeed.data.segments[0].end, originalConflictFeed.data.segments[0].end, "A rejected batch makes no partial first-side correction");
  const conflictTime = (await snapshot()).historicalFeed.ended_at;
  const conflictVersion = (await snapshot()).historicalFeed.updated_at;
  await logSheet.getByRole("button", { name: "Use latest", exact: true }).click();
  await page.evaluate(() => window.__mapleUiFixture.evictHistorical());
  assert.equal(await logSheet.getByText(/discarded|no longer in the log/i).count(), 0);
  await selectPart(logSheet, "Right");
  assert.equal(await logSheet.locator('input[type="time"]').inputValue(), "09:16", "Use latest starts a new draft on the returned version");
  await logSheet.getByRole("button", { name: "1 min earlier", exact: true }).click();
  await saveCorrections(logSheet).click();
  await logSheet.waitFor({ state: "hidden" });
  assert.equal((await snapshot()).calls.at(-1).edit.expect_updated_at, conflictVersion);
  assert.equal(Date.parse((await snapshot()).historicalFeed.ended_at), Date.parse(conflictTime) - 60_000);
  await log.getByRole("button", { name: /^Edit time:/ }).last().click();
  await logSheet.getByRole("button", { name: "1 min earlier", exact: true }).click();
  await page.evaluate(() => window.__mapleUiFixture.historicalFailure("gone"));
  await saveCorrections(logSheet).click();
  await logSheet.getByText(/Alex discarded this feed/).first().waitFor();
  assert(await saveCorrections(logSheet).isDisabled(), "An explicit deletion disables historical editing");
  await cancelCorrections(logSheet);
  console.log("PASS history conflicts: rejected batches apply nothing, retry uses the latest revision after eviction, and deletion stays blocked");

  await page.evaluate(() => { window.__mapleUiFixture.setRealDetails(true); window.__mapleUiFixture.loadHistorical(); });
  await log.getByRole("button", { name: /^Edit time:/ }).last().click();
  await logSheet.getByRole("button", { name: "Edit feed details or add a side", exact: true }).click();
  const realDetails = page.getByRole("dialog");
  await realDetails.getByRole("button", { name: /^Started Left/ }).click();
  await realDetails.locator('input[type="time"]').fill("08:44");
  await page.evaluate(() => window.__mapleUiFixture.failDetailsConflict());
  await realDetails.getByRole("button", { name: "Save time", exact: true }).click();
  await realDetails.getByRole("alert").filter({ hasText: "your change wasn't saved" }).waitFor();
  const currentDetails = (await snapshot()).historicalFeed;
  assert.equal(currentDetails.started_at, "2026-10-23T12:45:00.000Z", "Rejected full-details time change never partially saves");
  assert.equal(await realDetails.getByText(/discarded|Nothing to save: it's gone/i).count(), 0, "A historical details conflict stays available after refresh eviction");
  await realDetails.getByRole("button", { name: /^Started Left/ }).click();
  assert.equal(await realDetails.locator('input[type="time"]').inputValue(), "08:45");
  await realDetails.locator('input[type="time"]').fill("08:44");
  await realDetails.getByRole("button", { name: "Save time", exact: true }).click();
  await realDetails.waitFor({ state: "hidden" });
  const detailsRetry = (await snapshot()).calls.filter((call) => call.details);
  assert.equal(detailsRetry.length, 2, "One rejected details save can retry once without a conflict loop");
  assert.equal(detailsRetry[1].patch.expect_updated_at, currentDetails.updated_at, "Full details retains the exact server-returned version outside recent state");
  assert.equal((await snapshot()).historicalFeed.started_at, "2026-10-23T12:44:00.000Z");
  assert.equal((await snapshot()).historicalFeed.ended_at, currentDetails.ended_at, "Retry preserves the other person's end-time change");
  await page.evaluate(() => window.__mapleUiFixture.setRealDetails(false));
  console.log("PASS full historical details: server-returned conflict revision survives recent-window eviction and retries successfully");

  await page.setViewportSize({ width: 320, height: 568 });
  await log.getByRole("button", { name: /^Edit time:/ }).first().click();
  await settleView();
  const fixedSave = saveCorrections(logSheet);
  const fixedPreview = logSheet.locator("[data-nursing-correction-preview]");
  const initialSaveBox = await fixedSave.boundingBox();
  const initialPreviewBox = await fixedPreview.boundingBox();
  assert(initialSaveBox && initialSaveBox.y >= 0 && initialSaveBox.y + initialSaveBox.height <= 568, "Save is visible immediately on a 320×568 phone");
  assert(initialPreviewBox && initialPreviewBox.y >= 0 && initialPreviewBox.y + initialPreviewBox.height <= initialSaveBox.y + 1, "The complete preview is visible immediately above Save");
  assert.match(await fixedPreview.textContent(), /total/i, "The pinned preview includes the total duration");
  await logSheet.getByRole("button", { name: "Edit feed details or add a side", exact: true }).scrollIntoViewIfNeeded();
  const scrolledSaveBox = await fixedSave.boundingBox();
  const scrolledPreviewBox = await fixedPreview.boundingBox();
  assert(scrolledSaveBox && Math.abs(scrolledSaveBox.y - initialSaveBox.y) <= 1);
  assert(scrolledPreviewBox && Math.abs(scrolledPreviewBox.y - initialPreviewBox.y) <= 1, "Preview stays with Save while controls scroll");
  await noOverflow();
  await logSheet.getByRole("button", { name: "5 min later", exact: true }).click();
  await logSheet.getByRole("button", { name: "Edit feed details or add a side", exact: true }).scrollIntoViewIfNeeded();
  await logSheet.getByRole("button", { name: "Edit feed details or add a side", exact: true }).click();
  const shortGuard = logSheet.getByRole("alertdialog", { name: "Unsaved nursing changes", exact: true });
  await shortGuard.waitFor();
  const shortGuardBox = await shortGuard.boundingBox();
  assert(shortGuardBox && shortGuardBox.y >= 0 && shortGuardBox.y + shortGuardBox.height <= 568, "Unsaved navigation choices scroll into view on a short phone");
  assert(await shortGuard.evaluate((element) => element.contains(document.activeElement)), "Focus moves to the visible unsaved navigation choices");
  await shortGuard.getByRole("button", { name: "Keep editing", exact: true }).click();
  await page.screenshot({ path: path.join(screenshots, "nursing-320-short-fixed-save.png"), fullPage: true });
  await cancelCorrections(logSheet);
  console.log("PASS short phone: total preview and Save remain visible together at 320×568 while controls scroll");

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
  if (errors.length) console.error("Browser errors:", errors);
  await page.screenshot({ path: path.join(screenshots, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
