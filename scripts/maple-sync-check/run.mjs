import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingCases } from "./timing-cases.mjs";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const ts = require("typescript");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const output = await mkdtemp(path.join(tmpdir(), "maple-sync-check-"));
const origin = "https://maple-sync.example.test";
const now = "2026-01-01T10:17:00.000Z";
const member = { email: "alex@example.test", role: "owner", display_name: "Alex Example", emoji: null, color: null };
const feed = (id, started_at, ended_at) => ({
  id, kind: "feed", started_at, ended_at, active: !ended_at,
  data: { method: "breast", segments: [{ side: "L", start: started_at, end: ended_at }] },
  note: null, created_by: member.email, updated_by: null, source: "web", created_at: started_at, updated_at: ended_at ?? started_at,
});
const previous = feed(901, "2026-01-01T07:00:00.000Z", "2026-01-01T07:12:00.000Z");
const running = feed(902, "2026-01-01T10:00:00.000Z", null);
const saved = feed(902, running.started_at, now);
const snapshot = (rev, entries) => ({
  now, rev, entries, growth: [], me: member, members: [member], lifetime: { diapers: 0, feeds: entries.length }, seen_at: now,
  family: { id: 99, ask: "Alex" },
  baby: { id: 99, name: "River Example", nickname: "River", sex: "female", due_date: null, born_at: "2025-12-25T10:00:00.000Z", birth_weight_g: null, birth_length_cm: null, birth_head_cm: null, timezone: "UTC", settings: {} },
});

await build({
  entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", sourcemap: "inline", absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"test"' },
  plugins: [{ name: "production-sync-chip", setup(plugin) {
    if (process.env.MAPLE_SYNC_BASELINE_DIR) {
      plugin.onLoad({ filter: /\/useMaple\.tsx$/ }, async () => ({
        contents: await readFile(path.join(process.env.MAPLE_SYNC_BASELINE_DIR, "useMaple.tsx"), "utf8"),
        loader: "tsx", resolveDir: path.join(root, "src/components/maple"),
      }));
    }
    plugin.onResolve({ filter: /^fixture-sync-chip$/ }, () => ({ path: "sync-chip", namespace: "production-chip" }));
    plugin.onLoad({ filter: /.*/, namespace: "production-chip" }, async () => {
      try {
        if (process.env.MAPLE_SYNC_BASELINE_DIR) throw new Error("Use baseline component");
        const file = path.join(root, "src/components/maple/SyncStatus.tsx");
        await readFile(file, "utf8");
        return { contents: `export { default as SyncChip } from ${JSON.stringify(file)};`, loader: "tsx", resolveDir: root };
      } catch {}
      const file = path.join(root, "src/components/maple/MapleApp.tsx");
      const sourceFile = process.env.MAPLE_SYNC_BASELINE_DIR ? path.join(process.env.MAPLE_SYNC_BASELINE_DIR, "MapleApp.tsx") : file;
      const source = ts.createSourceFile(file, await readFile(sourceFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const chip = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "SyncChip");
      assert(chip, "The production SyncChip must exist");
      return {
        contents: `import { useMaple } from "./useMaple"; import { Icon } from "./icons"; ${chip.getText(source)}; export { SyncChip };`,
        loader: "tsx", resolveDir: path.dirname(file),
      };
    });
  } }],
});
const app = await readFile(path.join(output, "app.js"));
const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const cases = [];
const check = (name, run) => cases.push({ name, run });
const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const state = (page) => page.evaluate(() => {
  const { state, status, error, online, pending, seenAt } = window.__mapleSync;
  return { state, status, error, online, pending, seenAt };
});
const poll = (page) => page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.dispatchEvent(new Event("visibilitychange"));
});

