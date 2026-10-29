import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(path.join(root, "package.json"));
const { build } = require("esbuild");
const browsers = require("playwright");
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const output = await mkdtemp(path.join(tmpdir(), "maple-notifications-"));
const browserName = process.env.MAPLE_UI_BROWSER || "chromium";
const shots = path.join(root, "test-results/maple-notification-recovery", browserName);
await mkdir(shots, { recursive: true });
await build({
  entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", absWorkingDir: root, nodePaths: [path.join(root, "node_modules")],
  define: { "process.env.NODE_ENV": '"test"' },
  plugins: [{ name: "synthetic-boundaries", setup(plugin) {
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|phone)$/ }, () => ({ path: path.join(here, "mocks.jsx") }));
  } }],
});
const cssPath = path.join(root, "src/app/globals.css");
const css = await postcss([require("@tailwindcss/postcss")({ base: root })]).process(await readFile(cssPath, "utf8"), { from: cssPath });
const assets = {
  "/app.js": await readFile(path.join(output, "app.js")),
  "/app.css": css.css + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"),
};
const browser = await browsers[browserName].launch({ headless: true });
let failed = 0;
async function scenario(name, run) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(5000);
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, "https://notifications.example.test");
    return route.fulfill({
      contentType: url.pathname.endsWith(".js") ? "text/javascript" : url.pathname.endsWith(".css") ? "text/css" : "text/html",
      body: assets[url.pathname] ?? '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
    });
  });
  try {
    await page.goto("https://notifications.example.test/");
    await page.getByRole("button", { name: "Open notifications" }).click();
    await page.waitForFunction(() => window.notificationFixture.current.status === "on");
    await run(page);
    assert.deepEqual(errors, []);
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.message}`);
    await page.screenshot({ path: path.join(shots, `${name}.png`) });
  } finally { await page.close(); }
}

try {
  await scenario("failed-unsubscribe-recovery", async page => {
    const toggle = page.getByRole("switch", { name: "Notifications on this phone", exact: true });
    for (const result of ["reject", false]) {
      await page.evaluate(value => { window.notificationFixture.unsubscribeResult = value; }, result);
      await toggle.click();
      await page.waitForFunction(() => !window.notificationFixture.current.busy);
      const observed = await page.evaluate(() => ({ status: window.notificationFixture.current.status, problem: window.notificationFixture.current.problem, mark: window.notificationFixture.mark }));
      assert.equal(observed.status, "on", "Both failed removal operations must not display Off");
      assert.ok(observed.problem, "An unsuccessful turn-off needs visible retry guidance");
      assert.ok(observed.mark, "Keep the known active subscription until removal succeeds");
    }
    await page.evaluate(() => { window.notificationFixture.unsubscribeResult = true; });
    await toggle.click();
    await page.waitForFunction(() => !window.notificationFixture.current.busy);
    assert.equal(await page.evaluate(() => window.notificationFixture.current.status), "off");
    assert.equal(await page.evaluate(() => window.notificationFixture.current.problem), null);
  });
  await scenario("signout-retains-failed-subscription", async page => {
    await page.getByRole("button", { name: "Close", exact: true }).click();
    for (const result of ["reject", false]) {
      await page.evaluate(value => { window.notificationFixture.unsubscribeResult = value; }, result);
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
      const observed = await page.evaluate(() => ({
        status: window.notificationFixture.current.status,
        problem: window.notificationFixture.current.problem,
        mark: window.notificationFixture.mark,
        signouts: window.notificationFixture.signouts,
        toasts: window.notificationFixture.toasts,
      }));
      assert.equal(observed.status, "on", "Failed cleanup must not display Off");
      assert.ok(observed.mark, "Failed cleanup must retain the endpoint for retry");
      assert.ok(observed.problem, "Failed cleanup needs retry guidance");
      assert.equal(observed.signouts, 0, "Keep the session until notifications can be stopped");
      assert.match(observed.toasts.at(-1), /Try signing out again/, "A failed sign-out needs visible retry guidance");
    }
    await page.evaluate(() => { window.notificationFixture.unsubscribeResult = true; });
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.waitForFunction(() => window.notificationFixture.signouts === 1);
    assert.equal(await page.evaluate(() => window.notificationFixture.current.status), "off");
    assert.equal(await page.evaluate(() => window.notificationFixture.current.problem), null);
  });
  await scenario("saved-preference-survives-stale-refresh", async page => {
    for (const holdSave of [false, true]) {
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.evaluate(hold => { window.notificationFixture.holdRead = true; window.notificationFixture.holdSave = hold; }, holdSave);
      await page.getByRole("button", { name: "Open notifications" }).click();
      await page.waitForFunction(() => window.notificationFixture.reads.length > 0);
      const toggle = page.getByRole("switch", { name: "Nursing timer on the lock screen", exact: true });
      const expected = (await toggle.getAttribute("aria-checked")) !== "true";
      await toggle.click();
      if (holdSave) await page.waitForFunction(() => window.notificationFixture.saves.length > 0);
      else await page.waitForFunction(() => !window.notificationFixture.current.busy);
      await page.evaluate(() => { window.notificationFixture.holdRead = false; window.notificationFixture.reads.splice(0).forEach(resolve => resolve()); });
      await page.waitForTimeout(80);
      assert.equal(await toggle.getAttribute("aria-checked"), String(expected), "A refresh must not replace the user's newer preference");
      if (holdSave) await page.evaluate(() => { window.notificationFixture.saves.splice(0).forEach(resolve => resolve()); });
      await page.waitForFunction(() => !window.notificationFixture.current.busy);
      assert.equal(await page.evaluate(() => window.notificationFixture.prefs.nursing), expected);
    }
  });
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
