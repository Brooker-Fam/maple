import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const output = await mkdtemp(path.join(tmpdir(), "maple-lantern-"));
await build({
  entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", absWorkingDir: root, tsconfig: path.join(root, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"test"' },
  plugins: [{ name: "synthetic-lantern-boundaries", setup(plugin) {
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|useTimerActions|sheets)$/ }, () => ({ path: path.join(here, "mocks.jsx") }));
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => args.importer.endsWith("/sheets/parts.tsx") ? { path: path.join(here, "mocks.jsx") } : undefined);
  } }],
});
const css = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, "src/app/globals.css"), "utf8"), { from: path.join(root, "src/app/globals.css") });
await writeFile(path.join(output, "app.css"), css.css + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
const html = '<!doctype html><html class="maple-ui maple-night"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link href="/app.css" rel="stylesheet"></head><body><div id="root"></div><div id="already-inert" inert><button>Unavailable</button></div><script type="module" src="/app.js"></script></body></html>';
const browserName = process.env.REVIEW_BROWSER === "webkit" ? "webkit" : "chromium";
const browser = await ({ chromium, webkit }[browserName]).launch({ headless: true });
const errors = [];
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", hasTouch: true });
const page = await context.newPage();
page.setDefaultTimeout(5000);
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
  let releaseCount = 0;
  const pending = [];
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: () => new Promise((resolve) => pending.push(resolve)) } });
  window.__wake = {
    resolve: () => pending.splice(0).forEach((resolve) => resolve({ release: async () => { releaseCount++; } })),
    releases: () => releaseCount,
  };
});
await page.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, "https://lantern.example.test", "Every request must remain inside the synthetic fixture");
  assert(!url.pathname.startsWith("/api/"), "No fixture may reach an API");
  const file = url.pathname === "/app.js" ? "app.js" : url.pathname === "/app.css" ? "app.css" : null;
  await route.fulfill({ contentType: file?.endsWith("js") ? "text/javascript" : file ? "text/css" : "text/html", body: file ? await readFile(path.join(output, file)) : html });
});
const dialog = page.getByRole("dialog", { name: "Lantern timer", exact: true });
const close = page.getByRole("button", { name: "Close lantern", exact: true });
const pause = page.getByRole("button", { name: "Pause the feed (press and hold)", exact: true });
const calls = () => page.evaluate(() => window.__lantern.calls());
const open = async (query = "") => {
  await page.goto(`https://lantern.example.test/${query}`);
  await page.getByRole("button", { name: "Open lantern", exact: true }).click();
  await dialog.waitFor();
};
const center = async (button) => {
  const box = await button.boundingBox();
  assert(box);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

try {
  await open();
  assert(await close.evaluate((element) => element === document.activeElement), "Opening focuses the close control");
  assert(await page.locator("#root").evaluate((element) => element.inert), "Covered timer controls must be inert");
  await page.keyboard.press("Shift+Tab");
  assert(await page.getByRole("button", { name: "Done (press and hold)", exact: true }).evaluate((element) => element === document.activeElement), "Back-tab wraps to the last control");
  await page.keyboard.press("Tab");
  assert(await close.evaluate((element) => element === document.activeElement), "Tab wraps to the close control");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert(await page.getByRole("button", { name: "Open lantern", exact: true }).evaluate((element) => element === document.activeElement), "Closing restores the opener");
  assert.equal(await page.locator("#root").evaluate((element) => element.inert), false);
  assert.equal(await page.locator("#already-inert").evaluate((element) => element.inert), true, "Pre-existing inert state is preserved");
  await page.evaluate(() => window.__wake.resolve());
  await page.waitForFunction(() => window.__wake.releases() === 1);
  assert.notEqual(await page.evaluate(() => document.body.style.overflow), "hidden");
  console.log("PASS Lantern: focus enters, cycles, restores; background locked; late wake lock released");

  await open();
  await pause.focus();
  await page.keyboard.press("Space");
  assert.deepEqual(await calls(), ["pause"], "Space activates once");
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  assert.deepEqual(await calls(), ["pause", "pause"], "Enter auto-repeat must not send additional actions");
  await pause.evaluate((element) => element.click());
  assert.deepEqual(await calls(), ["pause", "pause", "pause"], "Assistive click activation works without a pointer hold");
  console.log("PASS Lantern: Space, Enter without repeats, assistive activation");

  await open("?both-row&care");
  await page.getByRole("button", { name: /^Going back and forth\?/ }).press("Space");
  await page.getByRole("button", { name: /^Log your Example medicine:/ }).press("Space");
  assert.deepEqual(await calls(), ["both", "dose"], "The same keyboard behavior reaches both small hold rows");
  console.log("PASS Lantern: keyboard reaches back-and-forth and care hold rows");

  await open();
  let point = await center(pause);
  await page.touchscreen.tap(point.x, point.y);
  assert.deepEqual(await calls(), [], "A short touch only gives the hold hint");
  await page.getByText("Hold to pause", { exact: true }).waitFor();
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  assert.deepEqual(await calls(), ["pause"], "A half-second hold confirms only once, including release");
  await page.mouse.down();
  await page.mouse.move(point.x + 25, point.y);
  await page.waitForTimeout(650);
  await page.mouse.up();
  assert.deepEqual(await calls(), ["pause"], "Moving away cancels a hold");
  console.log("PASS Lantern: short touch, deliberate hold, movement cancellation");

  await open("?care");
  const dose = page.getByRole("button", { name: /^Log your Example medicine:/ });
  point = await center(dose);
  await dose.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: point.x, clientY: point.y });
  await dose.dispatchEvent("pointermove", { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: point.x, clientY: point.y + 120 });
  await page.waitForTimeout(550);
  await dose.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: point.x, clientY: point.y + 120 });
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(await calls(), [], "Swiping down from a hold row must close without saving");
  console.log("PASS Lantern: a swipe starting on a dose does not log it");

  await open();
  await dialog.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 150, clientY: 150 });
  await dialog.dispatchEvent("pointerdown", { pointerId: 2, pointerType: "touch", isPrimary: false, clientX: 200, clientY: 150 });
  await dialog.dispatchEvent("pointerup", { pointerId: 2, pointerType: "touch", isPrimary: false, clientX: 200, clientY: 150 });
  await dialog.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 150, clientY: 300 });
  assert(await dialog.isVisible(), "A second finger cancels swipe-to-close until every finger lifts");
  assert.deepEqual(await calls(), []);
  await page.evaluate(() => window.__wake.resolve());
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__wake.releases() === 1);
  console.log("PASS Lantern: two-finger swipe guard; acquired wake lock released on close");

  await open("?long");
  await page.getByRole("button", { name: "Done: choose when the feed ended (press and hold)", exact: true }).press("Space");
  await dialog.waitFor({ state: "hidden" });
  const nextSheet = page.getByRole("dialog", { name: "When did the feed end?", exact: true });
  await nextSheet.waitFor();
  assert(await nextSheet.evaluate((element) => element.contains(document.activeElement)), "The finish-time sheet receives focus");
  assert.deepEqual(await calls(), [], "A forgotten timer still asks for its finish time before saving");
  await nextSheet.getByRole("button", { name: "Close", exact: true }).click();
  await nextSheet.waitFor({ state: "hidden" });
  assert.equal(await page.locator("#root").evaluate((element) => element.inert), false, "Changing from Lantern to a sheet leaves no background lock behind");
  console.log("PASS Lantern: forgotten timer opens finish-time sheet without saving");

  await open("?sleep");
  await page.getByRole("button", { name: "Woke up (press and hold)", exact: true }).press("Space");
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(await calls(), ["stop"]);
  assert.deepEqual(errors, []);
  console.log(`PASS Lantern: sleep stops once; no runtime errors (${browserName})`);
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
