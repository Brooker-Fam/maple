import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Little extras in the real app (lib/maple/whimsy, components/maple/extras.ts): the line under a log's toast, as a
 * phone with them on shows it. The whole app is bundled into a browser fixture and every request is answered here, at
 * an example.test origin, with synthetic records only (River, Sam, Alex). The checks read the lines from their own
 * module (fixture.jsx) and assert what's drawn, never a line's words, so they hold while the lines are rewritten.
 * `EXTRAS_UI_CASE` runs the cases whose names contain it; a failure leaves a screenshot in test-results/maple-extras-ui.
 * `EXTRAS_UI_BASELINE=<git revision>` loads the timer, sleep-plan and her food-and-drink hooks from that revision
 * (through esbuild, nothing swapped in the worktree), to see which cases catch them missing their lines.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const tailwind = require("@tailwindcss/postcss");
const out = await mkdtemp(path.join(tmpdir(), "maple-extras-ui-"));
const screenshots = path.join(root, "test-results/maple-extras-ui");
await build({
  entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(out, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", absWorkingDir: root, tsconfig: path.join(root, "tsconfig.json"),
  define: { "process.env": "{}" }, plugins: [{ name: "synthetic-browser", setup(plugin) {
    plugin.onResolve({ filter: /^next\/dynamic$/ }, () => ({ path: "dynamic", namespace: "synthetic-runtime" }));
    plugin.onLoad({ filter: /.*/, namespace: "synthetic-runtime" }, () => ({ contents: 'import {lazy,Suspense} from "react"; export default function dynamic(load){const Component=lazy(load);return function Dynamic(props){return <Suspense fallback={<p>Loading view…</p>}><Component {...props}/></Suspense>}}', loader: "jsx", resolveDir: root }));
    const baseline = process.env.EXTRAS_UI_BASELINE;
    if (baseline) plugin.onLoad({ filter: /\/(?:useTimerActions|sleep\/useSleep|care\/useNutrition)\.tsx$/ }, ({ path: file }) => ({ contents: execFileSync("git", ["show", `${baseline}:${path.relative(root, file)}`], { cwd: root, encoding: "utf8" }), loader: "tsx", resolveDir: path.dirname(file) }));
  } }],
});
const css = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, "src/app/globals.css"), "utf8"), { from: path.join(root, "src/app/globals.css") });
await writeFile(path.join(out, "app.css"), css.css + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
const html = '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link href="/app.css" rel="stylesheet"></head><body><div id="root"></div><script src="/app.js" type="module"></script></body></html>';

const ORIGIN = "https://extras.example.test";
const TZ = "America/New_York";
/** 12:30 PM in the family's timezone, and 2:00 AM the same night (8 PM–7 AM is the night: quiet cheers only). */
const DAY = "2026-11-15T17:30:00.000Z";
const NIGHT = "2026-11-15T07:00:00.000Z";
/** 26 days old: past the first days, and no weekly milestone today. */
const BORN = "2026-10-20T14:00:00.000Z";
const MIN = 60_000;
const me = { email: "sam@example.test", display_name: "Sam", role: "owner", emoji: null, color: null };
const partner = { email: "alex@example.test", display_name: "Alex", role: "member", emoji: null, color: null };
/** The words the toast fills in for River (sex female), written out here rather than taken from the app's own helper. */
const WORDS = { name: "River", Name: "River", he: "she", He: "She", him: "her", his: "her", His: "Her", hes: "she's", Hes: "She's" };
const fill = (text) => text.replace(/\{(\w+)\}/g, (token, key) => WORDS[key] ?? token);
const TOKEN = /\{\w+\}/;
const ageDays = (now) => Math.floor((Date.parse(now) - Date.parse(BORN)) / 86_400_000);
const iso = (ms) => new Date(ms).toISOString();
const ago = (now, minutes) => iso(Date.parse(now) - minutes * MIN);
const record = (id, kind, data, startedAt, extra = {}) => ({
  id, kind, data, started_at: startedAt, ended_at: null, active: false, note: null, created_by: me.email, updated_by: null,
  created_at: startedAt, updated_at: startedAt, source: "web", ...extra,
});
/** A morning already in the log (a bottle, a wet diaper), so Today is the everyday page. */
const history = (now) => [
  record(11, "feed", { method: "bottle", amount_ml: 90, milk: "breastmilk" }, ago(now, 150)),
  record(12, "diaper", { pee: true, poop: false }, ago(now, 180)),
];
const stateAt = (now, entries) => ({
  now, rev: "extras-1", seen_at: null, family: { id: 99, ask: "Sam" },
  baby: { id: 99, name: "River", nickname: null, sex: "female", timezone: TZ, born_at: BORN, due_date: "2026-10-20", birth_weight_g: null, birth_length_cm: null, birth_head_cm: null, settings: { show_alerts: false } },
  me, members: [me, partner], entries, growth: [], lifetime: { diapers: 1, feeds: 1, firsts: { poop: null, bath: null, tummy: null } }, care: null,
});

const browser = await chromium.launch({ headless: true });
let failures = 0;

/**
 * One phone: the real app at `now` over a synthetic route. `extras`: what this phone's switch holds ("on", "off", or
 * null for nothing stored). `server` keeps what the route has (its entries, the sleep plan's, her page's), so every
 * poll after a write reads it back as the server would.
 */
async function phone({ now = DAY, entries = history(now), extras = "on", sleep, care, viewport = { width: 375, height: 667 }, hash = "#today" } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", timezoneId: "UTC" });
  if (extras !== null) {
    await context.addInitScript(([value]) => {
      try { localStorage.setItem("maple-extras", value); } catch { /* storage blocked */ }
    }, [extras]);
  }
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.clock.setFixedTime(new Date(now));
  const server = { state: stateAt(now, entries.map((e) => ({ ...e }))), writes: [], unexpected: [], seq: 100 };
  if (sleep) server.state.sleep = sleep;
  if (care) server.state.care = care;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const stamp = () => server.state.now;
  const bump = () => (server.state.rev = `extras-${++server.seq}`);
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    assert.equal(url.origin, ORIGIN, "Every request stays inside the synthetic fixture");
    const p = url.pathname;
    if (!p.startsWith("/api/")) {
      const file = p === "/app.js" ? "app.js" : p === "/app.css" ? "app.css" : null;
      return route.fulfill({ contentType: file?.endsWith("js") ? "text/javascript" : file ? "text/css" : "text/html", body: file ? await readFile(path.join(out, file)) : html });
    }
    const method = req.method();
    const body = method === "GET" || method === "DELETE" ? null : req.postDataJSON();
    const json = (value, status = 200) => route.fulfill({ status, json: value });
    if (p === "/api/maple/auth/me") return json({ signedIn: true, google: false, email: false, apple: false, password: false });
    if (p === "/api/maple/state") return json(server.state);
    if (p === "/api/maple/diagnostics") return route.fulfill({ status: 204, body: "" });
    if (p === "/api/maple/chat/consent") return json({ terms: true, care: false, self: false });
    if (p === "/api/maple/chat/shared") return json({ chats: [] });
    if (p === "/api/maple/onboarding") return json({ needed: false });
    if (p === "/api/maple/push") return json({ publicKey: null, sub: null, health: { needs_resubscribe: false }, reminders: [] });
    if (p === "/api/maple/entries") {
      if (method === "GET") return json({ entries: url.searchParams.has("deleted") ? [] : server.state.entries, next_cursor: null, truncated: false });
      if (method === "POST") {
        server.writes.push({ path: p, body });
        const saved = record(++server.seq, body.kind, body.data ?? {}, body.started_at ?? stamp(), { ended_at: body.ended_at ?? null, note: body.note ?? null, created_at: stamp(), updated_at: stamp() });
        server.state.entries = [saved, ...server.state.entries];
        bump();
        return json({ entry: saved, created: true });
      }
    }
    if (p === "/api/maple/timer" && method === "POST") {
      server.writes.push({ path: p, body });
      if (body.action === "start") {
        const feed = body.kind === "feed";
        const started = record(++server.seq, body.kind, feed ? { method: "breast", first_side: body.side, last_side: body.side, segments: [{ side: body.side, start: stamp(), end: null }] } : {}, stamp(), { active: true });
        server.state.entries = [started, ...server.state.entries];
        bump();
        return json({ entry: started, alreadyRunning: false });
      }
      if (body.action === "stop") {
        const was = server.state.entries.find((e) => e.id === body.id);
        if (!was?.active) return json({ error: "Not running", reason: "stopped", entry: was ?? null }, 409);
        const end = body.at ?? stamp();
        const segments = was.data.segments?.map((s) => (s.end === null ? { ...s, end } : s));
        const stopped = { ...was, active: false, ended_at: end, updated_at: stamp(), data: segments ? { ...was.data, segments } : was.data };
        server.state.entries = server.state.entries.map((e) => (e.id === was.id ? stopped : e));
        bump();
        return json({ entry: stopped, ...(segments ? { before: { segments: was.data.segments, started_at: was.started_at, ended_at: null, updated_at: was.updated_at, first_side: was.data.first_side ?? null, last_side: was.data.last_side ?? null } } : {}) });
      }
    }
    if (p === "/api/maple/sleep" && method === "POST" && body.action === "try.finish" && server.state.sleep) {
      server.writes.push({ path: p, body });
      const before = server.state.sleep.tries.find((t) => t.id === body.id);
      const sleepNow = server.state.entries.find((e) => e.id === before.sleep_entry_id);
      const finished = { ...before, ended_at: sleepNow.ended_at ?? body.at ?? stamp(), outcome: body.outcome, updated_at: stamp() };
      server.state.sleep = { ...server.state.sleep, tries: [finished] };
      bump();
      return json({ result: { try: finished, before, sleep: sleepNow, sleepBefore: sleepNow, status: "finished" }, entries: [sleepNow], removed: [], sleep: server.state.sleep });
    }
    if (p === "/api/maple/care/entries" && server.state.care) {
      if (method === "GET") return json({ entries: server.state.care.entries, tz: TZ });
      if (method === "POST") {
        server.writes.push({ path: p, body });
        const entry = { ...body, id: ++server.seq, med_id: null, note: body.note ?? null, private: false, created_by: me.email, updated_by: null, source: "web", created_at: stamp(), updated_at: stamp() };
        server.state.care = { ...server.state.care, entries: [entry, ...server.state.care.entries] };
        bump();
        return json({ created: true, entry, notes: [] }, 201);
      }
    }
    server.unexpected.push(`${method} ${p}`);
    return json({ error: "Unexpected synthetic endpoint" }, 500);
  });
  await page.goto(`${ORIGIN}/${hash}`);
  return {
    page, server, errors,
    /** The family's clock moves on (the route's and this phone's), as a phone's does between two logs. */
    later: async (minutes) => {
      server.state.now = iso(Date.parse(server.state.now) + minutes * MIN);
      await page.clock.setFixedTime(new Date(server.state.now));
    },
    close: () => context.close(),
  };
}

