import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(__dirname, "..");
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const offline = { error: "Maple is briefly offline. Please try again.", code: "offline" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function files(folder: string): Promise<string[]> {
  return (await Promise.all((await readdir(folder, { withFileTypes: true })).map((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }))).flat();
}

async function routeInventory(): Promise<string[]> {
  const app = join(root, "src/app");
  const source = await files(app);
  for (const file of source.filter((path) => /\.[jt]sx?$/.test(path))) {
    assert(!/(?:^|[;\n])\s*["']use server["']/.test(await readFile(file, "utf8")), `Server Action needs cutover coverage: ${relative(root, file)}`);
  }
  const paths = source.filter((file) => file.endsWith("/route.ts")).map((file) => {
    const parts = relative(app, dirname(file)).split("/").filter((part) => !part.startsWith("("));
    return `/${parts.map((part) => part === "[transport]" ? "mcp" : part.startsWith("[") ? "synthetic" : part).join("/")}`;
  });
  const guarded = (path: string) => path.startsWith("/api/maple/") || path.startsWith("/oauth/") || path === "/api/waitlist";
  assert.deepEqual(paths.filter((path) => !guarded(path)).sort(), [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource/api/maple/mcp",
    "/.well-known/oauth-protected-resource/maple",
    "/blog/feed.xml",
    "/maple/sw.js",
  ]);
  return paths.filter(guarded);
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(5000)]);
  if (child.exitCode === null) { child.kill("SIGKILL"); await exited; }
}

async function run(fixture: string, paths: string[], readOnly: boolean) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: fixture,
    env: { PATH: process.env.PATH, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", MAPLE_READ_ONLY: readOnly ? "1" : "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const collect = (data: Buffer) => { logs = (logs + data.toString()).slice(-12000); };
  child.stdout!.on("data", collect);
  child.stderr!.on("data", collect);
  try {
    const until = Date.now() + 60_000;
    while (true) {
      if (child.exitCode !== null || Date.now() > until) throw new Error(`Synthetic Next server unavailable\n${logs}`);
      try { if ((await fetch(`${base}/test-probe`)).ok) break; } catch {}
      await sleep(100);
    }
    for (const path of paths) for (const method of methods) {
      const response = await fetch(`${base}${path}`, { method, redirect: "manual", headers: { "x-middleware-subrequest": "src/proxy:src/proxy:src/proxy:src/proxy:src/proxy" } });
      assert.equal(response.status, readOnly ? 503 : 200, `${method} ${path}`);
      if (readOnly) {
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("retry-after"), "60");
        assert.equal(response.headers.get("set-cookie"), null);
        if (method !== "HEAD") assert.deepEqual(await response.json(), offline);
      } else if (method !== "HEAD") assert.equal((await response.json()).reached, true);
    }
    const count = (await (await fetch(`${base}/test-probe`)).json()).calls;
    assert.equal(count, readOnly ? 0 : paths.length * methods.length, "blocked requests must never execute their route handler");
    for (const path of ["/maple", "/signup", "/privacy", "/pricing", "/maple/sw.js", "/blog/feed.xml"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 200, `public shell remains reachable: ${path}`);
    }
    console.log(`PASS ${readOnly ? "maintenance" : "normal"}: ${paths.length * methods.length} requests across ${paths.length} routes; handlers=${count}`);
  } finally { await stop(child); }
}

async function main() {
  const paths = await routeInventory();
  const fixture = await mkdtemp(join(tmpdir(), "maple-read-only-check-"));
  try {
    const app = join(fixture, "src/app/[[...path]]");
    await mkdir(app, { recursive: true });
    await symlink(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
    await writeFile(join(fixture, "package.json"), JSON.stringify({ name: "synthetic-cutover-check", private: true }));
    await writeFile(join(fixture, "src/app/layout.tsx"), "export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }");
    await writeFile(join(app, "route.ts"), `let calls = 0;\nfunction handle(request: Request) {\n  if (new URL(request.url).pathname === '/test-probe') return Response.json({ calls });\n  calls++;\n  return Response.json({ reached: true });\n}\nexport { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD, handle as OPTIONS };`);
    const proxy = join(root, "src/proxy.ts");
    if (existsSync(proxy)) await copyFile(proxy, join(fixture, "src/proxy.ts"));
    await run(fixture, paths, true);
    await run(fixture, paths, false);
  } finally { await rm(fixture, { recursive: true, force: true }); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
