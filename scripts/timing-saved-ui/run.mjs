import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium, webkit } = require("playwright");
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const tailwind = require("@tailwindcss/postcss");
const out = await mkdtemp(path.join(tmpdir(), "maple-timing-saved-"));
const baseline = process.env.MAPLE_TIMING_SAVED_BASELINE;
await build({
  entryPoints: [path.join(root, "scripts/first-use-ui/fixture.jsx")], outfile: path.join(out, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", absWorkingDir: root, tsconfig: path.join(root, "tsconfig.json"),
  define: { "process.env": "{}" }, plugins: [{ name: "synthetic-browser", setup(plugin) {
    plugin.onResolve({ filter: /^next\/dynamic$/ }, () => ({ path: "dynamic", namespace: "synthetic-runtime" }));
    plugin.onLoad({ filter: /.*/, namespace: "synthetic-runtime" }, () => ({ contents: 'import {lazy,Suspense} from "react"; export default function dynamic(load){const Component=lazy(load);return function Dynamic(props){return <Suspense fallback={<p>Loading view…</p>}><Component {...props}/></Suspense>}}', loader: "jsx", resolveDir: root }));
    if (baseline) plugin.onLoad({ filter: /\/(?:SleepSheet|PumpSheet|ActivitySheet|DiaperSheet)\.tsx$/ }, ({ path: file }) => ({ contents: execFileSync("git", ["show", `${baseline}:${path.relative(root, file)}`], { cwd: root, encoding: "utf8" }), loader: "tsx", resolveDir: path.dirname(file) }));
  } }],
});
const css = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, "src/app/globals.css"), "utf8"), { from: path.join(root, "src/app/globals.css") });
await writeFile(path.join(out, "app.css"), css.css + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
const html = '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link href="/app.css" rel="stylesheet"></head><body><div id="root"></div><script src="/app.js" type="module"></script></body></html>';
const NOW = "2026-10-28T13:30:00.000Z";
const me = { email: "sam@example.test", display_name: "Sam", role: "owner", emoji: null, color: null };
const browserName = process.env.REVIEW_BROWSER === "webkit" ? "webkit" : "chromium";
const browser = await ({ chromium, webkit }[browserName]).launch({ headless: true });

async function fixture(kind, historical, conflictOnSave = true) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", timezoneId: "UTC" });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(NOW));
  page.setDefaultTimeout(5000);
  const errors = [];
  const writes = [];
  const day = historical ? "2026-10-24" : "2026-10-28";
  let saved = { id: 401, kind, started_at: `${day}T12:00:00.000Z`, ended_at: kind === "diaper" ? null : `${day}T12:30:00.000Z`, active: false, data: kind === "diaper" ? { pee: true, poop: false } : {}, note: null, created_by: me.email, updated_by: null, created_at: `${day}T12:00:00.000Z`, updated_at: `${day}T12:30:00.000Z`, source: "web" };
  const state = { now: NOW, rev: "saved-1", seen_at: null, family: { id: 99, ask: "Sam" }, baby: { id: 99, name: "River", nickname: null, sex: null, timezone: "America/New_York", born_at: "2026-10-01T12:00:00.000Z", due_date: "2026-10-01", birth_weight_g: null, birth_length_cm: null, birth_head_cm: null, settings: { show_alerts: false } }, me, members: [me], entries: [saved], growth: [], lifetime: { diapers: 0, feeds: 0, firsts: { poop: null, bath: null, tummy: null } }, care: null };
  if (historical) state.entries = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    assert.equal(url.origin, "https://timing-saved.example.test", "Every request stays in the synthetic fixture");
    const p = url.pathname;
    if (!p.startsWith("/api/")) {
      const file = p === "/app.js" ? "app.js" : p === "/app.css" ? "app.css" : null;
      return route.fulfill({ contentType: file?.endsWith("js") ? "text/javascript" : file ? "text/css" : "text/html", body: file ? await readFile(path.join(out, file)) : html });
    }
    const json = (body) => route.fulfill({ json: body });
    if (p === "/api/maple/auth/me") return json({ signedIn: true, google: false, email: false, apple: false, password: false });
    if (p === "/api/maple/state") return json(state);
    if (p === "/api/maple/diagnostics") return route.fulfill({ status: 204, body: "" });
    if (p === "/api/maple/chat/consent") return json({ terms: true, care: false, self: false });
    if (p === "/api/maple/onboarding") return json({ needed: false });
    if (p === "/api/maple/push") return json({ publicKey: null, sub: null, health: { needs_resubscribe: false }, reminders: [] });
    if (p === "/api/maple/entries") {
      if (req.method() === "GET") return json({ entries: [saved], next_cursor: null, truncated: false });
      assert.equal(req.method(), "PATCH");
      const body = req.postDataJSON();
      writes.push(body);
      if (conflictOnSave && writes.length === 1) {
        saved = { ...saved, started_at: `${day}T12:02:00.000Z`, note: "Synthetic note from another phone", updated_at: "2026-10-28T13:29:00.000Z" };
        state.entries = historical ? [] : [saved];
        state.rev = "saved-conflict";
      }
      if (body.expect_updated_at && body.expect_updated_at !== saved.updated_at) return route.fulfill({ status: 409, json: { error: "Someone else just changed this. Have another look and try again.", reason: "changed", entry: saved } });
      saved = { ...saved, ...body, data: { ...saved.data, ...body.data }, updated_at: NOW };
      state.entries = historical ? [] : [saved];
      state.rev = "saved-2";
      return json({ entry: saved });
    }
    return route.fulfill({ status: 500, json: { error: "Unexpected synthetic endpoint" } });
  });
  await page.goto("https://timing-saved.example.test/#log");
  await page.getByRole("button", { name: /^Edit:/ }).click();
  const form = page.getByRole("dialog");
  await form.waitFor();
  return { page, form, writes, errors, state, day, saved: () => saved, close: () => context.close() };
}

