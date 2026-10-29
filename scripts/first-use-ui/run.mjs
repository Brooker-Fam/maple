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
const out = await mkdtemp(path.join(tmpdir(), "maple-first-use-"));
await build({
  entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(out, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", absWorkingDir: root, tsconfig: path.join(root, "tsconfig.json"),
  define: { "process.env": "{}" }, plugins: [{ name: "synthetic-browser", setup(plugin) {
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
  baby: { id: 99, name: "River", nickname: null, sex: null, timezone: "America/New_York", born_at: "2026-10-01T12:00:00.000Z", due_date: "2026-10-01", birth_weight_g: null, birth_length_cm: null, birth_head_cm: null, settings: { show_alerts: false } },
  me, members: [me], entries: [], growth: [], lifetime: { diapers: 0, feeds: 0, firsts: { poop: null, bath: null, tummy: null } }, care: null,
});
const browserName = process.env.REVIEW_BROWSER === "webkit" ? "webkit" : "chromium";
const browser = await ({ chromium, webkit }[browserName]).launch({ headless: true });
let failures = 0;

async function fixture({ state = freshState(), records = [], entryResponse, rangeResponse } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", timezoneId: "UTC" });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    assert.equal(url.origin, "https://first-use.example.test", "Every request must remain inside the synthetic fixture");
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

const writes = (f) => f.requests.filter((r) => r.pathname === "/api/maple/entries" && r.method !== "GET");
const localDay = (at, timezone) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const cases = [
  ["Every historical entry kind keeps an older family-local date", async () => {
    const kinds = [["Nursing", "feed"], ["Bottle", "feed"], ["Diaper", "diaper"], ["Sleep", "sleep"], ["Vitamin D", "med"], ["Tummy time", "tummy"], ["Bath", "bath"], ["Pump", "pump"], ["Temperature", "temp"], ["Skin check", "vitals"], ["Growth", "growth"], ["River's medicine", "med"], ["Other readings", "vitals"], ["Note", "note"], ["Moment", "moment"]];
    for (const [label, kind] of kinds) {
      const state = freshState();
      state.now = "2026-10-29T03:55:00.000Z"; // Oct 28 in the family's zone; browser stays in UTC.
      const f = await fixture({ state, entryResponse: ({ route, req }) => route.fulfill({ json: { entry: record(99, kind, req.postDataJSON().data, req.postDataJSON().started_at, req.postDataJSON()) } }) });
      try {
        await f.page.goto("https://first-use.example.test/#log");
        await f.page.getByRole("button", { name: "Jump to a day", exact: true }).click();
        await f.page.getByLabel("Jump to a day", { exact: true }).fill("2026-10-25");
        await f.page.locator("#maple-day-2026-10-25").getByRole("button", { name: "Add entry for Sun, Oct 25", exact: true }).click();
        const picker = f.page.getByRole("dialog", { name: "Log earlier", exact: true });
        await picker.getByRole("button", { name: label, exact: true }).click();
        await picker.waitFor({ state: "hidden" });
        const form = f.page.getByRole("dialog").last();
        await form.waitFor();
        if (label === "Nursing") await form.getByRole("textbox", { name: "minutes on the left", exact: true }).fill("5");
        if (label === "Bottle") await form.getByRole("textbox", { name: "ounces", exact: true }).fill("2");
        if (label === "Temperature") await form.getByRole("textbox", { name: "temperature in degrees Fahrenheit", exact: true }).fill("98.6");
        if (label === "Growth") await form.getByRole("textbox", { name: "pounds", exact: true }).fill("8");
        if (label === "River's medicine") await form.getByRole("textbox", { name: "Medicine name", exact: true }).fill("Synthetic medicine");
        if (label === "Other readings") await form.getByRole("textbox", { name: "heart rate, beats per minute", exact: true }).fill("120");
        if (label === "Note") await form.locator("textarea").fill("Synthetic historical note");
        if (label === "Moment") await form.getByRole("textbox", { name: "Title", exact: true }).fill("Synthetic historical moment");
        assert.equal(writes(f).length, 0, `${label} must remain unsaved while choosing details`);
        await form.getByRole("button", { name: /^(?:Log it|Log .+|Save moment)$/ }).click();
        await form.waitFor({ state: "hidden" });
        await f.page.waitForTimeout(50);
        const saved = writes(f)[0]?.body;
        assert.equal(saved?.kind, kind, `${label} must save its own kind`);
        assert.equal(localDay(saved.started_at, state.baby.timezone), "2026-10-25", `${label} must keep the chosen family-local date across UTC midnight`);
        if (saved.ended_at) assert.equal(localDay(saved.ended_at, state.baby.timezone), "2026-10-25", `${label} must not stretch until today`);
        if (["diaper", "temp", "vitals", "growth", "med", "note", "moment", "bath"].includes(kind)) assert.equal(saved.ended_at, undefined, `${label} must not invent a duration`);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }
  }],
  ["One-minute sleep corrections preserve seconds across midnight and DST", async () => {
    for (const [start, end, now, direction, expected] of [
      ["2026-10-28T12:00:42.500Z", "2026-10-28T12:30:12.500Z", NOW, "earlier", "2026-10-28T11:59:42.500Z"],
      ["2026-10-28T04:00:42.500Z", "2026-10-28T04:30:12.500Z", NOW, "earlier", "2026-10-28T03:59:42.500Z"],
      ["2026-03-08T06:59:42.500Z", "2026-03-08T07:30:12.500Z", "2026-03-08T08:30:00.000Z", "later", "2026-03-08T07:00:42.500Z"],
      ["2026-11-01T05:59:42.500Z", "2026-11-01T06:30:12.500Z", "2026-11-01T08:30:00.000Z", "later", "2026-11-01T06:00:42.500Z"],
    ]) {
      const state = freshState();
      state.now = now;
      state.baby.born_at = "2026-03-01T12:00:00.000Z";
      const original = record(55, "sleep", {}, start, { ended_at: end });
      state.entries = [original];
      const f = await fixture({ state, records: state.entries, entryResponse: ({ route, req }) => route.fulfill({ json: { entry: { ...original, ...req.postDataJSON() } } }) });
      try {
        await f.page.goto("https://first-use.example.test/#log");
        await f.page.getByRole("button", { name: /^Edit: Slept,/ }).click();
        const form = f.page.getByRole("dialog", { name: "Slept", exact: true });
        await form.getByRole("group", { name: "Fell asleep", exact: true }).getByRole("button", { name: `1 minute ${direction}`, exact: true }).click();
        await form.getByRole("button", { name: "Save", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        const patch = writes(f)[0]?.body;
        assert.equal(patch?.started_at, expected, "One minute must adjust exactly 60 seconds across day and clock changes");
        assert.equal(patch.ended_at, undefined, "Adjusting the start must preserve the saved end");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }
  }],
  ["Bath note-only edits preserve recorded seconds and duration", async () => {
    const state = freshState();
    const original = record(54, "bath", {}, "2026-10-28T12:00:42.500Z", { ended_at: "2026-10-28T12:03:12.500Z" });
    state.entries = [original];
    const f = await fixture({ state, records: state.entries, entryResponse: ({ route, req }) => route.fulfill({ json: { entry: { ...original, ...req.postDataJSON() } } }) });
    try {
      await f.page.goto("https://first-use.example.test/#log");
      await f.page.getByRole("button", { name: /^Edit: Bath,/ }).click();
      const form = f.page.getByRole("dialog", { name: "Bath", exact: true });
      await form.locator("textarea").fill("Synthetic bath note");
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await form.waitFor({ state: "hidden" });
      const patch = writes(f)[0]?.body;
      assert.equal(patch?.note, "Synthetic bath note");
      assert.equal(patch.started_at, undefined, "A note-only edit must not rewrite the saved start");
      assert.equal(patch.ended_at, undefined, "A note-only edit must not round or clear the saved 150-second bath");
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Bath length does not silently move an explicit start", async () => {
    const f = await fixture();
    try {
      await f.page.goto("https://first-use.example.test/#today");
      await f.page.getByRole("button", { name: "More", exact: true }).click();
      await f.page.getByRole("dialog", { name: "More to log", exact: true }).getByRole("button", { name: /^Bath(?:$|\s)/ }).click();
      const form = f.page.getByRole("dialog", { name: "Bath", exact: true });
      await form.getByRole("button", { name: "15 min ago", exact: true }).click();
      await form.getByRole("button", { name: "30m", exact: true }).click();
      assert(await form.getByRole("button", { name: "Log it", exact: true }).isDisabled(), "A chosen duration beyond now must not silently move an explicit start");
      assert.match(await form.textContent(), /Choose an earlier start or a shorter length/);
      assert.equal(writes(f).length, 0);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["History at local midnight preserves the selected day without invented duration", async () => {
    for (const [label, kind] of [["Sleep", "sleep"], ["Pump", "pump"], ["Tummy time", "tummy"]]) {
      const state = freshState();
      state.now = "2026-10-28T04:00:00.000Z";
      state.entries = [record(52, "diaper", { pee: true, poop: false }, "2026-10-27T12:00:00.000Z")];
      const f = await fixture({ state, records: state.entries, entryResponse: ({ route, req }) => route.fulfill({ json: { entry: record(99, kind, req.postDataJSON().data, req.postDataJSON().started_at, req.postDataJSON()) } }) });
      try {
        await f.page.goto("https://first-use.example.test/#log");
        await f.page.locator("#maple-day-2026-10-27").getByRole("button", { name: "Add entry for Yesterday", exact: true }).click();
        await f.page.getByRole("dialog", { name: "Log earlier", exact: true }).getByRole("button", { name: label, exact: true }).click();
        const form = f.page.getByRole("dialog", { name: label, exact: true });
        await form.getByRole("button", { name: "Log it", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        await f.page.waitForTimeout(50);
        const saved = writes(f)[0]?.body;
        assert.equal(saved?.kind, kind);
        assert.equal(saved.started_at, "2026-10-27T04:00:00.000Z", `${kind} must remain on the chosen local day`);
        assert.equal(saved.ended_at, saved.started_at, `${kind} must not replace a zero-span preset with invented duration`);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }
  }],
  ["Saved Vitamin D opens its recorded dose for correction", async () => {
    const state = freshState();
    state.entries = [record(51, "med", { name: "Vitamin D", dose: "Recorded label amount" }, undefined, { note: "Synthetic saved note" })];
    const f = await fixture({ state, records: state.entries, entryResponse: ({ route, req, url, state }) => {
      assert.equal(req.method(), "PATCH");
      assert.equal(url.searchParams.get("id"), "51");
      const patch = req.postDataJSON();
      const saved = { ...state.entries[0], ...patch, data: { ...state.entries[0].data, ...patch.data }, updated_at: NOW };
      state.entries = [saved]; state.rev = "example-2";
      return route.fulfill({ json: { entry: saved } });
    } });
    try {
      await f.page.goto("https://first-use.example.test/#today");
      await f.page.getByRole("button", { name: "More", exact: true }).click();
      await f.page.getByRole("dialog", { name: "More to log", exact: true }).getByRole("button", { name: /^Vitamin D logged/ }).click();
      const form = f.page.getByRole("dialog").filter({ has: f.page.getByRole("textbox", { name: "Medicine name", exact: true }) });
      await form.waitFor();
      assert.equal(await form.getByRole("textbox", { name: "Dose", exact: true }).inputValue(), "Recorded label amount");
      assert.equal(await form.locator("textarea").inputValue(), "Synthetic saved note");
      assert.equal(writes(f).length, 0, "Opening saved status must not write another dose");
      await form.locator("textarea").fill("Synthetic corrected note");
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await form.waitFor({ state: "hidden" });
      assert.equal(writes(f).length, 1);
      assert.equal(writes(f)[0].method, "PATCH");
      assert.equal(state.entries.length, 1);
      assert.equal(state.entries[0].note, "Synthetic corrected note");
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Populated historical days add any kind with both times on that day", async () => {
    for (const [label, title, kind] of [["Sleep", "Sleep", "sleep"], ["Pump", "Pump", "pump"], ["Tummy time", "Tummy time", "tummy"], ["Bath", "Bath", "bath"]]) {
      const state = freshState();
      state.entries = [record(52, "diaper", { pee: true, poop: false }, "2026-10-27T12:00:00.000Z")];
      const f = await fixture({ state, records: state.entries, entryResponse: ({ route, req }) => route.fulfill({ json: { entry: record(99, kind, req.postDataJSON().data, req.postDataJSON().started_at, req.postDataJSON()) } }) });
      try {
        await f.page.setViewportSize({ width: 320, height: 740 });
        await f.page.goto("https://first-use.example.test/#log");
        await f.page.locator("#maple-day-2026-10-27").getByRole("button", { name: "Add entry for Yesterday", exact: true }).click();
        const picker = f.page.getByRole("dialog", { name: "Log earlier", exact: true });
        await picker.getByText("Yesterday", { exact: true }).waitFor();
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth), 320, "The historical picker must fit a narrow phone");
        if (process.env.FIRST_USE_VISUAL && kind === "sleep") {
          await f.page.waitForTimeout(350);
          await f.page.screenshot({ path: "/tmp/maple-first-use-picker.png" });
        }
        await picker.getByRole("button", { name: new RegExp(`^${label}(?:$|\\s)`) }).click();
        const form = f.page.getByRole("dialog", { name: title, exact: true });
        await form.waitFor();
        assert.equal(writes(f).length, 0, "Choosing a kind must keep the record unsaved");
        const dates = form.locator('input[type="date"]');
        // Time fields display the day even before the date editor is opened.
        assert(await form.getByText(/Yesterday/).count(), `${kind} must display the selected day`);
        for (const date of await dates.all()) assert.equal(await date.inputValue(), "2026-10-27");
        await form.getByRole("button", { name: "Log it", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        await f.page.waitForTimeout(50);
        const saved = writes(f)[0]?.body;
        assert.equal(saved?.kind, kind);
        assert.equal(saved.started_at.slice(0, 10), "2026-10-27");
        if (kind !== "bath") {
          assert.equal(saved.ended_at.slice(0, 10), "2026-10-27");
          assert.equal(Date.parse(saved.ended_at) - Date.parse(saved.started_at), 15 * 60_000, "Historical ranges must not extend until today");
        }
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }
  }],
  ["Empty history respects feeding preferences in quick picks and More", async () => {
    for (const [nursing, bottles] of [[true, true], [false, true], [true, false], [false, false]]) {
      const state = freshState();
      state.baby.settings = { show_alerts: false, track_nursing: nursing, feeds_bottle: bottles, track_pump: false };
      const f = await fixture({ state });
      try {
        await f.page.goto("https://first-use.example.test/#log");
        const quick = f.page.getByRole("group", { name: "Log an earlier one", exact: true });
        await quick.waitFor();
        assert.equal(await quick.getByRole("button", { name: "Nursing", exact: true }).count(), Number(nursing));
        assert.equal(await quick.getByRole("button", { name: "Bottle", exact: true }).count(), Number(bottles));
        await quick.getByRole("button", { name: "More", exact: true }).click();
        const picker = f.page.getByRole("dialog", { name: "Log earlier", exact: true });
        await picker.waitFor();
        assert.equal(await picker.getByRole("button", { name: "Nursing", exact: true }).count(), Number(nursing));
        assert.equal(await picker.getByRole("button", { name: "Bottle", exact: true }).count(), Number(bottles));
        assert.equal(await picker.getByRole("button", { name: /^Pump/ }).count(), 0);
        assert.equal(writes(f).length, 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }
  }],
  ["History does not offer logging to viewers", async () => {
    const state = freshState();
    state.me = { ...state.me, role: "viewer" }; state.members = [state.me];
    state.entries = [record(53, "diaper", { pee: true, poop: false })];
    const f = await fixture({ state, records: state.entries });
    try {
      await f.page.goto("https://first-use.example.test/#log");
      await f.page.locator("#maple-day-2026-10-28").waitFor();
      assert.equal(await f.page.getByRole("button", { name: /^(?:Log earlier|Add entry) for/ }).count(), 0);
      assert.equal(await f.page.getByRole("group", { name: "Log an earlier one", exact: true }).count(), 0);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["A date chosen in an entirely empty history stays selected", async () => {
    const f = await fixture();
    try {
      await f.page.goto("https://first-use.example.test/#log");
      await f.page.getByRole("button", { name: "Jump to a day", exact: true }).click();
      await f.page.getByLabel("Jump to a day", { exact: true }).fill("2026-10-25");
      await f.page.locator("#maple-day-2026-10-25").getByRole("button", { name: "Add entry for Sun, Oct 25", exact: true }).click();
      const picker = f.page.getByRole("dialog", { name: "Log earlier", exact: true });
      await picker.getByText("Sun, Oct 25", { exact: true }).waitFor();
      await picker.getByRole("button", { name: "Diaper", exact: true }).click();
      const form = f.page.getByRole("dialog", { name: "Diaper", exact: true });
      await form.getByText(/Sun, Oct 25/).first().waitFor();
      assert.equal(writes(f).length, 0);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
];

try {
  for (const [name, run] of cases) {
    if (process.env.FIRST_USE_CASE && !name.includes(process.env.FIRST_USE_CASE)) continue;
    try { await run(); console.log(`PASS ${name} (${browserName})`); }
    catch (error) { failures++; console.error(`FAIL ${name} (${browserName}): ${error.message}`); }
  }
} finally { await browser.close(); await rm(out, { recursive: true, force: true }); }
if (failures) process.exit(1);

