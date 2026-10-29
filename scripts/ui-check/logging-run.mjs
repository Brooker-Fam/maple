import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const output = await mkdtemp(path.join(tmpdir(), "maple-logging-ui-"));
const screenshots = path.join(root, "test-results/maple-logging-ui");
await mkdir(screenshots, { recursive: true });
await build({
  entryPoints: [path.join(here, "logging-fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", sourcemap: "inline", absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"test"' },
  plugins: [{ name: "synthetic-logging-boundaries", setup(plugin) {
    if (process.env.LOGGING_BASELINE) {
      const baselineFiles = new Set([
        "LogTab.tsx", "MoreSheet.tsx", "PatternsTab.tsx", "StatusCard.tsx", "TodayTab.tsx",
        ...["Activity", "Diaper", "Feed", "Growth", "Med", "Moment", "Note", "Pump", "Sleep", "Temp", "Vitals"].map((name) => `sheets/${name}Sheet.tsx`),
      ].map((file) => `src/components/maple/${file}`));
      plugin.onLoad({ filter: /\.tsx$/ }, ({ path: file }) => {
        const relative = path.relative(root, file);
        if (!baselineFiles.has(relative)) return;
        return { contents: execFileSync("git", ["show", `4c709f11cfaf98c6f5550acc667e1443d5447262:${relative}`], { cwd: root, encoding: "utf8" }), loader: "tsx" };
      });
    }
    const mocks = { path: path.join(here, "logging-mocks.jsx") };
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav|useTimerActions|AppNav|sheets)$/ }, () => mocks);
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => /\/sheets\/(?:parts|MomentSheet|useSavedEntryConflict)\.tsx$/.test(args.importer) ? mocks : undefined);
  } }],
});
const compiled = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, "src/app/globals.css"), "utf8"), { from: path.join(root, "src/app/globals.css") });
await writeFile(path.join(output, "app.css"), compiled.css + "\n" + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
await writeFile(path.join(output, "index.html"), '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic logging checks</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", timezoneId: "UTC" });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/*", async (route) => {
  const pathname = new URL(route.request().url()).pathname;
  const file = ["/app.js", "/app.css"].includes(pathname) ? pathname.slice(1) : "index.html";
  await route.fulfill({ status: 200, contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html", body: await readFile(path.join(output, file)) });
});
const url = "https://logging.example.test";
const snapshot = () => page.evaluate(() => window.__loggingFixture.snapshot());
const assertInputValue = async (input, value, message) => {
  const element = await input.elementHandle();
  try {
    await page.waitForFunction(({ element, value }) => element?.value === value, { element, value });
    assert.equal(await input.inputValue(), value, message);
  } finally {
    await element?.dispose();
  }
};
const checks = [];
const check = async (name, run) => {
  if (process.env.LOGGING_CHECK && !name.includes(process.env.LOGGING_CHECK)) return;
  try { await run(); console.log(`PASS ${name}`); }
  catch (e) { checks.push(name); console.log(`FAIL ${name}: ${e.message}`); await page.screenshot({ path: path.join(screenshots, `${name.replaceAll(" ", "-")}-failure.png`) }); }
};
try {
  await check("historical day", async () => {
    await page.goto(`${url}?mode=history`);
    await page.getByRole("button", { name: "Jump to a day" }).click();
    await page.getByRole("textbox", { name: "Jump to a day" }).fill("2026-10-25").catch(() => page.getByLabel("Jump to a day", { exact: true }).fill("2026-10-25"));
    await page.locator("#maple-day-2026-10-25").getByRole("button", { name: "Diaper", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    assert.equal((await snapshot()).target.preset?.started_at?.slice(0, 10), "2026-10-25", "Historical add must carry the chosen date");
    assert(await page.getByRole("dialog").getByText(/Sun, Oct 25/).count(), "Form must display the chosen date");
  });
  await check("historical sleep", async () => {
    await page.goto(`${url}?mode=history`);
    await page.getByRole("button", { name: "Jump to a day" }).click();
    await page.getByLabel("Jump to a day", { exact: true }).fill("2026-10-25");
    await page.locator("#maple-day-2026-10-25").getByRole("button", { name: "Sleep", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Sleep", exact: true });
    await form.waitFor();
    assert.equal((await snapshot()).target.preset?.ended_at?.slice(0, 10), "2026-10-25", "Historical sleep must end on the chosen day");
    for (const label of ["Fell asleep", "Woke up"]) {
      assert(await form.getByRole("group", { name: label, exact: true }).getByText(/Sun, Oct 25/).count(), `${label} must remain on the chosen day`);
    }
  });
  await check("bottle while nursing", async () => {
    for (const mode of ["more-active", "more-paused"]) {
      await page.goto(`${url}?mode=${mode}`);
      await page.getByRole("dialog", { name: "More to log" }).waitFor();
      assert(await page.getByRole("button", { name: /^Bottle/ }).count(), "Bottle must remain available during active and paused nursing");
      await page.getByRole("button", { name: /^Bottle/ }).click();
      await page.getByRole("dialog", { name: "Feed", exact: true }).waitFor();
      assert.equal((await snapshot()).target.preset.method, "bottle");
      assert.equal((await snapshot()).calls.filter((x) => x.log).length, 0, "Opening a bottle must not write");
    }
  });
  await check("expanded diaper details", async () => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(`${url}?mode=form-diaper`);
    const form = page.getByRole("dialog", { name: "Diaper", exact: true });
    await form.getByRole("radio", { name: "Poop", exact: true }).click();
    const details = form.getByRole("region", { name: "Diaper details", exact: true });
    for (const name of ["Seedy", "Big", "Diaper rash"]) {
      const choice = details.getByRole("button", { name, exact: true });
      assert(await choice.isVisible(), `${name} is available without opening More details`);
      await choice.click();
    }
    assert.equal((await snapshot()).calls.filter((x) => x.log).length, 0, "Choosing details keeps the diaper unsaved");
    await form.getByRole("button", { name: "Log it", exact: true }).click();
    const diaper = (await snapshot()).calls.find((x) => x.log)?.log;
    assert.equal(diaper.kind, "diaper");
    assert.deepEqual(diaper.data, { pee: false, poop: true, texture: "seedy", size: "big", rash: true }, "Visible options are included in the logged diaper");
    await page.setViewportSize({ width: 390, height: 844 });
  });
  await check("expanded bottle milk", async () => {
    await page.goto(`${url}?mode=form-feed`);
    const form = page.getByRole("dialog", { name: "Feed", exact: true });
    await form.getByRole("radio", { name: "Bottle", exact: true }).click();
    const milk = form.getByRole("region", { name: "Milk", exact: true });
    for (const name of ["Breast milk", "Formula", "Mixed"]) {
      assert(await milk.getByRole("button", { name, exact: true }).isVisible(), `${name} is available without opening More details`);
    }
    await milk.getByRole("button", { name: "Formula", exact: true }).click();
    assert.equal((await snapshot()).calls.filter((x) => x.log).length, 0, "Choosing milk keeps the bottle unsaved");
    await form.getByRole("button", { name: /^Log / }).click();
    const bottle = (await snapshot()).calls.find((x) => x.log)?.log;
    assert.equal(bottle.data.method, "bottle");
    assert.equal(bottle.data.milk, "formula", "The visible milk choice is included when logging");
  });
  await check("pump mode carries measured amounts", async () => {
    await page.goto(`${url}?mode=form-pump`);
    const form = page.getByRole("dialog").first();
    await form.getByRole("textbox", { name: "left, oz", exact: true }).fill("2");
    await form.getByRole("textbox", { name: "right, oz", exact: true }).fill("1");
    await form.getByRole("radio", { name: "Total", exact: true }).click();
    assert.equal(await form.getByRole("textbox", { name: "total, oz", exact: true }).inputValue(), "3", "Total starts with the entered sides' sum");
    await form.getByRole("radio", { name: "Each side", exact: true }).click();
    assert.equal(await form.getByRole("textbox", { name: "left, oz", exact: true }).inputValue(), "2");
    assert.equal(await form.getByRole("textbox", { name: "right, oz", exact: true }).inputValue(), "1");
    await form.getByRole("radio", { name: "Total", exact: true }).click();
    assert.equal((await snapshot()).calls.filter((x) => x.log || x.patch).length, 0, "Changing pump modes keeps the entry unsaved");
    await form.getByRole("button", { name: "Log it", exact: true }).click();
    const pump = (await snapshot()).calls.find((x) => x.log)?.log;
    assert.equal(pump.kind, "pump");
    assert(Math.abs(pump.data.total_ml - 88.7) < 0.001);
    assert.equal(pump.data.left_ml, undefined);
    assert.equal(pump.data.right_ml, undefined);
  });
  await check("pump mode changes preserve invalid amount drafts", async () => {
    for (const editing of [false, true]) {
      await page.goto(`${url}?mode=${editing ? "form-pump-sides" : "form-pump"}`);
      const form = page.getByRole("dialog").first();
      if (!editing) await form.getByRole("textbox", { name: "right, oz", exact: true }).fill("1");
      const left = form.getByRole("textbox", { name: "left, oz", exact: true });
      await left.fill("7..2");
      const total = form.getByRole("radio", { name: "Total", exact: true });
      const save = form.getByRole("button", { name: editing ? "Save" : "Log it", exact: true });
      assert(await total.isDisabled(), "A mode change cannot discard an invalid side amount");
      assert(await save.isDisabled());
      assert(await form.getByText("Correct the number before changing how amounts are entered.", { exact: true }).isVisible());
      await total.evaluate((node) => node.click());
      assert.equal(await left.inputValue(), "7..2", "The raw draft remains available to correct");
      assert.equal((await snapshot()).calls.filter((x) => x.log || x.patch).length, 0);
      await left.fill("2");
      await total.click();
      await save.click();
      const writes = (await snapshot()).calls.filter((x) => x.log || x.patch);
      assert.equal(writes.length, 1);
      assert.deepEqual(editing ? writes[0].patch.data : writes[0].log.data, editing ? { total_ml: 99.1, left_ml: null, right_ml: null } : { total_ml: 88.7 });
    }
    await page.goto(`${url}?mode=form-pump-total`);
    const form = page.getByRole("dialog").first();
    const total = form.getByRole("textbox", { name: "total, oz", exact: true });
    await total.fill("7..2");
    const sides = form.getByRole("radio", { name: "Each side", exact: true });
    assert(await sides.isDisabled(), "An invalid combined amount cannot disappear into empty side fields");
    await sides.evaluate((node) => node.click());
    assert.equal(await total.inputValue(), "7..2");
    assert(await form.getByRole("button", { name: "Save", exact: true }).isDisabled());
    assert.equal((await snapshot()).calls.filter((x) => x.log || x.patch).length, 0);
  });
  await check("pump mode preserves recorded precision", async () => {
    for (const editLeft of [false, true]) {
      await page.goto(`${url}?mode=form-pump-sides`);
      const form = page.getByRole("dialog").first();
      if (editLeft) await form.getByRole("textbox", { name: "left, oz", exact: true }).fill("2");
      await form.getByRole("radio", { name: "Total", exact: true }).click();
      await form.getByRole("button", { name: "Save", exact: true }).click();
      const patch = (await snapshot()).calls.find((x) => x.patch)?.patch;
      assert.deepEqual(patch.data, { total_ml: editLeft ? 99.1 : 140, left_ml: null, right_ml: null }, "Total uses edits and exact untouched ml, not the rounded display values");
    }
  });
  await check("pump edited total clears stale split", async () => {
    for (const saved of [false, true]) {
      await page.goto(`${url}?mode=${saved ? "form-pump-sides" : "form-pump"}`);
      const form = page.getByRole("dialog").first();
      if (!saved) {
        await form.getByRole("textbox", { name: "left, oz", exact: true }).fill("2");
        await form.getByRole("textbox", { name: "right, oz", exact: true }).fill("1");
      }
      await form.getByRole("radio", { name: "Total", exact: true }).click();
      await form.getByRole("textbox", { name: "total, oz", exact: true }).fill("4");
      await form.getByRole("radio", { name: "Each side", exact: true }).click();
      for (const side of ["left", "right"]) assert.equal(await form.getByRole("textbox", { name: `${side}, oz`, exact: true }).inputValue(), "", "A changed combined amount cannot retain an outdated split");
      assert(await form.getByRole("button", { name: saved ? "Save" : "Log it", exact: true }).isDisabled(), "An unknown split cannot silently replace the edited total");
      await form.getByRole("radio", { name: "Total", exact: true }).click();
      assert.equal(await form.getByRole("textbox", { name: "total, oz", exact: true }).inputValue(), "4", "Returning to Total keeps the last measured combined amount");
      await form.getByRole("button", { name: saved ? "Save" : "Log it", exact: true }).click();
      const call = (await snapshot()).calls.find((x) => saved ? x.patch : x.log);
      assert.deepEqual(saved ? call.patch.data : call.log.data, saved ? { total_ml: 118.3, left_ml: null, right_ml: null } : { total_ml: 118.3 });
    }
  });
  await check("pump total never invents a split", async () => {
    await page.goto(`${url}?mode=form-pump-total`);
    const form = page.getByRole("dialog").first();
    await form.getByRole("radio", { name: "Each side", exact: true }).click();
    for (const side of ["left", "right"]) assert.equal(await form.getByRole("textbox", { name: `${side}, oz`, exact: true }).inputValue(), "");
    assert(await form.getByRole("button", { name: "Save", exact: true }).isDisabled(), "A blank split cannot silently erase the recorded total");
    await form.getByRole("radio", { name: "Total", exact: true }).click();
    assert.equal(await form.getByRole("textbox", { name: "total, oz", exact: true }).inputValue(), "3.38");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    assert.equal((await snapshot()).calls.find((x) => x.patch)?.patch.data, undefined, "Going back to the original total does not re-round it");
  });
  await check("pump replacement split clears the old opposite side", async () => {
    await page.goto(`${url}?mode=form-pump-sides`);
    const form = page.getByRole("dialog").first();
    await form.getByRole("radio", { name: "Total", exact: true }).click();
    await form.getByRole("textbox", { name: "total, oz", exact: true }).fill("4");
    await form.getByRole("radio", { name: "Each side", exact: true }).click();
    await form.getByRole("textbox", { name: "left, oz", exact: true }).fill("4");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    assert.deepEqual((await snapshot()).calls.find((x) => x.patch)?.patch.data, { left_ml: 118.3, right_ml: null, total_ml: null }, "A newly entered split cannot keep a hidden amount from the old split");
  });
  await check("pump presets preserve exact amounts and midnight", async () => {
    await page.goto(`${url}?mode=form-pump-sides-preset`);
    let form = page.getByRole("dialog").first();
    await form.getByRole("button", { name: "Log it", exact: true }).click();
    assert.deepEqual((await snapshot()).calls.find((x) => x.log)?.log.data, { left_ml: 100, right_ml: 40 }, "Untouched supplied amounts keep their recorded precision");
    await page.goto(`${url}?mode=form-pump-midnight`);
    form = page.getByRole("dialog").first();
    await form.getByRole("button", { name: "Log it", exact: true }).click();
    const pump = (await snapshot()).calls.find((x) => x.log)?.log;
    assert.equal(pump.started_at, "2026-10-25T04:00:00.000Z", "A chosen midnight is not moved to the previous day by a duration default");
    assert.equal(pump.ended_at, null);
  });
  await check("pump total preset and typed amount", async () => {
    await page.goto(`${url}?mode=form-pump-preset`);
    const form = page.getByRole("dialog").first();
    const amount = form.getByRole("textbox", { name: "total, oz", exact: true });
    assert.equal(await amount.inputValue(), "3.04", "A combined amount preset opens Total");
    await amount.fill("1.1");
    assert.equal(await amount.inputValue(), "1.1", "A typed amount stays at the user's precision");
    await form.getByRole("button", { name: "Log it", exact: true }).click();
    assert.deepEqual((await snapshot()).calls.find((x) => x.log)?.log.data, { total_ml: 32.5 });
  });
  await check("expanded sleep and reading options", async () => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(`${url}?mode=form-sleep`);
    let form = page.getByRole("dialog").first();
    const place = form.getByRole("button", { name: "Bassinet", exact: true });
    assert(await place.isVisible(), "Sleep location is visible on first open");
    await place.click();
    assert.equal((await snapshot()).calls.filter((x) => x.log).length, 0);
    await form.getByRole("button", { name: "Log it", exact: true }).click();
    assert.equal((await snapshot()).calls.find((x) => x.log)?.log.data.place, "bassinet");
    for (const mode of ["form-vitals", "form-vitals-skin"]) {
      await page.goto(`${url}?mode=${mode}`);
      form = page.getByRole("dialog").first();
      assert(await form.getByRole("textbox", { name: "heart rate, beats per minute", exact: true }).isVisible(), "Numeric readings stay visible in both entry routes");
      assert(await form.getByRole("radiogroup", { name: "How far the yellow has spread", exact: true }).isVisible(), "Skin choices stay visible in both entry routes");
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Expanded options fit a narrow phone");
    }
    await page.goto(`${url}?mode=form-temp`);
    form = page.getByRole("dialog").first();
    assert(await form.getByRole("textbox", { name: "heart rate, beats per minute", exact: true }).isVisible(), "A temperature can include other readings without expanding a section");
    await page.setViewportSize({ width: 390, height: 844 });
  });
  await check("temperature requires a measured reading", async () => {
    for (const units of ["us", "metric"]) {
      await page.goto(`${url}?mode=form-temp&units=${units}`);
      const form = page.getByRole("dialog").first();
      const field = form.getByRole("textbox", { name: `temperature in degrees ${units === "metric" ? "Celsius" : "Fahrenheit"}`, exact: true });
      assert.equal(await field.inputValue(), "", "A new temperature has no invented normal reading");
      assert(await form.getByRole("button", { name: "Log it", exact: true }).isDisabled());
      await form.getByRole("textbox", { name: "heart rate, beats per minute", exact: true }).fill("120");
      assert(await form.getByRole("button", { name: "Log it", exact: true }).isDisabled(), "Optional readings do not substitute for a temperature");
      await field.fill("7..2");
      assert(await form.getByRole("button", { name: "Log it", exact: true }).isDisabled(), "An invalid reading cannot be logged");
      await field.fill(units === "metric" ? "37.0" : "98.6");
      await form.getByRole("button", { name: "Rectal", exact: true }).click();
      await form.getByRole("button", { name: "Log it", exact: true }).click();
      const logs = (await snapshot()).calls.filter((x) => x.log).map((x) => x.log);
      assert.equal(logs.length, 2);
      assert.deepEqual(logs[0].data, { temp_c: 37, method: "rectal" });
      assert.deepEqual(logs[1].data, { heart_bpm: 120 });
      assert.equal(logs[0].started_at, logs[1].started_at, "Temperature and other readings stay at the same measured time");
    }
  });
  await check("temperature preserves supplied and saved readings", async () => {
    for (const [mode, expected] of [["form-temp-preset", 37], ["form-temp-precise-preset", 37.123], ["form-temp-edit", 37.123]]) {
      await page.goto(`${url}?mode=${mode}`);
      const form = page.getByRole("dialog").first();
      assert.notEqual(await form.getByRole("textbox", { name: "temperature in degrees Fahrenheit", exact: true }).inputValue(), "");
      await form.getByRole("radio", { name: "°C", exact: true }).click();
      await form.locator("textarea").first().fill("Synthetic measured reading");
      await form.getByRole("button", { name: mode === "form-temp-edit" ? "Save" : "Log it", exact: true }).click();
      const call = (await snapshot()).calls.find((x) => x.patch || x.log);
      if (mode === "form-temp-edit") assert.equal(call.patch.data.temp_c, undefined, "An untouched saved reading is not re-rounded after switching units");
      else assert.equal(call.log.data.temp_c, expected, "A supplied measurement is not re-rounded through its display units");
    }
  });
  await check("growth unit switches preserve measured values", async () => {
    for (const editing of [false, true]) {
      await page.goto(`${url}?mode=${editing ? "form-growth-edit" : "form-growth"}&units=metric`);
      const form = page.getByRole("dialog").first();
      if (editing) await form.getByRole("textbox", { name: "grams", exact: true }).fill("3372");
      await form.getByRole("textbox", { name: "grams", exact: true }).fill("3373");
      await form.getByRole("radio", { name: "lb · in", exact: true }).click();
      if (editing) await form.getByRole("textbox", { name: "length in inches", exact: true }).fill("20.5");
      await form.getByRole("textbox", { name: "length in inches", exact: true }).fill("20.25");
      await form.getByRole("textbox", { name: "head circumference in inches", exact: true }).fill("13.25");
      for (let i = 0; i < 3; i++) {
        await form.getByRole("radio", { name: "g · cm", exact: true }).click();
        await assertInputValue(form.getByRole("textbox", { name: "grams", exact: true }), "3373", "Viewing lb and oz cannot change a measured gram value");
        await form.getByRole("radio", { name: "lb · in", exact: true }).click();
        await assertInputValue(form.getByRole("textbox", { name: "length in inches", exact: true }), "20.25", "Returning to inches keeps the typed length");
        await assertInputValue(form.getByRole("textbox", { name: "head circumference in inches", exact: true }), "13.25", "Returning to inches keeps the typed head circumference");
      }
      await form.getByRole("button", { name: editing ? "Save" : "Log it", exact: true }).click();
      const call = (await snapshot()).calls.find((x) => x.patch || x.log);
      assert.deepEqual(editing ? call.patch.data : call.log.data, { weight_g: 3373, length_cm: 51.4, head_cm: 33.7, ...(!editing ? { at: "doctor" } : {}) });
    }
  });
  await check("growth unit changes preserve invalid measurement drafts", async () => {
    for (const editing of [false, true]) {
      await page.goto(`${url}?mode=${editing ? "form-growth-edit&units=metric" : "form-growth"}`);
      const form = page.getByRole("dialog").first();
      if (!editing) await form.getByRole("textbox", { name: "length in inches", exact: true }).fill("20");
      const weight = form.getByRole("textbox", { name: editing ? "grams" : "pounds", exact: true });
      await weight.fill("7..2");
      const units = form.getByRole("radio", { name: editing ? "lb · in" : "g · cm", exact: true });
      const save = form.getByRole("button", { name: editing ? "Save" : "Log it", exact: true });
      assert(await units.isDisabled(), "Changing units cannot turn a typo into a missing measurement");
      assert(await save.isDisabled());
      assert(await form.getByText("Correct the number before changing units.", { exact: true }).isVisible());
      await units.evaluate((node) => node.click());
      assert.equal(await weight.inputValue(), "7..2");
      assert.equal((await snapshot()).calls.filter((x) => x.log || x.patch).length, 0);
      await weight.fill(editing ? "3374" : "7");
      await units.click();
      await save.click();
      const writes = (await snapshot()).calls.filter((x) => x.log || x.patch);
      assert.equal(writes.length, 1);
      if (editing) assert.deepEqual(writes[0].patch.data, { weight_g: 3374 }, "Correcting the weight preserves untouched measurements");
      else assert.deepEqual(writes[0].log.data, { weight_g: 3175, length_cm: 50.8, at: "doctor" });
    }
  });
  await check("measurement note edits preserve unknown context", async () => {
    for (const kind of ["growth", "temp"]) {
      await page.goto(`${url}?mode=form-${kind}-edit-unknown`);
      const form = page.getByRole("dialog").first();
      if (kind === "growth") {
        for (const name of ["Doctor", "Home"]) assert.equal(await form.getByRole("radio", { name, exact: true }).getAttribute("aria-checked"), "false");
      } else {
        assert.equal(await form.getByRole("button", { name: "Rectal", exact: true }).getAttribute("aria-pressed"), "false", "Another reading's method is not assigned to this recorded temperature");
      }
      await form.locator("textarea").first().fill("Synthetic note-only edit");
      await form.getByRole("button", { name: "Save", exact: true }).click();
      const writes = (await snapshot()).calls.filter((x) => x.patch || x.log);
      assert.equal(writes.length, 1);
      assert.deepEqual(writes[0].patch.data ?? {}, {}, "A note-only edit adds no unknown measurement context");
      assert.equal(writes[0].patch.note, "Synthetic note-only edit");
      await page.goto(`${url}?mode=form-${kind}-edit-unknown`);
      const editable = page.getByRole("dialog").first();
      await editable.getByRole(kind === "growth" ? "radio" : "button", { name: kind === "growth" ? "Home" : "Armpit", exact: true }).click();
      await editable.getByRole("button", { name: "Save", exact: true }).click();
      assert.deepEqual((await snapshot()).calls.find((x) => x.patch)?.patch.data, kind === "growth" ? { at: "home" } : { method: "armpit" }, "An explicit context choice is still saved");
    }
  });
  await check("temperature unit changes preserve invalid reading drafts", async () => {
    await page.goto(`${url}?mode=form-temp&units=metric`);
    const form = page.getByRole("dialog").first();
    const reading = form.getByRole("textbox", { name: "temperature in degrees Celsius", exact: true });
    await reading.fill("50");
    const fahrenheit = form.getByRole("radio", { name: "°F", exact: true });
    assert(await fahrenheit.isDisabled(), "An out-of-range Celsius draft cannot disappear when Fahrenheit has a larger numeric limit");
    await fahrenheit.evaluate((node) => node.click());
    assert.equal(await reading.inputValue(), "50");
    assert(await form.getByRole("button", { name: "Log it", exact: true }).isDisabled());
    assert(await form.getByText("Correct the number before changing units.", { exact: true }).isVisible());
    assert.equal((await snapshot()).calls.filter((x) => x.log || x.patch).length, 0);
    await reading.fill("37.1");
    await fahrenheit.click();
    await form.getByRole("button", { name: "Log it", exact: true }).click();
    assert.deepEqual((await snapshot()).calls.find((x) => x.log)?.log.data, { temp_c: 37.1 });
  });
  await check("measurement fields fit narrow phones", async () => {
    const cramped = [];
    for (const width of [320, 390, 640]) {
      await page.setViewportSize({ width, height: 844 });
      for (const mode of ["form-growth", "form-pump"]) {
        await page.goto(`${url}?mode=${mode}`);
        const form = page.getByRole("dialog").first();
        await form.waitFor();
        for (const field of await form.locator('input[inputmode="decimal"]').all()) {
          const [label, available] = await field.evaluate((node) => {
            const style = getComputedStyle(node);
            return [node.getAttribute("aria-label"), node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)];
          });
          if (available < 64) cramped.push(`${label} at ${width}px has ${available}px for its number`);
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Measurement rows stay within the phone");
      }
    }
    for (const font of [24, 32]) {
      await page.setViewportSize({ width: 320, height: 568 });
      await page.goto(`${url}?mode=form-growth`);
      const form = page.getByRole("dialog").first();
      await form.waitFor();
      await page.evaluate((font) => { document.documentElement.style.fontSize = `${font}px`; }, font);
      for (const name of ["Home", "g · cm"]) {
        const choice = form.getByRole("radio", { name, exact: true });
        await choice.scrollIntoViewIfNeeded();
        assert(await choice.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const group = element.parentElement.getBoundingClientRect();
          return box.width >= 44 && box.height >= 44 && box.left >= group.left && box.right <= group.right &&
            document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest("button") === element;
        }), `${name} must remain an unobstructed 44px choice at 320px / ${font}px text`);
        await choice.click();
        assert.equal(await choice.getAttribute("aria-checked"), "true");
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.deepEqual(cramped, [], "Measured decimals need at least 64px of readable input space");
  });
  await check("growth cleared readings stay blank across units", async () => {
    await page.goto(`${url}?mode=form-growth`);
    const form = page.getByRole("dialog").first();
    await form.getByRole("textbox", { name: "pounds", exact: true }).fill("7");
    await form.getByRole("textbox", { name: "ounces", exact: true }).fill("2");
    await form.getByRole("radio", { name: "g · cm", exact: true }).click();
    await form.getByRole("textbox", { name: "grams", exact: true }).fill("");
    await form.getByRole("radio", { name: "lb · in", exact: true }).click();
    for (const name of ["pounds", "ounces"]) assert.equal(await form.getByRole("textbox", { name, exact: true }).inputValue(), "", "Clearing a measurement cannot bring back an old reading");
    assert(await form.getByRole("button", { name: "Log it", exact: true }).isDisabled(), "Blank measurements cannot be logged");
    await form.getByRole("textbox", { name: "pounds", exact: true }).fill("0");
    await form.getByRole("radio", { name: "g · cm", exact: true }).click();
    assert.equal(await form.getByRole("textbox", { name: "grams", exact: true }).inputValue(), "0", "Zero stays distinct from an empty measurement");
    assert(await form.getByRole("button", { name: "Log it", exact: true }).isDisabled(), "A zero weight cannot be saved as a valid measurement");
  });
  await check("growth preserves supplied and saved precision", async () => {
    for (const editing of [false, true]) {
      await page.goto(`${url}?mode=${editing ? "form-growth-edit" : "form-growth-preset"}`);
      const form = page.getByRole("dialog").first();
      await form.getByRole("radio", { name: "g · cm", exact: true }).click();
      await form.locator("textarea").first().fill("Synthetic measurements");
      await form.getByRole("button", { name: editing ? "Save" : "Log it", exact: true }).click();
      const call = (await snapshot()).calls.find((x) => x.patch || x.log);
      if (editing) assert.equal(call.patch.data, undefined, "Note-only edits do not resend rounded measurements");
      else assert.deepEqual(call.log.data, { weight_g: 3373, length_cm: 51.43, head_cm: 34.27, at: "doctor" }, "Supplied measurements do not round through display units");
    }
  });
  await check("temperature unit switches preserve a typed reading", async () => {
    for (const editing of [false, true]) {
      await page.goto(`${url}?mode=${editing ? "form-temp-edit" : "form-temp"}`);
      const form = page.getByRole("dialog").first();
      await form.getByRole("textbox", { name: "temperature in degrees Fahrenheit", exact: true }).fill("98.7");
      for (let i = 0; i < 3; i++) {
        await form.getByRole("radio", { name: "°C", exact: true }).click();
        await form.getByRole("radio", { name: "°F", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('input[aria-label="temperature in degrees Fahrenheit"]')?.value === "98.7");
        assert.equal(await form.getByRole("textbox", { name: "temperature in degrees Fahrenheit", exact: true }).inputValue(), "98.7", "Viewing Celsius cannot change the typed Fahrenheit reading");
      }
      await form.getByRole("button", { name: editing ? "Save" : "Log it", exact: true }).click();
      const call = (await snapshot()).calls.find((x) => x.patch || x.log);
      assert.equal((editing ? call.patch : call.log).data.temp_c, 37.056, "Save uses the typed reading, not a rounded unit conversion");
    }
  });
  await check("temperature new unit edits and clearing replace the reading", async () => {
    for (const relabel of [false, true]) {
      await page.goto(`${url}?mode=form-temp`);
      const form = page.getByRole("dialog").first();
      await form.getByRole("textbox", { name: "temperature in degrees Fahrenheit", exact: true }).fill(relabel ? "37.2" : "98.7");
      if (relabel) await form.getByRole("button", { name: "That looks like °C. Switch to °C?", exact: true }).click();
      else {
        await form.getByRole("radio", { name: "°C", exact: true }).click();
        await form.getByRole("textbox", { name: "temperature in degrees Celsius", exact: true }).fill("37.2");
      }
      await form.getByRole("radio", { name: "°F", exact: true }).click();
      await page.waitForFunction(() => document.querySelector('input[aria-label="temperature in degrees Fahrenheit"]')?.value === "99");
      await form.getByRole("button", { name: "Log it", exact: true }).click();
      assert.equal((await snapshot()).calls.find((x) => x.log)?.log.data.temp_c, 37.2, "An explicit Celsius correction replaces the previous reading");
    }
    await page.goto(`${url}?mode=form-temp-preset`);
    const form = page.getByRole("dialog").first();
    await form.getByRole("textbox", { name: "temperature in degrees Fahrenheit", exact: true }).fill("");
    await form.getByRole("radio", { name: "°C", exact: true }).click();
    assert.equal(await form.getByRole("textbox", { name: "temperature in degrees Celsius", exact: true }).inputValue(), "");
    assert(await form.getByRole("button", { name: "Log it", exact: true }).isDisabled(), "A cleared reading cannot be restored by switching units");
  });
  await check("expanded nursing side correction", async () => {
    await page.goto(`${url}?mode=form-nursing-details`);
    const form = page.getByRole("dialog").first();
    const side = form.getByRole("region", { name: "Change side", exact: true }).first();
    const both = side.getByRole("button", { name: /^It was both sides:/ });
    assert(await both.isVisible(), "A saved side can be corrected without expanding Change side");
    await both.click();
    assert(await form.getByRole("status").filter({ hasText: "Unsaved change to the times" }).isVisible());
    assert.equal((await snapshot()).calls.filter((x) => x.patch).length, 0, "Changing a side stays a draft until Save");
    await form.getByRole("button", { name: "Save time", exact: true }).click();
    await form.waitFor({ state: "hidden" });
    const call = (await snapshot()).calls.find((x) => x.patch);
    assert.equal(call.id, 7);
    assert.equal(call.patch.expect_updated_at, "2026-10-28T12:35:00.000Z");
    assert.deepEqual(call.patch.data.segments, [
      { side: "B", start: "2026-10-28T12:00:00.000Z", end: "2026-10-28T12:20:00.000Z" },
      { side: "R", start: "2026-10-28T12:25:00.000Z", end: "2026-10-28T12:35:00.000Z" },
    ], "Correcting a side preserves both stretches' recorded times");
  });
  await check("visible earlier action", async () => {
    await page.goto(`${url}?mode=more-active`);
    await page.getByRole("dialog", { name: "More to log" }).waitFor();
    assert(await page.getByRole("button", { name: /^Log earlier/ }).count(), "Backfill must have a visible action during a timer");
    await page.getByRole("button", { name: /^Log earlier/ }).click();
    await page.getByRole("button", { name: /^Diaper/ }).click();
    await page.getByRole("dialog", { name: "Diaper", exact: true }).waitFor();
    assert((await snapshot()).target.preset.started_at, "Earlier form must begin with a visible recorded time");
    assert.equal((await snapshot()).calls.filter((x) => x.log).length, 0, "Earlier route opens an unsaved form");
  });
  await check("more immediate actions", async () => {
    await page.goto(`${url}?mode=more-active`);
    await page.getByRole("dialog", { name: "More to log" }).waitFor();
    assert(await page.getByRole("button", { name: /^Log Vitamin D/ }).count(), "Immediate log action must say it logs");
    assert(await page.getByRole("button", { name: /^Start tummy timer/ }).count(), "Immediate timer action must say it starts a timer");
  });
  await check("today details in patterns", async () => {
    await page.goto(`${url}?mode=today`);
    const recent = page.getByRole("region", { name: "Recently logged", exact: true });
    await recent.waitFor();
    assert.equal(await recent.getByRole("button").count(), 4, "Today keeps three entries and See all");
    assert(await page.getByRole("region", { name: "Logged today", exact: true }).count(), "Today keeps compact logged totals");
    assert.equal(await page.getByRole("region", { name: "Day dial", exact: true }).count(), 0);
    await page.goto(`${url}?mode=patterns`);
    await page.getByRole("region", { name: "Day dial", exact: true }).waitFor();
    assert.equal(await page.getByRole("radio", { name: "Day clock", exact: true }).getAttribute("aria-checked"), "true", "Patterns opens directly to the full day clock");
    await page.getByRole("radio", { name: "Daily totals", exact: true }).click();
    await page.getByRole("heading", { name: "Diaper changes this week", exact: true }).waitFor();
    assert(await page.getByRole("heading", { name: "Diaper changes this week", exact: true }).count(), "The weekly comparison remains available in Patterns");
  });
  await check("status labels fit narrow phones", async () => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(`${url}?mode=today`);
    const labels = page.getByRole("region", { name: "Right now", exact: true }).locator("p").filter({ hasText: /^(Since pee|Since poop|Last wet|Last dirty)$/ }).locator("span");
    assert.equal(await labels.count(), 2);
    for (const label of await labels.all()) {
      assert(await label.evaluate((node) => node.scrollWidth <= node.clientWidth), `${await label.textContent()} must not truncate`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
  });
  await check("birth uncertainty in visit summary", async () => {
    await page.goto(`${url}?mode=patterns`);
    await page.waitForFunction(() => !!window.__loggingFixture);
    const [unknown, afterSpringForward, exact] = await page.evaluate(() => Promise.all([
      { born: "2026-10-28T04:00:00.000Z", approximate: true },
      { born: "2026-03-08T05:00:00.000Z", approximate: true, at: "2026-03-09T04:30:00.000Z" },
      { born: "2026-10-28T04:00:00.000Z", approximate: false },
    ].map((input) => window.__loggingFixture.visitSummary(input).then((summary) => summary.split("\n")[1]))));
    assert.equal(unknown, "Born Wed, Oct 28, time not recorded", "Unknown birth times preserve the recorded date without an age claim");
    assert.equal(afterSpringForward, "Born Sun, Mar 8, time not recorded", "A daylight-saving transition does not turn a birth date into an exact age");
    assert.equal(exact, "Born Wed, Oct 28 at 12:00 AM · today she's 9 hours old (Day 1)");
  });
  await check("patterns retry", async () => {
    await page.goto(`${url}?mode=patterns-error`);
    await page.getByRole("heading", { name: "Patterns", exact: true }).waitFor();
    await page.getByRole("radio", { name: "Daily totals", exact: true }).click();
    await page.getByRole("button", { name: "Try again", exact: true }).waitFor();
    assert(await page.getByRole("button", { name: "Try again", exact: true }).count(), "Failed history load needs a retry");
    await page.evaluate(() => window.__loggingFixture.recover());
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.getByRole("heading", { name: "Day by day", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Try again", exact: true }).count(), 0);
  });
  await check("earlier moment", async () => {
    await page.goto(`${url}?mode=form-moment-earlier`);
    const form = page.getByRole("dialog", { name: "New moment", exact: true });
    await form.waitFor();
    assert(await form.getByText(/Sun, Oct 25/).count(), "Earlier moments must display their chosen date");
  });
  for (const kind of ["note", "diaper", "sleep", "pump", "growth", "temp", "vitals", "med", "bath", "tummy", "moment", "feed"]) {
    await check(`draft ${kind}`, async () => {
      await page.goto(`${url}?mode=form-${kind}`);
      const form = page.getByRole("dialog").first();
      await form.waitFor();
      await form.locator("textarea").first().fill("Synthetic unsaved note");
      await form.getByRole("button", { name: "Close", exact: true }).click();
      assert(await page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true }).count(), "Closing an edited form must ask before discarding");
      await page.getByRole("button", { name: "Keep editing", exact: true }).click();
      assert.equal(await form.locator("textarea").first().inputValue(), "Synthetic unsaved note");
      assert.equal((await snapshot()).calls.filter((x) => x.log).length, 0, "Keeping a draft must not save it");
    });
  }
  for (const kind of ["pump", "growth", "vitals"]) {
    await check(`invalid numeric draft ${kind}`, async () => {
      await page.goto(`${url}?mode=form-${kind}`);
      const form = page.getByRole("dialog").first();
      await form.waitFor();
      const field = form.locator('input[inputmode="decimal"], input[inputmode="numeric"]').first();
      await field.fill("7..2");
      await form.getByRole("button", { name: "Close", exact: true }).click();
      assert(await page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true }).count(), "Invalid numeric text is still an unsaved draft");
      await page.getByRole("button", { name: "Keep editing", exact: true }).click();
      assert.equal(await field.inputValue(), "7..2");
    });
  }
  if (process.env.LOGGING_VISUAL) {
    for (const width of [320, 390, 1024]) {
      await page.setViewportSize({ width, height: 844 });
      for (const mode of ["today", "more-active", "patterns"]) {
        await page.goto(`${url}?mode=${mode}`);
        if (mode === "patterns") await page.getByRole("button", { name: /^Day details/ }).click();
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(screenshots, `${mode}-${width}.png`), fullPage: true });
        console.log(`VISUAL ${mode} ${width}: scroll width ${await page.evaluate(() => document.documentElement.scrollWidth)}`);
      }
    }
  }
  assert.deepEqual(errors, [], `Browser errors: ${errors.join("; ")}`);
  assert.deepEqual(checks, [], "All logging regression checks pass");
} finally { await browser.close(); await rm(output, { recursive: true, force: true }); }