/** A phone for `run`, closed after it; a failure leaves a screenshot of what the phone showed (synthetic records only). */
async function withPhone(opts, run) {
  const f = await phone(opts);
  try {
    await run(f);
    assert.deepEqual(f.errors, [], "No errors in the page");
  } catch (error) {
    await mkdir(screenshots, { recursive: true });
    await f.page.screenshot({ path: path.join(screenshots, `${current.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${++shot}.png`) }).catch(() => {});
    if (f.server.unexpected.length) error.message += ` (unexpected requests: ${[...new Set(f.server.unexpected)].join(", ")})`;
    throw error;
  } finally {
    await f.close();
  }
}
let current = "";
let shot = 0;

/** The toasts above the dock, oldest first, and the little extras drawn anywhere (a toast inside a sheet too). */
const toasts = (page) => page.locator("[data-maple-toasts] > div");
const extrasShown = (page) => page.locator("[data-toast-extra]");
/**
 * A dock tile, tapped as a person reads what the last tap brought in: past the dock's shared tap cooldown and a
 * diaper tile's own check mark (src/components/maple/Dock.tsx, tapCooldown.ts).
 */
async function tap(page, tile) {
  await page.waitForTimeout(1300);
  await page.locator(`[data-tile="${tile}"]`).click();
}
/** The lines that may follow an entry like `entry` at this age, by day or at night, as the module says (fixture.jsx). */
const poolFor = (page, entry, now, night) => page.evaluate(([e, days, n]) => {
  const ids = window.__extras.pool(e, days, n);
  return window.__extras.lines.filter((line) => ids.includes(line.id));
}, [entry, ageDays(now), night]);
const textOf = (locator) => locator.evaluate((el) => el.textContent ?? "");
/** The box of an element, from the bottom of the screen (px). */
const fromBottom = (locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { top: window.innerHeight - r.top, bottom: window.innerHeight - r.bottom };
});