async function fixture(entries = [previous]) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: "reduce", timezoneId: "UTC" });
  const page = await context.newPage();
  const requests = [];
  const diagnostics = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      errors.push(`Unexpected external request: ${url.origin}`);
      return route.abort();
    }
    if (url.pathname === "/api/maple/auth/me") return route.fulfill({ json: { signedIn: false, google: false, apple: false, email: false, password: true } });
    if (url.pathname === "/api/maple/diagnostics") {
      diagnostics.push(...route.request().postDataJSON().events);
      return route.fulfill({ status: 204 });
    }
    if (url.pathname.startsWith("/api/maple/")) {
      requests.push({ url, route, method: route.request().method(), body: route.request().postDataJSON() });
      return;
    }
    if (url.pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: app });
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><title>Synthetic Maple sync checks</title></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>' });
  });
  const take = async (pathname, method = "GET") => {
    const started = Date.now();
    while (Date.now() - started < 3000) {
      const index = requests.findIndex((item) => item.url.pathname === pathname && item.method === method);
      if (index !== -1) return requests.splice(index, 1)[0];
      if (errors.length) throw new Error(errors.join("\n"));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`No ${method} ${pathname}; queued: ${requests.map((r) => r.url.pathname).join(", ")}`);
  };
  const answer = async (request, json, status = 200) => {
    await request.route.fulfill({ status, json });
    await settle(page);
  };
  await page.goto(origin);
  await answer(await take("/api/maple/state"), snapshot("before", entries));
  await page.waitForFunction(() => window.__mapleSync?.status === "ready");
  return { page, take, answer, diagnostics, close: async () => { await context.close(); assert.deepEqual(errors, [], "No uncaught browser errors or outside requests"); } };
}

async function diagnostic(f, event) {
  const started = Date.now();
  while (Date.now() - started < 2000) {
    const found = f.diagnostics.find((item) => item.event === event);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`No ${event} diagnostic received`);
}

async function save(f, mode) {
  if (mode === "manual") {
    await f.page.evaluate((entry) => { void window.__mapleSync.log({ kind: "feed", started_at: entry.started_at, ended_at: entry.ended_at, data: entry.data }, { silent: true }); }, saved);
    await f.answer(await f.take("/api/maple/entries", "POST"), { entry: saved });
  } else {
    await f.page.evaluate((id) => { void window.__mapleSync.timerCall({ action: "stop", id }); }, saved.id);
    await f.answer(await f.take("/api/maple/timer", "POST"), { entry: saved });
  }
  return f.take("/api/maple/state");
}

for (const mode of ["manual", "timer"]) {
  for (const order of ["after fresh poll", "before fresh poll"]) {
    check(`${mode}: old poll ${order} keeps saved feed`, async (f) => {
      const initial = snapshot("before", mode === "timer" ? [running, previous] : [previous]);
      if (mode === "timer") {
        await poll(f.page);
        await f.answer(await f.take("/api/maple/state"), initial);
      }
      await poll(f.page);
      const stale = await f.take("/api/maple/state");
      const fresh = await save(f, mode);
      if (order === "after fresh poll") await f.answer(fresh, snapshot("after", [saved, previous]));
      await f.answer(stale, initial);
      const current = await state(f.page);
      assert.deepEqual(current.state.entries, [saved, previous], "An older snapshot cannot delete a saved feed or reactivate its stopped timer");
      if (order === "before fresh poll") {
        await poll(f.page);
        const verification = await f.take("/api/maple/state");
        assert.equal(verification.url.searchParams.get("rev"), null, "A pre-write snapshot cannot mark the post-write server state verified");
        await f.answer(verification, snapshot("after", [saved, previous]));
        await f.answer(fresh, snapshot("after", [saved, previous]));
      }
      await poll(f.page);
      const next = await f.take("/api/maple/state");
      assert.equal(next.url.searchParams.get("rev"), "after", "An old response cannot roll the next poll's revision backward");
      await f.answer(next, { unchanged: true, now, rev: "after" });
    });
  }
}

