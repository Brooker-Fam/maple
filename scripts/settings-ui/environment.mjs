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
const baselineFiles = new Set(["MapleApp.tsx", "AppNav.tsx", "FamilyTab.tsx", "Hero.tsx", "TodayTab.tsx", "LogTab.tsx", "PatternsTab.tsx", "MomentsTab.tsx", "care/CareScreen.tsx", "chat/ChatTab.tsx", "settings/AccountSettings.tsx", "settings/AssistantSettings.tsx", "settings/parts.tsx", "settings/PhoneSettings.tsx"]);

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
  const browser = await (process.env.REVIEW_BROWSER === "webkit" ? webkit : chromium).launch({ headless: true });
  return {
    visit: (options) => visit(browser, output, options),
    close: async () => { await browser.close(); await rm(output, { recursive: true, force: true }); },
  };
}

async function visit(browser, output, { hash = "today", guest = false, width = 390, theme = "light" } = {}) {
  const controls = { ...world(), signedIn: true, signoutFailure: false, tokens: [] };
  if (guest) {
    controls.state.me = { ...controls.state.me, email: "invite:900", role: "viewer", display_name: "Helper" };
    controls.state.members = [controls.state.me];
    controls.state.care = null;
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
  if (url.pathname === "/api/maple/invites") return json({ invites: [] });
  if (url.pathname === "/api/maple/epic") return json({ available: false });
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
