import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const output = await mkdtemp(path.join(tmpdir(), "maple-epic-ui-"));
const screenshots = process.env.MAPLE_EPIC_SCREENSHOTS;
let css = "";
if (screenshots) {
  await mkdir(screenshots, { recursive: true });
  const tailwind = require("@tailwindcss/postcss");
  const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
  const cssPath = path.join(root, "src/app/globals.css");
  const compiled = await postcss([tailwind({ base: root })]).process(await readFile(cssPath, "utf8"), { from: cssPath });
  css = compiled.css + "\n" + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8");
}
await build({ entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true, format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env.NODE_ENV": '"test"', "process.env.NEXT_PUBLIC_MAPLE_ORIGIN": '"https://maple-epic.example.test"' }, plugins: [{ name: "synthetic-medical-records", setup(plugin) {
  plugin.onResolve({ filter: /(?:^|\/)useMaple$/ }, () => ({ path: path.join(here, "mocks.jsx") }));
  plugin.onResolve({ filter: /(?:^|\/)AskChat$/ }, () => ({ path: path.join(here, "mocks.jsx") }));
  plugin.onResolve({ filter: /^\.\/index$/ }, args => args.importer.endsWith("sheets/parts.tsx") ? ({ path: path.join(here, "mocks.jsx") }) : undefined);
} }] });
const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = []; page.on("pageerror", error => errors.push(error.message));
const origin = "https://maple-epic.example.test";
await page.route("**/*", async route => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, "Synthetic checks must never contact MyChart or another external service");
  return route.fulfill({ status: 200, contentType: url.pathname === "/app.js" ? "text/javascript" : url.pathname === "/app.css" ? "text/css" : "text/html", body: url.pathname === "/app.js" ? await readFile(path.join(output, "app.js")) : url.pathname === "/app.css" ? css : '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>' });
});
const snapshot = () => page.evaluate(() => window.__epicFixture.snapshot());
const scenario = async config => {
  await page.evaluate(value => window.__epicFixture.scenario(value), config);
  await page.getByText("Loading medical records…", { exact: true }).waitFor({ state: "hidden" });
};

