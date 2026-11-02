import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium, webkit } = require("playwright");
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const tailwind = require("@tailwindcss/postcss");
const output = await mkdtemp(path.join(tmpdir(), "maple-sleep-"));
// Synthetic screenshots (a made-up family), uploaded by the UI checks workflow; test-results/ is ignored by git.
const screenshots = path.join(root, "test-results/maple-sleep-ui");
await mkdir(screenshots, { recursive: true });
await build({
  entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", absWorkingDir: root, tsconfig: path.join(root, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"test"' },
  plugins: [{ name: "synthetic-sleep-boundaries", setup(plugin) {
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|CareNav)$/ }, () => ({ path: path.join(here, "mocks.jsx") }));
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => args.importer.endsWith("/sheets/parts.tsx") ? { path: path.join(here, "mocks.jsx") } : undefined);
  } }],
});
const css = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, "src/app/globals.css"), "utf8"), { from: path.join(root, "src/app/globals.css") });
await writeFile(path.join(output, "app.css"), css.css + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
const html = (night) => `<!doctype html><html class="maple-ui${night ? " maple-night" : ""}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link href="/app.css" rel="stylesheet"></head><body class="bg-mp-bg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
const browserName = process.env.REVIEW_BROWSER === "webkit" ? "webkit" : "chromium";
const browser = await ({ chromium, webkit }[browserName]).launch({ headless: true });
const errors = [];
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", hasTouch: true });
const page = await context.newPage();
page.setDefaultTimeout(5000);
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, "https://sleep.example.test", "Every request must remain inside the synthetic fixture");
  assert(!url.pathname.startsWith("/api/"), "No fixture may reach an API");
  const file = url.pathname === "/app.js" ? "app.js" : url.pathname === "/app.css" ? "app.css" : null;
  await route.fulfill({ contentType: file?.endsWith("js") ? "text/javascript" : file ? "text/css" : "text/html", body: file ? await readFile(path.join(output, file)) : html(url.searchParams.has("night")) });
});

const calls = () => page.evaluate(() => window.__sleep.calls().filter((c) => c.action !== "GET"));
const actions = async () => (await calls()).map((c) => c.action);
const last = async () => (await calls()).at(-1);
const advance = (minutes) => page.evaluate((m) => window.__sleep.advance(m), minutes);
const strip = page.getByRole("group", { name: "Sleep plan", exact: true });
const plan = page.getByRole("dialog", { name: "Sleep plan", exact: true });
const toast = (text) => page.locator("[data-toast]").filter({ hasText: text });
const height = async (locator) => (await locator.boundingBox())?.height ?? 0;
const shot = async (name) => {
  await page.waitForTimeout(400); // let a sheet finish fading in
  await page.screenshot({ path: path.join(screenshots, `${name}-${browserName}.png`) });
};
const noHorizontalScroll = async (label) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(over <= 0, `${label}: no horizontal scroll (${over}px over)`);
};
const BANNED = [/cry[- ]it[- ]out/i, /safe to (sleep|doze|nap) (on|with|holding)/i, /contact nap/i, /keep holding/i, /\bstreak\b/i, /\bfail(ed|ure)?\b/i, /\bgrade\b/i];
const clean = async (locator, label) => {
  const text = await locator.innerText();
  for (const re of BANNED) assert(!re.test(text), `${label} must not say ${re}`);
  assert(!/\p{Extended_Pictographic}/u.test(text), `${label}: no emoji in the chrome`);
  return text;
};

try {
  // ── Set up the plan; its three parts ──
  await page.goto("https://sleep.example.test/");
  await page.getByRole("button", { name: "Open the sleep plan", exact: true }).click();
  await plan.waitFor();
  assert.equal(await strip.count(), 0, "No strip before there's a plan, a try or a shift");
  assert.match(await plan.innerText(), /River is .+ old/);
  await plan.getByRole("button", { name: "Set up the plan", exact: true }).click();
  await plan.getByText("Stage 1 of 4", { exact: true }).waitFor();
  assert.equal((await last()).action, "plan.create");
  let text = await clean(plan, "The plan");
  assert.match(text, /First tries/);
  assert.match(text, /0 of 1 tonight/);
  await shot("plan");
  console.log("PASS Plan: set up at stage 1 (one try a day), age from the birth date");

  await plan.getByRole("radio", { name: "Guidance", exact: true }).click();
  await plan.getByRole("heading", { name: "Safe sleep", exact: true }).waitFor();
  text = await clean(plan, "Guidance");
  for (const title of ["Safe sleep", "Call the pediatrician", "Call 911"]) assert(text.includes(title), `Guidance shows ${title}`);
  assert.match(text, /If she wakes crying/);
  const articles = plan.locator("article");
  const count = await articles.count();
  assert(count >= 8, `Guidance lists its items (${count})`);
  for (let i = 0; i < count; i++) {
    const hrefs = await articles.nth(i).locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    assert(hrefs.length > 0 && hrefs.every((h) => /^https:\/\//.test(h)), `Guidance item ${i} links its sources`);
  }
  assert.equal(await plan.getByRole("link", { name: "Call 911" }).getAttribute("href"), "tel:911");
  await plan.getByRole("button", { name: "Doctor numbers", exact: true }).click();
  assert.equal((await last()).action, "help", "Doctor numbers opens the shared Help sheet");
  assert.match(text, /not medical advice|isn't medical advice|not a substitute/i, "The disclaimer shows");
  await shot("guidance");
  console.log(`PASS Guidance: ${count} sourced items, safe sleep, when to call, 911 link, disclaimer, no banned words`);

  await plan.getByRole("radio", { name: "Progress", exact: true }).click();
  await plan.getByText("Last 7 days", { exact: true }).waitFor();
  text = await clean(plan, "Progress");
  assert.match(text, /Tries\s+None yet/);
  assert.doesNotMatch(text, /%/, "Progress gives counts, not percentages or scores");
  console.log("PASS Progress: plain counts, nothing yet");
  await page.keyboard.press("Escape");
  await plan.waitFor({ state: "hidden" });

  // ── Put down: one tap; the fed tag; earlier ──
  await strip.waitFor();
  assert.match(await strip.innerText(), /Bassinet try/);
  const putDown = strip.getByRole("button", { name: "Put down", exact: true });
  assert((await height(putDown)) >= 44, "Put down is a 44px target");
  await putDown.click();
  await toast("In the bassinet at 2:10 AM").waitFor();
  let c = await last();
  assert.equal(c.action, "try.start");
  assert.deepEqual(c.tags, ["fed"], "A feed that ended 12 minutes ago pre-ticks Recently fed");
  assert.match(await strip.innerText(), /In the bassinet/);
  await page.getByRole("button", { name: "Laid down 2 minutes earlier, at 2:08 AM", exact: true }).click();
  await toast("Laid down at 2:08 AM").waitFor();
  c = await last();
  assert.equal(c.action, "try.update");
  assert.equal(c.started_at, "2026-10-28T06:08:00.000Z");
  const card = page.getByRole("region", { name: "In the bassinet" });
  await card.waitFor();
  const outcomes = card.getByRole("group", { name: "How did it go?" }).getByRole("button");
  assert.equal(await outcomes.count(), 4, "Four outcomes on the card");
  for (let i = 0; i < 4; i++) assert((await height(outcomes.nth(i))) >= 56, "Outcome buttons are big");
  assert.match(await card.innerText(), /try 1 tonight/);
  await shot("try-running");
  console.log("PASS Put down: one tap, fed pre-ticked, two minutes earlier, four big outcomes");

  // ── How did it go: one tap, then Undo ──
  await advance(45);
  await card.getByRole("button", { name: /^Stayed asleep/ }).click();
  await toast("Stayed asleep after 47 min. Sleep timer stopped.").waitFor();
  c = await last();
  assert.equal(c.action, "try.finish");
  assert.equal(c.outcome, "stayed_asleep");
  assert.match(await strip.innerText(), /1 of 1 tonight/);
  await toast("Stayed asleep after 47 min").getByRole("button", { name: "Undo", exact: true }).click();
  await toast("Undone: the try is running again").waitFor();
  c = await last();
  assert.equal(c.action, "try.undo_finish");
  assert.equal(c.sleep?.was_active, true, "Undo restarts the sleep the finish stopped");
  assert.match(await strip.innerText(), /In the bassinet/);
  console.log("PASS Outcome: one tap finishes the try and its sleep; Undo puts both back");

  // ── Woke up elsewhere: the try asks, ending when she woke ──
  await advance(5);
  assert(await page.evaluate(() => window.__sleep.stopSleep()));
  await strip.getByText("She woke at 3:00 AM").waitFor();
  await strip.getByRole("button", { name: "How did it go?", exact: true }).click();
  const outcome = page.getByRole("dialog", { name: "How did it go?", exact: true });
  await outcome.waitFor();
  assert.match(await outcome.innerText(), /She woke at 3:00 AM\. The try ends then\./);
  await outcome.getByRole("button", { name: /^Woke calm/ }).click();
  await outcome.waitFor({ state: "hidden" });
  c = await last();
  assert.equal(c.action, "try.finish");
  assert.equal(c.outcome, "woke_calm");
  assert.equal(c.at, "2026-10-28T07:00:00.000Z", "The try ends when the sleep did");
  assert.equal(await toast("already ended").count(), 0, "This phone's own outcome closes its sheet without an 'already ended' notice");
  console.log("PASS Woke up: a try whose sleep stopped asks how it went, ending then");

  // ── Holding her awake; I'm getting sleepy: exactly two choices ──
  await page.getByRole("button", { name: "Open the sleep plan", exact: true }).click();
  await plan.waitFor();
  await plan.getByRole("button", { name: "Start holding her (awake)" }).click();
  await plan.waitFor({ state: "hidden" });
  const holding = page.getByRole("dialog", { name: "Holding River", exact: true });
  await holding.waitFor();
  await clean(holding, "Holding");
  await holding.getByRole("button", { name: "Start", exact: true }).click();
  await holding.waitFor({ state: "hidden" });
  c = await last();
  assert.equal(c.action, "shift.start");
  assert.equal(c.holder, "sam@example.test");
  assert.equal(c.next_holder, "alex@example.test");
  assert.equal(c.handoff_at, "2026-10-28T09:00:00.000Z", "Planned handoff two hours on");
  assert.match(await strip.innerText(), /You're holding her/);
  await strip.getByRole("button", { name: "I'm getting sleepy", exact: true }).click();
  const sleepy = page.getByRole("dialog", { name: "Getting sleepy?", exact: true });
  await sleepy.waitFor();
  text = await clean(sleepy, "Getting sleepy");
  const choices = sleepy.getByRole("button").filter({ hasNotText: /^$/ }).filter({ hasText: /bassinet now|^Wake/ });
  assert.equal(await choices.count(), 2, "Exactly two choices");
  assert.deepEqual((await choices.allInnerTexts()).map((t) => t.split("\n")[0]), ["Put her in the bassinet now", "Wake Alex"]);
  assert.equal(await sleepy.getByRole("button").count(), 3, "Two choices and the close button, nothing else");
  for (const box of await choices.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) assert(box >= 64, "Both choices are big");
  await shot("getting-sleepy");
  await sleepy.getByRole("button", { name: /^Wake Alex/ }).click();
  await sleepy.waitFor({ state: "hidden" });
  c = await last();
  assert.equal(c.action, "shift.handoff");
  assert.equal(c.to, "alex@example.test");
  assert.equal(c.wake, true, "Waking the partner asks the other phones to sound now");
  await toast("Alex is holding her now").waitFor();
  console.log("PASS Getting sleepy: two big choices only; waking the partner hands her over now");

  await strip.getByRole("button", { name: "I'm getting sleepy", exact: true }).click();
  await sleepy.waitFor();
  await sleepy.getByRole("button", { name: /^Put her in the bassinet now/ }).click();
  await page.getByRole("dialog", { name: "Into the bassinet", exact: true }).waitFor();
  const steps = page.getByRole("dialog", { name: "Into the bassinet", exact: true }).locator("ol li");
  assert.equal(await steps.count(), 5, "The five transfer steps");
  assert.match((await steps.allInnerTexts()).join(" "), /on her back/);
  assert.equal((await last()).action, "try.start");
  await page.getByRole("dialog", { name: "Into the bassinet", exact: true }).getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("dialog", { name: "Into the bassinet", exact: true }).waitFor({ state: "hidden" });
  console.log("PASS Bassinet now: starts a try, ends the turn, shows the five steps");

  // ── An earlier try nobody started: the duplicate question ──
  await page.getByRole("button", { name: "Log an earlier try", exact: true }).click();
  const log = page.getByRole("dialog", { name: "Log an earlier try", exact: true });
  await log.waitFor();
  await log.getByRole("button", { name: "Woke crying", exact: true }).click();
  await log.getByRole("button", { name: "Save", exact: true }).click();
  await log.getByRole("alert").waitFor();
  assert.match(await log.getByRole("alert").innerText(), /already logged.*nothing was saved yet/);
  assert.equal((await last()).allow_duplicate, false);
  await log.getByRole("button", { name: "Save anyway", exact: true }).click();
  await log.waitFor({ state: "hidden" });
  c = await last();
  assert.equal(c.action, "try.log");
  assert.equal(c.allow_duplicate, true);
  assert.equal(c.outcome, "woke_crying");
  await toast("Try saved: woke crying").waitFor();
  console.log("PASS Earlier try: a likely twin asks first, then saves on Save anyway");

  // ── Correct a try's time from the plan's recent tries ──
  await page.getByRole("button", { name: "Open the sleep plan", exact: true }).click();
  await plan.waitFor();
  await plan.getByRole("button", { name: /^Woke calm · 52 min/ }).click();
  const edit = page.getByRole("dialog", { name: "Bassinet try", exact: true });
  await edit.waitFor();
  await edit.getByRole("group", { name: "Laid down" }).getByRole("button", { name: "5 min earlier", exact: true }).click();
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await edit.waitFor({ state: "hidden" });
  c = await last();
  assert.equal(c.action, "try.update");
  assert.equal(c.started_at, "2026-10-28T06:03:00.000Z", "Five minutes earlier than 2:08 AM");
  assert.equal(c.ended_at, undefined, "Only the time that moved is sent");
  await toast("Try updated").waitFor();
  console.log("PASS Edit: a finished try's laid-down time moves by the nudges and saves only that");

  // ── Progress after a few tries: sample sizes, early observation ──
  await page.getByRole("button", { name: "Open the sleep plan", exact: true }).click();
  await plan.waitFor();
  await plan.getByRole("radio", { name: "Progress", exact: true }).click();
  await plan.getByText("Last 7 days", { exact: true }).waitFor();
  await plan.getByText(/^Stayed asleep/).first().waitFor();
  text = await clean(plan, "Progress with tries");
  assert.match(text, /Tries\s+\d+ on \d+ days?/);
  assert.match(text, /Stayed asleep\s+\d+ of \d+/);
  assert.match(text, /Logged sleep by place/);
  assert.match(text, /not a score/);
  assert.doesNotMatch(text, /best time/i, "No best time on a handful of tries");
  assert.doesNotMatch(text, /%/);
  await shot("progress");
  await page.setViewportSize({ width: 320, height: 640 });
  await noHorizontalScroll("Progress at 320px");
  await plan.getByRole("radio", { name: "Guidance", exact: true }).click();
  await noHorizontalScroll("Guidance at 320px");
  await plan.getByRole("radio", { name: "Plan", exact: true }).click();
  await plan.getByRole("button", { name: "Change the plan" }).click();
  await noHorizontalScroll("Plan editor at 320px");
  await page.keyboard.press("Escape");
  await noHorizontalScroll("Today's sleep cards at 320px");
  await page.setViewportSize({ width: 390, height: 844 });
  console.log("PASS Progress: counts with sample sizes, no score or best time; 320px layouts fit");

  // ── A view-only guest: the card, no buttons, no strip ──
  await page.goto("https://sleep.example.test/?running&role=viewer&night");
  const viewerCard = page.getByRole("region", { name: "In the bassinet" });
  await viewerCard.waitFor();
  assert.equal(await strip.count(), 0, "No strip for a view-only guest");
  assert.equal(await viewerCard.getByRole("button").count(), 0, "No outcome buttons for a view-only guest");
  assert.match(await viewerCard.innerText(), /Swaddled/);
  await shot("viewer-night");
  console.log("PASS Viewer: sees the running try (night look), can't log");

  assert.deepEqual(errors, []);
  console.log(`PASS Sleep UI: no runtime errors (${browserName})`);
} catch (err) {
  console.error("Page errors:", errors);
  console.error("Dialogs:", await page.getByRole("dialog").evaluateAll((ds) => ds.map((d) => d.getAttribute("aria-label") ?? d.getAttribute("aria-labelledby") ?? d.textContent.slice(0, 80))).catch(() => "?"));
  await page.screenshot({ path: path.join(screenshots, `failure-${browserName}.png`) }).catch(() => {});
  throw err;
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
