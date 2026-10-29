import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const out = await mkdtemp(path.join(tmpdir(), "maple-logging-recovery-"));
const baselineFiles = new Set(["sheets/NoteSheet.tsx", "sheets/PumpSheet.tsx", "LogTab.tsx", "MomentsTab.tsx", "Celebrations.tsx"]);
await build({
  entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(out, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", absWorkingDir: root, tsconfig: path.join(root, "tsconfig.json"),
  define: { "process.env": "{}" }, plugins: [{ name: "synthetic-browser", setup(plugin) {
    plugin.onLoad({ filter: /\.tsx$/ }, async ({ path: file }) => {
      if (file.endsWith("/useMaple.tsx")) {
        const source = await readFile(file, "utf8");
        const anchor = "  return <MapleContext.Provider value={value}>";
        assert(source.includes(anchor));
        return { contents: source.replace(anchor, "  window.__loggingReview = { state, pending: outbox, online };\n" + anchor), loader: "tsx" };
      }
      const relative = path.relative(path.join(root, "src/components/maple"), file);
      if (process.env.LOGGING_BASELINE_REF && baselineFiles.has(relative)) {
        return { contents: execFileSync("git", ["show", `${process.env.LOGGING_BASELINE_REF}:src/components/maple/${relative}`], { cwd: root, encoding: "utf8" }), loader: "tsx" };
      }
    });
    plugin.onResolve({ filter: /^next\/dynamic$/ }, () => ({ path: "dynamic", namespace: "synthetic-runtime" }));
    plugin.onLoad({ filter: /.*/, namespace: "synthetic-runtime" }, () => ({ contents: 'import {lazy,Suspense} from "react"; export default function dynamic(load){const Component=lazy(load);return function Dynamic(props){return <Suspense fallback={<p>Loading view…</p>}><Component {...props}/></Suspense>}}', loader: "jsx", resolveDir: root }));
  } }],
});
const css = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, "src/app/globals.css"), "utf8"), { from: path.join(root, "src/app/globals.css") });
await writeFile(path.join(out, "app.css"), css.css + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
const html = '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link href="/app.css" rel="stylesheet"></head><body><div id="root"></div><script src="/app.js" type="module"></script></body></html>';
const NOW = "2026-10-28T13:30:00.000Z";
const me = { email: "sam@example.test", display_name: "Sam", role: "owner", emoji: null, color: null };
const record = (id, kind, data, at = "2026-10-28T12:00:00.000Z", extra = {}) => ({ id, kind, data, started_at: at, ended_at: null, active: false, note: null, created_by: me.email, updated_by: null, created_at: at, updated_at: at, source: "web", ...extra });
const freshState = () => ({
  now: NOW, rev: "example-1", seen_at: null, family: { id: 99, ask: "Sam" },
  baby: { id: 99, name: "River", nickname: null, sex: "female", timezone: "America/New_York", born_at: "2026-10-01T12:00:00.000Z", due_date: "2026-10-01", birth_weight_g: null, birth_length_cm: null, birth_head_cm: null, settings: { show_alerts: false } },
  me, members: [me], entries: [], growth: [], lifetime: { diapers: 0, feeds: 0, firsts: { poop: null, bath: null, tummy: null } }, care: null,
});
const browserName = process.env.REVIEW_BROWSER === "webkit" ? "webkit" : "chromium";
const browser = await ({ chromium, webkit }[browserName]).launch({ headless: true });
let failures = 0;

async function fixture({ state = freshState(), records = [], entryResponse, rangeResponse } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    assert.equal(url.origin, "https://logging-recovery.example.test", "Every request must remain inside the synthetic fixture");
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/")) {
      const file = pathname === "/app.js" ? "app.js" : pathname === "/app.css" ? "app.css" : null;
      return route.fulfill({ contentType: file?.endsWith("js") ? "text/javascript" : file ? "text/css" : "text/html", body: file ? await readFile(path.join(out, file)) : html });
    }
    requests.push({ pathname, method: req.method(), body: req.postDataJSON(), query: url.search });
    const json = (body) => route.fulfill({ json: body });
    if (pathname === "/api/maple/auth/me") return json({ signedIn: true, google: false, email: false, apple: false, password: false });
    if (pathname === "/api/maple/state") return json(state);
    if (pathname === "/api/maple/diagnostics") return route.fulfill({ status: 204, body: "" });
    if (pathname === "/api/maple/entries") {
      if (req.method() !== "GET") return entryResponse ? entryResponse({ route, req, url, state, records }) : route.fulfill({ status: 400, json: { error: "Unexpected synthetic write" } });
      if (url.searchParams.has("from") && rangeResponse) return rangeResponse({ route, req, url, records });
      const kind = url.searchParams.get("kind");
      return json({ entries: url.searchParams.has("deleted") ? [] : records.filter((entry) => !kind || entry.kind === kind), next_cursor: null, truncated: false });
    }
    if (pathname === "/api/maple/chat/consent") return json({ terms: true, care: false, self: false });
    if (pathname === "/api/maple/onboarding") return json({ needed: false });
    if (pathname === "/api/maple/push") return json({ publicKey: null, sub: null, health: { needs_resubscribe: false }, reminders: [] });
    return route.fulfill({ status: 500, json: { error: "Unexpected synthetic endpoint" } });
  });
  return { page, state, records, requests, errors, close: () => context.close() };
}

