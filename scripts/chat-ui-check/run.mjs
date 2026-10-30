import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkLiveThread, liveServer } from "./live-thread-checks.mjs";
import { checkQueue } from "./queue-checks.mjs";

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
  await checkQueue({ page, url: origin });
  await page.goto(origin);
  await page.waitForFunction(() => !!window.__chatFixture);
  await page.getByText("Loading your conversation…", { exact: true }).waitFor();
  assert(await page.getByRole("button", { name: "Queue message", exact: true }).isDisabled());
  await fixture("history-error");
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  assert((await snapshot()).calls.some((c) => c.kind === "retry-history"));
  await page.getByText("Loading your conversation…", { exact: true }).waitFor();
  await fixture("hidden-work");
  await page.getByText("Thinking…", { exact: true }).waitFor();
  assert.equal(await page.getByText("Hidden synthetic model work", { exact: true }).count(), 0, "Reasoning stays hidden while progress stays visible");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("A draft for later");
  assert(await page.getByRole("button", { name: "Queue message", exact: true }).isEnabled(), "Generation keeps the draft editable and allows queueing the next message");
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
  assert(await answer.evaluate((el) => document.activeElement === el), "Opening a custom answer focuses its field");
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

  for (const name of ["question-error", "question-malformed"]) {
    await fixture(name);
    await page.getByRole("region", { name: "Question unavailable", exact: true }).waitFor();
    await page.getByText("This question couldn't be shown. You can type your reply in the message box.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Same feeding", exact: true }).count(), 0);
  }
  await fixture("tool-error");
  await page.getByText("Some details need checking before this can continue.", { exact: true }).waitFor();
  assert(!/log_feed|maple_status|Synthetic validation/.test(await page.locator("body").innerText()), "Tool/schema diagnostics never leak into cards");
  console.log("PASS errors: failed questions offer a typed fallback and tool diagnostics stay readable");

  await fixture("receipt");
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await page.getByText("Feeding in the log", { exact: true }).waitFor();
  await page.getByRole("region", { name: "Saved entry", exact: true }).getByText(/L 8m/).waitFor();
  await noOverflow(); await settle();
  await page.screenshot({ path: path.join(screenshots, "receipt-375-day.png") });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  assert((await snapshot()).calls.some((c) => c.kind === "edit" && c.value.entry.id === 901), "Edit opens the exact scoped entry");
  await undo.click();
  await page.getByRole("button", { name: "Undoing…", exact: true }).waitFor();
  assert.equal(await page.getByText("Feeding removed", { exact: true }).count(), 0, "Undo does not claim success before the mutation");
  await resolveAction(false);
  await page.getByText("Couldn't undo this entry. Check its status before trying again.", { exact: true }).waitFor();
  assert(await undo.isDisabled(), "An uncertain failed action must be checked before retry");
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await undo.click();
  await resolveAction(true);
  await page.getByText("Feeding removed", { exact: true }).waitFor();
  await page.evaluate(() => window.__chatFixture.remount());
  await page.getByText("Feeding removed", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Undo", exact: true }).count(), 0, "A removed entry never returns as saved after remount");
  const restore = page.getByRole("button", { name: "Restore", exact: true });
  await restore.click();
  await page.getByRole("button", { name: "Restoring…", exact: true }).waitFor();
  assert.equal(await page.getByText("Feeding in the log", { exact: true }).count(), 0);
  await resolveAction(false);
  await page.getByText("Couldn't restore this entry. Check its status before trying again.", { exact: true }).waitFor();
  assert(await restore.isDisabled());
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await restore.click();
  await resolveAction(true);
  await page.getByText("Feeding in the log", { exact: true }).waitFor();
  await page.evaluate(() => window.__chatFixture.remount());
  await page.getByText("Feeding in the log", { exact: true }).waitFor();
  assert(!/#901/.test(await page.locator("body").innerText()), "Raw receipt IDs remain hidden");
  console.log("PASS actions: exact entry Edit, pending and failed Undo/Restore, server status survives remount");

  await page.evaluate(() => {
    const old = window.__chatFixture.snapshot().records.baby.entry;
    window.__chatFixture.updateRecord("baby", { entry: { ...old, ended_at: null, data: { method: "bottle", amount_ml: 60, milk: "formula" }, updated_at: "2026-10-28T16:01:00.000Z" } });
  });
  const receiptCard = page.getByRole("region", { name: "Saved entry", exact: true });
  await receiptCard.getByText(/Bottle.*formula/).waitFor();
  assert(!(await receiptCard.innerText()).includes("left 8 minutes"), "Current details replace stale receipt prose after an edit");
  await page.evaluate(() => window.__chatFixture.updateRecord("baby", { available: false }));
  await page.getByText("Earlier confirmation. Current status is unavailable.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Undo", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Edit", exact: true }).count(), 0, "Missing exact records are not inferred deleted or editable");
  await page.evaluate(() => window.__chatFixture.remount());
  await page.getByText("Saved earlier", { exact: true }).waitFor();
  console.log("PASS receipts: edited details stay current; unavailable records are historical without destructive actions");

  await fixture("restore");
  await page.getByText("Feeding removed", { exact: true }).waitFor();
  assert(await page.getByRole("button", { name: "Restore", exact: true }).isEnabled());
  await page.evaluate(() => {
    const old = window.__chatFixture.snapshot().records.baby.entry;
    window.__chatFixture.updateRecord("baby", { entry: { ...old, kind: "med", data: { name: "Example medicine", moved_to: 902 } } });
  });
  await page.getByText("Moved to the care log", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Restore", exact: true }).count(), 0, "A moved medicine cannot be restored into both logs");
  assert(!/902/.test(await receiptCard.innerText()), "Move destination IDs are never shown");
  await fixture("care-receipt");
  await page.getByText("Example medicine · in the log", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit time", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit dose time", exact: true });
  await editor.waitFor();
  await editor.getByLabel("Taken at: time", { exact: true }).fill("10:15");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  assert((await snapshot()).calls.some((c) => c.kind === "care-edit" && c.id === 901 && c.at === "2026-10-28T14:15:00.000Z" && c.expected === "2026-10-28T16:00:00.000Z"), "Care edit uses the exact entry version and local time");
  await page.getByRole("region", { name: "Saved entry", exact: true }).getByText(/10:15/).waitFor();
  await noOverflow(); await settle();
  await page.screenshot({ path: path.join(screenshots, "care-receipt-375-day.png") });
  await undo.click();
  await resolveAction(true);
  await page.getByText("Example medicine · removed", { exact: true }).waitFor();
  assert((await snapshot()).calls.some((c) => c.kind === "care-remove" && c.id === 901));
  assert(!(await snapshot()).calls.some((c) => c.kind === "remove"), "Matching care/baby IDs cannot cross mutation domains");
  await page.evaluate(() => window.__chatFixture.remount());
  await page.getByText("Example medicine · removed", { exact: true }).waitFor();
  await restore.click();
  await resolveAction(true);
  await page.getByText("Example medicine · in the log", { exact: true }).waitFor();
  await page.evaluate(() => window.__chatFixture.setCareEnabled(false));
  await page.getByText("This care entry isn't available in chat.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Undo", exact: true }).count(), 0);
  assert(!/c901/.test(await page.locator("body").innerText()));
  console.log("PASS care receipts: scoped dose editing, Undo/Restore, reload and revoked access");

  await fixture("care-food");
  await page.getByText("Meal · in the log", { exact: true }).waitFor();
  await receiptCard.getByText(/Toast and eggs/).waitFor();
  assert(!(await receiptCard.innerText()).includes("OB"), "Food is never rendered as an OB question");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const foodEditor = page.getByRole("dialog", { name: "Edit food", exact: true });
  await foodEditor.getByRole("radio", { name: "Snack", exact: true }).click();
  await foodEditor.getByRole("textbox", { name: "What was it?", exact: true }).fill("Yogurt and fruit");
  await foodEditor.getByRole("button", { name: "Save", exact: true }).click();
  await foodEditor.waitFor({ state: "hidden" });
  await page.getByText("Snack · in the log", { exact: true }).waitFor();
  await receiptCard.getByText(/Yogurt and fruit/).waitFor();
  const foodEdit = (await snapshot()).calls.find((c) => c.kind === "care-edit-entry");
  assert.deepEqual(foodEdit.patch.data, { description: "Yogurt and fruit", meal: "snack" });
  assert.equal(foodEdit.expected, "2026-10-28T16:00:00.000Z");
  assert.equal((await snapshot()).records.care.entry.note, "Synthetic note retained", "Nutrition edits retain the entry's existing note");
  assert(!("note" in foodEdit.patch), "Food data is never saved into the question note field");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await foodEditor.getByRole("textbox", { name: "What was it?", exact: true }).fill("An older unsaved edit");
  await page.evaluate(() => {
    const old = window.__chatFixture.snapshot().records.care.entry;
    window.__chatFixture.updateRecord("care", { entry: { ...old, data: { ...old.data, description: "A newer saved snack" }, updated_at: "2026-10-28T16:05:00.000Z" } });
  });
  await foodEditor.getByRole("button", { name: "Save", exact: true }).click();
  await foodEditor.getByText("Couldn't confirm this change. Close this editor and check the latest entry before trying again.", { exact: true }).waitFor();
  assert.equal((await snapshot()).records.care.entry.data.description, "A newer saved snack", "Version guards preserve a newer change from another device");
  await foodEditor.getByRole("button", { name: "Cancel", exact: true }).click();

  await fixture("care-drink");
  await page.getByText("Water · in the log", { exact: true }).waitFor();
  await receiptCard.getByText(/8\.01 oz/).waitFor();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const drinkEditor = page.getByRole("dialog", { name: "Edit drink", exact: true });
  await drinkEditor.getByRole("textbox", { name: "Drink", exact: true }).fill("Tea");
  await drinkEditor.getByRole("button", { name: "Save", exact: true }).click();
  await drinkEditor.waitFor({ state: "hidden" });
  assert.equal((await snapshot()).records.care.entry.data.amount_ml, 237, "Renaming a drink does not round its original volume");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await drinkEditor.getByRole("textbox", { name: "Amount in oz", exact: true }).fill("-1");
  assert(await drinkEditor.getByRole("button", { name: "Save", exact: true }).isDisabled());
  await drinkEditor.getByRole("textbox", { name: "Amount in oz", exact: true }).fill("");
  await drinkEditor.getByRole("button", { name: "Save", exact: true }).click();
  await drinkEditor.waitFor({ state: "hidden" });
  await receiptCard.getByText(/Amount not recorded/).waitFor();
  assert.equal((await snapshot()).records.care.entry.data.amount_ml, null, "Unknown volume is not zero");
  await page.evaluate(() => window.__chatFixture.setUnits("metric"));
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await drinkEditor.getByRole("textbox", { name: "Amount in ml", exact: true }).fill("250");
  await drinkEditor.getByRole("button", { name: "Save", exact: true }).click();
  await drinkEditor.waitFor({ state: "hidden" });
  await receiptCard.getByText(/250 ml/).waitFor();
  assert.equal((await snapshot()).records.care.entry.data.amount_ml, 250);
  assert.equal((await snapshot()).records.care.entry.note, "Synthetic note retained");
  assert(!(await snapshot()).calls.some((c) => c.kind === "edit" || c.kind === "remove"), "Nutrition stays in the maternal care domain");
  await noOverflow(); await settle();
  await page.screenshot({ path: path.join(screenshots, "nutrition-receipt-375-day.png") });
  console.log("PASS nutrition receipts: old food/drink records edit in care, preserve versions/notes and respect units and unknown amounts");

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
  const scroller = page.locator('[aria-label="Chat"] > .overflow-y-auto').first();
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

  await fixture("queue-panel");
  await page.getByText("3 messages waiting", { exact: true }).waitFor();
  const queueList = page.getByRole("region", { name: "Message queue", exact: true }).locator(".overflow-y-auto");
  assert(await queueList.evaluate((el) => el.clientHeight <= 164 && el.scrollHeight > el.clientHeight), "Three long queued messages stay in a bounded scrolling panel");
  const composerBox = await page.getByRole("textbox", { name: "Message", exact: true }).boundingBox();
  assert(composerBox && composerBox.height <= 132 && composerBox.y + composerBox.height < 812, "Long drafts stay visible without pushing the composer offscreen");
  assert(await page.getByRole("button", { name: "Queue message", exact: true }).isVisible());
  await noOverflow(); await settle();
  await page.screenshot({ path: path.join(screenshots, "queue-panel-375-day.png") });
  console.log("PASS queue layout: three long messages scroll above the capped draft composer");

  await fixture("people-invite");
  const inviting = page.getByRole("region", { name: "Invite this person?", exact: true });
  await inviting.getByText("aunt@example.test", { exact: true }).waitFor();
  await inviting.getByText("Aunt Example", { exact: true }).waitFor();
  await inviting.getByText("Can log", { exact: true }).waitFor();
  await inviting.getByText("Sam's page", { exact: true }).waitFor();
  await inviting.getByText("Hidden", { exact: true }).waitFor();
  await tapTarget(inviting.getByRole("button", { name: "Invite", exact: true }));
  await noOverflow();
  await inviting.getByRole("button", { name: "Invite", exact: true }).click();
  assert.deepEqual((await snapshot()).calls.at(-1), { kind: "approve", id: "approval_invite", approved: true }, "Invite approves only this stored request");
  await fixture("people-change");
  const changing = page.getByRole("region", { name: "Change Blake's access?", exact: true });
  await changing.getByText("blake@example.test", { exact: true }).waitFor();
  await changing.getByText("Hidden → Can view", { exact: true }).waitFor();
  await changing.getByRole("button", { name: "Keep", exact: true }).click();
  assert.deepEqual((await snapshot()).calls.at(-1), { kind: "approve", id: "approval_change", approved: false }, "Keep turns the change down");
  await fixture("people-remove");
  const removing = page.getByRole("region", { name: "Remove Blake?", exact: true });
  await removing.getByText("blake@example.test", { exact: true }).waitFor();
  await removing.getByRole("button", { name: "Remove", exact: true }).click();
  assert.deepEqual((await snapshot()).calls.at(-1), { kind: "approve", id: "approval_remove", approved: true });
  await fixture("people-invited");
  const invited = page.getByRole("region", { name: "Invite ready", exact: true });
  await invited.getByText("aunt@example.test", { exact: true }).waitFor();
  await invited.getByRole("button", { name: "Copy invite link", exact: true }).waitFor();
  assert.equal(await page.getByText(/join=/).count(), 0, "The invite link is copied, never printed");
  await noOverflow();
  console.log("PASS people: invite, change and remove wait for their own card, and an invite's link is copied from its card");

  for (const name of ["question", "activity", "growth", "receipt", "care-receipt", "care-food", "care-drink", "queue-panel", "people-invite", "people-remove", "people-invited"]) {
    await fixture(name);
    if (name === "receipt") await page.getByText("Feeding in the log", { exact: true }).waitFor();
    if (name === "care-receipt") await page.getByText("Example medicine · in the log", { exact: true }).waitFor();
    if (name === "care-food") await page.getByText("Meal · in the log", { exact: true }).waitFor();
    if (name === "care-drink") await page.getByText("Water · in the log", { exact: true }).waitFor();
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
