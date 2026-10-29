import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = await mkdtemp(path.join(tmpdir(), "maple-siri-ui-"));
const baseline = process.argv.includes("--baseline");
const scenario = process.argv.find((value) => ["setup", "retry", "revoke", "returning"].includes(value)) ?? "setup";
const mocks = path.join(root, "scripts/ui-review-settings-mocks.jsx");
await build({
  entryPoints: [path.join(root, "scripts/shortcuts/ui-fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
  plugins: [{ name: "synthetic-siri", setup(plugin) {
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare)$/ }, () => ({ path: mocks }));
    if (baseline) plugin.onLoad({ filter: /\/settings\/AssistantSettings\.tsx$/ }, () => ({
      contents: execFileSync("git", ["show", "cfbb846:src/components/maple/settings/AssistantSettings.tsx"], { cwd: root, encoding: "utf8" }), loader: "tsx",
    }));
  } }],
});
await writeFile(path.join(output, "index.html"), '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
const shots = process.env.MAPLE_SIRI_SHOTS;
if (shots) {
  await mkdir(shots, { recursive: true });
  const postcss = require(require.resolve("postcss", { paths: [require.resolve("@tailwindcss/postcss")] }));
  const tailwind = require("@tailwindcss/postcss");
  const css = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, "src/app/globals.css"), "utf8"), { from: path.join(root, "src/app/globals.css") });
  await writeFile(path.join(output, "app.css"), css.css + "\n" + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
}
const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.setDefaultTimeout(1500);
await page.route("**/*", async (route) => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === "/app.css") return route.fulfill({ status: 200, contentType: "text/css", body: await readFile(path.join(output, "app.css")) });
  const script = pathname === "/app.js";
  await route.fulfill({ status: 200, contentType: script ? "text/javascript" : "text/html", body: await readFile(path.join(output, script ? "app.js" : "index.html")) });
});
try {
  await page.goto(`https://maplebaby.app/${scenario === "retry" ? "?fail=1" : scenario === "returning" ? "?existing=1" : ""}`);
  if (shots) {
    await page.addStyleTag({ url: "/app.css" });
    if (scenario === "setup") await page.getByRole("button", { name: "Set up Siri", exact: true }).waitFor({ state: "visible" });
    await page.screenshot({ path: path.join(shots, "siri-start.png"), fullPage: true });
  }
  if (scenario === "returning") {
    await page.getByRole("button", { name: "Make a new key", exact: true }).waitFor();
    await page.getByRole("link", { name: "Download Maple status", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Set up Siri", exact: true }).count(), 0);
    assert.equal((await page.evaluate(() => window.__siriFixture.calls())).filter((call) => call.method === "POST").length, 0);
    await page.getByText(/Haven.t installed one yet, or lost the key/).waitFor();
    assert.equal(await page.getByLabel("Name this key").inputValue(), "My iPhone 2", "A removed key does not cause duplicate default names");
    await page.getByLabel("Name this key").fill("Synthetic second phone");
    await page.getByRole("button", { name: "Make a new key", exact: true }).click();
    assert.equal((await page.evaluate(() => window.__siriFixture.calls())).find((call) => call.method === "POST").body.label, "Synthetic second phone");
    console.log("PASS: returning users can reuse a key or create a clearly named replacement");
  } else if (scenario === "retry") {
    await page.getByRole("alert").getByText("Your Siri keys couldn't load. Try again.").waitFor();
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.getByRole("button", { name: "Set up Siri", exact: true }).click();
    await page.getByRole("button", { name: "Copy key", exact: true }).waitFor();
    console.log("PASS: loading failures offer retry and recover setup");
  } else if (scenario === "revoke") {
    await page.getByRole("button", { name: baseline ? "Make a key" : "Set up Siri", exact: true }).click();
    if (!baseline) await page.getByRole("button", { name: /^Your Siri keys/ }).click();
    await page.getByRole("button", { name: baseline ? "Revoke" : "Remove My iPhone key", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Copy key", exact: true }).count(), 0, "A revoked one-time key is no longer offered for setup");
    console.log("PASS: revoking the new key removes it from setup");
  } else {
    await page.getByRole("button", { name: "Set up Siri", exact: true }).click();
    await page.getByRole("button", { name: "Copy key", exact: true }).waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "siri-setup.png"), fullPage: true });
    const download = page.getByRole("link", { name: "Download Maple status", exact: true });
    assert.equal(await download.getAttribute("href"), "/shortcuts/maple-status.shortcut");
    assert.equal(await page.getByText("Get Contents of URL", { exact: true }).count(), 0, "Manual actions stay out of the primary flow");
    assert.equal((await page.evaluate(() => window.__siriFixture.calls())).filter((call) => call.method === "POST").length, 1);
    await page.getByRole("button", { name: /^More Siri commands/ }).click();
    assert.equal(await page.getByRole("link", { name: /Maple pee/ }).getAttribute("href"), "/shortcuts/maple-pee.shortcut");
    assert.equal(await page.getByText("maple_synthetic_ui_check", { exact: true }).isVisible(), false, "The key is hidden until requested");
    console.log("PASS: setup creates one key, offers a safe installable starter, and hides manual configuration");
  }
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
