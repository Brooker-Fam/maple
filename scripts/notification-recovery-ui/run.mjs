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
async function scenario(name, run, path = "/") {
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
    await page.goto(`https://notifications.example.test${path}`);
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
  // Quiet during my protected sleep: only for an adult on a night roster, with their own window's times; a per-phone pref, on unless turned off.
  const extraShots = process.env.MAPLE_NOTIFY_SHOTS;
  if (extraShots) await mkdir(extraShots, { recursive: true });
  await scenario("quiet-window-switch", async page => {
    // The time range is kept on one line (a no-break space in each clock, a word joiner after the dash).
    const quiet = page.getByRole("switch", { name: /^Quiet during my protected sleep \(10\sPM–⁠?2\sAM\)$/ });
    await quiet.waitFor();
    assert.equal(await quiet.getAttribute("aria-checked"), "true", "Unset is on");
    // No medicines on this phone (no care page here): only what happens to nursing updates and a handoff, and the note kept.
    await page.getByText("Nursing updates in it never come later; a handoff to you still comes through. Maple keeps a note of what it held for 3 days.", { exact: true }).waitFor();
    if (extraShots) {
      for (const [width, height] of [[390, 844], [320, 568]]) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(150);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No sideways scroll at ${width}px`);
        await page.screenshot({ path: path.join(extraShots, `notifications-quiet-${width}x${height}.png`) });
      }
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await quiet.click();
    await page.waitForFunction(() => !window.notificationFixture.current.busy);
    assert.equal(await page.evaluate(() => window.notificationFixture.prefs.quiet_window), false, "Saved as this phone's pref");
    assert.equal(await page.evaluate(() => window.notificationFixture.prefs.nursing), true, "The other prefs are kept");
    assert.equal(await quiet.getAttribute("aria-checked"), "false");
    // Phone settings that help: the Focus you sleep with, Scheduled Summary and repeated calls.
    await page.getByRole("button", { name: "Phone settings that help" }).click();
    for (const text of ["Let Maple through the Focus you sleep with", "Keep Maple out of Scheduled Summary, or a handoff would wait", "Allow repeated calls, so a second call from the same person within 3 minutes rings through"]) {
      await page.getByText(text, { exact: false }).waitFor();
    }
    if (extraShots) {
      for (const [width, height] of [[390, 844], [320, 568]]) {
        await page.setViewportSize({ width, height });
        await page.getByText("Allow repeated calls", { exact: false }).scrollIntoViewIfNeeded();
        await page.waitForTimeout(150);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No sideways scroll at ${width}px`);
        await page.screenshot({ path: path.join(extraShots, `notifications-phone-settings-${width}x${height}.png`) });
      }
    }
  }, "/?roster");
  // What waits and what never comes later, as each phone reads it: a partner's (her reminders wait for the window's end) and
  // her own (nothing about her medicines is held on it).
  await scenario("quiet-window-note-partner", async page => {
    await page.getByRole("switch", { name: /^Quiet during my protected sleep/ }).waitFor();
    await page.getByText("Medicine reminders wait until it ends, if still due. “Logged” comes only to update a medicine notice already on this phone, and nursing updates never come later. A handoff to you still comes through. Maple keeps a note of what it held for 3 days.", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "Dana's medicines" }).waitFor();
    if (extraShots) {
      for (const [width, height] of [[390, 844], [320, 568]]) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(150);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No sideways scroll at ${width}px`);
        await page.screenshot({ path: path.join(extraShots, `notifications-quiet-partner-${width}x${height}.png`) });
      }
    }
  }, "/?roster&care=partner");
  await scenario("quiet-window-note-self", async page => {
    await page.getByRole("switch", { name: /^Quiet during my protected sleep/ }).waitFor();
    await page.getByText("Nursing updates in it never come later. Your own medicine reminders, “Logged” and a handoff to you still come through. Maple keeps a note of what it held for 3 days.", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "Your medicines" }).waitFor();
  }, "/?roster&care=self");
  await scenario("quiet-window-hidden-off-roster", async page => {
    await page.getByRole("switch", { name: "Nursing timer on the lock screen", exact: true }).waitFor();
    assert.equal(await page.getByRole("switch", { name: /^Quiet during my protected sleep/ }).count(), 0, "Not on a roster: no switch");
  });
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
