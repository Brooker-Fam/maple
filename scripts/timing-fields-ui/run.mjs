import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, webkit } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const out = await mkdtemp(path.join(tmpdir(), "maple-timing-fields-"));
const browserName = process.env.REVIEW_BROWSER === "webkit" ? "webkit" : "chromium";
const browser = await { chromium, webkit }[browserName].launch();

try {
  await build({ entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(out, "app.js"), bundle: true, format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env": "{}" } });
  const context = await browser.newContext({ timezoneId: "UTC" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-10-28T13:30:50.000Z") });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, "https://timing-fields.example.test");
    if (url.pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(out, "app.js")) });
    if (url.pathname === "/api/maple/auth/me") return route.fulfill({ json: { signedIn: false, google: false, email: false, apple: false, password: false } });
    if (url.pathname === "/api/maple/state") return route.fulfill({ status: 401, json: { error: "Synthetic signed-out fixture" } });
    if (url.pathname === "/api/maple/diagnostics") return route.fulfill({ status: 204 });
    if (url.pathname.startsWith("/api/")) throw new Error(`Unexpected request: ${url.pathname}`);
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div><script type="module" src="/app.js"></script>' });
  });
  await page.goto("https://timing-fields.example.test");
  const clock = page.getByLabel("Recorded at: time", { exact: true });
  const save = page.getByRole("button", { name: "Save", exact: true });
  await clock.waitFor();
  await page.clock.setSystemTime(new Date("2026-10-28T13:31:10.000Z"));
  await clock.fill("09:32");
  assert(await save.isEnabled(), "A newly allowed clock must validate against the time of the edit, without waiting for the periodic clock refresh");
  await save.click();
  assert.equal(await page.getByLabel("Saved time").textContent(), "2026-10-28T13:32:00.000Z");
  assert.deepEqual(errors, []);
  console.log(`PASS entered clock uses the live validation limit (${browserName})`);
} finally {
  await browser.close();
  await rm(out, { recursive: true, force: true });
}
