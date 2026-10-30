import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiRoute, world } from "../care-recovery-ui/world.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const screenshots = path.join(root, "test-results/settings-ui");
const require = createRequire(path.join(root, "package.json"));
const { build } = require("esbuild");
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const tailwind = require("@tailwindcss/postcss");
export const origin = "https://maplebaby.app";
const baseline = process.env.SETTINGS_BASELINE_REF;
const baselineFiles = new Set(["MapleApp.tsx", "AppNav.tsx", "FamilyTab.tsx", "AccountMenu.tsx", "useMaple.tsx", "Hero.tsx", "TodayTab.tsx", "LogTab.tsx", "PatternsTab.tsx", "MomentsTab.tsx", "care/CareScreen.tsx", "chat/ChatTab.tsx", "settings/PeopleSettings.tsx", "settings/AccountSettings.tsx", "settings/AssistantSettings.tsx", "settings/parts.tsx", "settings/PhoneSettings.tsx"]);

export async function environment() {
  const output = await mkdtemp(path.join(tmpdir(), "maple-settings-design-"));
  await mkdir(screenshots, { recursive: true });
  await build({
    entryPoints: [path.join(root, "scripts/care-recovery-ui/fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true,
    format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env": "{}" },
    plugins: [{ name: "synthetic-settings", setup(plugin) {
      plugin.onLoad({ filter: /\.tsx$/ }, ({ path: file }) => {
        const relative = path.relative(path.join(root, "src/components/maple"), file);
        if (baseline && baselineFiles.has(relative)) return { contents: execFileSync("git", ["show", `${baseline}:src/components/maple/${relative}`], { cwd: root, encoding: "utf8" }), loader: "tsx" };
      });
      plugin.onResolve({ filter: /^next\/dynamic$/ }, () => ({ path: "dynamic", namespace: "synthetic" }));
      plugin.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({ contents: 'import {lazy,Suspense} from "react"; export default function dynamic(load){const C=lazy(load);return function Dynamic(props){return <Suspense><C {...props}/></Suspense>}}', loader: "jsx", resolveDir: root }));
    } }],
  });
  const cssPath = path.join(root, "src/app/globals.css");
  const css = await postcss([tailwind({ base: root })]).process(await readFile(cssPath, "utf8"), { from: cssPath });
  await writeFile(path.join(output, "app.css"), css.css + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
  const { chromium, webkit } = require("playwright");
  const browser = await (process.env.REVIEW_BROWSER === "webkit" ? webkit : chromium).launch({ headless: true, ...(process.env.REVIEW_BROWSER_PATH ? { executablePath: process.env.REVIEW_BROWSER_PATH } : {}) });
  return {
    visit: (options) => visit(browser, output, options),
    close: async () => { await browser.close(); await rm(output, { recursive: true, force: true }); },
  };
}

async function visit(browser, output, { hash = "today", guest = false, role, width = 390, theme = "light", feedbackAsk = false } = {}) {
  const controls = { ...world(), signedIn: true, signoutFailure: false, tokens: [], memories: syntheticMemories(), memoryConflict: false, feedbackAsk };
  if (guest) {
    controls.state.me = { ...controls.state.me, email: "invite:900", role: "viewer", display_name: "Helper" };
    controls.state.members = [controls.state.me];
    controls.state.care = null;
  }
  if (role) controls.state.me.role = role;
  if (role === "photos") {
    controls.state.care = null;
    controls.state.entries = [];
    controls.state.baby.settings = {};
  }
  const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: "reduce", colorScheme: theme === "dark" ? "dark" : "light" });
  const page = await context.newPage();
  page.setDefaultTimeout(baseline ? 1500 : 5000);
  await page.addInitScript(({ theme }) => {
    localStorage.setItem("theme", theme === "dark" ? "dark" : "light");
    localStorage.setItem("maple-night", theme === "night" ? "always" : "off");
    document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.toggle("dark", theme === "dark"));
  }, { theme });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin, "Synthetic records cannot leave the local fixture");
    if (url.pathname.startsWith("/api/")) return settingsRoute(route, controls);
    const file = ["/app.js", "/app.css"].includes(url.pathname) ? url.pathname.slice(1) : null;
    await route.fulfill({ contentType: file?.endsWith("js") ? "text/javascript" : file ? "text/css" : "text/html", body: file ? await readFile(path.join(output, file)) : '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link href="/app.css" rel="stylesheet"></head><body><div id="root"></div><script src="/app.js" type="module"></script></body></html>' });
  });
  await page.goto(`${origin}/#${hash}`);
  await page.getByRole("navigation", { name: "Maple's Log" }).waitFor();
  return { page, controls, errors, close: () => context.close() };
}

