import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "maple-chat-navigation-"));
await build({
  entryPoints: [path.join(root, "scripts/ui-review-chat-navigation-fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
  plugins: [{ name: "synthetic-navigation-boundaries", setup(plugin) {
    const mocks = { path: path.join(root, "scripts/ui-review-settings-mocks.jsx") };
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav|useTimerActions|sheets|notify)$/ }, () => mocks);
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => args.importer.endsWith("/sheets/parts.tsx") ? mocks : undefined);
  } }],
});
const script = await readFile(path.join(output, "app.js"));
const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const failures = [];
const errors = [];
let page;
const url = "https://maple-navigation.example.test/";
async function check(name, test) {
  if (process.env.NAVIGATION_CHECK && !name.includes(process.env.NAVIGATION_CHECK)) return;
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(1800);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.fulfill({ contentType: route.request().url().endsWith("app.js") ? "text/javascript" : "text/html", body: route.request().url().endsWith("app.js") ? script : '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/app.js"></script>' }));
  try { await test(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
  finally { await page.close(); }
}
async function focused(name, hash, section) {
  await page.getByRole("heading", { name, level: 1, exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, hash);
  await page.waitForFunction((id) => document.activeElement?.id === id, section);
  assert.equal(await page.locator(`#${section}`).evaluate((node) => !!node.closest("[hidden]")), false);
}
try {
  for (const [button, heading, route, section] of [
    ["Open Baby details", "Baby details", "baby", "baby-details"],
    ["Open Doctor contacts", "Doctor & care plan", "doctor", "doctor-contacts"],
    ["Open This phone's settings", "Appearance & units", "appearance", "phone-preferences"],
  ]) await check(`chat opens ${route} with focus and Back`, async () => {
    await page.goto(`${url}#chat`);
    await page.getByRole("button", { name: button, exact: true }).click();
    await focused(heading, `#family/${route}`, section);
    await page.goBack();
    await page.getByRole("button", { name: button, exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, "#chat");
  });
  await check("viewer doctor opens read-only baby contact", async () => {
    await page.goto(`${url}?viewer#chat`);
    await page.getByRole("button", { name: "Open Doctor contacts", exact: true }).click();
    await focused("Baby details", "#family/baby", "baby-details");
    assert.equal(await page.getByRole("link", { name: /Pediatrician/ }).getAttribute("href"), "tel:2025550125");
    assert.equal(await page.getByRole("textbox").count(), 0);
  });
  for (const [label, heading, route] of [["Baby's name", "Baby details", "baby"], ["Pediatrician phone", "Doctor & care plan", "doctor"], ["Pediatrician", "Doctor & care plan", "doctor"], ["Bottles", "On Today", "today"]]) {
    await check(`stale ${label} card opens its Settings page`, async () => {
      await page.goto(`${url}#chat`);
      await page.getByRole("region", { name: `${label} setting`, exact: true }).getByRole("button", { name: "Open Settings", exact: true }).click();
      await page.getByRole("heading", { name: heading, level: 1, exact: true }).waitFor();
      assert.equal(new URL(page.url()).hash, `#family/${route}`);
    });
  }
  await check("focused settings preserve drafts and denied navigation", async () => {
    await page.goto(`${url}#chat`);
    await page.getByRole("button", { name: "Open Baby details", exact: true }).click();
    await focused("Baby details", "#family/baby", "baby-details");
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("River draft");
    await page.evaluate(() => window.__navigationFixture.go("family/appearance"));
    await page.getByRole("heading", { name: "Appearance & units", level: 1, exact: true }).waitFor();
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "chat tab", exact: true }).click();
    assert.equal(new URL(page.url()).hash, "#family/appearance");
    await page.goBack();
    await page.getByRole("heading", { name: "Baby details", level: 1, exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Name", exact: true }).inputValue(), "River draft");
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("River Example");
    await page.getByRole("button", { name: "chat tab", exact: true }).click();
    await page.getByRole("button", { name: "Open Medicines", exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.id === "mom-medicines");
    assert.equal(new URL(page.url()).hash, "#care");
  });
  await check("doctor name can be reviewed saved and retried", async () => {
    await page.goto(`${url}#chat`);
    await page.getByRole("region", { name: "Pediatrician setting", exact: true }).getByRole("button", { name: "Open Settings", exact: true }).click();
    const name = page.getByRole("textbox", { name: "Pediatrician name", exact: true });
    assert.equal(await name.inputValue(), "Example Pediatrics");
    await name.fill("New Synthetic Pediatrics");
    await page.evaluate(() => window.__navigationData.failNext());
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Synthetic save failed. Try again." }).waitFor();
    assert.equal(await name.inputValue(), "New Synthetic Pediatrics");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    const calls = await page.evaluate(() => window.__navigationData.calls());
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.settings.pediatrician_name, "New Synthetic Pediatrics");
    assert.equal(await page.getByRole("button", { name: "Save changes", exact: true }).count(), 0);
    await page.goto(`${url}?viewer#family/baby`);
    await page.getByText("Example Pediatrics", { exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox").count(), 0);
  });
  assert.deepEqual(errors, [], "No browser errors");
  assert.deepEqual(failures, [], "All chat navigation regressions pass");
} finally { await browser.close(); await rm(output, { recursive: true, force: true }); }
