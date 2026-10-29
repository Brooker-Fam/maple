import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const tailwind = require("@tailwindcss/postcss");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const output = await mkdtemp(path.join(tmpdir(), "maple-development-ui-"));
const baseline = process.env.MAPLE_DEVELOPMENT_BASELINE;
const only = process.env.MAPLE_DEVELOPMENT_ONLY;
const screenshots = path.join(root, "test-results/maple-development-ui");
await mkdir(screenshots, { recursive: true });
await build({
  entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env.NODE_ENV": '"test"' },
  plugins: [{ name: "synthetic-development-boundaries", setup(plugin) {
    const mocks = { path: path.join(here, "mocks.jsx") };
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav|sheets)$/ }, () => mocks);
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => args.importer.endsWith("/sheets/parts.tsx") ? mocks : undefined);
    if (baseline) plugin.onLoad({ filter: /\/development\/[A-Za-z]+\.tsx?$/ }, async (args) => {
      const name = path.basename(args.path);
      if (baseline === "storage" && name === "useDiscoveryPreferences.ts") {
        const contents = (await readFile(args.path, "utf8")).replace("  const temporary = memory.get(key);\n  if (temporary !== undefined) return temporary;\n", "");
        return { contents, loader: "ts", resolveDir: path.dirname(args.path) };
      }
      if (baseline === "disable" && name === "DailyDiscovery.tsx") {
        const contents = (await readFile(args.path, "utf8")).replace("const { update } = useDiscoveryPreferences();", "const { update, preferences } = useDiscoveryPreferences();\n  if (!preferences.enabled) return null;");
        return { contents, loader: "tsx", resolveDir: path.dirname(args.path) };
      }
      if (baseline === "focus" && name === "DailyDiscovery.tsx") {
        const contents = (await readFile(args.path, "utf8")).replace("heading.current?.focus({ preventScroll: true })", "void heading.current");
        return { contents, loader: "tsx", resolveDir: path.dirname(args.path) };
      }
      if (!["storage", "disable", "focus"].includes(baseline) && ["DailyDiscovery.tsx", "DiscoveryPreferences.tsx", "MilestonesToNotice.tsx"].includes(name)) {
        return { contents: "export default function AbsentFeature() { return null; }", loader: "tsx" };
      }
      return undefined;
    });
  } }],
});
const css = path.join(root, "src/app/globals.css");
const compiled = await postcss([tailwind({ base: root })]).process(await readFile(css, "utf8"), { from: css });
await writeFile(path.join(output, "app.css"), compiled.css + "\n" + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
await writeFile(path.join(output, "index.html"), '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic development check</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const origin = "https://maple-development.example.test";
const failures = [];
let scenarios = 0;
const card = (page) => page.locator('section[aria-labelledby="daily-discovery-title"]');
const options = (page) => page.getByRole("button", { name: "Discovery options", exact: true }).click();
const done = async (page) => { await page.getByRole("button", { name: "Done", exact: true }).click(); await page.getByRole("dialog").waitFor({ state: "hidden" }); };
const choose = async (page, label) => { await options(page); await page.getByRole("checkbox", { name: label, exact: true }).check(); await done(page); };
const screenshot = async (page, filename, fullPage = false) => {
  await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] > div')].every((layer) => {
    const style = getComputedStyle(layer);
    return Number(style.opacity) >= 0.999 && (style.transform === "none" || Math.abs(new DOMMatrixReadOnly(style.transform).m42) < 0.1);
  }));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(screenshots, filename), fullPage });
};
const expandedMilestones = async (page) => {
  await page.getByRole("button", { name: "Moments tab", exact: true }).click();
  const summary = page.locator("summary").filter({ hasText: "Milestones to notice" });
  await summary.waitFor();
  await summary.click();
  return summary.locator("..");
};
async function scenario(name, query, check) {
  if (only && !name.includes(only)) return;
  scenarios++;
  const context = await browser.newContext({ viewport: { width: 320, height: 812 }, reducedMotion: "reduce", locale: "en-US", serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  const errors = [];
  const network = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || !["/", "/app.js", "/app.css"].includes(url.pathname)) {
      network.push(route.request().url());
      await route.abort();
      return;
    }
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    await route.fulfill({ contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html", body: await readFile(path.join(output, file)) });
  });
  try {
    await page.goto(`${origin}/?${query}#today`);
    await page.waitForFunction(() => !!window.__development);
    await check(page);
    assert.deepEqual((await page.evaluate(() => window.__development.calls())).filter((call) => call.kind === "write"), []);
    assert.deepEqual(network, [], "The fixture never contacts an outside service or API");
    assert.deepEqual(errors, []);
    console.log(`PASS ${name}`);
  } catch (error) {
    await page.screenshot({ path: path.join(screenshots, baseline ? "baseline-failure.png" : "failure.png") }).catch(() => {});
    if (!baseline) throw new Error(`${name}: ${error.message}`, { cause: error });
    failures.push(name);
    console.error(`FAIL baseline ${name}: ${error.message.split("\n")[0]}`);
  } finally {
    await context.close();
  }
}

try {
  await scenario("one quiet discovery fits 320px in day, dark and night with a linked source", "", async (page) => {
    await card(page).waitFor();
    assert.equal(await card(page).count(), 1);
    assert.equal(await card(page).locator("details").getAttribute("open"), null);
    assert.equal(await page.getByRole("progressbar").count(), 0);
    for (const theme of ["day", "dark"]) {
      await page.evaluate((value) => window.__development.setTheme(value), theme);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await screenshot(page, `today-320-${theme}.png`);
    }
    await card(page).locator("summary").click();
    const link = card(page).getByRole("link", { name: /^Source:/ });
    assert.match(await link.getAttribute("href"), /^https:\/\//);
    assert.equal(await link.getAttribute("target"), "_blank");
    await page.evaluate(() => window.__development.setTheme("night"));
    await page.getByRole("button", { name: "Today's little discovery", exact: true }).waitFor();
    assert.equal(await card(page).count(), 0);
    await screenshot(page, "today-320-night.png");
  });

  await scenario("topic choices apply immediately and survive reload", "", async (page) => {
    await choose(page, "Movement & play");
    const title = await card(page).getByRole("heading").textContent();
    assert((await page.evaluate(() => window.__development.topicTitles("movement"))).includes(title));
    await page.reload();
    await card(page).waitFor();
    assert.equal(await card(page).getByRole("heading").textContent(), title);
    await options(page);
    assert(await page.getByRole("checkbox", { name: "Movement & play", exact: true }).isChecked());
    assert.equal(await page.getByRole("checkbox", { checked: true }).count(), 1);
    await screenshot(page, "topics-320-day.png");
  });

  await scenario("topic preferences stay separate for each member, family and baby", "", async (page) => {
    await card(page).waitFor();
    await page.getByRole("button", { name: "Settings tab", exact: true }).click();
    const brain = page.getByRole("checkbox", { name: "Brain & senses", exact: true });
    await brain.check();
    for (const identity of [{ email: "jordan@example.test" }, { family: 100, email: "alex@example.test" }, { family: 99, baby: 100 }]) {
      await page.evaluate((value) => window.__development.switchIdentity(value), identity);
      await page.waitForFunction(() => [...document.querySelectorAll('input[type="checkbox"]')].every((input) => !input.checked));
      assert.equal(await brain.isChecked(), false);
    }
    await page.evaluate(() => window.__development.switchIdentity({ family: 99, baby: 99, email: "alex@example.test" }));
    await page.waitForFunction(() => document.querySelector('input[type="checkbox"]')?.checked);
    assert(await brain.isChecked());
  });

  await scenario("hide for today expires at the baby's local midnight", "timezone=Pacific%2FAuckland&now=2026-10-29T10%3A59%3A00.000Z", async (page) => {
    await options(page);
    await page.getByRole("button", { name: "Hide for today", exact: true }).click();
    await page.getByRole("button", { name: "Show again", exact: true }).waitFor();
    assert.equal(await card(page).count(), 0);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((key) => key.startsWith("maple-discoveries-v1:")))));
    assert.equal(stored.hiddenDay, "2026-10-29");
    await page.evaluate(() => window.__development.setClock("2026-10-29T11:00:01.000Z"));
    await card(page).waitFor();
    assert.equal(await page.getByRole("button", { name: "Show again", exact: true }).count(), 0);
  });

  await scenario("running timers keep discoveries collapsed until requested", "timer=sleep", async (page) => {
    const reveal = page.getByRole("button", { name: "Today's little discovery", exact: true });
    await reveal.waitFor();
    assert.equal(await card(page).count(), 0);
    const box = await reveal.boundingBox();
    assert(box && box.height >= 44);
    await reveal.click();
    await card(page).waitFor();
    assert.equal(await card(page).count(), 1);
    await page.waitForFunction(() => document.activeElement?.id === "daily-discovery-title");
  });

  await scenario("unborn, future birth and older children have no development content", "", async (page) => {
    await card(page).waitFor();
    for (const born_at of [null, "2027-01-01T12:00:00.000Z", "2023-01-01T12:00:00.000Z"]) {
      await page.evaluate((value) => window.__development.setBaby({ born_at: value }), born_at);
      await card(page).waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Moments tab", exact: true }).click();
      assert.equal(await page.locator("summary").filter({ hasText: "Milestones to notice" }).count(), 0);
      await page.getByRole("button", { name: "Today tab", exact: true }).click();
    }
  });

  await scenario("corrected age is explicit with its own source", "born=2026-07-01T12%3A00%3A00.000Z&gestation=32", async (page) => {
    const panel = await expandedMilestones(page);
    await panel.getByText(/2 months corrected age/).waitFor();
    assert.match(await panel.locator("summary").textContent(), /By 2 months/);
    assert.equal(await panel.getByRole("link").count(), 2);
    assert.equal(await panel.getByRole("link", { name: "American Academy of Pediatrics: corrected age", exact: true }).getAttribute("href"), "https://www.healthychildren.org/english/ages-stages/baby/preemie/pages/preemie-milestones.aspx");
    await screenshot(page, "milestones-320-corrected.png", true);
  });

  await scenario("milestones stay optional and reuse saved moments and moment presets", "", async (page) => {
    await page.getByRole("button", { name: "Moments tab", exact: true }).click();
    const summary = page.locator("summary").filter({ hasText: "Milestones to notice" });
    await summary.waitFor();
    const panel = summary.locator("..");
    assert.equal(await panel.getAttribute("open"), null);
    await summary.click();
    assert.equal(await panel.getByRole("listitem").count(), 3);
    assert.equal(await panel.getByRole("checkbox").count(), 0);
    assert.equal(await panel.getByRole("progressbar").count(), 0);
    await panel.getByRole("button", { name: "Open saved moment: Smiles when you talk or smile", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__development.calls()), [{ kind: "open-moment", id: 901 }]);
    await panel.getByRole("button", { name: "Save a moment: Looks at your face", exact: true }).click();
    assert.deepEqual((await page.evaluate(() => window.__development.calls())).at(-1), { kind: "sheet", value: { kind: "moment", preset: { milestone: "looks-at-face", title: "Looks at your face" } } });
    assert.match(await panel.textContent(), /not a complete checklist or a developmental screening/);
    await screenshot(page, "milestones-320-day.png");
  });

  await scenario("tummy guidance opens the existing entry sheet without logging", "", async (page) => {
    await choose(page, "Movement & play");
    await page.evaluate(() => window.__development.showDiscovery("little-tummy-time", "movement"));
    await card(page).locator("summary").click();
    await page.getByRole("button", { name: "Log tummy time", exact: true }).click();
    await page.getByRole("dialog", { name: "Tummy time", exact: true }).waitFor();
    assert(await page.getByRole("button", { name: "Log it", exact: true }).isVisible());
    assert.deepEqual(await page.evaluate(() => window.__development.calls()), [{ kind: "sheet", value: { kind: "tummy", entry: undefined } }]);
    await screenshot(page, "tummy-sheet-320-day.png");
  });

  await scenario("viewers can read discoveries and saved moments without write actions", "role=viewer", async (page) => {
    await choose(page, "Movement & play");
    await page.evaluate(() => window.__development.showDiscovery("little-tummy-time", "movement"));
    await card(page).locator("summary").click();
    assert.equal(await page.getByRole("button", { name: "Log tummy time", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Milestones to notice in Moments", exact: true }).click();
    await page.waitForURL(/#moments$/);
    const panel = await expandedMilestones(page);
    assert.equal(await panel.getByRole("button", { name: /^Save a moment:/ }).count(), 0);
    assert.equal(await panel.getByRole("button", { name: /^Open saved moment:/ }).count(), 1);
    assert.equal(await panel.getByRole("listitem").count(), 3);
  });

  await scenario("disable keeps the chooser open and can be reversed before closing", "", async (page) => {
    await options(page);
    const toggle = page.getByRole("switch", { name: "Show on Today", exact: true });
    await toggle.click();
    await page.getByRole("dialog", { name: "Daily discoveries", exact: true }).waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    assert.equal(await card(page).count(), 0);
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    await done(page);
    await card(page).waitFor();
  });

  await scenario("storage write failure retains topic choices for the current visit", "", async (page) => {
    await card(page).waitFor();
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException("Synthetic storage full", "QuotaExceededError"); }; });
    await options(page);
    const movement = page.getByRole("checkbox", { name: "Movement & play", exact: true });
    await movement.check();
    assert(await movement.isChecked());
    await done(page);
    assert((await page.evaluate(() => window.__development.topicTitles("movement"))).includes(await card(page).getByRole("heading").textContent()));
  });
  assert(scenarios > 0, "At least one scenario must run");
  if (baseline) {
    assert.equal(failures.length, scenarios, "Every selected regression scenario must fail against its baseline");
    throw new Error(`Baseline rejected by all ${failures.length} regression scenarios`);
  }
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
