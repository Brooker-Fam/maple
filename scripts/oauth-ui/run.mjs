import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { NextRequest } from "next/server.js";
import { chromium, webkit } from "playwright";

const browsers = Object.entries({ chromium, webkit }).filter(([name]) => !process.env.OAUTH_BROWSER || name === process.env.OAUTH_BROWSER);
assert(browsers.length, "OAUTH_BROWSER must be chromium or webkit");
const metadataClient = "https://claude.ai/oauth/claude-code-client-metadata";
const root = process.cwd();
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const output = await mkdtemp(path.join(cache, "maple-oauth-ui-"));
try {
  process.env.MCP_SECRET = "synthetic-oauth-browser-check-secret";
  const mocks = {
    "@/lib/maple/auth": `
      export const ADMIN_ID = "admin", SESSION_COOKIE = "maple_session";
      export const isGoogleConfigured = () => true;
      export const isRemoved = async () => false;
      export const openSession = (value) => value === "synthetic-session" ? { id: "sam@example.test", fam: 7 } : null;
      export const signedInAs = async (session) => session.fam === 7 ? {
        ctx: { familyId: 7 },
        member: { email: "sam@example.test", display_name: "Sam", role: "owner" }
      } : null;
    `,
    "@/lib/maple/family": `
      export const adminFamilyId = () => 1;
      export const familiesOf = async () => [{ familyId: 7, name: "Synthetic family" }];
      export const parseFamilyId = (value) => /^[1-9][0-9]*$/.test(value || "") ? Number(value) : null;
    `,
    "@/lib/rate-limit": "export const checkUploadRateLimit = async () => ({ allowed: true });",
    "@/lib/posthog-server": "export const captureServerException = async () => {};",
  };
  const routePath = "src/app/oauth/authorize/route.ts";
  await build({
    stdin: {
      contents: `export { GET, POST } from "./${routePath}"; export { verifyAuthCode } from "./src/lib/mcp/auth.ts";`,
      resolveDir: root,
    },
    outfile: path.join(output, "route.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    plugins: [{
      name: "synthetic-membership",
      setup(builder) {
        builder.onResolve({ filter: /^@\/lib\/(maple\/(auth|family)|rate-limit|posthog-server)$/ }, ({ path: name }) => ({ path: name, namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: name }) => ({ contents: mocks[name], loader: "js" }));
        if (process.env.OAUTH_BASELINE_REF) {
          builder.onLoad({ filter: /src\/app\/oauth\/authorize\/route\.ts$/ }, async ({ path: file }) => ({
            contents: execFileSync("git", ["show", `${process.env.OAUTH_BASELINE_REF}:${routePath}`], { cwd: root, encoding: "utf8" }),
            loader: "ts",
            resolveDir: path.dirname(file),
          }));
        }
      },
    }],
  });
  const { GET, POST, verifyAuthCode } = await import(pathToFileURL(path.join(output, "route.cjs")));
  const posts = [];
  const callbackReferrers = [];
  const callbackServer = createServer((request, response) => {
    callbackReferrers.push(request.headers.referer);
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<h1>Connection approved</h1>");
  });
  await new Promise((resolve) => callbackServer.listen(0, "127.0.0.1", resolve));
  const callbackOrigin = `http://localhost:${callbackServer.address().port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), metadataClient, "server fetches stay inside the synthetic metadata mock");
    return Response.json({
      client_id: metadataClient,
      client_name: "Synthetic browser connector",
      redirect_uris: ["http://localhost/callback"],
      token_endpoint_auth_method: "none",
    }, { headers: { "Cache-Control": "no-store" } });
  };
  let origin;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      if (url.pathname !== "/oauth/authorize") {
        response.writeHead(404);
        response.end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = request.method === "POST" ? Buffer.concat(chunks) : undefined;
      if (body) posts.push({ origin: request.headers.origin, body: new URLSearchParams(body.toString()) });
      const incoming = new NextRequest(url, { method: request.method, headers: request.headers, body });
      const result = await (request.method === "POST" ? POST(incoming) : GET(incoming));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      response.writeHead(500);
      response.end(error.message);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://localhost:${server.address().port}`;

  let failures = 0;
  try {
    for (const [name, engine, clientId] of browsers.flatMap(([name, engine]) => ["synthetic-browser-client", metadataClient].map((clientId) => [name, engine, clientId]))) {
      const browser = await engine.launch();
      const context = await browser.newContext();
      await context.route("**/*", (route) => [origin, callbackOrigin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
      await context.addCookies([{ name: "maple_session", value: "synthetic-session", url: origin, sameSite: "Lax" }]);
      const page = await context.newPage();
      try {
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: `${callbackOrigin}/callback`,
          response_type: "code",
          code_challenge: "A".repeat(43),
          code_challenge_method: "S256",
          scope: "maple",
          state: "synthetic-state",
          resource: `${origin}/api/maple/mcp`,
        });
        const consent = await page.goto(`${origin}/oauth/authorize?${params}`);
        assert.equal(consent.status(), 200, await consent.text());
        const consentCopy = await page.locator("body").innerText();
        assert.equal(await page.getByRole("button", { name: "Approve", exact: true }).count(), 1, await page.locator("body").innerText());
        await page.getByRole("button", { name: "Approve", exact: true }).click();
        await page.waitForLoadState();
        const result = new URL(page.url());
        const lastPost = posts.at(-1);
        assert.equal(result.pathname, "/callback", `Approve rendered ${await page.locator("h1").textContent()} (POST Origin: ${lastPost?.origin})`);
        assert.equal(result.origin, callbackOrigin);
        assert.equal(lastPost.origin, origin);
        assert.equal(callbackReferrers.at(-1), undefined, "Consent URL is not shared with the app receiving the code");
        assert.equal(result.searchParams.get("state"), "synthetic-state");
        const grant = verifyAuthCode(result.searchParams.get("code"));
        assert.equal(grant?.client_id, clientId);
        if (clientId === metadataClient) assert.match(consentCopy, /Synthetic browser connector/);
        assert.equal(grant?.sub, "maple:sam@example.test");
        assert.equal(grant?.fam, 7);
        assert.equal(grant?.resource, `${origin}/api/maple/mcp`);

        await page.goto(`${origin}/oauth/authorize?${params}`);
        await page.getByRole("link", { name: "Cancel", exact: true }).click();
        await page.waitForLoadState();
        const cancelled = new URL(page.url());
        assert.equal(cancelled.origin, callbackOrigin);
        assert.equal(cancelled.searchParams.get("error"), "access_denied");
        assert.equal(cancelled.searchParams.get("code"), null);
        assert.equal(cancelled.searchParams.get("state"), "synthetic-state");
        assert.equal(callbackReferrers.at(-1), undefined, "Cancel does not share the consent URL");
        assert.deepEqual([result.searchParams.get("iss"), cancelled.searchParams.get("iss")], [origin, origin], "Approval and cancellation identify the authorization server");

        const data = Object.fromEntries(lastPost.body);
        for (const attackerOrigin of ["https://unrelated.example.test", "null"]) {
          const denied = await context.request.post(`${origin}/oauth/authorize`, { form: data, headers: { origin: attackerOrigin }, maxRedirects: 0 });
          assert.equal(denied.status(), 403, `${attackerOrigin} cannot approve`);
          assert.match(await denied.text(), /That didn&#39;t come from here/);
        }
        const otherFamily = await context.request.post(`${origin}/oauth/authorize`, { form: { ...data, maple_family: "8" }, headers: { origin }, maxRedirects: 0 });
        assert.equal(otherFamily.status(), 200);
        assert.match(await otherFamily.text(), /Please sign in again to approve/);
        await context.clearCookies();
        const signedOut = await context.request.post(`${origin}/oauth/authorize`, { form: data, headers: { origin }, maxRedirects: 0 });
        assert.equal(signedOut.status(), 200);
        assert.match(await signedOut.text(), /Please sign in again to approve/);
        console.log(`PASS ${name} ${clientId === metadataClient ? "CIMD" : "legacy"}: browser consent approves its member and family; foreign, opaque, signed-out and nonmember posts cannot approve`);
      } catch (error) {
        failures++;
        console.error(`FAIL ${name}: ${error.message}`);
      } finally {
        await context.close();
        await browser.close();
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.all([server, callbackServer].map((active) => new Promise((resolve, reject) => active.close((error) => error ? reject(error) : resolve()))));
  }
  if (failures) process.exitCode = 1;
} finally {
  await rm(output, { recursive: true, force: true });
}
