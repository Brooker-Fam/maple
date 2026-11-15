import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, webkit } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const out = await mkdtemp(path.join(tmpdir(), "maple-timing-range-"));
const browserName = process.env.REVIEW_BROWSER === "webkit" ? "webkit" : "chromium";
const browser = await { chromium, webkit }[browserName].launch();
const baseline = process.env.MAPLE_TIMING_RANGE_BASELINE;

const serve = async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, "https://timing-range.example.test");
  if (url.pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(out, "app.js")) });
  if (url.pathname === "/api/maple/auth/me") return route.fulfill({ json: { signedIn: false, google: false, email: false, apple: false, password: false } });
  if (url.pathname === "/api/maple/state") return route.fulfill({ status: 401, json: { error: "Synthetic signed-out fixture" } });
  if (url.pathname === "/api/maple/diagnostics") return route.fulfill({ status: 204 });
  if (url.pathname.startsWith("/api/")) throw new Error(`Unexpected request: ${url.pathname}`);
  return route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div><script type="module" src="/app.js"></script>' });
};

try {
  await build({
    entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(out, "app.js"), bundle: true, format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env": "{}" },
    plugins: baseline ? [{ name: "baseline-time-range", setup(plugin) {
      plugin.onLoad({ filter: /\/uiFields\.tsx$/ }, ({ path: file }) => ({ contents: execFileSync("git", ["show", `${baseline}:${path.relative(root, file)}`], { cwd: root, encoding: "utf8" }), loader: "tsx", resolveDir: path.dirname(file) }));
    } }] : [],
  });
  const context = await browser.newContext({ timezoneId: "UTC" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-10-29T03:59:50.000Z") });
  await page.route("**/*", serve);
  await page.goto("https://timing-range.example.test");
  const end = page.getByRole("group", { name: "Ended", exact: true });
  await end.getByLabel("Ended: time", { exact: true }).waitFor();
  await page.clock.setFixedTime(new Date("2026-10-29T04:00:10.000Z"));
  await end.getByRole("button", { name: "Now", exact: true }).click();
  assert.equal(await end.getByLabel("Ended: date", { exact: true }).inputValue(), "2026-10-29");
  await end.getByRole("group", { name: "Day", exact: true }).getByRole("button", { name: "Today", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  assert.equal(await page.getByLabel("Saved end").textContent(), "2026-10-29T04:00:10.000Z", "Today must refer to the current family date after midnight, without waiting for the periodic clock refresh");
  assert.deepEqual(errors, []);
  console.log(`PASS Today preserves the selected current date across midnight (${browserName})`);

  {
    // A start someone set: each chip keeps it and moves the end, and one that would end after now stays off.
    const context = await browser.newContext({ timezoneId: "UTC" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // React's own warnings (two scrubbers sharing a key leave a stale one on screen); the fixture's signed-out 401 is expected.
    page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text()); });
    await page.clock.install({ time: new Date("2026-10-29T14:00:00.000Z") });
    await page.route("**/*", serve);
    await page.goto("https://timing-range.example.test/?start=2026-10-29T13:45:00.000Z&end=2026-10-29T13:45:00.000Z");
    const start = page.getByLabel("Started: time", { exact: true });
    const end = page.getByLabel("Ended: time", { exact: true });
    const duration = page.getByRole("group", { name: "Duration", exact: true });
    const chip = (name) => duration.getByRole("button", { name, exact: true });
    const save = page.getByRole("button", { name: "Save", exact: true });
    await end.waitFor();
    assert(await chip("15m").isEnabled(), "A duration that ends by now is offered");
    for (const name of ["30m", "45m", "1h"]) assert(await chip(name).isDisabled(), `${name} from 9:45 would end after now`);
    await duration.getByText("A longer one would end after now. Choose an earlier start first.", { exact: true }).waitFor();
    await chip("15m").click();
    assert.equal(await start.inputValue(), "09:45", "A duration keeps the start");
    assert.equal(await end.inputValue(), "10:00", "A duration moves the end");
    await page.clock.fastForward(15 * 60_000);
    await chip("30m").click({ timeout: 5000 });
    assert.equal(await start.inputValue(), "09:45", "Once the clock gets there, a longer duration runs from the same start");
    assert.equal(await end.inputValue(), "10:15");
    await end.fill("09:30");
    assert(await save.isDisabled(), "An end before the start needs correcting");
    assert(await chip("30m").isEnabled(), "A duration can replace an end draft that needs correcting");
    await chip("30m").click();
    assert.equal(await end.inputValue(), "10:15", "Choosing the same duration again replaces the draft on screen");
    assert(await save.isEnabled());
    await start.fill("10:30");
    assert(await chip("15m").isDisabled(), "A duration never counts from a start that isn't the one on screen");
    await duration.getByText("Check the start date and time before choosing a duration.", { exact: true }).waitFor();
    await start.fill("09:45");
    await save.click();
    assert.equal(await page.getByLabel("Saved start").textContent(), "2026-10-29T13:45:00.000Z");
    assert.equal(await page.getByLabel("Saved end").textContent(), "2026-10-29T14:15:00.000Z");
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS Duration chips keep a start someone set and move only the end, never past now (${browserName})`);
  }

  {
    // The form's own guess at the start: kept while a chip fits, and given way to one that can't (it just finished).
    const context = await browser.newContext({ timezoneId: "UTC" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text()); });
    await page.clock.install({ time: new Date("2026-10-29T14:00:00.000Z") });
    await page.clock.setFixedTime(new Date("2026-10-29T14:00:00.000Z"));
    await page.route("**/*", serve);
    await page.goto("https://timing-range.example.test/?set=0&start=2026-10-29T13:45:00.000Z&end=2026-10-29T14:00:00.000Z");
    const start = page.getByLabel("Started: time", { exact: true });
    const end = page.getByLabel("Ended: time", { exact: true });
    const duration = page.getByRole("group", { name: "Duration", exact: true });
    const chip = (name) => duration.getByRole("button", { name, exact: true });
    await end.waitFor();
    for (const name of ["15m", "30m", "1h", "3h"]) assert(await chip(name).isEnabled(), `${name} is offered from a guessed start`);
    assert.equal(await duration.getByText(/would end after now/).count(), 0);
    await chip("15m").click();
    assert.equal(await start.inputValue(), "09:45", "A chip that fits keeps even a guessed start");
    assert.equal(await end.inputValue(), "10:00");
    await chip("1h").click();
    assert.equal(await start.inputValue(), "09:00", "One that can't fit from the guess: it just finished");
    assert.equal(await end.inputValue(), "10:00");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    assert.equal(await page.getByLabel("Saved start").textContent(), "2026-10-29T13:00:00.000Z");
    assert.equal(await page.getByLabel("Saved end").textContent(), "2026-10-29T14:00:00.000Z");
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS A guessed start stays while a chip fits and gives way to one that can't (${browserName})`);
  }
} finally {
  await browser.close();
  await rm(out, { recursive: true, force: true });
}
