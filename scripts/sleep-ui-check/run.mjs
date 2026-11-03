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
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|CareNav|ChatNav)$/ }, () => ({ path: path.join(here, "mocks.jsx") }));
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
// The plan's row: in Up next while she's awake, on her sleep's card while she's asleep and nobody has laid her down.
const planRow = page.getByRole("group", { name: "Sleep plan", exact: true });
const upNext = page.getByRole("region", { name: "Up next", exact: true });
const asleepCard = page.getByRole("region", { name: "Asleep timer", exact: true });
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
// Goals and check-ins: counts and their samples only (the words goals.ts holds itself to), and no-break spaces read as spaces.
const JUDGING = /\b(fail|failed|failing|failure|streaks?|grades?|scores?|best|worst|success(ful)?|perfect|missed|behind|bad|poor)\b/i;
const neutral = async (locator, label) => {
  const text = (await clean(locator, label)).replace(/\u00a0/g, " ");
  assert(!JUDGING.test(text), `${label} must stay neutral, not "${text.match(JUDGING)?.[0]}"`);
  return text;
};
/** Nothing wider than the screen: the page, and anything in a sheet that scrolls (its body). */
const noSideScroll = async (dialog, label) => {
  await noHorizontalScroll(label);
  const over = await dialog.evaluate((d) =>
    Math.max(0, ...[...d.querySelectorAll("*")].filter((el) => !el.matches("input, textarea, select") && ["auto", "scroll"].includes(getComputedStyle(el).overflowX)).map((el) => el.scrollWidth - el.clientWidth))
  );
  assert(over <= 0, `${label}: nothing in the sheet scrolls sideways (${over}px over)`);
};
/** A toast's button while a sheet is open: the fixture draws toasts outside the sheet (the app draws them inside it), so the backdrop is over them. */
const tapToast = (text, name) => toast(text).getByRole("button", { name, exact: true }).dispatchEvent("click");

