import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkLiveThread, liveServer } from "./live-thread-checks.mjs";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const output = await mkdtemp(path.join(tmpdir(), "maple-chat-ui-"));
const screenshots = path.join(root, "test-results/maple-chat-ui");
await mkdir(screenshots, { recursive: true });
await rm(path.join(screenshots, "failure.png"), { force: true });
await build({
  entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", sourcemap: "inline", absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"test"' },
  plugins: [{ name: "synthetic-chat-boundaries", setup(plugin) {
    const mocks = { path: path.join(here, "mocks.jsx") };
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav|ChatNav|useChatThread|useTimerActions|AppNav|sheets)$/ }, () => mocks);
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => args.importer.endsWith("/sheets/parts.tsx") ? mocks : undefined);
  } }],
});
await build({
  entryPoints: [path.join(here, "live-thread.jsx")], outfile: path.join(output, "live-app.js"), bundle: true,
  format: "esm", jsx: "automatic", sourcemap: "inline", absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"test"' },
  plugins: [{ name: "synthetic-chat-server-boundary", setup(plugin) {
    const mocks = { path: path.join(here, "mocks.jsx") };
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav|ChatNav|useTimerActions|AppNav|sheets)$/ }, () => mocks);
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => args.importer.endsWith("/sheets/parts.tsx") ? mocks : undefined);
  } }],
});
const css = path.join(root, "src/app/globals.css");
const compiled = await postcss([tailwind({ base: root })]).process(await readFile(css, "utf8"), { from: css });
await writeFile(path.join(output, "app.css"), compiled.css + "\n" + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
await writeFile(path.join(output, "index.html"), '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Maple synthetic chat checks</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
await writeFile(path.join(output, "live.html"), (await readFile(path.join(output, "index.html"), "utf8")).replace('/app.js', '/live-app.js'));
const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const context = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const server = liveServer();
const origin = "https://maple-chat-ui.example.test";
await page.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, "The fixture must never contact an outside service");
  if (url.pathname === "/api/maple/chat") return server.serve(route);
  const file = ["/app.js", "/live-app.js", "/live.html", "/app.css"].includes(url.pathname) ? url.pathname.slice(1) : "index.html";
  await route.fulfill({ status: 200, contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html", body: await readFile(path.join(output, file)) });
});
const fixture = async (name) => {
  await page.evaluate((value) => window.__chatFixture.scenario(value), name);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};
const snapshot = () => page.evaluate(() => window.__chatFixture.snapshot());
const resolveAction = (success) => page.evaluate((value) => window.__chatFixture.resolveAction(value), success);
const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "Chat must fit the mobile viewport");
const settle = async () => {
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};
const tapTarget = async (locator) => {
  const box = await locator.boundingBox();
  assert(box && box.height >= 44, "Interactive card controls must be at least 44px tall");
};