for (const failure of [401, 500, "network"]) {
  check(`late ${failure} error cannot invalidate newer success`, async (f) => {
    await poll(f.page);
    const stale = await f.take("/api/maple/state");
    const fresh = await save(f, "manual");
    await f.answer(fresh, snapshot("after", [saved, previous]));
    if (failure === "network") { await stale.route.abort("failed"); await settle(f.page); }
    else await f.answer(stale, { error: "Synthetic request failed" }, failure);
    const current = await state(f.page);
    assert.equal(current.status, "ready", "An old error cannot sign out a current session");
    assert.equal(current.error, null, "An old error cannot replace a successful refresh");
    assert.equal(current.online, true, "An old network error cannot mark a newer successful connection offline");
    assert.deepEqual(current.state.entries, [saved, previous]);
  });
}

check("HTTP refresh failure shows a retry warning with existing state", async (f) => {
  await poll(f.page);
  await f.answer(await f.take("/api/maple/state"), { error: "Synthetic request failed" }, 500);
  const current = await state(f.page);
  assert.equal(current.status, "ready");
  assert.deepEqual(current.state.entries, [previous]);
  assert.equal(await f.page.locator('[data-testid="sync-warning"] button').count(), 1, "An HTTP failure must visibly say the shared log may be out of date");
  await f.page.locator('[data-testid="sync-warning"] button').click();
  await f.answer(await f.take("/api/maple/state"), snapshot("recovered", [previous]));
  assert.equal(await f.page.locator('[data-testid="sync-warning"] button').count(), 0);
});

check("unchanged success clears an earlier HTTP refresh error", async (f) => {
  await poll(f.page);
  await f.answer(await f.take("/api/maple/state"), { error: "Synthetic request failed" }, 500);
  assert.notEqual((await state(f.page)).error, null);
  await poll(f.page);
  const recovery = await f.take("/api/maple/state");
  assert.equal(recovery.url.searchParams.get("rev"), "before");
  await f.answer(recovery, { unchanged: true, now, rev: "before" });
  assert.equal((await state(f.page)).error, null, "A successful unchanged reply is still a successful refresh");
  assert.equal(await f.page.locator('[data-testid="sync-warning"] button').count(), 0);
});

check("older successful poll cannot clear newer refresh failure", async (f) => {
  await poll(f.page);
  const stale = await f.take("/api/maple/state");
  await poll(f.page);
  await f.answer(await f.take("/api/maple/state"), { error: "Synthetic request failed" }, 500);
  await f.answer(stale, snapshot("older", [previous]));
  assert.notEqual((await state(f.page)).error, null, "An older success cannot hide the latest refresh failure");
});

