import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require(require.resolve("esbuild", { paths: [require.resolve("tsx")] }));
const { chromium } = require("playwright");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "maple-settings-ui-"));
const baseline = process.env.MAPLE_SETTINGS_BASELINE === "1";
const scenario = process.env.MAPLE_SETTINGS_SCENARIO ?? "settings";
const mocks = path.join(root, "scripts/ui-review-settings-mocks.jsx");
await build({
  entryPoints: [path.join(root, "scripts/ui-review-settings-fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
  plugins: [{ name: "synthetic-settings-boundaries", setup(plugin) {
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav|useTimerActions|sheets|notify)$/ }, () => ({ path: mocks }));
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => args.importer.endsWith("/sheets/parts.tsx") ? { path: mocks } : undefined);
    if (baseline) plugin.onLoad({ filter: /\/lib\/maple\/onboarding\/steps\.ts$/ }, (args) => ({ contents: execFileSync("git", ["show", `HEAD:${path.relative(root, args.path)}`], { cwd: root, encoding: "utf8" }), loader: "ts" }));
    if (baseline) plugin.onLoad({ filter: /\/(?:FamilyTab|BirthSheet|SignInMethods|BasicSteps|MoreSteps|Onboarding|StepShell)\.tsx$/ }, (args) => ({ contents: execFileSync("git", ["show", `HEAD:${path.relative(root, args.path)}`], { cwd: root, encoding: "utf8" }), loader: "tsx" }));
  } }],
});
const compiled = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, "src/app/globals.css"), "utf8"), { from: path.join(root, "src/app/globals.css") });
await writeFile(path.join(output, "app.css"), compiled.css + "\n" + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
await writeFile(path.join(output, "index.html"), '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
page.setDefaultTimeout(4000);
await page.addInitScript(() => localStorage.setItem("maple-onboarding-mode:99", "form"));
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", async (route) => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname.startsWith("/api/")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apple: false, email: false, methods: [] }) });
  const file = ["/app.js", "/app.css"].includes(pathname) ? pathname.slice(1) : "index.html";
  await route.fulfill({ status: 200, contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html", body: await readFile(path.join(output, file)) });
});
const snapshot = () => page.evaluate(() => window.__settingsFixture.snapshot());
const index = () => page.getByRole("heading", { level: 1, name: "Settings", exact: true }).waitFor();
const open = async (name) => { await page.getByRole("button", { name: new RegExp(`^${name}`) }).click(); await page.getByRole("heading", { level: 1, name, exact: true }).waitFor(); };
try {
  if (scenario === "onboarding") await page.clock.setFixedTime(new Date("2026-10-27T23:00:00Z"));
  await page.goto(`https://maple-settings.example.test/${["birth", "onboarding", "draft"].includes(scenario) ? `?view=${scenario}` : ""}#family`);
  await page.waitForFunction(() => !!window.__settingsFixture);
  if (scenario === "draft") {
    const name = page.getByLabel("Baby's name", { exact: true });
    await name.fill("River draft");
    await page.getByText("Your saved answers", { exact: true }).click();
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "Edit you", exact: true }).click();
    assert.equal(await name.inputValue(), "River draft", "Canceling earlier-answer navigation keeps the pending answer");
    assert.equal(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true, "Changed onboarding fields guard reload");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Edit you", exact: true }).click();
    await page.getByLabel("Your first name", { exact: true }).fill("Juniper draft");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "Back", exact: true }).click();
    assert.equal(await page.getByLabel("Your first name", { exact: true }).inputValue(), "Juniper draft", "Canceling Back keeps the edited saved answer");
    await page.getByLabel("Your first name", { exact: true }).fill("Juniper");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    assert.equal(await name.inputValue(), "");
    assert.equal(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), false, "An untouched answer does not guard reload");
    console.log("PASS onboarding drafts: earlier-answer and Back cancellation preserve fields, reload guard follows unsaved changes");
  } else if (scenario === "onboarding") {
    await page.getByRole("button", { name: "The baby is here", exact: true }).click();
    const birthDate = page.getByLabel("Birth date", { exact: true });
    assert.equal(await birthDate.getAttribute("max"), "2026-10-28", "Birth-date limit follows the family timezone");
    await birthDate.fill("2026-10-28");
    await page.getByLabel("I'm not sure of the time").check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal((await snapshot()).calls.filter((call) => call.method === "ANSWER").length, 1, "Setup accepts an unknown time before noon");
    await page.getByText(/Can log also gives access to the recovery page/).waitFor();
    console.log("PASS onboarding UI: family-timezone date limit, unknown morning birth, role disclosure");
  } else if (scenario === "birth") {
    const dialog = page.getByRole("dialog", { name: "Birth details" });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.evaluate(() => window.__settingsFixture.openBirth());
    await dialog.waitFor();
    assert(await dialog.getByLabel("Birth time not known").isChecked(), "Editing an unknown time preserves uncertainty");
    assert.equal(await dialog.getByLabel("Birth date", { exact: true }).inputValue(), "2026-10-28");
    await dialog.getByLabel("Birth time not known").uncheck();
    assert(await dialog.getByRole("button", { name: "Save", exact: true }).isDisabled(), "An unknown time cannot become an exact time without choosing one");
    await dialog.getByRole("button", { name: "Pick a time", exact: true }).click();
    await dialog.getByLabel("Born: exact time: date", { exact: true }).fill("2026-10-27");
    await dialog.getByLabel("Born: exact time: time", { exact: true }).fill("11:00");
    await dialog.getByLabel("Birth time not known").check();
    assert.equal(await dialog.getByLabel("Birth date", { exact: true }).inputValue(), "2026-10-27", "Switching to an unknown time preserves the selected birth day");
    await dialog.getByLabel("Birth date", { exact: true }).fill("2026-10-29");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    assert.equal(await dialog.getByLabel("Birth date", { exact: true }).inputValue(), "2026-10-29");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    assert.equal((await snapshot()).calls.filter((call) => call.method === "PATCH").length, 0, "Future birth date does not save");
    await dialog.getByLabel("Birth date", { exact: true }).fill("2026-10-28");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal((await snapshot()).state.baby.settings.birth_time_approx, true);
    assert.equal((await snapshot()).state.baby.born_at, "2026-10-28T04:00:00.000Z");
    await page.evaluate(() => window.__settingsFixture.openBirth());
    await dialog.getByLabel("Birth time not known").uncheck();
    await dialog.getByRole("button", { name: "Now", exact: true }).click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal((await snapshot()).state.baby.settings.birth_time_approx, undefined);
    assert.equal((await snapshot()).state.baby.born_at, "2026-10-28T13:00:00.000Z");
    console.log("PASS birth UI: unknown time preserved, future date blocked, dirty draft retained, date-only and exact corrections saved");
  } else if (scenario === "signout-error") {
    if (await page.getByRole("heading", { name: "Settings", level: 1, exact: true }).count()) await open("Sign-in & account");
    await page.evaluate(() => window.__settingsFixture.failNext());
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Couldn't confirm sign-out. Try again." }).waitFor();
    assert(await page.getByRole("button", { name: "Sign out", exact: true }).isEnabled());
    console.log("PASS account UI: sign-out failure is visible and retry is available");
  } else if (scenario === "guest") {
    await page.evaluate(() => window.__settingsFixture.asGuest());
    if (await page.getByRole("heading", { name: "Settings", level: 1, exact: true }).count()) await open("Sign-in & account");
    await page.getByText("Signed in with a one-time invite link", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("button", { name: "Stay signed in", exact: true }).waitFor();
    assert.equal((await snapshot()).calls.filter((call) => call.url.includes("signout")).length, 0, "Guest sign-out waits for the recovery warning");
    await page.getByRole("button", { name: "Stay signed in", exact: true }).click();
    assert.equal((await snapshot()).calls.filter((call) => call.url.includes("signout")).length, 0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await index();
    assert.equal(await page.getByRole("button", { name: /^On Today/ }).count(), 0, "Viewers do not get editing settings");
    console.log("PASS guest UI: access recovery, sign-out confirmation, viewer settings visibility");
  } else {
    await index();
    assert.equal(await page.getByLabel("Name", { exact: true }).count(), 0, "The index does not expose profile editors");
    await open("Baby details");
    await page.getByText(/Born today, time not recorded/).waitFor();
    await page.getByLabel("Name", { exact: true }).fill("River Draft");
    await page.getByRole("button", { name: "Save changes", exact: true }).waitFor();
    page.once("dialog", (dialog) => dialog.dismiss());
    assert.equal(await page.evaluate(() => window.dispatchEvent(new CustomEvent("maple-before-navigate", { cancelable: true, detail: { tab: "today" } }))), false, "Canceling navigation preserves settings drafts");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await index();
    await open("Baby details");
    assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "River Draft", "Returning from the index preserves the draft");
    await page.evaluate(() => window.__settingsFixture.failNext());
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Synthetic save failed" }).waitFor();
    assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "River Draft", "A failed save preserves entered details");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    assert.equal((await snapshot()).state.baby.name, "River Draft");
    await page.goBack();
    await index();
    await open("People & permissions");
    await page.getByText(/Can log also gives access to the recovery page/).waitFor();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await open("Sign-in & account");
    await page.getByRole("link", { name: /Download River's log/ }).waitFor();
    await page.getByText(/Photo files, recovery records and chat are not included/).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Settings fit a phone viewport");
    console.log("PASS settings UI: focused navigation, draft retention, save retry, browser Back, role disclosure, export scope");
  }
  assert.deepEqual(errors, [], "No browser runtime errors");
} catch (error) {
  if (errors.length) console.error(errors);
  throw error;
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
