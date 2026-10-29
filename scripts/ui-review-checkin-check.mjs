import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const output = await mkdtemp(path.join(tmpdir(), "maple-checkin-ui-"));
await build({ entryPoints: [path.join(root, "scripts/ui-review-checkin-fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true, format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env.NODE_ENV": '"test"' }, plugins: [{ name: "synthetic-care-boundaries", setup(plugin) {
  if (process.env.CHECKIN_BASELINE === "1") plugin.onLoad({ filter: /src\/components\/maple\/care\/(CheckIn|FullCheckIn|NutritionEntrySheet)\.tsx$/ }, (args) => ({ contents: execFileSync("git", ["show", `eb425d5:${path.relative(root, args.path)}`], { cwd: root, encoding: "utf8" }), loader: "tsx", resolveDir: path.dirname(args.path) }));
  plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav|sheets)$/ }, () => ({ path: path.join(root, "scripts/ui-review-care-mocks.jsx") }));
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
page.on("dialog", (dialog) => dialog.accept());
const visit = async (scenario = "full") => { await page.goto(`https://maple-checkin.example.test/?scenario=${scenario}&run=${Math.random()}`); await page.getByRole("heading", { name: "Example check-in", exact: true }).waitFor(); };
const answer = async (value = "Not at all") => {
  await page.waitForTimeout(450);
  await page.getByRole("radio", { name: value, exact: true }).click();
};
const start = async () => { await visit(); await page.getByRole("button", { name: "Start", exact: true }).click(); };
const reachCrisis = async () => {
  await start();
  for (let i = 0; i < 8; i++) await answer();
  await answer("Several days");
  await page.getByRole("button", { name: "Continue the check-in", exact: true }).waitFor();
  await page.waitForTimeout(800);
  await page.waitForFunction(() => [...document.querySelectorAll("button")].find((button) => button.textContent === "Continue the check-in")?.getAttribute("aria-disabled") !== "true");
};
const cases = [
  ["late partial failure does not survive a successful final save", async () => {
    await start();
    await page.evaluate(() => { window.__checkinFixture.hold = true; window.__checkinFixture.failFirst = true; });
    for (let i = 0; i < 8; i++) await answer();
    await answer("Several days");
    await page.getByRole("button", { name: "Continue the check-in", exact: true }).waitFor();
    await page.waitForTimeout(850);
    await page.getByRole("button", { name: "Continue the check-in", exact: true }).click();
    for (let i = 0; i < 7; i++) await answer();
    await page.waitForTimeout(450); await page.getByRole("radio").first().click();
    await page.getByRole("button", { name: /^(Saving…|Done)$/ }).waitFor();
    await page.evaluate(() => { window.__checkinFixture.hold = false; window.__checkinFixture.pending(); });
    await page.waitForFunction(() => window.__checkinFixture.calls.length === 2);
    await page.getByRole("button", { name: "Done", exact: true }).waitFor();
    await page.waitForTimeout(100);
    assert.equal(await page.getByText("Synthetic check-in save failure", { exact: true }).count(), 0, "Successful final save must clear the previous partial error");
  }],
  ["remote tags update while an unsaved note remains intact", async () => {
    await visit("daily");
    await page.getByRole("button", { name: "Anything else? (optional)", exact: true }).click();
    await page.getByRole("textbox").fill("Synthetic unsaved note");
    await page.evaluate(() => window.__checkinFixture.externalTags(["tearful"]));
    await page.waitForFunction(() => document.querySelector('button[aria-pressed="true"]')?.textContent === "Tearful");
    assert.equal(await page.getByRole("textbox").inputValue(), "Synthetic unsaved note");
    await page.locator("button[aria-pressed]").filter({ hasText: "Anxious" }).click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("textbox").waitFor({ state: "hidden" });
    const calls = await page.evaluate(() => window.__checkinFixture.calls);
    assert.deepEqual(calls.at(-1).patch.tags, ["tearful", "anxious"]);
    assert(calls.some((call) => call.patch.note === "Synthetic unsaved note"));
  }],
  ["remote tags merge with a failed local tag before retry", async () => {
    await visit("daily");
    await page.getByRole("button", { name: "Anything else? (optional)", exact: true }).click();
    await page.evaluate(() => { window.__checkinFixture.fail = true; });
    await page.locator("button[aria-pressed]").filter({ hasText: "Anxious" }).click();
    await page.getByText("Synthetic check-in save failure", { exact: true }).waitFor();
    await page.evaluate(() => window.__checkinFixture.externalTags(["tearful"]));
    await page.waitForFunction(() => [...document.querySelectorAll('button[aria-pressed="true"]')].some((button) => button.textContent === "Tearful"));
    assert.equal(await page.locator("button[aria-pressed]").filter({ hasText: "Anxious" }).getAttribute("aria-pressed"), "true");
    await page.evaluate(() => { window.__checkinFixture.fail = false; });
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByRole("textbox").waitFor({ state: "hidden" });
    const calls = await page.evaluate(() => window.__checkinFixture.calls);
    assert.deepEqual([...calls.at(-1).patch.tags].sort(), ["anxious", "tearful"]);
  }],
  ["daily tag failure remains retryable instead of hiding on Done", async () => {
    await visit("daily");
    await page.getByRole("button", { name: "Anything else? (optional)", exact: true }).click();
    await page.evaluate(() => { window.__checkinFixture.fail = true; });
    await page.getByRole("button", { name: "Tearful", exact: true }).click();
    await page.getByText("Synthetic check-in save failure", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.waitForTimeout(400);
    await page.getByText("Synthetic check-in save failure", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Tearful", exact: true }).getAttribute("aria-pressed"), "true");
    await page.evaluate(() => { window.__checkinFixture.fail = false; });
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByRole("button", { name: "Tearful", exact: true }).and(page.locator("[aria-pressed]")).waitFor({ state: "hidden" });
    const calls = await page.evaluate(() => window.__checkinFixture.calls);
    assert.deepEqual(calls.at(-1).patch, { tags: ["tearful"] });
  }],
  ...["food", "drink"].map((kind) => [`${kind} form guards its failed save draft`, async () => {
    await visit(kind);
    const input = page.getByRole("textbox", { name: kind === "food" ? "What was it?" : "Drink", exact: true });
    await input.fill("Synthetic example");
    await page.getByRole("button", { name: kind === "food" ? "Log food" : "Log drink", exact: true }).click();
    await page.getByText("Synthetic nutrition save failure", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    assert.equal(await input.inputValue(), "Synthetic example");
  }]),
  ["early answers require explicit discard and remain local", async () => {
    await start(); await answer();
    await page.keyboard.press("Escape");
    const discard = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
    await discard.waitFor();
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await page.getByText("Question 2 of 16", { exact: true }).waitFor();
    await page.goBack();
    await discard.waitFor();
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.__checkinFixture.calls), []);
  }],
  ["failed completed check-in stays retryable and Done waits for save", async () => {
    await start();
    await page.evaluate(() => { window.__checkinFixture.fail = true; });
    for (let i = 0; i < 16; i++) await answer();
    await page.getByText("Synthetic check-in save failure", { exact: true }).waitFor();
    assert(await page.getByRole("button", { name: "Done", exact: true }).isDisabled());
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await page.evaluate(() => { window.__checkinFixture.fail = false; });
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.getByText("Synthetic check-in save failure", { exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  }],
  ["partial close waits for its save and retry preserves the existing row", async () => {
    await reachCrisis();
    assert.equal((await page.evaluate(() => window.__checkinFixture.calls))[0].data.item9_ever, true);
    await page.getByRole("button", { name: "Continue the check-in", exact: true }).click();
    await page.getByText("Question 10 of 16", { exact: true }).waitFor();
    await answer();
    await page.evaluate(() => { window.__checkinFixture.fail = true; });
    await page.keyboard.press("Escape");
    await page.getByText("Synthetic check-in save failure", { exact: true }).waitFor();
    await page.getByText("Question 11 of 16", { exact: true }).waitFor();
    await page.evaluate(() => { window.__checkinFixture.fail = false; });
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    const calls = await page.evaluate(() => window.__checkinFixture.calls);
    assert(calls.slice(1).every((call) => call.options?.id === 901), "Every partial retry updates the first saved row");
    assert.equal(calls.at(-1).data.gad7.length, 1);
  }],
  ["daily note reports saving, keeps failed text, and retries once", async () => {
    await visit("daily");
    await page.getByRole("button", { name: "Anything else? (optional)", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Check-in saved" }).waitFor();
    await page.evaluate(() => { window.__checkinFixture.fail = true; window.__checkinFixture.hold = true; });
    const note = page.getByRole("textbox");
    await note.fill("Synthetic note to keep");
    await page.getByRole("status").filter({ hasText: "Unsaved changes" }).waitFor();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Saving changes…" }).waitFor();
    assert(await page.getByRole("button", { name: "Saving…", exact: true }).isDisabled());
    assert.equal((await page.evaluate(() => window.__checkinFixture.calls)).length, 1, "Save changes bypasses blur and makes one request");
    await page.evaluate(() => { window.__checkinFixture.hold = false; window.__checkinFixture.pending(); });
    await page.getByText("Synthetic check-in save failure", { exact: true }).waitFor();
    assert.equal(await note.inputValue(), "Synthetic note to keep");
    assert.equal((await page.evaluate(() => window.__checkinFixture.calls)).length, 1);
    await page.evaluate(() => { window.__checkinFixture.fail = false; });
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await note.waitFor({ state: "hidden" });
    assert.equal((await page.evaluate(() => window.__checkinFixture.calls)).length, 2);
  }],
  ["daily note Change cannot silently hide a failed save", async () => {
    await visit("daily");
    await page.getByRole("button", { name: "Anything else? (optional)", exact: true }).click();
    await page.evaluate(() => { window.__checkinFixture.fail = true; });
    await page.getByRole("textbox").fill("Synthetic unfinished note");
    await page.getByRole("button", { name: "Change", exact: true }).click();
    await page.getByText("Synthetic check-in save failure", { exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox").inputValue(), "Synthetic unfinished note");
  }],
  ["past check-in explicit save keeps failed note edits visible", async () => {
    await visit("daily");
    await page.getByRole("button", { name: "Your check-ins", exact: true }).click();
    await page.getByRole("button", { name: /^Today ·/ }).click();
    await page.evaluate(() => { window.__checkinFixture.fail = true; });
    await page.getByRole("textbox").fill("Synthetic historical note");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByText("Synthetic check-in save failure", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.waitForTimeout(500);
    assert.equal(await page.getByRole("textbox").inputValue(), "Synthetic historical note");
  }],
];
const selected = cases.filter(([name]) => !process.env.CHECKIN_CASE || name.includes(process.env.CHECKIN_CASE));
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