check("a stalled refresh times out visibly and a later poll recovers", async (f) => {
  await f.page.clock.install();
  await poll(f.page);
  await f.take("/api/maple/state");
  await f.page.clock.fastForward(16_000);
  await settle(f.page);
  assert.notEqual((await state(f.page)).error, null, "A state request still pending after 15 seconds must report its timeout");
  assert.equal((await state(f.page)).online, true, "An expired refresh deadline does not prove this phone is offline");
  assert.equal(await f.page.locator('[data-testid="sync-warning"] button').count(), 1);
  assert.match(await f.page.locator('[data-testid="sync-warning"] button').innerText(), /Couldn't refresh/);
  await poll(f.page);
  await f.answer(await f.take("/api/maple/state"), snapshot("recovered", [previous]));
  assert.equal((await state(f.page)).error, null);
  assert.equal(await f.page.locator('[data-testid="sync-warning"] button').count(), 0);
});

check("a return visit keeps its recap anchor when a write invalidates the poll", async (f) => {
  await f.page.clock.install();
  await f.page.clock.setSystemTime(await f.page.evaluate(() => Date.now() + 4 * 3600_000));
  await poll(f.page);
  const firstReturnPoll = await f.take("/api/maple/state");
  const fresh = await save(f, "manual");
  const beforeVisit = "2026-01-01T07:00:00.000Z";
  await f.answer(firstReturnPoll, { ...snapshot("before", [previous]), seen_at: beforeVisit });
  await f.answer(fresh, snapshot("after", [saved, previous]));
  assert.deepEqual((await state(f.page)).state.entries, [saved, previous]);
  assert.equal((await state(f.page)).seenAt, beforeVisit, "The first response has the visit time from before the server marked this visit");
});

check("saving records a correlated refresh and discarded late response", async (f) => {
  await poll(f.page);
  const stale = await f.take("/api/maple/state");
  const fresh = await save(f, "manual");
  const requestId = fresh.route.request().headers()["x-maple-request-id"];
  await f.answer(fresh, snapshot("after", [saved, previous]));
  await f.answer(stale, snapshot("before", [previous]));
  const write = await diagnostic(f, "write_succeeded");
  const refreshed = await diagnostic(f, "refresh_applied_after_write");
  await diagnostic(f, "stale_response_discarded");
  assert.match(requestId, /^[a-f0-9-]{36}$/i);
  assert.equal(write.requestId, requestId);
  assert.equal(refreshed.requestId, requestId);
  assert.equal(write.status, 200);
  for (const event of f.diagnostics) {
    assert(Object.keys(event).every((key) => ["event", "requestId", "status", "elapsedMs"].includes(key)), "Diagnostics cannot contain log records, people, entry kinds, or errors");
  }
});

for (const held of [false, true]) check(`historical correction keeps ${held ? "held " : ""}Undo after recent-state eviction`, async (f) => {
  const before = feed(899, "2025-12-25T07:00:00.000Z", "2025-12-25T07:20:00.000Z");
  const after = { ...before, ended_at: "2025-12-25T07:15:00.000Z", updated_at: now,
    data: { ...before.data, segments: [{ ...before.data.segments[0], end: "2025-12-25T07:15:00.000Z" }] } };
  await f.page.evaluate(({ before, held }) => {
    if (held) window.__mapleSync.holdTimerToasts(true);
    void window.__mapleTimerActions.retime(before, { op: "move", edge: "end", ref: { side: "L", start: before.started_at }, to: "2025-12-25T07:15:00.000Z", expect_updated_at: before.updated_at });
  }, { before, held });
  const request = await f.take("/api/maple/timer", "POST");
  assert.equal(request.body.edit.expect_updated_at, before.updated_at);
  await f.answer(request, { entry: after, before: { segments: before.data.segments, started_at: before.started_at, ended_at: before.ended_at, updated_at: before.updated_at } });
  await f.answer(await f.take("/api/maple/state"), snapshot("historical-save", [previous]));
  if (held) await f.page.evaluate(() => window.__mapleSync.holdTimerToasts(false));
  await f.page.waitForFunction(() => window.__mapleSync.toasts.some((t) => t.undo && t.watch?.entryId === 899));
  assert(!(await state(f.page)).state.entries.some((e) => e.id === before.id), "The historical feed really left the recent-state snapshot");
  assert(await f.page.evaluate(() => window.__mapleSync.toasts.some((t) => t.undo && t.watch?.allowMissing)), "Version-guarded Undo remains available after history eviction");
  await f.page.evaluate(() => window.__mapleSync.toasts.find((t) => t.watch?.entryId === 899).undo());
  const undo = await f.take("/api/maple/timer", "POST");
  assert.equal(undo.body.edit.op, "restore");
  assert.equal(undo.body.edit.expect_updated_at, after.updated_at, "Undo still guards the exact corrected revision");
  await f.answer(undo, { entry: { ...before, updated_at: "2026-01-01T10:17:01.000Z" } });
  await f.answer(await f.take("/api/maple/state"), snapshot("historical-undo", [previous]));
});

check("batch correction previews every change in one request and toast Undo restores the whole feed", async (f) => {
  const at = (minute) => `2026-01-01T09:${String(minute).padStart(2, "0")}:00.000Z`;
  const before = { ...feed(903, at(0), at(40)), note: "Synthetic batch correction",
    data: { method: "breast", first_side: "L", last_side: "R", left_sec: 1200, right_sec: 1200, segments: [
      { side: "L", start: at(0), end: at(20) },
      { side: "R", start: at(20), end: at(40) },
    ] } };
  const edit = { op: "batch", expect_updated_at: before.updated_at, edits: [
    { op: "move", edge: "side_end", ref: { side: "L", start: at(0) }, to: at(15) },
    { op: "set_side", ref: { side: "L", start: at(0) }, side: "B" },
    { op: "move", edge: "start", ref: { side: "R", start: at(20) }, to: at(22) },
    { op: "set_side", ref: { side: "R", start: at(22) }, side: "L" },
    { op: "move", edge: "end", ref: { side: "L", start: at(22) }, to: at(35) },
  ] };
  const after = { ...before, ended_at: at(35), updated_at: now, updated_by: member.email,
    data: { method: "breast", first_side: "L", last_side: "L", left_sec: 780, right_sec: 0, both_sec: 900, segments: [
      { side: "B", start: at(0), end: at(15) },
      { side: "L", start: at(22), end: at(35) },
    ] } };
  const content = ({ started_at, ended_at, active, data, note }) => ({ started_at, ended_at, active, data, note });
  await poll(f.page);
  await f.answer(await f.take("/api/maple/state"), snapshot("batch-before", [before, previous]));
  const timerRequests = [];
  f.page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/maple/timer" && request.method() === "POST") timerRequests.push(request.postDataJSON());
  });
  await f.page.evaluate(({ before, edit }) => { void window.__mapleTimerActions.retime(before, edit); }, { before, edit });
  const request = await f.take("/api/maple/timer", "POST");
  assert.deepEqual(request.body, { action: "retime", id: before.id, edit }, "The provider sends the complete guarded batch");
  assert.deepEqual(content((await state(f.page)).state.entries.find((e) => e.id === before.id)), content(after),
    "Before the server replies, the real provider shows every corrected time, side, and total");
  assert.equal(timerRequests.length, 1, "A multi-correction Save sends one timer request");
  await f.answer(request, { entry: after, before: { segments: before.data.segments, started_at: before.started_at, ended_at: before.ended_at, updated_at: before.updated_at,
    first_side: before.data.first_side ?? null, last_side: before.data.last_side ?? null } });
  await f.answer(await f.take("/api/maple/state"), snapshot("batch-saved", [after, previous]));
  await f.page.waitForFunction(() => window.__mapleSync.toasts.some((t) => t.undo && t.watch?.entryId === 903));
  assert.equal(await f.page.evaluate(() => window.__mapleSync.toasts.find((t) => t.watch?.entryId === 903)?.undoLabel), "Undo changes");
  assert.equal(timerRequests.length, 1, "Success and refresh do not split the draft into further writes");
  await f.page.evaluate(() => window.__mapleSync.toasts.find((t) => t.watch?.entryId === 903).undo());
  const undo = await f.take("/api/maple/timer", "POST");
  assert.deepEqual(undo.body, { action: "retime", id: before.id, edit: {
    op: "restore", segments: before.data.segments, started_at: before.started_at, ended_at: before.ended_at, expect_updated_at: after.updated_at,
    first_side: before.data.first_side, last_side: before.data.last_side,
  } }, "Toast Undo restores the complete server before snapshot with the corrected revision");
  assert.deepEqual(content((await state(f.page)).state.entries.find((e) => e.id === before.id)), content(before),
    "Undo optimistically restores all times, sides, and totals together");
  const restored = { ...before, updated_at: "2026-01-01T10:17:01.000Z", updated_by: member.email };
  await f.answer(undo, { entry: restored });
  await f.answer(await f.take("/api/maple/state"), snapshot("batch-undone", [restored, previous]));
  assert.deepEqual((await state(f.page)).state.entries, [restored, previous]);
  assert.equal(timerRequests.length, 2, "One Save plus one Undo are the only timer writes");
});