const diaper = (pee, poop) => ({ kind: "diaper", data: { pee, poop }, active: false });

const cases = [
  ["A quick diaper's toast carries one little extra, River's name and pronouns filled in", async () => {
    await withPhone({}, async ({ page, server }) => {
      await page.locator('[data-tile="pee"]').waitFor();
      const pool = await poolFor(page, diaper(true, false), DAY, false);
      assert(pool.length > 0, "Some line fits a wet diaper by day");
      await tap(page, "pee");
      await extrasShown(page).first().waitFor();
      assert.equal(await toasts(page).count(), 1);
      assert.equal(await extrasShown(page).count(), 1, "One line, under the one toast");
      assert.equal(await toasts(page).first().locator("[data-toast-extra]").count(), 1, "The line is the toast's own");
      const shown = (await textOf(extrasShown(page).first())).trim();
      assert(shown.length > 0, "The line has words");
      assert(!/[{}]/.test(shown), `No token is left in braces: ${shown}`);
      assert(pool.some((line) => fill(line.text) === shown), `The line is one that fits a wet diaper, filled in: ${shown}`);
      assert.deepEqual(server.writes.map((w) => w.body.kind), ["diaper"], "One diaper saved");
    });

    // Only the lines that name the baby left to come round (the rest marked as shown): the one shown has River's words in.
    await withPhone({}, async ({ page }) => {
      await page.locator('[data-tile="pee"]').waitFor();
      let pick = null;
      for (const [tile, pee, poop] of [["pee", true, false], ["poop", false, true], ["both", true, true]]) {
        const pool = await poolFor(page, diaper(pee, poop), DAY, false);
        const named = pool.filter((line) => TOKEN.test(line.text));
        if (named.length) {
          pick = { tile, pool, named };
          break;
        }
      }
      if (!pick) return console.log("  (no diaper line names the baby right now: the first part covers the filling)");
      const seenKey = await page.evaluate(() => window.__extras.seenKey);
      const seen = pick.pool.filter((line) => !pick.named.includes(line)).map((line) => line.id);
      await page.evaluate(([key, ids]) => localStorage.setItem(key, JSON.stringify({ seen: ids, at: null, kind: null })), [seenKey, seen]);
      await tap(page, pick.tile);
      await extrasShown(page).first().waitFor();
      const shown = (await textOf(extrasShown(page).first())).trim();
      assert(!/[{}]/.test(shown), `No token is left in braces: ${shown}`);
      assert(pick.named.some((line) => fill(line.text) === shown), `A line naming the baby, with River's words in: ${shown}`);
      assert(/\b(?:River|[Ss]he|[Hh]er)\b/.test(shown), `River's name or pronouns are in it: ${shown}`);
    });
  }],

  ["A poop's color chips stay as far from the bottom of the screen with the line as without it", async () => {
    const at = {};
    for (const extras of ["on", "off"]) {
      await withPhone({ extras }, async ({ page }) => {
        await tap(page, "poop");
        const toast = toasts(page).last();
        const chip = toast.locator("button:has(.mp-swatch)").first();
        await chip.waitFor();
        await page.waitForTimeout(300);
        const lines = await toast.locator("[data-toast-extra]").count();
        assert.equal(lines, extras === "on" ? 1 : 0, `With extras ${extras}, ${extras === "on" ? "one line" : "no line"} under the poop's toast`);
        at[extras] = { chip: await fromBottom(chip), text: await fromBottom(toast.locator("span.flex-1").first()) };
        if (lines) {
          const line = await fromBottom(toast.locator("[data-toast-extra]"));
          assert(line.bottom >= at[extras].chip.top - 0.5, "The line sits above the chips, never between them and the thumb");
          assert(line.top <= at[extras].text.bottom + 0.5, "The line sits under the toast's text");
        }
      });
    }
    assert(Math.abs(at.on.chip.bottom - at.off.chip.bottom) <= 1, `The chips stay put: ${at.on.chip.bottom}px from the bottom with the line, ${at.off.chip.bottom}px without`);
    assert(at.on.text.bottom > at.off.text.bottom + 4, "The toast grows upward to make room for the line");
  }],

  ["A feed finished with Done and a sleep with Woke up get a line; a start, or a finish beside another timer, gets none", async () => {
    const started = ago(DAY, 18);
    const feed = record(31, "feed", { method: "breast", first_side: "L", last_side: "L", segments: [{ side: "L", start: started, end: null }] }, started, { active: true });
    await withPhone({ entries: [feed, ...history(DAY)] }, async ({ page, server }) => {
      await tap(page, "done");
      const toast = toasts(page).last();
      const fix = toast.getByRole("button", { name: "Ended earlier…", exact: true });
      await fix.waitFor();
      assert.equal(await extrasShown(page).count(), 1, "The Done toast carries one line");
      assert.equal(await toast.locator("[data-toast-extra]").count(), 1);
      assert((await fromBottom(toast.locator("[data-toast-extra]"))).bottom >= (await fromBottom(fix)).top - 0.5, "Its chip stays under the line");
      assert.equal(server.writes.find((w) => w.path === "/api/maple/timer")?.body.action, "stop");
    });

    // A sleep in the bassinet with no try on it: Woke up's toast gets a line too.
    const asleep = record(32, "sleep", { place: "bassinet" }, ago(DAY, 40), { active: true });
    await withPhone({ entries: [asleep, ...history(DAY)] }, async ({ page, server }) => {
      await tap(page, "wake");
      const toast = toasts(page).last();
      await toast.getByRole("button", { name: "Edit", exact: true }).waitFor();
      assert.equal(await toast.locator("[data-toast-extra]").count(), 1, "Woke up's toast carries one line");
      assert.equal(server.writes.find((w) => w.path === "/api/maple/timer")?.body.action, "stop");
    });

    // Done on the feed while a sleep timer runs on ("Keep both"): that card's live clock stays clear, so no line.
    const dozing = record(33, "sleep", {}, ago(DAY, 5), { active: true });
    await withPhone({ entries: [feed, dozing, ...history(DAY)], viewport: { width: 320, height: 568 } }, async ({ page, server }) => {
      await tap(page, "done");
      await toasts(page).last().getByRole("button", { name: "Ended earlier…", exact: true }).waitFor();
      await page.waitForTimeout(300);
      assert.equal(await extrasShown(page).count(), 0, "No line while another timer's card runs on");
      assert.equal(server.writes.find((w) => w.path === "/api/maple/timer")?.body.id, feed.id);
    });

    // A running timer's toast sits under its card's live clock: it stays two lines, with no extra.
    await withPhone({}, async ({ page, server }) => {
      await tap(page, "L");
      await page.getByRole("region", { name: "Nursing timer", exact: true }).waitFor();
      await toasts(page).last().getByRole("button", { name: "Undo", exact: true }).waitFor();
      await page.waitForTimeout(300);
      assert.equal(await extrasShown(page).count(), 0, "No line under a start");
      assert.equal(server.writes.find((w) => w.path === "/api/maple/timer")?.body.action, "start");
    });
  }],

  ["Woke up on a bassinet try asks how it went with no line; the try's answer gets the cheer, unless her sleep runs on", async () => {
    const down = ago(DAY, 40);
    const sleep = record(41, "sleep", { place: "bassinet" }, down, { active: true });
    const bassinet = { id: 51, started_at: down, ended_at: null, outcome: null, put_down_by: me.email, tags: [], note: null, sleep_entry_id: 41, made_sleep: true, created_by: me.email, updated_by: me.email, source: "web", created_at: down, updated_at: down };
    const trying = { entries: [sleep, ...history(DAY)], sleep: { plan: null, tries: [bassinet], shifts: [], goals: [] } };
    await withPhone(trying, async ({ page, server }) => {
      await tap(page, "wake");
      const sheet = page.getByRole("dialog", { name: "How did it go?", exact: true });
      await sheet.waitFor();
      await page.getByText(/^Slept /).first().waitFor();
      await page.waitForTimeout(300);
      assert.equal(await extrasShown(page).count(), 0, "Woke up's toast leaves the cheer to the try's answer");
      await sheet.getByRole("button", { name: /^Stayed asleep/ }).click();
      await sheet.waitFor({ state: "hidden" });
      await extrasShown(page).first().waitFor();
      assert.equal(await extrasShown(page).count(), 1, "The try's outcome toast carries one line");
      assert.equal(server.writes.find((w) => w.path === "/api/maple/sleep")?.body.action, "try.finish");
    });

    // Picked up still asleep, from the try's card: her sleep timer runs on, and its card's live clock stays clear.
    await withPhone(trying, async ({ page, server }) => {
      const card = page.locator('[data-sleep-card="try"]');
      await card.waitFor();
      await page.waitForTimeout(1300);
      await card.getByRole("button", { name: /^Picked up/ }).click();
      await toasts(page).last().getByText(/^Picked up/).waitFor();
      await page.getByRole("region", { name: "Asleep timer", exact: true }).waitFor();
      await page.waitForTimeout(300);
      assert.equal(await extrasShown(page).count(), 0, "No line while her sleep timer runs on");
      assert.equal(server.writes.find((w) => w.path === "/api/maple/sleep")?.body.outcome, "picked_up");
    });
  }],

  ["Her own drink gets a cheer", async () => {
    const care = { person: { member: me.email, name: "Sam", self: true, created_by: me.email }, access: { self: true, read: true, write: true, private: true, mood: true, therapist: true, manage: true }, settings: { checkin_suggestions: false }, plans: [], entries: [], mood: [] };
    await withPhone({ care, hash: "#care" }, async ({ page, server }) => {
      await page.getByRole("button", { name: /^Log water, / }).click();
      await extrasShown(page).first().waitFor();
      assert.equal(await extrasShown(page).count(), 1, "Her drink's toast carries one line");
      assert.equal(server.writes.find((w) => w.path === "/api/maple/care/entries")?.body.kind, "drink");
    });
  }],

  ["The \"Same one?\" question and a temperature get none", async () => {
    const theirs = record(61, "diaper", { pee: true, poop: false }, ago(DAY, 2), { created_by: partner.email });
    await withPhone({ entries: [theirs, ...history(DAY)] }, async ({ page, server }) => {
      await tap(page, "pee");
      await toasts(page).last().getByRole("button", { name: "Keep both", exact: true }).waitFor();
      await page.waitForTimeout(300);
      assert.equal(await extrasShown(page).count(), 0, "A question gets nothing under it but its answers");
      assert.deepEqual(server.writes.map((w) => w.body.kind), ["diaper"], "The diaper is saved, as the dock always does");
    });

    await withPhone({}, async ({ page, server }) => {
      await tap(page, "more");
      await page.getByRole("dialog", { name: "More to log", exact: true }).getByRole("button", { name: /^Temperature/ }).click();
      const form = page.getByRole("dialog", { name: "Temperature", exact: true });
      await form.getByRole("textbox", { name: "temperature in degrees Fahrenheit", exact: true }).fill("98.6");
      await form.getByRole("button", { name: "Log it", exact: true }).click();
      await form.waitFor({ state: "hidden" });
      await toasts(page).last().waitFor();
      await page.waitForTimeout(300);
      assert.deepEqual(server.writes.map((w) => w.body.kind), ["temp"]);
      assert.equal(await extrasShown(page).count(), 0, "A reading gets the plain confirmation only");
    });
  }],

  ["Switched off, or with nothing stored under automation, there are none", async () => {
    for (const extras of ["off", null]) {
      await withPhone({ extras }, async ({ page, server }) => {
        const stored = await page.evaluate(() => ({ webdriver: navigator.webdriver, value: localStorage.getItem("maple-extras") }));
        assert.deepEqual(stored, { webdriver: true, value: extras }, "A browser under automation, with the switch as set");
        await tap(page, "pee");
        await toasts(page).first().waitFor();
        await tap(page, "poop");
        await toasts(page).nth(1).waitFor();
        await page.waitForTimeout(300);
        assert.deepEqual(server.writes.map((w) => w.body.kind), ["diaper", "diaper"]);
        assert.equal(await extrasShown(page).count(), 0, `No line with ${extras ?? "nothing stored"}`);
      });
    }
  }],

  ["At night the first log gets a quiet line and one ten minutes later gets none", async () => {
    await withPhone({ now: NIGHT, entries: history(NIGHT) }, async ({ page, server, later }) => {
      await page.locator('[data-tile="pee"]').waitFor();
      const pool = await poolFor(page, diaper(true, false), NIGHT, true);
      assert(pool.length > 0, "Some quiet line fits a diaper at night");
      await tap(page, "pee");
      await extrasShown(page).first().waitFor();
      assert.equal(await extrasShown(page).count(), 1);
      const shown = (await textOf(extrasShown(page).first())).trim();
      assert(pool.some((line) => fill(line.text) === shown), `The night's line is one of the quiet ones: ${shown}`);
      await later(10);
      await tap(page, "pee");
      await toasts(page).nth(1).waitFor();
      await page.waitForTimeout(300);
      assert.equal(await toasts(page).count(), 2, "The first toast is still up beside the second");
      assert.equal(await toasts(page).nth(0).locator("[data-toast-extra]").count(), 1, "The first log keeps its line");
      assert.equal(await toasts(page).nth(1).locator("[data-toast-extra]").count(), 0, "Ten minutes on, the next log gets none");
      assert.deepEqual(server.writes.map((w) => w.body.kind), ["diaper", "diaper"], "Both diapers saved");
      assert.equal(server.writes[1].body.started_at, iso(Date.parse(NIGHT) + 10 * MIN), "The second is logged ten minutes after the first, by the phone's clock");
    });
  }],
];

try {
  for (const [name, run] of cases) {
    if (process.env.EXTRAS_UI_CASE && !name.includes(process.env.EXTRAS_UI_CASE)) continue;
    current = name;
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures++;
      console.error(`FAIL ${name}: ${error.message}`);
    }
  }
} finally {
  await browser.close();
  await rm(out, { recursive: true, force: true });
}
if (failures) process.exit(1);