let failures = 0;
try {
  for (const [kind, historical] of [["sleep", false], ["pump", false], ["tummy", false], ["bath", false], ["diaper", false], ["sleep", true]]) {
    if (process.env.MAPLE_TIMING_SAVED_CASE && kind !== process.env.MAPLE_TIMING_SAVED_CASE) continue;
    const f = await fixture(kind, historical);
    try {
      const time = f.form.locator('input[type="time"]').first();
      await time.fill("07:59");
      await f.form.locator("textarea").fill("Synthetic unsaved draft");
      await Promise.all([
        f.page.waitForResponse((response) => response.request().method() === "GET" && response.url().includes("/api/maple/state")),
        f.form.getByRole("button", { name: "Save", exact: true }).click(),
      ]);
      assert.equal(f.saved().started_at, `${f.day}T12:02:00.000Z`, `${kind}: stale editor must preserve the other phone's time`);
      assert.equal(await time.inputValue(), "07:59", "A rejected time remains in the draft");
      assert.equal(await f.form.locator("textarea").inputValue(), "Synthetic unsaved draft");
      assert(await f.form.getByRole("button", { name: "Save", exact: true }).isDisabled());
      await f.form.getByRole("button", { name: "Discard draft and use latest", exact: true }).click();
      assert.equal(await time.inputValue(), "08:02", "Reviewing the newer entry replaces the time draft");
      assert.equal(await f.form.locator("textarea").inputValue(), "Synthetic note from another phone");
      await time.fill("08:01");
      await f.form.getByRole("button", { name: "Save", exact: true }).click();
      await f.form.waitFor({ state: "hidden" });
      assert.equal(f.writes.length, 2);
      assert.equal(f.writes[1].expect_updated_at, "2026-10-28T13:29:00.000Z");
      assert.equal(f.saved().started_at, `${f.day}T12:01:00.000Z`);
      assert.equal(f.saved().note, "Synthetic note from another phone");
      assert.deepEqual(f.errors, []);
      process.stdout.write(`PASS ${kind}${historical ? " outside the recent log" : ""}: stale saved time preserves the draft and recovers with the latest entry (${browserName})\n`);
    } catch (error) {
      failures++;
      process.stderr.write(`FAIL ${kind}${historical ? " outside the recent log" : ""}\n${error.stack}\n`);
    } finally { await f.close(); }
  }
  if (!process.env.MAPLE_TIMING_SAVED_CASE || process.env.MAPLE_TIMING_SAVED_CASE === "diaper-now") {
    const f = await fixture("diaper", false, false);
    try {
      await f.form.getByRole("button", { name: "Now", exact: true }).click();
      await f.form.getByRole("button", { name: "Save", exact: true }).click();
      await f.form.waitFor({ state: "hidden" });
      assert.equal(f.saved().started_at, NOW, "Now moves a saved diaper to the current time");
      assert.deepEqual(f.errors, []);
      process.stdout.write(`PASS saved diaper: Now replaces the saved timestamp (${browserName})\n`);
    } catch (error) {
      failures++;
      process.stderr.write(`FAIL saved diaper Now\n${error.stack}\n`);
    } finally { await f.close(); }
  }
} finally { await browser.close(); await rm(out, { recursive: true, force: true }); }
if (failures) process.exitCode = 1;