async function settingsRoute(route, controls) {
  const req = route.request();
  const url = new URL(req.url());
  const json = (body, status = 200) => route.fulfill({ status, json: body });
  if (url.pathname === "/api/maple/auth/me") return json({ signedIn: controls.signedIn, google: true, email: true, apple: false, password: false });
  if (!controls.signedIn && url.pathname === "/api/maple/state") return json({ error: "Signed out" }, 401);
  if (url.pathname === "/api/maple/auth/signout") {
    controls.requests.push({ path: url.pathname, method: req.method() });
    if (controls.signoutFailure) return json({ error: "Synthetic sign-out failure" }, 503);
    controls.signedIn = false;
    return json({ ok: true });
  }
  if (url.pathname === "/api/maple/diagnostics") return route.fulfill({ status: 204, body: "" });
  if (url.pathname === "/api/maple/auth/methods") return json({ methods: [], google: true, email: true, apple: false });
  if (url.pathname === "/api/maple/invites") {
    controls.requests.push({ path: url.pathname, method: req.method(), body: req.postDataJSON() });
    return req.method() === "POST" ? json({ url: `${origin}/maple/invite/synthetic-local-only`, invites: [] }) : json({ invites: [] });
  }
  if (url.pathname === "/api/maple/members") {
    const body = req.postDataJSON();
    controls.requests.push({ path: url.pathname, method: req.method(), body });
    if (req.method() === "PATCH") {
      controls.state.members = controls.state.members.map((member) => member.email === (body.email ?? controls.state.me.email) ? { ...member, ...body } : member);
      controls.state.me = controls.state.members.find((member) => member.email === controls.state.me.email);
      controls.changed();
    }
    return json(req.method() === "POST" ? { url: `${origin}/maple/invite/synthetic-local-only`, emailed: false } : { members: controls.state.members });
  }
  if (url.pathname === "/api/maple/memories") return memoriesRoute(req, controls, json);
  if (url.pathname === "/api/maple/epic") return json({ available: false });
  // A check that sets controls.chatStream reads that conversation instead, with its terms accepted.
  if (controls.chatStream && url.pathname === "/api/maple/chat/consent") return json({ terms: true, care: false, self: false });
  if (controls.chatStream && url.pathname === "/api/maple/chat") return json(controls.chatStream);
  if (url.pathname === "/api/maple/chat") return json({ messages: [], has_more: false, thread_id: "synthetic-settings-thread" });
  if (url.pathname === "/api/maple/baby" && req.method() === "PATCH") {
    const body = req.postDataJSON();
    controls.state.baby = { ...controls.state.baby, ...body, settings: { ...controls.state.baby.settings, ...body.settings } };
    controls.changed();
    return json({ baby: controls.state.baby });
  }
  if (url.pathname === "/api/maple/tokens") {
    controls.requests.push({ path: url.pathname, method: req.method() });
    if (req.method() === "POST") {
      const record = { id: 900, label: "Synthetic iPhone", created_at: controls.state.now, last_used_at: null };
      controls.tokens.push(record);
      return json({ token: "maple_synthetic_fixture_key_never_valid", record });
    }
    if (req.method() === "DELETE") controls.tokens = [];
    return json({ tokens: controls.tokens });
  }
  return apiRoute(route, controls);
}