check("batch Undo restores stored and absent side hints on a both-side feed", async (f) => {
  const before = { ...feed(904, "2026-01-01T09:00:00.000Z", "2026-01-01T09:20:00.000Z"),
    data: { method: "breast", first_side: "L", left_sec: 0, right_sec: 0, both_sec: 1200,
      segments: [{ side: "B", start: "2026-01-01T09:00:00.000Z", end: "2026-01-01T09:20:00.000Z" }] } };
  const after = { ...before, updated_at: now, data: { method: "breast", first_side: "R", last_side: "R", left_sec: 0, right_sec: 1200,
    segments: [{ ...before.data.segments[0], side: "R" }] } };
  await poll(f.page);
  await f.answer(await f.take("/api/maple/state"), snapshot("both-before", [before, previous]));
  await f.page.evaluate((before) => { void window.__mapleTimerActions.retime(before, { op: "batch", expect_updated_at: before.updated_at,
    edits: [{ op: "set_side", ref: { side: "B", start: before.started_at }, side: "R" }] }); }, before);
  await f.answer(await f.take("/api/maple/timer", "POST"), { entry: after, before: {
    segments: before.data.segments, started_at: before.started_at, ended_at: before.ended_at, updated_at: before.updated_at, first_side: "L", last_side: null,
  } });
  await f.answer(await f.take("/api/maple/state"), snapshot("both-saved", [after, previous]));
  await f.page.waitForFunction(() => window.__mapleSync.toasts.some((t) => t.undo && t.watch?.entryId === 904));
  await f.page.evaluate(() => window.__mapleSync.toasts.find((t) => t.watch?.entryId === 904).undo());
  const undo = await f.take("/api/maple/timer", "POST");
  assert.equal(undo.body.edit.first_side, "L", "The original start-side hint accompanies Undo");
  assert.equal(undo.body.edit.last_side, null, "An absent original last-side hint accompanies Undo as null");
  assert.deepEqual((await state(f.page)).state.entries.find((e) => e.id === before.id).data, before.data,
    "Before the server replies, Undo restores the original hint and removes the introduced hint");
  const restored = { ...before, updated_at: "2026-01-01T10:17:01.000Z" };
  await f.answer(undo, { entry: restored });
  await f.answer(await f.take("/api/maple/state"), snapshot("both-undone", [restored, previous]));
});

