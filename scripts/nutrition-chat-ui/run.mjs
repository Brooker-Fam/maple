import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const tailwind = require("@tailwindcss/postcss");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const output = await mkdtemp(path.join(tmpdir(), "maple-nutrition-chat-ui-"));
const screenshots = path.join(root, "test-results/maple-nutrition-chat-ui");
const baseline = process.env.MAPLE_NUTRITION_CHAT_BASELINE;
const only = process.env.MAPLE_NUTRITION_CHAT_ONLY;
const baselineFiles = new Set(["src/components/maple/care/NutritionSection.tsx"]);
await mkdir(screenshots, { recursive: true });
await build({
  entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env.NODE_ENV": '"test"' },
  plugins: [{ name: "synthetic-nutrition-chat-boundaries", setup(plugin) {
    const mocks = { path: path.join(here, "mocks.jsx") };
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav|useChatThread|sheets)$/ }, () => mocks);
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => args.importer.endsWith("/sheets/parts.tsx") ? mocks : undefined);
    if (baseline) plugin.onLoad({ filter: /\.[tj]sx?$/ }, (args) => {
      const relative = path.relative(root, args.path);
      if (!baselineFiles.has(relative)) return undefined;
      return {
        contents: execFileSync("git", ["show", `${baseline}:${relative}`], { cwd: root, encoding: "utf8" }),
        loader: relative.endsWith("tsx") ? "tsx" : "ts", resolveDir: path.dirname(args.path),
      };
    });
  } }],
});
const css = path.join(root, "src/app/globals.css");
const compiled = await postcss([tailwind({ base: root })]).process(await readFile(css, "utf8"), { from: css });
await writeFile(path.join(output, "app.css"), compiled.css + "\n" + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
await writeFile(path.join(output, "index.html"), '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic nutrition chat check</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const origin = "https://maple-nutrition-chat.example.test";
const failures = [];
let scenarios = 0;
const snapshot = (page) => page.evaluate(() => window.__nutritionChat.snapshot());
const draftBox = (page) => page.getByRole("textbox", { name: "Message", exact: true });
const sends = (value) => value.calls.filter((call) => call.kind === "send");
const writes = (value) => value.calls.filter((call) => call.kind === "api" && call.method !== "GET");
const noSends = async (page) => assert.deepEqual(sends(await snapshot(page)), []);
const openChat = async (page) => {
  const action = page.getByRole("button", { name: "Log food or drink", exact: true });
  assert.equal(await action.count(), 1, "Nutrition offers one primary action that opens chat");
  await action.click();
  await page.waitForURL(/#chat$/);
  await draftBox(page).waitFor();
};
const draftContains = async (page, text) => {
  await page.waitForFunction((expected) => document.querySelector('textarea[aria-label="Message"]')?.value.includes(expected), text);
};

async function scenario(name, query, check) {
  if (only && !name.includes(only)) return;
  scenarios++;
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC", serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  const network = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || !["/", "/app.js", "/app.css"].includes(url.pathname)) {
      network.push(route.request().url());
      await route.abort();
      return;
    }
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    await route.fulfill({ contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html", body: await readFile(path.join(output, file)) });
  });
  try {
    await page.goto(`${origin}/?${query}#care`);
    await page.waitForFunction(() => !!window.__nutritionChat);
    await check(page);
    await noSends(page);
    assert.deepEqual(network, [], "The fixture cannot contact an outside service or API");
    assert.deepEqual(errors, []);
    console.log(`PASS ${name}`);
  } catch (error) {
    await page.screenshot({ path: path.join(screenshots, baseline ? "baseline-failure.png" : "failure.png") }).catch(() => {});
    if (!baseline) throw new Error(`${name}: ${error.message}`, { cause: error });
    failures.push(name);
    console.error(`FAIL baseline ${name}: ${error.message.split("\n")[0]}`);
  } finally {
    await context.close();
  }
}

try {
  await scenario("nutrition opens an editable unsent care draft using the family day", "", async (page) => {
    assert.equal(await page.getByRole("textbox").count(), 0);
    if (!baseline) await page.screenshot({ path: path.join(screenshots, "nutrition-actions-375.png"), fullPage: true });
    await openChat(page);
    await draftContains(page, "protein");
    const value = await draftBox(page).inputValue();
    assert.match(value, /Log food or drink for Sam Example/);
    assert.match(value, /2026-10-27 \(America\/New_York\)/);
    assert.match(value, /[Ee]stimate protein and fiber/);
    assert.match(value, /I had:/);
    await draftBox(page).fill(`${value} Two eggs, toast and an apple.`);
    assert.match(await draftBox(page).inputValue(), /Two eggs, toast and an apple\.$/);
    assert.deepEqual(writes(await snapshot(page)), []);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    if (!baseline) await page.screenshot({ path: path.join(screenshots, "nutrition-draft-390.png") });
  });

  await scenario("historical nutrition draft names the selected day and care person for another caregiver", "self=false", async (page) => {
    await page.getByLabel("Food and drink day", { exact: true }).selectOption("2026-10-24");
    await openChat(page);
    await draftContains(page, "2026-10-24");
    const value = await draftBox(page).inputValue();
    assert.match(value, /Log food or drink for Sam Example.*2026-10-24 \(America\/New_York\)/);
    assert.match(value, /Ask for the time/);
    assert.match(value, /Sam Example had:/);
    assert.equal(value.includes("2026-10-27"), false);
    assert.deepEqual(writes(await snapshot(page)), []);
  });

  await scenario("nutrition handoff preserves an existing draft until Add or Dismiss", "draft=My+unfinished+question", async (page) => {
    await openChat(page);
    const draft = draftBox(page);
    assert.equal(await draft.inputValue(), "My unfinished question");
    await page.getByRole("button", { name: "Dismiss question", exact: true }).click();
    assert.equal(await draft.inputValue(), "My unfinished question");
    await page.getByRole("button", { name: "Care tab", exact: true }).click();
    await openChat(page);
    assert.equal(await draft.inputValue(), "My unfinished question");
    await page.getByRole("button", { name: "Add to draft", exact: true }).click();
    assert.match(await draft.inputValue(), /^My unfinished question\n\nLog food or drink for Sam Example/);
    assert.match(await draft.inputValue(), /Estimate protein and fiber/);
    assert.equal(await page.getByRole("region", { name: "Question from your log" }).count(), 0);
    assert.deepEqual(writes(await snapshot(page)), []);
  });

  await scenario("nutrition handoff leaves closed care consent unchanged", "care=false", async (page) => {
    await openChat(page);
    await draftContains(page, "Sam Example");
    await page.getByText("The chat can't see your food, drinks, medicines, temperatures or OB questions. You can turn that on in Settings → Chat privacy.", { exact: true }).waitFor();
    assert.equal((await snapshot(page)).consent.care, false);
    assert.deepEqual(writes(await snapshot(page)), []);
  });

  await scenario("nutrition draft waits for chat terms without opting into care access", "terms=false&care=false", async (page) => {
    await openChat(page);
    await page.getByRole("heading", { name: "Before you start", exact: true }).waitFor();
    await draftContains(page, "protein");
    assert(await draftBox(page).isDisabled());
    assert(await page.getByRole("button", { name: "Send", exact: true }).isDisabled());
    assert.deepEqual(writes(await snapshot(page)), []);
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('textarea[aria-label="Message"]')?.disabled);
    assert.match(await draftBox(page).inputValue(), /Log food or drink for Sam Example/);
    const value = await snapshot(page);
    assert.deepEqual(writes(value).map(({ path: pathname, body }) => ({ path: pathname, body })), [{ path: "/api/maple/chat/consent", body: { terms: true, care: false } }]);
    assert.equal(value.consent.care, false);
  });

  await scenario("pending nutrition prompts are discarded on family, baby or member change", "draft=Existing+draft", async (page) => {
    for (const identity of [{ family: 100 }, { baby: 100 }, { email: "casey@example.test" }]) {
      await openChat(page);
      await page.getByRole("region", { name: "Question from your log" }).waitFor();
      await page.evaluate((value) => window.__nutritionChat.switchIdentity(value), identity);
      await page.getByRole("region", { name: "Question from your log" }).waitFor({ state: "hidden" });
      assert.equal(await draftBox(page).inputValue(), "Existing draft");
      await page.getByRole("button", { name: "Care tab", exact: true }).click();
    }
    assert.deepEqual(writes(await snapshot(page)), []);
  });

  await scenario("manual logging remains explicit and Water keeps its direct measured save", "care=false&terms=false", async (page) => {
    assert.equal(await page.getByRole("button", { name: "Ate something", exact: true }).isVisible(), false);
    await page.getByRole("button", { name: "Log water, 8 oz", exact: true }).click();
    await page.waitForFunction(() => window.__nutritionChat.snapshot().state.care.entries.length === 1);
    let value = await snapshot(page);
    assert.equal(writes(value)[0].body.data.name, "Water");
    assert(Math.abs(writes(value)[0].body.data.amount_ml - 236.5882365) < 0.001);
    assert.equal(writes(value)[0].body.at, "2026-10-28T02:30:00.000Z");
    await page.getByText("Log manually", { exact: true }).click();
    await page.getByRole("button", { name: "Ate something", exact: true }).click();
    await page.getByLabel("What was it?", { exact: true }).fill("Synthetic toast");
    await page.getByRole("button", { name: "Log food", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    value = await snapshot(page);
    assert.equal(writes(value).length, 2);
    assert.equal(writes(value)[1].body.kind, "food");
    assert.equal(writes(value)[1].body.data.description, "Synthetic toast");
    assert.equal(writes(value)[1].body.data.items, undefined);
    assert.deepEqual(value.consent, { terms: false, care: false, self: true });
    assert.equal(new URL(page.url()).hash, "#care");
    await page.getByRole("button", { name: "Other drink", exact: true }).click();
    await page.getByRole("dialog", { name: "Had a drink", exact: true }).waitFor();
  });
  assert(scenarios > 0, "At least one scenario must run");
  if (baseline) {
    assert.equal(failures.length, scenarios, "Every selected regression scenario must fail against the baseline");
    throw new Error(`Baseline rejected by all ${failures.length} regression scenarios`);
  }
  console.log(`All ${scenarios} nutrition chat integration scenarios passed.`);
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