async function openNote(page) {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("dialog", { name: "More to log", exact: true }).getByRole("button", { name: /^Note/ }).click();
  return page.getByRole("dialog", { name: "Note", exact: true });
}

const cases = [
  ["Note fields and dismissal stay locked while a save is pending", async () => {
    let release;
    let started;
    const requestStarted = new Promise((resolve) => { started = resolve; });
    const f = await fixture({ entryResponse: async ({ route, req, state }) => {
      await new Promise((resolve) => { release = resolve; started(); });
      const saved = record(900, "note", req.postDataJSON().data, req.postDataJSON().started_at, { note: req.postDataJSON().note, updated_at: NOW });
      state.entries = [saved]; state.rev = "example-2";
      return route.fulfill({ json: { entry: saved } });
    } });
    try {
      await f.page.goto("https://logging-recovery.example.test/#today");
      const dialog = await openNote(f.page);
      const field = dialog.getByRole("textbox").first();
      await field.fill("Synthetic submitted note");
      await dialog.getByRole("button", { name: "Log it", exact: true }).click();
      await requestStarted;
      assert(await field.isDisabled(), "Typing during a pending save must not create a draft that its response discards");
      assert(await dialog.getByRole("button", { name: "Make it a question for the doctor", exact: true }).isDisabled());
      assert.equal(await dialog.getByRole("button", { name: "Close", exact: true }).count(), 0);
      await f.page.keyboard.press("Escape");
      assert(await dialog.isVisible());
      await f.page.goBack();
      await f.page.waitForTimeout(100);
      assert(await dialog.isVisible(), "Back must not dismiss a pending save");
      release();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(f.state.entries[0].note, "Synthetic submitted note");
      assert.equal(f.requests.filter((req) => req.method === "POST" && req.pathname === "/api/maple/entries").length, 1);
      assert.deepEqual(f.errors, []);
    } finally { release?.(); await f.close(); }
  }],
  ["Note keeps rejected drafts, retries once, and preserves offline saves", async () => {
    let response = "reject";
    const f = await fixture({ entryResponse: async ({ route, req, state }) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (response === "reject") return route.fulfill({ status: 400, json: { error: "Synthetic non-retryable note rejection" } });
      if (response === "offline") return route.fulfill({ status: 503, json: { error: "Synthetic temporary outage" } });
      const saved = record(900, "note", req.postDataJSON().data, req.postDataJSON().started_at, { note: req.postDataJSON().note, updated_at: NOW });
      state.entries = [saved]; state.rev = "example-2";
      return route.fulfill({ json: { entry: saved } });
    } });
    try {
      await f.page.goto("https://logging-recovery.example.test/#today");
      const dialog = await openNote(f.page);
      const draft = "Synthetic note that must survive a rejected save";
      await dialog.getByRole("textbox").first().fill(draft);
      await dialog.getByRole("button", { name: "Log it", exact: true }).click();
      await f.page.getByText("Synthetic non-retryable note rejection", { exact: true }).waitFor();
      await f.page.waitForTimeout(500);
      assert(await dialog.isVisible(), "Rejected note must remain open");
      assert.equal(await dialog.getByRole("textbox").first().inputValue(), draft);
      const rejected = await f.page.evaluate(() => ({ entries: window.__loggingReview.state.entries, pending: window.__loggingReview.pending, stored: localStorage.getItem("maple-outbox-v1") }));
      assert.deepEqual(rejected, { entries: [], pending: [], stored: null });
      response = "save";
      await dialog.getByRole("button", { name: "Log it", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await f.page.waitForFunction(() => window.__loggingReview.state.entries.some((entry) => entry.id === 900));
      assert.equal(f.requests.filter((req) => req.method === "POST" && req.pathname === "/api/maple/entries").length, 2);
      response = "offline";
      await f.page.waitForTimeout(900);
      const offlineDialog = await openNote(f.page);
      await offlineDialog.getByRole("textbox").first().fill("Synthetic offline note");
      await offlineDialog.getByRole("button", { name: "Log it", exact: true }).click();
      await offlineDialog.waitFor({ state: "hidden" });
      await f.page.waitForFunction(() => window.__loggingReview.pending.length === 1);
      const queued = await f.page.evaluate(() => ({ pending: window.__loggingReview.pending, stored: JSON.parse(localStorage.getItem("maple-outbox-v1")) }));
      assert.equal(queued.pending[0].input.note, "Synthetic offline note");
      assert.equal(queued.stored[0].input.note, "Synthetic offline note");
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Pump mode changes replace inactive amounts without rounding untouched values", async () => {
    const state = freshState();
    state.entries = [record(123, "pump", { total_ml: 60.123 }, undefined, { ended_at: "2026-10-28T12:15:00.000Z" })];
    const f = await fixture({ state, records: state.entries, entryResponse: ({ route, req, state }) => {
      const patch = req.postDataJSON();
      const current = state.entries[0];
      const data = { ...current.data, ...patch.data };
      for (const [key, value] of Object.entries(data)) if (value === null) delete data[key];
      const updated = { ...current, ...patch, data, updated_at: NOW };
      state.entries = [updated]; state.rev = `${state.rev}-saved`;
      return route.fulfill({ json: { entry: updated } });
    } });
    const open = async () => { await f.page.getByRole("button", { name: /Pumped/ }).click(); return f.page.getByRole("dialog", { name: "Pumped", exact: true }); };
    try {
      await f.page.goto("https://logging-recovery.example.test/#today");
      let dialog = await open();
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(state.entries[0].data.total_ml, 60.123, "Untouched rounded display must preserve exact stored amount");
      dialog = await open();
      await dialog.getByRole("radio", { name: "Each side", exact: true }).click();
      await dialog.getByRole("textbox", { name: "left, oz", exact: true }).fill("1");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.deepEqual(state.entries[0].data, { left_ml: 29.6 }, "Changing to side amounts must remove the previous total");
      dialog = await open();
      await dialog.getByRole("radio", { name: "Total", exact: true }).click();
      await dialog.getByRole("textbox", { name: "total, oz", exact: true }).fill("2");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.deepEqual(state.entries[0].data, { total_ml: 59.1 }, "Changing to total must remove prior side amounts");
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Cached History reports failed weeks until a successful retry", async () => {
    let failing = false;
    const records = [record(123, "note", {}, "2026-10-24T12:00:00.000Z", { note: "Earlier synthetic note" })];
    const f = await fixture({ records, rangeResponse: async ({ route, url }) => {
      const older = url.searchParams.get("from") === "2026-10-19";
      if (failing && older) return route.fulfill({ status: 503, json: { error: "Synthetic failed older week" } });
      if (failing) await new Promise((resolve) => setTimeout(resolve, 150));
      return route.fulfill({ json: { entries: older ? records : [], truncated: false } });
    } });
    try {
      await f.page.goto("https://logging-recovery.example.test/#history/timeline");
      await f.page.getByText("“Earlier synthetic note”", { exact: true }).waitFor();
      failing = true; f.state.rev = "example-2";
      await f.page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
        delete document.visibilityState;
      });
      const banner = f.page.getByRole("status").filter({ hasText: "Couldn't refresh" });
      await banner.waitFor();
      await f.page.waitForTimeout(250);
      assert(await banner.isVisible(), "A successful recent week must not hide another failed week");
      await f.page.getByText("“Earlier synthetic note”", { exact: true }).waitFor();
      records[0] = { ...records[0], note: "Corrected synthetic note", updated_at: NOW };
      failing = false;
      await banner.getByRole("button", { name: "Try again", exact: true }).click();
      await f.page.getByText("“Corrected synthetic note”", { exact: true }).waitFor();
      await banner.waitFor({ state: "hidden" });
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Unknown birth dates keep birthday moments together while exact times stay exact", async () => {
    for (const [bornAt, approximate, before] of [["2026-10-28T16:00:00.000Z", true, false], ["2026-10-28T04:00:00.000Z", true, false], ["2026-10-28T16:00:00.000Z", false, true]]) {
      const state = freshState();
      state.baby.born_at = bornAt; state.baby.settings.birth_time_approx = approximate;
      const moment = record(123, "moment", { title: "First morning together", milestone: "born" });
      state.entries = [moment];
      const f = await fixture({ state, records: [moment] });
      try {
        await f.page.goto("https://logging-recovery.example.test/#moments");
        const card = f.page.getByRole("button", { name: /^First morning together,/ });
        await card.waitFor();
        assert.equal(await f.page.getByRole("heading", { name: "Before she arrived", exact: true }).count(), before ? 1 : 0);
        assert.equal(await f.page.getByRole("heading", { name: "Week 1", exact: true }).count(), before ? 0 : 1);
        await card.getByText(before ? /Before birth/ : /Day 1/).waitFor();
        await card.click();
        await f.page.getByRole("dialog", { name: "Moment", exact: true }).getByText(before ? /before she arrived/i : /Day 1/).waitFor();
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }
  }],
  ["Unknown birth dates label first-day celebrations consistently", async () => {
    for (const approximate of [true, false]) {
      const state = freshState();
      state.baby.born_at = "2026-10-28T16:00:00.000Z";
      state.baby.settings.birth_time_approx = approximate;
      state.lifetime.firsts.bath = "2026-10-28T12:00:00.000Z";
      state.entries = [record(123, "bath", {})];
      const f = await fixture({ state, records: state.entries });
      try {
        await f.page.goto("https://logging-recovery.example.test/#today");
        const celebration = f.page.getByRole("heading", { name: "Her first bath", exact: true }).locator("..");
        await celebration.waitFor();
        assert.match(await celebration.innerText(), approximate ? /Day 1/ : /Before birth/);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }
  }],
];

try {
  for (const [name, run] of cases) {
    if (process.env.LOGGING_CASE && !name.includes(process.env.LOGGING_CASE)) continue;
    try { await run(); console.log(`PASS ${name} (${browserName})`); }
    catch (error) { failures++; console.error(`FAIL ${name} (${browserName}): ${error.message}`); }
  }
} finally { await browser.close(); await rm(out, { recursive: true, force: true }); }
if (failures) process.exit(1);
