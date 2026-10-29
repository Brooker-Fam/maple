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
const out = await mkdtemp(path.join(tmpdir(), "maple-timing-now-"));
const baseline = process.env.MAPLE_TIMING_NOW_BASELINE;
await build({
  entryPoints: [path.join(root, "scripts/first-use-ui/fixture.jsx")], outfile: path.join(out, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", absWorkingDir: root, tsconfig: path.join(root, "tsconfig.json"),
  define: { "process.env": "{}" }, plugins: [{ name: "synthetic-browser", setup(plugin) {
    plugin.onResolve({ filter: /^next\/dynamic$/ }, () => ({ path: "dynamic", namespace: "synthetic-runtime" }));
    plugin.onLoad({ filter: /.*/, namespace: "synthetic-runtime" }, () => ({ contents: 'import {lazy,Suspense} from "react"; export default function dynamic(load){const Component=lazy(load);return function Dynamic(props){return <Suspense fallback={<p>Loading view…</p>}><Component {...props}/></Suspense>}}', loader: "jsx", resolveDir: root }));
    if (baseline) plugin.onLoad({ filter: /\/(?:VitalsSheet|MedSheet|GrowthSheet|NoteSheet|TempSheet|FeedSheet|MomentSheet)\.tsx$/ }, ({ path: file }) => ({ contents: execFileSync("git", ["show", `${baseline}:${path.relative(root, file)}`], { cwd: root, encoding: "utf8" }), loader: "tsx", resolveDir: path.dirname(file) }));
  } }],
});
const css = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, "src/app/globals.css"), "utf8"), { from: path.join(root, "src/app/globals.css") });
await writeFile(path.join(out, "app.css"), css.css + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
const html = '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link href="/app.css" rel="stylesheet"></head><body><div id="root"></div><script src="/app.js" type="module"></script></body></html>';
const NOW = "2026-10-28T13:30:00.000Z";
const LATER = "2026-10-28T13:37:00.000Z";
const RETRY = "2026-10-28T13:42:00.000Z";
const START = "2026-10-28T12:00:42.500Z";
const me = { email: "sam@example.test", display_name: "Sam", role: "owner", emoji: null, color: null };
const browserName = process.env.REVIEW_BROWSER === "webkit" ? "webkit" : "chromium";
const browser = await ({ chromium, webkit }[browserName]).launch({ headless: true });

async function fixture(kind, data, conflict = false) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", timezoneId: "UTC" });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(NOW));
  page.setDefaultTimeout(5000);
  const errors = [];
  const writes = [];
  let rejectNext = false;
  let saved = { id: 501, kind, data, started_at: START, ended_at: data.method === "breast" ? "2026-10-28T12:10:42.500Z" : null, active: false, note: "Synthetic original note", created_by: me.email, updated_by: null, created_at: START, updated_at: START, source: "web" };
  const state = { now: NOW, rev: "now-1", seen_at: null, family: { id: 99, ask: "Sam" }, baby: { id: 99, name: "River", nickname: null, sex: null, timezone: "America/New_York", born_at: "2026-10-01T12:00:00.000Z", due_date: "2026-10-01", birth_weight_g: null, birth_length_cm: null, birth_head_cm: null, settings: { show_alerts: false } }, me, members: [me], entries: [saved], growth: [], lifetime: { diapers: 0, feeds: 0, firsts: { poop: null, bath: null, tummy: null } }, care: null };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    assert.equal(url.origin, "https://timing-now.example.test", "Every request stays in the synthetic fixture");
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
      if (conflict && writes.length === 1) {
        saved = { ...saved, started_at: "2026-10-28T12:02:00.000Z", note: "Synthetic note from another phone", updated_at: "2026-10-28T13:29:00.000Z" };
        if (data.segments) saved = { ...saved, ended_at: "2026-10-28T12:12:00.000Z", data: { ...data, segments: [{ side: "L", start: "2026-10-28T12:02:00.000Z", end: "2026-10-28T12:12:00.000Z" }] } };
        state.entries = [saved];
        state.rev = "now-conflict";
      }
      if (body.expect_updated_at && body.expect_updated_at !== saved.updated_at) return route.fulfill({ status: 409, json: { error: "Someone else just changed this. Have another look and try again.", reason: "changed", entry: saved } });
      if (rejectNext) {
        rejectNext = false;
        return route.fulfill({ status: 422, json: { error: "Synthetic save rejected. Try again." } });
      }
      saved = { ...saved, ...body, data: { ...saved.data, ...body.data }, updated_at: state.now };
      state.entries = [saved];
      state.rev = `now-${writes.length + 1}`;
      return json({ entry: saved });
    }
    return route.fulfill({ status: 500, json: { error: "Unexpected synthetic endpoint" } });
  });
  await page.goto("https://timing-now.example.test/#log");
  const edit = async () => {
    if (data.segments) {
      await page.getByRole("button", { name: /^Edit time: Nursed/ }).click();
      await page.getByRole("button", { name: "Edit feed details or add a side", exact: true }).click();
    } else await page.getByRole("button", { name: /^Edit:/ }).click();
    const form = page.getByRole("dialog").last();
    await form.waitFor();
    return form;
  };
  return { page, edit, writes, errors, saved: () => saved, reject: () => { rejectNext = true; }, advance: async (at) => { state.now = at; await page.clock.setFixedTime(new Date(at)); }, close: () => context.close() };
}