try {
  await page.goto(`${origin}/maple?epic=denied&keep=yes#family/medical-records`);
  await page.waitForFunction(() => !!window.__epicFixture);
  await page.getByText("MyChart access wasn't approved. You can try again whenever you're ready.", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("epic"), null);
  assert.equal(new URL(page.url()).searchParams.get("keep"), "yes");
  assert.equal(new URL(page.url()).hash, "#family/medical-records");
  assert(await page.getByRole("button", { name: "Review measurements", exact: true }).isDisabled());
  await page.getByRole("checkbox", { name: /This is River Test/ }).check();
  await page.getByRole("button", { name: "Review measurements", exact: true }).click();
  await page.getByText("Choose what to add", { exact: true }).waitFor();
  assert.deepEqual((await snapshot()).calls.find(call => call.path.endsWith("/review")).body, { pendingId: "synthetic-pending", confirmPatient: true });
  assert(await page.getByRole("button", { name: "Add 2 measurements", exact: true }).isDisabled());
  assert.equal(await page.getByText("January 15, 2026", { exact: true }).count(), 1, "Date-only measurement must not invent a time");
  await page.getByRole("checkbox", { name: /Length:/ }).uncheck();
  await page.getByRole("checkbox", { name: /I want the selected measurements/ }).check();
  await page.getByRole("button", { name: "Add 1 measurement", exact: true }).click();
  await page.getByText("1 measurement added to the growth log.", { exact: true }).waitFor();
  assert.deepEqual((await snapshot()).calls.find(call => call.path.endsWith("/import") && call.method === "POST").body, { pendingId: "synthetic-pending", measurementIds: ["synthetic-weight"], shareWithFamilyAndAssistants: true });
  assert.equal((await snapshot()).refreshes, 1);
  console.log("PASS Epic UI: record confirmation, explicit sharing, selection, original date and log refresh");

  await scenario({ stage: "patient", mismatch: true });
  assert(await page.getByRole("button", { name: "Review measurements", exact: true }).isDisabled());
  assert(await page.getByRole("checkbox", { name: /This is River Test/ }).isDisabled());
  await page.getByRole("button", { name: "Connect again", exact: true }).waitFor();
  await scenario({ stage: "measurements", expired: true });
  assert(await page.getByRole("button", { name: "Add 2 measurements", exact: true }).isDisabled());
  assert(await page.getByRole("checkbox", { name: /I want the selected measurements/ }).isDisabled());
  await scenario({ stage: "patient", sandbox: true, mismatch: true });
  await page.getByRole("checkbox", { name: /synthetic test record/ }).check();
  await page.getByRole("button", { name: "Review measurements", exact: true }).click();
  await page.getByText("Choose what to add", { exact: true }).waitFor();
  assert(await page.getByRole("button", { name: "Add 2 measurements", exact: true }).isDisabled());
  assert(await page.getByRole("checkbox", { name: /I want the selected measurements/ }).isDisabled());
  console.log("PASS Epic UI: wrong child, expiration and sandbox save guards");

  await scenario({ stage: "measurements", empty: true, skipped: 1 });
  await page.getByText(/No supported growth measurements were returned/).waitFor();
  assert.equal(await page.getByRole("button", { name: /^Add \d/ }).count(), 0);
  await page.getByRole("button", { name: "Discard pending connection", exact: true }).click();
  await page.getByText("The pending connection was discarded. Nothing was added to the log.", { exact: true }).waitFor();
  assert.deepEqual((await snapshot()).calls.find(call => call.method === "DELETE").body, { pendingId: "synthetic-pending" }, "Discard must name the reviewed authorization");

  await scenario({ importedCount: 2 });
  await page.getByRole("button", { name: "Remove my imported measurements", exact: true }).click();
  assert.equal((await snapshot()).calls.filter(call => call.method === "DELETE").length, 0);
  await page.getByRole("button", { name: "Keep measurements", exact: true }).click();
  assert.equal((await snapshot()).calls.filter(call => call.method === "DELETE").length, 0);
  await page.getByRole("button", { name: "Remove my imported measurements", exact: true }).click();
  await page.getByRole("button", { name: "Remove permanently", exact: true }).click();
  await page.getByText(/Your imported measurements were removed from Maple/).waitFor();
  assert.equal((await snapshot()).calls.filter(call => call.method === "DELETE").length, 1);
  console.log("PASS Epic UI: empty import, discard and explicit permanent-removal confirmation");

  await scenario({ stage: "measurements", failures: { "POST /api/maple/epic/import": true } });
  await page.getByRole("checkbox", { name: /I want the selected measurements/ }).check();
  await page.getByRole("button", { name: "Add 2 measurements", exact: true }).click();
  await page.getByText("Synthetic request failed. Try again.", { exact: true }).waitFor();
  assert(await page.getByRole("checkbox", { name: /I want the selected measurements/ }).isChecked());
  await page.getByRole("button", { name: "Add 2 measurements", exact: true }).click();
  await page.getByText("2 measurements added to the growth log.", { exact: true }).waitFor();
  await scenario({ native: true });
  await page.getByText(/in Safari or Chrome to import medical records/).waitFor();
  assert(await page.getByRole("button", { name: "Connect Albany Med", exact: true }).isDisabled());
  await scenario({ enabled: false });
  assert.equal(await page.getByTestId("availability").innerText(), "hidden");
  assert.equal(await page.getByRole("button", { name: "Connect Albany Med", exact: true }).count(), 0);
  await scenario({ viewer: true });
  await page.getByText("Only a family owner can import medical records.", { exact: true }).waitFor();
  assert.equal((await snapshot()).calls.length, 0, "A viewer must not request private import state");
  await scenario({ growth: true });
  await page.getByRole("heading", { name: "Imported measurements", exact: true }).waitFor();
  assert.equal(await page.locator("input, textarea, select").count(), 0, "Imported clinical values, notes and date must not be editable");
  assert.equal(await page.getByRole("button", { name: "Save", exact: true }).count(), 0);
  await page.getByText("MyChart import", { exact: true }).waitFor();
  await page.getByText("3.5 kg", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  assert((await snapshot()).calls.some(call => call.method === "remove" && call.id === 10));
  await scenario({ growth: true, viewer: true });
  await page.getByRole("heading", { name: "Imported measurements", exact: true }).waitFor();
  assert.equal(await page.locator("input, textarea, select").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Delete", exact: true }).count(), 0, "Viewers cannot delete imported copies");
  assert(await page.getByRole("button", { name: "Close", exact: true }).count() > 0);
  await scenario({ entryRow: true });
  await page.getByText("via MyChart import", { exact: true }).waitFor();
  assert.equal(await page.getByText("View", { exact: true }).count(), 1);
  assert(!/\d{1,2}:\d{2}\s?[AP]M/.test(await page.locator("body").innerText()), "Imported timeline rows must not invent a clock time for date-only observations");
  assert.deepEqual(errors, []);
  console.log("PASS Epic UI: retry preserves choices, native browser guidance, hidden configuration and viewer privacy");
  console.log("PASS Epic UI: imported growth details are read-only, labeled, and deletable only by writers");
  if (screenshots) {
    await scenario({ stage: "measurements", snapshot: true });
    await page.getByText("Choose what to add", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(screenshots, "epic-preview.png"), fullPage: true, animations: "disabled" });
    await scenario({ growth: true });
    await page.getByRole("heading", { name: "Imported measurements", exact: true }).waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(screenshots, "epic-imported.png"), fullPage: true, animations: "disabled" });
  }
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
