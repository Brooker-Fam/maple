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
  await shot("plan");
  console.log("PASS Plan: set up from More at stage 1 (one try a day), age from the birth date");

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
  await form.getByRole("textbox", { name: "Step 1", exact: true }).fill("Bassinet after the late feed");
  await form.getByRole("button", { name: "Add a window", exact: true }).click();
  // A window under 30 minutes: the rules' words show by the window at once, and Save sends nothing.
  await form.getByLabel("Window 1 to", { exact: true }).fill("22:15");
  await form.getByText("Window 1: a protected window is 30 minutes to 12 hours long.", { exact: true }).waitFor();
  sent = (await sam.calls()).length;
  await form.getByRole("button", { name: "Save the goal", exact: true }).click();
  assert.equal((await sam.calls()).length, sent, "Still nothing sent");
  await form.getByLabel("Window 1 to", { exact: true }).fill("02:00");
  await form.getByText(/^Window 1: /).waitFor({ state: "detached" });
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
      { member: "sam@example.test", from: "22:00", to: "02:00", nights: [0, 1, 2, 3, 4, 5, 6] },
      { member: "alex@example.test", from: "02:00", to: "06:00", nights: [0, 1, 2, 3, 4, 5, 6] },
    ],
  });
  await raised("Sleep goal saved: Both of us get one long stretch");
  await plan.waitFor();
  const made = plan.getByRole("region", { name: "Both of us get one long stretch" });
  await made.getByText(/^This week:/).first().waitFor();
  text = await neutral(made, "A new goal");
  assert(text.includes("Target date Wed, Nov 25 · 28 days left · week 1 of 5"), text);
  assert(text.includes("3 nights a week with a bassinet try asleep 1 hour or more"), text);
  assert(text.includes("Sam 10:00 PM–2:00 AM"), text);
  assert(text.includes("Alex 2:00 AM–6:00 AM"), text);
  console.log("PASS Goal form: says what to fix by the field; a new window defaults to the other adult from where the last one ends, with no early overlap error; saves the goal");
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
  await holding.getByRole("button", { name: "Start", exact: true }).click();
  await holding.waitFor({ state: "hidden" });
  c = await sam.last();
  assert.deepEqual([c.action, c.holder, c.next_holder, c.handoff_at, c.asleep], ["shift.start", "sam@example.test", "alex@example.test", "2026-10-28T09:16:00.000Z", true], "Planned handoff two hours on, asleep in arms");
  await toast(/Holding her · handoff 5:16 AM · asleep in arms since 3:16 AM/).waitFor();
  let arms = (await sam.db()).entries.find((e) => e.kind === "sleep" && e.active);
  assert.equal(arms?.data.place, "arms", "A sleep in arms runs");
  assert.match(await strip.innerText(), /You're holding her/);
  await strip.getByRole("button", { name: "I'm getting sleepy", exact: true }).click();
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
  console.log("PASS Holding: asleep in arms starts a sleep in arms; Wake Alex only asks (Undo takes it back) and keeps the bassinet big; ten minutes on, the two safe choices again; Alex has her records it; then Sam sees Take over, never I'm getting sleepy");

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
  text = await strip.innerText();
  assert.match(text, /\d of 1 since last night/, `At 7:30 AM the strip says since last night: ${text}`);
  assert.doesNotMatch(text, /tonight/);
  const stripWords = strip.getByRole("button", { name: /Open the sleep plan/ }).locator("span.line-clamp-2");
  assert(await stripWords.evaluate((el) => el.scrollHeight <= el.clientHeight + 1), "The strip's words aren't cut");
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
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.protected, wrote.night, "note" in wrote], ["checkin.save", "partly", "2026-11-04", false], "Last night (it began Wednesday evening); one tap leaves any note as it is");
  assert.match(wrote.client_id, /^checkin-/);
  await checkin.waitFor({ state: "detached" });
  await toast("Checked in for last night: partly").getByRole("button", { name: "Undo", exact: true }).click();
  await checkin.waitFor();
  wrote = await sam.last();
  assert.equal(wrote.action, "checkin.delete", "Undo deletes the check-in it made");
  assert.deepEqual((await page.evaluate(() => window.__sleep.checkins())).filter((x) => x.member === "sam@example.test" && x.night === "2026-11-04"), []);
  console.log("PASS Check-in card: the morning after, for the adult on the roster; one tap saves last night's answer; Undo deletes it");

  // Not now: hidden for that night on this phone, even after a reload.
  const hiddenKey = "maple-sleep-checkin-hidden:99:sam@example.test";
  await checkin.getByRole("button", { name: "Not now", exact: true }).click();
  await checkin.waitFor({ state: "detached" });
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), hiddenKey), "2026-11-04");
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
  assert(text.includes("view-only guests never do"), "It says who sees a check-in");
  await sheet.getByRole("textbox", { name: "Note", exact: true }).fill("Up once, back down quickly");
  const big = sheet.getByRole("group", { name: "Did your protected sleep window hold last night?" }).getByRole("button");
  for (let i = 0; i < 3; i++) assert((await height(big.nth(i))) >= 56, "The sheet's answers are big");
  await shot("checkin-sheet");
  await big.filter({ hasText: /^Yes$/ }).click();
  await sheet.waitFor({ state: "hidden" });
  wrote = await sam.last();
  assert.deepEqual([wrote.action, wrote.protected, wrote.night, wrote.note], ["checkin.save", "yes", "2026-11-04", "Up once, back down quickly"]);
  await toast("Checked in for last night: yes").waitFor();
  assert.equal(await checkin.count(), 0, "Checked in: the card goes");
  console.log("PASS Check-in sheet: a note, then one tap on a big answer saves both; Not now hides the card for that night on this phone");

  // ── The goal card: each target's counts with what they're out of, steps, the roster with hints, each adult's check-ins ──
  await sam.row.click();
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
  assert.equal(await big.filter({ hasText: /^Yes$/ }).getAttribute("aria-pressed"), "true", "The saved answer");
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

  // ── A view-only guest: goals, steps, the roster and the baby's numbers; never a check-in; nothing that writes ──
  await page.goto("https://sleep.example.test/?goals&morning&role=viewer&night");
  await sam.row.click();
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
  assert.deepEqual((await sam.calls()).map((x) => x.action), [], "A view-only guest's phone sent no writes");
  await shot("goals-viewer-night");
  console.log("PASS Viewer: goals, steps, the roster and the baby's numbers through the Sleep plan row (night look); no check-ins anywhere and nothing that writes");

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
  await S.strip.getByRole("button", { name: "I'm getting sleepy", exact: true }).click();
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
  // Alex holds her now: Alex's I'm getting sleepy offers to wake Sam, never Alex.
  await A.strip.getByRole("button", { name: "I'm getting sleepy", exact: true }).click();
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
  await sam2.getByRole("group", { name: "Sleep plan", exact: true }).getByText("You're holding her").waitFor();
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
