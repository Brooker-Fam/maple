import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium, webkit } = require("playwright");
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const tailwind = require("@tailwindcss/postcss");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const output = await mkdtemp(path.join(tmpdir(), "maple-onboarding-recovery-"));
await build({
  entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"),
  bundle: true, format: "esm", jsx: "automatic", absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
  plugins: [{ name: "synthetic-boundaries", setup(plugin) {
    const mocks = { path: path.join(here, "mocks.jsx") };
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav|useTimerActions|sheets|notify)$/ }, () => mocks);
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => args.importer.endsWith("/sheets/parts.tsx") ? mocks : undefined);
  } }],
});
const cssPath = path.join(root, "src/app/globals.css");
const compiled = await postcss([tailwind({ base: root })]).process(await readFile(cssPath, "utf8"), { from: cssPath });
const css = compiled.css + "\n" + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8");
const javascript = await readFile(path.join(output, "app.js"));
const html = '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
const browserName = process.env.MAPLE_UI_BROWSER === "webkit" ? "webkit" : "chromium";
const browser = await ({ chromium, webkit })[browserName].launch({ headless: true });
const origin = "https://onboarding-recovery.example.test";
const results = [];
const errors = [];

async function fixture(handler, view) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(5000);
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("maple-onboarding-mode:99", "form"));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin, "Synthetic checks never contact outside services");
    if (url.pathname.startsWith("/api/")) {
      if (await handler?.(route, url)) return;
      const value = url.pathname === "/api/maple/chat/consent"
        ? { terms: true, care: false, self: false }
        : { invites: [], tokens: [], entries: [], apple: false, email: false, methods: [] };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    }
    return route.fulfill({
      status: 200,
      contentType: url.pathname === "/app.js" ? "text/javascript" : url.pathname === "/app.css" ? "text/css" : "text/html",
      body: url.pathname === "/app.js" ? javascript : url.pathname === "/app.css" ? css : html,
    });
  });
  await page.goto(`${origin}/${view ? `?view=${view}` : "#family"}`);
  await page.waitForFunction(() => window.__settingsFixture);
  return page;
}

const open = async (page, name) => {
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await page.getByRole("heading", { name, level: 1, exact: true }).waitFor();
};
const snapshot = (page) => page.evaluate(() => window.__settingsFixture.snapshot());
const pendingPatch = (page, count = 1) => page.waitForFunction(n => window.__settingsFixture.snapshot().calls.filter(x => x.method === "PATCH").length >= n, count);
const capture = async (page, name) => {
  if (!process.env.MAPLE_UI_SCREENSHOTS) return;
  await mkdir(process.env.MAPLE_UI_SCREENSHOTS, { recursive: true });
  await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="dialog"] > [tabindex="-1"]')).every(panel => getComputedStyle(panel).opacity === "1"));
  await page.screenshot({ path: path.join(process.env.MAPLE_UI_SCREENSHOTS, `${browserName}-${name}.png`), fullPage: true });
};

async function check(name, run) {
  if (process.env.MAPLE_UI_CASE && !name.includes(process.env.MAPLE_UI_CASE)) return;
  try {
    await run();
    results.push({ name, passed: true });
    console.log(`PASS ${browserName}: ${name}`);
  } catch (error) {
    results.push({ name, passed: false });
    console.error(`FAIL ${browserName}: ${name}\n${error.stack}`);
  } finally {
    for (const context of browser.contexts()) await context.close();
  }
}

