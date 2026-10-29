async function queuedWorld({ browser, readFile, output }, sync) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  let online = false;
  let release;
  let started;
  const flushing = new Promise((resolve) => { started = resolve; });
  const now = "2026-10-28T13:30:00.000Z";
  const savedAt = "2026-10-28T13:35:00.000Z";
  const member = { email: "synthetic@example.test", display_name: "Synthetic parent", role: "owner" };
  const state = { now, rev: "first", family: { id: 99 }, me: member, members: [member], baby: { id: 99, name: "Synthetic baby", born_at: now, timezone: "America/New_York", settings: {} }, entries: [], care: null, growth: [], lifetime: null };
  const patches = [];
  const posts = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) {
      const filename = url.pathname === "/app.js" ? "queued.js" : url.pathname === "/app.css" ? "app.css" : null;
      return route.fulfill({ contentType: filename?.endsWith("js") ? "text/javascript" : filename ? "text/css" : "text/html", body: filename ? await readFile(`${output}/${filename}`) : '<!doctype html><html class="maple-ui"><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>' });
    }
    if (url.pathname === "/api/maple/auth/me") return route.fulfill({ json: { signedIn: true, google: false, email: false, apple: false, password: false } });
    if (url.pathname === "/api/maple/state") return route.fulfill({ json: state });
    if (url.pathname === "/api/maple/upload") return route.fulfill({ json: { ready: false, access: null } });
    if (url.pathname === "/api/maple/diagnostics") return route.fulfill({ status: 204, body: "" });
    if (url.pathname === "/api/maple/entries" && request.method() === "POST") {
      if (!online) return route.fulfill({ status: 503, json: { error: "Synthetic offline connection" } });
      started();
      if ((sync === "during" || sync === "behind") && !posts.length) await new Promise((resolve) => { release = resolve; });
      const input = request.postDataJSON();
      const entry = { id: 901 + posts.length, kind: input.kind, data: input.data, note: input.note, started_at: input.started_at ?? now, ended_at: null, active: false, source: "web", created_by: member.email, updated_by: null, created_at: savedAt, updated_at: savedAt };
      posts.push(entry); state.entries.push(entry); state.rev = `synced-${posts.length}`;
      return route.fulfill({ json: { entry } });
    }
    if (url.pathname === "/api/maple/entries" && request.method() === "PATCH") {
      const patch = request.postDataJSON(); patches.push({ id: Number(url.searchParams.get("id")), patch });
      if (patches.at(-1).id < 0) return route.fulfill({ status: 400, json: { error: "Invalid entry ID" } });
      if (patch.expect_updated_at !== savedAt) return route.fulfill({ status: 409, json: { reason: "changed", entry: state.entries[0], error: "Wrong saved revision" } });
      const entry = { ...state.entries[0], ...patch, data: { ...state.entries[0].data, ...patch.data }, updated_at: "2026-10-28T13:36:00.000Z" };
      state.entries = [entry]; state.rev = "edited";
      return route.fulfill({ json: { entry } });
    }
    return route.fulfill({ status: 400, json: { error: "Unexpected synthetic endpoint" } });
  });
  return { context, page, patches, posts, state, errors, savedAt, release: () => release?.(), reconnect: async () => { online = true; await page.evaluate(() => window.dispatchEvent(new Event("online"))); await flushing; } };
}

export function queuedCases(deps) {
  const { assert } = deps;
  return [false, true, "during", "behind"].map((sync) => [`moment edits ${sync === "behind" ? "survive an earlier queued upload" : sync === "during" ? "wait for an in-flight queued save" : sync ? "follow a queued ID after sync" : "stay in the local outbox before sync"}`, async () => {
    const { context, page, patches, posts, state, errors, savedAt, release, reconnect } = await queuedWorld(deps, sync);
    try {
      await page.goto("https://queued-photos.example.test");
      await page.getByRole("button", { name: sync === "behind" ? "Create two queued moments" : "Create queued moment", exact: true }).click();
      const form = page.getByRole("dialog", { name: "Edit moment", exact: true });
      await form.waitFor();
      await form.getByRole("textbox", { name: "Title", exact: true }).fill("Edited queued caption");
      const queued = await page.evaluate(() => JSON.parse(localStorage.getItem("maple-outbox-v1")));
      assert.equal(queued.length, sync === "behind" ? 2 : 1);
      if (sync) {
        await reconnect();
        if (sync === "behind") {
          await form.getByRole("button", { name: "Save changes", exact: true }).click();
          await form.waitFor({ state: "hidden" }); release();
          await page.waitForFunction(() => window.__queuedMoment.pending === 0);
          assert.equal(patches.length, 0);
          assert.deepEqual(posts.map((entry) => entry.data.title), ["First queued moment", "Edited queued caption"]);
          assert.deepEqual(errors, []);
          return;
        }
        if (sync === "during") {
          await form.getByRole("button", { name: "Save changes", exact: true }).click();
          assert.equal(patches.length, 0, "An in-flight outbox entry must not be patched by its temporary ID");
          assert(await form.isVisible()); release();
        }
        await page.waitForFunction(() => window.__queuedMoment.pending === 0);
      }
      await form.getByRole("button", { name: "Save changes", exact: true }).click();
      await form.waitFor({ state: "hidden" });
      if (sync) {
        assert.equal(patches.length, 1); assert.equal(patches[0].id, 901);
        assert.equal(patches[0].patch.expect_updated_at, savedAt);
        assert.equal(state.entries[0].data.title, "Edited queued caption");
      } else {
        assert.equal(patches.length, 0);
        const next = await page.evaluate(() => JSON.parse(localStorage.getItem("maple-outbox-v1")));
        assert.equal(next.length, 1); assert.equal(next[0].input.data.title, "Edited queued caption");
        assert(!Object.hasOwn(next[0].input.data, "milestone"), "An empty milestone must not become an invalid null field in the queued creation");
      }
      assert.deepEqual(errors, []);
    } finally { release(); await context.close(); }
  }]);
}
