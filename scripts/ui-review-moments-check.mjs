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
const output = await mkdtemp(path.join(tmpdir(), "maple-moments-ui-"));
await build({ entryPoints: [path.join(root, "scripts/ui-review-moments-fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true, format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env.NODE_ENV": '"test"' }, plugins: [{ name: "synthetic-moments-boundaries", setup(plugin) {
  plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|sheets|EntryRow)$/ }, () => ({ path: path.join(root, "scripts/ui-review-moments-mocks.jsx") }));
} }] });
const cssFile = path.join(root, "src/app/globals.css");
const css = await postcss([tailwind({ base: root })]).process(await readFile(cssFile, "utf8"), { from: cssFile });
await writeFile(path.join(output, "app.css"), css.css + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
const page = await context.newPage();
page.setDefaultTimeout(3000);
let photos = "ok";
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/maple/photo") {
    if (photos === "all-fail" || photos === "full-fail" && url.searchParams.get("size") === "full") return route.fulfill({ status: 503, body: "Synthetic image failure" });
    return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="100"><rect width="80" height="100" fill="#7b9277"/></svg>' });
  }
  const file = url.pathname === "/app.js" || url.pathname === "/app.css" ? url.pathname.slice(1) : null;
  return route.fulfill({ contentType: file?.endsWith("js") ? "text/javascript" : file ? "text/css" : "text/html", body: file ? await readFile(path.join(output, file)) : '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>' });
});
const visit = async (scenario = "photo") => { await page.goto(`https://maple-moments.example.test/?scenario=${scenario}`); await page.getByRole("heading", { name: "Moments", exact: true }).waitFor(); };
const cases = [
  ["Back closes the photo before returning to the previous tab", async () => {
    await page.goto("https://maple-moments.example.test/?scenario=navigation#today");
    await page.getByRole("button", { name: "Go to Moments", exact: true }).click();
    await page.getByRole("button", { name: /^Example photo,/ }).click();
    await page.goBack();
    await page.getByRole("dialog", { name: "Moment", exact: true }).waitFor({ state: "hidden" });
    assert.equal(new URL(page.url()).hash, "#moments");
    await page.goBack();
    await page.waitForFunction(() => window.location.hash === "#today");
  }],
  ["501 moments remain reachable and older first/month highlights are complete", async () => {
    await visit("pages");
    await page.getByRole("button", { name: "First real smile: open the moment", exact: true }).waitFor();
    await page.getByRole("button", { name: /^Month 1,.*: open$/ }).waitFor();
    const older = page.getByRole("button", { name: "Load older moments", exact: true });
    await older.waitFor();
    for (let pageNumber = 0; pageNumber < 6 && await older.isVisible(); pageNumber++) {
      await older.click();
      await page.waitForFunction(() => ![...document.querySelectorAll("button")].some((button) => button.textContent.includes("Loading older")));
    }
    assert.equal(await page.getByRole("button", { name: /^Example moment \d+,/ }).count(), 501);
    assert.equal(await older.count(), 0);
  }],
  ["failed refresh remains visible alongside cached moments and retries", async () => {
    await visit();
    await page.getByRole("button", { name: /^Example photo,/ }).waitFor();
    await page.evaluate(() => window.__momentsFixture.failRefresh());
    await page.getByRole("alert").filter({ hasText: "Couldn't refresh moments" }).waitFor();
    assert.equal(await page.getByRole("button", { name: /^Example photo,/ }).count(), 1);
    await page.evaluate(() => window.__momentsFixture.allowRefresh());
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("alert").waitFor({ state: "hidden" });
  }],
  ["full photo failure offers recovery even when its thumbnail loads", async () => {
    photos = "full-fail";
    await visit();
    await page.getByRole("button", { name: /^Example photo,/ }).click();
    const dialog = page.getByRole("dialog", { name: "Moment", exact: true });
    await dialog.getByText("Couldn't load the full photo.", { exact: true }).waitFor();
    photos = "ok";
    await dialog.getByRole("button", { name: "Retry photo", exact: true }).click();
    await dialog.getByRole("button", { name: "Retry photo", exact: true }).waitFor({ state: "hidden" });
    await page.waitForFunction(() => { const image = document.querySelector('[role="dialog"] img[src*="size=full"]'); return image?.complete && image.naturalWidth > 0; });
    assert(await dialog.locator('img[src*="size=full"]').evaluate((image) => image.complete && image.naturalWidth > 0));
  }],
  ["failed thumbnail identifies the problem and opens a recoverable photo", async () => {
    photos = "all-fail";
    await visit();
    const card = page.getByRole("button", { name: /^Example photo,/ });
    await card.getByText("Couldn't load photo", { exact: true }).waitFor();
    await card.click();
    const dialog = page.getByRole("dialog", { name: "Moment", exact: true });
    await dialog.getByText("Couldn't load this photo.", { exact: true }).waitFor();
    photos = "ok";
    await dialog.getByRole("button", { name: "Retry photo", exact: true }).click();
    await dialog.getByRole("button", { name: "Retry photo", exact: true }).waitFor({ state: "hidden" });
  }],
  ["optimistic edits replace an older fetched caption", async () => {
    photos = "ok";
    await visit();
    await page.getByRole("button", { name: /^Example photo,/ }).waitFor();
    await page.evaluate(() => window.__momentsFixture.editRecent());
    await page.getByRole("button", { name: /^Updated example photo,/ }).waitFor();
  }],
  ["lightbox keeps keyboard focus away from background controls", async () => {
    await visit();
    await page.getByRole("button", { name: /^Example photo,/ }).click();
    const dialog = page.getByRole("dialog", { name: "Moment", exact: true });
    await dialog.getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press("Tab");
    assert(await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement)), "Tab from the final viewer control must stay in the viewer");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert(await page.getByRole("button", { name: /^Example photo,/ }).evaluate((button) => document.activeElement === button));
  }],
  ["first photo and birth have distinct labels and missing firsts stay factual", async () => {
    await visit("empty");
    assert.deepEqual(await page.evaluate(() => window.__momentsFixture.labels()), ["First photo", "Hello, world"]);
    await page.getByText("No firsts recorded yet", { exact: true }).waitFor();
  }],
];
const selected = cases.filter(([name]) => !process.env.MOMENTS_CASE || name.includes(process.env.MOMENTS_CASE));
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