check("toast absence exemption still dismisses newer revisions and removed recent entries", async (f) => {
  await f.page.evaluate((entry) => {
    window.__mapleSync.toast("Historical", { duration: 60_000, watch: { entryId: entry.id, updatedAt: entry.updated_at, allowMissing: true } });
    window.__mapleSync.toast("Recent", { duration: 60_000, watch: { entryId: 901, updatedAt: "2026-01-01T07:12:00.000Z" } });
  }, feed(899, "2025-12-25T07:00:00.000Z", "2025-12-25T07:20:00.000Z"));
  const newer = { ...feed(899, "2025-12-25T07:00:00.000Z", "2025-12-25T07:20:00.000Z"), updated_at: now };
  await f.page.evaluate(() => { void window.__mapleSync.refresh(); });
  await f.answer(await f.take("/api/maple/state"), snapshot("newer-and-removed", [newer]));
  assert.equal(await f.page.evaluate(() => window.__mapleSync.toasts.length), 0, "Newer historical revisions and missing recent entries both invalidate watches");
});

check("refresh failures and recovery reach diagnostics", async (f) => {
  await poll(f.page);
  await f.answer(await f.take("/api/maple/state"), { error: "Synthetic private diagnostic sentinel" }, 500);
  assert.equal((await diagnostic(f, "refresh_failed")).status, 500);
  await poll(f.page);
  await f.answer(await f.take("/api/maple/state"), { unchanged: true, now, rev: "before" });
  await diagnostic(f, "refresh_recovered");
  assert(!JSON.stringify(f.diagnostics).includes("sentinel"), "Server error messages stay out of diagnostics");
});

