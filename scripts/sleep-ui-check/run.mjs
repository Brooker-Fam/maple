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
const mocks = path.join(here, "mocks.jsx");
await build({
  entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", absWorkingDir: root, tsconfig: path.join(root, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"test"' }, logLevel: "warning",
  plugins: [{ name: "synthetic-sleep-boundaries", setup(plugin) {
    // The app's store, clock, timer actions, navigation and openers are the fixture's; everything else is the real code.
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav|ChatNav|useTimerActions|AppNav|sheets)$/ }, (args) => (args.importer === mocks ? undefined : { path: mocks }));
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => (/\/sheets\/[^/]+\.tsx$/.test(args.importer) ? { path: mocks } : undefined));
  } }],
});
const css = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, "src/app/globals.css"), "utf8"), { from: path.join(root, "src/app/globals.css") });
await writeFile(path.join(output, "app.css"), css.css + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
const html = (night) => `<!doctype html><html class="maple-ui${night ? " maple-night" : ""}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link href="/app.css" rel="stylesheet"></head><body class="bg-mp-bg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
const browserName = process.env.REVIEW_BROWSER === "webkit" ? "webkit" : "chromium";
const browser = await ({ chromium, webkit }[browserName]).launch({ headless: true });
const errors = [];
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", hasTouch: true });
await context.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, "https://sleep.example.test", "Every request must remain inside the synthetic fixture");
  assert(!url.pathname.startsWith("/api/"), "No fixture may reach an API");
  const file = url.pathname === "/app.js" ? "app.js" : url.pathname === "/app.css" ? "app.css" : null;
  await route.fulfill({ contentType: file?.endsWith("js") ? "text/javascript" : file ? "text/css" : "text/html", body: file ? await readFile(path.join(output, file)) : html(url.searchParams.has("night")) });
});
const page = await context.newPage();
page.setDefaultTimeout(5000);
page.on("pageerror", (error) => errors.push(error.message));

/** One phone: the page, or a frame of ?phones. Every helper reads through it. */
const phone = (p) => {
  const calls = () => p.evaluate(() => window.__sleep.calls().filter((c) => c.action !== "GET" && c.action !== "OTHER"));
  return {
    p,
    calls,
    last: async () => (await calls()).at(-1),
    since: async (n) => (await calls()).slice(n),
    poll: () => p.evaluate(() => window.__sleep.poll()),
    db: () => p.evaluate(() => window.__sleep.db()),
    strip: p.getByRole("group", { name: "Sleep plan", exact: true }),
    plan: p.getByRole("dialog", { name: "Sleep plan", exact: true }),
    // Today's Sleep plan row (the app's own way in, for every role that reads the log).
    row: p.locator(".maple-app").getByRole("button", { name: /^Sleep plan\b/ }),
    dock: p.getByRole("region", { name: "Log something", exact: true }),
    // Toasts above the dock, or inside an open sheet (ToastHost draws them there).
    toast: (text) => p.locator("[aria-live=polite] > div").filter({ hasText: text }),
  };
};
const sam = phone(page);
const { strip, plan, toast } = sam;
/**
 * A toast was raised, even one the app keeps out of sight: raised while one sheet closes and the next opens, it waits
 * outside the new sheet (ToastHost), as on a phone.
 */
const raised = (text, on = page) =>
  on.waitForFunction((t) => window.__sleep.toasts().some((x) => x.includes(t)), text, { timeout: 5000 });
/** A toast's button (ToastHost draws a toast raised while a sheet is open inside that sheet). */
const tapToast = (text, name) => toast(text).getByRole("button", { name, exact: true }).click();
const advance = (minutes, on = page) => on.evaluate((m) => window.__sleep.advance(m), minutes);
const height = async (locator) => (await locator.boundingBox())?.height ?? 0;
const shot = async (name, on = page) => {
  await page.waitForTimeout(400); // let a sheet finish fading in
  await on.screenshot({ path: path.join(screenshots, `${name}-${browserName}.png`) });
};
const noHorizontalScroll = async (label, on = page) => {
  const over = await on.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
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
  const text = (await clean(locator, label)).replace(/ /g, " ");
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
/** More → a row by its label (More's sleep rows: Put her down now, Log an earlier try, Holding her or Take over, Sleep plan, Sleep goals). */
const more = async (label, on = sam) => {
  await on.dock.getByRole("button", { name: /^More$/ }).click();
  const sheet = on.p.getByRole("dialog", { name: "More to log", exact: true });
  await sheet.waitFor();
  await sheet.getByRole("button", { name: new RegExp(`^${label}`) }).click();
  await sheet.waitFor({ state: "hidden" });
};
/** A button's box sits wholly above the dock (and so isn't under it). */
const aboveDock = async (locator, on = sam) => {
  const box = await locator.boundingBox();
  const dock = await on.dock.boundingBox();
  return !!box && !!dock && box.y + box.height <= dock.y + 0.5;
};

try {
  // ── Set up the plan from More; no row on Today until there is one ──
  await page.goto("https://sleep.example.test/");
  await sam.dock.waitFor();
  assert.equal(await strip.count(), 0, "No strip before there's a plan, a try or a shift");
  assert.equal(await sam.row.count(), 0, "No Sleep plan row on Today before there's a plan or a goal");
  await more("Sleep plan");
  await plan.waitFor();
  assert.match(await plan.innerText(), /River is .+ old/);
  await plan.getByRole("button", { name: "Set up the plan", exact: true }).click();
  await plan.getByText("Stage 1 of 4", { exact: true }).waitFor();
  assert.equal((await sam.last()).action, "plan.create");
  let text = await clean(plan, "The plan");
  assert.match(text, /First tries/);
  assert.match(text, /0 of 1 tonight/);
  // Set up, no try yet: what to do tonight, in the plan's words (never crying it out).
  const firstTry = plan.locator("[data-first-try]");
  await firstTry.getByText("What to do tonight", { exact: true }).waitFor();
  assert.match(await firstTry.innerText(), /The first long night stretch after a feed: once she's deeply asleep, lay her on her back in the bassinet and tap Put down\. If she wakes crying, soothe her and try once more, then pause until the next try\./);
  await shot("plan");
  console.log("PASS Plan: set up from More at stage 1 (one try a day), age from the birth date, and what to do tonight");

  await plan.getByRole("radio", { name: "Guidance", exact: true }).click();
  await plan.getByRole("heading", { name: "Safe sleep", exact: true }).waitFor();
  text = await clean(plan, "Guidance");
  for (const title of ["Safe sleep", "Call the pediatrician", "Call 911"]) assert(text.includes(title), `Guidance shows ${title}`);
  assert.match(text, /If she wakes crying/);
  const articles = plan.locator("article");
  const count = await articles.count();
  assert(count >= 8, `Guidance lists its items (${count})`);
  for (let i = 0; i < count; i++) {
    const links = articles.nth(i).locator("a");
    const hrefs = await links.evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    assert(hrefs.length > 0 && hrefs.every((h) => /^https:\/\//.test(h)), `Guidance item ${i} links its sources`);
    for (const h of await links.evaluateAll((as) => as.map((a) => a.getBoundingClientRect().height))) assert(h >= 44, `A source link is a 44px target (${h}px)`);
  }
  assert.equal(await plan.getByRole("link", { name: "Call 911" }).getAttribute("href"), "tel:911");
  await plan.getByRole("button", { name: "Doctor numbers", exact: true }).click();
  assert.equal((await sam.last()).action, "care.openHelp", "Doctor numbers opens the shared Help sheet");
  assert.match(text, /not medical advice|isn't medical advice|not a substitute/i, "The disclaimer shows");
  await shot("guidance");
  console.log(`PASS Guidance: ${count} sourced items with 44px source links, safe sleep, when to call, 911 link, disclaimer, no banned words`);

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
  let ask = await sam.last();
  assert.equal(ask.action, "ask", "Set a goal with Maple opens the chat, and the sheet steps aside");
  assert.equal(ask.prompt, "Help us set a sleep goal: what we're working toward, a few small weekly steps, and who sleeps when.");
  assert.match(ask.prompt, /\bsleep goal\b/, "The seeded message has the words that load the chat's sleep tools");
  console.log("PASS Goals, none yet: Set a goal with Maple seeds the chat with a sleep goal message; Set one yourself is there too");

  // Back in through Today's Sleep plan row (there's a plan now).
  await sam.row.click();
  await plan.waitFor();
  await plan.getByRole("radio", { name: "Goals", exact: true }).click();
  await plan.getByRole("button", { name: "Set one yourself", exact: true }).click();
  const form = page.getByRole("dialog", { name: "New sleep goal", exact: true });
  await form.waitFor();
  let sent = (await sam.calls()).length;
  await form.getByRole("button", { name: "Save the goal", exact: true }).click();
  await form.getByText("The goal's title is needed.", { exact: true }).waitFor();
  assert.equal((await sam.calls()).length, sent, "Nothing is sent while the form has something to fix");
  await form.getByRole("textbox", { name: "Goal", exact: true }).fill("Both of us get one long stretch");
  await form.getByText("The goal's title is needed.", { exact: true }).waitFor({ state: "detached" });
  await form.getByRole("textbox", { name: "Why it matters", exact: true }).fill("Back to work soon");
  await form.getByLabel("Target date", { exact: true }).fill("2026-11-25");
  await form.getByText("Wed, Nov 25, 28 days from today", { exact: true }).waitFor();
  await form.getByRole("button", { name: "Add a target: Bassinet nights", exact: true }).click();
  await form.getByRole("button", { name: "Add a step", exact: true }).click();
  // A plan Maple won't make: nothing shows while it's typed; Save says what to try instead, by the step, and sends nothing.
  const step1 = form.getByRole("textbox", { name: "Step 1", exact: true });
  await step1.fill("Let her nap in the swing after lunch");
  await page.waitForTimeout(200);
  assert.equal(await form.locator("[data-goal-problem]").count(), 0, "No refusal while it's being typed");
  sent = (await sam.calls()).length;
  await form.getByRole("button", { name: "Save the goal", exact: true }).click();
  const refusal = form.getByRole("group", { name: "Step 1", exact: true }).getByText(`Step 1: Maple won't plan sleep in a swing; try "If she falls asleep in the swing, move her to the bassinet".`, { exact: true });
  await refusal.waitFor();
  assert.equal((await sam.calls()).length, sent, "A refusal sends nothing");
  assert.doesNotMatch(await form.innerText(), /never leave|Reword it/, "Help, not a lecture");
  await shot("goal-form-refusal");
  await step1.fill("Bassinet after the late feed");
  await refusal.waitFor({ state: "detached" });
  await form.getByRole("button", { name: "Add a window", exact: true }).click();
  // A window under 30 minutes: the rules' words show by the window at once, and Save sends nothing.
  await form.getByLabel("Window 1 to", { exact: true }).fill("22:15");
  await form.getByText("Window 1: a protected window is 30 minutes to 12 hours long.", { exact: true }).waitFor();
  sent = (await sam.calls()).length;
  await form.getByRole("button", { name: "Save the goal", exact: true }).click();
  assert.equal((await sam.calls()).length, sent, "Still nothing sent");
  await form.getByLabel("Window 1 to", { exact: true }).fill("02:00");
  await form.getByText(/^Window 1: /).waitFor({ state: "detached" });
  // How her feeds in that window are covered: one tap, with what it means.
  await form.getByRole("group", { name: "Window 1: feeds in it" }).getByRole("button", { name: "Nursing", exact: true }).click();
  await form.getByText("She nurses: whoever's on duty brings her to nurse, then settles her.", { exact: true }).waitFor();
  // A second window: the other adult, from where the first ends, on its nights, and no overlap flagged before anyone sets it.
  await form.getByRole("button", { name: "Add a window", exact: true }).click();
  const w2 = form.getByRole("group", { name: "Window 2", exact: true });
  await w2.waitFor();
  assert.equal(await w2.getByRole("group", { name: "Window 2: who sleeps" }).getByRole("button", { name: "Alex", exact: true }).getAttribute("aria-pressed"), "true", "The other adult");
  assert.equal(await form.getByLabel("Window 2 from", { exact: true }).inputValue(), "02:00", "Starts where window 1 ends");
  assert.equal(await form.getByLabel("Window 2 to", { exact: true }).inputValue(), "06:00", "Four hours on");
  assert.equal(await form.locator("[data-goal-problem]").count(), 0, "No overlap or other error before anyone touches it");
  assert.match(await w2.innerText(), /A night goes by its evening: on Sun night this is 2:00 AM early Mon\./, "Which nights, said plainly for a window after midnight");
  // Moved onto window 1's hours for the same adult: now the overlap shows, on the window just moved.
  await w2.getByRole("group", { name: "Window 2: who sleeps" }).getByRole("button", { name: "Me", exact: true }).click();
  await form.getByLabel("Window 2 from", { exact: true }).fill("23:00");
  await w2.getByText(/^Windows 1 and 2 overlap for Sam/).waitFor();
  await w2.getByRole("group", { name: "Window 2: who sleeps" }).getByRole("button", { name: "Alex", exact: true }).click();
  await form.getByLabel("Window 2 from", { exact: true }).fill("02:00");
  await form.locator("[data-goal-problem]").first().waitFor({ state: "detached" });
  await neutral(form, "The goal form");
  await shot("goal-form");
  await form.getByRole("button", { name: "Save the goal", exact: true }).click();
  await form.waitFor({ state: "hidden" });
  let wrote = await sam.last();
  assert.equal(wrote.action, "goal.create");
  assert.match(wrote.client_id, /^goal-/, "A client id, so a retried save stays one goal");
  assert.deepEqual(wrote.goal, {
    title: "Both of us get one long stretch",
    why: "Back to work soon",
    target_date: "2026-11-25",
    targets: [{ kind: "bassinet_nights", per_week: 3, min_minutes: 60 }],
    steps: [{ title: "Bassinet after the late feed", week_of: null }],
    roster: [
      { member: "sam@example.test", from: "22:00", to: "02:00", nights: [0, 1, 2, 3, 4, 5, 6], covers: "nurse" },
      { member: "alex@example.test", from: "02:00", to: "06:00", nights: [0, 1, 2, 3, 4, 5, 6] },
    ],
  });
  await raised("Sleep goal saved: Both of us get one long stretch");
  await plan.waitFor();
  const made = plan.getByRole("region", { name: "Both of us get one long stretch" });
  await made.getByText(/^This week:/).first().waitFor();
  text = await neutral(made, "A new goal");
  assert(text.includes("Target date Wed, Nov 25 · 28 days left · week 1 of 4"), text);
  assert(text.includes("3 nights a week with a bassinet try asleep 1 hour or more"), text);
  assert(text.includes("Sam 10:00 PM–2:00 AM"), text);
  assert(text.includes("Alex 2:00 AM–6:00 AM"), text);
  assert(text.includes("Sam (you)") && text.includes("no check-ins yet"), "The owner sees check-ins");
  // Set in the night: nobody is asked about the night before it.
  assert(!text.includes("last night: not yet") && (await made.getByRole("button", { name: "Check in", exact: true }).count()) === 0, "No check-in for a night before the goal");
  console.log("PASS Goal form: says what to fix by the field (a plan Maple won't make only on Save, with a wording to try); a window's feeds; a new window defaults to the other adult from where the last one ends, with no early overlap error; saves the goal");
  await page.keyboard.press("Escape");
  await plan.waitFor({ state: "hidden" });

  // ── Put down: one tap (a double tap is still one), the fed tag, earlier; one card for one sleep ──
  await strip.waitFor();
  assert.match(await strip.innerText(), /Bassinet try/);
  const putDown = strip.getByRole("button", { name: "Put down", exact: true });
  assert((await height(putDown)) >= 44, "Put down is a 44px target");
  assert((await height(strip.getByRole("button", { name: /Open the sleep plan/ }))) >= 44, "The strip's words are a 44px target too");
  const before = (await sam.calls()).length;
  await putDown.dblclick();
  await toast("In the bassinet at 2:10 AM").waitFor();
  await page.waitForTimeout(300);
  assert.deepEqual((await sam.since(before)).map((c) => c.action), ["try.start"], "A double tap on Put down lays her down once");
  assert.equal(await page.getByRole("dialog", { name: "How did it go?" }).count(), 0, "…and never opens How did it go?");
  let c = await sam.last();
  assert.deepEqual(c.tags, ["fed"], "A feed that ended 12 minutes ago pre-ticks Recently fed");
  assert.match(await strip.innerText(), /In the bassinet/);
  // While she's down, How did it go? is the strip's strong button: its sheet's outcomes sit in thumb reach (the card's are at the top).
  assert.match(await strip.getByRole("button", { name: "How did it go?", exact: true }).locator("span").getAttribute("class"), /bg-mp-accent/, "How did it go? is the strong button");
  await page.getByRole("button", { name: "Laid down 2 minutes earlier, at 2:08 AM", exact: true }).click();
  await toast("Laid down at 2:08 AM").waitFor();
  c = await sam.last();
  assert.equal(c.action, "try.update");
  assert.equal(c.started_at, "2026-10-28T06:08:00.000Z");
  const card = page.getByRole("region", { name: "In the bassinet" });
  await card.waitFor();
  assert.equal(await page.getByRole("region", { name: "Asleep timer" }).count(), 0, "One sleep, one card: the try's sleep has no timer card of its own");
  const outcomes = card.getByRole("group", { name: "How did it go?" }).getByRole("button");
  assert.equal(await outcomes.count(), 4, "Four outcomes on the card");
  for (let i = 0; i < 4; i++) assert((await height(outcomes.nth(i))) >= 56, "Outcome buttons are big");
  assert.match(await card.innerText(), /try 1 tonight/);
  await shot("try-running");
  // Asked for tags or a note, How did it go? opens with its details out.
  await card.getByRole("button", { name: "Tags, note or an earlier end", exact: true }).click();
  const withDetails = page.getByRole("dialog", { name: "How did it go?", exact: true });
  await withDetails.getByRole("group", { name: "Ended" }).waitFor();
  assert.equal(await withDetails.getByRole("button", { name: /^Add details/ }).getAttribute("aria-expanded"), "true");
  await page.keyboard.press("Escape");
  await withDetails.waitFor({ state: "hidden" });
  // At 320x568 the four outcomes clear the dock.
  await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  for (let i = 0; i < 4; i++) assert(await aboveDock(outcomes.nth(i)), `Outcome ${i + 1} sits above the dock at 320x568`);
  await shot("try-running-320x568");
  await page.setViewportSize({ width: 390, height: 844 });
  // The card's header opens the plan.
  await card.getByRole("button", { name: "In the bassinet. Open the sleep plan." }).click();
  await plan.waitFor();
  await page.keyboard.press("Escape");
  await plan.waitFor({ state: "hidden" });
  console.log("PASS Put down: one tap (a double tap is one), fed pre-ticked, two minutes earlier, one card for the sleep, four big outcomes clear of the dock at 320x568");

  // ── How did it go: one tap, then Undo ──
  await advance(45);
  await card.getByRole("button", { name: /^Stayed asleep/ }).click();
  await toast("Stayed asleep after 47 min. Sleep timer stopped.").waitFor();
  c = await sam.last();
  assert.equal(c.action, "try.finish");
  assert.equal(c.outcome, "stayed_asleep");
  assert.match(await strip.innerText(), /1 of 1 tonight/);
  // The plan's try for tonight is done: Put down is still there, but quiet.
  assert.doesNotMatch(await strip.getByRole("button", { name: "Put down", exact: true }).locator("span").getAttribute("class"), /bg-mp-accent/, "After 1 of 1, Put down isn't the strong action");
  await shot("after-1-of-1");
  await toast("Stayed asleep after 47 min").getByRole("button", { name: "Undo", exact: true }).click();
  await toast("Undone: the try is running again").waitFor();
  c = await sam.last();
  assert.equal(c.action, "try.undo_finish");
  assert.equal(c.sleep?.was_active, true, "Undo restarts the sleep the finish stopped");
  assert.match(await strip.innerText(), /In the bassinet/);
  console.log("PASS Outcome: one tap finishes the try and its sleep; Undo puts both back");

  // ── Woke up elsewhere: the outcomes first; a crying wake says soothe, then try once more; the retry, pause ──
  await advance(5);
  assert(await page.evaluate(() => window.__sleep.stopSleep()));
  await strip.getByText("She woke at 3:00 AM").waitFor();
  await strip.getByRole("button", { name: "How did it go?", exact: true }).click();
  const outcome = page.getByRole("dialog", { name: "How did it go?", exact: true });
  await outcome.waitFor();
  assert.match(await outcome.innerText(), /She woke at 3:00 AM\. The try ends then\./);
  const details = outcome.getByRole("button", { name: /^Add details/ });
  assert.equal(await details.getAttribute("aria-expanded"), "false", "Tags and a note wait under Add details");
  const [gridTop, detailsTop] = [await outcome.getByRole("group", { name: "How did it go?" }).boundingBox(), await details.boundingBox()];
  assert(gridTop.y < detailsTop.y, "The four outcomes come first");
  await details.click();
  await outcome.getByRole("group", { name: "Tags" }).waitFor();
  assert.equal(await outcome.getByRole("textbox", { name: "Note", exact: true }).count(), 1, "The note field has a name");
  await shot("outcome-sheet");
  await outcome.getByRole("button", { name: /^Woke crying/ }).click();
  await outcome.waitFor({ state: "hidden" });
  c = await sam.last();
  assert.deepEqual([c.action, c.outcome, c.at], ["try.finish", "woke_crying", "2026-10-28T07:00:00.000Z"], "The try ends when the sleep did");
  assert.equal(await toast("already ended").count(), 0, "This phone's own outcome closes its sheet without an 'already ended' notice");
  await toast("Woke crying after 52 min. Soothe her; try once more when she's deeply asleep.").waitFor();
  await strip.getByText("Soothe her; try once more when she's deeply asleep").waitFor();
  const tryAgain = strip.getByRole("button", { name: "Try again", exact: true });
  await shot("after-crying");
  // At 320 the crying line is whole (three lines when it needs them), never "…when she's...".
  await page.setViewportSize({ width: 320, height: 568 });
  await page.waitForTimeout(200);
  const cryWords = strip.getByRole("button", { name: /Open the sleep plan/ }).locator("span.line-clamp-3");
  assert(await cryWords.evaluate((el) => el.scrollHeight <= el.clientHeight + 1), "The crying line isn't cut at 320");
  await shot("after-crying-320x568");
  await page.setViewportSize({ width: 390, height: 844 });
  await advance(10);
  await tryAgain.click();
  await toast("try 2 tonight, a retry").waitFor();
  assert.equal((await sam.last()).action, "try.start");
  await advance(6);
  await page.getByRole("region", { name: "In the bassinet" }).getByRole("button", { name: /^Woke crying/ }).click();
  await toast("Woke crying after 6 min. Sleep timer stopped. Pause until the next try.").waitFor();
  await strip.getByText("Pause until the next try").waitFor();
  const quiet = strip.getByRole("button", { name: "Put down", exact: true });
  assert.doesNotMatch(await quiet.locator("span").getAttribute("class"), /bg-mp-accent/, "Put down is the soft button after the retry");
  await shot("after-retry");
  console.log("PASS Crying: outcomes first (details folded, the note named); after a crying wake the strip and toast say soothe and Try again; after the retry, pause, with Put down soft");

  // ── Holding her: asleep in arms; I'm getting sleepy only for the holder; Wake Alex only asks ──
  await more("Holding her");
  const holding = page.getByRole("dialog", { name: "Holding River", exact: true });
  await holding.waitFor();
  await clean(holding, "Holding");
  for (const name of ["Who's holding", "Planned handoff", "Who's next"]) assert.equal(await holding.getByRole("group", { name, exact: true }).count(), 1, `The ${name} chips are one named group`);
  await holding.getByRole("button", { name: "Asleep in arms", exact: true }).click();
  await holding.getByText(/Logs her sleep in arms from now/).waitFor();
  // The goal saved above has Alex's protected window 2–6 AM: two hours on (5:16 AM) would wake Alex inside it, so its end comes first.
  const planned = holding.getByRole("group", { name: "Planned handoff" }).getByRole("button", { name: "6:00 AM · after Alex's protected sleep", exact: true });
  assert.equal(await planned.getAttribute("aria-pressed"), "true", "The window's end, preselected");
  await holding.getByRole("group", { name: "Planned handoff" }).getByRole("button", { name: /^In 2h · 5:16 AM/ }).click();
  await holding.locator("[data-handoff-window]").filter({ hasText: "5:16 AM is inside Alex's protected sleep (2:00–6:00 AM) on the roster." }).waitFor();
  await shot("holding-start-roster");
  await planned.click();
  await holding.locator("[data-handoff-window]").waitFor({ state: "detached" });
  await holding.getByRole("button", { name: "Start", exact: true }).click();
  await holding.waitFor({ state: "hidden" });
  c = await sam.last();
  assert.deepEqual([c.action, c.holder, c.next_holder, c.handoff_at, c.asleep], ["shift.start", "sam@example.test", "alex@example.test", "2026-10-28T10:00:00.000Z", true], "Planned for the end of Alex's window, asleep in arms");
  await toast(/Holding her · handoff 6:00 AM · asleep in arms since 3:16 AM/).waitFor();
  let arms = (await sam.db()).entries.find((e) => e.kind === "sleep" && e.active);
  assert.equal(arms?.data.place, "arms", "A sleep in arms runs");
  // Asleep in arms: one card (the turn's; her sleep's timer card steps aside), and the strip's action is Put her down, in thumb reach.
  assert.match(await strip.innerText(), /Asleep in your arms · since 3:16 AM/);
  const putHerDown = strip.getByRole("button", { name: "Put her down", exact: true });
  await putHerDown.waitFor();
  assert.equal(await strip.getByRole("button", { name: "I'm getting sleepy" }).count(), 0, "I'm getting sleepy moves to the card");
  const armsTurn = page.getByRole("region", { name: "You're holding River" });
  await armsTurn.getByText(/^Asleep in arms since 3:16 AM · /).waitFor();
  await page.getByRole("region", { name: "Asleep timer" }).waitFor({ state: "detached" });
  await armsTurn.getByRole("button", { name: "I'm getting sleepy", exact: true }).waitFor();
  await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  assert(await strip.getByRole("button", { name: /Open the sleep plan/ }).locator("span.line-clamp-3").evaluate((el) => el.scrollHeight <= el.clientHeight + 1), "The strip's words fit at 320");
  assert((await putHerDown.boundingBox()).x + (await putHerDown.boundingBox()).width <= 320, "Put her down fits at 320");
  await noHorizontalScroll("Asleep in arms at 320px");
  await shot("asleep-in-arms-320x568");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("asleep-in-arms");
  // Her sleep's own times, from the turn's card (its timer card's Edit times).
  await armsTurn.getByRole("button", { name: "Edit sleep", exact: true }).click();
  c = await sam.last();
  assert.deepEqual([c.action, c.args?.[0]?.kind, c.args?.[0]?.entry?.id], ["sheets.open", "sleep", arms.id], "Edit sleep opens her sleep");
  await armsTurn.getByRole("button", { name: "I'm getting sleepy", exact: true }).click();
  const sleepy = page.getByRole("dialog", { name: "Getting sleepy?", exact: true });
  await sleepy.waitFor();
  text = await clean(sleepy, "Getting sleepy");
  const choices = sleepy.getByRole("button").filter({ hasText: /bassinet now|^Wake/ });
  assert.equal(await choices.count(), 2, "Exactly two choices");
  assert.deepEqual((await choices.allInnerTexts()).map((t) => t.split("\n")[0]), ["Put her in the bassinet now", "Wake Alex"]);
  assert.equal(await sleepy.getByRole("button").count(), 3, "Two choices and the close button, nothing else");
  for (const box of await choices.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) assert(box >= 64, "Both choices are big");
  await shot("getting-sleepy");
  sent = (await sam.calls()).length;
  await sleepy.getByRole("button", { name: /^Wake Alex/ }).click();
  const waking = page.getByRole("dialog", { name: "Waking Alex…", exact: true });
  await waking.waitFor();
  assert.deepEqual((await sam.since(sent)).map((x) => [x.action, x.to]), [["shift.ask", "alex@example.test"]], "Waking Alex asks; it doesn't hand her over");
  text = await clean(waking, "Waking Alex");
  assert(text.includes("Alex's phone only sounds if handoff reminders are on. Go wake Alex."), text);
  const bassinetNow = waking.getByRole("button", { name: /^Put her in the bassinet now/ });
  assert((await height(bassinetNow)) >= 64, "The bassinet stays the big button");
  assert.equal(await waking.getByRole("button", { name: "Alex has her", exact: true }).count(), 1);
  await toast("Asked Alex to take over").waitFor();
  assert.equal((await sam.db()).shifts.find((x) => !x.ended_at).holder, "sam@example.test", "Sam is still recorded holding her");
  await shot("waking-alex");
  await toast("Asked Alex to take over").getByRole("button", { name: "Undo", exact: true }).click();
  await sleepy.waitFor();
  assert.equal((await sam.last()).action, "shift.cancel_ask", "Undo takes the ask back");
  await sleepy.getByRole("button", { name: /^Wake Alex/ }).click();
  await waking.waitFor();
  // Ten minutes and nobody took over: the two safe choices again, never "keep holding".
  await advance(11);
  await sleepy.getByText("Nobody has taken over yet (11 min since you asked Alex).").waitFor();
  // (Eleven minutes on, the ask's toast has timed out; let it finish leaving.)
  await sleepy.getByRole("button", { name: "Undo" }).first().waitFor({ state: "detached" });
  const again = sleepy.getByRole("button").filter({ hasText: /bassinet now|^Wake/ });
  assert.deepEqual((await again.allInnerTexts()).map((t) => t.split("\n")[0]), ["Put her in the bassinet now", "Wake Alex again"], "The two safe choices again");
  assert.equal(await sleepy.getByRole("button").count(), 3, "And nothing else");
  await clean(sleepy, "Ten minutes on");
  await shot("nobody-took-over");
  await page.keyboard.press("Escape");
  await sleepy.waitFor({ state: "hidden" });
  assert.match(await strip.innerText(), /Nobody has taken over yet/);
  const turn = page.getByRole("region", { name: "Nobody has taken over yet" });
  await turn.getByRole("button", { name: "Wake Alex again" }).click();
  assert.equal((await sam.last()).action, "shift.ask");
  // Alex arrives: the holder says so.
  await strip.getByRole("button", { name: "Alex has her", exact: true }).click();
  c = await sam.last();
  assert.deepEqual([c.action, c.to], ["shift.handoff", "alex@example.test"]);
  await toast(/^Alex has her now · next handoff/).waitFor();
  assert.equal((await sam.db()).entries.find((e) => e.id === arms.id)?.active, true, "Her sleep in arms runs on through the handoff");
  // Sam isn't holding her now: no I'm getting sleepy anywhere on Sam's phone; Take over instead.
  assert.match(await strip.innerText(), /Alex is holding her/);
  await strip.getByRole("button", { name: "Take over", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /I'm getting sleepy/ }).count(), 0, "Only the person holding her gets I'm getting sleepy");
  await shot("after-handoff-sam");
  await toast(/^Alex has her now/).getByRole("button", { name: "Undo", exact: true }).click();
  await strip.getByText(/Waking Alex…|You're holding her|Nobody has taken over yet/).first().waitFor();
  assert.equal((await sam.last()).action, "shift.undo_handoff");
  console.log("PASS Holding: the planned handoff's default skips the next holder's protected window (picking a time inside it says so); asleep in arms is one card, with Put her down on the strip (it fits at 320) and I'm getting sleepy and Edit sleep on the card; Wake Alex only asks (Undo takes it back) and keeps the bassinet big; ten minutes on, the two safe choices again; Alex has her records it; then Sam sees Take over, never I'm getting sleepy");

  // Into the bassinet from the turn: the try sits on her sleep in arms, and the card is that sleep's card.
  await strip.getByRole("button", { name: /I'm getting sleepy|Alex has her/ }).first().waitFor();
  await page.getByRole("region", { name: /Waking Alex…|Nobody has taken over yet|You're holding River/ }).getByRole("button", { name: /Put her in the bassinet now|Into the bassinet/ }).first().click();
  await toast(/^In the bassinet at/).waitFor();
  c = await sam.last();
  assert.equal(c.action, "try.start");
  let db = await sam.db();
  const onArms = db.tries.find((t) => !t.ended_at);
  assert.deepEqual([onArms.sleep_entry_id, onArms.made_sleep], [arms.id, false], "The try sits on her sleep in arms");
  assert.equal(db.shifts.filter((x) => !x.ended_at).length, 0, "Into the bassinet ends the turn");
  const armsCard = page.getByRole("region", { name: "In the bassinet" });
  await armsCard.getByText(/Asleep since 3:16 AM \(in arms first\)/).waitFor();
  // One sleep, one card: the sleep in arms's own timer card steps aside (once its exit has run).
  await page.getByRole("region", { name: "Asleep timer" }).waitFor({ state: "detached" });
  await armsCard.getByRole("button", { name: /^Stayed asleep/ }).click();
  await toast(/^Stayed asleep after/).waitFor();
  console.log("PASS Asleep in arms: into the bassinet links the try to it, and the try's card is that sleep's only card");

  // ── An earlier try nobody started: the duplicate question by its buttons ──
  await more("Log an earlier try");
  const log = page.getByRole("dialog", { name: "Log an earlier try", exact: true });
  await log.waitFor();
  assert.equal(await log.getByRole("textbox", { name: "Note", exact: true }).count(), 1, "The note field has a name");
  await log.getByRole("group", { name: "How it went" }).getByRole("button", { name: "Woke crying", exact: true }).click();
  await log.getByRole("button", { name: "Save", exact: true }).click();
  const twin = log.getByRole("alert").filter({ hasText: "is already logged. Is this the same one? Nothing is saved yet." });
  await twin.waitFor();
  assert((await twin.boundingBox()).y + 10 > (await log.getByRole("button", { name: "Save anyway", exact: true }).boundingBox()).y - 120, "The question sits by its buttons, in the footer");
  assert.equal((await sam.last()).allow_duplicate, false);
  await log.getByRole("button", { name: "Same one, close", exact: true }).waitFor();
  await shot("log-twin");
  await log.getByRole("button", { name: "Save anyway", exact: true }).click();
  await log.waitFor({ state: "hidden" });
  c = await sam.last();
  assert.deepEqual([c.action, c.allow_duplicate, c.outcome], ["try.log", true, "woke_crying"]);
  await toast("Try saved: woke crying").waitFor();
  console.log("PASS Earlier try: More has it as a row; a likely twin asks in the footer (Same one, close / Save anyway)");

  // ── Correct a try's time from the plan's recent tries ──
  await sam.row.click();
  await plan.waitFor();
  await plan.getByRole("button", { name: /^Woke crying · 52 min/ }).click();
  const edit = page.getByRole("dialog", { name: "Bassinet try", exact: true });
  await edit.waitFor();
  assert.equal(await edit.getByRole("textbox", { name: "Note", exact: true }).count(), 1, "The note field has a name");
  await edit.getByRole("group", { name: "Laid down" }).getByRole("button", { name: "5 min earlier", exact: true }).click();
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await edit.waitFor({ state: "hidden" });
  c = await sam.last();
  assert.equal(c.action, "try.update");
  assert.equal(c.started_at, "2026-10-28T06:03:00.000Z", "Five minutes earlier than 2:08 AM");
  assert.equal(c.ended_at, undefined, "Only the time that moved is sent");
  await toast("Try updated").waitFor();
  console.log("PASS Edit: a finished try's laid-down time moves by the nudges and saves only that");

  // ── Progress after a few tries: sample sizes ──
  await sam.row.click();
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

  // ── The plan editor keeps its draft through another phone's change (a poll, then a 409) ──
  await plan.getByRole("radio", { name: "Plan", exact: true }).click();
  await plan.getByRole("button", { name: "Change the plan" }).click();
  await plan.getByRole("group", { name: "Stage" }).getByRole("button", { name: /^2 · / }).click();
  await page.evaluate(() => window.__sleep.changePlan({ goal: "Bassinet most nights" }));
  await page.evaluate(() => window.__sleep.poll());
  const editorAlert = plan.getByRole("alert").filter({ hasText: "Alex changed the plan on another phone just now. This shows their version, with your changes kept on top." });
  await editorAlert.waitFor();
  assert.equal(await plan.getByRole("group", { name: "Stage" }).getByRole("button", { name: /^2 · / }).getAttribute("aria-pressed"), "true", "The stage change survives the poll");
  assert.equal(await plan.getByRole("textbox", { name: "Your goal" }).inputValue(), "Bassinet most nights", "Their goal shows");
  await plan.getByText("Alex changed this on another phone").waitFor();
  // Changed again on the other phone, not polled: Save is a 409, the editor stays, and the next Save goes on top.
  await page.evaluate(() => window.__sleep.changePlan({ sleeps_now: "bassinet" }));
  await plan.getByRole("button", { name: "Save the plan", exact: true }).click();
  await plan.getByRole("alert").filter({ hasText: "so nothing was saved yet" }).waitFor();
  assert.equal(await plan.getByRole("group", { name: "Stage" }).getByRole("button", { name: /^2 · / }).getAttribute("aria-pressed"), "true", "Still the stage change, after the 409");
  await shot("plan-editor-409");
  await plan.getByRole("button", { name: "Save the plan", exact: true }).click();
  await plan.getByRole("button", { name: "Change the plan" }).waitFor();
  c = await sam.last();
  assert.deepEqual([c.action, c.patch.stage], ["plan.update", 2], "Saved on top of theirs");
  db = await sam.db();
  assert.deepEqual([db.plan.stage, db.plan.goal, db.plan.sleeps_now], [2, "Bassinet most nights", "bassinet"], "Both phones' changes stand");
  await page.setViewportSize({ width: 320, height: 640 });
  await noHorizontalScroll("Plan at 320px");
  await plan.getByRole("radio", { name: "Guidance", exact: true }).click();
  await noHorizontalScroll("Guidance at 320px");
  await page.keyboard.press("Escape");
  await noHorizontalScroll("Today at 320px");
  await page.setViewportSize({ width: 390, height: 844 });
  console.log("PASS Progress and the plan editor: counts with sample sizes; the draft survives a poll and a 409, marked and rebased; 320px fits");

  // ── A view-only guest: the Sleep plan row and the card's header open the plan; nothing writes ──
  await page.goto("https://sleep.example.test/?running&role=viewer&night");
  const viewerCard = page.getByRole("region", { name: "In the bassinet" });
  await viewerCard.waitFor();
  assert.equal(await strip.count(), 0, "No strip for a view-only guest");
  assert.deepEqual(await viewerCard.getByRole("button").allInnerTexts().then((t) => t.length), 1, "Only the header, which opens the plan");
  assert.match(await viewerCard.innerText(), /Swaddled/);
  await shot("viewer-night");
  await viewerCard.getByRole("button", { name: "In the bassinet. Open the sleep plan." }).click();
  await plan.waitFor();
  assert.equal(await plan.getByRole("button", { name: "Change the plan" }).count(), 0, "Nothing to change");
  await page.keyboard.press("Escape");
  await plan.waitFor({ state: "hidden" });
  await sam.row.click();
  await plan.waitFor();
  await plan.getByRole("radio", { name: "Goals", exact: true }).click();
  await plan.getByRole("radio", { name: "Goals", exact: true, checked: true }).waitFor();
  // Someone holding her, seen by a view-only guest: who and since when, and the header into the plan; nothing to tap that writes.
  await page.goto("https://sleep.example.test/?holding&role=viewer");
  const viewerTurn = page.getByRole("region", { name: "Sam is holding River" });
  await viewerTurn.waitFor();
  assert.deepEqual(await viewerTurn.getByRole("button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label"))), ["Sam is holding River. Open the sleep plan."], "Only the header");
  assert.equal(await page.getByRole("button", { name: /I'm getting sleepy|Take over/ }).count(), 0, "No sleepy sheet or take over for a view-only guest");
  console.log("PASS Viewer: the Sleep plan row and the try and turn cards' headers reach the plan and goals; no strip, no writes");

  // ── The morning after: "since last night", not "tonight"; Put her down now; last night's try in one tap ──
  await page.goto("https://sleep.example.test/?goals&morning&lastnight");
  await strip.waitFor();
  // Last night sits straight after Right now, above the Sleep plan row: at 390 × 844 its question clears the dock as Today opens.
  const lastCard = page.getByRole("region", { name: "Last night", exact: true });
  const QUESTION_TOP = "Did you get your 10 PM–2 AM sleep?";
  await lastCard.waitFor();
  const rowBox = await sam.row.boundingBox();
  assert((await lastCard.boundingBox()).y < rowBox.y, "Last night comes before the Sleep plan row");
  for (const b of await lastCard.getByRole("group", { name: QUESTION_TOP }).getByRole("button").all()) assert(await aboveDock(b), "The check-in's answers clear the dock at 390 × 844, no scrolling");
  await shot("morning-today");
  // From 5 AM the strip carries the card's first question; Answer brings the card into view with focus on its first answer.
  text = await strip.innerText();
  assert.match(text, /Did you get your 10 PM–2 AM sleep\? · last night/, `The strip carries the card's question: ${text}`);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  const stripWords = strip.getByRole("button", { name: /Open the sleep plan/ }).locator("span.line-clamp-3");
  assert(await stripWords.evaluate((el) => el.scrollHeight <= el.clientHeight + 1), "The strip's words aren't cut at 320");
  await shot("morning-strip-question-320x568");
  await strip.getByRole("button", { name: "Answer", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === "Yes" && !!document.activeElement.closest("[data-last-night]"));
  await page.waitForTimeout(600);
  for (const b of await lastCard.getByRole("group", { name: QUESTION_TOP }).getByRole("button").all()) assert(await aboveDock(b), "Answer: the check-in's answers on screen above the dock at 320 × 568");
  await shot("morning-answer-320x568");
  await page.setViewportSize({ width: 390, height: 844 });
  // Not now: the card goes for the night on this phone, and the strip says the plan's count again.
  await lastCard.getByRole("button", { name: "Not now", exact: true }).click();
  await lastCard.waitFor({ state: "detached" });
  text = await strip.innerText();
  assert.match(text, /\d of 1 since last night/, `At 7:30 AM the strip says since last night: ${text}`);
  assert.doesNotMatch(text, /tonight/);
  assert(await stripWords.evaluate((el) => el.scrollHeight <= el.clientHeight + 1), "The strip's words aren't cut");
  await page.evaluate(() => localStorage.clear());
  await sam.dock.getByRole("button", { name: /^More$/ }).click();
  const moreSheet = page.getByRole("dialog", { name: "More to log", exact: true });
  await moreSheet.waitFor();
  assert.equal(await moreSheet.getByRole("button", { name: /^Bassinet try/ }).count(), 0, "No ambiguous Bassinet try");
  await moreSheet.getByRole("button", { name: /^Put her down now/ }).waitFor();
  await moreSheet.getByRole("button", { name: /^Log an earlier try/ }).click();
  await moreSheet.waitFor({ state: "hidden" });
  await log.waitFor();
  const fromLog = log.getByRole("group", { name: "From the log" });
  await fromLog.getByRole("button", { name: /^Sleep 2:30 AM to 5:10 AM, in arms/ }).click();
  // A chip's times fold the time fields into one line, so How it went is in view (at 390 and 320).
  await log.locator("[data-try-times]").filter({ hasText: "Laid down 2:30, ended 5:10 AM" }).waitFor();
  assert.equal(await log.getByLabel("Laid down: time").count(), 0, "The time fields fold away");
  const howItWent = log.getByRole("group", { name: "How it went" });
  const inView = async (label) => {
    const b = await howItWent.boundingBox();
    const vh = page.viewportSize().height;
    assert(b && b.y >= 0 && b.y + 44 <= vh, `${label}: How it went is in view (${JSON.stringify(b)})`);
  };
  await inView("390 × 844");
  await shot("log-chip-filled");
  await page.setViewportSize({ width: 320, height: 568 });
  await page.waitForTimeout(200);
  await inView("320 × 568");
  await noSideScroll(log, "Log an earlier try at 320px");
  await shot("log-chip-filled-320x568");
  await page.setViewportSize({ width: 390, height: 844 });
  await log.getByRole("button", { name: "Change times", exact: true }).click();
  assert.equal(await log.getByLabel("Laid down: time").inputValue(), "02:30");
  assert.equal(await log.getByLabel("Ended: time").inputValue(), "05:10");
  // A clock later than now reads as last night's; a time that can't be, in words, not 2026-11-05.
  await log.getByLabel("Laid down: time").fill("23:30");
  assert.equal(await log.getByLabel("Laid down: date").inputValue(), "2026-11-04", "11:30 PM at 7:30 AM is last night's");
  await log.getByLabel("Ended: time").fill("07:45");
  const said = await log.getByRole("alert").filter({ hasText: /^Choose / }).first().innerText();
  assert.match(said, /^Choose today at 7:3\d AM or earlier\.$/, `A human date, never 2026-11-05: ${said}`);
  await log.getByLabel("Ended: time").fill("01:20");
  await log.getByRole("group", { name: "How it went" }).getByRole("button", { name: "Stayed asleep", exact: true }).click();
  await shot("log-last-night");
  await log.getByRole("button", { name: "Save", exact: true }).click();
  await log.getByRole("alert").filter({ hasText: "Is this the same one?" }).waitFor();
  await log.getByRole("button", { name: "Same one, close", exact: true }).click();
  await log.waitFor({ state: "hidden" });
  c = await sam.last();
  assert.deepEqual([c.action, c.started_at, c.ended_at, c.allow_duplicate], ["try.log", "2026-11-05T04:30:00.000Z", "2026-11-05T06:20:00.000Z", false], "Same one: nothing saved");
  console.log("PASS Morning: the strip says since last night (not cut at 2 lines), More says Put her down now and has Log an earlier try; last night's sleep fills both times; a later clock reads as last night; errors say today");

  // ── The morning after a night on the roster: Today's Last night card asks Sam; one tap saves last night's answer; Undo deletes it ──
  await page.goto("https://sleep.example.test/?goals&morning");
  const checkin = page.getByRole("region", { name: "Last night", exact: true });
  await checkin.waitFor();
  text = await neutral(checkin, "Today's Last night card");
  const QUESTION = "Did you get your 10 PM–2 AM sleep?";
  assert(text.includes(QUESTION) && !/\bhold/i.test(text), `The question names the window and never says "hold": ${text}`);
  assert(text.includes("Wed, Nov 4") && /8:00 PM\s+1 sleep · 2 feeds · 1 diaper\s+now/.test(text), text);
  assert.equal(await checkin.locator("[data-night-strip]").count(), 1, "The night as a strip from the log");
  assert.equal(await checkin.locator("[data-night-strip]").getAttribute("aria-label"), "1 sleep, 2 feeds and 1 diaper logged between 8:00 PM and 7:30 AM; nothing logged 1:20–6:40 AM.", "The strip in words");
  const onCard = checkin.getByRole("group", { name: QUESTION }).getByRole("button");
  assert.deepEqual(await onCard.allInnerTexts(), ["Yes", "Partly", "Not this time"]);
  for (let i = 0; i < 3; i++) assert((await height(onCard.nth(i))) >= 44, "The answers are 44px targets");
  await shot("checkin-card");
  await checkin.getByRole("button", { name: "Partly", exact: true }).click();
  // Its receipt and Undo in the card, never a toast over the next question.
  const receipt = checkin.locator("[data-last-night-receipt]");
  await receipt.filter({ hasText: "Checked in: partly" }).waitFor();
  assert.equal(await toast("Checked in for last night").count(), 0, "No toast for the card's own answer");
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.protected, wrote.night, "note" in wrote], ["checkin.save", "partly", "2026-11-04", false], "Last night (it began Wednesday evening); one tap leaves any note as it is");
  assert.match(wrote.client_id, /^checkin-/);
  // The night's next question takes its place: the stretch with nothing logged between the 1:20 AM wake and the 6:40 AM diaper,
  // named by whose protected window it mostly was, with Not sure first.
  const gapAsk = checkin.locator("[aria-labelledby='last-night-ask']");
  await gapAsk.getByRole("heading", { name: "Nothing logged 1:20–6:40 AM" }).waitFor();
  assert.equal(await gapAsk.getByText("5h 20m · mostly Alex's window", { exact: true }).count(), 1, "Whose window it was");
  assert.deepEqual(await gapAsk.getByRole("button").allInnerTexts(), ["Not sure", "Up or feeding", "She slept through"], "Not sure first; one stretch, so nothing to skip");
  await shot("checkin-receipt");
  await checkin.getByRole("button", { name: "Undo", exact: true }).click();
  await checkin.getByRole("group", { name: QUESTION }).waitFor();
  await receipt.waitFor({ state: "detached" });
  wrote = await sam.last();
  assert.equal(wrote.action, "checkin.delete", "Undo deletes the check-in it made");
  assert.deepEqual((await page.evaluate(() => window.__sleep.checkins())).filter((x) => x.member === "sam@example.test" && x.night === "2026-11-04"), []);
  console.log("PASS Last night card: the morning after, for the adult on the roster, worded without \"hold\"; one tap saves last night's answer; Undo deletes it");

  // Not now: hidden for that night on this phone, even after a reload.
  const hiddenKey = "maple-last-night:99:sam@example.test";
  await checkin.getByRole("button", { name: "Not now", exact: true }).click();
  await checkin.waitFor({ state: "detached" });
  assert.deepEqual(JSON.parse(await page.evaluate((k) => localStorage.getItem(k), hiddenKey)), { night: "2026-11-04", hidden: true });
  await page.reload();
  await sam.dock.waitFor();
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
  assert(text.includes(QUESTION) && !/\bhold/i.test(text), text);
  assert(text.includes("view-only guests never do"), "It says who sees a check-in");
  await sheet.getByRole("textbox", { name: "Note", exact: true }).fill("Up once, back down quickly");
  const big = sheet.getByRole("group", { name: QUESTION }).getByRole("button");
  for (let i = 0; i < 3; i++) assert((await height(big.nth(i))) >= 56, "The sheet's answers are big");
  await shot("checkin-sheet");
  await big.filter({ hasText: /^Yes$/ }).click();
  await sheet.waitFor({ state: "hidden" });
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.protected, wrote.night, wrote.note], ["checkin.save", "yes", "2026-11-04", "Up once, back down quickly"]);
  // Its receipt comes back to the card (with its Undo), never a toast over the next question.
  await receipt.filter({ hasText: "Checked in: yes, with a note" }).waitFor();
  assert.equal(await toast("Checked in").count(), 0, "No toast for the note saved from the card");
  console.log("PASS Check-in sheet: a note, then one tap on a big answer saves both; Not now hides the card for that night on this phone");

  // The stretch with nothing logged: Up or feeding saves nothing; then the night's other questions, one tap each, on Sam's own
  // check-in: where River spent it, then the 2 AM handoff the roster planned.
  const n0 = (await sam.calls()).length;
  await checkin.getByRole("heading", { name: "Nothing logged 1:20–6:40 AM" }).waitFor();
  await checkin.getByRole("button", { name: "Up or feeding", exact: true }).click();
  const place = checkin.getByRole("region", { name: "Where did River spend most of last night?" });
  await place.waitFor();
  assert.equal((await sam.calls()).length, n0, "Up or feeding saves nothing");
  // Every sleep last night has a place in the log (the try's bassinet): prefilled, to confirm, or Something else for all five.
  assert.equal(await place.getByText("From the log: mostly the bassinet. Right?").count(), 1, "Prefilled from the log");
  assert.deepEqual(await place.getByRole("button").allInnerTexts(), ["Yes, the bassinet", "Something else"]);
  await shot("place-prefill");
  await page.setViewportSize({ width: 320, height: 568 });
  await checkin.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(200);
  for (const name of ["Yes, the bassinet", "Something else"]) assert(await aboveDock(place.getByRole("button", { name, exact: true })), `${name} clears the dock at 320 × 568`);
  await noHorizontalScroll("The place prefill at 320px");
  await shot("place-prefill-320x568");
  await page.setViewportSize({ width: 390, height: 844 });
  await place.getByRole("button", { name: "Something else", exact: true }).click();
  assert.deepEqual(await place.getByRole("button").allInnerTexts(), ["Bassinet", "Held by someone awake", "Some of each", "Somewhere else", "Not sure"]);
  await place.getByRole("button", { name: "Bassinet", exact: true }).click();
  await receipt.filter({ hasText: "Saved: bassinet" }).waitFor();
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.protected, wrote.place, wrote.night, "note" in wrote], ["checkin.save", "yes", "bassinet", "2026-11-04", false], "On Sam's own check-in, the answer and note it has kept");
  assert.equal(await checkin.getByText("Any bassinet try that isn't in the log?").count(), 0, "A try is in the log for last night, so it isn't asked");
  const handoff = checkin.getByRole("region", { name: "Did the 2:00 AM handoff happen as planned?" });
  await handoff.waitFor();
  assert.deepEqual(await handoff.getByRole("button").allInnerTexts(), ["On time", "Early", "Late", "No handoff"]);
  await handoff.getByRole("button", { name: "Late", exact: true }).click();
  await toast("Saved: late").waitFor();
  await checkin.waitFor({ state: "detached" });
  const mine = (await page.evaluate(() => window.__sleep.checkins())).find((x) => x.member === "sam@example.test" && x.night === "2026-11-04");
  assert.deepEqual([mine.protected, mine.note, mine.place, mine.handoff], ["yes", "Up once, back down quickly", "bassinet", "late"], "All of it on Sam's check-in");
  console.log("PASS The night's other questions: where the baby spent it and the planned handoff, one tap each on the adult's own check-in; a try in the log isn't asked about; then the card goes");

  // ── The goal card: each target's counts with what they're out of, steps, the roster with hints, each adult's check-ins ──
  await sam.row.click();
  await plan.waitFor();
  await plan.getByRole("radio", { name: "Goals", exact: true }).click();
  const goalCard = plan.getByRole("region", { name: "Both of us get one long stretch" });
  // Thursday morning, the goal's week 2 ended last night (its 14th night) while week 3's step is already the next one: the counts
  // name their week ("Week 2 (ended last night)"), so "this week" never means two weeks at once (coach round 2's N7).
  await goalCard.getByText(/^Week 2 \(ended last night\):/).first().waitFor();
  text = await neutral(goalCard, "The goal card");
  assert(!/This week:|Last week:|so far/.test(text), `On the morning after, no "this week" or "so far" for a week that's over\n---\n${text}`);
  for (const line of [
    "Back to work on the 30th",
    "Target date Wed, Nov 25 · 20 days left · week 2 of 5",
    "4 nights a week with a bassinet try asleep 1 hour or more",
    // Monday night has only a holding turn and check-ins about the adults' own sleep: nothing about the bassinet, so not known.
    "Week 2 (ended last night): 2 of the 4 nights aimed for · 2 of 4 nights logged or answered · 3 not logged (1 with only feeds or other entries)",
    "Week 1: 2 of the 4 nights aimed for · 2 of 3 nights logged or answered · 4 not logged",
    "A bassinet stretch of 3 hours or more",
    "Week 2 (ended last night): longest 3h 00m · 1 of 4 stretches 3 hours or more",
    "Week 1: longest 2h 30m · 0 of 3 stretches 3 hours or more",
    "Sam's protected sleep, 5 nights a week",
    "Week 2 (ended last night): yes on 4 of the 5 nights aimed for · checked in 5 of 7 roster nights (not this time 1)",
    "Logged week 2 (ended last night): something on 5 of 7 nights (5 with a gap of 4 hours or more) · feeds on 2 · tries on 4 · check-ins on 5",
    "Week 1: no check-ins · 7 nights on the roster",
    "Calmer bedtimes",
    "Not counted from the log.",
    "1 of 3 done",
    "Done by Alex",
    "Sam 10:00 PM–2:00 AM",
    "Hint from the log, the last 7 nights it was on: feeds began inside it on 2 of 7 nights (2 feeds: 1 nursing logged by Alex, 1 nursing logged by Sam); nothing logged inside it on 2 of them; Alex held River during it on 1 night; 3 bassinet tries began inside it.",
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
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.id, wrote.step, wrote.done, "revision" in wrote], ["goal.step", 301, "s6", true, false]);
  await goalCard.getByText("2 of 3 done", { exact: true }).waitFor();
  assert.equal(await step.getAttribute("aria-checked"), "true");
  await tapToast("Step done: White noise on for every try", "Undo");
  await goalCard.getByText("1 of 3 done", { exact: true }).waitFor();
  wrote = await sam.last();
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
  wrote = await sam.last();
  let server = await page.evaluate(() => window.__sleep.goal(301));
  assert.deepEqual([wrote.action, wrote.id, wrote.patch, wrote.revision], ["goal.update", 301, { title: "Both of us get a long stretch, most nights" }, server.revision - 1], "Only the title, from the revision this phone had");
  await raised("Sleep goal updated");
  const renamed = plan.getByRole("region", { name: "Both of us get a long stretch, most nights" });
  await renamed.waitFor();

  // Changed on another phone meanwhile: a 409 shows theirs at once, keeps this person's change on top, and saves on the next Save.
  await renamed.getByRole("button", { name: "Edit", exact: true }).click();
  await editForm.waitFor();
  await why.fill("Back to work on the 30th, both of us");
  await page.evaluate(() =>
    window.__sleep.changeGoal(301, {
      title: "A long stretch for each of us",
      roster: [
        { id: "w8", member: "sam@example.test", from: "22:30", to: "02:00", nights: [0, 1, 2, 3, 4, 5, 6] },
        { id: "w9", member: "alex@example.test", from: "02:00", to: "06:00", nights: [0, 1, 2, 3, 4, 5, 6] },
      ],
    })
  );
  // Saved from the footer, at the bottom of a tall form, as a person would.
  await editForm.getByRole("button", { name: "Save changes", exact: true }).click();
  const goalAlert = editForm.getByRole("alert").filter({ hasText: "Someone changed this goal on another phone just now, so nothing was saved yet." });
  await goalAlert.waitFor();
  await page.waitForTimeout(300);
  const alertBox = await goalAlert.boundingBox();
  assert(alertBox && alertBox.y >= 0 && alertBox.y + alertBox.height <= 844, `The alert scrolls into view (${alertBox?.y})`);
  await editForm.getByText("Alex changed this goal on another phone. Look it over, then save again.").waitFor();
  await editForm.getByText("Alex changed this: “A long stretch for each of us”").waitFor();
  await editForm.getByText("Alex changed this: 10:30 PM–2:00 AM").waitFor();
  wrote = await sam.last();
  assert.equal(wrote.action, "goal.update");
  server = await page.evaluate(() => window.__sleep.goal(301));
  assert.equal(server.why, "Back to work on the 30th", "Nothing was saved");
  assert.equal(await title.inputValue(), "A long stretch for each of us", "Their title, which this person didn't touch");
  assert.equal(await why.inputValue(), "Back to work on the 30th, both of us", "This person's change, kept");
  await shot("goal-changed-elsewhere");
  await editForm.getByRole("button", { name: "Save changes", exact: true }).click();
  await editForm.waitFor({ state: "hidden" });
  wrote = await sam.last();
  server = await page.evaluate(() => window.__sleep.goal(301));
  assert.deepEqual([wrote.action, wrote.patch, wrote.revision], ["goal.update", { why: "Back to work on the 30th, both of us" }, server.revision - 1], "Only this person's change, on the newer revision");
  assert.deepEqual([server.title, server.why], ["A long stretch for each of us", "Back to work on the 30th, both of us"], "Both changes stand");
  const goalNow = plan.getByRole("region", { name: "A long stretch for each of us" });
  await goalNow.waitFor();
  console.log("PASS Edit: only what changed, with the revision; a 409 scrolls its notice into view, repeats it by Save, marks what the other phone changed (Alex changed this: …), keeps this person's change and saves it on top");

  // Talk it through with Maple: the chat, seeded with this goal's review.
  await goalNow.getByRole("button", { name: "Talk it through with Maple", exact: true }).click();
  await plan.waitFor({ state: "hidden" });
  ask = await sam.last();
  assert.deepEqual([ask.action, ask.prompt], ["ask", "Let's review our sleep goal: A long stretch for each of us"]);

  // Close: set aside with a note; it moves to Closed recently; Undo opens it again.
  await sam.row.click();
  await plan.waitFor();
  await plan.getByRole("radio", { name: "Goals", exact: true }).click();
  await goalNow.getByRole("button", { name: "Close goal", exact: true }).click();
  const closeBox = goalNow.getByRole("group", { name: "Close this goal" });
  await closeBox.getByRole("textbox", { name: "A note for later", exact: true }).fill("Trying again next month");
  await closeBox.getByRole("button", { name: "Set it aside", exact: true }).click();
  await toast("Set aside: A long stretch for each of us").waitFor();
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.id, wrote.status, wrote.note], ["goal.close", 301, "dropped", "Trying again next month"]);
  await plan.getByRole("heading", { name: "Closed recently", exact: true }).waitFor();
  text = await neutral(plan, "Goals with one set aside");
  assert(text.includes("Set aside on Thu, Nov 5 · Trying again next month"), text);
  await plan.getByRole("button", { name: "Set one yourself", exact: true }).waitFor();
  await tapToast("Set aside: A long stretch for each of us", "Undo");
  await toast("Undone: the goal is open again").waitFor();
  wrote = await sam.last();
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
  // The question follows the roster: Alex's change moved Sam's window to 10:30 PM.
  const bigNow = sheet.getByRole("group", { name: "Did you get your 10:30 PM–2 AM sleep?" }).getByRole("button");
  assert.equal(await bigNow.filter({ hasText: /^Yes$/ }).getAttribute("aria-pressed"), "true", "The saved answer");
  await sheet.getByRole("button", { name: "Remove my check-in", exact: true }).click();
  await plan.waitFor();
  wrote = await sam.last();
  assert.equal(wrote.action, "checkin.delete");
  await raised("Check-in removed");
  await goalNow.getByText(/last night: not yet/).first().waitFor();
  await page.keyboard.press("Escape");
  await plan.waitFor({ state: "hidden" });
  await checkin.waitFor();
  await noHorizontalScroll("Today's check-in card at 320px");
  await shot("checkin-card-320");
  await page.setViewportSize({ width: 390, height: 844 });
  console.log("PASS 320px: the four tabs share one row; Goals, the form, the check-in sheet and Today's card fit without sideways scroll");

  // ── A timer left running overnight, at 390 × 844: Today opens on its card, which asks Woke at above the dock ──
  await page.goto("https://sleep.example.test/?goals&morning&sparse");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const timer390 = page.getByRole("region", { name: "Asleep timer" }).locator("[data-woke-ask]");
  await timer390.getByText("A feed was logged at 6:30 AM. Did she wake then?").waitFor();
  for (const name of ["Woke at 6:30 AM", "Still asleep"]) assert(await aboveDock(timer390.getByRole("button", { name, exact: true })), `${name} clears the dock at 390 × 844`);
  await shot("timer-left-running-390");

  // ── Last night on a sparse log: a timer left running, three stretches with nothing logged, Tell Maple, all on a 320 × 568 phone ──
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("https://sleep.example.test/?goals&morning&sparse");
  // A fresh phone: the stretch answered earlier on this one (from 1:20 AM) is remembered per phone, per night.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const night = page.getByRole("region", { name: "Last night", exact: true });
  await night.waitFor();
  /** The card's essentials on a small phone, scrolled to: its heading, the strip, the question and its answers, and Not now, all on screen above the dock at once. */
  const essentials = async (label) => {
    await night.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(150);
    for (const part of [night.getByRole("heading", { name: "Last night", exact: true }), night.locator("[data-night-strip]"), night.locator("[aria-labelledby='last-night-ask']"), night.getByRole("button", { name: "Not now", exact: true })]) {
      const b = await part.boundingBox();
      assert(b && b.y >= 0 && (await aboveDock(part)), `${label}: on screen above the dock at 320 × 568 (${JSON.stringify(b)}, dock ${JSON.stringify(await sam.dock.boundingBox())})`);
    }
    await noHorizontalScroll(`${label} at 320px`);
  };
  text = await neutral(night, "Last night, a sparse log");
  assert(text.includes("The sleep timer is still running from 4:45 AM") && text.includes("A feed was logged at 6:30 AM."), text);
  // The timer left running asks on its own card too (Today opens on it), its answers above the dock at 320 × 568 with no scrolling.
  const timerCard = page.getByRole("region", { name: "Asleep timer" });
  const timerAsk = timerCard.locator("[data-woke-ask]");
  await timerAsk.getByText("A feed was logged at 6:30 AM. Did she wake then?").waitFor();
  for (const name of ["Woke at 6:30 AM", "Still asleep"]) assert(await aboveDock(timerAsk.getByRole("button", { name, exact: true })), `${name} on the timer's card clears the dock at 320 × 568`);
  // And the strip carries it: one tap from the dock.
  assert.match(await strip.innerText(), /Still asleep since 4:45 AM\?/);
  await shot("timer-left-running-320");
  await essentials("A timer left running");
  await shot("last-night-running-320");
  await strip.getByRole("button", { name: "Woke at 6:30 AM", exact: true }).click();
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.at], ["stop", "2026-11-05T11:30:00.000Z"], "Stops the sleep when the next thing was logged");
  await timerCard.waitFor({ state: "detached" });
  await night.getByRole("group", { name: "Did you get your 10 PM–2 AM sleep?" }).waitFor();
  await essentials("The check-in");
  await night.getByRole("button", { name: "Yes", exact: true }).click();
  // The answer's receipt is in the card: no toast sits on the next question's chips at 320.
  const sparseReceipt = night.locator("[data-last-night-receipt]");
  await sparseReceipt.filter({ hasText: "Checked in: yes" }).waitFor();
  assert.equal(await page.locator("[aria-live=polite] > div").count(), 0, "No toast over the next question at 320");

  // The two longest stretches with nothing logged, between two things that were, each named by whose window it was, Not sure first.
  const gap = night.locator("[aria-labelledby='last-night-ask']");
  await gap.getByRole("heading", { name: "Nothing logged 8:50–11:00 PM" }).waitFor();
  assert.equal(await gap.getByText("2h 10m · partly your window", { exact: true }).count(), 1, "Whose window");
  assert.deepEqual(await gap.getByRole("button").allInnerTexts(), ["Not sure", "Up or feeding", "She slept through", "Skip the rest"]);
  await essentials("A stretch with nothing logged");
  await shot("last-night-gap-320");
  const beforeGaps = (await sam.calls()).length;
  await gap.getByRole("button", { name: "Not sure", exact: true }).click();
  await sparseReceipt.filter({ hasText: "Left out of the counts" }).waitFor();
  assert.equal((await sam.calls()).length, beforeGaps, "Not sure saves nothing");
  // 1:20–3:00 AM (1h 40m) is the shortest of three: not asked.
  await gap.getByRole("heading", { name: "Nothing logged 3:00–4:45 AM" }).waitFor();
  assert.equal(await gap.getByText("1h 45m · Alex's window", { exact: true }).count(), 1, "Alex's window");
  assert.deepEqual(await gap.getByRole("button").allInnerTexts(), ["Not sure", "Up or feeding", "She slept through"], "The last one: nothing to skip");
  await gap.getByRole("button", { name: "She slept through", exact: true }).click();
  await sparseReceipt.filter({ hasText: "Logged: asleep 3:00–4:45 AM" }).waitFor();
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.kind, wrote.started_at, wrote.ended_at], ["log", "sleep", "2026-11-05T08:00:00.000Z", "2026-11-05T09:45:00.000Z"], "A sleep for that stretch");
  assert.equal(await page.locator("[aria-live=polite] > div").count(), 0, "Still no toast");
  await shot("last-night-receipt-320");
  // Its Undo: the sleep goes, and the stretch is asked again.
  await night.getByRole("button", { name: "Undo", exact: true }).click();
  await gap.getByRole("heading", { name: "Nothing logged 3:00–4:45 AM" }).waitFor();
  wrote = await sam.last();
  assert.equal(wrote.action, "remove", "Undo removes the sleep it logged");
  await gap.getByRole("button", { name: "She slept through", exact: true }).click();
  await sparseReceipt.filter({ hasText: "Logged: asleep 3:00–4:45 AM" }).waitFor();

  // Somewhere else (not every sleep has a place, so nothing is prefilled): the safe-sleep line, in the guidance's own words; then the planned handoff.
  const where = night.getByRole("region", { name: "Where did River spend most of last night?" });
  await where.getByRole("button", { name: "Bassinet", exact: true }).waitFor();
  assert.deepEqual(await where.getByRole("button").allInnerTexts(), ["Bassinet", "Held by someone awake", "Some of each", "Somewhere else", "Not sure"], "No prefill when a sleep has no place");
  await where.getByRole("button", { name: "Somewhere else", exact: true }).click();
  await sparseReceipt.filter({ hasText: "Saved: somewhere else" }).waitFor();
  await night.locator("[data-safe-sleep]").waitFor();
  assert.match(await night.locator("[data-safe-sleep]").innerText(), /^Lay her on her back for every nap and at night\. Keep her bassinet in your room, close to your bed but not in it/);
  await night.getByRole("region", { name: "Did the 2:00 AM handoff happen as planned?" }).getByRole("button", { name: "No handoff", exact: true }).click();
  await sparseReceipt.filter({ hasText: "Saved: no handoff" }).waitFor();
  const samSaid = (await page.evaluate(() => window.__sleep.checkins())).find((x) => x.member === "sam@example.test" && x.night === "2026-11-04");
  assert.deepEqual([samSaid.protected, samSaid.place, samSaid.handoff], ["yes", "elsewhere", "none"]);
  await shot("last-night-safe-sleep-320");

  // Tell Maple: the chat, with "Last night: " typed for them.
  await night.getByRole("button", { name: "Tell Maple", exact: true }).click();
  ask = await sam.last();
  assert.deepEqual([ask.action, ask.prompt], ["ask", "Last night: "]);
  await night.getByRole("button", { name: "Not now", exact: true }).click();
  await night.waitFor({ state: "detached" });

  // Skip the rest: on a fresh phone, the first stretch's Skip the rest answers both, and saves nothing.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await night.waitFor();
  await night.getByRole("button", { name: "Woke at 6:30 AM", exact: true }).click();
  await night.getByRole("button", { name: "Yes", exact: true }).click();
  await gap.getByRole("heading", { name: "Nothing logged 8:50–11:00 PM" }).waitFor();
  const beforeSkip = (await sam.calls()).length;
  await gap.getByRole("button", { name: "Skip the rest of the stretches", exact: true }).click();
  await night.getByRole("region", { name: "Where did River spend most of last night?" }).waitFor();
  await sparseReceipt.filter({ hasText: "Skipped: left out of the counts" }).waitFor();
  assert.equal((await sam.calls()).length, beforeSkip, "Skip the rest saves nothing");
  await page.setViewportSize({ width: 390, height: 844 });
  console.log("PASS Last night: a timer left running asks on its own card and the strip (one tap stops it at the next thing logged); only the two longest stretches are asked, each naming whose window it was, Not sure first, with Skip the rest; receipts and Undo stay in the card, never a toast over the next question at 320; the place question lists all five when a sleep has no place; Somewhere else shows the safe-sleep line; Tell Maple seeds the chat; essentials fit above the dock at 320 × 568");

  // The night strip in the night look: every bar wears the kind fill (dim amber), never the day's bright lavender and orange.
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("https://sleep.example.test/?goals&morning&sparse&night");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await night.waitFor();
  const bars = night.locator("[data-night-strip] [data-bar]");
  assert((await bars.count()) >= 4, "The night's bars");
  const fills = await bars.evaluateAll((els) => els.map((el) => [el.className.includes("mp-kind-fill"), getComputedStyle(el).backgroundColor]));
  for (const [has, color] of fills) assert(has && color === "rgba(224, 169, 59, 0.45)", `A bar in the night look is the dim amber fill (${color})`);
  await night.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await shot("last-night-strip-night-320");
  await page.setViewportSize({ width: 390, height: 844 });
  await night.evaluate((el) => el.scrollIntoView({ block: "start" }));
  assert.deepEqual([...new Set(await bars.evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor)))], ["rgba(224, 169, 59, 0.45)"], "The same at 390");
  await shot("last-night-strip-night-390");
  console.log("PASS Night look: the Last night strip's bars are the kind fill's dim amber, at 320 and 390");

  // ── A view-only guest: goals, steps, the roster and the baby's numbers; never a check-in; nothing that writes ──
  await page.goto("https://sleep.example.test/?goals&morning&role=viewer&night");
  await sam.row.click();
  await plan.waitFor();
  assert.equal(await checkin.count(), 0, "No check-in card for a view-only guest");
  await plan.getByRole("radio", { name: "Goals", exact: true }).click();
  const viewerGoal = plan.getByRole("region", { name: "Both of us get one long stretch" });
  await viewerGoal.getByText(/^Week 2 \(ended last night\):/).first().waitFor();
  text = await neutral(plan, "Goals for a view-only guest");
  // Without the adults' check-ins, Sunday night (a holding turn, no try or sleep) says nothing about the bassinet: one more night not logged.
  for (const line of ["Week 2 (ended last night): 2 of the 4 nights aimed for · 2 of 4 nights logged · 3 not logged (1 with only feeds or other entries)", "Logged week 2 (ended last night): something on 5 of 7 nights (5 with a gap of 4 hours or more) · feeds on 2 · tries on 4", "Week 2 (ended last night): longest 3h 00m", "White noise on for every try", "Sam 10:00 PM–2:00 AM", "Hint from the log", "Counted from each adult's own morning check-ins."]) {
    assert(text.includes(line), `A view-only guest sees "${line}"`);
  }
  assert.doesNotMatch(text, /Check-ins|checked in|last night:|\bpartly\b|not this time|held \d/, "Never a check-in, a count of them or an answer");
  assert.equal(await viewerGoal.getByRole("checkbox").count(), 0, "Steps aren't buttons for a view-only guest");
  for (const name of ["Edit", "Close goal", "Talk it through with Maple", "Set one yourself", "Set another with Maple", "Check in", "Change", "Open again", "More for this goal"]) {
    assert.equal(await plan.getByRole("button", { name, exact: true }).count(), 0, `No ${name} for a view-only guest`);
  }
  assert.equal(await viewerGoal.getByRole("button", { name: "Ask Maple about it", exact: true }).count(), 1, "Asking about it only reads");
  assert.deepEqual((await sam.calls()).map((x) => x.action), [], "A view-only guest's phone sent no writes");
  await shot("goals-viewer-night");
  console.log("PASS Viewer: goals, steps, the roster and the baby's numbers through the Sleep plan row (night look); no check-ins anywhere and nothing that writes");

  // ── Round 3: light logging, a quiet stretch's clean restart, and the weekly look-back ──
  const lastNight = page.getByRole("region", { name: "Last night", exact: true });
  const cardReceipt = lastNight.locator("[data-last-night-receipt]");
  /** A new card's screens for review: 390 × 844 and 320 × 568, by day and in the night look (its colors), then back as it was. */
  const screens = async (name, locator) => {
    const wasNight = await page.evaluate(() => document.documentElement.classList.contains("maple-night"));
    for (const [width, h] of [[390, 844], [320, 568]]) {
      await page.setViewportSize({ width, height: h });
      for (const night of [false, true]) {
        await page.evaluate((on) => document.documentElement.classList.toggle("maple-night", on), night);
        await locator.evaluate((el) => el.scrollIntoView({ block: "start" }));
        await noHorizontalScroll(`${name} at ${width}px`);
        await shot(`r3-${name}-${width}x${h}-${night ? "night" : "day"}`);
      }
    }
    await page.evaluate((on) => document.documentElement.classList.toggle("maple-night", on), wasNight);
    await page.setViewportSize({ width: 390, height: 844 });
  };

  // A family who answers only in the morning: their answers are the counts' sample, never "nothing logged" or "Only".
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("https://sleep.example.test/?mornings&morning");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await sam.row.click();
  await plan.waitFor();
  await plan.getByRole("radio", { name: "Goals", exact: true }).click();
  const morningGoal = plan.getByRole("region", { name: "Bassinet nights, and sleep for both of us" });
  await morningGoal.locator("[data-goal-coverage]").waitFor();
  text = await neutral(morningGoal, "A goal counted from morning check-ins");
  for (const line of [
    "Week 1 (ended last night): 3 of the 4 nights aimed for (3 from check-ins) · tried on 6 of 7 nights",
    "Week 1 (ended last night): yes on 4 of the 5 nights aimed for · checked in 6 of 7 roster nights (partly 1, not this time 1)",
    "Week 1 (ended last night): no overnight logs; these come from morning check-ins on 7 nights",
  ]) assert(text.includes(line), `The goal card shows "${line}"\n---\n${text}`);
  assert.doesNotMatch(text, /\bOnly\b|anything logged|too few/, "The morning answers are plenty: no \"Only\", nothing too few");
  assert((await neutral(plan, "Goals")).includes("Three logged nights a week is enough; on the other nights, the morning check-in is plenty."), "The coverage note says how little is enough");
  await shot("goal-card-mornings");
  await screens("goal-card-mornings", morningGoal);
  await page.keyboard.press("Escape");
  await plan.waitFor({ state: "hidden" });

  // Its review morning: after Sam's check-in, Week 1's look-back ends the Last night card, every count with what it's out of.
  await lastNight.getByRole("group", { name: "Did you get your 10 PM–2 AM sleep?" }).getByRole("button", { name: "Yes", exact: true }).click();
  await cardReceipt.filter({ hasText: "Checked in: yes" }).waitFor();
  const look = lastNight.locator("[data-look-back]");
  await look.getByRole("heading", { name: "Week 1 look-back", exact: true }).waitFor();
  text = await neutral(look, "The look-back");
  for (const line of [
    "Bassinet nights: 3 of the 4 aimed for (3 from check-ins) · 7 nights answered in the morning",
    "Sam's protected sleep: yes on 5 of the 5 aimed for",
    "This week's step: Bassinet for the first stretch after the 10 PM feed",
    "Check-ins: Sam 7 of 7 nights · Alex 7 of 7 nights",
  ]) assert(text.includes(line), `The look-back shows "${line}"\n---\n${text}`);
  assert.doesNotMatch(text, /overdue/i);
  const lookChoices = look.getByRole("region", { name: "This week's step?" }).getByRole("button");
  assert.deepEqual(await lookChoices.allInnerTexts(), ["Keep it", "Ease off a week", "Next step"]);
  for (let i = 0; i < 3; i++) assert((await height(lookChoices.nth(i))) >= 44, "The look-back's choices are 44px targets");
  await shot("look-back-390");
  await screens("look-back", lastNight);
  // Keep it: the review, from the revision this phone has; the card has nothing left, so its receipt rides a toast with Undo.
  await look.getByRole("button", { name: "Keep it", exact: true }).click();
  await toast("Keeping this week's step").waitFor();
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.id, wrote.revision, wrote.note], ["goal.review", 330, 2, null], "Keep it records the review");
  await lastNight.waitFor({ state: "detached" });
  await tapToast("Keeping this week's step", "Undo");
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.revision, wrote.back], ["goal.review", 3, { at: null, note: null }], "Undo puts back the review before it");
  await look.getByRole("heading", { name: "Week 1 look-back", exact: true }).waitFor();
  // Next step with no step planned after this one: the chat, seeded with the look-back.
  await look.getByRole("button", { name: "Next step: ask Maple", exact: true }).click();
  ask = await sam.last();
  assert.deepEqual([ask.action, ask.prompt], ["ask", "Week 1 look-back: what's a good next step?"]);
  console.log("PASS Light logging: a family who only answers in the morning reads \"no overnight logs; these come from morning check-ins on 7 nights\", counts its tries, never \"Only\"; its review morning ends the Last night card with Week 1's look-back (each count with what it's out of), Keep it records the review with Undo, and Next step with nothing planned opens the chat");

  // At 320 × 568 in the night look: the look-back's choices fit without sideways scroll.
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("https://sleep.example.test/?mornings&morning&night");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await lastNight.getByRole("button", { name: "Yes", exact: true }).click();
  await look.getByRole("heading", { name: "Week 1 look-back", exact: true }).waitFor();
  // Scrolled to, as a person would: its heading at the top, its choices above the dock.
  await look.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(200);
  await noHorizontalScroll("The look-back at 320px");
  for (const name of ["Keep it", "Ease off a week"]) assert(await aboveDock(look.getByRole("button", { name, exact: true })), `${name} clears the dock at 320 × 568`);
  await shot("look-back-320x568-night");
  await page.setViewportSize({ width: 390, height: 844 });

  // A receipt is for its own night: left open overnight, the next morning's card asks afresh, with no Undo for yesterday.
  await page.goto("https://sleep.example.test/?goals&morning");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await lastNight.getByRole("group", { name: "Did you get your 10 PM–2 AM sleep?" }).getByRole("button", { name: "Yes", exact: true }).click();
  await cardReceipt.filter({ hasText: "Checked in: yes" }).waitFor();
  await advance(24 * 60);
  await lastNight.getByText("Thu, Nov 5", { exact: true }).waitFor();
  await lastNight.getByRole("group", { name: "Did you get your 10 PM–2 AM sleep?" }).waitFor();
  assert.equal(await cardReceipt.count(), 0, "Yesterday's receipt (and its Undo) stays with yesterday");
  console.log("PASS Receipts: a receipt left on the card overnight doesn't carry into the next morning's question");

  // Week 2's look-back on the goal's review day. After noon the night's optional questions fold behind one row.
  await page.goto("https://sleep.example.test/?goals&morning&review");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await lastNight.waitFor();
  await advance(5 * 60);
  await lastNight.getByRole("group", { name: "Did you get your 10 PM–2 AM sleep?" }).getByRole("button", { name: "Yes", exact: true }).click();
  await lastNight.getByText("More about last night, if you'd like.", { exact: true }).waitFor();
  assert.equal(await lastNight.getByRole("button", { name: "Answer", exact: true }).count(), 1, "One row for the rest, after noon");
  await look.getByRole("heading", { name: "Week 2 look-back", exact: true }).waitFor();
  text = await neutral(look, "Week 2's look-back");
  for (const line of ["Bassinet nights: 2 of the 4 aimed for · 5 nights logged", "This week's step: White noise on for every try", "Calmer bedtimes: not counted from the log", "Check-ins: Sam 5 of 7 nights · Alex 3 of 7 nights"]) {
    assert(text.includes(line), `Week 2's look-back shows "${line}"\n---\n${text}`);
  }
  await shot("look-back-folded-390");
  // Ease off a week: counting picks up again in a week; then, as a second tap, the target date a week later.
  await look.getByRole("button", { name: "Ease off a week", exact: true }).click();
  await lastNight.getByRole("heading", { name: "Move the target date a week later?", exact: true }).waitFor();
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.id, wrote.patch], ["goal.update", 301, { paused_until: "2026-11-12" }]);
  await cardReceipt.filter({ hasText: "Easing off a week" }).waitFor();
  assert.deepEqual(await look.getByRole("button").allInnerTexts(), ["Yes, to Wed, Dec 2", "Keep Wed, Nov 25"]);
  await shot("look-back-move-date-390");
  await screens("look-back-move-date", lastNight);
  await look.getByRole("button", { name: "Yes, to Wed, Dec 2", exact: true }).click();
  await cardReceipt.filter({ hasText: "Target date Wed, Dec 2" }).waitFor();
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.patch], ["goal.update", { target_date: "2026-12-02" }]);
  assert.equal(await look.count(), 0, "No look-back while easing off");
  server = await page.evaluate(() => window.__sleep.goal(301));
  assert.deepEqual([server.paused_until, server.target_date, server.status], ["2026-11-12", "2026-12-02", "active"], "Easing off never pauses or closes the goal");
  // The goal card while easing off: the aims, when counting picks up again, and no tally; its menu picks it up from tonight.
  await sam.row.click();
  await plan.waitFor();
  await plan.getByRole("radio", { name: "Goals", exact: true }).click();
  const easing = plan.getByRole("region", { name: "Both of us get one long stretch" });
  await easing.getByText("Easing off", { exact: true }).waitFor();
  text = await neutral(easing, "The goal card, easing off");
  for (const line of ["Target date Wed, Dec 2 · 27 days left", "Easing off until Thu, Nov 12: nothing is counted until then, and the steps and targets hold.", "4 nights a week with a bassinet try asleep 1 hour or more", "White noise on for every try"]) {
    assert(text.includes(line), `The easing card shows "${line}"\n---\n${text}`);
  }
  assert.doesNotMatch(text, /aimed for|week \d of|Hint from the log|Check-ins/, "No tally while easing off");
  await shot("goal-card-easing-390");
  await screens("goal-card-easing", easing);
  await easing.getByRole("button", { name: "More for this goal", exact: true }).click();
  const goalMenu = easing.getByRole("group", { name: "More for this goal" });
  assert.deepEqual((await goalMenu.getByRole("button").allInnerTexts()).map((t) => t.split("\n")[0]), ["Pick up from tonight"]);
  await goalMenu.getByRole("button", { name: /^Pick up from tonight/ }).click();
  await toast("Picked up: counting from tonight").waitFor();
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.patch], ["goal.update", { counts_from: "2026-11-05", paused_until: null }]);
  await easing.getByText("Counting since Thu, Nov 5: the nights before it don't count.", { exact: true }).waitFor();
  await tapToast("Picked up: counting from tonight", "Undo");
  await easing.getByText("Easing off", { exact: true }).waitFor();
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.patch], ["goal.update", { counts_from: null, paused_until: "2026-11-12" }], "Undo puts back exactly what it changed");
  await page.keyboard.press("Escape");
  await plan.waitFor({ state: "hidden" });
  console.log("PASS Look-back: on week 2's review day it follows the check-in (the optional questions folded after noon); Ease off a week, then Move the target date a week later, each with its receipt in the card; the goal card while easing shows the aims and when counting picks up again, no tally, and its menu's Pick up from tonight has Undo");

  // A quiet stretch: one card, once, on Today; the goal never pauses, closes or re-dates itself. (Its first showing marks it
  // seen on this phone, so it's waited for before the storage is cleared, or that mark could land after the clear.)
  await page.goto("https://sleep.example.test/?quiet&morning");
  const back = page.getByRole("region", { name: "Back to “Bassinet by Dec 1”?" });
  await back.waitFor();
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await back.waitFor();
  text = await neutral(back, "The return card");
  assert(text.includes("Nothing was logged Oct 27–Nov 4, so those nights don't count."), text);
  assert.deepEqual(await back.getByRole("group", { name: "What's next for this goal" }).getByRole("button").allInnerTexts(), ["Pick up from tonight", "Ease off a week", "Set it aside"]);
  assert.equal(await lastNight.count(), 0, "No look-back or questions on top of it");
  await shot("goal-return-390");
  await screens("goal-return", back);
  const backReceipt = back.locator("[data-goal-return-receipt]");
  // Set it aside: the goal's own close path, and its Undo opens it again.
  await back.getByRole("button", { name: "Set it aside", exact: true }).click();
  await backReceipt.filter({ hasText: "Set aside: Bassinet by Dec 1" }).waitFor();
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.id, wrote.status], ["goal.close", 320, "dropped"]);
  const undoBox = await back.getByRole("button", { name: "Undo", exact: true }).boundingBox();
  assert(undoBox && undoBox.width >= 44 && undoBox.height >= 44, `Undo is a 44px target (${JSON.stringify(undoBox)})`);
  await back.getByRole("button", { name: "Undo", exact: true }).click();
  await back.getByRole("button", { name: "Pick up from tonight", exact: true }).waitFor();
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.patch], ["goal.update", { status: "active" }]);
  // Pick up from tonight: counting starts again tonight; Undo puts it back.
  await back.getByRole("button", { name: "Pick up from tonight", exact: true }).click();
  await backReceipt.filter({ hasText: "Picked up: counting from tonight" }).waitFor();
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.patch], ["goal.update", { counts_from: "2026-11-05" }]);
  await back.getByRole("button", { name: "Undo", exact: true }).click();
  await back.getByRole("button", { name: "Pick up from tonight", exact: true }).waitFor();
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.patch], ["goal.update", { counts_from: null }]);
  // Once per stretch on this phone: after a reload it doesn't come back, and the goal card says it once, with no tally.
  await page.reload();
  await sam.dock.waitFor();
  await page.waitForTimeout(500);
  assert.equal(await back.count(), 0, "Once per stretch on this phone");
  await sam.row.click();
  await plan.waitFor();
  assert.equal(await plan.locator("[data-goal-return]").count(), 0, "Nor in the plan");
  await plan.getByRole("radio", { name: "Goals", exact: true }).click();
  const quietGoal = plan.getByRole("region", { name: "Bassinet by Dec 1" });
  await quietGoal.locator("[data-goal-quiet]").filter({ hasText: "Nothing logged since Tue, Oct 27." }).waitFor();
  text = await neutral(quietGoal, "The goal card in a quiet stretch");
  assert.doesNotMatch(text, /aimed for|too few|not logged|Logged /, "Said once, with no tally");
  await shot("goal-card-quiet-390");
  await screens("goal-card-quiet", quietGoal);
  await page.keyboard.press("Escape");
  await plan.waitFor({ state: "hidden" });
  // Changed on another phone first: a 409 saves nothing over it; the next tap, on the goal as it is now, saves.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await back.waitFor();
  await page.evaluate(() => window.__sleep.changeGoal(320, { why: "For the move to the crib" }));
  await back.getByRole("button", { name: "Ease off a week", exact: true }).click();
  await toast("Someone changed this goal on another phone just now").waitFor();
  assert.equal((await page.evaluate(() => window.__sleep.goal(320))).paused_until ?? null, null, "Nothing saved over the other phone's change");
  await back.getByRole("button", { name: "Ease off a week", exact: true }).click();
  await backReceipt.filter({ hasText: "Easing off until Thu, Nov 12" }).waitFor();
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.patch], ["goal.update", { paused_until: "2026-11-12" }]);
  await back.getByRole("button", { name: "Done", exact: true }).click();
  await back.waitFor({ state: "detached" });
  console.log("PASS Quiet stretch: one return card, once per stretch, says nothing was logged Oct 27–Nov 4 and offers Pick up from tonight, Ease off a week and Set it aside, each with its receipt and a 44px Undo in the card; the goal card says it once with no tally; a 409 saves nothing over another phone's change");

  // The return card at 320 × 568 in the night look.
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("https://sleep.example.test/?quiet&morning&night");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await back.waitFor();
  await back.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(200);
  await noHorizontalScroll("The return card at 320px");
  for (const name of ["Pick up from tonight", "Ease off a week", "Set it aside"]) assert(await aboveDock(back.getByRole("button", { name, exact: true })), `${name} clears the dock at 320 × 568`);
  await shot("goal-return-320x568-night");
  await page.setViewportSize({ width: 390, height: 844 });
  console.log("PASS 320 × 568: the return card's choices clear the dock with no sideways scroll, in the night look");

  // ── Two phones: Sam asks, Alex says I've got her and sees the catch-up; Sam's sheet says Taken over ──
  await page.setViewportSize({ width: 820, height: 870 });
  await page.goto("https://sleep.example.test/?phones&holding&night");
  const samFrame = page.frameLocator("iframe[name=sam]");
  const alexFrame = page.frameLocator("iframe[name=alex]");
  await samFrame.getByRole("group", { name: "Sleep plan", exact: true }).waitFor();
  const samP = page.frame({ name: "sam" });
  const alexP = page.frame({ name: "alex" });
  const S = { ...phone(samFrame), poll: () => samP.evaluate(() => window.__sleep.poll()), calls: () => samP.evaluate(() => window.__sleep.calls().filter((x) => x.action !== "GET" && x.action !== "OTHER")) };
  const A = { ...phone(alexFrame), poll: () => alexP.evaluate(() => window.__sleep.poll()), calls: () => alexP.evaluate(() => window.__sleep.calls().filter((x) => x.action !== "GET" && x.action !== "OTHER")) };
  assert.match(await A.strip.innerText(), /Sam is holding her/);
  await A.strip.getByRole("button", { name: "Take over", exact: true }).waitFor();
  assert.equal(await alexFrame.getByRole("button", { name: /I'm getting sleepy/ }).count(), 0, "Alex isn't holding her: no I'm getting sleepy");
  // She's asleep in Sam's arms: Sam's strip offers Put her down, and I'm getting sleepy is on the turn's card.
  await S.strip.getByRole("button", { name: "Put her down", exact: true }).waitFor();
  await samFrame.getByRole("region", { name: "You're holding River" }).getByRole("button", { name: "I'm getting sleepy", exact: true }).click();
  await samFrame.getByRole("dialog", { name: "Getting sleepy?" }).getByRole("button", { name: /^Wake Alex/ }).click();
  const samWaking = samFrame.getByRole("dialog", { name: "Waking Alex…", exact: true });
  await samWaking.waitFor();
  await A.poll();
  await A.strip.getByText("Sam asked you to take over").waitFor();
  const alexTurn = alexFrame.getByRole("region", { name: "Sam asked you to take over" });
  await alexTurn.getByRole("button", { name: "I've got her", exact: true }).waitFor();
  await shot("two-phones-asked");
  await A.strip.getByRole("button", { name: "I've got her", exact: true }).click();
  const catchUp = alexFrame.getByRole("dialog", { name: "You have River", exact: true });
  await catchUp.waitFor();
  const lines = await catchUp.getByRole("list", { name: "Catch-up" }).innerText();
  for (const re of [/Feed\s+Last fed 1:30 AM \(40m ago\) · next side Left/, /Diaper\s+Last changed 1:20 AM \(50m ago\) · wet/, /Running\s+Asleep since 1:40 AM \(in arms\), 30 min/, /Handoff\s+Next planned for 4:10 AM, to Sam/]) assert.match(lines, re, lines);
  const accepted = (await A.calls()).at(-1);
  assert.deepEqual([accepted.action, accepted.who], ["shift.accept", "alex@example.test"]);
  await shot("two-phones-catch-up");
  await S.poll();
  await samFrame.getByRole("dialog", { name: "Taken over", exact: true }).getByText("Alex has her now, since 2:10 AM.").waitFor();
  assert.match(await S.strip.innerText(), /Alex is holding her/);
  assert.equal(await samFrame.getByRole("button", { name: /I'm getting sleepy/ }).count(), 0, "Sam handed her over: no I'm getting sleepy for Sam");
  await shot("two-phones-taken-over");
  await catchUp.getByRole("button", { name: "Done", exact: true }).click();
  await catchUp.waitFor({ state: "hidden" });
  // Alex holds her now (still asleep in arms: the strip's Put her down): Alex's I'm getting sleepy offers to wake Sam, never Alex.
  await A.strip.getByRole("button", { name: "Put her down", exact: true }).waitFor();
  await alexFrame.getByRole("region", { name: "You're holding River" }).getByRole("button", { name: "I'm getting sleepy", exact: true }).click();
  const alexSleepy = alexFrame.getByRole("dialog", { name: "Getting sleepy?", exact: true });
  await alexSleepy.waitFor();
  assert.deepEqual((await alexSleepy.getByRole("button").filter({ hasText: /bassinet now|^Wake/ }).allInnerTexts()).map((t) => t.split("\n")[0]), ["Put her in the bassinet now", "Wake Sam"], "The partner is never the person holding her");
  await page.keyboard.press("Escape");
  console.log("PASS Two phones: Sam's Wake Alex asks; Alex's phone says Sam asked you to take over with I've got her; accepting records the handoff and shows the catch-up (last feed and next side, last diaper, what's running, the next handoff); Sam's sheet says Taken over and Sam gets Take over; Alex's sleepy sheet wakes Sam");

  // Undo from the catch-up: the turn goes back to Sam.
  await page.goto("https://sleep.example.test/?phones&holding");
  const sam2 = page.frameLocator("iframe[name=sam]");
  const alex2 = page.frameLocator("iframe[name=alex]");
  await alex2.getByRole("group", { name: "Sleep plan", exact: true }).getByRole("button", { name: "Take over", exact: true }).click();
  const takeOver = alex2.getByRole("dialog", { name: "Take over", exact: true });
  await takeOver.waitFor();
  assert.equal(await takeOver.getByRole("group", { name: "Who has her now" }).getByRole("button", { name: "Me", exact: true }).getAttribute("aria-pressed"), "true", "Take over: Alex has her");
  await takeOver.getByRole("button", { name: "I've got her", exact: true }).click();
  const catchUp2 = alex2.getByRole("dialog", { name: "You have River", exact: true });
  await catchUp2.waitFor();
  await catchUp2.getByRole("button", { name: "Undo", exact: true }).click();
  await catchUp2.waitFor({ state: "hidden" });
  await page.frame({ name: "sam" }).evaluate(() => window.__sleep.poll());
  await sam2.getByRole("group", { name: "Sleep plan", exact: true }).getByText("Asleep in your arms").waitFor();
  console.log("PASS Take over: from anyone else's phone it's I've got her, with the catch-up and its Undo, which puts the turn back");

  // At the planned handoff, the holder's strip offers the handoff itself; the sheet records it as what it is: Alex has her.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("https://sleep.example.test/?holding&night");
  await strip.waitFor();
  await advance(81);
  await strip.getByText("Handoff time").waitFor();
  await strip.getByRole("button", { name: "Hand off to Alex", exact: true }).click();
  const handOff = page.getByRole("dialog", { name: "Hand off", exact: true });
  await handOff.waitFor();
  assert.equal(await handOff.getByRole("group", { name: "Who has her now" }).getByRole("button", { name: "Alex", exact: true }).getAttribute("aria-pressed"), "true", "Alex, preselected");
  await shot("handoff-time");
  await handOff.getByRole("button", { name: "Alex has her", exact: true }).click();
  await handOff.waitFor({ state: "hidden" });
  c = await sam.last();
  assert.deepEqual([c.action, c.to], ["shift.handoff", "alex@example.test"]);
  await toast(/^Alex has her now/).waitFor();
  console.log("PASS Handoff time: the holder's strip says Hand off to Alex, and the sheet's button says what it records: Alex has her");

  // ── Plan for going back to work: five questions, one read-back, saved only on Save the goal, no logs needed ──
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("https://sleep.example.test/");
  await sam.dock.waitFor();
  await more("Sleep goals");
  await plan.waitFor();
  await plan.getByRole("button", { name: "Plan for going back to work", exact: true }).click();
  const quick = plan.getByRole("region", { name: "Plan for going back to work" });
  await quick.getByText("Question 1 of 5", { exact: true }).waitFor();
  const next = quick.getByRole("button", { name: "Next", exact: true });
  assert.equal(await next.isDisabled(), true, "Next waits for an answer");
  await quick.getByRole("group", { name: "Who goes back to work" }).getByRole("button", { name: "Alex", exact: true }).click();
  await quick.getByLabel("The day back at work", { exact: true }).fill("2026-11-30");
  await next.click();
  await quick.getByText("Question 2 of 5", { exact: true }).waitFor();
  await quick.getByRole("group", { name: "How River is fed" }).getByRole("button", { name: "Nursing", exact: true }).click();
  assert.equal(await next.isDisabled(), true, "Nursing asks who nurses");
  await quick.getByRole("group", { name: "Who nurses" }).getByRole("button", { name: "Me", exact: true }).click();
  await next.click();
  await quick.getByRole("group", { name: "Where River sleeps now" }).getByRole("button", { name: "In arms", exact: true }).click();
  await next.click();
  // Alex goes back: Alex is on first (and sleeps the second half), Sam second, by default.
  assert.equal(await quick.getByRole("group", { name: "On duty for the first half" }).getByRole("button", { name: "Alex", exact: true }).getAttribute("aria-pressed"), "true", "the one going back is on first");
  assert.equal(await quick.getByRole("group", { name: "On duty for the second half" }).getByRole("button", { name: "Me", exact: true }).getAttribute("aria-pressed"), "true", "the other adult second");
  await quick.getByRole("group", { name: "Where the adult who's off sleeps" }).getByRole("button", { name: "Another room", exact: true }).click();
  await next.click();
  assert.equal(await quick.getByLabel("Target date", { exact: true }).inputValue(), "2026-12-13", "two weeks after the day back, by default");
  await noSideScroll(plan, "The quick setup at 390px");
  sent = (await sam.calls()).length;
  await quick.getByRole("button", { name: "See the plan", exact: true }).click();
  await quick.getByText("Here's the plan. Nothing is saved until you save it.", { exact: true }).waitFor();
  text = await neutral(quick, "The quick setup's read-back");
  for (const line of [
    "Back to work: protected sleep for Alex and Sam",
    "Alex goes back to work on Mon, Nov 30.",
    "Target date Sun, Dec 13",
    "Alex's protected sleep, 5 nights a week",
    "Sam's protected sleep, 4 nights a week",
    "Sam 10:00 PM–2:00 AM",
    "Alex 2:00 AM–6:00 AM",
    "Sun–Thu nights",
    "She nurses: whoever's on duty brings her to nurse, then settles her.",
    // Nursing only: the feeds step plans the night feeds (no bottle step), and the roster starts with its rehearsal.
    "Plan the night feeds: whoever's on duty brings her to Sam to nurse, then settles her",
    "The roster starts on Mon, Nov 16, two weeks before the day back, with its rehearsal: the morning check-ins and the counts begin then.",
    "Week of Mon, Nov 2",
    "Rehearse the work-week roster on 2 or 3 nights",
    "Plan a short first week back (a Wednesday or Thursday start, if work allows)",
    "River sleeps in arms now: holding her is fine while you're awake, and the Plan tab's first stage is one bassinet try a day.",
    "The adult who's off sleeps in another room. Night feeds: in Sam's window, Alex brings her to Sam to nurse, then settles her; in Alex's window, Sam nurses her.",
  ]) assert(text.includes(line), `The read-back shows "${line}"\n---\n${text}`);
  assert.equal((await sam.calls()).length, sent, "Reading it over sends nothing");
  await shot("quick-setup-readback");
  await quick.getByRole("button", { name: "Save the goal", exact: true }).click();
  await raised("Sleep goal saved: Back to work: protected sleep for Alex and Sam");
  await plan.getByRole("region", { name: "Back to work: protected sleep for Alex and Sam" }).waitFor();
  wrote = await sam.last();
  assert.equal(wrote.action, "goal.create");
  assert.deepEqual(wrote.goal.template, { kind: "back_to_work", member: "alex@example.test", date: "2026-11-30", nursing: "sam@example.test", roster_from: "2026-11-16", feeding: "nursing" }, "who goes back and when, who nurses, how she is fed, and when the roster starts");
  assert.deepEqual(wrote.goal.roster.map((w) => [w.member, w.from, w.to, w.nights.length, w.covers]), [["sam@example.test", "22:00", "02:00", 7, "nurse"], ["alex@example.test", "02:00", "06:00", 5, "nurse"]], "a window each, Alex's on work nights");
  assert.deepEqual(wrote.goal.steps.map((x) => x.week_of), ["2026-11-02", "2026-11-16", "2026-11-23"], "three steps timed from the day back");
  // At 320px it fits without sideways scroll.
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("https://sleep.example.test/");
  await more("Sleep goals");
  await plan.getByRole("button", { name: "Plan for going back to work", exact: true }).click();
  await quick.getByText("Question 1 of 5", { exact: true }).waitFor();
  await noSideScroll(plan, "The quick setup at 320px");
  console.log("PASS Quick setup: five questions one at a time (who goes back and when, feeding and who nurses, where she sleeps, the night's halves, the target date), one read-back with a roster and three steps from the day back, saved only on Save the goal; 320px fits");

  // ── A nursing feed at night: the feed card's quiet line with NICHD's two options; none by day, none for a view-only guest ──
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("https://sleep.example.test/?nursing&night");
  const feedCard = page.getByRole("region", { name: "Nursing timer", exact: true });
  await feedCard.waitFor();
  const nightLine = feedCard.getByText("Feeling sleepy? Wake someone to sit with you, or lay her on her back in the bassinet.", { exact: true });
  await nightLine.waitFor();
  await shot("night-feed-line");
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("https://sleep.example.test/?nursing&night");
  await nightLine.waitFor();
  assert(await aboveDock(nightLine), "The night line clears the dock at 320 × 568");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("https://sleep.example.test/?nursing&morning");
  await feedCard.waitFor();
  assert.equal(await feedCard.locator("[data-night-feed]").count(), 0, "Not by day (7:30 AM)");
  await page.goto("https://sleep.example.test/?nursing&role=viewer&night");
  await feedCard.waitFor();
  assert.equal(await feedCard.locator("[data-night-feed]").count(), 0, "Not for a view-only guest");
  console.log("PASS Night feed: while she nurses between 10 PM and 6 AM, the feed card says wake someone to sit with you, or the bassinet (clear of the dock at 320 × 568); nothing by day or for a view-only guest");

  // ── A feed logged after her sleep in arms began: the turn's card asks Woke at; Still asleep lets it be ──
  await page.goto("https://sleep.example.test/?holding&armsfeed&night");
  const fedTurn = page.getByRole("region", { name: "You're holding River" });
  const fedAsk = fedTurn.locator("[data-woke-ask]");
  await fedAsk.getByText("A feed was logged at 2:00 AM. Did she wake then?").waitFor();
  assert.equal(await page.getByRole("region", { name: "Asleep timer" }).count(), 0, "One card for the turn and her sleep in arms");
  await shot("arms-feed-ask-night");
  await page.setViewportSize({ width: 320, height: 568 });
  await page.waitForTimeout(200);
  await noHorizontalScroll("The turn's card with its question at 320px");
  await shot("arms-feed-ask-320x568-night");
  await page.setViewportSize({ width: 390, height: 844 });
  await fedAsk.getByRole("button", { name: "Still asleep", exact: true }).click();
  await fedAsk.waitFor({ state: "detached" });
  await page.reload();
  await fedTurn.waitFor();
  await page.waitForTimeout(300);
  assert.equal(await fedTurn.locator("[data-woke-ask]").count(), 0, "Still asleep holds on this phone");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await fedTurn.locator("[data-woke-ask]").getByRole("button", { name: "Woke at 2:00 AM", exact: true }).click();
  c = await sam.last();
  assert.deepEqual([c.action, c.id, c.at], ["stop", 91, "2026-10-28T06:00:00.000Z"], "Her sleep in arms stops when the feed began");
  await fedTurn.getByText(/^Asleep in arms since/).waitFor({ state: "detached" });
  console.log("PASS Arms and a feed: a feed logged after her sleep in arms began asks Woke at on the turn's card (one card); Still asleep holds on this phone; Woke at stops it then");

  // ── The next handoff and the roster: never inside the next holder's protected window ──
  await page.goto("https://sleep.example.test/?holding&roster");
  const rosterTurn = page.getByRole("region", { name: "You're holding River" });
  await rosterTurn.getByRole("button", { name: "Hand off", exact: true }).click();
  const handSheet = page.getByRole("dialog", { name: "Hand off", exact: true });
  await handSheet.waitFor();
  // Alex takes over now (2:10 AM); the next handoff back to Sam would be 4:10 AM, inside Sam's 2:30–5:30 AM window: its end comes first.
  const endChip = handSheet.getByRole("group", { name: "Next planned handoff" }).getByRole("button", { name: "5:30 AM · after your protected sleep", exact: true });
  assert.equal(await endChip.getAttribute("aria-pressed"), "true", "The window's end, preselected");
  await handSheet.getByRole("group", { name: "Next planned handoff" }).getByRole("button", { name: /^In 2h · 4:10 AM/ }).click();
  await handSheet.locator("[data-handoff-window]").filter({ hasText: "4:10 AM is inside your protected sleep (2:30–5:30 AM) on the roster." }).waitFor();
  await shot("handoff-roster-sheet");
  await page.setViewportSize({ width: 320, height: 568 });
  await page.waitForTimeout(200);
  await noSideScroll(handSheet, "The Hand off sheet at 320px");
  await shot("handoff-roster-sheet-320x568");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Escape");
  await handSheet.waitFor({ state: "hidden" });
  // The holder's own "Alex has her" after Wake Alex: the store plans the next one, and the toast says why.
  await rosterTurn.getByRole("button", { name: "I'm getting sleepy", exact: true }).click();
  await page.getByRole("dialog", { name: "Getting sleepy?" }).getByRole("button", { name: /^Wake Alex/ }).click();
  await page.getByRole("dialog", { name: "Waking Alex…" }).waitFor();
  await page.keyboard.press("Escape");
  await strip.getByRole("button", { name: "Alex has her", exact: true }).click();
  await toast("Alex has her now · next handoff 5:30 AM, after your protected sleep (2:30–5:30 AM)").waitFor();
  c = await sam.last();
  assert.deepEqual([c.action, c.to, "handoff_at" in c], ["shift.handoff", "alex@example.test", false], "The store's default, moved off the window");
  db = await sam.db();
  assert.equal(db.shifts.find((x) => !x.ended_at).handoff_at, "2026-10-28T09:30:00.000Z", "5:30 AM");
  await shot("handoff-roster-toast");
  // Two phones: Alex's I've got her, and the catch-up says why.
  await page.setViewportSize({ width: 820, height: 870 });
  await page.goto("https://sleep.example.test/?phones&holding&roster&night");
  const samR = page.frameLocator("iframe[name=sam]");
  const alexR = page.frameLocator("iframe[name=alex]");
  await samR.getByRole("region", { name: "You're holding River" }).getByRole("button", { name: "I'm getting sleepy", exact: true }).click();
  await samR.getByRole("dialog", { name: "Getting sleepy?" }).getByRole("button", { name: /^Wake Alex/ }).click();
  await page.frame({ name: "alex" }).evaluate(() => window.__sleep.poll());
  await alexR.getByRole("group", { name: "Sleep plan", exact: true }).getByRole("button", { name: "I've got her", exact: true }).click();
  const rosterCatch = alexR.getByRole("dialog", { name: "You have River", exact: true });
  await rosterCatch.waitFor();
  assert.match(await rosterCatch.getByRole("list", { name: "Catch-up" }).innerText(), /Handoff\s+Next planned for 5:30 AM, to Sam, after Sam's protected sleep \(2:30–5:30 AM\)/);
  await shot("two-phones-roster-catch-up");
  await page.setViewportSize({ width: 390, height: 844 });
  console.log("PASS Next handoff: the Hand off sheet's default skips the next holder's protected window (a time inside it says so); the holder's Alex has her and Alex's I've got her plan it for the window's end, and the toast and catch-up say why");

  // ── The morning with a plan set up and no try: what to do next, and why the morning nap ──
  await page.goto("https://sleep.example.test/?morning");
  await more("Sleep plan");
  await plan.waitFor();
  await plan.getByRole("button", { name: "Set up the plan", exact: true }).click();
  await plan.getByText("Stage 1 of 4", { exact: true }).waitFor();
  text = await clean(plan, "The plan in the morning");
  assert(text.includes("0 of 1 since last night · next: the first morning nap (the backup, since no night try was logged)"), text);
  await plan.locator("[data-first-try]").getByText("What to do next", { exact: true }).waitFor();
  assert.match(await plan.locator("[data-first-try]").innerText(), /The first morning nap: once she's deeply asleep, lay her on her back in the bassinet and tap Put down\./);
  await page.setViewportSize({ width: 320, height: 568 });
  await noSideScroll(plan, "The plan at 320px");
  await shot("plan-morning-320x568");
  await page.setViewportSize({ width: 390, height: 844 });
  console.log("PASS Plan copy: the backup says why (no night try was logged), and setup says what to do next");

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
