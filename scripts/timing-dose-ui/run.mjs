import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, webkit } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const out = await mkdtemp(path.join(tmpdir(), "maple-timing-dose-"));
const browserName = process.env.REVIEW_BROWSER === "webkit" ? "webkit" : "chromium";
const browser = await { chromium, webkit }[browserName].launch();
const baseline = process.env.MAPLE_TIMING_DOSE_BASELINE;
const scenario = process.env.DOSE_SCENARIO;

try {
  await build({
    entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(out, "app.js"), bundle: true, format: "esm", jsx: "automatic", absWorkingDir: root, define: { "process.env": "{}" },
    plugins: [{ name: "synthetic-dose-hooks", setup(plugin) {
      plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav|sheets|MedPlanSheet|CareHistorySheet)$/ }, () => ({ path: path.join(here, "mocks.jsx") }));
      plugin.onResolve({ filter: /^\.\/index$/ }, (args) => args.importer.endsWith("/sheets/parts.tsx") ? { path: path.join(here, "mocks.jsx") } : undefined);
      if (baseline) plugin.onLoad({ filter: /\/(DoseTimeSheet|DoseSheet|PlanDetail|ChatCareEditor)\.tsx$/ }, ({ path: file }) => ({ contents: execFileSync("git", ["show", `${baseline}:${path.relative(root, file)}`], { cwd: root, encoding: "utf8" }), loader: "tsx", resolveDir: path.dirname(file) }));
    } }],
  });
  const context = await browser.newContext({ timezoneId: "UTC", reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
  await page.clock.install({ time: new Date("2026-10-28T13:30:50.000Z") });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, "https://timing-dose.example.test");
    if (url.pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(out, "app.js")) });
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div><script type="module" src="/app.js"></script>' });
  });
  await page.goto("https://timing-dose.example.test");
  const clock = page.getByLabel("Taken at: time", { exact: true });
  const save = page.getByRole("button", { name: "Save time", exact: true });
  await clock.waitFor();
  if (!scenario || scenario === "conflict") {
    await clock.fill("");
    await page.evaluate(() => window.doseFixture.change({ note: "Changed synthetic note" }));
    await page.getByRole("button", { name: "Use latest time", exact: true }).click();
    assert.equal(await clock.inputValue(), "08:00", "Use latest time must replace an invalid draft even when only the dose details changed");
    assert(await save.isDisabled());
    console.log(`PASS dose conflict reset restores the saved clock after a details-only change (${browserName})`);
  }
  if (!scenario || scenario === "clock") {
    await page.clock.setSystemTime(new Date("2026-10-28T13:31:10.000Z"));
    await clock.fill("09:32");
    assert(await save.isEnabled(), "Dose corrections validate against the current minute instead of the last sampled clock");
    await save.click();
    assert.equal((await page.evaluate(() => window.doseFixture.snapshot())).calls.at(-1).at, "2026-10-28T13:32:00.000Z");
    console.log(`PASS dose corrections use the live future-time limit (${browserName})`);
  }
  for (const form of ["plan", "one-off", "details", "chat"]) {
    if (scenario && scenario !== form) continue;
    await page.clock.setSystemTime(new Date("2026-10-28T13:30:50.000Z"));
    await page.goto(`https://timing-dose.example.test?form=${form}`);
    if (form === "details") await page.getByRole("button", { name: "Dose details", exact: true }).click();
    await clock.waitFor();
    if (form === "chat") await clock.fill("09:35");
    await page.clock.setSystemTime(new Date("2026-10-28T13:31:10.000Z"));
    await clock.fill("09:32");
    const submit = page.getByRole("button", { name: form === "chat" ? "Save" : form === "details" ? "Save dose" : /^Took it at / });
    assert(await submit.isEnabled(), `${form} validates against the current minute instead of the last sampled clock`);
    await submit.click();
    const submitted = (await page.evaluate(() => window.doseFixture.snapshot())).calls.at(-1);
    assert.equal((form === "chat" ? submitted : form === "details" ? submitted.patch : submitted.input).at, "2026-10-28T13:32:00.000Z");
    console.log(`PASS ${form} dose form uses the live future-time limit (${browserName})`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await rm(out, { recursive: true, force: true });
}
