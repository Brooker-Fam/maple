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
const out = await mkdtemp(path.join(tmpdir(), "maple-timing-history-"));
await build({
  entryPoints: [path.join(root, "scripts/first-use-ui/fixture.jsx")], outfile: path.join(out, "app.js"), bundle: true,
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

async function fixture({ state, records, entryResponse, rangeResponse }) {
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

const localDay = (at, timezone) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

try {
  const state = freshState();
  const records = [record(54, "diaper", { pee: true, poop: false }, "2026-10-10T12:00:42.500Z")];
  const f = await fixture({
    state,
    records,
    rangeResponse: ({ route, url, records }) => route.fulfill({ json: {
      entries: records.filter((entry) => {
        const day = localDay(entry.started_at, state.baby.timezone);
        return day >= url.searchParams.get("from") && day <= url.searchParams.get("to");
      }),
      truncated: false,
    } }),
    entryResponse: ({ route, req, state, records }) => {
      const saved = { ...records[0], ...req.postDataJSON(), updated_at: state.now };
      records[0] = saved;
      state.rev = "example-2";
      return route.fulfill({ json: { entry: saved } });
    },
  });
  try {
    await f.page.goto("https://first-use.example.test/#log");
    await f.page.getByRole("button", { name: "Jump to a day", exact: true }).click();
    await f.page.getByLabel("Jump to a day", { exact: true }).fill("2026-10-03");
    await f.page.locator("#maple-day-2026-10-03").waitFor();
    await f.page.getByRole("button", { name: /^Edit: Wet diaper,/ }).click();
    const form = f.page.getByRole("dialog", { name: "Wet diaper", exact: true });
    await form.getByLabel("When: exact time: date", { exact: true }).fill("2026-10-03");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await form.waitFor({ state: "hidden" });
    await f.page.waitForTimeout(2000);
    const count = await f.page.getByRole("button", { name: /^Edit: Wet diaper,/ }).count();
    assert.equal(count, 1, "Moving an older entry to another already-loaded week must keep it visible exactly once");
    const destination = f.page.locator("#maple-day-2026-10-03");
    assert.equal(await destination.getByRole("button", { name: /^Edit: Wet diaper,/ }).count(), 1);
    assert.match(await destination.textContent(), /1 wet/);
    assert.equal(await f.page.locator("#maple-day-2026-10-10").getByRole("button", { name: /^Edit: Wet diaper,/ }).count(), 0);
    assert.equal(localDay(records[0].started_at, state.baby.timezone), "2026-10-03");
    assert.deepEqual(f.errors, []);
    console.log(`PASS historical retime moves the row and count into the selected older week (${browserName})`);
  } finally { await f.close(); }
} finally { await browser.close(); await rm(out, { recursive: true, force: true }); }