/** Settings → Memories over made-up records (memory/types.ts MemoryList); `controls.memoryConflict` answers the next edit with 409. */
function memoriesRoute(req, controls, json) {
  const list = controls.memories;
  const canEdit = controls.state.me.role === "owner" || controls.state.me.role === "member";
  const reply = () => json({ ...list, canEdit });
  if (req.method() === "GET") return reply();
  const body = req.postDataJSON();
  controls.requests.push({ path: "/api/maple/memories", method: "POST", body });
  if (!canEdit) return json({ error: "You have view-only access." }, 403);
  const at = controls.state.now;
  const find = (id) => list.records.find((m) => m.id === id);
  if (controls.memoryConflict && body.action === "correct") {
    controls.memoryConflict = false;
    const current = find(body.id);
    current.fact = "Someone else's newer words.";
    current.revision += 1;
    return json({ error: "Someone changed that memory just now. Here it is as it is now.", code: "changed", current, list: { ...list, canEdit } }, 409);
  }
  if (body.action === "save" || body.action === "correct") {
    const id = Math.max(0, ...list.records.map((m) => m.id)) + 1;
    if (body.action === "correct") Object.assign(find(body.id), { status: "superseded", ended_at: at, ended_by: controls.state.me.email });
    list.records.unshift({ id, ...body.memory, status: "active", revision: 1, predecessor_id: body.action === "correct" ? body.id : null, said_by: controls.state.me.email, via: "web", source_text: null, source_words: true, stated_at: at, ended_at: null, ended_by: null, ended_via: null, updated_at: at });
  }
  if (body.action === "resolve" || body.action === "archive") Object.assign(find(body.id), { status: body.action === "resolve" ? "resolved" : "archived", ended_at: at, ended_by: controls.state.me.email, ended_via: "web" });
  if (body.action === "forget") list.records = list.records.filter((m) => m.id !== body.id && m.predecessor_id !== body.id);
  if (body.action === "forget_all") list.records = [];
  if (body.action === "switches") list.state = { ...list.state, ...(body.capture === undefined ? {} : { capture: body.capture }), ...(body.use === undefined ? {} : { use: body.use }) };
  return reply();
}

/** Made-up family memories for River's family: current ones of several kinds, one ended, one replaced. */
export function syntheticMemories() {
  const base = { reason: null, valid_from: null, valid_to: null, review_on: null, revision: 1, predecessor_id: null, said_by: "sam@example.test", via: "chat", source_text: null, source_words: false, ended_at: null, ended_by: null, ended_via: null };
  const at = (day) => `2026-10-${day}T14:00:00.000Z`;
  return {
    state: { revision: 7, epoch: 2, capture: true, use: true },
    today: "2026-10-28",
    records: [
      { ...base, id: 1, kind: "routine", fact: "Sam does the 2am feed on weeknights.", status: "active", stated_at: at(20), updated_at: at(20), via: "web", source_words: true },
      { ...base, id: 2, kind: "feeding", fact: "River takes a sensitive formula; regular formula gave her gas.", reason: "Gas and fussiness after feeds", predecessor_id: 5, status: "active", stated_at: at(22), updated_at: at(22), source_text: "the sensitive one works way better for her", source_words: true, review_on: "2026-11-15" },
      { ...base, id: 3, kind: "health", fact: "River's pediatrician wants her woken to eat every 3 hours until her weight check.", status: "active", valid_to: "2026-11-03", stated_at: at(24), updated_at: at(24), source_text: "Saved because the parent asked to remember the doctor's instruction.", via: "claude" },
      { ...base, id: 4, kind: "sleep", fact: "River sleeps swaddled in the bassinet.", status: "active", valid_to: "2026-10-25", stated_at: at(12), updated_at: at(12) },
      { ...base, id: 5, kind: "feeding", fact: "River takes regular formula.", status: "superseded", stated_at: at(10), updated_at: at(22), ended_at: at(22), ended_by: "sam@example.test", ended_via: "chat" },
    ],
  };
}