for (const kind of ["feed", "sleep", "tummy", "pump"]) check(`one-minute start correction: ${kind}`, async (f) => {
  await f.page.evaluate((kind) => {
    if (kind === "feed") void window.__mapleTimerActions.startFeed("L");
    else void window.__mapleTimerActions.startTimer(kind);
  }, kind);
  const start = await f.take("/api/maple/timer", "POST");
  assert.equal(start.body.action, "start", "The first tap immediately starts the timer");
  const entry = { ...feed(905, now, null), kind, ...(kind === "feed" ? {} : { data: {} }) };
  await f.answer(start, { entry, alreadyRunning: false });
  await f.page.waitForFunction(() => window.__mapleSync.toasts.some((t) => t.actions?.some((a) => /^1 min/.test(a.label))));
  await f.page.evaluate(() => window.__mapleSync.toasts.find((t) => t.actions?.some((a) => /^1 min/.test(a.label))).actions.find((a) => /^1 min/.test(a.label)).onClick());
  const correction = await f.take("/api/maple/timer", "POST");
  const at = kind === "feed" ? correction.body.edit.to : correction.body.at;
  assert.equal(at, "2026-01-01T10:16:00.000Z", "One minute is measured from the saved start, not the later toast tap");
  assert.equal(correction.body.action, kind === "feed" ? "retime" : "adjust");
  await f.answer(correction, { entry: { ...entry, started_at: at, updated_at: "2026-01-01T10:17:01.000Z", ...(kind === "feed" ? { data: { ...entry.data, segments: [{ side: "L", start: at, end: null }] } } : {}) } });
});

check("one-minute start correction: previous feed boundary", async (f) => {
  const prior = { ...previous, ended_at: "2026-01-01T10:14:30.000Z", data: { method: "bottle", amount_ml: 60 } };
  await f.page.evaluate(() => { void window.__mapleSync.refresh(); });
  await f.answer(await f.take("/api/maple/state"), snapshot("nearby", [prior]));
  await f.page.evaluate(() => { void window.__mapleTimerActions.startFeed("L"); });
  const entry = feed(905, now, null);
  await f.answer(await f.take("/api/maple/timer", "POST"), { entry, alreadyRunning: false });
  await f.page.waitForFunction(() => window.__mapleSync.toasts.some((t) => t.actions?.some((a) => a.label === "Since the last feed")));
  const labels = await f.page.evaluate(() => window.__mapleSync.toasts.find((t) => t.watch?.entryId === 905).actions.map((a) => a.label));
  assert.deepEqual(labels, ["Since the last feed", "1 min"], "Longer choices stop at the previous feed while one minute remains available");
  await f.page.evaluate(() => window.__mapleSync.toasts.find((t) => t.watch?.entryId === 905).actions.find((a) => a.label === "Since the last feed").onClick());
  const correction = await f.take("/api/maple/timer", "POST");
  assert.equal(correction.body.edit.to, prior.ended_at, "The boundary retains the previous feed's exact seconds");
  await f.answer(correction, { entry: { ...entry, started_at: prior.ended_at, updated_at: "2026-01-01T10:17:01.000Z", data: { ...entry.data, segments: [{ side: "L", start: prior.ended_at, end: null }] } } });
});

timingCases({ check, snapshot, running, now });

let failures = 0;
try {
  for (const { name, run } of cases) {
    if (process.env.MAPLE_SYNC_CASE && !name.includes(process.env.MAPLE_SYNC_CASE)) continue;
    let f;
    try {
      f = await fixture();
      await run(f);
      await f.close();
      f = null;
      console.log(`PASS ${name}`);
    } catch (error) {
      failures++;
      console.error(`FAIL ${name}: ${error.message.split("\n")[0]}`);
    } finally {
      if (f) await f.close().catch((error) => console.error(error.message));
    }
  }
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
if (failures) process.exitCode = 1;
