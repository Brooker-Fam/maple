import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const output = await mkdtemp(path.join(tmpdir(), "maple-settings-ui-"));
await build({ entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true, format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env.NODE_ENV": '"test"' }, plugins: [{ name: "synthetic-settings-boundaries", setup(plugin) {
  plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav|AppNav|sheets|notify)$/ }, () => ({ path: path.join(here, "mocks.jsx") }));
} }] });
const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
const errors = []; page.on("pageerror", e => errors.push(e.message));
const origin = "https://maple-settings.example.test";
await page.route("**/*", async route => {
  const url = new URL(route.request().url()); assert.equal(url.origin, origin, "Synthetic checks never contact outside services");
  return route.fulfill({ status: 200, contentType: url.pathname === "/app.js" ? "text/javascript" : "text/html", body: url.pathname === "/app.js" ? await readFile(path.join(output, "app.js")) : '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>' });
});
const snapshot = () => page.evaluate(() => window.__settingsFixture.snapshot());
const scenario = config => page.evaluate(value => window.__settingsFixture.scenario(value), config);
const resolve = success => page.evaluate(value => window.__settingsFixture.resolve(value), success);
const family = { v: 1, scope: "family", babyId: 99, key: "track_pump", label: "Pumping", previous: true, value: false, status: "proposed" };
const phone = { v: 1, scope: "phone", key: "units", label: "Units", previous: null, value: "metric", status: "proposed" };
try {
  await page.goto(origin); await page.waitForFunction(() => !!window.__settingsFixture);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByText("Saving…", { exact: true }).waitFor(); assert(await page.getByRole("button", { name: "Apply", exact: true }).isDisabled());
  assert.deepEqual((await snapshot()).calls.at(-1).body, { threadId: "synthetic-thread", messageId: "synthetic-message", toolCallId: "synthetic-tool", action: "apply" }, "Family action sends only its stored proposal identity");
  await resolve(true); await page.getByText("Saved: Off", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Undo", exact: true }).click(); await resolve(true); await page.getByText("Restored: On", { exact: true }).waitFor();
  console.log("PASS settings: family Apply waits for server, durable receipt, Undo");

  await scenario({ kind: "setting", setting: phone });
  await page.getByText("Current: lb · oz · °F", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Apply", exact: true }).click(); assert.equal((await snapshot()).units, "metric");
  await resolve(false); await page.getByText("Changed on this phone: kg · ml · °C", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  assert.equal((await snapshot()).calls.filter(c => c.kind === "units").length, 1, "Retry acknowledges the original local change without applying again");
  assert.equal((await snapshot()).calls.at(-1).body.phonePrevious, "us");
  await resolve(true); await page.getByText("Saved: kg · ml · °C", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Undo", exact: true }).click(); assert.equal((await snapshot()).units, "us");
  await resolve(true); await page.getByText("Restored: lb · oz · °F", { exact: true }).waitFor();
  console.log("PASS settings: actual phone provider, failed acknowledgment preserved, retry and Undo");

  await scenario({ kind: "setting", setting: { ...phone, key: "night", label: "Night look", value: "always" } });
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem("maple-night")), "always");
  await resolve(true); await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem("maple-night")), null); await resolve(true);
  await scenario({ kind: "setting", setting: { ...phone, key: "theme", label: "Theme", value: "dark" } });
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  assert(await page.evaluate(() => document.documentElement.classList.contains("dark")));
  await resolve(true); await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert(!(await page.evaluate(() => document.documentElement.classList.contains("dark")))); await resolve(true);
  console.log("PASS settings: real night preference storage and theme application, including Undo");

  await scenario({ kind: "setting", setting: { ...phone, phoneDevice: "different-phone" } });
  assert.equal(await page.getByRole("button", { name: "Apply", exact: true }).count(), 0);
  await scenario({ kind: "setting", setting: family, viewer: true });
  assert.equal(await page.getByRole("button", { name: "Apply", exact: true }).count(), 0);
  await scenario({ kind: "setting", setting: family, busy: true }); assert(await page.getByRole("button", { name: "Apply", exact: true }).isDisabled());
  await scenario({ kind: "setting", setting: family, online: false }); assert(await page.getByRole("button", { name: "Apply", exact: true }).isDisabled());
  await scenario({ kind: "setting", setting: family, baby: { id: 99, name: "River", nickname: null, settings: { track_pump: false } } });
  await page.getByRole("button", { name: "Open Family", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Apply", exact: true }).count(), 0);
  await scenario({ kind: "setting", setting: family, baby: { id: 100, name: "River", nickname: null, settings: { track_pump: true } } });
  await page.getByRole("button", { name: "Open Family", exact: true }).waitFor();
  await scenario({ kind: "setting", setting: { ...phone, status: "applied", previous: "us" } });
  await page.getByText("Changed again since this card. Your current choice is lb · oz · °F.", { exact: true }).waitFor();
  assert(await page.getByRole("button", { name: "Undo", exact: true }).isDisabled());
  console.log("PASS settings: different phone, viewer, busy/offline and changed-preference guards");

  for (const [destination, expected] of [["notifications", "notifications"], ["doctor_questions", "doctor"], ["add_photo", "sheet"]]) {
    await scenario({ kind: "navigation", destination }); await page.getByRole("button").click(); assert.equal((await snapshot()).calls.at(-1).kind, expected);
  }
  for (const [destination, target] of [["baby_profile", "baby-details"], ["pediatrician", "doctor-contacts"], ["phone_preferences", "phone-preferences"], ["mom_medicines", "mom-medicines"]]) {
    await scenario({ kind: "navigation", destination }); await page.getByRole("button").click();
    await page.waitForFunction(id => document.activeElement?.id === id, target);
    assert.equal((await snapshot()).focused, target, "Navigation focuses its exact destination section");
  }
  await scenario({ kind: "navigation", destination: "add_photo", viewer: true }); assert(await page.getByRole("button").isDisabled());
  await scenario({ kind: "navigation", destination: "mom_medicines", care: false }); assert(await page.getByRole("button").isDisabled());
  assert.deepEqual(errors, []); console.log("PASS navigation: existing sheets, exact section focus, viewer/care restrictions");
} finally { await browser.close(); await rm(output, { recursive: true, force: true }); }
