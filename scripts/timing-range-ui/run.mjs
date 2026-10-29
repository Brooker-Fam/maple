import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, webkit } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const out = await mkdtemp(path.join(tmpdir(), "maple-timing-range-"));
const browserName = process.env.REVIEW_BROWSER === "webkit" ? "webkit" : "chromium";
const browser = await { chromium, webkit }[browserName].launch();
const baseline = process.env.MAPLE_TIMING_RANGE_BASELINE;

try {
  await build({
    entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(out, "app.js"), bundle: true, format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env": "{}" },
    plugins: baseline ? [{ name: "baseline-time-range", setup(plugin) {
      plugin.onLoad({ filter: /\/uiFields\.tsx$/ }, ({ path: file }) => ({ contents: execFileSync("git", ["show", `${baseline}:${path.relative(root, file)}`], { cwd: root, encoding: "utf8" }), loader: "tsx", resolveDir: path.dirname(file) }));
    } }] : [],
  });
  const context = await browser.newContext({ timezoneId: "UTC" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-10-29T03:59:50.000Z") });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, "https://timing-range.example.test");
    if (url.pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(out, "app.js")) });
    if (url.pathname === "/api/maple/auth/me") return route.fulfill({ json: { signedIn: false, google: false, email: false, apple: false, password: false } });
    if (url.pathname === "/api/maple/state") return route.fulfill({ status: 401, json: { error: "Synthetic signed-out fixture" } });
    if (url.pathname === "/api/maple/diagnostics") return route.fulfill({ status: 204 });
    if (url.pathname.startsWith("/api/")) throw new Error(`Unexpected request: ${url.pathname}`);
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div><script type="module" src="/app.js"></script>' });
  });
  await page.goto("https://timing-range.example.test");
  const end = page.getByRole("group", { name: "Ended", exact: true });
  await end.getByLabel("Ended: time", { exact: true }).waitFor();
  await page.clock.setFixedTime(new Date("2026-10-29T04:00:10.000Z"));
  await end.getByRole("button", { name: "Now", exact: true }).click();
  assert.equal(await end.getByLabel("Ended: date", { exact: true }).inputValue(), "2026-10-29");
  await end.getByRole("group", { name: "Day", exact: true }).getByRole("button", { name: "Today", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  assert.equal(await page.getByLabel("Saved end").textContent(), "2026-10-29T04:00:10.000Z", "Today must refer to the current family date after midnight, without waiting for the periodic clock refresh");
  assert.deepEqual(errors, []);
  console.log(`PASS Today preserves the selected current date across midnight (${browserName})`);
} finally {
  await browser.close();
  await rm(out, { recursive: true, force: true });
}
