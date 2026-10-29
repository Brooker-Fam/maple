import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium, webkit } = require("playwright");
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const tailwind = require("@tailwindcss/postcss");
const out = await mkdtemp(path.join(tmpdir(), "maple-switch-earlier-"));
const baseline = process.env.MAPLE_TIMING_BASELINE;
await build({
  entryPoints: [path.join(root, "scripts/first-use-ui/fixture.jsx")], outfile: path.join(out, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", absWorkingDir: root, tsconfig: path.join(root, "tsconfig.json"),
  define: { "process.env": "{}" }, plugins: [{ name: "synthetic-browser", setup(plugin) {
    plugin.onResolve({ filter: /^next\/dynamic$/ }, () => ({ path: "dynamic", namespace: "synthetic-runtime" }));
    plugin.onLoad({ filter: /.*/, namespace: "synthetic-runtime" }, () => ({ contents: 'import {lazy,Suspense} from "react"; export default function dynamic(load){const Component=lazy(load);return function Dynamic(props){return <Suspense fallback={<p>Loading view…</p>}><Component {...props}/></Suspense>}}', loader: "jsx", resolveDir: root }));
    if (baseline) plugin.onLoad({ filter: /\/(?:TimerCard|FeedParts|FixTimesSheet)\.tsx$/ }, ({ path: file }) => ({ contents: execFileSync("git", ["show", `${baseline}:${path.relative(root, file)}`], { cwd: root, encoding: "utf8" }), loader: "tsx", resolveDir: path.dirname(file) }));
  } }],
});
const css = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, "src/app/globals.css"), "utf8"), { from: path.join(root, "src/app/globals.css") });
await writeFile(path.join(out, "app.css"), css.css + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
const html = '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link href="/app.css" rel="stylesheet"></head><body><div id="root"></div><script src="/app.js" type="module"></script></body></html>';
const NOW = "2026-10-28T13:30:00.000Z";
const me = { email: "sam@example.test", display_name: "Sam", role: "owner", emoji: null, color: null };
const original = () => ({
  id: 401, kind: "feed", started_at: "2026-10-28T12:30:00.000Z", ended_at: null, active: true,
  data: { method: "breast", first_side: "L", last_side: "L", segments: [{ side: "L", start: "2026-10-28T12:30:00.000Z", end: null }] },
  note: null, created_by: me.email, updated_by: null, created_at: "2026-10-28T12:30:00.000Z", updated_at: "2026-10-28T12:30:00.000Z", source: "web",
});
const browserName = process.env.REVIEW_BROWSER === "webkit" ? "webkit" : "chromium";
const browser = await ({ chromium, webkit }[browserName]).launch({ headless: true });
async function fixture(mode = "success", width = 390, height = 844) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", timezoneId: "UTC" });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(NOW));
  page.setDefaultTimeout(5000);
  const errors = [];
  const writes = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let saved = original();
  if (mode === "early") saved = { ...saved, started_at: "2026-10-28T13:15:00.000Z", data: { ...saved.data, segments: [{ side: "L", start: "2026-10-28T13:15:00.000Z", end: null }] } };
  if (mode === "old") saved = { ...saved, started_at: "2026-10-28T06:30:00.000Z", data: { ...saved.data, segments: [{ side: "L", start: "2026-10-28T06:30:00.000Z", end: null }] } };
  const state = { now: NOW, rev: "switch-1", seen_at: null, family: { id: 99, ask: "Sam" }, baby: { id: 99, name: "River", nickname: null, sex: "female", timezone: "America/New_York", born_at: "2026-10-01T12:00:00.000Z", due_date: "2026-10-01", birth_weight_g: null, birth_length_cm: null, birth_head_cm: null, settings: { show_alerts: false } }, me, members: [me], entries: [saved], growth: [], lifetime: { diapers: 0, feeds: 0, firsts: { poop: null, bath: null, tummy: null } }, care: null };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    assert.equal(url.origin, "https://timing-switch.example.test", "Every request stays in the synthetic fixture");
    const p = url.pathname;
    if (!p.startsWith("/api/")) {
      const file = p === "/app.js" ? "app.js" : p === "/app.css" ? "app.css" : null;
      return route.fulfill({ contentType: file?.endsWith("js") ? "text/javascript" : file ? "text/css" : "text/html", body: file ? await readFile(path.join(out, file)) : html });
    }
    const json = (body) => route.fulfill({ json: body });
    if (p === "/api/maple/auth/me") return json({ signedIn: true, google: false, email: false, apple: false, password: false });
    if (p === "/api/maple/state") return json(state);
    if (p === "/api/maple/diagnostics") return route.fulfill({ status: 204, body: "" });
    if (p === "/api/maple/entries") return json({ entries: state.entries, next_cursor: null, truncated: false });
    if (p === "/api/maple/chat/consent") return json({ terms: true, care: false, self: false });
    if (p === "/api/maple/onboarding") return json({ needed: false });
    if (p === "/api/maple/push") return json({ publicKey: null, sub: null, health: { needs_resubscribe: false }, reminders: [] });
    if (p === "/api/maple/timer") {
      const body = req.postDataJSON();
      writes.push(body);
      if (mode === "pending") await pending;
      if (mode === "retry" && writes.length === 1) return route.fulfill({ status: 503, json: { error: "Synthetic save failure" } });
      if (mode === "conflict" && writes.length === 1) {
        saved = { ...saved, data: { ...saved.data, last_side: "R", segments: [{ ...saved.data.segments[0], end: "2026-10-28T13:10:00.000Z" }, { side: "R", start: "2026-10-28T13:10:00.000Z", end: null }] }, note: "Synthetic note from another device", updated_at: "2026-10-28T13:29:00.000Z", updated_by: me.email };
        state.entries = [saved];
        state.rev = "switch-conflict";
        return route.fulfill({ status: 409, json: { error: "This feed changed", reason: "changed", entry: saved } });
      }
      assert.equal(body.expect_updated_at ?? body.edit?.expect_updated_at, saved.updated_at, "Switch and Undo check the shown revision");
      const before = { segments: structuredClone(saved.data.segments), started_at: saved.started_at, ended_at: saved.ended_at, updated_at: saved.updated_at, first_side: saved.data.first_side ?? null, last_side: saved.data.last_side ?? null };
      if (body.action === "switch") {
        assert(body.at < await page.evaluate(() => new Date().toISOString()), "Forgotten switch records an earlier timestamp");
        saved = { ...saved, data: { ...saved.data, last_side: body.side, segments: [...saved.data.segments.slice(0, -1), { ...saved.data.segments.at(-1), end: body.at }, { side: body.side, start: body.at, end: null }], last_tap: { kind: "switch", side: body.side, at: NOW, by: me.email } }, updated_at: new Date(Date.parse(NOW) + writes.length * 1000).toISOString(), updated_by: me.email };
      } else {
        assert.equal(body.action, "retime");
        assert.equal(body.edit.op, "restore");
        assert.deepEqual(body.edit.segments, original().data.segments, "Undo sends the server's original segments");
        assert.equal(body.edit.started_at, original().started_at);
        assert.equal(body.edit.ended_at, null);
        saved = { ...saved, started_at: body.edit.started_at, ended_at: body.edit.ended_at, active: body.edit.ended_at === null, data: { ...saved.data, segments: body.edit.segments, first_side: body.edit.first_side, last_side: body.edit.last_side }, updated_at: new Date(Date.parse(NOW) + writes.length * 1000).toISOString() };
      }
      state.entries = [saved];
      state.rev = `switch-${writes.length + 1}`;
      return json({ entry: saved, before });
    }
    return route.fulfill({ status: 500, json: { error: "Unexpected synthetic endpoint" } });
  });
  await page.goto("https://timing-switch.example.test/#today");
  await page.getByRole("region", { name: "Nursing timer", exact: true }).waitFor();
  if (mode !== "early") await page.getByText("Still nursing?", { exact: true }).waitFor();
  return { page, writes, errors, state, release, close: async () => {
    release();
    await page.unrouteAll({ behavior: "wait" });
    await context.close();
  } };
}
const open = async (f) => {
  await f.page.getByRole("button", { name: "Switch earlier…", exact: true }).click();
  const form = f.page.getByRole("dialog", { name: "Switch earlier", exact: true });
  await form.waitFor();
  return form;
};
const cases = [
  ["Forgotten switch stages a bounded earlier time, retries, and undoes one write", async () => {
    const f = await fixture("retry");
    try {
      const form = await open(f);
      const save = form.getByRole("button", { name: "Save switch", exact: true });
      assert(await save.isDisabled(), "Opening the picker does not choose a switch time");
      assert.equal(f.writes.length, 0);
      await form.getByRole("button", { name: /10 min ago/ }).click();
      assert.equal(await form.locator('input[type="time"]').inputValue(), "09:20");
      await form.locator('input[type="time"]').fill("08:29");
      assert(await save.isDisabled(), "Switch cannot precede the current side");
      await form.getByRole("button", { name: /10 min ago/ }).click();
      assert(await save.isEnabled(), "A preset replaces an invalid typed time");
      assert.equal(f.writes.length, 0);
      await save.click();
      await form.getByRole("alert").filter({ hasText: /Synthetic save failure/ }).waitFor();
      assert.equal(await form.locator('input[type="time"]').inputValue(), "09:20", "Failure retains the chosen switch");
      await save.click();
      await form.waitFor({ state: "hidden" });
      assert.deepEqual(f.writes.map(({ action, side, at, expect_updated_at }) => ({ action, side, at, expect_updated_at })), [1, 2].map(() => ({ action: "switch", side: "R", at: "2026-10-28T13:20:00.000Z", expect_updated_at: original().updated_at })));
      assert.equal(f.state.entries[0].data.segments[0].end, "2026-10-28T13:20:00.000Z");
      assert.equal(f.state.entries[0].active, true);
      await f.page.waitForTimeout(700);
      await f.page.getByRole("button", { name: "Undo", exact: true }).click();
      await f.page.waitForFunction(() => document.body.textContent.includes("Still nursing?"));
      assert.equal(f.writes.length, 3);
      assert.deepEqual(f.state.entries[0].data.segments, original().data.segments);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Switch earlier fits a narrow phone and Cancel leaves the timer untouched", async () => {
    const f = await fixture("success", 320);
    try {
      const form = await open(f);
      assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const save = form.getByRole("button", { name: "Save switch", exact: true });
      const bounds = await save.boundingBox();
      assert(bounds && bounds.y + bounds.height <= 844, "Save remains visible in the sheet footer");
      await f.page.waitForTimeout(350);
      await mkdir(path.join(root, "test-results/timing-switch"), { recursive: true });
      await f.page.screenshot({ path: path.join(root, `test-results/timing-switch/${browserName}-320.png`) });
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
      await form.waitFor({ state: "hidden" });
      assert.equal(f.writes.length, 0);
      assert.deepEqual(f.state.entries[0], original());
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["A newer revision preserves the switch draft until the latest feed is reviewed", async () => {
    const f = await fixture("conflict");
    try {
      const form = await open(f);
      await form.getByRole("button", { name: /^5 min ago/ }).click();
      await form.getByRole("button", { name: "Save switch", exact: true }).click();
      await form.getByRole("button", { name: "Use latest", exact: true }).waitFor();
      assert(await form.getByRole("button", { name: "Save switch", exact: true }).isDisabled());
      assert.equal(await form.locator('input[type="time"]').inputValue(), "09:25");
      assert.equal(f.writes.length, 1);
      await form.getByRole("button", { name: "Use latest", exact: true }).click();
      await form.getByText("When did you switch to Left?", { exact: true }).waitFor();
      await form.getByRole("button", { name: /10 min ago/ }).click();
      await form.getByRole("button", { name: "Save switch", exact: true }).click();
      await form.waitFor({ state: "hidden" });
      assert.equal(f.writes[1].expect_updated_at, "2026-10-28T13:29:00.000Z");
      assert.equal(f.writes[1].side, "L", "The reviewed current side determines the next side");
      assert.equal(f.state.entries[0].note, "Synthetic note from another device");
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Timer menu opens Switch earlier before the reminder appears", async () => {
    const f = await fixture("early");
    try {
      assert.equal(await f.page.getByText("Still nursing?", { exact: true }).count(), 0);
      await f.page.getByRole("button", { name: "More timer options", exact: true }).click();
      await f.page.getByRole("button", { name: "Switch earlier Record when you changed sides", exact: true }).click();
      const form = f.page.getByRole("dialog", { name: "Switch earlier", exact: true });
      await form.waitFor();
      assert.equal(await form.getByRole("button", { name: /^15 min ago/ }).count(), 0, "Preset cannot erase the recorded side");
      await form.getByRole("button", { name: /^5 min ago/ }).click();
      await form.getByRole("button", { name: "Save switch", exact: true }).click();
      await form.waitFor({ state: "hidden" });
      assert.equal(f.writes.length, 1);
      assert.equal(f.writes[0].at, "2026-10-28T13:25:00.000Z");
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["The four-hour switch limit rejects older times without changing the draft", async () => {
    const f = await fixture("old");
    try {
      const form = await open(f);
      const time = form.locator('input[type="time"]');
      const save = form.getByRole("button", { name: "Save switch", exact: true });
      await time.fill("04:30");
      assert(await save.isDisabled(), "A five-hour-old switch cannot save");
      assert.equal(await time.inputValue(), "04:30", "The rejected time remains visible");
      await form.getByText("Switches can only be recorded within the last 4 hours.", { exact: true }).waitFor();
      await time.fill("05:35");
      assert(await save.isEnabled(), "A switch inside the server window can save");
      assert.equal(f.writes.length, 0);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["The four-hour switch limit advances while the draft stays open", async () => {
    const f = await fixture("old");
    try {
      const form = await open(f);
      const time = form.locator('input[type="time"]');
      const save = form.getByRole("button", { name: "Save switch", exact: true });
      await time.fill("05:35");
      assert(await save.isEnabled());
      await f.page.clock.setFixedTime(new Date("2026-10-28T13:40:00.000Z"));
      await f.page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Save switch" && button.disabled));
      assert.equal(await time.inputValue(), "05:35", "An expired draft is preserved");
      assert.equal(f.writes.length, 0);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Relative switch choices use the time of the tap and preserve the selected time", async () => {
    const f = await fixture();
    try {
      const form = await open(f);
      await f.page.clock.setFixedTime(new Date("2026-10-28T13:40:00.000Z"));
      await form.getByRole("button", { name: /^1 min ago/ }).click();
      assert.equal(await form.locator('input[type="time"]').inputValue(), "09:39", "The selected relative time starts from the tap");
      await f.page.clock.setFixedTime(new Date("2026-10-28T13:45:00.000Z"));
      await form.getByRole("button", { name: "Save switch", exact: true }).click();
      await form.waitFor({ state: "hidden" });
      assert.equal(f.writes.length, 1);
      assert.equal(f.writes[0].at, "2026-10-28T13:39:00.000Z", "Waiting to save keeps the selected timestamp");
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["An open switch editor accepts a clock time after it was opened", async () => {
    const f = await fixture();
    try {
      const form = await open(f);
      await f.page.clock.setFixedTime(new Date("2026-10-28T13:40:00.000Z"));
      await form.locator('input[type="time"]').fill("09:39");
      const save = form.getByRole("button", { name: "Save switch", exact: true });
      assert(await save.isEnabled(), "A time before the current clock remains valid after the editor opens");
      await save.click();
      await form.waitFor({ state: "hidden" });
      assert.equal(f.writes.length, 1);
      assert.equal(f.writes[0].at, "2026-10-28T13:39:00.000Z");
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["A pending switch locks keyboard dismissal and duplicate submission on a short phone", async () => {
    const f = await fixture("pending", 320, 568);
    try {
      const form = await open(f);
      await f.page.waitForTimeout(250);
      assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const save = form.getByRole("button", { name: "Save switch", exact: true });
      const bounds = await save.boundingBox();
      assert(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 568, "Save remains in the short phone viewport");
      await form.getByRole("button", { name: /10 min ago/ }).focus();
      await f.page.keyboard.press("Enter");
      await save.focus();
      await f.page.keyboard.press("Enter");
      await form.getByRole("button", { name: "Saving…", exact: true }).waitFor();
      assert(await form.locator('input[type="time"]').isDisabled());
      await f.page.keyboard.press("Enter");
      await f.page.keyboard.press("Escape");
      assert.equal(await f.page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true }).count(), 0, "A pending save cannot offer to discard a request already sent");
      assert.equal(f.writes.length, 1, "Repeated activation sends one request");
      f.release();
      await form.waitFor({ state: "hidden" });
      assert.deepEqual(f.errors, []);
    } finally { f.release(); await f.close(); }
  }],
];
let failures = 0;
try {
  for (const [name, check] of cases) {
    if (process.env.MAPLE_TIMING_CASE && !name.includes(process.env.MAPLE_TIMING_CASE)) continue;
    try { await check(); process.stdout.write(`PASS ${name}\n`); }
    catch (error) { failures++; process.stderr.write(`FAIL ${name}\n${error.stack}\n`); }
  }
} finally { await browser.close(); await rm(out, { recursive: true, force: true }); }
if (failures) process.exitCode = 1;
