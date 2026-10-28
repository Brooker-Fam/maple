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
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => /\/sheets\/(?:parts|MomentSheet)\.tsx$/.test(args.importer) ? mocks : undefined);
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
    await page.getByRole("button", { name: /^Day details/ }).click();
    assert(await page.getByRole("region", { name: "Day dial", exact: true }).count(), "The full dial remains available in Patterns");
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
    await page.waitForTimeout(150);
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