try {
  await checkLiveThread({ page, server, url: origin });
  await page.goto(origin);
  await page.waitForFunction(() => !!window.__chatFixture);
  await page.getByText("Loading your conversation…", { exact: true }).waitFor();
  assert(await page.getByRole("button", { name: "Waiting for the current reply", exact: true }).isDisabled());
  await fixture("history-error");
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  assert((await snapshot()).calls.some((c) => c.kind === "retry-history"));
  await page.getByText("Loading your conversation…", { exact: true }).waitFor();
  await fixture("hidden-work");
  await page.getByText("Thinking…", { exact: true }).waitFor();
  assert.equal(await page.getByText("Hidden synthetic model work", { exact: true }).count(), 0, "Reasoning stays hidden while progress stays visible");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("A draft for later");
  assert(await page.getByRole("button", { name: "Waiting for the current reply", exact: true }).isDisabled(), "Generation blocks another send while keeping the draft editable");
  await fixture("read-work");
  await page.getByText("Checking the log…", { exact: true }).waitFor();
  assert.equal(await page.getByText("Working on it…", { exact: true }).count(), 0, "A tool does not add a competing activity row");
  await fixture("recovering");
  await page.getByText("Finishing your previous reply…", { exact: true }).waitFor();
  console.log("PASS loading: initial history, retry, hidden reasoning, read tools, recovery, editable draft");

  await fixture("question");
  const same = page.getByRole("button", { name: "Same feeding", exact: true });
  await same.waitFor();
  await tapTarget(same);
  await same.click();
  await page.getByText("Sending your answer…", { exact: true }).waitFor();
  assert.deepEqual((await snapshot()).calls.at(-1), { kind: "answer", toolCallId: "call_question", answer: { choiceId: "same" } });
  await resolveAction(true);
  await same.waitFor({ state: "hidden" });
  assert((await page.getByRole("region", { name: "Was this the same feeding?", exact: true }).innerText()).includes("Same feeding"));
  assert.equal(await page.getByRole("button", { name: "Same feeding", exact: true }).count(), 0, "An answered question cannot be replayed");
  await fixture("question");
  await page.getByRole("button", { name: "Type an answer", exact: true }).click();
  const answer = page.getByRole("textbox", { name: "Your answer", exact: true });
  await answer.fill("It was a separate feeding on the right.");
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  assert.deepEqual((await snapshot()).calls.at(-1), { kind: "answer", toolCallId: "call_question", answer: { text: "It was a separate feeding on the right." } });
  await resolveAction(false);
  await page.getByRole("button", { name: "Send answer", exact: true }).waitFor();
  assert.equal(await answer.inputValue(), "It was a separate feeding on the right.", "A failed answer preserves the draft");
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await resolveAction(true);
  await page.getByRole("region", { name: "Was this the same feeding?", exact: true }).locator("p").filter({ hasText: "It was a separate feeding on the right." }).waitFor();
  await noOverflow();
  await settle();
  await page.screenshot({ path: path.join(screenshots, "question-375-day.png") });
  console.log("PASS questions: choices, pending state, custom reply, retry, answered history");

  await fixture("receipt");
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await undo.waitFor();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  assert((await snapshot()).calls.some((c) => c.kind === "edit" && c.value.entry.id === 901), "Edit opens the correct synthetic entry");
  await undo.click();
  await page.getByRole("button", { name: "Undoing…", exact: true }).waitFor();
  assert.equal(await page.getByText("Undone", { exact: true }).count(), 0, "Undo does not claim success before the mutation");
  await resolveAction(false);
  await page.getByText("Couldn't undo this entry. Try again.", { exact: true }).waitFor();
  await undo.click();
  await resolveAction(true);
  await page.getByText("Undone", { exact: true }).waitFor();
  await fixture("restore");
  const restore = page.getByRole("button", { name: "Restore", exact: true });
  await restore.click();
  await page.getByRole("button", { name: "Restoring…", exact: true }).waitFor();
  assert.equal(await page.getByText("Restored", { exact: true }).count(), 0);
  await resolveAction(false);
  await page.getByText("Couldn't restore this entry. Try again.", { exact: true }).waitFor();
  await restore.click();
  await resolveAction(true);
  await page.getByText("Restored", { exact: true }).waitFor();
  assert(!/#901/.test(await page.locator("body").innerText()), "Raw receipt IDs remain hidden");
  console.log("PASS actions: entry Edit, pending Undo/Restore, failed actions stay retryable, confirmed success");

  await fixture("activity");
  const activityCard = page.getByRole("region", { name: "Activity over time", exact: true });
  await activityCard.getByRole("radio", { name: "Sleep", exact: true }).click();
  await tapTarget(activityCard.getByRole("radio", { name: "Sleep", exact: true }));
  assert.equal(await activityCard.getByRole("radio", { name: "Sleep", exact: true }).getAttribute("aria-checked"), "true");
  await page.getByRole("radio", { name: "14 days", exact: true }).click();
  const sleepPlot = activityCard.getByRole("group", { name: /^Logged sleep in hours/ });
  await sleepPlot.focus();
  await page.keyboard.press("ArrowLeft");
  assert((await activityCard.locator('[aria-live="polite"]').innerText()).includes("Oct 27"), "Keyboard navigation exposes the selected day's exact values");
  await page.getByRole("button", { name: "Previous day", exact: true }).click();
  assert((await activityCard.locator('[aria-live="polite"]').innerText()).includes("Oct 26"), "Day controls work without touching a small chart point");
  await page.getByText("Show data", { exact: true }).click();
  await page.getByRole("table").waitFor();
  assert((await page.getByRole("table").innerText()).includes("10/19") || (await page.getByRole("table").innerText()).includes("Oct 19"), "Expanded range includes older logged days");
  assert((await page.getByRole("table").innerText()).includes("No logs"), "Missing observations remain distinct from zero activity");
  await page.getByRole("radio", { name: "Diapers", exact: true }).click();
  await page.getByText("Show data", { exact: true }).click();
  await noOverflow();
  const dateLabels = await activityCard.locator("svg text").evaluateAll((elements) => elements.filter((el) => /^Oct/.test(el.textContent ?? "")).map((el) => { const rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right }; }).sort((a, b) => a.left - b.left));
  assert(dateLabels.every((label, index) => index === 0 || dateLabels[index - 1].right + 2 <= label.left), "Date labels must not collide on the mobile chart");
  await settle();
  await page.screenshot({ path: path.join(screenshots, "activity-375-day.png") });
  await activityCard.getByRole("button", { name: "Refresh chart", exact: true }).click();
  assert((await snapshot()).calls.some((c) => c.kind === "send" && /diapers/i.test(c.text) && /14/.test(c.text)), "Refresh asks for the visible metric and range");
  await fixture("growth");
  const growthCard = page.getByRole("region", { name: "Weight over time", exact: true });
  await growthCard.getByRole("button", { name: "Previous measurement", exact: true }).click();
  assert((await growthCard.locator('[aria-live="polite"]').innerText()).includes("Oct 20"), "Measurement controls expose the selected recorded weight");
  await page.getByText("Show data", { exact: true }).click();
  await page.getByRole("table").waitFor();
  assert((await page.getByRole("table").innerText()).includes("lb"), "Growth data has readable units");
  await page.getByText("Show data", { exact: true }).click();
  await noOverflow();
  await settle();
  await page.screenshot({ path: path.join(screenshots, "growth-375-day.png") });
  console.log("PASS charts: metric and range controls, data tables, growth measurements, mobile layout");

  await fixture("long");
  const scroller = page.locator('[aria-label="Chat"] .overflow-y-auto').first();
  await scroller.evaluate((el) => { el.scrollTop = 100; el.dispatchEvent(new Event("scroll", { bubbles: true })); });
  const before = await scroller.evaluate((el) => el.scrollTop);
  await page.evaluate(() => window.__chatFixture.appendReply());
  const latest = page.getByRole("button", { name: /Latest reply/ });
  await latest.waitFor();
  assert(Math.abs(await scroller.evaluate((el) => el.scrollTop) - before) < 5, "A new reply does not interrupt earlier reading");
  await page.evaluate(() => window.__chatFixture.setActive(false));
  await page.evaluate(() => window.__chatFixture.setActive(true));
  assert(Math.abs(await scroller.evaluate((el) => el.scrollTop) - before) < 5, "Tab switching preserves reading position");
  await latest.click();
  assert(await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 100), "Latest reply returns to the newest content");
  console.log("PASS scroll: new reply indicator, stable reading position, tab return, latest navigation");

  for (const name of ["question", "activity", "growth"]) {
    await fixture(name);
    await page.evaluate(() => document.documentElement.classList.add("dark", "maple-night"));
    await settle();
    await noOverflow();
    await page.screenshot({ path: path.join(screenshots, `${name}-375-night.png`) });
  }
  assert.deepEqual(errors, [], "No uncaught browser errors");
  console.log("PASS theme: synthetic cards fit the mobile viewport in the night look");
} catch (error) {
  await page.screenshot({ path: path.join(screenshots, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
