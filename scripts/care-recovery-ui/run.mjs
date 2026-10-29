import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiRoute, world } from "./world.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(path.join(root, "package.json"));
const { build } = require("esbuild");
const { chromium, webkit } = require("playwright");
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const tailwind = require("@tailwindcss/postcss");
const output = await mkdtemp(path.join(tmpdir(), "maple-care-recovery-"));
await build({ entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true, format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env": "{}" }, plugins: [{ name: "browser-runtime", setup(plugin) {
  plugin.onResolve({ filter: /^next\/dynamic$/ }, () => ({ path: "dynamic", namespace: "synthetic" }));
  plugin.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({ contents: 'import {lazy,Suspense} from "react"; export default function dynamic(load){const C=lazy(load);return function Dynamic(props){return <Suspense><C {...props}/></Suspense>}}', loader: "jsx", resolveDir: root }));
} }] });
const cssPath = path.join(root, "src/app/globals.css");
const css = await postcss([tailwind({ base: root })]).process(await readFile(cssPath, "utf8"), { from: cssPath });
await writeFile(path.join(output, "app.css"), css.css + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
const browser = await (process.env.REVIEW_BROWSER === "webkit" ? webkit : chromium).launch({ headless: true });
const refresh = async (page, controls) => {
  const reads = controls.requests.filter((request) => request.path === "/api/maple/state").length;
  await page.evaluate(() => window.dispatchEvent(new Event("maple:family-moved")));
  await waitFor(() => controls.requests.filter((request) => request.path === "/api/maple/state").length > reads);
  await page.waitForTimeout(100);
};
async function waitFor(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert(check(), "Expected synthetic request to complete");
}
async function visit(controls) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(1800);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, "https://care-recovery.example.test");
    if (url.pathname.startsWith("/api/")) return apiRoute(route, controls);
    const file = ["/app.js", "/app.css"].includes(url.pathname) ? url.pathname.slice(1) : null;
    await route.fulfill({ contentType: file?.endsWith("js") ? "text/javascript" : file ? "text/css" : "text/html", body: file ? await readFile(path.join(output, file)) : '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link href="/app.css" rel="stylesheet"></head><body><div id="root"></div><script src="/app.js" type="module"></script></body></html>' });
  });
  await page.goto("https://care-recovery.example.test/#care");
  await page.getByRole("heading", { name: "Sam", exact: true }).waitFor();
  return { page, errors };
}
const question = (page) => page.getByLabel("A question for your OB", { exact: true });
const answer = (page) => page.locator("textarea");
const cases = [
  ["new OB questions guard tab changes", async (page) => {
    await question(page).fill("Synthetic question to preserve");
    const prompts = [];
    page.on("dialog", async (dialog) => { prompts.push(dialog.message()); await dialog.dismiss(); });
    await page.getByRole("button", { name: "Today", exact: true }).last().click();
    assert.equal(prompts.length, 1);
    assert.equal(await question(page).inputValue(), "Synthetic question to preserve");
  }],
  ["failed OB answers have persistent retry and retain their draft", async (page, controls) => {
    await answer(page).fill("Synthetic answer to preserve");
    controls.answerFailure = true;
    await page.getByRole("heading", { name: "Sam", exact: true }).click();
    const retry = page.getByRole("button", { name: "Retry answer", exact: true });
    await retry.waitFor();
    const prompts = [];
    page.on("dialog", async (dialog) => { prompts.push(dialog.message()); await dialog.dismiss(); });
    await page.getByRole("button", { name: "Today", exact: true }).last().click();
    assert.equal(prompts.length, 1);
    assert.equal(await answer(page).inputValue(), "Synthetic answer to preserve");
    controls.answerFailure = false;
    await retry.click();
    await waitFor(() => controls.state.care.entries[0].data.answer === "Synthetic answer to preserve");
    await page.getByText("Answer saved", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Today", exact: true }).last().click();
    await question(page).waitFor({ state: "hidden" });
    assert.equal(prompts.length, 1, "Successful saves clear the navigation guard");
  }, true],
  ...[false, true].map((failure) => [`in-flight answer navigation waits for ${failure ? "failure" : "success"}`, async (page, controls) => {
    controls.pauseAnswer = true;
    controls.answerFailure = failure;
    const prompts = [];
    page.on("dialog", async (dialog) => { prompts.push(dialog.message()); await dialog.accept(); });
    await answer(page).fill("Synthetic answer still saving");
    await page.getByRole("button", { name: "Today", exact: true }).last().click();
    await waitFor(() => controls.releaseAnswer);
    try {
      assert.equal(new URL(page.url()).hash, "#care", "Navigation waits for the answer request");
      assert.equal(prompts.length, 1);
      assert.match(prompts[0], /still saving/i);
      assert.doesNotMatch(prompts[0], /discard/i);
    } finally { controls.releaseAnswer(); }
    controls.pauseAnswer = false;
    if (failure) {
      await page.getByRole("button", { name: "Retry answer", exact: true }).waitFor();
      assert.equal(await answer(page).inputValue(), "Synthetic answer still saving");
      assert.equal(controls.state.care.entries[0].data.answer, "");
    } else {
      await page.getByText("Answer saved", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Today", exact: true }).last().click();
      await question(page).waitFor({ state: "hidden" });
      assert.equal(prompts.length, 1);
    }
  }, true]),
  ["remote answer changes preserve both answers until an explicit choice", async (page, controls) => {
    const original = controls.state.care.entries[0].updated_at;
    await answer(page).fill("My synthetic draft");
    controls.answerElsewhere("Other caregiver's correction");
    await refresh(page, controls);
    await page.getByRole("heading", { name: "Sam", exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(controls.state.care.entries[0].data.answer, "Other caregiver's correction");
    assert.equal(await answer(page).inputValue(), "My synthetic draft");
    assert(controls.requests.filter((request) => request.method === "PATCH").every((request) => request.body.expect_updated_at === original));
    await page.getByText("Other caregiver's correction", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Use saved answer", exact: true }).click();
    assert.equal(await answer(page).inputValue(), "Other caregiver's correction");
    await answer(page).fill("My reviewed correction");
    controls.answerElsewhere("Second caregiver correction");
    await page.getByRole("heading", { name: "Sam", exact: true }).click();
    await page.getByText("Second caregiver correction", { exact: true }).waitFor();
    assert.equal(await answer(page).inputValue(), "My reviewed correction");
    assert.equal(controls.state.care.entries[0].data.answer, "Second caregiver correction");
    await page.getByRole("button", { name: "Save my answer instead", exact: true }).click();
    await waitFor(() => controls.state.care.entries[0].data.answer === "My reviewed correction");
    await page.getByText("Answer saved", { exact: true }).waitFor();
  }, true],
  ...["family", "member", "person"].map((scope) => [`${scope} changes clear care drafts in the actual provider`, async (page, controls) => {
    await question(page).fill("Sam's synthetic draft");
    if (scope === "family") controls.state.family = { id: 100, ask: "Casey" };
    if (scope === "member") controls.state.me = { ...controls.state.me, email: "helper@example.test" };
    if (scope === "person") controls.state.care.person = { ...controls.state.care.person, member: "casey@example.test" };
    controls.state.care.person.name = "Casey";
    controls.changed();
    await refresh(page, controls);
    await page.getByRole("heading", { name: "Casey", exact: true }).waitFor();
    assert.equal(await question(page).inputValue(), "");
    assert.equal(controls.requests.filter((request) => request.method === "POST").length, 0);
  }]),
  ...[false, true].map((historyFailure) => [`pending historical food stays visible${historyFailure ? " when history fails" : " and removable"}`, async (page, controls) => {
    controls.foodFailure = true;
    controls.historyFailure = historyFailure;
    await page.getByRole("button", { name: "Ate something", exact: true }).click();
    await page.getByLabel("What was it?", { exact: true }).fill("Synthetic earlier meal");
    await page.getByRole("button", { name: "Just now · Change time", exact: true }).click();
    await page.getByLabel("Eaten at: date", { exact: true }).fill("2026-10-24");
    await page.getByRole("button", { name: "Log food", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByLabel("Food and drink day", { exact: true }).selectOption("2026-10-24");
    await page.getByText("Synthetic earlier meal", { exact: true }).waitFor();
    await page.getByText("On this phone, not synced", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Edit Synthetic earlier meal", exact: true }).isDisabled(), true);
    if (historyFailure) {
      await page.getByRole("alert").filter({ hasText: "Couldn't load this day" }).waitFor();
      assert.equal(await page.getByRole("region", { name: "Recorded nutrition", exact: true }).count(), 0);
    }
    await page.getByRole("button", { name: "Remove Synthetic earlier meal", exact: true }).click();
    await page.getByText("Synthetic earlier meal", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("maple-outbox-v1") ?? "[]").length), 0);
  }]),
  ["medicine and temperature shortcuts precede nutrition details", async (page) => {
    const actions = await page.getByRole("group", { name: "Quick actions", exact: true }).boundingBox();
    const nutrition = await page.getByRole("region", { name: "Food & drink", exact: true }).boundingBox();
    assert(actions.y + actions.height <= nutrition.y);
    assert(actions.y + actions.height < 700, "Care shortcuts fit above the tab bar on a phone");
  }],
];
let failed = 0;
try {
  for (const [name, check, hasQuestion] of cases) {
    if (process.env.CARE_CASE && !name.includes(process.env.CARE_CASE)) continue;
    const controls = world();
    if (hasQuestion) controls.question();
    const { page, errors } = await visit(controls);
    try { await check(page, controls); assert.deepEqual(errors, []); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
    finally { await page.close(); }
  }
} finally { await browser.close(); await rm(output, { recursive: true, force: true }); }
if (failed) process.exit(1);
