import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const output = await mkdtemp(path.join(tmpdir(), "maple-chat-images-ui-"));
const screenshots = path.join(root, "test-results/chat-images-ui");
await mkdir(screenshots, { recursive: true });
await build({ entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true, format: "esm", jsx: "automatic", absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"test"' }, plugins: [{ name: "synthetic-images-boundaries", setup(plugin) {
    const mocks = { path: path.join(here, "../chat-ui-check/mocks.jsx") };
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav|ChatNav|useTimerActions|AppNav|sheets)$/ }, () => mocks);
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => args.importer.endsWith("/sheets/parts.tsx") ? mocks : undefined);
  } }],
});
const css = path.join(root, "src/app/globals.css");
const compiled = await postcss([tailwind({ base: root })]).process(await readFile(css, "utf8"), { from: css });
await writeFile(path.join(output, "app.css"), compiled.css + "\n" + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
await writeFile(path.join(output, "index.html"), '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic chat photo checks</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const context = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
const page = await context.newPage();
page.setDefaultTimeout(5000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const origin = "https://maple-chat-images.example.test";
let messages = [], sends = [], uploads = [], uploadMode = "ok", heldUpload, sendFails = false;
let id = 0;
const nextImage = () => ({ type: "file", mediaType: "image/jpeg", url: `/api/maple/chat/images?id=00000000-0000-4000-8000-${String(++id).padStart(12, "0")}` });
const syntheticPng = Buffer.from(await page.evaluate(() => {
  const canvas = document.createElement("canvas"); canvas.width = 400; canvas.height = 300;
  const context = canvas.getContext("2d"); context.fillStyle = "#e9dbc7"; context.fillRect(0, 0, 400, 300);
  context.fillStyle = "#fffdf7"; context.beginPath(); context.ellipse(200, 150, 150, 125, 0, 0, Math.PI * 2); context.fill();
  context.fillStyle = "#e9a24d"; context.fillRect(110, 95, 100, 110);
  context.fillStyle = "#649665";
  for (const [x, y] of [[255, 105], [275, 155], [245, 190]]) { context.beginPath(); context.arc(x, y, 28, 0, Math.PI * 2); context.fill(); }
  return canvas.toDataURL("image/png").split(",")[1];
}), "base64");
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
await page.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  assert.equal(url.origin, origin, "Synthetic browser checks never contact outside services");
  if (url.pathname === "/api/maple/chat/images") {
    if (request.method() === "GET") return route.fulfill({ status: 200, contentType: "image/png", body: syntheticPng });
    uploads.push({ family: request.headers()["x-maple-family"], bytes: request.postDataBuffer() });
    if (uploadMode === "hold") { heldUpload = route; return; }
    if (uploadMode === "fail") return json(route, { error: "Photo upload unavailable. Try again." }, 503);
    if (uploadMode === "invalid") return json(route, { image: { ...nextImage(), url: "https://unsafe.example.test/photo.jpg" } });
    return json(route, { image: nextImage() });
  }
  if (url.pathname === "/api/maple/chat") {
    if (request.method() === "GET") return json(route, { current: { id: "synthetic-images-thread", busy: false }, items: messages.map((message) => ({ thread: "synthetic-images-thread", message })), more: false,
      ...(url.searchParams.has("requestId") ? { delivery: { requestId: url.searchParams.get("requestId"), state: "missing", threadId: null, busy: false } } : {}),
    });
    if (request.method() === "DELETE") { messages = []; return json(route, { ok: true }); }
    const body = request.postDataJSON();
    sends.push(body);
    if (sendFails) return json(route, { error: "Synthetic send failed" }, 503);
    const answer = { id: `synthetic-answer-${sends.length}`, role: "assistant", parts: [{ type: "text", text: "I can describe this example photo." }] };
    messages.push(body.message, answer);
    const chunks = [{ type: "start", messageId: answer.id }, { type: "start-step" }, { type: "text-start", id: "answer" }, { type: "text-delta", id: "answer", delta: answer.parts[0].text }, { type: "text-end", id: "answer" }, { type: "finish-step" }, { type: "finish", finishReason: "stop" }];
    return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" }, body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n" });
  }
  const file = ["/app.js", "/app.css"].includes(url.pathname) ? url.pathname.slice(1) : "index.html";
  return route.fulfill({ status: 200, contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html", body: await readFile(path.join(output, file)) });
});
const photoFile = { name: "synthetic-photo.png", mimeType: "image/png", buffer: syntheticPng };
const add = () => page.getByRole("button", { name: "Add photo", exact: true });
const message = () => page.getByRole("textbox", { name: "Message", exact: true });
const choose = async (files = [photoFile]) => {
  await page.getByLabel("Choose chat photos", { exact: true }).setInputFiles(files);
};
const attached = () => page.getByRole("button", { name: "Remove photo 1", exact: true });
const ready = () => page.getByRole("button", { name: "Feeding", exact: true }).waitFor();
const fixture = (fn, value) => page.evaluate(([method, arg]) => window.__imageFixture[method](arg), [fn, value]);
const reset = async () => {
  messages = []; sends = []; uploads = []; uploadMode = "ok"; sendFails = false; heldUpload = null;
  await page.goto(origin);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await ready();
  assert(await add().count(), "Chat exposes the photo attachment control");
};
const checks = [
  ["image-only send and authenticated history thumbnails", async () => {
    await add().click();
    await page.getByRole("button", { name: "Choose photos", exact: true }).waitFor();
    await page.getByRole("button", { name: "Take photo", exact: true }).waitFor();
    assert.equal(await page.getByLabel("Take chat photo", { exact: true }).getAttribute("capture"), "environment");
    await choose(); await attached().waitFor();
    assert.equal(uploads[0].family, "99");
    assert(uploads[0].bytes.includes(Buffer.from("image/jpeg")), "Phone normalizes image encoding before upload");
    assert(uploads[0].bytes.length < 512 * 1024 + 1024, "Image upload stays below the private image cap");
    const link = page.getByRole("link", { name: "Open photo 1", exact: true });
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
    assert((await link.getAttribute("href")).startsWith("/api/maple/chat/images?id="));
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("I can describe this example photo.", { exact: true }).waitFor();
    assert.equal(sends.length, 1);
    assert.equal(sends[0].message.parts.filter((part) => part.type === "file").length, 1);
    assert.equal(sends[0].message.parts.filter((part) => part.type === "text").length, 0);
    await page.reload(); await page.getByRole("img", { name: "Attached photo 1", exact: true }).waitFor();
    assert.equal(sends.length, 1, "History reload does not resend images");
  }],
  ["two-photo cap, removal, and optional caption", async () => {
    await message().fill("Describe this synthetic meal without saving it.");
    await choose([photoFile, { ...photoFile, name: "synthetic-second.png" }]);
    await page.getByRole("button", { name: "Remove photo 2", exact: true }).waitFor();
    assert(await add().isDisabled());
    await attached().click();
    assert(await add().isEnabled());
    assert.equal(await page.getByRole("img", { name: "Attached photo 1", exact: true }).count(), 1);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("I can describe this example photo.", { exact: true }).waitFor();
    assert.equal(sends[0].message.parts.find((part) => part.type === "text").text, "Describe this synthetic meal without saving it.");
    assert.equal(sends[0].message.parts.filter((part) => part.type === "file").length, 1);
  }],
  ["draft reload, tab switch, offline queue, edit and deliberate resume", async () => {
    await choose(); await attached().waitFor();
    await fixture("setActive", false); await fixture("setActive", true); await attached().waitFor();
    await page.reload(); await attached().waitFor();
    assert(!JSON.stringify(await page.evaluate(() => ({ ...localStorage }))).includes("data:image"), "Only image references persist in browser storage");
    await fixture("setOnline", false); assert(await add().isDisabled());
    await page.getByRole("button", { name: "Queue message", exact: true }).click();
    await page.getByRole("region", { name: "Message queue", exact: true }).waitFor();
    assert.equal(sends.length, 0);
    await page.reload();
    const queue = page.getByRole("region", { name: "Message queue", exact: true });
    await queue.getByRole("button", { name: "Resume", exact: true }).waitFor();
    assert.equal(sends.length, 0);
    await queue.getByRole("button", { name: "Edit", exact: true }).click();
    await queue.getByRole("button", { name: "Save changes", exact: true }).click();
    await queue.getByRole("button", { name: "Edit", exact: true }).waitFor();
    await queue.getByRole("button", { name: "Resume", exact: true }).click();
    await page.getByText("I can describe this example photo.", { exact: true }).waitFor();
    assert.equal(sends[0].message.parts.filter((part) => part.type === "file").length, 1);
  }],
  ["queued editing can explicitly remove a photo without losing the caption", async () => {
    await message().fill("This synthetic caption should stay.");
    await choose(); await attached().waitFor();
    await fixture("setOnline", false);
    await page.getByRole("button", { name: "Queue message", exact: true }).click();
    const queue = page.getByRole("region", { name: "Message queue", exact: true });
    await queue.getByRole("button", { name: "Edit", exact: true }).click();
    await queue.getByRole("button", { name: "Remove photo 1", exact: true }).click();
    await queue.getByRole("button", { name: "Save changes", exact: true }).click();
    await fixture("setOnline", true);
    await queue.getByRole("button", { name: "Resume", exact: true }).click();
    await page.getByText("I can describe this example photo.", { exact: true }).waitFor();
    assert.deepEqual(sends[0].message.parts, [{ type: "text", text: "This synthetic caption should stay." }]);
  }],
  ["upload errors preserve caption and reject unsafe references", async () => {
    await message().fill("Keep this synthetic caption");
    uploadMode = "fail"; await choose();
    await page.getByText("Photo upload unavailable. Try again.", { exact: true }).waitFor();
    assert.equal(await message().inputValue(), "Keep this synthetic caption");
    assert.equal(await attached().count(), 0);
    assert(await page.getByRole("button", { name: "Send", exact: true }).isDisabled());
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    uploadMode = "invalid"; await choose();
    await page.getByText("Couldn't attach that photo. Try again.", { exact: true }).waitFor();
    assert.equal(await attached().count(), 0);
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await choose([{ name: "synthetic.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') }]);
    await page.getByText("Choose a JPEG, PNG or WebP photo.", { exact: true }).waitFor();
    assert.equal(uploads.length, 2, "Unsupported file is rejected before upload");
    assert.equal(await message().inputValue(), "Keep this synthetic caption");
  }],
  ["terms and scope changes cannot attach a pending upload to another family", async () => {
    await fixture("setTerms", false); assert(await add().isDisabled());
    await fixture("setTerms", true); assert(await add().isEnabled());
    uploadMode = "hold"; await choose();
    await page.getByText("Uploading photo…", { exact: true }).waitFor();
    await page.waitForFunction(() => !!document.querySelector('input[aria-label="Choose chat photos"]'));
    while (!heldUpload) await new Promise((resolve) => setTimeout(resolve, 20));
    await fixture("setFamily", 100);
    await json(heldUpload, { image: nextImage() }).catch(() => {});
    await ready();
    assert.equal(await attached().count(), 0);
    assert.equal(uploads[0].family, "99");
    assert.equal(await message().inputValue(), "");
    uploadMode = "ok"; await choose(); await attached().waitFor();
    assert.equal(uploads[1].family, "100");
  }],
  ["deleting history cancels a pending photo attachment", async () => {
    await message().fill("Describe this synthetic example.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("I can describe this example photo.", { exact: true }).waitFor();
    uploadMode = "hold"; await choose();
    await page.getByText("Uploading photo…", { exact: true }).waitFor();
    while (!heldUpload) await new Promise((resolve) => setTimeout(resolve, 20));
    await page.getByRole("button", { name: "Delete chat history", exact: true }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await ready();
    await json(heldUpload, { image: nextImage() }).catch(() => {});
    await page.getByText("Uploading photo…", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(await attached().count(), 0);
    assert.equal(await page.getByRole("img", { name: "Attached photo 1", exact: true }).count(), 0);
  }],
  ["failed message retry preserves original photo and request identity", async () => {
    await choose(); await attached().waitFor();
    sendFails = true;
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    sendFails = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByText("I can describe this example photo.", { exact: true }).waitFor();
    assert.equal(sends.length, 2);
    assert.deepEqual(sends[0], sends[1], "Retry preserves the exact attachment and original delivery identity");
  }],
  ["mobile photo composer fits day and night screens", async () => {
    await choose([photoFile, { ...photoFile, name: "synthetic-second.png" }]);
    await page.getByRole("button", { name: "Remove photo 2", exact: true }).waitFor();
    await message().fill("What can you tell from these synthetic photos?");
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 667 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const box = await page.getByRole("button", { name: "Send", exact: true }).boundingBox();
      assert(box && box.width >= 44 && box.height >= 44 && box.y + box.height <= 667);
      await page.screenshot({ path: path.join(screenshots, `composer-${width}-day.png`) });
    }
    await page.evaluate(() => document.documentElement.classList.add("dark", "maple-night"));
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
    await page.screenshot({ path: path.join(screenshots, "composer-375-night.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark", "maple-night"));
    await page.setViewportSize({ width: 375, height: 812 });
  }],
];
let failures = 0;
try {
  for (const [name, run] of checks.filter(([name]) => !process.env.CHAT_IMAGES_UI_CASE || name.includes(process.env.CHAT_IMAGES_UI_CASE))) {
    try { await reset(); await run(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
  }
  assert.deepEqual(errors, [], "Browser must have no runtime errors");
} finally {
  await browser.close(); await rm(output, { recursive: true, force: true });
}
if (failures) process.exitCode = 1;