try {
  // ── Set up the plan; its three parts ──
  await page.goto("https://sleep.example.test/");
  await page.getByRole("button", { name: "Open the sleep plan", exact: true }).click();
  await plan.waitFor();
  assert.equal(await planRow.count(), 0, "No plan row before there's a plan, a try or a shift");
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

  // ── Goals, none yet: set one with Maple (the chat, seeded), or by hand ──
  await plan.getByRole("radio", { name: "Goals", exact: true }).click();
  await plan.getByRole("button", { name: "Set one yourself", exact: true }).waitFor();
  text = await neutral(plan, "Goals, none yet");
  assert.match(text, /Something to work toward together, like River sleeping longer in the bassinet/);
  await shot("goals-empty");
  await plan.getByRole("button", { name: "Set a goal with Maple", exact: true }).click();
  await plan.waitFor({ state: "hidden" });
  let ask = await last();
  assert.equal(ask.action, "ask", "Set a goal with Maple opens the chat, and the sheet steps aside");
  assert.equal(ask.prompt, "Help us set a sleep goal: what we're working toward, a few small weekly steps, and who sleeps when.");
  assert.match(ask.prompt, /\bsleep goal\b/, "The seeded message has the words that load the chat's sleep tools");
  console.log("PASS Goals, none yet: Set a goal with Maple seeds the chat with a sleep goal message; Set one yourself is there too");

  await page.getByRole("button", { name: "Open the sleep plan", exact: true }).click();
  await plan.waitFor();
  await plan.getByRole("radio", { name: "Goals", exact: true }).click();
  await plan.getByRole("button", { name: "Set one yourself", exact: true }).click();
  const form = page.getByRole("dialog", { name: "New sleep goal", exact: true });
  await form.waitFor();
  let sent = (await calls()).length;
  await form.getByRole("button", { name: "Save the goal", exact: true }).click();
  await form.getByText("The goal's title is needed.", { exact: true }).waitFor();
  assert.equal((await calls()).length, sent, "Nothing is sent while the form has something to fix");
  await form.getByRole("textbox", { name: "Goal", exact: true }).fill("Both of us get one long stretch");
  await form.getByText("The goal's title is needed.", { exact: true }).waitFor({ state: "detached" });
  await form.getByRole("textbox", { name: "Why it matters", exact: true }).fill("Back to work soon");
  await form.getByLabel("Target date", { exact: true }).fill("2026-11-25");
  await form.getByText("Wed, Nov 25, 28 days from today", { exact: true }).waitFor();
  await form.getByRole("button", { name: "Add a target: Bassinet nights", exact: true }).click();
  await form.getByRole("button", { name: "Add a step", exact: true }).click();
  await form.getByRole("textbox", { name: "Step 1", exact: true }).fill("Bassinet after the late feed");
  await form.getByRole("button", { name: "Add a window", exact: true }).click();
  // A window under 30 minutes: the rules' words show by the window at once, and Save sends nothing.
  await form.getByLabel("Window 1 to", { exact: true }).fill("22:15");
  await form.getByText("Window 1: a protected window is 30 minutes to 12 hours long.", { exact: true }).waitFor();
  sent = (await calls()).length;
  await form.getByRole("button", { name: "Save the goal", exact: true }).click();
  assert.equal((await calls()).length, sent, "Still nothing sent");
  await form.getByLabel("Window 1 to", { exact: true }).fill("02:00");
  await form.getByText(/^Window 1: /).waitFor({ state: "detached" });
  await neutral(form, "The goal form");
  await shot("goal-form");
  await form.getByRole("button", { name: "Save the goal", exact: true }).click();
  await form.waitFor({ state: "hidden" });
  let wrote = await last();
  assert.equal(wrote.action, "goal.create");
  assert.match(wrote.client_id, /^goal-/, "A client id, so a retried save stays one goal");
  assert.deepEqual(wrote.goal, {
    title: "Both of us get one long stretch",
    why: "Back to work soon",
    target_date: "2026-11-25",
    targets: [{ kind: "bassinet_nights", per_week: 3, min_minutes: 60 }],
    steps: [{ title: "Bassinet after the late feed", week_of: null }],
    roster: [{ member: "sam@example.test", from: "22:00", to: "02:00", nights: [0, 1, 2, 3, 4, 5, 6] }],
  });
  await toast("Sleep goal saved: Both of us get one long stretch").waitFor();
  await plan.waitFor();
  const made = plan.getByRole("region", { name: "Both of us get one long stretch" });
  await made.getByText(/^This week:/).waitFor();
  text = await neutral(made, "A new goal");
  assert(text.includes("Target date Wed, Nov 25 · 28 days left · week 1 of 5"), text);
  assert(text.includes("3 nights a week with a bassinet try asleep 1 hour or more"), text);
  assert(text.includes("This week: counting starts with the goal's first night"), text);
  assert(text.includes("Sam 10:00 PM–2:00 AM"), text);
  assert(text.includes("last night: not yet"), "The owner sees check-ins");
  console.log("PASS Goal form: says what to fix by the field and sends nothing until it's right; saves the goal, its target, step and window; back on Goals with its card");
  await page.keyboard.press("Escape");
  await plan.waitFor({ state: "hidden" });

  // ── Put down: one tap; the fed tag; earlier ──
  await planRow.waitFor();
  assert.match(await planRow.innerText(), /Bassinet try/);
  assert.equal(await upNext.getByRole("group", { name: "Sleep plan", exact: true }).count(), 1, "Awake, the plan's row is in Up next, not on the dock");
  const putDown = planRow.getByRole("button", { name: "Put down", exact: true });
  assert((await height(putDown)) >= 44, "Put down is a 44px target");
  await putDown.click();
  await toast("In the bassinet at 2:10 AM").waitFor();
  let c = await last();
  assert.equal(c.action, "try.start");
  assert.deepEqual(c.tags, ["fed"], "A feed that ended 12 minutes ago pre-ticks Recently fed");
  // One place for her sleep: the try sits at the bottom of the sleep's card, and the plan's row steps aside.
  await asleepCard.getByRole("region", { name: "In the bassinet", exact: true }).waitFor();
  assert.equal(await page.getByRole("region", { name: "In the bassinet", exact: true }).count(), 1, "The try is drawn once, on her sleep's card");
  assert.equal(await planRow.count(), 0, "The plan's row steps aside while a try runs");
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
  assert.match(await upNext.innerText(), /1 of 1 tonight/, "Back in Up next, counted");
  assert.equal(await asleepCard.count(), 0, "The finish stopped her sleep");
  await toast("Stayed asleep after 47 min").getByRole("button", { name: "Undo", exact: true }).click();
  await toast("Undone: the try is running again").waitFor();
  c = await last();
  assert.equal(c.action, "try.undo_finish");
  assert.equal(c.sleep?.was_active, true, "Undo restarts the sleep the finish stopped");
  await asleepCard.getByRole("region", { name: "In the bassinet", exact: true }).waitFor();
  assert.equal(await planRow.count(), 0);
  console.log("PASS Outcome: one tap finishes the try and its sleep; Undo puts both back");

  // ── Woke up elsewhere: the try asks, ending when she woke ──
  await advance(5);
  assert(await page.evaluate(() => window.__sleep.stopSleep()));
  // Her sleep's card is gone, so the open try is a card of its own, asking, with the four outcomes (each ends it then).
  const woke = page.getByRole("region", { name: "She woke at 3:00 AM", exact: true });
  await woke.waitFor();
  assert.equal(await asleepCard.count(), 0);
  assert.equal(await planRow.count(), 0, "No Put down while a try is still open");
  assert.equal(await woke.getByRole("group", { name: "How did it go?" }).getByRole("button").count(), 4);
  await woke.getByRole("button", { name: "Tags, note or an earlier end", exact: true }).click();
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
  // The holding card is the one place for it (it was also a strip on the dock): "I'm getting sleepy" first.
  const mine = page.getByRole("region", { name: "You're holding River", exact: true });
  await mine.waitFor();
  assert.equal(await planRow.count(), 0, "The plan's row steps aside while someone holds her");
  assert.equal(await page.getByRole("button", { name: "I'm getting sleepy", exact: true }).count(), 1, "One I'm getting sleepy on the screen");
  await mine.getByRole("button", { name: "I'm getting sleepy", exact: true }).click();
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

  await page.getByRole("region", { name: "Alex is holding River", exact: true }).getByRole("button", { name: "I'm getting sleepy", exact: true }).click();
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

  // ── A view-only guest: the try, no buttons, no plan row ──
  await page.goto("https://sleep.example.test/?running&role=viewer&night");
  const viewerCard = page.getByRole("region", { name: "In the bassinet" });
  await viewerCard.waitFor();
  assert.equal(await planRow.count(), 0, "No plan row for a view-only guest");
  assert.equal(await viewerCard.getByRole("button").count(), 0, "No outcome buttons for a view-only guest");
  assert.match(await viewerCard.innerText(), /Swaddled/);
  await shot("viewer-night");
  console.log("PASS Viewer: sees the running try (night look), can't log");

  // ── The morning after a night on the roster: Today asks Sam; one tap saves last night's answer; Undo deletes it ──
  await page.goto("https://sleep.example.test/?goals&morning");
  const checkin = page.getByRole("region", { name: "How did last night go?" });
  await checkin.waitFor();
  text = await neutral(checkin, "Today's check-in");
  assert(text.includes("Your protected window, 10:00 PM–2:00 AM"), text);
  assert(text.includes("Did your protected sleep window hold last night?"), text);
  const onCard = checkin.getByRole("group", { name: "Did your protected sleep window hold last night?" }).getByRole("button");
  assert.deepEqual(await onCard.allInnerTexts(), ["Yes", "Partly", "Not this time"]);
  for (let i = 0; i < 3; i++) assert((await height(onCard.nth(i))) >= 44, "The answers are 44px targets");
  await shot("checkin-card");
  await checkin.getByRole("button", { name: "Partly", exact: true }).click();
  await toast("Checked in for last night: partly").waitFor();
  wrote = await last();
  assert.deepEqual([wrote.action, wrote.protected, wrote.night, "note" in wrote], ["checkin.save", "partly", "2026-11-04", false], "Last night (it began Wednesday evening); one tap leaves any note as it is");
  assert.match(wrote.client_id, /^checkin-/);
  await checkin.waitFor({ state: "detached" });
  await toast("Checked in for last night: partly").getByRole("button", { name: "Undo", exact: true }).click();
  await checkin.waitFor();
  wrote = await last();
  assert.equal(wrote.action, "checkin.delete", "Undo deletes the check-in it made");
  assert.deepEqual((await page.evaluate(() => window.__sleep.checkins())).filter((x) => x.member === "sam@example.test" && x.night === "2026-11-04"), []);
  console.log("PASS Check-in card: the morning after, for the adult on the roster; one tap saves last night's answer; Undo deletes it");

  // Not now: hidden for that night on this phone, even after a reload.
  const hiddenKey = "maple-sleep-checkin-hidden:99:sam@example.test";
  await checkin.getByRole("button", { name: "Not now", exact: true }).click();
  await checkin.waitFor({ state: "detached" });
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), hiddenKey), "2026-11-04");
  await page.reload();
  await page.getByRole("button", { name: "Open the sleep plan", exact: true }).waitFor();
  await page.waitForTimeout(300);
  assert.equal(await checkin.count(), 0, "Not now holds for that night on this phone");
  await page.evaluate((k) => localStorage.removeItem(k), hiddenKey);
  await page.reload();
  await checkin.waitFor();

  // Add a note: the sheet, the note, then one tap on a big answer saves both.
  await checkin.getByRole("button", { name: "Add a note", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "How did last night go?", exact: true });
  await sheet.waitFor();
  text = await neutral(sheet, "The check-in sheet");
  assert(text.includes("Last night · Wed, Nov 4 · your window 10:00 PM–2:00 AM"), text);
  assert(text.includes("view-only guests never do"), "It says who sees a check-in");
  await sheet.getByRole("textbox", { name: "Note", exact: true }).fill("Up once, back down quickly");
  const big = sheet.getByRole("group", { name: "Did your protected sleep window hold last night?" }).getByRole("button");
  for (let i = 0; i < 3; i++) assert((await height(big.nth(i))) >= 56, "The sheet's answers are big");
  await shot("checkin-sheet");
  await big.filter({ hasText: /^Yes$/ }).click();
  await sheet.waitFor({ state: "hidden" });
  wrote = await last();
  assert.deepEqual([wrote.action, wrote.protected, wrote.night, wrote.note], ["checkin.save", "yes", "2026-11-04", "Up once, back down quickly"]);
  await toast("Checked in for last night: yes").waitFor();
  assert.equal(await checkin.count(), 0, "Checked in: the card goes");
  console.log("PASS Check-in sheet: a note, then one tap on a big answer saves both; Not now hides the card for that night on this phone");

  // ── The goal card: each target's counts with what they're out of, steps, the roster with hints, each adult's check-ins ──
  await page.getByRole("button", { name: "Open the sleep plan", exact: true }).click();
  await plan.waitFor();
  await plan.getByRole("radio", { name: "Goals", exact: true }).click();
  const goalCard = plan.getByRole("region", { name: "Both of us get one long stretch" });
  await goalCard.getByText(/^This week:/).first().waitFor();
  text = await neutral(goalCard, "The goal card");
  for (const line of [
    "Back to work on the 30th",
    "Target date Wed, Nov 25 · 20 days left · week 2 of 5",
    "4 nights a week with a bassinet try asleep 1 hour or more",
    "This week: 2 of 7 nights so far · tried on 4",
    "Last week: 2 of 7 nights · tried on 3",
    "A bassinet stretch of 3 hours or more",
    "This week: longest 3h 00m · 1 of 4 stretches 3 hours or more",
    "Last week: longest 2h 30m · 0 of 3 stretches 3 hours or more",
    "Sam's protected window holding 5 nights a week",
    "This week: held 4 of 5 nights checked in (not this time 1) · 7 nights on the roster so far",
    "Last week: no check-ins · 7 nights on the roster",
    "Calmer bedtimes",
    "Not counted from the log.",
    "1 of 3 done",
    "Done by Alex",
    "Sam 10:00 PM–2:00 AM",
    "Hint from the log, the last 7 nights it was on: feeds began inside it on 2 nights (2 feeds, 1 logged by Sam); Alex held River during it on 1 night; 3 bassinet tries began inside it.",
    "Alex 2:00 AM–6:00 AM",
    "since Thu, Oct 22",
    "Sam (you)",
    "5 nights: yes 4, not this time 1 · last night: yes",
    "3 nights: yes 2, partly 1 · last night: yes",
  ]) assert(text.includes(line), `The goal card shows "${line}"\n---\n${text}`);
  await shot("goal-card");

  // A step: one tap marks it done on the goal as it is now (no revision); Undo marks it not done.
  const step = goalCard.getByRole("checkbox", { name: /^White noise on for every try/ });
  assert.equal(await step.getAttribute("aria-checked"), "false");
  assert((await height(step)) >= 44, "A step is a 44px target");
  await step.click();
  await toast("Step done: White noise on for every try").waitFor();
  wrote = await last();
  assert.deepEqual([wrote.action, wrote.id, wrote.step, wrote.done, "revision" in wrote], ["goal.step", 301, "s6", true, false]);
  await goalCard.getByText("2 of 3 done", { exact: true }).waitFor();
  assert.equal(await step.getAttribute("aria-checked"), "true");
  await tapToast("Step done: White noise on for every try", "Undo");
  await goalCard.getByText("1 of 3 done", { exact: true }).waitFor();
  wrote = await last();
  assert.deepEqual([wrote.action, wrote.step, wrote.done], ["goal.step", "s6", false]);
  console.log("PASS Goal card: counts with what they're out of, this week and last, steps, roster hints and both adults' check-ins; a step toggles, and Undo toggles it back");

  // Edit: only the field that changed, with the revision this phone has.
  await goalCard.getByRole("button", { name: "Edit", exact: true }).click();
  const editForm = page.getByRole("dialog", { name: "Change the sleep goal", exact: true });
  await editForm.waitFor();
  const title = editForm.getByRole("textbox", { name: "Goal", exact: true });
  const why = editForm.getByRole("textbox", { name: "Why it matters", exact: true });
  assert.equal(await title.inputValue(), "Both of us get one long stretch");
  await title.fill("Both of us get a long stretch, most nights");
  await editForm.getByRole("button", { name: "Save changes", exact: true }).click();
  await editForm.waitFor({ state: "hidden" });
  wrote = await last();
  let server = await page.evaluate(() => window.__sleep.goal(301));
  assert.deepEqual([wrote.action, wrote.id, wrote.patch, wrote.revision], ["goal.update", 301, { title: "Both of us get a long stretch, most nights" }, server.revision - 1], "Only the title, from the revision this phone had");
  await toast("Sleep goal updated").waitFor();
  const renamed = plan.getByRole("region", { name: "Both of us get a long stretch, most nights" });
  await renamed.waitFor();

  // Changed on another phone meanwhile: a 409 shows theirs at once, keeps this person's change on top, and saves on the next Save.
  await renamed.getByRole("button", { name: "Edit", exact: true }).click();
  await editForm.waitFor();
  await why.fill("Back to work on the 30th, both of us");
  await page.evaluate(() => window.__sleep.changeGoal(301, { title: "A long stretch for each of us" }));
  await editForm.getByRole("button", { name: "Save changes", exact: true }).click();
  await editForm.getByRole("alert").filter({ hasText: "Someone changed this goal on another phone just now, so nothing was saved yet." }).waitFor();
  wrote = await last();
  assert.equal(wrote.action, "goal.update");
  server = await page.evaluate(() => window.__sleep.goal(301));
  assert.equal(server.why, "Back to work on the 30th", "Nothing was saved");
  assert.equal(await title.inputValue(), "A long stretch for each of us", "Their title, which this person didn't touch");
  assert.equal(await why.inputValue(), "Back to work on the 30th, both of us", "This person's change, kept");
  await shot("goal-changed-elsewhere");
  await editForm.getByRole("button", { name: "Save changes", exact: true }).click();
  await editForm.waitFor({ state: "hidden" });
  wrote = await last();
  server = await page.evaluate(() => window.__sleep.goal(301));
  assert.deepEqual([wrote.action, wrote.patch, wrote.revision], ["goal.update", { why: "Back to work on the 30th, both of us" }, server.revision - 1], "Only this person's change, on the newer revision");
  assert.deepEqual([server.title, server.why], ["A long stretch for each of us", "Back to work on the 30th, both of us"], "Both changes stand");
  const goalNow = plan.getByRole("region", { name: "A long stretch for each of us" });
  await goalNow.waitFor();
  console.log("PASS Edit: only what changed, with the revision; a 409 applies the other phone's version, keeps this person's change and saves it on top");

  // Talk it through with Maple: the chat, seeded with this goal's review.
  await goalNow.getByRole("button", { name: "Talk it through with Maple", exact: true }).click();
  await plan.waitFor({ state: "hidden" });
  ask = await last();
  assert.deepEqual([ask.action, ask.prompt], ["ask", "Let's review our sleep goal: A long stretch for each of us"]);

  // Close: set aside with a note; it moves to Closed recently; Undo opens it again.
  await page.getByRole("button", { name: "Open the sleep plan", exact: true }).click();
  await plan.waitFor();
  await plan.getByRole("radio", { name: "Goals", exact: true }).click();
  await goalNow.getByRole("button", { name: "Close goal", exact: true }).click();
  const closeBox = goalNow.getByRole("group", { name: "Close this goal" });
  await closeBox.getByRole("textbox", { name: "A note for later", exact: true }).fill("Trying again next month");
  await closeBox.getByRole("button", { name: "Set it aside", exact: true }).click();
  await toast("Set aside: A long stretch for each of us").waitFor();
  wrote = await last();
  assert.deepEqual([wrote.action, wrote.id, wrote.status, wrote.note], ["goal.close", 301, "dropped", "Trying again next month"]);
  await plan.getByRole("heading", { name: "Closed recently", exact: true }).waitFor();
  text = await neutral(plan, "Goals with one set aside");
  assert(text.includes("Set aside on Thu, Nov 5 · Trying again next month"), text);
  await plan.getByRole("button", { name: "Set one yourself", exact: true }).waitFor();
  await tapToast("Set aside: A long stretch for each of us", "Undo");
  await toast("Undone: the goal is open again").waitFor();
  wrote = await last();
  assert.deepEqual([wrote.action, wrote.patch], ["goal.update", { status: "active" }]);
  await goalNow.waitFor();
  console.log("PASS Close: set aside with a note moves it to Closed recently; Undo opens it again");

  // ── 320px: the four tabs on one row, and nothing scrolls sideways ──
  await page.setViewportSize({ width: 320, height: 640 });
  const tops = await plan.getByRole("radiogroup", { name: "Sleep plan" }).getByRole("radio").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  assert.equal(tops.length, 4);
  assert.equal(new Set(tops).size, 1, `Plan, Goals, Guidance and Progress share one row at 320px (${tops})`);
  await noSideScroll(plan, "Goals at 320px");
  await shot("goals-320");
  await goalNow.getByRole("button", { name: "Edit", exact: true }).click();
  await editForm.waitFor();
  await noSideScroll(editForm, "The goal form at 320px");
  await page.keyboard.press("Escape");
  await plan.waitFor();
  await plan.getByRole("radio", { name: "Goals", exact: true }).waitFor();
  // Sam's own check-in from Goals: Change opens the sheet; Remove my check-in deletes it (Undo in its toast) and goes back to Goals.
  await goalNow.getByRole("button", { name: "Change", exact: true }).click();
  await sheet.waitFor();
  await noSideScroll(sheet, "The check-in sheet at 320px");
  assert.equal(await sheet.getByRole("textbox", { name: "Note", exact: true }).inputValue(), "Up once, back down quickly", "The saved note");
  assert.equal(await big.filter({ hasText: /^Yes$/ }).getAttribute("aria-pressed"), "true", "The saved answer");
  await sheet.getByRole("button", { name: "Remove my check-in", exact: true }).click();
  await plan.waitFor();
  wrote = await last();
  assert.equal(wrote.action, "checkin.delete");
  await toast("Check-in removed").waitFor();
  await goalNow.getByText(/last night: not yet/).first().waitFor();
  await page.keyboard.press("Escape");
  await plan.waitFor({ state: "hidden" });
  await checkin.waitFor();
  await noHorizontalScroll("Today's check-in card at 320px");
  await shot("checkin-card-320");
  await page.setViewportSize({ width: 390, height: 844 });
  console.log("PASS 320px: the four tabs share one row; Goals, the form, the check-in sheet and Today's card fit without sideways scroll");

  // ── A view-only guest: goals, steps, the roster and the baby's numbers; never a check-in; nothing that writes ──
  await page.goto("https://sleep.example.test/?goals&morning&role=viewer&night");
  await page.getByRole("button", { name: "Open the sleep plan", exact: true }).click();
  await plan.waitFor();
  assert.equal(await checkin.count(), 0, "No check-in card for a view-only guest");
  await plan.getByRole("radio", { name: "Goals", exact: true }).click();
  const viewerGoal = plan.getByRole("region", { name: "Both of us get one long stretch" });
  await viewerGoal.getByText(/^This week:/).first().waitFor();
  text = await neutral(plan, "Goals for a view-only guest");
  for (const line of ["This week: 2 of 7 nights so far · tried on 4", "This week: longest 3h 00m", "White noise on for every try", "Sam 10:00 PM–2:00 AM", "Hint from the log", "Counted from each adult's own morning check-ins."]) {
    assert(text.includes(line), `A view-only guest sees "${line}"`);
  }
  assert.doesNotMatch(text, /Check-ins|checked in|last night:|\bpartly\b|not this time|held \d/, "Never a check-in, a count of them or an answer");
  assert.equal(await viewerGoal.getByRole("checkbox").count(), 0, "Steps aren't buttons for a view-only guest");
  for (const name of ["Edit", "Close goal", "Talk it through with Maple", "Set one yourself", "Set another with Maple", "Check in", "Change", "Open again"]) {
    assert.equal(await plan.getByRole("button", { name, exact: true }).count(), 0, `No ${name} for a view-only guest`);
  }
  assert.equal(await viewerGoal.getByRole("button", { name: "Ask Maple about it", exact: true }).count(), 1, "Asking about it only reads");
  assert.deepEqual(await actions(), [], "A view-only guest's phone sent no writes");
  await shot("goals-viewer-night");
  console.log("PASS Viewer: goals, steps, the roster and the baby's numbers (night look); no check-ins anywhere and nothing that writes");

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