try {
  await check("setup sign-out failure is visible while waiting", async () => {
    const page = await fixture(async (route, url) => {
      if (url.pathname !== "/api/maple/auth/signout") return false;
      await route.fulfill({ status: 503, json: { error: "Synthetic sign-out failure" } });
      return true;
    }, "waiting");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByText("Couldn't confirm sign-out. Try again.", { exact: true }).waitFor();
    assert(await page.getByRole("button", { name: "Sign out", exact: true }).isEnabled());
  });

  await check("setup sign-out warns an invited member before losing access", async () => {
    const page = await fixture(undefined, "invite-waiting");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Sign out?", exact: true });
    await confirmation.waitFor();
    assert.equal((await snapshot(page)).calls.filter(call => call.url === "/api/maple/auth/signout").length, 0);
    await confirmation.getByRole("button", { name: "Stay signed in", exact: true }).click();
    await confirmation.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await confirmation.getByRole("button", { name: "Sign out anyway", exact: true }).click();
    await page.waitForFunction(() => window.__settingsFixture.snapshot().calls.some(call => call.url === "/api/maple/auth/signout"));
  });

  for (const view of ["draft", "waiting"]) {
    await check(`setup sign-out is available from ${view}`, async () => {
      const page = await fixture(undefined, view);
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await page.waitForFunction(() => window.__settingsFixture.snapshot().calls.some(call => call.url === "/api/maple/auth/signout"));
      assert.equal((await snapshot(page)).calls.filter(call => call.url === "/api/maple/auth/signout").length, 1);
    });
  }

  await check("setup sign-out protects an unsent chat draft", async () => {
    const page = await fixture(undefined, "draft");
    await page.getByRole("radio", { name: "Questions and chat", exact: true }).click();
    const draft = "Synthetic unsent setup answer";
    await page.getByRole("textbox", { name: "Message", exact: true }).fill(draft);
    page.once("dialog", dialog => dialog.dismiss());
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    assert.equal((await snapshot(page)).calls.filter(call => call.url === "/api/maple/auth/signout").length, 0);
    assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), draft);
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.waitForFunction(() => window.__settingsFixture.snapshot().calls.some(call => call.url === "/api/maple/auth/signout"));
  });

  await check("invite list failure has a working retry", async () => {
    let reads = 0;
    const page = await fixture(async (route, url) => {
      if (url.pathname !== "/api/maple/invites") return false;
      reads++;
      const failed = reads === 1;
      await route.fulfill({ status: failed ? 503 : 200, contentType: "application/json", body: JSON.stringify(failed
        ? { error: "Synthetic invite list unavailable" }
        : { invites: [{ id: 41, display_name: "Pending Helper", role: "viewer", expires_at: "2026-11-02T12:00:00Z", used_at: null }] }) });
      return true;
    });
    await open(page, "People & permissions");
    await page.getByRole("alert").filter({ hasText: /invite/i }).waitFor();
    await page.getByRole("button", { name: /Retry|Try again/ }).click();
    await page.getByText("Pending Helper", { exact: true }).waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal(reads, 2);
  });

  for (const [section, label, field] of [["Baby details", "Name", "name"], ["Doctor & care plan", "Pediatrician name", "pediatrician_name"]]) {
    await check(`${section} preserves edits typed during save`, async () => {
      let release;
      let submitted;
      const page = await fixture(async (route, url) => {
        if (url.pathname !== "/api/maple/baby" || route.request().method() !== "PATCH") return false;
        submitted = route.request().postDataJSON();
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        return true;
      });
      await open(page, section);
      await page.getByLabel(label, { exact: true }).fill("First saved value");
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await pendingPatch(page);
      await page.getByLabel(label, { exact: true }).fill("Newer unsaved value");
      release();
      await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
      assert.equal((submitted.settings ?? submitted)[field], "First saved value");
      assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), "Newer unsaved value");
      assert(await page.getByRole("button", { name: "Save changes", exact: true }).isEnabled());
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await pendingPatch(page, 2);
      release();
      await page.getByRole("button", { name: "Save changes", exact: true }).waitFor({ state: "detached" });
      assert.equal((submitted.settings ?? submitted)[field], "Newer unsaved value");
      assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), "Newer unsaved value");
    });
  }

  await check("invite result keeps its submitted recipient and granted role", async () => {
    for (const [role, label, description] of [
      ["photos", "Photos only", "See shared moments, photos and captions. Save or share photos. No baby log, recovery page or chat."],
      ["viewer", "View baby log", "See moments and the baby's daily log. Read through chat. No recovery page or changes."],
      ["member", "Can log", "Add and edit the baby log and moments. Also see and add to the recovery page, including medicines, food and check-ins."],
    ]) {
      let release;
      let submitted;
      const page = await fixture(async (route, url) => {
        if (url.pathname !== "/api/maple/invites" || route.request().method() !== "POST") return false;
        submitted = route.request().postDataJSON();
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ url: `${origin}/maple/join#synthetic-only` }) });
        return true;
      });
      await open(page, "People & permissions");
      await page.getByRole("button", { name: /^Invite with a one-time link/ }).click();
      const dialog = page.getByRole("dialog", { name: "Invite with a link" });
      const choices = dialog.getByRole("group", { name: "What they can access", exact: true });
      assert.equal(await choices.getByRole("radio").count(), 3);
      assert(await choices.getByRole("radio", { name: /^Photos only / }).isChecked(), "New invitations begin with photos-only access");
      await dialog.getByLabel("Their name", { exact: true }).fill("Helper One");
      const choice = choices.getByRole("radio", { name: new RegExp(`^${label} `) });
      if (role !== "photos") await choice.click();
      assert(await choice.isChecked());
      await dialog.getByRole("button", { name: "Create invite link", exact: true }).click();
      await page.waitForFunction(() => window.__settingsFixture.snapshot().calls.some(x => x.method === "POST"));
      assert(await dialog.getByLabel("Their name", { exact: true }).isDisabled(), "The recipient cannot change while creating the link");
      for (const radio of await choices.getByRole("radio").all()) {
        assert(await radio.isDisabled(), "Granted access cannot change while creating the link");
      }
      release();
      const ready = page.getByRole("dialog", { name: "Link ready" });
      await ready.waitFor();
      assert.deepEqual({ name: submitted.display_name, role: submitted.role }, { name: "Helper One", role });
      assert.match(await ready.innerText(), /Send this to Helper One/);
      assert(await ready.getByText(label, { exact: true }).isVisible());
      assert(await ready.getByText(description, { exact: true }).isVisible());
      await capture(page, `invite-result-${role}`);
      await page.context().close();
    }
  });

  await check("On Today prevents overlapping saves of the same switch", async () => {
    const releases = [];
    const page = await fixture(async (route, url) => {
      if (url.pathname !== "/api/maple/baby" || route.request().method() !== "PATCH") return false;
      await new Promise(resolve => { releases.push(resolve); });
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return true;
    });
    await open(page, "On Today");
    const bottles = page.getByRole("switch", { name: /^Bottles/ });
    await bottles.click();
    await pendingPatch(page);
    assert(await bottles.isDisabled(), "The same setting waits for its save before accepting another choice");
    await bottles.evaluate(button => button.click());
    assert.equal((await snapshot(page)).calls.filter(call => call.method === "PATCH").length, 1);
    releases[0]();
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Bottles"]')?.disabled === false);
    assert.equal(await bottles.getAttribute("aria-checked"), "false");
    assert.equal((await snapshot(page)).state.baby.settings.feeds_bottle, false);
    await bottles.click();
    await pendingPatch(page, 2);
    releases[1]();
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Bottles"]')?.disabled === false);
    assert.equal(await bottles.getAttribute("aria-checked"), "true");
    assert.equal((await snapshot(page)).state.baby.settings.feeds_bottle, true);
  });

  await check("onboarding chat draft survives mode and connection changes", async () => {
    const page = await fixture(undefined, "draft");
    await page.getByRole("radio", { name: "Questions and chat", exact: true }).click();
    const draft = "Synthetic baby details not sent yet";
    await page.getByRole("textbox", { name: "Message", exact: true }).fill(draft);
    await page.getByRole("radio", { name: "Just the questions", exact: true }).click();
    await page.getByRole("radio", { name: "Questions and chat", exact: true }).click();
    assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), draft);
    await page.evaluate(() => window.__settingsFixture.setOnline(false));
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor({ state: "detached" });
    await page.evaluate(() => window.__settingsFixture.setOnline(true));
    assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), draft);
    assert.equal((await snapshot(page)).calls.filter(call => call.url === "/api/maple/onboarding/chat").length, 0);
  });

  await check("onboarding invite remains selectable after clipboard denial", async () => {
    const page = await fixture();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new DOMException("Synthetic clipboard denied", "NotAllowedError")) } });
      delete Navigator.prototype.share;
      delete navigator.share;
    });
    await page.goto(`${origin}/?view=links`);
    await page.getByRole("button", { name: "Copy Helper Synthetic's link", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: /copy/i }).waitFor();
    const link = page.getByLabel("Helper Synthetic's invite link", { exact: true });
    assert.equal(await link.inputValue(), `${origin}/maple/join#synthetic-onboarding-link`);
    assert.equal(await link.getAttribute("readonly"), "");
    await link.focus();
    assert.equal(await link.evaluate(input => input.selectionEnd - input.selectionStart), (await link.inputValue()).length);
    assert.equal(await page.getByRole("button", { name: "Share Helper Synthetic's link", exact: true }).count(), 0);
    assert.equal(await page.getByText("Copied", { exact: true }).count(), 0);
    await capture(page, "invite-copy-recovery");
  });

  assert.deepEqual(errors, [], "No uncaught browser errors");
  const failures = results.filter(result => !result.passed);
  console.log(`${results.length - failures.length}/${results.length} ${browserName} onboarding recovery scenarios passed`);
  if (failures.length) process.exitCode = 1;
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
