import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queuedCases } from "./queued-cases.mjs";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");
const sharp = require("sharp");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const output = await mkdtemp(path.join(tmpdir(), "maple-photo-sharing-"));
const screenshots = path.join(root, "test-results/moments-sharing-ui");
await mkdir(screenshots, { recursive: true });
await build({ entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true, format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env.NODE_ENV": '"test"' }, plugins: [{ name: "synthetic-photo-sharing", setup(plugin) {
  const mock = { path: path.join(here, "mocks.jsx") };
  plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|sheets|EntryRow|AskChat|SignOutButton)$/ }, () => mock);
  plugin.onResolve({ filter: /^\.\/index$/ }, (args) => /\/sheets\/(?:parts|MomentSheet)\.tsx$/.test(args.importer) ? mock : undefined);
  plugin.onResolve({ filter: /^@vercel\/blob\/client$/ }, () => ({ path: path.join(here, "blob.jsx") }));
  if (process.env.MOMENTS_BASELINE) plugin.onLoad({ filter: /\/(?:MomentPhotos|MomentsTab|MomentSheet)\.tsx$/ }, ({ path: file }) => ({ contents: execFileSync("git", ["show", `${process.env.MOMENTS_BASELINE}:${path.relative(root, file)}`], { cwd: root, encoding: "utf8" }), loader: "tsx" }));
} }] });
await build({ entryPoints: [path.join(here, "queued-fixture.jsx")], outfile: path.join(output, "queued.js"), bundle: true, format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env": "{}" }, plugins: [{ name: "queued-photo-components", setup(plugin) {
  const mock = { path: path.join(here, "mocks.jsx") };
  plugin.onResolve({ filter: /(?:^|\/)(?:AskChat|SignOutButton|sheets)$/ }, () => mock);
  plugin.onResolve({ filter: /^\.\/index$/ }, (args) => /\/sheets\/(?:parts|MomentSheet)\.tsx$/.test(args.importer) ? mock : undefined);
} }] });
const cssFile = path.join(root, "src/app/globals.css");
const css = await postcss([tailwind({ base: root })]).process(await readFile(cssFile, "utf8"), { from: cssFile });
await writeFile(path.join(output, "app.css"), css.css + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
const jpeg = await sharp({ create: { width: 600, height: 800, channels: 3, background: "#869d7e" } }).composite([{ input: Buffer.from('<svg width="600" height="800"><circle cx="300" cy="330" r="140" fill="#f3d397"/><path d="M100 660L300 440L500 660Z" fill="#41645b"/></svg>') }]).jpeg().toBuffer();
const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
await context.addInitScript(() => {
  Object.defineProperty(navigator, "share", { configurable: true, value: async (data) => { if (window.__shareFailure) throw new Error("Synthetic sharing failure"); window.__shared = { keys: Object.keys(data), type: data.files?.[0]?.type, size: data.files?.[0]?.size }; } });
  Object.defineProperty(navigator, "canShare", { configurable: true, value: () => !window.__unsupportedShare });
});
const page = await context.newPage();
page.setDefaultTimeout(2500);
const errors = [];
const discarded = [];
let photoFailure = false;
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/maple/photo") return route.fulfill(photoFailure ? { status: 503, body: "Synthetic photo failure" } : { contentType: "image/jpeg", body: jpeg });
  if (url.pathname === "/api/maple/upload") {
    if (request.method() === "DELETE") discarded.push(JSON.parse(request.postData()).urls);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ready: true, access: "private", maxBytes: 10485760, familyId: 99, prefix: "maple/f99/" }) });
  }
  const file = ["/app.js", "/app.css"].includes(url.pathname) ? url.pathname.slice(1) : null;
  return route.fulfill({ contentType: file?.endsWith("js") ? "text/javascript" : file ? "text/css" : "text/html", body: file ? await readFile(path.join(output, file)) : '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>' });
});
const visit = async (mode = "gallery") => { photoFailure = false; discarded.length = 0; await page.goto(`https://photos.example.test/?mode=${mode}`); };
const openPhoto = async () => { await page.getByRole("button", { name: /^Example photo,/ }).click(); await page.getByRole("dialog", { name: "Moment", exact: true }).waitFor(); };
const upload = async () => {
  await page.locator('input[type="file"][multiple]').setInputFiles({ name: "synthetic-photo.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Uploaded"]').length === 2);
};
const snapshot = () => page.evaluate(() => window.__photoFixture.calls());
const cases = [
  ...queuedCases({ assert, browser, readFile, output }),
  ["native share sends authenticated photo bytes without a private URL", async () => {
    await visit(); await openPhoto();
    const share = page.getByRole("button", { name: "Share photo", exact: true });
    await share.click();
    assert.deepEqual(await page.evaluate(() => window.__shared), { keys: ["files"], type: "image/jpeg", size: jpeg.length });
    assert(await page.locator('[role="dialog"] img[src*="photo=aaaaaaaa"]').count());
    await page.evaluate(() => { window.__shareFailure = true; });
    await share.click();
    await page.getByRole("status").filter({ hasText: "Couldn't open sharing" }).waitFor();
  }],
  ["unsupported sharing offers a private-byte download", async () => {
    await visit(); await page.evaluate(() => { window.__unsupportedShare = true; }); await openPhoto();
    const save = page.getByRole("link", { name: "Save photo", exact: true });
    await save.waitFor();
    assert.equal(await page.getByRole("button", { name: "Share photo", exact: true }).count(), 0);
    assert((await save.getAttribute("href")).startsWith("blob:"));
    const downloading = page.waitForEvent("download"); await save.click(); const download = await downloading;
    assert.equal(download.suggestedFilename(), "maple-901-1.jpg");
    assert.deepEqual(await readFile(await download.path()), jpeg);
  }],
  ["sharing preparation retries a failed authenticated image", async () => {
    await visit(); photoFailure = true; await openPhoto();
    const alert = page.getByRole("alert").filter({ hasText: "Couldn't prepare this photo for sharing" });
    await alert.waitFor(); photoFailure = false; await alert.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("link", { name: "Save photo", exact: true }).waitFor();
  }],
  ["saved moment photos can be replaced while preserving retained ids and revision", async () => {
    await visit("edit");
    await page.getByRole("button", { name: "Remove photo", exact: true }).first().click(); await upload();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    const patch = (await snapshot()).find((call) => call.patch).patch;
    assert.equal(patch.expect_updated_at, "2026-10-28T13:30:00.000Z");
    assert.equal(patch.data.photos.length, 2); assert.equal(patch.data.photos[0].id, "b".repeat(32));
    assert.match(patch.data.photos[1].key, /maple\/f99\/moments\//);
    assert.equal(discarded.length, 0);
  }],
  ["caption edits retain saved photos through Strict Mode cleanup", async () => {
    await visit("strict");
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("A caption edit");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    const patch = (await snapshot()).find((call) => call.patch).patch;
    assert.deepEqual(patch.data.photos.map((photo) => photo.id), ["a".repeat(32), "b".repeat(32)]);
    assert.equal(patch.data.title, "A caption edit");
    assert.equal(discarded.length, 0);
  }],
  ["failed photo edit keeps uploads and caption for retry", async () => {
    await visit("edit"); await page.getByRole("button", { name: "Remove photo", exact: true }).first().click(); await upload();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("My kept draft");
    await page.evaluate(() => { window.__failSave = true; });
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Your draft is still here" }).waitFor();
    assert.equal(discarded.length, 0); assert.equal(await page.getByRole("textbox", { name: "Title", exact: true }).inputValue(), "My kept draft");
    await page.evaluate(() => { window.__failSave = false; }); await page.getByRole("button", { name: "Save changes", exact: true }).click();
    const calls = (await snapshot()).filter((call) => call.patch); assert.deepEqual(calls[0], calls[1]);
  }],
  ["conflict retains the draft until explicitly loading the latest moment", async () => {
    await visit("edit"); await page.getByRole("button", { name: "Remove photo", exact: true }).first().click(); await upload();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("My conflicting draft");
    await page.evaluate(() => { window.__conflict = true; }); await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByText("Someone changed this moment while you were editing.", { exact: false }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Title", exact: true }).inputValue(), "My conflicting draft"); assert.equal(discarded.length, 0);
    await page.getByRole("button", { name: "Discard draft and load latest", exact: true }).click();
    assert.equal(await page.getByRole("textbox", { name: "Title", exact: true }).inputValue(), "Latest family caption");
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="Uploaded"]').length === 2);
    assert.equal(discarded.flat().length, 2); assert(discarded.flat().every((url) => url.includes("synthetic.private.blob")));
  }],
  ["uncertain save keeps attempted uploads when the draft removes them", async () => {
    await visit("edit"); await page.getByRole("button", { name: "Remove photo", exact: true }).first().click(); await upload();
    await page.evaluate(() => { window.__failSave = true; }); await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Your draft is still here" }).waitFor();
    await page.getByRole("button", { name: "Remove photo", exact: true }).last().click();
    await page.waitForTimeout(100);
    assert.equal(discarded.length, 0, "A lost save response must not delete bytes that the server could still attach");
  }],
  ["photo guests get the scrapbook without developmental suggestions or editing", async () => {
    await visit("guest"); await page.getByRole("heading", { name: "Moments", exact: true }).waitFor();
    assert.equal(await page.getByText("Milestones to notice", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Add a moment", exact: true }).count(), 0);
    await openPhoto(); assert.equal(await page.getByRole("button", { name: "Edit", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Share photo", exact: true }).waitFor();
  }],
  ["owners can open family invitations from Moments", async () => {
    await visit(); await page.getByRole("button", { name: "Invite family to see photos", exact: true }).click();
    await page.waitForFunction(() => location.hash === "#family/people");
    await visit("guest"); assert.equal(await page.getByRole("button", { name: "Invite family to see photos", exact: true }).count(), 0);
  }],
  ["share controls fit small phones and night mode", async () => {
    for (const night of [false, true]) {
      await page.setViewportSize({ width: 320, height: 568 }); await visit();
      if (night) await page.evaluate(() => window.__photoFixture.night());
      await openPhoto(); await page.getByRole("link", { name: "Save photo", exact: true }).waitFor();
      await page.waitForFunction(() => { const photo = document.querySelector('[role="dialog"] img[src*="size=full"]'); return photo?.complete && photo.naturalWidth > 0 && getComputedStyle(photo).opacity === "1"; });
      for (const control of [page.getByRole("button", { name: "Share photo", exact: true }), page.getByRole("link", { name: "Save photo", exact: true })]) {
        const box = await control.boundingBox(); assert(box && box.height >= 44 && box.x >= 0 && box.x + box.width <= 320 && box.y + box.height <= 568);
      }
      await page.screenshot({ path: path.join(screenshots, `photo-320-${night ? "night" : "day"}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 }); await visit("edit");
    await page.getByRole("button", { name: "Choose photos", exact: true }).waitFor().catch(() => page.getByRole("button", { name: "Add more", exact: true }).waitFor());
    await page.screenshot({ path: path.join(screenshots, "edit-390.png") });
  }],
];
let failed = 0;
try {
  for (const [name, run] of cases) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
  }
  assert.deepEqual(errors, []);
  console.log(`${cases.length - failed} passed, ${failed} failed`);
} finally { await browser.close(); await rm(output, { recursive: true, force: true }); }
if (failed) process.exit(1);
