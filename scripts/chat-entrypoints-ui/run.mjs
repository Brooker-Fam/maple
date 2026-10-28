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
const output = await mkdtemp(path.join(tmpdir(), "maple-entrypoints-ui-"));
const baseline = process.env.MAPLE_ENTRYPOINTS_BASELINE;
const only = process.env.MAPLE_ENTRYPOINTS_ONLY;
const screenshots = path.join(root, "test-results/maple-entrypoints-ui");
const baselineFiles = new Set(process.env.MAPLE_ENTRYPOINTS_BASELINE_FILES?.split(",") ?? [
  "src/components/maple/AppNav.tsx", "src/components/maple/Sheet.tsx", "src/components/maple/sheetHistory.ts",
  "src/components/maple/chat/ChatNav.tsx", "src/components/maple/chat/ChatTab.tsx", "src/components/maple/sheets/parts.tsx",
  "src/components/maple/sheets/FeedSheet.tsx",
]);
await mkdir(screenshots, { recursive: true });
await build({
  entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env.NODE_ENV": '"test"' },
  plugins: [{ name: "synthetic-entrypoint-boundaries", setup(plugin) {
    const mocks = { path: path.join(here, "mocks.jsx") };
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav|useChatThread|useTimerActions|sheets)$/ }, () => mocks);
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
await writeFile(path.join(output, "index.html"), '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic chat entrypoint check</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const origin = "https://maple-entrypoints.example.test";
const failures = [];
let scenarios = 0;
const noSends = async (page) => assert.deepEqual((await page.evaluate(() => window.__entrypoints.calls())).filter((call) => call.kind === "send"), []);
const settled = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const waitChat = async (page) => {
  await page.waitForURL(/#chat$/);
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await settled(page);
  assert.equal(new URL(page.url()).hash, "#chat");
};
const askEntry = async (page) => {
  await page.getByRole("button", { name: "Open saved entry", exact: true }).click();
  const ask = page.getByRole("button", { name: "Ask about this entry", exact: true });
  await ask.waitFor();
  const box = await ask.boundingBox();
  assert(box && box.height >= 44, "Entry chat action keeps a 44px touch target");
  await ask.click();
};
async function scenario(name, query, check) {
  if (only && !name.includes(only)) return;
  scenarios++;
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: "reduce", locale: "en-US", serviceWorkers: "block" });
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
    await page.goto(`${origin}/?${query}#today`);
    await page.waitForFunction(() => !!window.__entrypoints);
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
  await scenario("saved entry opens an unsent dated draft and browser Back returns to Today", "", async (page) => {
    await askEntry(page);
    await waitChat(page);
    const draft = page.getByRole("textbox", { name: "Message", exact: true });
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="Message"]')?.value.includes("#901"));
    assert.match(await draft.inputValue(), /diaper entry \(#901\).*2026-10-26 at 10:10 PM \(America\/New_York\)/);
    await noSends(page);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await page.screenshot({ path: path.join(screenshots, "entry-draft-375-day.png") });
    await page.evaluate(() => document.documentElement.classList.add("maple-night", "dark"));
    await page.screenshot({ path: path.join(screenshots, "entry-draft-375-night.png") });
    await page.goBack();
    await page.waitForURL(/#today$/);
    await page.getByRole("heading", { name: "Today", exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
  });

  await scenario("existing draft survives until Add to draft or Dismiss question is chosen", "draft=My+unfinished+question", async (page) => {
    await askEntry(page);
    await waitChat(page);
    const draft = page.getByRole("textbox", { name: "Message", exact: true });
    assert.equal(await draft.inputValue(), "My unfinished question");
    await page.getByRole("button", { name: "Dismiss question", exact: true }).click();
    assert.equal(await draft.inputValue(), "My unfinished question");
    assert.equal(await page.getByRole("region", { name: "Question from your log" }).count(), 0);
    await page.getByRole("button", { name: "Today tab", exact: true }).click();
    await askEntry(page);
    await waitChat(page);
    assert.equal(await draft.inputValue(), "My unfinished question");
    await page.getByRole("button", { name: "Add to draft", exact: true }).click();
    assert.match(await draft.inputValue(), /^My unfinished question\n\nCan you help me understand.*#901/);
    assert.equal(await page.getByRole("region", { name: "Question from your log" }).count(), 0);
  });

  await scenario("entry prompts wait for terms and viewers can still ask", "terms=false&role=viewer", async (page) => {
    await askEntry(page);
    await waitChat(page);
    await page.getByRole("heading", { name: "Before you start", exact: true }).waitFor();
    const draft = page.getByRole("textbox", { name: "Message", exact: true });
    assert.match(await draft.inputValue(), /#901/);
    assert(await draft.isDisabled());
    assert(await page.getByRole("button", { name: "Send", exact: true }).isDisabled());
    await noSends(page);
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('textarea[aria-label="Message"]')?.disabled);
    assert.match(await draft.inputValue(), /#901/);
    assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), false);
  });

  await scenario("long drafts remain intact and oversized prompts never navigate", "", async (page) => {
    const accepted = await page.evaluate(() => window.__entrypoints.ask({ label: "Too long", prompt: "x".repeat(2001) }));
    assert.equal(accepted, false);
    assert.equal(new URL(page.url()).hash, "#today");
    await page.evaluate(() => window.__entrypoints.setDraft("x".repeat(1980)));
    await askEntry(page);
    await waitChat(page);
    const draft = page.getByRole("textbox", { name: "Message", exact: true });
    assert.equal(await draft.inputValue(), "x".repeat(1980));
    assert(await page.getByRole("button", { name: "Add to draft", exact: true }).isDisabled());
    await page.getByText("Send or shorten your draft to make room for this question.", { exact: true }).waitFor();
    await draft.fill("A shortened question");
    assert.equal(await page.getByRole("button", { name: "Add to draft", exact: true }).isDisabled(), false);
    await page.getByRole("button", { name: "Add to draft", exact: true }).click();
    assert.match(await draft.inputValue(), /^A shortened question\n\nCan you help me understand.*#901/);
    assert((await draft.inputValue()).length <= 2000);
  });

  await scenario("pending local entries have no ask action while saved entries do", "entry=pending", async (page) => {
    await page.getByRole("button", { name: "Open saved entry", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    assert.equal(await page.getByRole("button", { name: "Ask about this entry", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.evaluate(() => window.__entrypoints.ask({ label: "Saved entry", prompt: "What does saved entry #902 show?" }));
    await waitChat(page);
    assert.match(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), /#902/);
  });

  for (const sameTab of [false, true]) {
    await scenario(`dirty entry ${sameTab ? "already in Chat" : "on Today"} stays on cancel and opens on confirmed discard`, "", async (page) => {
      if (sameTab) await page.getByRole("button", { name: "Chat tab", exact: true }).click();
      await page.getByRole("button", { name: "Open saved entry", exact: true }).click();
      const note = page.getByRole("dialog").getByRole("textbox");
      await note.fill("Unsaved synthetic note");
      let confirmations = 0;
      const cancel = async (dialog) => { confirmations++; assert.match(dialog.message(), /discard your unsaved changes/); await dialog.dismiss(); };
      page.once("dialog", cancel);
      await page.getByRole("button", { name: "Ask about this entry", exact: true }).click();
      assert.equal(confirmations, 1);
      assert.equal(await note.inputValue(), "Unsaved synthetic note");
      assert.equal(new URL(page.url()).hash, sameTab ? "#chat" : "#today");
      assert.equal(await page.getByRole("dialog").count(), 1);
      page.once("dialog", async (dialog) => { confirmations++; await dialog.accept(); });
      await page.getByRole("button", { name: "Ask about this entry", exact: true }).click();
      await waitChat(page);
      assert.equal(confirmations, 2, "Each tap asks once");
      const draft = await page.getByRole("textbox", { name: "Message", exact: true }).inputValue();
      assert.match(draft, /#901/);
      assert.equal(draft.includes("Unsaved synthetic note"), false);
    });
  }

  await scenario("staged nursing changes require confirmation before opening Chat", "sheet=feed", async (page) => {
    await page.getByRole("button", { name: "Open saved entry", exact: true }).click();
    await page.getByText("Change side", { exact: true }).click();
    await page.getByRole("button", { name: "It was Right", exact: true }).click();
    await page.getByText("Unsaved change to the times", { exact: true }).waitFor();
    let confirmations = 0;
    page.once("dialog", async (dialog) => { confirmations++; await dialog.dismiss(); });
    await page.getByRole("button", { name: "Ask about this entry", exact: true }).click();
    assert.equal(confirmations, 1, "Staged times require the same navigation confirmation as ordinary form fields");
    assert.equal(new URL(page.url()).hash, "#today");
    await page.getByText("Unsaved change to the times", { exact: true }).waitFor();
    page.once("dialog", async (dialog) => { confirmations++; await dialog.accept(); });
    await page.getByRole("button", { name: "Ask about this entry", exact: true }).click();
    await waitChat(page);
    assert.equal(confirmations, 2);
    assert.match(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), /saved feed entry \(#901\)/);
  });

  await scenario("pending entry question is discarded when the family, baby or member changes", "draft=Existing+draft", async (page) => {
    await askEntry(page);
    await waitChat(page);
    for (const identity of [{ family: 100 }, { baby: 100 }, { email: "jordan@example.test" }]) {
      await page.getByRole("region", { name: "Question from your log" }).waitFor();
      await page.evaluate((value) => window.__entrypoints.switchIdentity(value), identity);
      await page.getByRole("region", { name: "Question from your log" }).waitFor({ state: "hidden" });
      assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "Existing draft");
      await page.evaluate(() => window.__entrypoints.ask({ label: "Synthetic scoped question", prompt: "How does saved entry #903 fit with the log?" }));
    }
  });
  assert(scenarios > 0, "At least one scenario must run");
  if (baseline) {
    assert.equal(failures.length, scenarios, "Every selected regression scenario must fail against the baseline");
    throw new Error(`Baseline rejected by all ${failures.length} regression scenarios`);
  }
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
