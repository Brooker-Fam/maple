import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, webkit } from "playwright";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const origin = "https://synthetic.example.test";
const events = [{ event: "write_succeeded", status: 201 }];
process.env.MAPLE_SESSION_SECRET = "synthetic-diagnostics-browser-secret";

function load(file, mocks = {}) {
  const absolute = resolve(root, file);
  const source = ts.transpileModule(readFileSync(absolute, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const local = createRequire(absolute);
  const module = { exports: {} };
  new Function("require", "module", "exports", source)(
    (name) => name in mocks ? mocks[name] : local(name), module, module.exports,
  );
  return module.exports;
}

const diagnostics = load("src/lib/maple/diagnostics.ts");
const bundle = await build({
  stdin: {
    contents: `import { recordSyncDiagnostic } from './src/lib/maple/diagnostics-client';
      window.emitDiagnostic = () => recordSyncDiagnostic('write_succeeded', { status: 201 });`,
    resolveDir: root,
  },
  bundle: true,
  write: false,
  format: "esm",
});

let failed = 0;
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  const browser = await engine.launch({ headless: true });
  try {
    const logged = [];
    const errors = [];
    const endpoint = load("src/app/api/maple/diagnostics/route.ts", {
      "@/lib/db": { query: async () => [{ count: 1 }] },
      "@/lib/posthog-server": { captureServerException: async (...args) => { errors.push(args); } },
      "@/lib/maple/api": {
        json: (body, status = 200) => Response.json(body, { status }),
        withMember: (_name, handler) => (request) => handler(request, { email: "synthetic@example.test" }),
      },
      "@/lib/maple/auth-request": load("src/lib/maple/auth-request.ts"),
      "@/lib/maple/diagnostics": { ...diagnostics, logSyncDiagnostic: (event) => { logged.push(event); } },
    });
    const page = await browser.newPage();
    const requests = [];
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      assert.equal(url.origin, origin);
      if (request.method() === "POST") {
        assert.equal(url.pathname, "/api/maple/diagnostics");
        const headers = await request.allHeaders();
        const response = await endpoint.POST(new Request(request.url(), {
          method: "POST", headers, body: request.postData(),
        }));
        requests.push({ headers, body: request.postDataJSON() });
        await route.fulfill({ status: response.status, body: await response.text() });
      } else if (url.pathname === "/app.js") {
        await route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0].text });
      } else {
        await route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><title>Synthetic diagnostics check</title><script type="module" src="/app.js"></script>',
        });
      }
    });
    await page.goto(`${origin}/maple/private-synthetic?private=synthetic-query#synthetic-fragment`);
    const response = page.waitForResponse(`${origin}/api/maple/diagnostics`);
    await page.evaluate(() => window.emitDiagnostic());
    assert.equal((await response).status(), 204);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.origin, origin);
    assert.equal(requests[0].headers.referer, `${origin}/`);
    assert.deepEqual(requests[0].body, { events });
    assert.deepEqual(logged, events);
    assert.deepEqual(errors, []);
    console.log(`PASS ${name}: diagnostics accepted with origin-only referrer`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await browser.close();
  }
}
process.exitCode = failed ? 1 : 0;