let failures = 0;
const kinds = [["vitals", { heart_bpm: 120 }], ["med", { name: "Synthetic medicine" }], ["growth", { weight_g: 4000 }], ["note", {}], ["temp", { temp_c: 37, method: "armpit" }], ["feed", { method: "bottle", amount_ml: 60 }], ["moment", { title: "Synthetic moment" }]];
try {
  for (const [kind, data] of kinds) {
    if (process.env.MAPLE_TIMING_NOW_MODE === "conflict") continue;
    if (process.env.MAPLE_TIMING_NOW_CASE && kind !== process.env.MAPLE_TIMING_NOW_CASE) continue;
    const f = await fixture(kind, data);
    try {
      let form = await f.edit();
      await form.locator("textarea").fill("Synthetic note-only edit");
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await form.waitFor({ state: "hidden" });
      assert.equal(f.saved().started_at, START, "An unchanged time keeps its seconds and milliseconds");
      form = await f.edit();
      const date = form.locator('input[type="date"]');
      await date.fill("");
      assert(await form.getByRole("button", { name: "Save", exact: true }).isDisabled(), "An incomplete date cannot submit");
      assert.equal(f.writes.length, 1);
      await date.fill("2026-10-28");
      assert(await form.getByRole("button", { name: "Save", exact: true }).isEnabled(), "Completing the date restores Save");
      await form.locator('input[type="time"]').fill("");
      assert(await form.getByRole("button", { name: "Save", exact: true }).isDisabled(), "An incomplete time cannot submit");
      await form.getByRole("button", { name: "Now", exact: true }).click();
      assert(await form.getByRole("button", { name: "Save", exact: true }).isEnabled(), "Now recovers an invalid clock");
      await form.locator("textarea").fill("Synthetic retry draft");
      await f.advance(LATER);
      f.reject();
      await Promise.all([
        f.page.waitForResponse((response) => response.request().method() === "PATCH" && response.status() === 422),
        form.getByRole("button", { name: "Save", exact: true }).click(),
      ]);
      await form.getByRole("button", { name: "Save", exact: true }).waitFor();
      assert.equal(f.writes[1].started_at, LATER, "Now resolves when saving, not when the sheet opened or the chip was tapped");
      assert.equal(f.saved().started_at, START, "A rejected save leaves the saved timestamp untouched");
      assert.equal(await form.locator("textarea").inputValue(), "Synthetic retry draft");
      await f.advance(RETRY);
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await form.waitFor({ state: "hidden" });
      assert.equal(f.writes.length, 3);
      assert.equal(f.saved().started_at, RETRY, "A retry with Now selected records the retry's current time");
      assert.equal(f.saved().note, "Synthetic retry draft");
      assert.deepEqual(f.errors, []);
      process.stdout.write(`PASS ${kind}: saved Now, unchanged precision, invalid-clock recovery, delayed submit and rejected-save retry (${browserName})\n`);
    } catch (error) {
      failures++;
      process.stderr.write(`FAIL ${kind}\n${error.stack}\n`);
    } finally { await f.close(); }
  }
  for (const [kind, data] of [...kinds, ["feed", { method: "breast", left_sec: 600, right_sec: 0, first_side: "L" }]]) {
    if (process.env.MAPLE_TIMING_NOW_MODE === "now") continue;
    if (process.env.MAPLE_TIMING_NOW_CASE && kind !== process.env.MAPLE_TIMING_NOW_CASE) continue;
    const f = await fixture(kind, data, true);
    try {
      const form = await f.edit();
      const time = form.locator('input[type="time"]').first();
      await time.fill("07:59");
      await form.locator("textarea").fill("Synthetic unsaved draft");
      await Promise.all([
        f.page.waitForResponse((response) => response.request().method() === "GET" && response.url().includes("/api/maple/state")),
        form.getByRole("button", { name: "Save", exact: true }).click(),
      ]);
      assert.equal(f.saved().started_at, "2026-10-28T12:02:00.000Z", "A stale editor preserves the other phone's timestamp");
      assert.equal(await time.inputValue(), "07:59", "A rejected time remains in the draft");
      assert.equal(await form.locator("textarea").inputValue(), "Synthetic unsaved draft");
      assert(await form.getByRole("button", { name: "Save", exact: true }).isDisabled());
      await form.getByRole("button", { name: "Discard draft and use latest", exact: true }).click();
      assert.equal(await time.inputValue(), "08:02");
      assert.equal(await form.locator("textarea").inputValue(), "Synthetic note from another phone");
      await time.fill("08:01");
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await form.waitFor({ state: "hidden" });
      assert.equal(f.writes.length, 2);
      assert.equal(f.writes[1].expect_updated_at, "2026-10-28T13:29:00.000Z");
      assert.equal(f.saved().started_at, "2026-10-28T12:01:00.000Z");
      assert.equal(f.saved().note, "Synthetic note from another phone");
      assert.deepEqual(f.errors, []);
      process.stdout.write(`PASS ${kind}${data.method === "breast" ? " by minutes" : ""}: concurrent saved-time correction keeps the draft and recovers from the latest record (${browserName})\n`);
    } catch (error) {
      failures++;
      process.stderr.write(`FAIL ${kind} conflict\n${error.stack}\n`);
    } finally { await f.close(); }
  }
  if (process.env.MAPLE_TIMING_NOW_MODE !== "now" && (!process.env.MAPLE_TIMING_NOW_CASE || process.env.MAPLE_TIMING_NOW_CASE === "feed")) {
    const f = await fixture("feed", { method: "breast", first_side: "L", segments: [{ side: "L", start: START, end: "2026-10-28T12:10:42.500Z" }] }, true);
    try {
      const form = await f.edit();
      await form.getByText("Type minutes instead", { exact: true }).click();
      await form.getByRole("textbox", { name: "minutes on the left", exact: true }).fill("11");
      await form.locator("textarea").fill("Synthetic unsaved draft");
      await Promise.all([
        f.page.waitForResponse((response) => response.request().method() === "GET" && response.url().includes("/api/maple/state")),
        form.getByRole("button", { name: "Save", exact: true }).click(),
      ]);
      assert.equal(f.saved().ended_at, "2026-10-28T12:12:00.000Z", "Typed minutes cannot overwrite a timed feed changed on another phone");
      assert.equal(await form.getByRole("textbox", { name: "minutes on the left", exact: true }).inputValue(), "11");
      assert.equal(await form.locator("textarea").inputValue(), "Synthetic unsaved draft");
      assert(await form.getByRole("button", { name: "Save", exact: true }).isDisabled());
      await form.getByRole("button", { name: "Discard draft and use latest", exact: true }).click();
      await form.getByText("Type minutes instead", { exact: true }).click();
      assert.equal(await form.getByRole("textbox", { name: "minutes on the left", exact: true }).inputValue(), "10");
      await form.getByRole("textbox", { name: "minutes on the left", exact: true }).fill("12");
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await form.waitFor({ state: "hidden" });
      assert.equal(f.writes.length, 2);
      assert.equal(f.writes[1].expect_updated_at, "2026-10-28T13:29:00.000Z");
      assert.equal(f.writes[1].data.left_sec, 720);
      assert.equal(f.saved().note, "Synthetic note from another phone");
      assert.deepEqual(f.errors, []);
      process.stdout.write(`PASS timed nursing: replacing parts with minutes preserves a concurrent change and recovers from the latest record (${browserName})\n`);
    } catch (error) {
      failures++;
      process.stderr.write(`FAIL timed nursing minutes conflict\n${error.stack}\n`);
    } finally { await f.close(); }
  }
} finally { await browser.close(); await rm(out, { recursive: true, force: true }); }
if (failures) process.exitCode = 1;
