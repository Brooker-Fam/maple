import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "maple-onboarding-waiting-"));
await build({
  stdin: { resolveDir: root, sourcefile: "waiting-fixture.jsx", loader: "jsx", contents: `
    import { useEffect, useRef, useState } from "react";
    import { createRoot } from "react-dom/client";
    import Onboarding from "./src/components/maple/onboarding/Onboarding";
    import { FixtureContext } from "./scripts/ui-review-settings-mocks";
    const view = { familyId: 99, status: "onboarding", owner: false, done: {}, next: "welcome", canFinish: false, missing: ["welcome"], modelSteps: 0, values: {} };
    function Fixture() {
      const [finished, setFinished] = useState(false);
      const response = useRef("fail");
      const calls = useRef([]);
      useEffect(() => { window.__waitingFixture = { respond: (value) => { response.current = value; }, calls: () => calls.current }; }, []);
      const api = async (url, options) => {
        calls.current.push({ url, method: options?.method ?? "GET" });
        if (response.current === "fail") throw new Error("Synthetic connection failure");
        return { needed: response.current !== "complete", view };
      };
      return <FixtureContext.Provider value={{ maple: { api, refresh: async () => {}, online: true, toasts: [], dismissToast: () => {} }, care: null }}>
        {finished ? <h1>Log opened</h1> : <Onboarding initial={view} onDone={() => setFinished(true)} />}
      </FixtureContext.Provider>;
    }
    createRoot(document.getElementById("root")).render(<Fixture />);
  ` },
  outfile: path.join(output, "app.js"), bundle: true, format: "esm", jsx: "automatic", absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
  plugins: [{ name: "synthetic-waiting-boundaries", setup(plugin) {
    const mocks = { path: path.join(root, "scripts/ui-review-settings-mocks.jsx") };
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav|useTimerActions|sheets|notify)$/ }, () => mocks);
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => args.importer.endsWith("/sheets/parts.tsx") ? mocks : undefined);
  } }],
});
const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
page.setDefaultTimeout(2000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", async (route) => {
  const script = new URL(route.request().url()).pathname === "/app.js";
  await route.fulfill({ contentType: script ? "text/javascript" : "text/html", body: script ? await readFile(path.join(output, "app.js")) : '<!doctype html><html><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>' });
});
try {
  await page.goto("https://maple-waiting.example.test/");
  await page.getByRole("heading", { name: "Almost ready", exact: true }).waitFor();
  const check = page.getByRole("button", { name: "Check again", exact: true });
  await check.click();
  await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").innerText(), /couldn't check|connection failure/i);
  assert(await check.isEnabled(), "A failed request must allow another check");
  assert.equal(await page.getByRole("heading", { name: "Log opened", exact: true }).count(), 0, "A failed check must not open the log");
  await page.evaluate(() => window.__waitingFixture.respond("pending"));
  await check.click();
  await page.getByRole("alert").waitFor({ state: "hidden" });
  assert(await page.getByRole("heading", { name: "Almost ready", exact: true }).isVisible());
  await page.evaluate(() => window.__waitingFixture.respond("complete"));
  await check.click();
  await page.getByRole("heading", { name: "Log opened", exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__waitingFixture.calls()), Array.from({ length: 3 }, () => ({ url: "/api/maple/onboarding", method: "GET" })));
  assert.deepEqual(errors, []);
  console.log("PASS waiting setup reports failed checks, retries, and opens only after completion");
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
