import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const output = await mkdtemp(path.join(tmpdir(), "maple-search-ui-"));
const screenshots = path.join(root, "test-results/maple-search-ui");
await mkdir(screenshots, { recursive: true });
await build({ entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true, format: "esm", jsx: "automatic", absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"test"' },
  plugins: [{ name: "synthetic-search-boundaries", setup(plugin) {
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|AppNav|sheets)$/ }, () => ({ path: path.join(here, "mocks.jsx") }));
  } }],
});
const css = path.join(root, "src/app/globals.css");
const compiled = await postcss([tailwind({ base: root })]).process(await readFile(css, "utf8"), { from: css });
await writeFile(path.join(output, "app.css"), compiled.css + "\n" + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
await writeFile(path.join(output, "index.html"), '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const page = await browser.newPage({ viewport: { width: 375, height: 812 }, reducedMotion: "reduce", locale: "en-US" });
const origin = "https://maple-search-ui.example.test";
const pending = new Map();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, "No outside service may be contacted");
  if (url.pathname.startsWith("/api/")) {
    assert(["/api/maple/chat/entry", "/api/maple/chat/search", "/api/maple/entries"].includes(url.pathname));
    pending.set(url.pathname, route);
    return;
  }
  const file = ["/app.js", "/app.css"].includes(url.pathname) ? url.pathname.slice(1) : "index.html";
  await route.fulfill({ contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html", body: await readFile(path.join(output, file)) });
});
const waitFor = async (url) => {
  const deadline = Date.now() + 5000;
  while (!pending.has(url) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert(pending.has(url), `Expected request ${url}`);
  return pending.get(url);
};
const reply = async (url, body, status = 200) => {
  const route = await waitFor(url); pending.delete(url);
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
};
const reset = async (mode = "member") => {
  await page.evaluate((value) => window.__searchUi.reset(value), mode);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
};
const entry = { id: 901, kind: "note", started_at: "2026-10-28T14:00:00.000Z", updated_at: "2026-10-28T15:00:00.000Z", data: { for_doctor: true, done: false }, note: "Current synthetic question" };

try {
  await page.goto(origin);
  await page.waitForFunction(() => !!window.__searchUi);
  const draft = page.getByRole("textbox", { name: "Message" });
  await draft.fill("A draft for the next turn");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Opening…", exact: true }).waitFor();
  assert(await page.getByRole("button", { name: "Load more", exact: true }).isDisabled());
  const exact = await waitFor("/api/maple/chat/entry");
  assert.equal(new URL(exact.request().url()).searchParams.get("id"), "901");
  assert.equal(exact.request().headers()["x-maple-family"], "1");
  await reply("/api/maple/chat/entry", { entry, deleted: false });
  await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
  assert((await page.evaluate(() => window.__searchUi.calls())).some((call) => call.type === "edit" && call.value.entry.note === "Current synthetic question"));
  assert.equal(await draft.inputValue(), "A draft for the next turn");
  console.log("PASS search Edit reads the current scoped entry and keeps the composer draft");

  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await page.getByRole("button", { name: "Loading…", exact: true }).waitFor();
  const more = await waitFor("/api/maple/chat/search");
  assert.equal(more.request().method(), "POST");
  assert.deepEqual(more.request().postDataJSON(), { cursor: "synthetic_next_page" });
  await reply("/api/maple/chat/search", { error: "Search access is no longer available." }, 403);
  await page.getByRole("alert").filter({ hasText: "Search access is no longer available." }).waitFor();
  assert.equal(await draft.inputValue(), "A draft for the next turn");
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  const results = await page.evaluate(() => window.__searchUi.results);
  await reply("/api/maple/chat/search", { ...results, entries: [{ id: 902, kind: "note", startedAt: "2026-10-27T14:00:00.000Z", summary: "Another synthetic question", question: true, done: true }], nextCursor: null });
  await page.getByText("Another synthetic question", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Load more", exact: true }).count(), 0);
  assert.equal(await draft.inputValue(), "A draft for the next turn");
  console.log("PASS search pagination shows loading, preserves errors for retry and keeps the draft");

  await reset();
  await page.getByRole("button", { name: "Mark asked", exact: true }).click();
  await reply("/api/maple/chat/entry", { entry, deleted: false });
  const update = await waitFor("/api/maple/entries");
  assert.deepEqual(update.request().postDataJSON(), { data: { done: true }, expect_updated_at: entry.updated_at });
  await reply("/api/maple/entries", { error: "Save failed" }, 503);
  await page.getByRole("alert").filter({ hasText: "Couldn't change this question" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Reopen question", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Mark asked", exact: true }).click();
  // Another person already marked it asked: this user's action stays idempotent, never reopens it.
  await reply("/api/maple/chat/entry", { entry: { ...entry, data: { for_doctor: true, done: true } }, deleted: false });
  assert.equal((await waitFor("/api/maple/entries")).request().postDataJSON().data.done, true);
  await reply("/api/maple/entries", { entry: { ...entry, data: { for_doctor: true, done: true } } });
  await page.getByRole("button", { name: "Reopen question", exact: true }).click();
  await reply("/api/maple/chat/entry", { entry: { ...entry, data: { for_doctor: true, done: true } }, deleted: false });
  assert.equal((await waitFor("/api/maple/entries")).request().postDataJSON().data.done, false);
  await reply("/api/maple/entries", { entry });
  await page.getByRole("button", { name: "Mark asked", exact: true }).waitFor();
  console.log("PASS question checklist confirms successful writes, retries failure and preserves tap intent");

  await reset("viewer");
  assert.equal(await page.getByRole("button", { name: "Edit", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Mark asked", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Open history", exact: true }).click();
  assert((await page.evaluate(() => window.__searchUi.calls())).some((call) => call.type === "nav" && call.value === "log"));
  await reset("offline");
  assert(await page.getByRole("button", { name: "Edit", exact: true }).isDisabled());
  assert(await page.getByRole("button", { name: "Load more", exact: true }).isDisabled());
  await reset();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  const box = await page.getByRole("button", { name: "Mark asked", exact: true }).boundingBox();
  assert(box && box.height >= 44);
  await page.screenshot({ path: path.join(screenshots, "search-375-day.png") });
  await page.evaluate(() => document.documentElement.classList.add("maple-night", "dark"));
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
  await page.screenshot({ path: path.join(screenshots, "search-375-night.png") });
  assert.deepEqual(errors, []);
  console.log("PASS search viewer/offline controls and mobile layout");
} catch (error) {
  await page.screenshot({ path: path.join(screenshots, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
